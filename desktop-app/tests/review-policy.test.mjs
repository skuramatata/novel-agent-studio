import test from "node:test";
import assert from "node:assert/strict";
import {
  auditContinuity,
  reviewDocument,
} from "../runtime/paragraph-review.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import { canMigrateReview, REVIEW_POLICY } from "../runtime/review-policy.mjs";
const config = { provider: "glm", model: "glm-5.3" };
test("专项三维度独立请求与强度，问题合并后引用仍指向正确问题", async () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content:
          "六月一日，他交出了钥匙。\n\n次日六月三日，他仍拿着同一把钥匙。",
      },
    ],
    {},
  );
  const seen = [];
  const result = await auditContinuity({
    doc,
    context: {},
    profile: createBudgetProfile(config),
    ask: async (key, messages, validate, tokens, label, options) => {
      const dimension = ["time", "state", "evidence"][seen.length];
      seen.push({ key, label, effort: options.reasoningEffort });
      const refs = [
        { sourceId: "scene:1", paragraph: 1 },
        { sourceId: "scene:1", paragraph: 2 },
      ];
      const value = {
        dimensions: [
          dimension === "evidence"
            ? {
                dimension,
                verdict: "not_applicable",
                evidence: [],
                explanation: "不涉及证词推断",
              }
            : {
                dimension,
                verdict: "issues",
                issues: [
                  {
                    kind: "contradiction",
                    target: refs[1],
                    evidence: refs,
                    explanation:
                      dimension === "time" ? "次日日期不符" : "钥匙持有人不符",
                    resolution: "preserve_evidence",
                    preserve: [refs[0]],
                    fix:
                      dimension === "time" ? "核对次日日期" : "核对钥匙持有人",
                  },
                ],
              },
        ],
      };
      assert.throws(() =>
        options.contract.parse({
          ...value,
          dimensions: [...value.dimensions, ...value.dimensions],
        }),
      );
      return validate(options.contract.parse(value));
    },
  });
  assert.deepEqual(
    seen.map((s) => s.effort),
    ["low", "low", "high"],
  );
  assert.equal(new Set(seen.map((s) => s.key)).size, 3);
  assert.equal(result.continuityChecks.length, 3);
  const ids = new Set(result.issues.map((i) => i.id));
  assert(
    result.continuityChecks
      .flatMap((c) => c.issueIds || [])
      .every((id) => ids.has(id)),
  );
});
test("旧综合审稿截断允许迁移，新模块失败保持阻断", () => {
  const step = {
    contractId: "continuity_review",
    lastFailure: { kind: "output_limit" },
  };
  assert(canMigrateReview(config, step));
  assert(!canMigrateReview(config, { ...step, reviewPolicy: REVIEW_POLICY }));
  assert(!canMigrateReview(config, { ...step, contractId: "review" }));
  assert(
    !canMigrateReview(config, { ...step, lastFailure: { kind: "validation" } }),
  );
});

test("专项中途断网后恢复，复用已完成维度且不把剩余维度当作完成", async () => {
  const { createStructuredAsker } =
    await import("../runtime/structured-step.mjs");
  const doc = reviewDocument([{ scene: 1, content: "清晨，他坐在门边。" }], {});
  let state = {
    id: "recovery",
    reviewWorkflow: { phase: "review" },
    values: {},
    fragments: {},
  };
  const budget = createBudgetProfile(config);
  let fail = true;
  const calls = [];
  let persisted;
  const save = async () => {
    persisted = JSON.stringify(state);
  };
  const run = () =>
    auditContinuity({
      doc,
      context: {},
      profile: budget,
      state,
      save,
      ask: createStructuredAsker({
        state,
        budget,
        save,
        call: async (messages, tokens, label) => {
          const dimension = label.includes("时间顺序")
            ? "time"
            : label.includes("物件状态")
              ? "state"
              : "evidence";
          calls.push(dimension);
          if (dimension === "evidence" && fail) throw Error("网络中断");
          return {
            text: JSON.stringify({
              dimensions: [
                {
                  dimension,
                  verdict: "not_applicable",
                  evidence: [],
                  explanation: "测试范围不涉及",
                },
              ],
            }),
            finishReason: "stop",
          };
        },
      }),
    });
  await assert.rejects(run(), /网络中断/);
  state = JSON.parse(persisted);
  fail = false;
  const result = await run();
  assert.equal(result.continuityChecks.length, 3);
  assert.deepEqual(calls, ["time", "state", "evidence", "evidence"]);
});
