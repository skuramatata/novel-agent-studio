// 普通流程测试的模型桩；定位错误、漏改和误判使用独立用例中的真实响应。
export function repairPlanResponse(data) {
  const quoteAt = (ref) => ({
    sourceId: ref.sourceId,
    quote: data.document.sources
      .find((s) => s.sourceId === ref.sourceId)
      .paragraphs.find((p) => p[0] === ref.paragraph)
      .slice(1)
      .map((sentence) => (Array.isArray(sentence) ? sentence[1] : sentence))
      .join(""),
  });
  return {
    decisions: data.issues.map((i) => ({
      issueId: i.id,
      decision: "repair",
      reason: "重新核对原文，问题及修订范围成立",
      evidence: i.evidence.map(quoteAt),
      targets: [
        i.target,
        ...(i.allowedTargets || []).filter(
          (r) =>
            !(i.preserve || []).some(
              (p) => p.sourceId === r.sourceId && p.paragraph === r.paragraph,
            ),
        ),
      ]
        .filter(
          (r, n, a) =>
            a.findIndex(
              (t) => t.sourceId === r.sourceId && t.paragraph === r.paragraph,
            ) === n,
        )
        .map((r) => ({ ...quoteAt(r), fix: i.fix })),
    })),
  };
}
