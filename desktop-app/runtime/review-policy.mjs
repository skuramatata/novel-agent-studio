import { usesHighReasoning } from "./reasoning-budget.mjs";
export const REVIEW_POLICY = "review-dimensions-1";
export const REVIEW_DIMENSIONS = [
  { id: "time", label: "时间顺序专项审稿", effort: "low" },
  { id: "state", label: "人物与物件状态审稿", effort: "low" },
  { id: "evidence", label: "证据与推断专项审稿", effort: "high" },
];
export function canMigrateReview(state, step) {
  return (
    usesHighReasoning(state) &&
    step?.contractId === "continuity_review" &&
    step.reviewPolicy !== REVIEW_POLICY &&
    step.lastFailure?.kind === "output_limit"
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
