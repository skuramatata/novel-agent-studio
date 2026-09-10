import test from "node:test";
import assert from "node:assert/strict";
import {
  auditContinuity,
  reviewDocument,
} from "../runtime/paragraph-review.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import {
  canMigrateReview,
  REVIEW_POLICY,
  EVIDENCE_REVIEW_POLICY,
  GENERAL_REVIEW_POLICY,
} from "../runtime/review-policy.mjs";
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
    ["low", "low", "low"],
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
  assert(canMigrateReview(config, { ...step, contractId: "review" }));
  assert(
    !canMigrateReview(config, {
      ...step,
      contractId: "review",
      reviewPolicy: GENERAL_REVIEW_POLICY,
    }),
  );
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

test("仅专项完成后的普通审稿降为low，未执行专项的入口保留完整审稿", async () => {
  const { reviewAndPatch } = await import("../runtime/paragraph-review.mjs");
  const { createStructuredAsker } =
    await import("../runtime/structured-step.mjs");
  for (const specialist of [false, true]) {
    const scenes = [{ scene: 1, content: "他推开了房门。" }];
    const state = { id: "scope", values: {}, fragments: {} };
    const budget = createBudgetProfile(config);
    const calls = [];
    const save = async () => {};
    const ask = createStructuredAsker({
      state,
      budget,
      save,
      call: async (messages, tokens, label, partial, options) => {
        calls.push({ label, effort: options.reasoningEffort, tokens });
        const dimension = label.includes("时间顺序")
          ? "time"
          : label.includes("物件状态")
            ? "state"
            : label.includes("证据与推断")
              ? "evidence"
              : null;
        if (!dimension) {
          assert.equal(
            messages[0].content.includes("本轮是已完成专项后的"),
            specialist,
          );
          assert.equal(options.reasoningEffort, specialist ? "low" : "high");
        }
        return {
          text: JSON.stringify(
            dimension
              ? {
                  dimensions: [
                    {
                      dimension,
                      verdict: "not_applicable",
                      evidence: [],
                      explanation: "未涉及",
                    },
                  ],
                }
              : { issues: [] },
          ),
          finishReason: "stop",
        };
      },
    });
    const result = await reviewAndPatch({
      scenes,
      context: specialist ? { continuity: {} } : {},
      state,
      save,
      ask,
      profile: budget,
      signal: new AbortController().signal,
    });
    assert.deepEqual(result.scenes, scenes);
    assert.equal(calls.length, specialist ? 4 : 1);
    assert.equal(calls.at(-1).tokens, specialist ? 12000 : 18500);
  }
});

test("旧证据high截断迁移，新low失败不重置预算，其他专项不迁移", () => {
  const step = {
    contractId: "continuity_review",
    label: "证据与推断专项审稿 · 分批 1/2",
    reviewPolicy: REVIEW_POLICY,
    lastFailure: { kind: "output_limit" },
  };
  assert(canMigrateReview(config, step));
  assert(
    !canMigrateReview(config, {
      ...step,
      reviewPolicy: EVIDENCE_REVIEW_POLICY,
    }),
  );
  assert(!canMigrateReview(config, { ...step, label: "时间顺序专项审稿" }));
  assert(
    !canMigrateReview(config, { ...step, lastFailure: { kind: "validation" } }),
  );
});

test("证据low发现阻断问题后进入high依据核实，未核实不得完成", async () => {
  const { reviewAndPatch } = await import("../runtime/paragraph-review.mjs");
  const { createStructuredAsker } =
    await import("../runtime/structured-step.mjs");
  const scenes = [
    {
      scene: 1,
      content: "他只听到一声响，尚未看见来人。\n\n他断定来的一定是李青。",
    },
  ];
  const state = { id: "evidence-chain", values: {}, fragments: {} };
  const budget = createBudgetProfile(config);
  const seen = [];
  const ask = createStructuredAsker({
    state,
    budget,
    save: async () => {},
    call: async (messages, tokens, label, partial, options) => {
      seen.push({ label, effort: options.reasoningEffort });
      if (options.reasoningEffort === "high") {
        assert.match(label, /核对修订依据/);
        assert.match(messages[1].content, /他断定来的一定是李青/);
        throw Error("验证在实际修订前停止");
      }
      const dim = label.includes("时间顺序")
        ? "time"
        : label.includes("物件状态")
          ? "state"
          : label.includes("证据与推断")
            ? "evidence"
            : null;
      const refs = [
        { sourceId: "scene:1", paragraph: 1 },
        { sourceId: "scene:1", paragraph: 2 },
      ];
      const value = dim
        ? {
            dimensions: [
              dim === "evidence"
                ? {
                    dimension: dim,
                    verdict: "issues",
                    issues: [
                      {
                        kind: "unsupported_inference",
                        target: refs[1],
                        evidence: refs,
                        explanation: "声响不能确定身份",
                        resolution: "remove_unsupported",
                        preserve: [],
                        fix: "保留为怀疑",
                      },
                    ],
                  }
                : {
                    dimension: dim,
                    verdict: "not_applicable",
                    evidence: [],
                    explanation: "未涉及",
                  },
            ],
          }
        : { issues: [] };
      return { text: JSON.stringify(value), finishReason: "stop" };
    },
  });
  await assert.rejects(
    reviewAndPatch({
      scenes,
      context: { continuity: {} },
      state,
      save: async () => {},
      ask,
      profile: budget,
      signal: new AbortController().signal,
    }),
    /验证在实际修订前停止/,
  );
  assert.equal(seen.find((x) => x.label.includes("证据与推断")).effort, "low");
  assert.equal(seen.at(-1).effort, "high");
  assert.notEqual(state.reviewWorkflow.phase, "completed");
});
