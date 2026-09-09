import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSpecialistResult,
  suppliedReviewScope,
} from "../runtime/review-result.mjs";
import {
  auditContinuity,
  reviewDocument,
} from "../runtime/paragraph-review.mjs";
import { mergeContinuityReview } from "../runtime/continuity.mjs";
import { runReviewBatches } from "../runtime/review-context.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";

const ref = (paragraph) => ({ sourceId: "scene:1", paragraph });
const doc = reviewDocument(
  [{ scene: 1, content: "他拿到誊样。\n\n他认定亲笔签名完全相同。" }],
  {},
);
const issue = {
  kind: "unsupported_inference",
  target: ref(2),
  evidence: [ref(1), ref(2)],
  explanation: "誊样不能证明亲笔特征",
  fix: "收回肯定判断",
  resolution: "remove_unsupported",
};
const result = (issues = [issue]) => ({
  dimensions: [
    {
      dimension: "time",
      verdict: "not_applicable",
      explanation: "没有日期",
      evidence: [],
    },
    {
      dimension: "state",
      verdict: "consistent",
      explanation: "只确认持有誊样",
      evidence: [ref(1)],
    },
    { dimension: "evidence", verdict: "issues", issues },
  ],
  authorChecks: [],
  priorFindings: [],
});
const audit = (value) =>
  auditContinuity({
    doc,
    context: {},
    ledger: {},
    ask: async (_, messages, validate) => {
      const example = JSON.parse(
        messages[0].content.split("格式示例（请按实际原文填写）：")[1],
      );
      assert.ok(example.dimensions);
      assert.equal(example.issues, undefined);
      return validate(value);
    },
  });

test("专项发现只填写一次，由程序生成汇总和问题编号，实际依据仍逐条核对", async () => {
  const checked = await audit(result());
  assert.equal(checked.issues.length, 1);
  assert.equal(checked.issues[0].blocking, true);
  assert.equal(checked.continuityChecks[2].verdict, "problem");
  assert.deepEqual(checked.continuityChecks[2].issueIds, [
    checked.issues[0].id,
  ]);
  assert.equal(checked.issues[0].evidence[0].quote, "他拿到誊样。");
  assert.deepEqual(checked.suppliedScope, suppliedReviewScope(doc));
  await assert.rejects(
    audit(result([{ ...issue, evidence: [ref(99)] }])),
    /范围|无法定位/,
  );
  await assert.rejects(
    audit(result([{ ...issue, evidence: [ref(2)] }])),
    /两处/,
  );
});

test("新格式拒绝空问题、矛盾结论、重复维度和混合旧协议，旧problem无issues仍拒绝", async () => {
  assert.throws(() => normalizeSpecialistResult(result([])), /完整问题/);
  const inconsistent = result();
  inconsistent.dimensions[2].verdict = "consistent";
  assert.throws(() => normalizeSpecialistResult(inconsistent), /必须为 issues/);
  const duplicate = result();
  duplicate.dimensions[2].dimension = "state";
  assert.throws(() => normalizeSpecialistResult(duplicate), /不得重复/);
  assert.throws(
    () => normalizeSpecialistResult({ ...result(), issues: [] }),
    /不得同时/,
  );
  assert.throws(
    () => normalizeSpecialistResult({ ...result(), continuityChecks: [] }),
    /不得同时/,
  );
  await assert.rejects(
    audit({
      issues: [],
      continuityChecks: normalizeSpecialistResult(result()).continuityChecks,
    }),
    /未定位对应段落/,
  );
  await assert.rejects(audit(result(Array(17).fill(issue))), /16/);
});

test("需要确认的ambiguity按关联问题阻断，不因汇总只展示前八个目标放行", async () => {
  const checked = await audit(
    result([{ ...issue, kind: "ambiguity", resolution: "needs_confirmation" }]),
  );
  assert.equal(checked.issues[0].blocking, true);
});

test("专项与综合审稿去重/重排后仍关联真实问题且保存双方材料范围", async () => {
  const specialist = await audit(result());
  const general = {
    issues: [{ ...specialist.issues[0], kind: "contradiction" }],
    suppliedScope: { sources: [] },
  };
  specialist.issues[0].blocking = false;
  const merged = mergeContinuityReview(specialist, general);
  const id = merged.continuityChecks[2].issueIds[0];
  assert.equal(
    merged.issues.find((i) => i.id === id).kind,
    "unsupported_inference",
  );
  assert.equal(merged.suppliedScopes.length, 2);
});

test("分批来源只记录提供的原始段号，汇总问题编号在去重后仍有效", async () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content: Array.from(
          { length: 24 },
          (_, i) => `${i}。${"历史事实。".repeat(150)}`,
        ).join("\n\n"),
      },
    ],
    {},
  );
  const checked = await runReviewBatches({
    doc,
    key: "batches",
    label: "审稿",
    profile: createBudgetProfile(),
    messagesFor: (view) => [{ role: "user", content: JSON.stringify(view) }],
    ask: async (_, messages, validate) => validate({}),
    validate: (_, view) => ({
      issues: [
        {
          id: "finding-1",
          kind: "ambiguity",
          target: {
            sourceId: "scene:1",
            paragraph: view.sources[0].paragraphs[0].paragraph,
          },
          evidence: [],
        },
      ],
      continuityChecks: [
        { dimension: "state", verdict: "problem", issueIds: ["finding-1"] },
      ],
      suppliedScope: suppliedReviewScope(view),
    }),
  });
  assert.ok(checked.batchCoverage.total > 1);
  for (const check of checked.continuityChecks)
    assert.ok(checked.issues.some((i) => i.id === check.issueIds[0]));
  assert.deepEqual(
    [
      ...new Set(
        checked.suppliedScopes.flatMap((s) => s.sources[0].paragraphs),
      ),
    ].sort((a, b) => a - b),
    Array.from({ length: 24 }, (_, i) => i + 1),
  );
  assert.ok(
    checked.suppliedScopes.every(
      (s) => s.sources[0].sourceHash === doc.sources[0].hash,
    ),
  );
});
