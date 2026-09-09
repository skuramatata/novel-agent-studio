import { z } from "zod";

export const REVIEW_RESULT_VERSION = "review-result-2";
export function remapReviewChecks(checks, ids) {
  return checks?.map((check) => ({
    ...check,
    ...(check.issueIds
      ? {
          issueIds: [
            ...new Set(
              check.issueIds.map((id) => {
                if (!ids.has(id))
                  throw Error(`专项汇总关联的问题不存在：${id}`);
                return ids.get(id);
              }),
            ),
          ],
        }
      : {}),
  }));
}
const dimensionSchema = z.object({
  dimension: z.enum(["time", "state", "evidence"]),
  verdict: z.enum(["issues", "consistent", "insufficient", "not_applicable"]),
  issues: z.array(z.unknown()).max(16).default([]),
  evidence: z.array(z.unknown()).max(8).default([]),
  explanation: z.string().max(1000).default(""),
});

// 记录程序实际提供的材料，不把模型抄出的名单当成已经检查过的证明。
export function suppliedReviewScope(doc) {
  return {
    documentVersion: doc.version,
    policy:
      "仅记录本批实际提供的原文；不证明模型逐项检查，更不代表全书没有某事件。",
    sources: doc.sources.map((source) => ({
      sourceId: source.sourceId,
      sourceHash: source.hash,
      paragraphs: source.paragraphs.map((row) => row.paragraph),
    })),
    ...(doc.coverage ? { coverage: doc.coverage } : {}),
  };
}

// 专项问题只有一个输入位置；问题列表、编号及汇总状态由程序生成。
// 老检查点/响应继续走原校验，不能丢弃其未列入 issues 的 problem。
export function normalizeSpecialistResult(value) {
  if (!value?.dimensions) return value;
  if (value.issues !== undefined || value.continuityChecks !== undefined)
    throw Error(
      "专项新格式只在 dimensions 内提供问题，不得同时提供另一份 issues 或 continuityChecks。",
    );
  const dimensions = z.array(dimensionSchema).length(3).parse(value.dimensions);
  if (new Set(dimensions.map((d) => d.dimension)).size !== 3)
    throw Error(
      "dimensions 必须分别覆盖 time、state、evidence，不得重复或遗漏。",
    );
  const issues = [];
  const continuityChecks = dimensions.map((dimension) => {
    const { verdict, evidence, explanation } = dimension;
    if (verdict !== "issues") {
      if (dimension.issues.length)
        throw Error(
          `${dimension.dimension} 已列出问题，verdict 必须为 issues，不能同时宣称无问题。`,
        );
      return { dimension: dimension.dimension, verdict, evidence, explanation };
    }
    if (!dimension.issues.length)
      throw Error(
        `${dimension.dimension}.verdict=issues 必须在该维度列出完整问题，不能只声称有问题。`,
      );
    if (evidence.length || explanation)
      throw Error(
        `${dimension.dimension} 的问题依据和说明只填写在问题项内，不重复填写汇总 evidence/explanation。`,
      );
    const start = issues.length;
    issues.push(...dimension.issues);
    // 这里只是用于展示的摘要地址；每项完整证据仍由 validateFindings 逐条校验。
    const targets = [
      ...new Map(
        dimension.issues.map((issue) => [
          JSON.stringify(issue?.target),
          issue?.target,
        ]),
      ).values(),
    ];
    return {
      dimension: dimension.dimension,
      verdict: "problem",
      issueIds: dimension.issues.map((_, i) => `finding-${start + i + 1}`),
      evidence: targets.slice(0, 8),
      explanation: `本维度有 ${dimension.issues.length} 项发现，依据与说明见关联问题。`,
    };
  });
  return {
    issues,
    continuityChecks,
    authorChecks: value.authorChecks,
    priorFindings: value.priorFindings,
  };
}
