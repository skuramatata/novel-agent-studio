import { MEMORY_EXTRACTION_POLICY } from "./memory-extraction-policy.mjs";
import { fitWritingContext } from "./context-budget.mjs";
export { estimatedTokens, ensureBudget } from "./model-budget.mjs";
import { createHash } from "node:crypto";
import { continuityLedger } from "./continuity.mjs";
import {
  continuityRecordSchema,
  CONTINUITY_MEMORY_RULES,
} from "./continuity-schema.mjs";
import { workflowContract } from "./workflow-skill.mjs";
import { z } from "zod";
import { selectMemoryRecords } from "./memory-selection.mjs";
import { INLINE_EVIDENCE_FORMAT } from "./memory-transport.mjs";
import {
  extractedMemorySchema,
  memoryRecordSchema,
  MEMORY_RECORD_LIMIT,
  MEMORY_SUMMARY_LIMIT,
} from "./memory-schema.mjs";
// 持久化旧记忆仍允许缺少 continuity；本轮抽取的必填要求由调用场景决定。
export function memoryExtractionContract({
  continuity = false,
  compact = false,
} = {}) {
  const record = continuity
    ? memoryRecordSchema.extend({ continuity: continuityRecordSchema })
    : memoryRecordSchema;
  const quoted = extractedMemorySchema.extend({
    summary: z
      .string()
      .min(1)
      .max(compact ? 400 : MEMORY_SUMMARY_LIMIT),
    records: z.array(record).max(compact ? 8 : MEMORY_RECORD_LIMIT),
  });
  const source = quoted.extend({
    records: z
      .array(
        record
          .omit({ quote: true })
          .extend({ sourceId: z.number().int().positive() }),
      )
      .max(compact ? 8 : MEMORY_RECORD_LIMIT),
  });
  return workflowContract("memory_extract", z.union([source, quoted]), {
    displaySchema: source,
  });
}
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function isCurrent(entry, p) {
  const c = p.chapters.find((c) => c.id === entry.chapterId);
  return !!c && sourceMatches(entry, c);
}
// 抽取提示只读取本章片段。先核对来源，再允许复用；跨章连续性另行重算。
function sourceMatches(entry, chapter) {
  return (
    entry.sourceHash === digest(chapter.content) &&
    entry.sourceText ===
      chapter.content.slice(entry.sourceStart, entry.sourceEnd) &&
    entry.records.every((r) => entry.sourceText.includes(r.quote))
  );
}
export function sourceParts(content, maxChars = 4000) {
  const parts = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + maxChars, content.length);
    if (end < content.length) {
      const boundary = content.lastIndexOf("\n", end);
      if (boundary > start + maxChars / 2) end = boundary + 1;
    }
    parts.push({ start, end, text: content.slice(start, end) });
    start = end;
  }
  return parts;
}
// 每个编号绑定一个原文片段；引文由程序复制，避免模型抄写时改字或拼接。
export function memorySources(source) {
  const sources = [];
  for (const line of source.match(/[^\n]+\n?|\n/g) || []) {
    for (let start = 0; start < line.length; start += 600) {
      sources.push({
        sourceId: sources.length + 1,
        text: line.slice(start, start + 600),
      });
    }
  }
  return sources;
}
export function validateExtraction(value, source, { continuity = false } = {}) {
  const sources = memorySources(source);
  const resolved = Array.isArray(value?.records)
    ? {
        ...value,
        records: value.records.map((record, index) => {
          if (!record || !Object.hasOwn(record, "sourceId")) return record;
          const ref =
            Number.isInteger(record.sourceId) && sources[record.sourceId - 1];
          if (!ref || !ref.text.trim())
            throw Error(
              `记忆 records[${index}].sourceId 无效，请选择提供的非空原文片段编号。`,
            );
          return { ...record, quote: ref.text };
        }),
      }
    : value;
  const result = extractedMemorySchema.parse(resolved);
  const missing = result.records.flatMap((r, i) =>
    r.continuity ? [] : [`records[${i}].continuity`],
  );
  if (continuity && missing.length)
    throw Error(
      `缺少必填字段：${missing.join("、")}。每条记忆必须提供continuity对象，保留陈述性质、行动主体、物件变化与时间；对象内未知字段按字段表填空串或null，不能省略整个对象或补造事实。`,
    );
  for (const [index, r] of result.records.entries())
    if (!source.includes(r.quote))
      throw Error(
        `记忆 records[${index}] 的引用不在提供的原文中，必须逐字引用。请改用 sourceId 指向提供的原文片段，不要自行改写或拼接 quote。`,
      );
  return result;
}
export async function indexChapter(
  p,
  chapter,
  ask,
  { continuity = false, compact = false } = {},
) {
  const contract = memoryExtractionContract({ continuity, compact });
  const recordLimit = compact ? 8 : MEMORY_RECORD_LIMIT;
  const summaryLimit = compact ? 400 : MEMORY_SUMMARY_LIMIT;
  const hash = digest(chapter.content);
  const parts = sourceParts(chapter.content, compact ? 1600 : 4000),
    entries = [];
  for (const [part, source] of parts.entries()) {
    const cached = p.memory?.entries.find(
      (e) =>
        e.chapterId === chapter.id &&
        e.part === part &&
        sourceMatches(e, chapter) &&
        e.sourceStart === source.start &&
        e.sourceEnd === source.end &&
        (!continuity || e.continuityVersion === 1),
    );
    if (cached) {
      entries.push(cached);
      continue;
    }
    const value = await ask(
      `memory:${chapter.id}:${hash}:${compact ? MEMORY_EXTRACTION_POLICY : "source-only-2"}:${part}${continuity ? ":continuity-1" : ""}`,
      [
        {
          role: "system",
          content:
            `从提供的小说原文抽取有出处的记忆，只输出JSON。summary最多${summaryLimit}字符，只描述本段正文，不能把章纲当成已发生事件。records最多${recordLimit}条，选对后续情节有用的记录，不为凑数拆分。人物的谎言、猜测和传闻必须保留陈述性质；不知道的时间、知情人不要推断。kind只能填以下小写英文值之一：event（事件）、state（状态）、knowledge（知情）、thread（故事线进展）、foreshadow（伏笔）。epistemic只能填observed（原文陈述）、belief（人物信念）、rumor（传闻）、unknown（无法确定）。人物信念可用kind=knowledge、epistemic=belief，不能把belief填入kind。这里的observed也只是原文陈述，不证明叙述者可靠。每条记录必须选择支持该记录的 sources 中的一个 sourceId 整数编号，程序会回填原文引文，不要输出quote或抄写原文。text最多600字符，精简且仅描述该片段支持的事实；entities和knownBy必须是数组，未知时填[]，不能填字符串；各最多12项、每项最多80字符，storyTime最多160字符。格式：{"summary":"本段摘要","records":[{"kind":"event","text":"事件描述","entities":["人物或物件"],"storyTime":"未知","knownBy":[],"epistemic":"observed","sourceId":1${continuity ? ',"continuity":{"assertion":"unknown","actor":"","action":"","object":"","before":"","after":"","evidenceForm":"unknown","time":null}' : ""}}]}` +
            (continuity
              ? "\n" +
                CONTINUITY_MEMORY_RULES +
                "\n实际输出每条records都必须包含完整continuity对象，包含伏笔与状态类记录。"
              : ""),
        },
        {
          role: "user",
          content: JSON.stringify({
            chapter: chapter.number,
            part: part + 1,
            sources: memorySources(source.text),
          }),
        },
      ],
      (value) => {
        const result = validateExtraction(value, source.text, { continuity });
        if (
          result.records.length > recordLimit ||
          result.summary.length > summaryLimit
        )
          throw Error("本批记忆超出记录数或摘要长度上限。");
        return result;
      },
      continuity ? 6000 : 3500,
      `整理第 ${chapter.number} 章记忆 · ${part + 1}/${parts.length}`,
      {
        contract,
        ...(compact
          ? {
              reasoningEffort: "low",
              memoryExtractionPolicy: MEMORY_EXTRACTION_POLICY,
            }
          : {}),
      },
    );
    entries.push({
      ...value,
      chapterId: chapter.id,
      sourceHash: hash,
      part,
      sourceStart: source.start,
      sourceEnd: source.end,
      sourceText: source.text,
      dependencyScope: "chapter",
      ...(continuity ? { continuityVersion: 1 } : {}),
    });
  }
  return entries;
}
// 仅压缩发送给模型的表示；保留全部记录、知情边界及逐字引文。
// 正式记忆和审稿证据仍使用原结构，避免改变已保存任务的引用地址。
export function modelWritingContext(context, { recentChapterId } = {}) {
  const fields = [
    "kind",
    "text",
    "entities",
    "storyTime",
    "knownBy",
    "epistemic",
    ...((context.evidence || []).some((e) =>
      e.records.some((r) => r.continuity),
    )
      ? ["continuity"]
      : []),
  ];
  return {
    ...context,
    ...(recentChapterId ? { recentChapterId } : {}),
    evidence: (context.evidence || []).map((entry) => {
      const quotes = [...new Set(entry.records.map((r) => r.quote))];
      return {
        chapterId: entry.chapterId,
        part: entry.part,
        summary: entry.summary,
        recordColumns: [...fields, "quoteIndex"],
        quotes,
        records: entry.records.map((r) => [
          ...fields.map((field) => r[field]),
          quotes.indexOf(r.quote),
        ]),
        ...(entry.recordReasons ? { recordReasons: entry.recordReasons } : {}),
      };
    }),
    evidenceFormat: INLINE_EVIDENCE_FORMAT,
  };
}
export function contextFor(
  p,
  target,
  instruction,
  entries,
  { continuity = false, profile, retrieved } = {},
) {
  const prior = p.chapters
    .filter((c) => c.number < target.number)
    .sort((a, b) => a.number - b.number);
  const current = entries.filter(
    (e) => isCurrent(e, p) && prior.some((c) => c.id === e.chapterId),
  );
  const requested = [...instruction.matchAll(/第\s*(\d+)\s*章/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n !== target.number);
  const references = p.chapters.filter((c) => requested.includes(c.number));
  const available = prior.filter((c) => c.content.trim());
  const sourceHelp = available.length
    ? `可引用：${available.map((c) => `第${c.number}章《${c.title}》`).join("、")}。请改为实际来源章号；若是人物背景往事，请去掉错误章号并说明背景事件。`
    : "此前还没有已写正文。若是人物背景往事，请去掉引用章号，按人物设定或章纲描述事件。";
  if (requested.some((n) => !references.some((c) => c.number === n)))
    throw Error(
      `引用的${requested
        .filter((n) => !references.some((c) => c.number === n))
        .map((n) => `第${n}章`)
        .join("、")}不存在。${sourceHelp}`,
    );
  if (references.some((c) => c.number >= target.number || !c.content.trim()))
    throw Error(
      `正在写第${target.number}章；历史引用必须指向此前已有正文的章节，不能引用未来章或空白章。${sourceHelp}`,
    );
  const query = instruction + " " + target.summary;
  const names = p.characters
    .filter((c) => query.includes(c.name))
    .map((c) => c.name);
  const {
    evidence,
    manifest,
    coverage: memorySelection,
  } = selectMemoryRecords({
    entries: current,
    chapters: prior,
    references,
    query,
    retrieved,
    profile,
  });
  const context = {
    instruction,
    chapter: {
      id: target.id,
      number: target.number,
      title: target.title,
      plan: target.summary,
    },
    originalChapter: target.content || undefined,
    relations: p.relations.filter(
      (r) =>
        !names.length ||
        p.characters.some(
          (c) =>
            names.includes(c.name) && (c.id === r.source || c.id === r.target),
        ),
    ),
    premise: p.premise,
    author: p.author,
    characters: p.characters
      .filter((c) => !names.length || names.includes(c.name))
      .map(({ secret, ...c }) => c),
    recentText: prior.at(-1)?.content.slice(-2400) || "",
    evidence,
    memorySelection,
    ...(retrieved
      ? {
          retrievedSources: retrieved.sources,
          retrievalCoverage: retrieved.coverage,
        }
      : {}),
    ...(continuity ? { continuity: continuityLedger(current, query) } : {}),
    recallSources: references.map((c) => ({
      chapterId: c.id,
      number: c.number,
      content: c.content,
    })),
    rules:
      "章纲是计划，不是已发生事实。记录均为模型抽取，冲突以原文为依据并报告。区分过去知情、现在知情与当前允许揭示；未检索到不代表可以编造既有事实。人物背景往事可依据已采纳的人物设定和当前章纲展开，不要求此前已写成正文；不得伪称前文已有该事件。关键冲突交由证据审查指出具体句子及处理建议。",
  };
  fitWritingContext(
    [
      {
        role: "user",
        content: JSON.stringify(
          modelWritingContext(context, { recentChapterId: prior.at(-1)?.id }),
        ),
      },
    ],
    Math.min(8000, profile?.capabilities?.maxOutputTokens ?? 8000),
    profile,
  );
  return { context, manifest };
}
export function memoryView(p) {
  return {
    version: 1,
    entries: (p.memory?.entries || []).map((e) => ({
      ...e,
      current: isCurrent(e, p),
    })),
    chapters: p.chapters.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      hasContent: !!c.content.trim(),
      indexed:
        sourceParts(c.content).length > 0 &&
        sourceParts(c.content).every((_, part) =>
          p.memory?.entries.some(
            (e) => e.chapterId === c.id && e.part === part && isCurrent(e, p),
          ),
        ),
    })),
  };
}
