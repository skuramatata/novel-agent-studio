import { createHash } from "node:crypto";
import { z } from "zod";
import { workflowContract } from "./workflow-skill.mjs";
import { sourceParts } from "./memory.mjs";
import {
  emptyStoryEvents,
  mergeStoryEvents,
  impactOf,
  chapterCoverage,
  eventEvidence,
  normalizeStoryEvents,
  storyEventIssues,
  setIssueDisposition,
} from "./story-events.mjs";
import {
  STORY_EVENT_KINDS,
  STORY_EVENT_BASES,
  STORY_EDGE_TYPES,
  STORY_EDGE_BASES,
} from "./story-events-schema.mjs";

const shortHash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const eventDraftSchema = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().max(1200).optional(),
    kind: z.enum(STORY_EVENT_KINDS),
    actors: z.array(z.string().max(80)).max(24),
    objects: z.array(z.string().max(80)).max(24),
    basis: z.enum(STORY_EVENT_BASES),
    storyTime: z.string().max(160).optional(),
    sourceId: z.number().int().positive().optional(),
    quote: z.string().min(1).max(2000),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .strict();

// 端点可用两种方式表达：
// - sourceId/targetId：本次分片内的临时序号（1 起）
// - sourceRef/targetRef：已存在的正式事件 ID（如 sev-xxxxxxxxxxxx），可跨章
// 程序再把临时标识解析成持久化 ID，模型不接触、也不能自造持久化身份。
const relationDraftSchema = z
  .object({
    sourceId: z.number().int().positive().optional(),
    targetId: z.number().int().positive().optional(),
    sourceRef: z.string().min(1).max(120).optional(),
    targetRef: z.string().min(1).max(120).optional(),
    type: z.enum(STORY_EDGE_TYPES),
    basis: z.enum(STORY_EDGE_BASES).optional(),
    explanation: z.string().max(2000),
    evidenceSourceId: z.number().int().positive().optional(),
  })
  .strict();

const extractionSchema = z
  .object({
    summary: z.string().max(800),
    events: z.array(eventDraftSchema).max(24),
    relations: z.array(relationDraftSchema).max(32).optional(),
  })
  .strict();

export const STORY_EVENT_EXTRACTION_POLICY = "story-events-v1";
const extractionContract = workflowContract(
  "memory_extract",
  extractionSchema,
  { displaySchema: extractionSchema },
);

const SYSTEM_PROMPT = `从提供的小说原文抽取故事事件与事件间关系，只输出JSON。events 最多24条，relations 最多32条。
每个事件必须逐字引用支持它的原文 quote（也可选择 sources 中的 sourceId），程序会按 span 回填出处。
kind 只能填：action（行动）、decision（决定）、discovery（发现）、handover（转交）、state-change（状态变化）、recall（回忆/回溯）、other。
basis 只能填：narration（正文叙述）、testimony（人物证词）、document（文件所载）、belief（人物信念）、rumor（传闻）、author（作者设定）。
只有原文明确写出的前后因果才能建立 relations 并用 basis=explicit；仅时间相邻、共享人物或共享物件不构成因果。
推测关系必须显式 basis=inferred；无法核实的填 unverified。relations 的 explanation 必须写清依据，不能只写"相关"。
人物回忆前文事件时用 kind=recall，并可用 relations 指向被回忆事件（type=recall）。
不得为凑数拆分事件，不得把章纲或计划当成已发生事实，不得补写原文没有的因果。
格式：{"summary":"本片摘要","events":[{"title":"事件标题","summary":"一句话","kind":"action","actors":["人物"],"objects":["物件"],"basis":"narration","storyTime":"未知或原文时间","sourceId":1,"quote":"原文逐字"}],"relations":[{"sourceId":1,"targetId":2,"type":"causal","basis":"explicit","explanation":"原文依据","evidenceSourceId":1}]}`;

// 每个分片独立抽取；区间偏移由程序按分片重新计算，模型只判断片段内相对位置。
function locate(partText, quote, partStart) {
  const start = partText.indexOf(quote);
  if (start < 0) return null;
  return { start: partStart + start, end: partStart + start + quote.length };
}

