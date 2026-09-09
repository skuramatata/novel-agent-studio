import { createHash } from "node:crypto";
import { estimatedTokens } from "./model-budget.mjs";
import { inputLimit, requestOutput } from "./model-capabilities.mjs";

const grams = (text) =>
  new Set(
    (String(text).match(/[\p{L}\p{N}]+/gu) || []).flatMap((s) =>
      [...s].slice(1).map((_, i) => s.slice(i, i + 2)),
    ),
  );
const recordId = (entry, index) =>
  createHash("sha256")
    .update(
      JSON.stringify([entry.chapterId, entry.sourceHash, entry.part, index]),
    )
    .digest("hex")
    .slice(0, 20);

// 记忆是带出处的抽取记录，不把“较新”“更相似”当作事实裁决。
// 向量命中的原文、文字匹配、近期章节和作者引用并行召回，按记录合并。
export function selectMemoryRecords({
  entries,
  chapters,
  references = [],
  query,
  retrieved,
  profile,
}) {
  const numbers = new Map(chapters.map((c) => [c.id, c.number]));
  const recent = [...chapters].sort((a, b) => a.number - b.number).at(-1)?.id;
  const explicit = new Set(references.map((c) => c.id));
  const terms = grams(query);
  const rows = entries.flatMap((entry, entryIndex) =>
    entry.records.map((record, index) => ({
      entry,
      entryIndex,
      record,
      index,
      id: recordId(entry, index),
      reasons: [
        ...(entry.chapterId === recent ? ["recent"] : []),
        ...(explicit.has(entry.chapterId) ? ["explicit"] : []),
        ...((retrieved?.sources || []).some(
          (s) =>
            s.chapterId === entry.chapterId &&
            (s.text.includes(record.quote) || record.quote.includes(s.text)),
        )
          ? ["retrieved"]
          : []),
      ],
    })),
  );
  const frequencies = new Map();
  for (const r of rows)
    for (const t of grams(r.record.text + " " + r.record.quote))
      frequencies.set(t, (frequencies.get(t) || 0) + 1);
  for (const row of rows) {
    const r = row.record;
    row.score = [...grams(r.text + " " + r.quote)]
      .filter((t) => terms.has(t))
      .reduce((n, t) => n + Math.log(1 + rows.length / frequencies.get(t)), 0);
    const objects = [
      r.continuity?.object,
      r.continuity?.actor,
      ...r.entities,
    ].filter(Boolean);
    if (objects.some((x) => query.includes(x))) row.score += 8;
    if (row.score > 0) row.reasons.push("related");
    // 线索与知情记录同样可按相关性召回，不因不是状态/事件而丢弃。
    if (row.score > 0 && ["thread", "foreshadow", "knowledge"].includes(r.kind))
      row.score += 4;
    if (row.reasons.includes("retrieved")) row.score += 1000;
    row.required =
      row.reasons.includes("recent") || row.reasons.includes("explicit");
  }
  const selected = new Set(rows.filter((r) => r.required));
  const project = (chosen) =>
    entries.flatMap((entry, entryIndex) => {
      const matches = rows.filter(
        (r) => r.entryIndex === entryIndex && chosen.has(r),
      );
      if (!matches.length) return [];
      return [
        {
          chapterId: entry.chapterId,
          part: entry.part,
          summary: entry.summary,
          records: matches.map((r) => r.record),
          recordReasons: matches.map((r) => r.reasons),
        },
      ];
    });
  const cost = (chosen) =>
    estimatedTokens(
      [{ role: "user", content: JSON.stringify(project(chosen)) }],
      profile,
    );
  // 必需材料不裁剪；其他记忆独立设软预算，留空间给原文检索与场景正文。
  const optionalBudget = Math.max(
    0,
    Math.min(
      6000,
      Math.floor(inputLimit(profile, requestOutput(8000, profile)) / 4),
    ),
  );
  const target = cost(selected) + optionalBudget;
  for (const row of rows
    .filter((r) => !r.required && r.reasons.length)
    .sort(
      (a, b) =>
        b.score - a.score ||
        numbers.get(b.entry.chapterId) - numbers.get(a.entry.chapterId) ||
        a.entry.part - b.entry.part ||
        a.index - b.index,
    )) {
    selected.add(row);
    if (cost(selected) > target) selected.delete(row);
  }
  const evidence = project(selected);
  const manifest = evidence.map((entry) => {
    const chosen = [...selected].filter(
      (r) =>
        r.entry.chapterId === entry.chapterId && r.entry.part === entry.part,
    );
    return {
      chapterId: entry.chapterId,
      part: entry.part,
      sourceHash: chosen[0].entry.sourceHash,
      reason: [...new Set(chosen.flatMap((r) => r.reasons))].join("、"),
      recordIds: chosen.map((r) => r.id),
    };
  });
  return {
    evidence,
    manifest,
    coverage: {
      version: 2,
      totalRecords: rows.length,
      selectedRecords: selected.size,
      requiredRecords: [...selected].filter((r) => r.required).length,
      retrievedRecords: [...selected].filter((r) =>
        r.reasons.includes("retrieved"),
      ).length,
      omittedRecords: rows.length - selected.size,
      selectedEntries: evidence.length,
      optionalBudget,
      policy:
        "近期与明确引用完整保留；向量原文命中和相关记忆按记录合并。不同陈述性质与相互冲突的记录不自动覆盖，未入选不代表不存在。",
    },
  };
}
