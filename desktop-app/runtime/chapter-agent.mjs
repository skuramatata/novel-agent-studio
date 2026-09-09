import { fitWritingContext } from "./context-budget.mjs";
import { z } from "zod";
import { complete } from "./providers.mjs";
import { createStructuredAsker } from "./structured-step.mjs";
import { workflowContract, proseWorkflowMessages } from "./workflow-skill.mjs";
import { createBudgetProfile, observeTokenUsage } from "./model-budget.mjs";
import { requestOutput, inputLimit } from "./model-capabilities.mjs";
import { applyProposal, readyForChapter } from "./schema.mjs";
import {
  WRITING_RULES,
  countWords,
  chapterWordRange,
  taskMessages,
  normalizeTaskWordTargets,
} from "./writing.mjs";
import {
  indexChapter,
  contextFor,
  ensureBudget,
  digest,
  modelWritingContext,
} from "./memory.mjs";
import { WORKFLOW_VERSION } from "./checkpoint.mjs";
import { runPlanningDag } from "./planning-dag.mjs";
import { reviewAndPatch } from "./paragraph-review.mjs";
import { continuationTask } from "./continuation.mjs";
import { sceneLengthMessages, lengthDistance } from "./scene-length.mjs";
import { DEFAULT_WORD_TOLERANCE, wordToleranceLabel } from "./word-range.mjs";
import { appendCreationEvent, stageCategory } from "./creation-log.mjs";
import { sceneTimeSchema } from "./continuity-schema.mjs";
import { retrieveContinuitySources, continuityLedger } from "./continuity.mjs";
import { runDraftWork } from "./draft-agent.mjs";
import {
  draftScenes,
  pauseDraft,
  recordDraftVersion,
} from "./revision-session.mjs";

const intentSchema = z.object({
  mode: z.enum(["discuss", "plan", "draft", "revise"]),
  targetIds: z.array(z.string()).max(200),
  totalWords: z.number().int().min(100).max(2000000).nullable(),
  chapterWords: z.number().int().min(100).max(10000).nullable(),
  totalWordsEvidence: z.string().optional(),
  chapterWordsEvidence: z.string().optional(),
  scopeEvidence: z.string(),
  explanation: z.string(),
});
const scenesSchema = z.object({
  scenes: z
    .array(
      z.object({
        goal: z.string().max(1000),
        knowledge: z.string().max(1000),
        time: sceneTimeSchema.optional(),
      }),
    )
    .min(1)
    .max(16),
});
const intentContract = workflowContract("task_intent", intentSchema);
const scenesContract = workflowContract("scene_plan", scenesSchema);