// 无区间时的定位：引文在本片必须唯一出现。
// 重复出现说明模型没给区间、程序无法判断指的是哪一处，此时报歧义，
// 不能静默选第一处（那会把第二次事件标到第一次的位置上）。
function locateUnique(partText, quote, partStart, failures, context) {
  if (!quote) return null;
  const first = partText.indexOf(quote);
  if (first < 0) return null;
  const second = partText.indexOf(quote, first + 1);
  if (second >= 0) {
    failures.push(
      `第${context.chapter.number}章第${context.part + 1}片 events[${context.event}] 引文「${quote}」` +
        `在本片出现多处（${first}、${second}…），缺少 start/end 无法唯一定位，属歧义，已拒绝该事件。`,
    );
    return null;
  }
  return {
    start: partStart + first,
    end: partStart + first + quote.length,
  };
}


const HISTORY_LIMIT = 12;
const HISTORY_QUOTE = 240;

// 给抽取请求挑出可在本章引用的历史事件：只取本章之前的正式事件（不含候选），
// 按与当前片段的字面相关性排序，并附上持久化 ID 与原文证据。
// 未装入的历史事件在 historyCoverage 里明确标注未覆盖，不能假装全书不存在。
function historyPayloadFor(graph, chapter, partText, partIndex) {
  const before = graph.nodes.filter(
    (node) => node.chapterNumber < chapter.number && node.status !== "candidate",
  );
  const scored = before.map((node) => {
    const haystack = [node.title, node.summary, ...node.actors, ...node.objects].join(" ");
    let score = 0;
    for (const token of new Set([...haystack])) if (partText.includes(token)) score += 1;
    if (node.actors.some((a) => partText.includes(a))) score += 6;
    if (node.objects.some((o) => partText.includes(o))) score += 6;
    return { node, score };
  });
  const picked = scored
    .sort((a, b) => b.score - a.score || a.node.chapterNumber - b.node.chapterNumber)
    .slice(0, HISTORY_LIMIT)
    .map(({ node }) => node);
  const uncoveredChapters = [
    ...new Set(
      before
        .filter((node) => !picked.some((p) => p.id === node.id))
        .map((node) => node.chapterNumber),
    ),
  ].sort((a, b) => a - b);
  return {
    historyEvents: picked.map((node) => ({
      id: node.id,
      chapterNumber: node.chapterNumber,
      chapterTitle: node.chapterTitle,
      title: node.title,
      summary: node.summary,
      storyTime: node.storyTime,
      kind: node.kind,
      actors: node.actors,
      objects: node.objects,
      basis: node.basis,
      quote: node.evidence.quote.slice(0, HISTORY_QUOTE),
    })),
    historyCoverage: {
      chapterId: chapter.id,
      part: partIndex + 1,
      totalBefore: before.length,
      provided: picked.length,
      uncoveredChapters,
      note: before.length
        ? picked.length
          ? "仅提供按相关性选出的历史事件；未列出的历史事件不代表不存在，需时可增加引用范围。"
          : "本片没有装入历史事件；这不代表全书不存在相关事件。"
        : "本章之前还没有已抽取事件。",
    },
    historyRules:
      "historyEvents 是已存在的正式事件，可直接用其 id 作为 relations 的 sourceRef/targetRef 端点。events 中的新事件用 1 起临时序号，在 relations 里通过 sourceId/targetId 引用；不要自造 sev- 开头的 ID。",
  };
}

// 把模型给的端点解析成持久化 ID：临时序号 → 本片新事件；ref → 已存在正式事件。
function resolveEndpoint(raw, idKey, refKey, localIds, created, graph, chapter) {
  if (Number.isInteger(raw?.[idKey])) {
    if (!localIds.has(raw[idKey]))
      return { error: "临时序号不在本片事件范围内" };
    const index = localIds.get(raw[idKey]);
    // null 表示该原始序号的事件已被拒绝（引文不匹配等），必须明确报错，
    // 不能跳过或顺移到下一个事件，否则关系会连到错误的事件上。
    if (index === null)
      return {
        error: `临时序号 ${raw[idKey]} 对应的事件已被拒绝（出处无效），无法作为关系端点`,
      };
    const node = created[index];
    if (!node) return { error: "临时序号未对应到已建立事件" };
    return { id: node.id };
  }
  const ref = raw?.[refKey];
  if (typeof ref === "string" && ref) {
    const node = graph.nodes.find((n) => n.id === ref);
    if (!node) return { error: `引用的事件 ${ref} 不在本作品正式图中` };
    // 候选可引用正式历史，但不能指向其他章节尚未生效的候选或未来章。
    if (node.status === "candidate") return { error: `引用的事件 ${ref} 仍是候选状态` };
    return { id: node.id };
  }
  return { error: "端点必须提供临时序号或已存在事件 ID" };
}

