import { requestOutput } from "./model-capabilities.mjs";
export const OUTPUT_POLICY = "glm53-high-output-1";
export const usesHighReasoning = (config = {}) =>
  config.provider === "glm" && config.model?.toLowerCase() === "glm-5.3";
// 应用策略，不是供应商保证；思考与最终内容共用单次输出额度。
export function initialOutput(desired, profile, scope = "general") {
  if (!profile?.highReasoning) return requestOutput(desired, profile);
  const observed = profile.reasoningPeaks?.[scope] || 0;
  const reserve = Math.max(12000, Math.ceil(observed * 1.25));
  return requestOutput(
    Math.max(desired, Math.min(24000, Math.max(16000, desired + reserve))),
    profile,
  );
}
export function observeReasoning(profile, scope, usage) {
  const n = usage?.completion_tokens_details?.reasoning_tokens;
  if (!profile?.highReasoning || !Number.isSafeInteger(n) || n <= 0) return;
  profile.reasoningPeaks ??= {};
  profile.reasoningPeaks[scope] = Math.max(
    profile.reasoningPeaks[scope] || 0,
    n,
  );
}
export function canUpgradeOutput(state, step) {
  return (
    usesHighReasoning(state) &&
    step?.status === "exhausted" &&
    step.lastFailure?.kind === "output_limit" &&
    !step.outputPolicy &&
    step.outputBudget < 24000
  );
}
