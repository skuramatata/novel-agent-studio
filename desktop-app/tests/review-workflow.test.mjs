import { repairPlanResponse } from "./fixtures/repair-plan.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewAndPatch,
  reviewDocument,
  validateFindings,
  validateVerification,
} from "../runtime/paragraph-review.mjs";
import {
  reviewWorkflow,
  trackFindings,
  markIssues,
  rememberDecisions,
  authorConstraints,
  reuseAuthorDecisions,
  retryReview,
  reviewTaskState,
} from "../runtime/review-workflow.mjs";
import {
  pauseForAuthor,
  submitReviewDecision,
  isReviewDecisionReplay,
  resolveReviewProblems,
} from "../runtime/review-resolution.mjs";

const scenes = [{ scene: 1, content: "纸页干燥。\n\n两页都湿透了。" }];
const ref = (paragraph) => ({ sourceId: "scene:1", paragraph });
const finding = {
  kind: "contradiction",
  target: ref(2),
  evidence: [ref(1), ref(2)],
  explanation: "同一时刻干湿冲突",
  resolution: "needs_confirmation",
  fix: "保留干燥",
};
const doc = reviewDocument(scenes, {});
const problems = validateFindings({ issues: [finding] }, doc).issues;
const authorChecks = (d) =>
  (d.authorConstraints || []).map((c) => ({
    id: c.id,
    respected: true,
    evidence: [ref(1)],
  }));

for (const failedPhase of [
  "review",
  "arbitration",
  "grounding",
  "patch",
  "verify",
]) {
  test(`${failedPhase} 技术失败保存阶段，重启仅重试失败节点，不转作者问题`, async () => {
    let state = { id: "task", values: { "final-scene:0": scenes[0].content } },
      saved,
      fail = true,
      patched = false;
    const calls = [];
    const ask = async (key, messages, validate) => {
      const d = JSON.parse(messages[1].content);
      const phase = key.includes(":grounding:")
        ? "grounding"
        : key.startsWith("arbitrate-")
          ? "arbitration"
          : key.includes(":verify:")
            ? "verify"
            : key.includes(":patch:")
              ? "patch"
              : "review";
      calls.push({ phase, key });
      if (phase === failedPhase && fail) {
        fail = false;
        const e = Error("模拟协议失败");
        e.code = "MODEL_VALIDATION";
        throw e;
      }
      if (phase === "grounding") return validate(repairPlanResponse(d));
      if (phase === "review")
        return validate({
          issues: patched ? [] : [finding],
          authorChecks: authorChecks(d),
        });
      if (phase === "arbitration")
        return validate({
          decisions: d.issues.map((i) => ({
            issueId: i.id,
            action: "preserve_evidence",
            evidenceIndexes: [1],
            reason: "首次正面描写",
          })),
        });
      if (phase === "patch")
        return validate({
          baseVersion: d.document.version,
          replacements: [
            {
              ...ref(2),
              issueIds: d.issues.map((i) => i.id),
              replacement: "两页仍然干燥。",
            },
          ],
        });
      patched = true;
      return validate({
        checks: d.issues.map((i) => ({
          issueId: i.id,
          resolved: true,
          preservedFacts: true,
          noUnsupportedAdditions: true,
          downstreamConsistent: true,
          evidence: [ref(2)],
          explanation: "已统一",
        })),
        authorChecks: authorChecks(d),
      });
    };
    const run = () =>
      reviewAndPatch({
        scenes: [{ scene: 1, content: state.values["final-scene:0"] }],
        context: {},
        state,
        ask,
        signal: new AbortController().signal,
        save: async () => {
          saved = structuredClone(state);
        },
      });
    await assert.rejects(run, {
      name: "ReviewRetryableError",
      phase: failedPhase,
    });
    assert.equal(saved.status, "retryable");
    assert.equal(saved.pendingReview, undefined);
    assert.equal(saved.values["final-scene:0"], scenes[0].content);
    assert.equal(reviewTaskState(saved).resumable, true);
    const offset = calls.length;
    state = structuredClone(saved);
    retryReview(state);
    const result = await run();
    assert.equal(calls[offset].phase, failedPhase);
    assert.notEqual(calls[offset].key, calls[offset - 1].key);
    assert.equal(result.commits.length, 1);
    assert.equal(state.reviewWorkflow.phase, "completed");
    assert.equal(state.reviewWorkflow.issues[0].status, "closed");
    if (failedPhase === "verify")
      assert.equal(calls.filter((c) => c.phase === "patch").length, 1);
  });
}

