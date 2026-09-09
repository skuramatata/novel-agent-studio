export const INLINE_EVIDENCE_FORMAT =
  "records每行按recordColumns排列；quoteIndex是本条目quotes数组的从0开始的下标。quotes为逐字原文，记录及摘要是模型抽取，不能替代原文。";
const SHARED_FORMAT =
  "records每行按recordColumns排列；quoteIndex对应本条目的quoteRefs。quoteRef或textRef以source指向recentText、recallSources[index].content、retrievedSources[index].text或memorySources[index].text；start/end为从0开始的UTF-16偏移，end不含。引用只复用逐字原文，不改变来源章节、知情人或陈述性质；摘要与记录是抽取结果，不是真相。";

// 仅用于写作请求的传输投影，正式记忆与审稿文档始终保留完整引文。
export function resolveWritingQuote(data, ref, depth = 0) {
  if (!ref || depth > 3) throw Error("原文复用引用无效。");
  const source =
    ref.source === "recentText"
      ? data.recentText
      : ref.source === "recallSources"
        ? data.recallSources?.[ref.index]?.content
        : ["retrievedSources", "memorySources"].includes(ref.source)
          ? data[ref.source]?.[ref.index]
          : null;
  const text =
    typeof source === "string"
      ? source
      : typeof source?.text === "string"
        ? source.text
        : source?.textRef
          ? resolveWritingQuote(data, source.textRef, depth + 1)
          : null;
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(ref.start) ||
    !Number.isSafeInteger(ref.end) ||
    ref.start < 0 ||
    ref.end <= ref.start ||
    ref.end > text.length
  )
    throw Error("原文复用引用越界或来源缺失。");
  return text.slice(ref.start, ref.end);
}

export function expandWritingMemory(data) {
  if (data.memoryTransport?.version !== 2) return data;
  const next = structuredClone(data);
  for (const entry of next.evidence || []) {
    entry.quotes = entry.quoteRefs.map((ref) => resolveWritingQuote(data, ref));
    delete entry.quoteRefs;
  }
  for (const s of next.retrievedSources || [])
    if (s.textRef) {
      s.text = resolveWritingQuote(data, s.textRef);
      delete s.textRef;
    }
  for (const field of ["timeAnchors", "relatedFacts"])
    for (const row of next.continuity?.[field] || [])
      if (row.quoteRef) {
        row.quote = resolveWritingQuote(data, row.quoteRef);
        delete row.quoteRef;
      }
  delete next.memorySources;
  delete next.memoryTransport;
  next.evidenceFormat = INLINE_EVIDENCE_FORMAT;
  return next;
}

export function compactWritingMemory(input) {
  if (input.memorySelection?.version !== 2) return input;
  const data = expandWritingMemory(input),
    next = structuredClone(data);
  const pool = [],
    available = [];
  let shared = 0;
  const add = (chapterId, text, source, index) => {
    if (chapterId && typeof text === "string" && text)
      available.push({
        chapterId,
        text,
        source,
        ...(index === undefined ? {} : { index }),
      });
  };
  add(data.recentChapterId, data.recentText, "recentText");
  (data.recallSources || []).forEach((s, i) =>
    add(s.chapterId, s.content, "recallSources", i),
  );
  const reference = (chapterId, text, create = true) => {
    const existing = available.find(
      (s) => s.chapterId === chapterId && s.text.includes(text),
    );
    if (existing) {
      shared++;
      const start = existing.text.indexOf(text);
      return {
        source: existing.source,
        ...(existing.index === undefined ? {} : { index: existing.index }),
        start,
        end: start + text.length,
      };
    }
    if (!create) return null;
    const index = pool.length;
    pool.push({ chapterId, text });
    add(chapterId, text, "memorySources", index);
    return { source: "memorySources", index, start: 0, end: text.length };
  };
  (data.retrievedSources || []).forEach((s, i) => {
    const ref = reference(s.chapterId, s.text, false);
    if (ref) {
      delete next.retrievedSources[i].text;
      next.retrievedSources[i].textRef = ref;
    }
    add(s.chapterId, s.text, "retrievedSources", i);
  });
  for (const entry of next.evidence || []) {
    entry.quoteRefs = entry.quotes.map((text) =>
      reference(entry.chapterId, text),
    );
    delete entry.quotes;
  }
  for (const field of ["timeAnchors", "relatedFacts"])
    for (const row of next.continuity?.[field] || [])
      if (row.quote && row.chapterId) {
        row.quoteRef = reference(row.chapterId, row.quote);
        delete row.quote;
      }
  if (!shared) return data;
  next.memorySources = pool;
  next.memoryTransport = { version: 2, sharedQuotes: shared };
  next.evidenceFormat = SHARED_FORMAT;
  return next;
}