export async function runChapterAgent(
  p,
  config,
  signal,
  progress,
  checkpoint,
  state,
  fetcher = fetch,
  services = {},
) {
  // 已在执行的旧检查点保持原证据地址与恢复链；新任务启用连续性专项。
  const continuity = state.continuityVersion === 1;
  const extractionOptions = { continuity };
  const save = async () => {
    state.updatedAt = new Date().toISOString();
    await checkpoint.write(state);
  };
  let callsThisRun = 0;
  const budget = createBudgetProfile(config, state.tokenBudget);
  state.tokenBudget = budget;
  async function call(messages, tokens, label, partial = false) {
    if (!partial) messages = proseWorkflowMessages(messages);
    tokens = requestOutput(tokens, budget);
    signal.throwIfAborted();
    state.stage = label;
    const selected = fitWritingContext(messages, tokens, budget);
    messages = selected.messages;
    const inputEstimate = ensureBudget(messages, tokens, budget);
    if (selected.coverage) {
      state.contextSelections ??= {};
      state.contextSelections[label] = selected.coverage;
    }
    if (++callsThisRun > 90)
      throw Error("本次达到90次调用预算，已保存进度，可继续恢复。");
    state.stage = label;
    state.calls++;
    const started = Date.now();
    const category = stageCategory(label);
    appendCreationEvent(state, {
      category,
      status: "running",
      title: label,
      details: {
        调用序号: state.calls,
        输出预算: tokens,
        输入估算: inputEstimate,
        有效上下文: budget.capabilities.contextLimit,
        模型输出上限: budget.capabilities.maxOutputTokens,
        预算依据: budget.capabilities.confidence,
        估算方式: `本地BPE × ${budget.factor}（非供应商实际Token）`,
        ...(selected.coverage
          ? {
              原始输入估算: selected.originalInputEstimate,
              历史记忆: `${selected.coverage.includedRecords}/${selected.coverage.totalRecords}条，完整索引保留`,
              ...(selected.transport
                ? {
                    原文复用处数: selected.transport.sharedQuotes,
                    复用前输入估算: selected.transport.beforeTokens,
                    复用后输入估算: selected.transport.afterTokens,
                  }
                : {}),
            }
          : {}),
      },
    });
    progress(label);
    await save();
    let result;
    try {
      result = await complete(config, messages, signal, fetcher, tokens, {
        allowPartial: partial,
      });
    } catch (e) {
      appendCreationEvent(state, {
        category,
        status: signal.aborted ? "waiting" : "failed",
        title: `${label} · 调用未完成`,
        details: { 原因: e.message, 耗时毫秒: Date.now() - started },
      });
      await save();
      throw e;
    }
    state.usages.push(result.usage);
    observeTokenUsage(budget, messages, result.usage);
    appendCreationEvent(state, {
      category,
      status: result.finishReason === "length" ? "waiting" : "success",
      title: `${label} · 收到模型结果`,
      details: {
        耗时毫秒: Date.now() - started,
        结束原因: result.finishReason,
        响应模型: result.model,
        输入Token: result.usage?.prompt_tokens,
        输出Token: result.usage?.completion_tokens,
        思考Token: result.usage?.completion_tokens_details?.reasoning_tokens,
        总Token: result.usage?.total_tokens,
        输入估算: inputEstimate,
        后续预算系数: budget.factor,
      },
    });
    await save();
    signal.throwIfAborted();
    return result;
  }
  const ask = createStructuredAsker({ state, budget, call, save, signal });
  try {
    const req = state.request;
    if (state.draftWork) {
      const result = await runDraftWork({
        p,
        state,
        ask,
        save,
        signal,
        profile: budget,
      });
      return {
        ...result,
        model: config.model,
        calls: state.calls,
        usages: state.usages,
        promptVersion: WORKFLOW_VERSION,
      };
    }
    if (req.mode === "memory") {
      const targets = p.chapters.filter(
        (c) => c.content.trim() && (!req.chapterId || c.id === req.chapterId),
      );
      if (!targets.length) throw Error("没有可整理的已采纳正文。");
      let entries = [...(p.memory?.entries || [])];
      for (const ch of targets) {
        const values = await indexChapter(p, ch, ask, extractionOptions);
        entries = entries.filter((e) => e.chapterId !== ch.id).concat(values);
      }
      state.status = "ready";
      if (services.retrieval) {
        state.retrievalIndex = await services.retrieval.sync(p, {
          signal,
          progress,
        });
        appendCreationEvent(state, {
          category: "memory",
          status: "success",
          title: "本地向量与关键词索引已更新",
          details: { 片段: state.retrievalIndex.chunks },
        });
      }
      await save();
      return {
        memoryOnly: { version: 1, entries },
        model: config.model,
        calls: state.calls,
        usages: state.usages,
        promptVersion: WORKFLOW_VERSION,
      };
    }
    if (!readyForChapter(p))
      return await runPlanningDag(p, req.instruction, {
        ask,
        state,
        save,
        signal,
      });
    let task;
    const continuation = !req.chapterId && continuationTask(p, req.instruction);
    if (continuation?.complete) {
      state.status = "ready";
      state.stage = "已有章节均已完成";
      await save();
      return {
        proposal: {
          summary:
            "已采纳章纲中的章节都有正文了。若需修改，请说明章节和修改要求；若要续写新章，请先补充章纲。",
        },
        model: config.model,
        calls: state.calls,
        usages: state.usages,
        promptVersion: WORKFLOW_VERSION,
      };
    }
    if (req.chapterId) {
      const ch = p.chapters.find((c) => c.id === req.chapterId);
      if (!ch) throw Error("章节不存在。");
      task = {
        mode: ch.content ? "revise" : "draft",
        targetIds: [ch.id],
        chapterWords: req.words ?? p.premise.chapterWords,
        totalWords: null,
      };
    } else if (continuation) {
      task = continuation;
      state.values.intent = task;
      await save();
    } else {
      const messages = taskMessages(p, req.instruction);
      messages[0].content = messages[0].content.replace(
        "targetIds只选",
        "最多选择200章。targetIds只选",
      );
      task = await ask(
        "intent-v2",
        messages,
        (v) => {
          const value = intentSchema.parse(v);
          if (
            ["draft", "revise"].includes(value.mode) &&
            (!value.scopeEvidence.trim() ||
              !req.instruction.includes(value.scopeEvidence))
          )
            throw Error(
              "范围依据必须逐字引用本次请求，不得拼接历史请求；本次请求为：" +
                req.instruction,
            );
          return normalizeTaskWordTargets(value, req.instruction);
        },
        3500,
        "确定章节任务",
        { contract: intentContract },
      );
      // ask 会重新校验旧缓存；把归一后的目标写回，恢复不再沿用推算总字数。
      state.values["intent-v2"] = task;
      await save();
      if (!["draft", "revise"].includes(task.mode)) return { legacy: true };
      if (
        !task.scopeEvidence.trim() ||
        !req.instruction.includes(task.scopeEvidence)
      )
        throw Error("写作范围没有本次请求的授权依据。");
    }
    if (
      !task.targetIds.length ||
      new Set(task.targetIds).size !== task.targetIds.length ||
      task.targetIds.some((id) => !p.chapters.some((c) => c.id === id))
    )
      throw Error("目标章节不存在或重复。");
    const targets = p.chapters
      .filter((c) => task.targetIds.includes(c.id))
      .sort((a, b) => a.number - b.number);
    const ch = targets[0];
    if (task.mode === "draft" && ch.content)
      throw Error("已有正文需要明确修订授权。");
    if (p.chapters.some((c) => c.number < ch.number && !c.content.trim()))
      throw Error("请先完成并采纳前面的章节，再生成本章，避免缺失故事状态。");
    const preserved = p.chapters
      .filter((c) => !task.targetIds.includes(c.id))
      .reduce((n, c) => n + countWords(c.content), 0);
    const words =
      task.totalWords !== null
        ? Math.round((task.totalWords - preserved) / targets.length)
        : (task.chapterWords ?? p.premise.chapterWords);
    if (words < 100 || words > 10000)
      throw Error("单章目标需要为100—10000字，请调整章节范围或字数。");
    const tolerance = state.wordTolerance ?? DEFAULT_WORD_TOLERANCE;
    const wordRange = chapterWordRange(words, tolerance);
    const wordTarget = {
      chapterId: ch.id,
      words,
      ...wordRange,
      tolerance,
      source:
        task.totalWords !== null
          ? "本次明确的整篇目标，扣除保留章节后分配"
          : req.chapterId && req.words !== undefined
            ? "章节生成参数"
            : req.chapterId || continuation || task.chapterWords === null
              ? "作品设置中的每章字数"
              : "本次明确的单章目标",
    };
    if (JSON.stringify(state.wordTarget) !== JSON.stringify(wordTarget)) {
      state.wordTarget = wordTarget;
      appendCreationEvent(state, {
        title: "确定本章字数目标",
        details: {
          章节: ch.number,
          目标字数: words,
          容差: wordToleranceLabel(tolerance),
          允许范围: `${wordRange.min}—${wordRange.max}字`,
          依据: wordTarget.source,
        },
      });
    }
    state.chapterId = ch.id;
    state.remaining = targets.slice(1).map((c) => c.id);
    await save();
    let entries = [...(p.memory?.entries || [])];
    for (const prior of p.chapters
      .filter((c) => c.number < ch.number && c.content)
      .sort((a, b) => a.number - b.number)) {
      const indexed = await indexChapter(
        { ...p, memory: { version: 1, entries } },
        prior,
        ask,
        extractionOptions,
      );
      entries = entries.filter((e) => e.chapterId !== prior.id).concat(indexed);
    }
    state.stage = `准备第 ${ch.number} 章上下文`;
    if (
      state.retrievalVersion === 1 &&
      services.retrieval &&
      !state.retrievedContext
    ) {
      state.retrievalIndex = await services.retrieval.sync(p, {
        signal,
        progress,
      });
      state.retrievedContext = await services.retrieval.search(
        p,
        ch.number,
        req.instruction + "\n" + ch.summary,
        {
          signal,
          profile: budget,
          maxTokens: Math.min(
            6000,
            Math.floor(inputLimit(budget, requestOutput(8000, budget)) / 3),
          ),
        },
      );
      appendCreationEvent(state, {
        category: "memory",
        status: "success",
        title: "本地混合检索已完成",
        details: {
          索引片段: state.retrievalIndex.chunks,
          选中原文段落: state.retrievedContext.coverage.selected,
          检索输入估算: state.retrievedContext.coverage.tokens,
        },
      });
      await save();
    }
    const { context, manifest } = contextFor(p, ch, req.instruction, entries, {
      continuity,
      profile: budget,
      retrieved: state.retrievedContext,
    });
    const recentChapterId = p.chapters
      .filter((c) => c.number < ch.number)
      .sort((a, b) => a.number - b.number)
      .at(-1)?.id;
    const writingContext = modelWritingContext(context, { recentChapterId });
    state.manifest = manifest;
    if (context.memorySelection && !state.memorySelection) {
      state.memorySelection = context.memorySelection;
      appendCreationEvent(state, {
        category: "memory",
        status: "success",
        title: "分层记忆召回已完成",
        details: {
          有效记录: context.memorySelection.totalRecords,
          选中记录: context.memorySelection.selectedRecords,
          必需记录: context.memorySelection.requiredRecords,
          原文命中记录: context.memorySelection.retrievedRecords,
          说明: "近期记忆与作者引用保留，历史事实按记录合并召回；时间线另行核对。",
        },
      });
    }
    await save();
    const count = Math.max(1, Math.ceil(words / 1200));
    const sceneShape = {
      goal: "本场景具体行动与后果",
      knowledge: "允许知道和揭示的内容",
      ...(continuity
        ? {
            time: {
              start: "开始时间",
              gap: "距前场景的间隔",
              duration: "本场景经过多久",
              end: "结束时间",
            },
          }
        : {}),
    };
    const plan = await ask(
      "scene-plan",
      [
        {
          role: "system",
          content: `${WRITING_RULES}\n为当前章设计恰好${count}个连续场景。每个场景有行动、阻力、选择、后果，并遵守知情边界。只输出JSON：${JSON.stringify({ scenes: [sceneShape] })}。${continuity ? "每个场景必须填写time全部四项，按已知时间锚点推进，不得漏填。未定绝对日期时使用相对时间，不补造年份或历法；回忆分别标明事件时间和叙述时间。" : ""}不得复制尚未揭示的秘密。章纲只是计划；回忆必须依据原文，缺失关键依据应明确报告，不能补造过去对白。`,
        },
        {
          role: "user",
          content: JSON.stringify({
            ...writingContext,
            targetWords: words,
            chapterWordRange: wordRange,
            ...(continuity
              ? {
                  timeRequirements:
                    "每个场景必须另提供time:{start:开始时间,gap:距前场景的间隔,duration:本场景经过多久,end:结束时间}，四项均为非空字符串。依据continuity中的已发生时间和前场景顺序安排，不重新发明到任等固定日期。未定绝对日期时使用明确相对时间，不能补造年份或历法。回忆分别写明回忆发生时间与当前叙述时间。计划不是已经发生的事实。",
                }
              : {}),
          }),
        },
      ],
      (v) => {
        const result = scenesSchema.parse(v);
        if (result.scenes.length !== count)
          throw Error(`必须规划${count}个场景`);
        if (continuity && result.scenes.some((s) => !s.time))
          throw Error(
            "每个场景必须提供time.start/gap/duration/end，未定绝对日期时用相对时间，不补造日期。",
          );
        return result;
      },
      5000,
      "规划本章场景",
      { contract: scenesContract },
    );
    const budgets = plan.scenes.map(
      (_, i) => Math.floor(words / count) + (i < words % count ? 1 : 0),
    );
    async function writeScene(
      i,
      round,
      feedback = [],
      sceneWords = budgets[i],
      strictLength = false,
    ) {
      const key = `scene:${i}:round:${round}${round ? ":" + digest(feedback).slice(0, 16) : ""}`;
      if (state.values[key]) return state.values[key];
      let text =
        state.fragments[key] ||
        (strictLength ? state.values[`final-scene:${i}`] || "" : "");
      const totalBefore = strictLength
        ? plan.scenes.reduce(
            (sum, _, j) =>
              sum + countWords(state.values[`final-scene:${j}`] || ""),
            0,
          )
        : 0;
      const share =
        strictLength && totalBefore
          ? countWords(state.values[`final-scene:${i}`] || "") / totalBefore
          : 0;
      const lower = strictLength
        ? Math.ceil(wordRange.min * share)
        : Math.ceil(sceneWords * 0.7);
      const upper = strictLength
        ? Math.floor(wordRange.max * share)
        : Math.floor(sceneWords * 1.6);
      const distance = (sceneLength) =>
        strictLength
          ? lengthDistance(
              totalBefore -
                countWords(state.values[`final-scene:${i}`] || "") +
                sceneLength,
              wordRange.min,
              wordRange.max,
            )
          : lengthDistance(sceneLength, lower, upper);
      const prior = plan.scenes.slice(0, i).map((s, j) => ({
        goal: s.goal,
        content: state.values[`final-scene:${j}`] || "",
      }));
      const following = plan.scenes.slice(i + 1).flatMap((_, offset) => {
        const index = i + 1 + offset,
          content = state.values[`final-scene:${index}`];
        return content ? [{ scene: index + 1, content }] : [];
      });
      async function finishScene() {
        // 场景只分配参考预算，完整初稿先汇总，再以整章范围验收。
        if (!strictLength && state.values[`${key}:ended`] && text.trim()) {
          state.values[key] = text;
          await save();
          return text;
        }
        const fitsChapter = () => {
          if (!strictLength) return false;
          const total = plan.scenes.reduce(
            (sum, _, j) =>
              sum +
              countWords(
                j === i ? text : state.values[`final-scene:${j}`] || "",
              ),
            0,
          );
          return total >= wordRange.min && total <= wordRange.max;
        };
        state.lengthRepairs ??= {};
        const history = (state.lengthRepairs[key] ??= {
          targetWords: sceneWords,
          attempts: [],
        });
        const originalKey = `length-original:${key}`;
        state.fragments[originalKey] ??= text;
        for (let repair = 0; repair < 3; repair++) {
          const actual = countWords(text);
          if ((actual >= lower && actual <= upper) || fitsChapter()) {
            state.values[key] = text;
            await save();
            return text;
          }
          const fixed = await call(
            sceneLengthMessages({
              draft: text,
              targetWords: sceneWords,
              lower,
              upper,
              scene: plan.scenes[i],
              author: p.author,
              previousScenes: prior,
              followingScenes: following,
              feedback,
              attempts: history.attempts,
            }),
            6000,
            `调整第 ${ch.number} 章场景 ${i + 1} 的篇幅`,
            true,
          );
          const rawKey = `raw-repair:${key}:${state.calls}`;
          state.fragments[rawKey] = fixed.text;
          state.responseMeta ??= {};
          state.responseMeta[rawKey] = {
            finishReason: fixed.finishReason,
            model: fixed.model,
            usage: fixed.usage,
          };
          await save();
          // 完整重写以供应商正常结束为准；标记只是辅助协议，漏写不能丢弃修订。
          // length 即便携带标记也不能当作完整输出。
          if (fixed.finishReason !== "stop")
            throw Error(
              "篇幅修订输出未完整结束，已保留原场景与修订尝试，可恢复重试。",
            );
          const candidate = fixed.text.replaceAll("〈场景完成〉", "").trim();
          const candidateWords = countWords(candidate);
          const improved =
            candidateWords > 0 && distance(candidateWords) < distance(actual);
          history.attempts.push({
            call: state.calls,
            beforeWords: actual,
            candidateWords,
            improved,
          });
          if (improved) {
            text = candidate;
            state.fragments[key] = text;
          }
          appendCreationEvent(state, {
            category: "writing",
            status: improved ? "success" : "waiting",
            title: improved
              ? "场景篇幅调整取得进展"
              : "场景篇幅未改善，保留较优草稿并调整提示",
            details: {
              章节: ch.number,
              场景: i + 1,
              目标字数: sceneWords,
              调整前: actual,
              本次输出: candidateWords,
              保留字数: countWords(text),
            },
          });
          await save();
        }
        const actual = countWords(text);
        if ((actual >= lower && actual <= upper) || fitsChapter()) {
          state.values[key] = text;
          await save();
          return text;
        }
        if (strictLength && text.trim()) {
          appendCreationEvent(state, {
            category: "writing",
            status: "waiting",
            title: "保留本场景较优草稿，继续整章篇幅调整",
            details: {
              场景: i + 1,
              实测字数: actual,
              整章允许范围: `${wordRange.min}—${wordRange.max}字`,
            },
          });
          await save();
          return text;
        }
        throw Error(`场景${i + 1}尚未完整结束，草稿已保留，可恢复重试。`);
      }
      if (
        strictLength ||
        state.values[`${key}:ended`] ||
        countWords(text) > upper
      )
        return finishScene();
      for (let continuation = 0; continuation < 4; continuation++) {
        const response = await call(
          [
            {
              role: "system",
              content: `${WRITING_RULES}\n仅写当前场景的小说正文，不输出JSON、标题、计划或字数说明。本场参考目标约${sceneWords}字，整章目标${words}字，允许${wordRange.min}—${wordRange.max}字，场景可按情节不均分（汉字逐字计，标点不计）。续写只输出接下来的新文字，不复述已有段落。场景完成时另起一行输出〈场景完成〉，不能提前标记。修订反馈只适用于当前场景。`,
            },
            {
              role: "user",
              content: JSON.stringify({
                ...writingContext,
                sceneIndex: i + 1,
                totalScenes: count,
                scene: plan.scenes[i],
                previousScenes: prior,
                followingScenes: following,
                feedback,
                previousDraft: round
                  ? state.values[`final-scene:${i}`] || ""
                  : undefined,
                alreadyWritten: text,
                remainingWords: Math.max(0, sceneWords - countWords(text)),
              }),
            },
          ],
          6000,
          `${round ? "修订" : "起草"}第 ${ch.number} 章 · 场景 ${i + 1}/${count}${text ? " · 续写" : ""}`,
          true,
        );
        state.fragments[`raw-scene:${key}:${state.calls}`] = response.text;
        await save();
        const next = response.text.replaceAll("〈场景完成〉", "").trim();
        const ended =
          response.finishReason === "stop" &&
          (response.text.includes("〈场景完成〉") ||
            countWords(text + next) >= lower);
        if (!next && !(ended && text))
          throw Error("场景没有新增正文，已保存草稿。");
        if (next && text.endsWith(next))
          throw Error("续写重复了已有结尾，已保留草稿，请检查后重试。");
        text +=
          (text && next && !state.values[`${key}:partial`] ? "\n\n" : "") +
          next;
        state.fragments[key] = text;
        state.values[`${key}:partial`] = response.finishReason === "length";
        if (ended) state.values[`${key}:ended`] = true;
        await save();
        if (ended) return finishScene();
      }
      throw Error("当前场景续写达到4次，草稿已保存，可恢复继续。");
    }
    for (let i = 0; i < count; i++) {
      if (!state.values[`final-scene:${i}`]) {
        state.values[`final-scene:${i}`] = await writeScene(i, 0);
        await save();
      }
    }
    async function balanceLength(round) {
      const maxPasses = Math.max(3, count * 2),
        attempted = new Set();
      for (let pass = 0; pass <= maxPasses; pass++) {
        const lengths = plan.scenes.map((_, i) =>
          countWords(state.values[`final-scene:${i}`]),
        );
        const total = lengths.reduce((a, b) => a + b, 0);
        if (total >= wordRange.min && total <= wordRange.max) return;
        if (pass === maxPasses) break;
        if (attempted.size === count) attempted.clear();
        const i = lengths
          .map((length, index) => ({ length, index }))
          .filter(({ index }) => !attempted.has(index))
          .sort((a, b) => b.length - a.length)[0].index;
        attempted.add(i);
        // 按当前场景占比逐步调整，不能把整章全部超额都从一个场景扣除。
        const goal = Math.max(100, Math.round((words * lengths[i]) / total));
        state.values[`final-scene:${i}`] = await writeScene(
          i,
          100 + round * Math.max(3, count * 2) + pass,
          [
            {
              fix: `整章实测${total}字，目标${words}字，允许${wordRange.min}—${wordRange.max}字。按本场景占比分担篇幅调整，只调整本场景到${goal}字，保留因果和关键事实；其他场景仍可继续调整，不必由本场景承担全部差额。`,
            },
          ],
          goal,
          true,
        );
        await save();
      }
      throw Error(
        `整章篇幅调整后仍超出${wordRange.min}—${wordRange.max}字，所有场景已保存，可恢复重试。`,
      );
    }
    // 篇幅调整发生在证据审稿之前；审稿之后禁止整场重写。
    if (!state.paragraphReview) await balanceLength(0);
    if (continuity && !state.continuityEvidence) {
      state.continuityEvidence = retrieveContinuitySources(
        p.chapters,
        ch.number,
        plan.scenes
          .map((_, i) => state.values[`final-scene:${i}`])
          .join("\n\n"),
      );
      appendCreationEvent(state, {
        category: "review",
        status: "success",
        title: "已独立回查历史正文",
        details: {
          扫描章节:
            state.continuityEvidence.coverage.scannedChapters.join("、") ||
            "无前章",
          原文段落: `${state.continuityEvidence.coverage.suppliedParagraphs}/${state.continuityEvidence.coverage.totalParagraphs}`,
          说明: "独立于写作记忆检索，包含原文邻段；未命中不代表全书不存在。",
        },
      });
      await save();
    }
    const reviewContext = continuity
      ? {
          ...context,
          sceneTimes: plan.scenes.map((s, i) => ({ scene: i + 1, ...s.time })),
          continuitySources: state.continuityEvidence.sources,
          continuityCoverage: state.continuityEvidence.coverage,
        }
      : context;
    state.reviewContext = reviewContext;
    recordDraftVersion(state, "起草完成的原始草稿");
    await save();
    const reviewed = await reviewAndPatch({
      scenes: plan.scenes.map((_, i) => ({
        scene: i + 1,
        content: state.values[`final-scene:${i}`],
      })),
      context: reviewContext,
      profile: budget,
      ask,
      state,
      save,
      signal,
      minWords: wordRange.min,
      maxWords: wordRange.max,
      prepareContinuity: continuity
        ? async (scenes) => {
            const draft = {
              ...ch,
              content: scenes.map((s) => s.content).join("\n\n"),
            };
            const candidate = {
              ...p,
              chapters: p.chapters.map((c) => (c.id === ch.id ? draft : c)),
              memory: { version: 1, entries },
            };
            const currentEntries = await indexChapter(
              candidate,
              draft,
              ask,
              extractionOptions,
            );
            // 原文变更即换提取缓存；每轮按新稿重算，不能沿用修订前的天数。
            return continuityLedger(
              [
                ...entries.filter((e) =>
                  p.chapters.some(
                    (c) => c.id === e.chapterId && c.number < ch.number,
                  ),
                ),
                ...currentEntries,
              ],
              draft.content,
            );
          }
        : undefined,
    });
    for (const scene of reviewed.scenes)
      state.values[`final-scene:${scene.scene - 1}`] = scene.content;
    await save();
    const content = plan.scenes
      .map((_, i) => state.values[`final-scene:${i}`])
      .join("\n\n");
    const actual = countWords(content);
    if (actual < wordRange.min || actual > wordRange.max)
      throw Error(
        `整章实测${actual}字，目标${words}字，允许${wordRange.min}—${wordRange.max}字，草稿已保留。`,
      );
    const chapters = p.chapters.map((c) =>
      c.id === ch.id ? { ...c, content } : c,
    );
    const candidate = { ...p, chapters, memory: { version: 1, entries } };
    entries = entries
      .filter((e) => e.chapterId !== ch.id)
      .concat(
        await indexChapter(
          candidate,
          chapters.find((c) => c.id === ch.id),
          ask,
          extractionOptions,
        ),
      );
    const proposal = {
      summary: `第 ${ch.number} 章已独立完成，实测${actual}字 / 目标${words}字（允许${wordRange.min}—${wordRange.max}字），共${count}个场景，等待采纳。已通过字数检查、${continuity ? "历史原文回查、时间与事实专项审稿、" : ""}带证据审稿与段落补丁复核，文学质量仍需作者审阅。${reviewed.review.issues.length ? `另有${reviewed.review.issues.length}项非阻断疑点或建议，已保留在审稿记录中。` : ""}${targets.length > 1 ? `本次只交付首章；另外${targets.length - 1}章请采纳后在章节页逐章继续。` : ""}`,
      chapters,
      memory: { version: 1, entries },
      ...(ch.content ? { revisionScope: [ch.id] } : {}),
    };
    applyProposal(p, proposal, p.revision);
    state.status = "ready";
    state.stage = "章节候选已完成";
    await save();
    signal.throwIfAborted();
    return {
      proposal,
      model: config.model,
      calls: state.calls,
      usages: state.usages,
      promptVersion: WORKFLOW_VERSION,
    };
  } catch (e) {
    if (
      !signal.aborted &&
      draftScenes(state).some((s) => s.content.trim()) &&
      (e.name === "ReviewRetryableError" ||
        e.code === "AUTHOR_REVISION_LIMIT" ||
        state.draftWork)
    ) {
      if (e.name !== "WaitingForAuthor") {
        pauseDraft(state, e.message);
        await save();
        return {
          draftOnly: true,
          model: config.model,
          calls: state.calls,
          usages: state.usages,
          promptVersion: WORKFLOW_VERSION,
        };
      }
    }
    state.status = signal.aborted
      ? "interrupted"
      : e.name === "WaitingForAuthor"
        ? "awaiting_input"
        : e.name === "ReviewRetryableError"
          ? "retryable"
          : "failed";
    state.error = e.name === "WaitingForAuthor" ? "" : e.message;
    await save();
    throw e;
  }
}