export async function extractStoryEvents(
  p,
  ask,
  { chapterIds, maxChars = 4000, model = "", signal } = {},
) {
  const targets = p.chapters
    .filter((c) => c.content.trim())
    .filter((c) => !chapterIds || chapterIds.includes(c.id))
    .sort((a, b) => a.number - b.number);
  const known = p.storyEvents ?? emptyStoryEvents();
  let graph = normalizeStoryEvents({ ...known, chapters: p.chapters });
  const coverage = new Map(
    (known.coverage || []).map((entry) => [entry.chapterId, entry]),
  );
  for (const chapter of p.chapters)
    if (!coverage.has(chapter.id))
      coverage.set(chapter.id, chapterCoverage({ chapterId: chapter.id, status: "pending" }));
  const failures = [];
  for (const chapter of targets) {
    signal?.throwIfAborted?.();
    const parts = sourceParts(chapter.content, maxChars);
    const done = [];
    for (const [index, part] of parts.entries()) {
      const sources = splitSources(part.text);
      try {
        const value = await ask(
          `story-events:${chapter.id}:${shortHash(part.text)}:${index}`,
          [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                chapterId: chapter.id,
                chapter: chapter.number,
                part: index + 1,
                parts: parts.length,
                sources,
                ...historyPayloadFor(graph, chapter, part.text, index),
              }),
            },
          ],
          (raw) => extractionSchema.parse(raw),
          4000,
          `抽取第 ${chapter.number} 章事件 · ${index + 1}/${parts.length}`,
          { contract: extractionContract },
        );
        const nodeDrafts = [];
        const localIds = new Map();
        for (const [i, event] of value.events.entries()) {
          const ref =
            Number.isInteger(event.sourceId) && sources[event.sourceId - 1]
              ? sources[event.sourceId - 1]
              : null;
          if (!ref && !Number.isInteger(event.start))
            failures.push(`第${chapter.number}章第${index + 1}片 events[${i}] 未给出可定位的 sourceId 或区间`);
          // F3：区间只用来"核验"模型引文，不用来重新截取。
          // 区间与逐字引文不一致时必须拒绝并报因，不能按区间换一段文字当证据。
          const hasSpan =
            Number.isInteger(event.start) && Number.isInteger(event.end);
          const span = hasSpan
            ? { start: part.start + event.start, end: part.start + event.end }
            : null;
          const quote = event.quote || ref?.text || "";
          // G3：模型给了区间时，区间是"已核验的位置"，必须优先采用。
          // indexOf 只会返回首次匹配；正文里重复出现同一句时（如两次"甲敲门。"），
          // 用首处会把第二次事件错标到第一次的位置。
          const located = hasSpan
            ? { start: span.start, end: span.end }
            : locateUnique(part.text, quote, part.start, failures, {
                chapter,
                part: index,
                event: i,
              });
          if (!located) {
            // 占用该原始序号但标记为无效，供 relations 解析时明确报错。
            localIds.set(i + 1, null);
            failures.push(
              `第${chapter.number}章第${index + 1}片 events[${i}].quote 不在原文中`,
            );
            continue;
          }
          if (hasSpan) {
            const slice = chapter.content.slice(span.start, span.end);
            if (slice !== event.quote) {
              localIds.set(i + 1, null);
              failures.push(
                `第${chapter.number}章第${index + 1}片 events[${i}] 区间与引文不符：` +
                  `start=${event.start}/end=${event.end} 处原文是「${slice}」，` +
                  `模型 quote 是「${event.quote}」；引用必须逐字对应，已拒绝该事件。`,
              );
              continue;
            }
          }
          if (!ref && !hasSpan && !located) {
            failures.push(
              `第${chapter.number}章第${index + 1}片 events[${i}] 未给出可定位的 sourceId 或区间`,
            );
            continue;
          }
          // 证据区间取模型引文在原文中的真实位置，引文本身保持模型原样。
          const evidence = eventEvidence(
            chapter.id,
            chapter.content,
            located.start,
            located.end,
          );
          nodeDrafts.push({
            chapterId: chapter.id,
            title: event.title,
            summary: event.summary ?? "",
            kind: event.kind,
            actors: event.actors,
            objects: event.objects,
            basis: event.basis,
            storyTime: event.storyTime ?? "",
            evidence,
          });
          // F4/G1：事件临时编号与原文片段 sourceId 是两套编号，必须分开。
          // ① event.sourceId 只指向本片 sources[]（用于定位原文）；
          // ② 事件临时编号 = 模型本次输出的原始序号（第 i 个事件即 i+1），
          //    与"是否被接受"无关；③ 持久化 ID 由 mergeStoryEvents 生成。
          // 关键：编号不能按 nodeDrafts.length 递增。若第 1 个事件被拒后重新编号，
          // 关系 2→3 会连到丙开门→丁离开（错移一位）。这里用 events 的下标，
          // 被拒事件显式记为 null，关系引用它时报无效端点，绝不静移接。
          localIds.set(i + 1, nodeDrafts.length - 1);
        }
        const merged = mergeStoryEvents(graph, nodeDrafts, {
          chapters: p.chapters,
          coverage: [
            chapterCoverage({
              chapterId: chapter.id,
              status: "extracted",
              parts: [...done, index],
              model,
            }),
          ],
        });
        graph = merged.storyEvents;
        // localIds 记的是 nodeDrafts 的下标，created 必须与之一一对应地取回节点，
        // 不能按引文再筛一遍（同引文合并、跨章事件都会让下标错位）。
        const created = nodeDrafts.map((draft) =>
          graph.nodes.find(
            (n) =>
              n.chapterId === draft.chapterId &&
              n.evidence.start === draft.evidence.start &&
              n.evidence.end === draft.evidence.end &&
              n.title === draft.title,
          ) ?? null,
        );
        const edgeDrafts = [];
        for (const [i, relation] of (value.relations || []).entries()) {
          const from = resolveEndpoint(
            relation,
            "sourceId",
            "sourceRef",
            localIds,
            created,
            graph,
            chapter,
          );
          const to = resolveEndpoint(
            relation,
            "targetId",
            "targetRef",
            localIds,
            created,
            graph,
            chapter,
          );
          if (from.error || to.error) {
            failures.push(
              `第${chapter.number}章第${index + 1}片 relations[${i}] 端点无效：${from.error || to.error}`,
            );
            continue;
          }
          const source = { id: from.id };
          const target = { id: to.id };
          const ref = sources[(relation.evidenceSourceId ?? relation.sourceId) - 1];
          edgeDrafts.push({
            source: source.id,
            target: target.id,
            type: relation.type,
            basis: relation.basis ?? "explicit",
            explanation: relation.explanation,
            evidence: ref
              ? [
                  {
                    chapterId: chapter.id,
                    start: part.start,
                    end: part.end,
                    quote: part.text,
                  },
                ]
              : [],
          });
        }
        if (edgeDrafts.length) {
          graph = mergeStoryEvents(graph, [], {
            chapters: p.chapters,
            edges: edgeDrafts,
          }).storyEvents;
        }
        done.push(index);
        coverage.set(
          chapter.id,
          chapterCoverage({
            chapterId: chapter.id,
            status: done.length === parts.length ? "extracted" : "partial",
            parts: done,
            model,
          }),
        );
      } catch (error) {
        failures.push(`第${chapter.number}章第${index + 1}片：${error.message}`);
        if (signal?.aborted) break;
      }
    }
    const status = graph.coverage.find((c) => c.chapterId === chapter.id);
    const failure = failures.filter((f) => f.startsWith(`第${chapter.number}章`));
    coverage.set(
      chapter.id,
      chapterCoverage({
        chapterId: chapter.id,
        status: failure.length ? (done.length ? "partial" : "failed") : done.length ? status?.status ?? "extracted" : "pending",
        parts: done,
        model,
        failure: failure.length ? failure.join("；") : null,
      }),
    );
  }
  const merged = normalizeStoryEvents({
    version: 1,
    nodes: graph.nodes,
    edges: graph.edges,
    coverage: p.chapters.map(
      (c) =>
        coverage.get(c.id) ??
        chapterCoverage({ chapterId: c.id, status: "pending" }),
    ),
    issues: graph.issues,
    chapters: p.chapters,
  });
  const impact = impactOf(merged, p);
  return {
    storyEvents: impact.storyEvents,
    coverage: impact.storyEvents.coverage,
    staleNodeIds: impact.staleNodeIds,
    failures,
  };
}

