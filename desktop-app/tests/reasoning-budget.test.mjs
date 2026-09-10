import test from "node:test";
import assert from "node:assert/strict";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import {
  initialOutput,
  observeReasoning,
  canUpgradeOutput,
  OUTPUT_POLICY,
} from "../runtime/reasoning-budget.mjs";
import { capabilityKey } from "../runtime/model-capabilities.mjs";
const config = {
  provider: "glm",
  model: "glm-5.3",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};
test("high起始预算覆盖思考与内容，按契约学习，恢复保留且不跨模型", () => {
  const p = createBudgetProfile(config);
  assert.equal(initialOutput(3000, p, "outlines"), 16000);
  assert.equal(initialOutput(8000, p), 20000);
  observeReasoning(p, "outlines", {
    completion_tokens_details: { reasoning_tokens: 16000 },
  });
  assert.equal(initialOutput(3000, p, "outlines"), 23000);
  assert.equal(initialOutput(3000, p, "review"), 16000);
  assert.equal(
    initialOutput(
      3000,
      createBudgetProfile(config, JSON.parse(JSON.stringify(p))),
      "outlines",
    ),
    23000,
  );
  assert.equal(
    initialOutput(
      3000,
      createBudgetProfile({ ...config, model: "glm-5.2" }, p),
      "outlines",
    ),
    3000,
  );
  assert.equal(
    initialOutput(
      3000,
      createBudgetProfile({ ...config, baseUrl: "other" }, p),
      "outlines",
    ),
    16000,
  );
  observeReasoning(p, "outlines", {
    completion_tokens_details: { reasoning_tokens: 100000 },
  });
  assert.equal(initialOutput(3000, p, "outlines"), 24000);
});
test("模型覆盖上限始终约束实际预算", () => {
  const c = {
    ...config,
    limits: { maxOutputTokens: 10000 },
    limitKey: capabilityKey(config),
  };
  assert.equal(initialOutput(3000, createBudgetProfile(c)), 10000);
});
test("仅旧high额度耗尽可升级一次，格式失败与已升级步骤保持阻断", () => {
  const step = {
    status: "exhausted",
    outputBudget: 12000,
    lastFailure: { kind: "output_limit" },
  };
  assert(canUpgradeOutput(config, step));
  assert(!canUpgradeOutput(config, { ...step, outputPolicy: OUTPUT_POLICY }));
  assert(
    !canUpgradeOutput(config, { ...step, lastFailure: { kind: "validation" } }),
  );
  assert(!canUpgradeOutput({ ...config, model: "glm-5.2" }, step));
});
