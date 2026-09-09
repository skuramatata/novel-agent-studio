import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  reviewDocument,
  evidenceAt,
  validateFindings,
  applyParagraphPatch,
  reviewAndPatch,
} from "../runtime/paragraph-review.mjs";
import {
  authorConstraints,
  rememberDecisions,
} from "../runtime/review-workflow.mjs";
import { runReviewBatches } from "../runtime/review-context.mjs";
import { resolveReviewProblems } from "../runtime/review-resolution.mjs";
import {
  modelDocument,
  AUTHOR_CONSTRAINT_CONTEXT_VERSION,
  AUTHOR_CONSTRAINT_RULES,
  ARBITRATION_EVIDENCE_VERSION,
} from "../runtime/review-payload.mjs";
import {
  blockedStructuredRecovery,
  createStructuredAsker,
  STRUCTURED_RECOVERY_VERSION,
} from "../runtime/structured-step.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import { workflowContract } from "../runtime/workflow-skill.mjs";

const ref = (paragraph) => ({ sourceId: "scene:1", paragraph });
const scenes = [
  {
    scene: 1,
    content:
      "营地由苏婉清照看。\n\n苏婉清把毛毯交给女生。\n\n苏婉清仍攥着毛毯。",
  },
];
const doc = reviewDocument(scenes, {});
const issue = {
  kind: "contradiction",
  target: ref(3),
  evidence: [ref(2), ref(3)],
  explanation: "毛毯已经交出却仍在手里。",
  resolution: "preserve_evidence",
  preserve: [ref(2)],
  fix: "按作者选择保留交出的事实，删去仍持物的动作。",
};
const findings = validateFindings({ issues: [issue] }, doc).issues;
function setup() {
  const state = {
    id: "scoped-author",
    values: { "final-scene:0": scenes[0].content },
  };
  rememberDecisions(state, "people", [
    {
      ...findings[0],
      id: "people",
      target: evidenceAt(doc, ref(1)),
      evidence: [evidenceAt(doc, ref(1)), evidenceAt(doc, ref(3))],
      preserve: [evidenceAt(doc, ref(3))],
      authorInstruction: "以苏婉清这处原文为准。",
    },
  ]);
  rememberDecisions(state, "object", [
    { ...findings[0], authorInstruction: "以把毛毯交给女生为准。" },
  ]);
  return state;
}
const patch = {
  baseVersion: doc.version,
  replacements: [
    {
      ...ref(3),
      issueIds: [findings[0].id],
      replacement: "苏婉清把空手拢进袖子。",
    },
  ],
};

test("作者选择保留原问题范围和先后顺序，旧引文经补丁修改后定位现稿但不伪造匹配", () => {
  const state = setup(),
    history = structuredClone(state.reviewWorkflow.constraints);
  const proposed = applyParagraphPatch(scenes, doc, findings, patch);
  const next = reviewDocument(proposed.scenes, {});
  state.paragraphReview = { commits: [{ changes: proposed.changes }] };
  const result = authorConstraints(state, next);
  assert.equal(result.length, 2);
  assert.equal(result[0].scope.originalTarget.quote, "营地由苏婉清照看。");
  assert.deepEqual(
    result.map((c) => c.sequence),
    [1, 2],
  );
  assert.equal(result[0].facts[0].quote, "苏婉清仍攥着毛毯。");
  assert.equal(result[0].facts[0].currentReference, null);
  assert.deepEqual(result[0].facts[0].currentContextReferences, [ref(3)]);
  assert.deepEqual(state.reviewWorkflow.constraints, history);
  assert.deepEqual(
    authorConstraints(JSON.parse(JSON.stringify(state)), next),
    result,
  );
});

test("候选补丁复核也获得修改后的对应原文，删除段落、伪造哈希或重名段落不猜地址", () => {
  const state = setup();
  const proposed = applyParagraphPatch(scenes, doc, findings, patch);
  const next = reviewDocument(proposed.scenes, {});
  const result = authorConstraints(state, next, {
    proposedChanges: proposed.changes,
  });
  assert.deepEqual(result[0].facts[0].currentContextReferences, [ref(3)]);
  assert.equal(state.paragraphReview, undefined);
  for (const [view, changes] of [
    [next, proposed.changes.map((c) => ({ ...c, sourceHash: "fake" }))],
    [
      reviewDocument([{ scene: 1, content: "其他文字。" }], {}),
      proposed.changes.map((c) => ({ ...c, replacement: "" })),
    ],
    [
      reviewDocument(
        [
          {
            scene: 1,
            content: "苏婉清把空手拢进袖子。\n\n苏婉清把空手拢进袖子。",
          },
        ],
        {},
      ),
      proposed.changes,
    ],
  ])
    assert.equal(
      authorConstraints(state, view, { proposedChanges: changes })[0].facts[0]
        .currentContextReferences,
      undefined,
    );
});

