import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewDocument,
  auditContinuity,
} from "../runtime/paragraph-review.mjs";
import { batchReviewDocuments } from "../runtime/review-context.mjs";
import { modelDocument } from "../runtime/review-payload.mjs";
import { createBudgetProfile, ensureBudget } from "../runtime/model-budget.mjs";
import { coalesceReviewFindings } from "../runtime/review-dedup.mjs";
import {
  trackFindings,
  trackCompleteReview,
} from "../runtime/review-workflow.mjs";
import {
  blockedStructuredRecovery,
  STRUCTURED_RECOVERY_VERSION,
  REVIEW_BATCH_PROTOCOL,
} from "../runtime/structured-step.mjs";
const ref = (p) => ({ sourceId: "scene:1", paragraph: p, sentence: 1 });
test("空占位兼容不吞掉放错位置的有效事实或修订要求", async () => {
  const doc = reviewDocument(
    [{ scene: 1, content: "纸是干的。\n\n纸又湿了。" }],
    {},
  );
  const raw = {
    dimensions: [
      {
        dimension: "time",
        verdict: "consistent",
        evidence: [ref(1)],
        explanation: "时序一致",
      },
      {
        dimension: "state",
        verdict: "issues",
        preserve: [],
        fix: "",
        issues: [
          {
            kind: "suggestion",
            target: ref(2),
            evidence: [ref(2)],
            resolution: "suggestion",
            explanation: "用词建议",
            fix: "换词",
          },
        ],
      },
      {
        dimension: "evidence",
        verdict: "not_applicable",
        evidence: [],
        explanation: "无材料推断",
      },
    ],
  };
  await auditContinuity({
    doc,
    context: {},
    ask: async (k, m, validate, o, l, { contract }) => {
      const parsed = contract.parse(raw);
      validate(parsed);
      assert.throws(() =>
        contract.parse({
          ...raw,
          dimensions: raw.dimensions.map((d, i) =>
            i === 1 ? { ...d, preserve: [ref(1)] } : d,
          ),
        }),
      );
      assert.throws(() =>
        contract.parse({
          ...raw,
          dimensions: raw.dimensions.map((d, i) =>
            i === 1 ? { ...d, fix: "保留原文" } : d,
          ),
        }),
      );
      return parsed;
    },
  });
});
test("完整当前章可放入预算时不生成场景笛卡尔积且完整覆盖历史", () => {
  const text = Array.from(
    { length: 35 },
    (_, i) => `段${i}。` + "她核对了账本的日期与钥匙的去向。".repeat(45),
  ).join("\n\n");
  const doc = reviewDocument([{ scene: 1, content: text }], {
    recallSources: [{ chapterId: "old", number: 1, content: text }],
  });
  const profile = createBudgetProfile({ provider: "glm", model: "glm-5.2" });
  const messagesFor = (view) => [
    { role: "system", content: "执行审稿。".repeat(80) },
    { role: "user", content: JSON.stringify(modelDocument(view)) },
  ];
  const views = batchReviewDocuments(doc, messagesFor, { profile });
  assert.ok(views.length > 1 && views.length <= 5, `批次过多：${views.length}`);
  for (const view of views) {
    ensureBudget(messagesFor(view), 6500, profile);
    assert.equal(view.sources[0].paragraphs.length, 35);
  }
  for (const source of doc.sources)
    for (const p of source.paragraphs)
      assert.ok(
        views.some((v) =>
          v.sources.some(
            (s) =>
              s.sourceId === source.sourceId &&
              s.paragraphs.some((r) => r.paragraph === p.paragraph),
          ),
        ),
      );
});
test("相同目标的子集证据只登记一次，其他冲突与作者取舍不合并", () => {
  const a = {
    kind: "contradiction",
    target: ref(2),
    evidence: [ref(1), ref(2)],
    preserve: [ref(1)],
    blocking: true,
    resolution: "preserve_evidence",
  };
  const b = { ...a, evidence: [ref(3), ref(2), ref(1)] };
  const c = { ...a, preserve: [ref(2)] };
  const d = { ...a, target: ref(3) };
  const result = coalesceReviewFindings([a, b, c, d]);
  assert.equal(result.issues.length, 3);
  assert.equal(result.owners.get(a), result.owners.get(b));
  assert.equal(result.issues[0].evidence.length, 3);
});
test("完整复审替换待办，单批和中断不清掉旧记录，历史再发现可重新打开", () => {
  const state = {};
  const a = {
    kind: "ambiguity",
    target: { ...ref(1), quote: "旧发现" },
    evidence: [{ ...ref(1), quote: "旧发现" }],
    blocking: false,
  };
  const b = {
    ...a,
    target: { ...ref(2), quote: "新发现" },
    evidence: [{ ...ref(2), quote: "新发现" }],
  };
  trackFindings(state, [a], "v1");
  trackFindings(state, [b], "v1");
  assert.equal(state.reviewWorkflow.issues[0].status, "advisory");
  trackCompleteReview(state, [b], "v1");
  assert.equal(state.reviewWorkflow.issues[0].status, "stale");
  trackCompleteReview(state, [a], "v1");
  assert.equal(state.reviewWorkflow.issues[0].status, "advisory");
});
test("仅旧分批审稿允许迁移，同版耗尽不再请求，无关步骤维持预算", () => {
  const step = {
    contractId: "continuity_review",
    label: "专项审稿 · 分批 9/50",
    status: "exhausted",
  };
  const state = {
    status: "awaiting_instruction",
    structuredSteps: { failed: step },
    structuredFailure: {
      version: STRUCTURED_RECOVERY_VERSION,
      stepId: "failed",
    },
  };
  assert.equal(blockedStructuredRecovery(state), null);
  step.reviewBatchProtocol = REVIEW_BATCH_PROTOCOL;
  assert.ok(blockedStructuredRecovery(state));
  delete step.reviewBatchProtocol;
  step.contractId = "patch";
  assert.ok(blockedStructuredRecovery(state));
});