test("问题编号跨证据变化关联，关闭后重开必须记录新的证据原因", () => {
  const s = {};
  const first = trackFindings(s, problems, doc.version);
  markIssues(s, first, "verified");
  const changedDoc = reviewDocument(
    [{ scene: 1, content: "纸页干燥。\n\n他看见湿透的纸页。" }],
    {},
  );
  const changed = validateFindings(
    { issues: [{ ...finding, explanation: "修订后仍声称湿透" }] },
    changedDoc,
  ).issues;
  const again = trackFindings(s, changed, changedDoc.version);
  assert.equal(again[0].ledgerId, first[0].ledgerId);
  assert.equal(s.reviewWorkflow.events.at(-1).type, "issue_reopened");
  assert.match(s.reviewWorkflow.events.at(-1).reason, /修订后/);
  markIssues(s, again, "closed");
  assert.throws(
    () => trackFindings(s, changed, "new-document-version"),
    /没有新证据/,
  );
});

test("作者事实按文本重新定位，段号移动不串事实，不匹配时不猜地址", () => {
  const s = {};
  const issues = trackFindings(s, problems, doc.version);
  rememberDecisions(s, "answer", [
    {
      ...issues[0],
      resolution: "preserve_evidence",
      preserve: [issues[0].evidence[0]],
      authorInstruction: "以干燥为准",
    },
  ]);
  const moved = reviewDocument(
    [{ scene: 1, content: "有人敲门。\n\n纸页干燥。\n\n两页都湿透了。" }],
    {},
  );
  const constraints = authorConstraints(s, moved);
  assert.equal(constraints[0].facts[0].currentReference.paragraph, 2);
  const gone = reviewDocument([{ scene: 1, content: "纸张没有受潮。" }], {});
  assert.equal(authorConstraints(s, gone)[0].facts[0].currentReference, null);
  assert.equal(authorConstraints(s, gone)[0].facts[0].quote, "纸页干燥。");
  assert.equal(
    reuseAuthorDecisions(s, issues, doc)[0].authorInstruction,
    "以干燥为准",
  );
  assert.throws(
    () => validateFindings({ issues: [] }, moved, [], constraints),
    /全部作者裁定/,
  );
  assert.throws(
    () =>
      validateFindings(
        {
          issues: [],
          authorChecks: [
            { id: constraints[0].id, respected: false, evidence: [ref(2)] },
          ],
        },
        moved,
        [],
        constraints,
      ),
    /阻断问题/,
  );
});

test("未被作者覆盖的普通新问题不能继承另一个问题的裁定", () => {
  const s = {};
  rememberDecisions(s, "a", [
    {
      ...problems[0],
      resolution: "author_direction",
      authorInstruction: "保留干燥",
    },
  ]);
  const other = {
    ...problems[0],
    target: { ...ref(1), quote: "钥匙在桌上。" },
    evidence: [
      { ...ref(1), quote: "钥匙在桌上。" },
      { ...ref(2), quote: "钥匙在门外。" },
    ],
  };
  assert.equal(
    reuseAuthorDecisions(s, [other], doc)[0].authorInstruction,
    undefined,
  );
});

test("只询问未裁定项，自动决定与作者回答一起进入修订", async () => {
  const s = { id: "task", paragraphReview: {}, status: "running" };
  const automatic = {
    ...problems[0],
    id: "automatic",
    resolution: "preserve_evidence",
    preserve: [problems[0].evidence[0]],
  };
  await assert.rejects(
    () =>
      resolveReviewProblems({
        state: s,
        doc,
        problems: [automatic, ...problems],
        save: async () => {},
        round: 0,
        ask: async (k, m, validate) =>
          validate({
            decisions: [
              {
                issueId: problems[0].id,
                action: "needs_confirmation",
                evidenceIndexes: [],
                reason: "关键取舍未确定",
              },
            ],
          }),
      }),
    { name: "WaitingForAuthor" },
  );
  assert.equal(s.pendingReview.issues.length, 1);
  const request = {
    taskId: "task",
    pendingId: s.pendingReview.id,
    choices: [{ issueId: problems[0].id, optionId: "evidence-1" }],
  };
  submitReviewDecision(s, request);
  const resolved = await resolveReviewProblems({
    state: s,
    doc,
    problems,
    save: async () => {},
    round: 0,
    ask: () => assert.fail("不应重新裁定"),
  });
  assert.equal(resolved.length, 2);
  assert.equal(s.reviewWorkflow.constraints.length, 1);
  s.status = "completed";
  assert.equal(isReviewDecisionReplay(s, request), true);
  assert.equal(
    isReviewDecisionReplay(s, {
      ...request,
      choices: [{ ...request.choices[0], optionId: "evidence-2" }],
    }),
    false,
  );
});

