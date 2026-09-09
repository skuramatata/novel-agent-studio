import test from "node:test";
import assert from "node:assert/strict";
import {
  baseTokens,
  estimatedTokens,
  ensureBudget,
  createBudgetProfile,
  observeTokenUsage,
} from "../runtime/model-budget.mjs";
import { capabilityKey } from "../runtime/model-capabilities.mjs";
import { structuredRetryMessages } from "../runtime/structured.mjs";

const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};
config.limits = { appContextCap: 60000 };
config.limitKey = capabilityKey(config);
const messages = [
  { role: "system", content: "原文、事实和引用不可丢弃。" },
  {
    role: "user",
    content: JSON.stringify({
      sources: [{ sourceId: 1, text: "他保管着钥匙。" }],
    }),
  },
];

test("中文与英文按分词计数，保留余量，特殊标记仅作为正文", () => {
  assert.equal(baseTokens([{ role: "user", content: "Hello, world!" }]), 580);
  assert.ok(
    baseTokens([{ role: "user", content: "这是中文小说。".repeat(100) }]) <
      2000,
  );
  assert.equal(baseTokens([{ role: "user", content: "<|endoftext|>" }]), 583);
  assert.ok(estimatedTokens(messages) >= baseTokens(messages) * 1.25);
  const message = { role: "user", content: "短句" };
  const before = baseTokens([message]);
  message.content += "新增正文。".repeat(100);
  assert.ok(baseTokens([message]) > before);
});

test("实际用量校准可恢复且不跨模型/入口，低用量和缺失值不能降低保护", () => {
  const profile = createBudgetProfile(config);
  for (const usage of [
    null,
    {},
    { total_tokens: 9999 },
    { prompt_tokens: 0 },
    { prompt_tokens: "99" },
  ])
    observeTokenUsage(profile, messages, usage);
  assert.equal(profile.samples, 0);
  const actual = baseTokens(messages) * 2;
  observeTokenUsage(profile, messages, { prompt_tokens: actual });
  assert.ok(estimatedTokens(messages, profile) >= actual * 1.15);
  const raised = profile.factor;
  observeTokenUsage(profile, messages, { prompt_tokens: 1 });
  assert.equal(profile.factor, raised);
  assert.equal(profile.samples, 2);
  const saved = JSON.parse(JSON.stringify(profile));
  assert.deepEqual(createBudgetProfile(config, saved), profile);
  for (const next of [
    { ...config, model: "glm-other" },
    { ...config, baseUrl: "https://other.test" },
    { ...config, provider: "minimax" },
  ])
    assert.equal(createBudgetProfile(next, saved).samples, 0);
  assert.equal(
    createBudgetProfile(config, { ...saved, factor: NaN }).factor,
    1.25,
  );
  assert.equal(
    createBudgetProfile(config, { ...saved, version: "unknown" }).samples,
    0,
  );
});

test("预算包含输出与更新后的安全系数，实际超限仍明确阻断", () => {
  const profile = createBudgetProfile(config);
  const input = [{ role: "user", content: "他开门检查钥匙。\n".repeat(3000) }];
  assert.doesNotThrow(() => ensureBudget(input, 6000, profile));
  observeTokenUsage(profile, input, { prompt_tokens: 55000 });
  assert.throws(
    () => ensureBudget(input, 6000, profile),
    (error) =>
      error.code === "CONTEXT_BUDGET" &&
      error.inputEstimate + error.outputBudget > error.limit,
  );
  assert.throws(() => ensureBudget(input, NaN), /非负整数/);
});

test("小型纠错保留响应，过长响应只带错误说明，原任务证据保持不变", () => {
  const before = structuredClone(messages);
  const small = '{"records":[]}';
  const shortRetry = structuredRetryMessages(
    messages,
    small,
    Error("records缺少sourceId"),
    3500,
  );
  assert.equal(shortRetry[2].content, small);
  const oversized = "无效输出。\n".repeat(10000);
  const retry = structuredRetryMessages(
    messages,
    oversized,
    Error("sourceId编号越界"),
    3500,
  );
  assert.deepEqual(retry.slice(0, 2), before);
  assert.equal(retry.length, 3);
  assert.match(retry[2].content, /sourceId编号越界/);
  assert.match(retry[2].content, /未附入/);
  assert.ok(estimatedTokens(retry) - estimatedTokens(messages) < 1000);
  assert.doesNotThrow(() => ensureBudget(retry, 3500));
  assert.deepEqual(messages, before);
});

test("纠错内容和输出预留一起核算，即使短响应也不能挤占必需证据预算", () => {
  const profile = createBudgetProfile(config);
  const output = 59000;
  const response = "错误内容。".repeat(50);
  const retry = structuredRetryMessages(
    messages,
    response,
    Error("格式不完整"),
    output,
    profile,
  );
  assert.equal(retry.length, 3);
  assert.equal(retry[2].role, "user");
  assert.doesNotThrow(() => ensureBudget(retry, output, profile));
});
