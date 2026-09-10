const address = (r) =>
  JSON.stringify([r.sourceId, r.paragraph, r.sentence ?? null]);
const refs = (values = []) => new Set(values.map(address));
const subset = (a, b) => [...a].every((key) => b.has(key));

// 只合并同一目标、同一处置且证据互为子集的发现。不同句子的冲突、
// 不同保留事实和不同处置不合并；语义相似不足以替作者裁决。
export function coalesceReviewFindings(findings) {
  const issues = [],
    owners = new Map();
  for (const finding of findings) {
    const evidence = refs(finding.evidence),
      preserve = refs(finding.preserve);
    const matches = issues.filter((item) => {
      const previous = refs(item.evidence),
        kept = refs(item.preserve);
      return (
        item.kind === finding.kind &&
        address(item.target) === address(finding.target) &&
        item.resolution === finding.resolution &&
        item.blocking === finding.blocking &&
        subset(kept, preserve) &&
        subset(preserve, kept) &&
        (subset(evidence, previous) || subset(previous, evidence))
      );
    });
    if (matches.length !== 1) {
      const item = { ...finding };
      issues.push(item);
      owners.set(finding, item);
    } else {
      const item = matches[0];
      if (evidence.size > refs(item.evidence).size)
        Object.assign(item, {
          evidence: finding.evidence,
          explanation: finding.explanation,
        });
      owners.set(finding, item);
    }
  }
  return { issues, owners };
}