test("旧检查点失败但仍有未答问题时投影为等待；全部回答后可恢复", async () => {
  const s = { id: "task", status: "running" };
  await assert.rejects(() =>
    pauseForAuthor(problems, doc, s, async () => {}, "选择"),
  );
  s.status = "failed";
  assert.equal(reviewTaskState(s).status, "awaiting_input");
  assert.equal(reviewTaskState(s).resumable, false);
  s.reviewDecisions = {
    [s.pendingReview.id]: {
      choices: [{ issueId: problems[0].id, optionId: "evidence-1" }],
    },
  };
  assert.equal(reviewTaskState(s).review, null);
  assert.equal(reviewTaskState(s).resumable, true);
});

test("旧作者历史导入一次，事实快照不会因重复恢复增加", () => {
  const s = {
    authorReviewHistory: [
      {
        pendingId: "old",
        issues: [
          {
            ...problems[0],
            resolution: "preserve_evidence",
            preserve: [problems[0].evidence[0]],
            authorInstruction: "保留干燥",
          },
        ],
      },
    ],
  };
  reviewWorkflow(s);
  reviewWorkflow(s);
  assert.equal(s.reviewWorkflow.constraints.length, 1);
  assert.equal(authorConstraints(s, doc)[0].facts[0].quote, "纸页干燥。");
});
test("旧版回答已消费但补丁未执行时，迁移从补丁开始而不是重审跳过回答", async () => {
  const s = {
    id: "legacy",
    status: "running",
    values: { "final-scene:0": scenes[0].content },
  };
  const base = {
    scenes,
    context: {},
    state: s,
    save: async () => {},
    signal: new AbortController().signal,
  };
  await assert.rejects(
    () =>
      reviewAndPatch({
        ...base,
        ask: async (key, messages, validate) => {
          if (key.includes(":review:")) return validate({ issues: [finding] });
          return validate({
            decisions: [
              {
                issueId: "finding-1",
                action: "needs_confirmation",
                evidenceIndexes: [],
                reason: "请作者决定",
              },
            ],
          });
        },
      }),
    { name: "WaitingForAuthor" },
  );
  submitReviewDecision(s, {
    taskId: s.id,
    pendingId: s.pendingReview.id,
    choices: [{ issueId: "finding-1", optionId: "evidence-1" }],
  });
  await resolveReviewProblems({
    state: s,
    doc,
    problems,
    round: 0,
    save: async () => {},
    ask: () => assert.fail("不应调用"),
  });
  delete s.paragraphReview.cycle;
  delete s.reviewWorkflow;
  assert.equal(s.pendingReview, undefined);
  const stages = [];
  const result = await reviewAndPatch({
    ...base,
    ask: async (key, messages, validate) => {
      const d = JSON.parse(messages[1].content);
      if (key.includes(":grounding:")) {
        stages.push("grounding");
        return validate(repairPlanResponse(d));
      }
      if (key.includes(":review:")) {
        stages.push("review");
        return validate({ issues: [], authorChecks: authorChecks(d) });
      }
      if (key.includes(":verify:")) {
        stages.push("verify");
        return validate({
          authorChecks: authorChecks(d),
          checks: d.issues.map((i) => ({
            issueId: i.id,
            resolved: true,
            preservedFacts: true,
            noUnsupportedAdditions: true,
            downstreamConsistent: true,
            evidence: [ref(2)],
            explanation: "保留干燥",
          })),
        });
      }
      stages.push("patch");
      return validate({
        baseVersion: d.document.version,
        replacements: [
          {
            ...ref(2),
            issueIds: d.issues.map((i) => i.id),
            replacement: "两页仍然干燥。",
          },
        ],
      });
    },
  });
  assert.deepEqual(stages, ["grounding", "patch", "verify", "review"]);
  assert.equal(result.commits.length, 1);
  assert.equal(s.reviewWorkflow.constraints.length, 1);
});