function splitSources(text, size = 600) {
  const sources = [];
  for (const line of text.match(/[^\n]+\n?|\n/g) || []) {
    for (let start = 0; start < line.length; start += size)
      sources.push({ sourceId: sources.length + 1, text: line.slice(start, start + size) });
  }
  return sources;
}

// 采纳前只改候选消息；采纳后才写回正式作品。
export function applyStoryEventProposal(project, proposal) {
  if (!proposal?.storyEvents) return project;
  return {
    ...project,
    storyEvents: normalizeStoryEvents({
      ...proposal.storyEvents,
      chapters: project.chapters,
    }),
  };
}

function issue(kind, explanation, { nodeIds = [], edgeIds = [], suggestion = "" } = {}) {
  return {
    id: `sit-${shortHash(JSON.stringify([kind, explanation, nodeIds, edgeIds]))}`,
    kind,
    nodeIds,
    edgeIds,
    explanation,
    suggestion,
    disposition: "open",
  };
}

// 缺口检查：只在有原文或明确声明依据时报告，绝不自动改正文。
export function checkStoryEvents(project, graph, { knowledgeClaims = [] } = {}) {
  const normalized = normalizeStoryEvents({ ...graph, chapters: project.chapters });
  const issues = [...normalized.issues];
  const edgeKey = (e) => `${e.source}|${e.target}|${e.type}`;
  const duplicates = new Map();
  for (const edge of normalized.edges) {
    const key = edgeKey(edge);
    if (duplicates.has(key)) {
      issues.push(
        issue("conflict", `同一对事件存在重复的 ${edge.type} 关系。`, {
          nodeIds: [edge.source, edge.target],
          edgeIds: [edge.id, duplicates.get(key)],
          suggestion: "确认保留哪一条，或在作者裁定中合并。",
        }),
      );
    } else duplicates.set(key, edge.id);
  }
  for (const edge of normalized.edges) {
    if (edge.basis === "explicit" && !edge.evidence.length)
      issues.push(
        issue("missing-source", "explicit 关系缺少当前正文可核的依据。", {
          nodeIds: [edge.source, edge.target],
          edgeIds: [edge.id],
          suggestion: "补原文依据，或改为 inferred/unverified。",
        }),
      );
    if (edge.type === "causal" && edge.basis === "inferred")
      issues.push(
        issue("conflict", "因果关系是推断而非原文明确写出，需作者确认。", {
          nodeIds: [edge.source, edge.target],
          edgeIds: [edge.id],
          suggestion: "保留为推断，或补充原文依据。",
        }),
      );
  }
  // state-break：同一物件在同一章或跨章出现不同数量/互斥状态时报告，不判谁对。
  const byObject = new Map();
  for (const node of normalized.nodes) {
    for (const object of node.objects) {
      if (!byObject.has(object)) byObject.set(object, []);
      byObject.get(object).push(node);
    }
  }
  // 只取真正的数量词；"第三章""三十年前""第二遍"这类序数/时长不计入，
  // 否则同一物件只因出现次数词就会被误报成状态冲突。
  const QUANTITY = /[零一二三四五六七八九十百千两\d]+(?:听|个|只|件|枚|把|块|根|张|本|罐|人|份|颗|袋|箱|瓶)/g;
  const numbersOf = (node) => {
    const text = `${node.title}${node.summary}${node.evidence.quote}`;
    return [...text.matchAll(QUANTITY)].map((m) => m[0]);
  };
  const chaptersById = new Map(
    (project.chapters || []).filter(Boolean).map((c) => [c.id, c]),
  );
  // 判断"数量变化是否被解释"：必须有可核的过程，而不是"出现过某个字"。
  // G6：「剩」「余」这类是"剩余状态"的描述，本身不解释数量为何变化——
  // 「此时桌上还剩十个」与「此时桌上只剩九个」在同一时刻并存，是矛盾而非推进。
  // 因此把它们从"过程动词"里移出，只保留真正表示动作/转移的词；
  // 数量变化仍要由前一条（旧量）与后一条（新量）在同章的叙述先后上承接。
  // 真动作（真正改变数量的动作）。
  const PROCESS_ACTION =
    /(吃|喝|用|消耗|分|送|交|取|拿走|丢掉|扔|剥|卖出|买入|添加|添|增加|减少|变为|变成)/;
  // 剩余量/结果态表述：单独出现只说"现在是多少"，不解释变化（G6）。
  const LEFTOVER = /(剩|余|还留|留下)/;
  // 判定"这条陈述是不是在讲变化结果"：必须同时具备
  // ① 结果态用词（剩/余/…）——说明它承接了某个动作；
  // ② 该结果与旧量不同。
  // 只写"某某说十个/九个"这类并存断言不算，即便上下文出现过动作词。
  const statesResult = (text) => LEFTOVER.test(text);
  // F11：数量可能只写在逐字证据里（模型不该被迫把数字重复进标题），
  // 因此判断"新旧量"时必须读证据，与 numbersOf 的读取范围保持一致。
  const countText = (node) =>
    [...`${node.title}${node.summary}${node.evidence.quote}`.matchAll(QUANTITY)]
      .map((m) => m[0])
      .join(",");
  // 叙述先后以本章正文的实际位置为准（narrativeOffset 在草稿里常为 0，
  // 不能作为排序依据）；同起点时用 narrativeOffset 兜底。
  const precedes = (before, after) => {
    if (before.chapterId !== after.chapterId) return false;
    if (before.evidence.end <= after.evidence.start) return true;
    if (after.evidence.end <= before.evidence.start) return false;
    return before.narrativeOffset < after.narrativeOffset;
  };
  // 变化过程可能写在两条事件之前或之间（"席间他吃了苹果。开席时十个苹果，
  // 散席时剩九个。"里动作在旧量之前）。取同章上下文：从 after 所在段落的
  // 段首（或 before 起点前一句）到 after 结束，覆盖"动作→旧量→新量"整段。
  const contextText = (before, after) => {
    const content = chaptersById.get(after.chapterId)?.content ?? "";
    if (!content) return "";
    const from = Math.max(0, Math.min(before.evidence.start, after.evidence.start));
    // 向前扩到所在句子起点，避免把"他吃了"切在句子中间。
    // 向前扩一句：变化动作常写在旧量所在句的上一句
    // （"席间他吃了苹果。开席时十个苹果，…"），只退到本句首会漏掉它。
    const prevBreak = Math.max(
      content.lastIndexOf("。", from - 1),
      content.lastIndexOf(String.fromCharCode(10), from - 1),
    );
    const extraBreak =
      prevBreak > 0
        ? Math.max(
            content.lastIndexOf("。", prevBreak - 1),
            content.lastIndexOf(String.fromCharCode(10), prevBreak - 1),
          )
        : -1;
    const sentenceStart = Math.max(extraBreak + 1, 0);
    return content.slice(Math.min(sentenceStart, from), Math.max(before.evidence.end, after.evidence.end));
  };
  const explainsTransition = (before, after) => {
    if (!precedes(before, after)) return false;
    const own = `${after.title}${after.summary}${after.evidence.quote}`;
    const context = `${own}${contextText(before, after)}`;
    const oldCount = countText(before);
    const newCount = countText(after);
    if (!oldCount || !newCount || oldCount === newCount) return false;
    // ① 后一条自身陈述的是"变化后的结果量"（剩/余…）——它承接了动作；
    //    或 ② 后一条自身含动作词。
    // 两者都不满足时（如"老周说九个"这种并存断言），即便上下文出现过动作词，
    // 也不能算解释了数量差——那是同刻两个互斥陈述，必须进待核对项。
    if (statesResult(own) || PROCESS_ACTION.test(own)) return true;
    // 后一条只是静态陈述，但上下文确实写了动作且它紧接旧量之后：
    // 仍要求后一条带结果态语义，否则不豁免。
    return statesResult(context) && PROCESS_ACTION.test(context) && statesResult(own);
  };
  // 同一时点：同章即视为可能并存；跨章按时间推进处理，不判互斥。
  // 两条都写了相同 storyTime（如"同一时刻"）时，更是明确的"同时并存"，
  // 此时即便出现过程动词也不能当作推进——这是对明确故事时间的尊重。
  const sameTimePoint = (a, b) => a.chapterId === b.chapterId;
  const explicitSameTime = (a, b) =>
    Boolean(a.storyTime) && a.storyTime === b.storyTime;
  for (const [object, nodes] of byObject) {
    const conflicts = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const mine = numbersOf(nodes[i]);
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (nodes[i].kind === "recall" || nodes[j].kind === "recall") continue;
        const theirs = numbersOf(nodes[j]);
        // 只有两条事件都对同一物件给出了数量、且数量不同，才是客观互斥。
        // "标题不同""都是 state-change"不是互斥证据：正常叙事里的两次状态变化
        // 会被误报成矛盾，违背"传闻/悬念/正常叙事不能当成矛盾"的约束。
        // 没有数量词时不做猜测，交由作者或专项审稿判断。
        if (!(mine.length > 0 && theirs.length > 0)) continue;
        if (mine.join(",") === theirs.join(",")) continue;
        // 数量不同只是"需要核对"的候选条件，不是冲突本身：
        // 若两段原文里写明了消耗/转移过程（吃掉、用掉、送出、剩下），
        // 这是正常的状态推进，不报互斥；只有同一时点并存两个互斥数量陈述才报。
        if (!sameTimePoint(nodes[i], nodes[j])) continue;
        // 有承接解释（旧量 → 新量）就算正常推进，不报互斥。
        // 明确同一 storyTime 时不允许用"过程动词"豁免：同刻并存的两个数量
        // 就是互相矛盾，必须进入待核对项（不关闭检查）。
        const explained =
          !explicitSameTime(nodes[i], nodes[j]) &&
          (explainsTransition(nodes[i], nodes[j]) ||
            explainsTransition(nodes[j], nodes[i]));
        if (explained) continue;
        conflicts.push([nodes[i], nodes[j]]);
      }
    }
    if (!conflicts.length) continue;
    const involved = [...new Set(conflicts.flat())];
    issues.push(
      issue(
        "state-break",
        `物件「${object}」出现互斥状态描述，需作者核对：${involved
          .map((n) => `第${n.chapterNumber}章《${n.chapterTitle}》${n.title}`)
          .join(" / ")}。`,
        {
          nodeIds: involved.map((n) => n.id),
          suggestion: "核对原文后决定保留、修正或标注为不可靠叙述；不要自动改正文。",
        },
      ),
    );
  }
  for (const claim of knowledgeClaims) {
    if (claim.learnedIn?.length) continue;
    const claimedNumber =
      project.chapters.find((c) => c.id === claim.claimedAt.chapterId)?.number ??
      Infinity;
    // 只认"本章之前"的获知记录；同章刚发生的发现不能解释本章开头的已知。
    const supported = normalized.nodes.some(
      (node) =>
        node.actors.includes(claim.actor) &&
        node.objects.includes(claim.subject) &&
        node.chapterNumber < claimedNumber &&
        node.chapterId !== claim.claimedAt.chapterId &&
        node.id !== claim.nodeId,
    );
    if (supported) continue;
    issues.push(
      issue(
        "unsourced-knowledge",
        `${claim.actor} 在第${project.chapters.find((c) => c.id === claim.claimedAt.chapterId)?.number ?? "?"}章表现为已知「${claim.subject}」，但未找到获知过程。`,
        {
          suggestion: "由作者决定补交代、改为推测或保留悬念；不得自动补写前情。",
        },
      ),
    );
  }
  const impact = impactOf({ ...normalized, issues }, project);
  return {
    ...impact.storyEvents,
    issues: dedupe(impact.storyEvents.issues),
    staleNodeIds: impact.staleNodeIds,
    staleEdgeIds: impact.staleEdgeIds,
    downstreamNodeIds: impact.downstreamNodeIds,
  };
}

