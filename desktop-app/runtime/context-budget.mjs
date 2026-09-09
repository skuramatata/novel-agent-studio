import {
  estimatedTokens,
  ensureBudget,
  CONTEXT_LIMIT,
} from "./model-budget.mjs";
import { inputLimit } from "./model-capabilities.mjs";
import {
  compactWritingMemory,
  expandWritingMemory,
} from "./memory-transport.mjs";

// 换用 BPE 后同步换算软额度，避免估算变准却顺手灌入更多历史。
const EVIDENCE_BUDGET = 10000;
const bigrams = (text) =>
  new Set(
    (String(text).match(/[\p{L}\p{N}]{2,}/gu) || []).flatMap((part) =>
      [...part].slice(1).map((_, i) => part.slice(i, i + 2)),
    ),
  );

// 只投影发送给写作者的记忆；不更改原始记忆、审稿文档及引用地址。
export function fitWritingContext(messages, output, profile) {
  const estimate = (value) => estimatedTokens(value, profile);
  const index = messages.findIndex((message) => {
    if (message.role !== "user" || typeof message.content !== "string")
      return false;
    try {
      const data = JSON.parse(message.content);
      return (
        Array.isArray(data.evidence) &&
        data.evidence.every((e) => Array.isArray(e.recordColumns))
      );
    } catch {
      return false;
    }
  });
  if (index < 0) return { messages };
  const data = expandWritingMemory(JSON.parse(messages[index].content));
  const required = new Set(
    [
      data.recentChapterId,
      ...(data.recallSources || []).map((s) => s.chapterId),
    ].filter(Boolean),
  );
  const query = [
    data.instruction,
    data.chapter?.plan,
    data.scene?.goal,
    data.scene?.knowledge,
    JSON.stringify(data.feedback || []),
  ].join(" ");
  const terms = bigrams(query);
  const records = data.evidence.flatMap((entry, entryIndex) =>
    entry.records.map((row, recordIndex) => {
      const fields = Object.fromEntries(
        entry.recordColumns.map((column, i) => [column, row[i]]),
      );
      return {
        entryIndex,
        recordIndex,
        fields,
        quote: entry.quotes[fields.quoteIndex],
        required: required.has(entry.chapterId),
        reasons: entry.recordReasons?.[recordIndex] || [],
      };
    }),
  );
  const entityFrequency = new Map();
  for (const record of records)
    for (const entity of new Set(record.fields.entities || []))
      entityFrequency.set(entity, (entityFrequency.get(entity) || 0) + 1);
  for (const record of records) {
    // 全书常见的人名不会让整份历史条目入选；优先匹配当前行动与物件。
    record.score = [...bigrams(record.fields.text + " " + record.quote)].filter(
      (t) => terms.has(t),
    ).length;
    if (record.reasons.includes("retrieved")) record.score += 1000;
    for (const entity of record.fields.entities || [])
      if (query.includes(entity))
        record.score +=
          20 * Math.log(1 + records.length / entityFrequency.get(entity));
  }
  const included = new Set(records.filter((r) => r.required));
  const assemble = () => {
    const evidence = [],
      sources = [];
    for (const [entryIndex, entry] of data.evidence.entries()) {
      const selected = records.filter(
        (r) => r.entryIndex === entryIndex && included.has(r),
      );
      sources.push({
        chapterId: entry.chapterId,
        part: entry.part,
        totalRecords: entry.records.length,
        includedRecords: selected.map((r) => r.recordIndex),
      });
      if (!selected.length) continue;
      const quotes = [...new Set(selected.map((r) => r.quote))];
      evidence.push({
        ...entry,
        quotes,
        ...(entry.recordReasons
          ? { recordReasons: selected.map((r) => r.reasons) }
          : {}),
        records: selected.map((r) =>
          entry.recordColumns.map((column, i) =>
            column === "quoteIndex"
              ? quotes.indexOf(r.quote)
              : entry.records[r.recordIndex][i],
          ),
        ),
      });
    }
    const coverage = {
      policy:
        "当前场景按记录检索；最近一章及明确引用材料保留。未入选记录仍保存在完整作品记忆中，不能据此声称全书不存在某事。",
      totalRecords: records.length,
      includedRecords: included.size,
      sources,
    };
    const assembled = { ...data, evidence, historyCoverage: coverage };
    const toMessages = (payload) =>
      messages.map((message, i) =>
        i === index
          ? {
              ...message,
              content: JSON.stringify(payload),
            }
          : message,
      );
    const plain = toMessages(assembled);
    if (data.memorySelection?.version !== 2)
      return { messages: plain, coverage };
    const compact = toMessages(compactWritingMemory(assembled));
    const beforeTokens = estimate(plain),
      afterTokens = estimate(compact);
    const transport = JSON.parse(compact[index].content).memoryTransport;
    return afterTokens < beforeTokens && transport
      ? {
          messages: compact,
          coverage,
          transport: { ...transport, beforeTokens, afterTokens },
        }
      : { messages: plain, coverage };
  };
  let result = assemble();
  ensureBudget(result.messages, output, profile);
  // 给场景正文、后文及协议纠错预留空间；必需引用超出软额度时仍完整保留。
  const mandatorySize = estimate(result.messages);
  const emptyData = { ...data, evidence: [] };
  const baseMessages = messages.map((m, i) =>
    i === index ? { ...m, content: JSON.stringify(emptyData) } : m,
  );
  const targetSize = Math.min(
    inputLimit(profile, output),
    data.memorySelection?.version === 2
      ? mandatorySize +
          Math.min(6000, data.memorySelection.optionalBudget ?? 6000)
      : Math.max(mandatorySize, estimate(baseMessages) + EVIDENCE_BUDGET),
  );
  for (const record of records
    .filter(
      (r) =>
        !r.required && (data.memorySelection?.version !== 2 || r.score > 0),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entryIndex - b.entryIndex ||
        a.recordIndex - b.recordIndex,
    )) {
    included.add(record);
    const next = assemble();
    if (estimate(next.messages) <= targetSize) result = next;
    else included.delete(record);
  }
  ensureBudget(result.messages, output, profile);
  return {
    ...result,
    inputEstimate: estimate(result.messages),
    originalInputEstimate: estimate(messages),
  };
}