test("新旧裁定的原问题和修改后上下文作为必需地址进入每批，真实违反仍不能放行", async () => {
  const state = setup(),
    proposed = applyParagraphPatch(scenes, doc, findings, patch);
  state.paragraphReview = { commits: [{ changes: proposed.changes }] };
  const next = reviewDocument(proposed.scenes, {
    recentText: "海面有风。\n\n".repeat(2000),
  });
  const constraints = authorConstraints(state, next);
  let batches = 0;
  await runReviewBatches({
    doc: next,
    profile: createBudgetProfile(),
    pins: constraints,
    messagesFor: (view) => [
      {
        role: "user",
        content: JSON.stringify({
          document: modelDocument(view),
          authorConstraints: constraints,
        }),
      },
    ],
    ask: async (_key, messages, validate) => {
      batches++;
      const input = JSON.parse(messages[0].content);
      const paragraphs = input.document.sources
        .find((s) => s.sourceId === "scene:1")
        .paragraphs.map((r) => r[0]);
      assert.ok(paragraphs.includes(1) && paragraphs.includes(3));
      return validate({
        issues: [],
        authorChecks: constraints.map((c) => ({
          id: c.id,
          respected: true,
          evidence: [ref(1)],
        })),
      });
    },
    validate: (value, view) => validateFindings(value, view, [], constraints),
    key: "pinned-author",
    label: "审稿",
  });
  assert.ok(batches > 1);
  assert.throws(
    () =>
      validateFindings(
        {
          issues: [],
          authorChecks: constraints.map((c) => ({
            id: c.id,
            respected: false,
            evidence: [ref(1)],
          })),
        },
        next,
        [],
        constraints,
      ),
    /阻断问题/,
  );
});

test("同一事实的连续补丁和段号移动仍按实际文字定位，不靠旧段号", () => {
  const state = setup(),
    first = applyParagraphPatch(scenes, doc, findings, patch);
  const middle = reviewDocument(first.scenes, {});
  const second = {
    sourceId: "scene:1",
    paragraph: 3,
    sourceHash: middle.sources[0].hash,
    before: patch.replacements[0].replacement,
    replacement: "苏婉清的手空着。",
  };
  state.paragraphReview = {
    commits: [{ changes: first.changes }, { changes: [second] }],
  };
  const moved = reviewDocument(
    [
      {
        scene: 1,
        content:
          "开头。\n\n营地由苏婉清照看。\n\n苏婉清把毛毯交给女生。\n\n苏婉清的手空着。",
      },
    ],
    {},
  );
  assert.deepEqual(
    authorConstraints(state, moved)[0].facts[0].currentContextReferences,
    [ref(4)],
  );
});

test("已有裁定贯穿审稿、定位、补丁、复核和复审完成，原记录不被旧整句锁死", async () => {
  const state = setup(),
    history = structuredClone(state.reviewWorkflow.constraints);
  const phases = [];
  let patched = false;
  const result = await reviewAndPatch({
    scenes,
    context: {},
    state,
    signal: new AbortController().signal,
    save: async () => {},
    ask: async (_key, messages, validate, _output, _label, options) => {
      const phase = options.contract.id,
        input = JSON.parse(messages[1].content);
      phases.push(phase);
      const authorChecks = input.authorConstraints.map((c, i) => ({
        id: c.id,
        respected: true,
        evidence: [ref(i + 1)],
      }));
      assert.deepEqual(
        input.authorConstraints.map((c) => c.sequence),
        [1, 2],
      );
      if (phase === "review")
        return validate({ issues: patched ? [] : [issue], authorChecks });
      if (phase === "grounding")
        return validate({
          decisions: input.issues.map((i) => ({
            issueId: i.id,
            decision: "repair",
            reason: "按后一次物件取舍调整动作，前一次人物选择继续有效。",
            evidence: [ref(2), ref(3)],
            targets: [
              {
                sourceId: "scene:1",
                quote: "苏婉清仍攥着毛毯。",
                fix: "只删除仍持物动作",
              },
            ],
          })),
        });
      if (phase === "patch")
        return validate({
          replacements: [
            {
              ...ref(3),
              issueIds: input.issues.map((i) => i.id),
              replacement: patch.replacements[0].replacement,
            },
          ],
        });
      assert.equal(phase, "verification");
      patched = true;
      assert.equal(input.authorConstraints[0].facts[0].currentReference, null);
      assert.deepEqual(
        input.authorConstraints[0].facts[0].currentContextReferences,
        [ref(3)],
      );
      return validate({
        authorChecks,
        checks: input.issues.map((i) => ({
          issueId: i.id,
          resolved: true,
          preservedFacts: true,
          noUnsupportedAdditions: true,
          downstreamConsistent: true,
          evidence: [ref(3)],
          explanation: "物件按最新取舍处理，原人物选择保留。",
        })),
      });
    },
  });
  assert.deepEqual(phases, [
    "review",
    "grounding",
    "patch",
    "verification",
    "review",
  ]);
  assert.equal(result.commits.length, 1);
  assert.deepEqual(
    result.scenes,
    applyParagraphPatch(scenes, doc, findings, patch).scenes,
  );
  assert.deepEqual(state.reviewWorkflow.constraints, history);
  assert.equal(state.reviewWorkflow.phase, "completed");
});

