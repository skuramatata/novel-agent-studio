import { usesHighReasoning } from "./reasoning-budget.mjs";
export const MEMORY_EXTRACTION_POLICY = "glm53-memory-low-1600-v2";
export function canMigrateMemoryExtraction(state, step) {
  return (
    usesHighReasoning(state) &&
    step?.contractId === "memory_extract" &&
    (step.lastFailure?.kind === "output_limit" ||
      (step.lastFailure?.kind === "validation" &&
        /continuity/.test(step.lastFailure.detail || ""))) &&
    step.memoryExtractionPolicy !== MEMORY_EXTRACTION_POLICY
  );
}
