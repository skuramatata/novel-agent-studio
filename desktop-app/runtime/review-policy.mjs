import { usesHighReasoning } from "./reasoning-budget.mjs";
export const GENERAL_REVIEW_POLICY = "review-narrative-low-1";
export const EVIDENCE_REVIEW_POLICY = "evidence-scan-low-1";
export const REVIEW_POLICY = "review-dimensions-1";
export const REVIEW_DIMENSIONS = [
  { id: "time", label: "时间顺序专项审稿", effort: "low" },
  { id: "state", label: "人物与物件状态审稿", effort: "low" },
  {
    id: "evidence",
    label: "证据与推断专项审稿",
    effort: "low",
    policy: EVIDENCE_REVIEW_POLICY,
  },
];
export function canMigrateReview(state, step) {
  if (!usesHighReasoning(state) || step?.lastFailure?.kind !== "output_limit")
    return false;
  if (step.contractId === "review")
    return step.reviewPolicy !== GENERAL_REVIEW_POLICY;
  if (step.contractId !== "continuity_review") return false;
  if (step.reviewPolicy === EVIDENCE_REVIEW_POLICY) return false;
  return (
    step.reviewPolicy !== REVIEW_POLICY ||
    step.label?.startsWith("证据与推断专项审稿") === true
  );
}

// 高风险判断暂时保持high；专项轻量维度由各自的请求选项覆盖。
export const REVIEW_EFFORTS = Object.freeze({
  continuity_review: "high",
  review: "high",
  arbitration: "high",
  grounding: "high",
  patch: "high",
  verification: "high",
  author_revision: "high",
  author_verification: "high",
});