test("旧裁定协议失败可以重新组装输入，同版耗尽与无关步骤不会获得无限重试", async () => {
  const old = {
    id: "old",
    contractId: "review",
    status: "exhausted",
    calls: 3,
    corrections: 2,
    input: [
      {
        role: "user",
        content: JSON.stringify({ authorConstraints: [{ id: "author" }] }),
      },
    ],
  };
  const state = {
    status: "retryable",
    reviewWorkflow: { phase: "review" },
    values: {},
    fragments: {},
    structuredSteps: { old },
    structuredFailure: { version: STRUCTURED_RECOVERY_VERSION, stepId: "old" },
  };
  assert.equal(blockedStructuredRecovery(state), null);
  old.authorContextVersion = AUTHOR_CONSTRAINT_CONTEXT_VERSION;
  assert.ok(blockedStructuredRecovery(state));
  delete old.authorContextVersion;
  old.contractId = "memory_extract";
  assert.ok(blockedStructuredRecovery(state));
  old.contractId = "review";
  const snapshot = structuredClone(old);
  const contract = workflowContract(
    "review",
    z.object({ issues: z.array(z.unknown()) }),
  );
  let calls = 0;
  const ask = createStructuredAsker({
    state,
    budget: createBudgetProfile(),
    call: async () => {
      calls++;
      return { text: JSON.stringify({ issues: [] }), finishReason: "stop" };
    },
    save: async () => {},
    signal: new AbortController().signal,
  });
  const messages = [
    { role: "system", content: AUTHOR_CONSTRAINT_RULES },
    {
      role: "user",
      content: JSON.stringify({
        authorConstraints: authorConstraints(setup(), doc),
      }),
    },
  ];
  const run = () =>
    ask(
      "author-recheck",
      messages,
      () => {
        throw Error("同版仍然错误");
      },
      3000,
      "审稿",
      { contract, maxCorrections: 2 },
    );
  await assert.rejects(run(), /纠错预算已用尽/);
  const count = calls;
  await assert.rejects(run(), /纠错预算已用尽/);
  assert.equal(calls, count);
  assert.ok(blockedStructuredRecovery(state));
  assert.deepEqual(state.structuredSteps.old, snapshot);
});

test("自动裁决编号按问题明确提供，纠错一次列出全部越界项且仍拒绝无依据裁决", async () => {
  const problems = ["first", "second"].map((id) => ({
    ...findings[0],
    id,
    resolution: "needs_confirmation",
    preserve: [],
  }));
  const state = { id: "indexed-evidence", values: {}, paragraphReview: {} };
  let calls = 0;
  const result = await resolveReviewProblems({
    problems,
    doc,
    state,
    save: async () => {},
    round: 0,
    ask: async (_key, messages, validate) => {
      calls++;
      const input = JSON.parse(messages[1].content);
      assert.equal(input.evidenceProtocol, ARBITRATION_EVIDENCE_VERSION);
      assert.equal(input.issues.length, 2);
      for (const i of input.issues)
        assert.deepEqual(
          i.evidence.map((e) => e.index),
          [1, 2],
        );
      const decisions = input.issues.map((i) => ({
        issueId: i.id,
        action: "preserve_evidence",
        evidenceIndexes: [1, 2, 3],
        reason: "回查有依据",
      }));
      assert.throws(
        () => validate({ decisions }),
        (error) => {
          assert.match(error.message, /first:.*仅可选.*1、2/);
          assert.match(error.message, /second:.*仅可选.*1、2/);
          return true;
        },
      );
      return validate({
        decisions: decisions.map((d) => ({ ...d, evidenceIndexes: [1] })),
      });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    result.map((i) => i.preserve),
    problems.map((i) => [i.evidence[0]]),
  );
});

test("裁决证据协议迁移仅影响旧裁决步骤，同版耗尽仍停止且原记录不改写", () => {
  const step = {
    id: "arbitration-old",
    contractId: "arbitration",
    status: "exhausted",
    corrections: 1,
    calls: 2,
    authorContextVersion: AUTHOR_CONSTRAINT_CONTEXT_VERSION,
  };
  const state = {
    status: "retryable",
    structuredSteps: { [step.id]: step },
    structuredFailure: {
      version: STRUCTURED_RECOVERY_VERSION,
      stepId: step.id,
    },
  };
  const old = structuredClone(step);
  assert.equal(blockedStructuredRecovery(state), null);
  assert.deepEqual(step, old);
  step.arbitrationEvidenceVersion = ARBITRATION_EVIDENCE_VERSION;
  assert.ok(blockedStructuredRecovery(state));
  delete step.arbitrationEvidenceVersion;
  step.contractId = "grounding";
  assert.ok(blockedStructuredRecovery(state));
});