function dedupe(issues) {
  const seen = new Set();
  const out = [];
  for (const item of issues) {
    const key = `${item.kind}|${item.explanation}|${item.nodeIds.join(",")}|${item.edgeIds.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function reviewDisposition(graph, issueId, disposition) {
  // 只改目标问题的处理状态；不重跑归一化，避免按当前正文重判证据后
  // 丢掉合法关系、节点或别人已保存的处理结果。
  return setIssueDisposition(graph, issueId, disposition);
}

// 从本章正文与既有事件链推出"人物未获知却表现为已知"的可解释候选。
// 规则保守：只在该人物本章对某物件做出断定/使用动作、且事件链中此前没有
// 该人物获得该物件的 handover/discovery/knowledge 记录时才提出，宁可少报。
const ACCESS_VERBS = ["数出", "拿出", "掏出", "举起", "摸到", "认出", "断定", "确认", "知道", "记得", "说过"];
const ORDINAL = /^[零一二三四五六七八九十百千两\d]+(?:章|节|回|遍|次|年|月|日|天)$/;

export function knowledgeClaimsFrom(project, graph, chapterId) {
  const chapter = project.chapters?.find((c) => c.id === chapterId);
  if (!chapter?.content?.trim()) return [];
  const normalized = normalizeStoryEvents({ ...graph, chapters: project.chapters });
  const earlier = normalized.nodes.filter(
    (node) => node.chapterId !== chapterId && node.chapterNumber < chapter.number,
  );
  const claims = [];
  for (const node of normalized.nodes) {
    if (node.chapterId !== chapterId) continue;
    if (node.kind === "recall") continue;
    for (const actor of node.actors) {
      for (const object of node.objects) {
        if (ORDINAL.test(object)) continue;
        const known = earlier.some(
          (other) =>
            other.actors.includes(actor) &&
            other.objects.includes(object) &&
            ["handover", "discovery", "action"].includes(other.kind),
        );
        if (known) continue;
        const learnedHere = normalized.edges.some(
          (edge) =>
            edge.type === "knowledge" &&
            (edge.source === node.id || edge.target === node.id),
        );
        if (learnedHere) continue;
        const quote = node.evidence.quote;
        if (!ACCESS_VERBS.some((verb) => quote.includes(verb))) continue;
        claims.push({
          actor,
          subject: object,
          claimedAt: {
            chapterId,
            start: node.evidence.start,
            end: node.evidence.end,
            quote,
          },
          learnedIn: [],
          nodeId: node.id,
        });
      }
    }
  }
  const seen = new Set();
  return claims.filter((claim) => {
    const key = `${claim.actor}|${claim.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 候选只提交本章新增/变更的事件与受影响的边：已存在且未变的节点不进增量，
// 因此长篇不会把整张图塞进消息，界面也能直接看出"本章新增了什么"。
export function storyEventsForProposal(graph, { chapterIds } = {}) {
  // 走正规归一化路径。增量只含本章节点，但跨章边会指向正式历史里的事件，
  // 因此把「本轮范围之外、但确实存在的事件 id」作为 knownNodeIds 传入：
  // 端点合法性 = 本次 nodes ∪ knownNodeIds，两处都没有才丢弃。
  // 这样既不跳过端点校验，也不会把合法的跨章边误判成悬空边。
  const knownNodeIds = new Set(
    (Array.isArray(graph?.nodes) ? graph.nodes : [])
      .filter((node) => !chapterIds || !chapterIds.includes(node.chapterId))
      .map((node) => node.id),
  );
  const normalized = normalizeStoryEvents(
    {
      version: 1,
      nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph?.edges) ? graph.edges : [],
      coverage: Array.isArray(graph?.coverage) ? graph.coverage : [],
      issues: Array.isArray(graph?.issues) ? graph.issues : [],
    },
    { knownNodeIds },
  );
  const scope = chapterIds ? new Set(chapterIds) : null;
  const nodes = normalized.nodes.filter((node) => {
    if (node.status === "candidate") return true;
    if (!scope) return true;
    return scope.has(node.chapterId);
  });
  const ids = new Set(nodes.map((n) => n.id));
  // 边只要有一端落在本轮增量、或证据出自本轮章节，就属于本轮变更；
  // 跨章边的另一端可能指向正式历史，不能因此把整条边丢掉。
  const edges = normalized.edges.filter(
    (edge) =>
      !scope ||
      ids.has(edge.source) ||
      ids.has(edge.target) ||
      edge.evidence.some((e) => scope.has(e.chapterId)),
  );
  return {
    nodes: nodes.map((node) => ({
      chapterId: node.chapterId,
      title: node.title,
      summary: node.summary,
      kind: node.kind,
      actors: node.actors,
      objects: node.objects,
      status: node.status,
      basis: node.basis,
      storyTime: node.storyTime,
      evidence: {
        start: node.evidence.start,
        end: node.evidence.end,
        quote: node.evidence.quote,
      },
    })),
    edges: edges
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        basis: edge.basis,
        explanation: edge.explanation,
        evidence: edge.evidence.map((e) => ({
          chapterId: e.chapterId,
          start: e.start,
          end: e.end,
          quote: e.quote,
        })),
      })),
    coverage: normalized.coverage.filter(
      (entry) => !scope || scope.has(entry.chapterId),
    ),
    // 问题随候选一起提交：类型、说明、建议、关联对象与作者处理状态都不丢，
    // 否则界面与采纳后都无法显示"本轮发现了什么、作者怎么处置"。
    issues: normalized.issues.filter(
      (item) =>
        !scope ||
        [...item.nodeIds, ...item.edgeIds].some((id) => ids.has(id)) ||
        item.nodeIds.length === 0,
    ),
  };
}

export { storyEventIssues };
