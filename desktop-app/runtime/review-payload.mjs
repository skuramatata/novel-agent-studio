export const reference = ({ sourceId, paragraph, sentence }) => ({
  sourceId,
  paragraph,
  ...(sentence === undefined ? {} : { sentence }),
});

// 记忆表的数组下标不是正文地址。仅为本批逐字命中的引文提供可复制地址；
// 未命中条目仍保留为回查线索，不能凭摘要补造证据或把第 0 项当第 0 段。
export function modelContinuity(ledger, doc) {
  if (!ledger) return ledger;
  const locate = (quote) => {
    if (!quote?.trim()) return [];
    // 记忆来源分块可能携带段尾换行，正文段落将分隔符存放在偏移中。
    // 只去掉边缘空白用于定位，返回的证据仍由正文地址逐字回填。
    quote = quote.trim();
    return doc.sources.flatMap((source) =>
      source.paragraphs.flatMap((row) => {
        if (!row.text.includes(quote)) return [];
        const sentences = row.sentences.filter((s) => s.text.includes(quote));
        return [
          {
            sourceId: source.sourceId,
            paragraph: row.paragraph,
            ...(sentences.length === 1
              ? { sentence: sentences[0].sentence }
              : {}),
          },
        ];
      }),
    );
  };
  const project = (record) => {
    const references = locate(record.quote);
    const { quote, ...metadata } = record;
    return { ...metadata, ...(references.length ? {} : { quote }), references };
  };
  return {
    ...ledger,
    timeAnchors: (ledger.timeAnchors || []).map(project),
    relatedFacts: (ledger.relatedFacts || []).map(project),
    referencePolicy:
      "本表只是索引，不是document.sources。references仅列本批逐字命中的正文地址；为空表示本批没有定位到引文，不代表全书不存在。不能将timeAnchors、relatedFacts、calculations或数组下标写入证据地址。",
  };
}
// 引用只携带地址；全文在document中只传一次，不携带UI选项及历史快照。
export function modelFindings(issues) {
  return issues.map((i) => ({
    id: i.id,
    kind: i.kind,
    target: reference(i.target),
    evidence: i.evidence.map(reference),
    preserve: (i.preserve || []).map(reference),
    resolution: i.resolution,
    explanation: i.explanation,
    fix: i.fix,
    ...(i.allowedTargets
      ? { allowedTargets: i.allowedTargets.map(reference) }
      : {}),
    ...(i.repairTargets
      ? {
          repairTargets: i.repairTargets.map((t) => ({
            ...reference(t),
            quote: t.quote,
            fix: t.fix,
          })),
        }
      : {}),
    ...(i.authorInstruction ? { authorInstruction: i.authorInstruction } : {}),
    ...(i.arbitration ? { arbitration: i.arbitration } : {}),
  }));
}
export function modelAuthorHistory(history = []) {
  return history.flatMap((h) =>
    h.issues.map((i) => ({
      target: reference(i.target),
      instruction: i.authorInstruction,
      preserve: (i.preserve || []).map(reference),
    })),
  );
}
export function modelDocument(doc, { explicitSentences = false } = {}) {
  return {
    version: doc.version,
    ...(doc.coverage ? { coverage: doc.coverage } : {}),
    format: explicitSentences
      ? "paragraphs每行是[段落编号,[句子编号,原文],[句子编号,原文],...]；引用直接使用提供的编号，不重新数句。所有原文完整保留。"
      : "paragraphs每行是[段落编号,第1句原文,第2句原文,...]；句子编号就是该行中的位置，从1开始。所有原文完整保留。",
    sources: doc.sources.map((s) => ({
      sourceId: s.sourceId,
      label: s.label,
      editable: s.editable,
      paragraphs: s.paragraphs.map((p) => [
        p.paragraph,
        ...p.sentences.map((x) =>
          explicitSentences ? [x.sentence, x.text] : x.text,
        ),
      ]),
    })),
  };
}
