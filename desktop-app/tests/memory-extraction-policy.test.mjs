import test from "node:test";
import assert from "node:assert/strict";
import { sourceParts, indexChapter } from "../runtime/memory.mjs";
import {
  canMigrateMemoryExtraction,
  MEMORY_EXTRACTION_POLICY,
} from "../runtime/memory-extraction-policy.mjs";
import { complete } from "../runtime/providers.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import {
  initialOutput,
  observeReasoning,
} from "../runtime/reasoning-budget.mjs";
const config = {
  provider: "glm",
  model: "glm-5.3",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "test",
};
test("小批次完整覆盖原文，不重叠不漏字，引用仍指向原文", async () => {
  const content = "甲拿起信。\n乙看着门。\n".repeat(350);
  const parts = sourceParts(content, 1600);
  assert.equal(parts.map((p) => p.text).join(""), content);
  assert(parts.every((p) => p.text.length <= 1600));
  const keys = [];
  await indexChapter(
    { memory: { entries: [] } },
    { id: "ch", number: 1, content },
    async (key, messages, validate, tokens, label, options) => {
      keys.push(key);
      assert.equal(options.reasoningEffort, "low");
      assert.equal(options.memoryExtractionPolicy, MEMORY_EXTRACTION_POLICY);
      assert.match(options.contract.fields, /最多8项/);
      assert.match(options.contract.fields, /最多400字/);
      const record = {
        kind: "event",
        text: "拿信",
        entities: [],
        storyTime: "未知",
        knownBy: [],
        epistemic: "observed",
        sourceId: 1,
      };
      assert.throws(
        () => validate({ summary: "摘要", records: Array(9).fill(record) }),
        /上限/,
      );
      assert.throws(() =>
        options.contract.parse({
          summary: "摘要",
          records: Array(9).fill(record),
        }),
      );
      return validate({ summary: "摘要", records: [record] });
    },
    { compact: true },
  );
  assert.equal(keys.length, parts.length);
  assert(keys.every((k) => k.includes(MEMORY_EXTRACTION_POLICY)));
});
test("仅旧记忆额度失败可迁移，新策略失败不会无限重试", () => {
  const step = {
    contractId: "memory_extract",
    lastFailure: { kind: "output_limit" },
  };
  assert(canMigrateMemoryExtraction(config, step));
  assert(
    !canMigrateMemoryExtraction(config, {
      ...step,
      memoryExtractionPolicy: MEMORY_EXTRACTION_POLICY,
    }),
  );
  assert(
    !canMigrateMemoryExtraction(config, {
      ...step,
      lastFailure: { kind: "validation" },
    }),
  );
  assert(
    !canMigrateMemoryExtraction(config, { ...step, contractId: "review" }),
  );
});
test("记忆low不继承high观测额度，其他模型与默认high不受影响", async () => {
  const p = createBudgetProfile(config);
  observeReasoning(p, "memory_extract", {
    completion_tokens_details: { reasoning_tokens: 22928 },
  });
  assert.equal(initialOutput(6000, p, "memory_extract:low"), 12000);
  assert.equal(initialOutput(6000, p, "prose"), 18000);
  for (const effort of [undefined, "low"])
    await complete(
      config,
      [],
      undefined,
      async (_, init) => {
        assert.equal(JSON.parse(init.body).reasoning_effort, effort || "high");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "结果" }, finish_reason: "stop" }],
          }),
        );
      },
      12000,
      { reasoningEffort: effort },
    );
});
