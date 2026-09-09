import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewDocument,
  validateFindings,
  reviewAndPatch,
  applyParagraphPatch,
  REVIEW_VERSION,
} from "../runtime/paragraph-review.mjs";
import {
  pauseForAuthor,
  submitReviewDecision,
  resolveReviewProblems,
} from "../runtime/review-resolution.mjs";
import {
  applyAuthorDecisions,
  rememberDecisions,
  restoreRepeatedAuthorQuestions,
  reviewTaskState,
  trackFindings,
} from "../runtime/review-workflow.mjs";
import { validateRepairPlan } from "../runtime/repair-plan.mjs";
import { digest } from "../runtime/memory.mjs";

const scenes = [
  {
    scene: 1,
    content: "她抱着那条毛毯。角上杏枝绣到一半。\n\n她没有出声。她按住箱盖。",
  },
];
const context = { recentText: "她将毛毯搭在他肩上。" };
const doc = reviewDocument(scenes, context);
const rawFinding = {
  kind: "missing_history",
  target: { sourceId: "scene:1", paragraph: 1 },
  evidence: [
    { sourceId: "recent", paragraph: 1 },
    { sourceId: "scene:1", paragraph: 1, sentence: 2 },
  ],
  searchedSources: doc.sources.map((s) => s.sourceId),
  resolution: "needs_confirmation",
  explanation: "此前未交代杏枝是否绣完。",
  fix: "确认绣工状态。",
};
const finding = validateFindings({ issues: [rawFinding] }, doc).issues[0];
const insertionIssue = {
  ...finding,
  id: "bridge",
  ledgerId: "bridge-ledger",
  target: {
    sourceId: "scene:1",
    paragraph: 2,
    sourceHash: doc.sources[0].hash,
    quote: doc.sources[0].paragraphs[1].text,
  },
  resolution: "preserve_evidence",
  preserve: [],
  explanation: "补充现场毛毯状态。",
  fix: "在原句之后补一句，不改掉原句。",
};
const stateFor = () => ({
  id: "author-loop",
  status: "running",
  values: { "final-scene:0": scenes[0].content },
  paragraphReview: {
    contextHash: digest([REVIEW_VERSION, context, 0, null]),
    inputScenes: structuredClone(scenes),
    round: 0,
    commits: [],
    cycle: {
      documentVersion: doc.version,
      attempt: 0,
      review: { issues: [finding, insertionIssue] },
    },
  },
});
const confirmed = (state, issue = finding, facts = [finding.evidence[1]]) => {
  const answer = {
    ...issue,
    resolution: "preserve_evidence",
    preserve: facts,
    authorInstruction: "保留绣到一半的原文。",
  };
  rememberDecisions(state, "answered-once", [answer]);
  return answer;
};

test("作者选定当前细节后直接结案，不要求模型随机改判才退出确认", () => {
  const state = {};
  confirmed(state);
  const result = applyAuthorDecisions(state, [finding], doc)[0];
  assert.equal(result.blocking, false);
  assert.equal(result.authorRetained, true);
  assert.equal(result.preserve[0].quote, finding.evidence[1].quote);
  const shifted = reviewDocument(
    [{ scene: 1, content: "新增无关段落。\n\n" + scenes[0].content }],
    context,
  );
  const moved = {
    ...finding,
    target: { ...finding.target, paragraph: 2 },
    evidence: finding.evidence.map((r) =>
      r.sourceId === "scene:1" ? { ...r, paragraph: 2 } : r,
    ),
  };
  assert.equal(
    applyAuthorDecisions(state, [moved], shifted)[0].authorRetained,
    true,
  );
});

test("其他问题、改写后的断言、真矛盾或保留历史来源不能被同段裁定放行", () => {
  const state = {};
  const tracked = { ...finding, ledgerId: "same-paragraph" };
  confirmed(state, tracked);
  for (const issue of [
    {
      ...tracked,
      target: { ...finding.target, quote: "同段另一项未经授权的断言。" },
    },
    { ...tracked, kind: "contradiction" },
    {
      ...tracked,
      evidence: [{ ...finding.evidence[1], quote: "另一个事实。" }],
    },
  ])
    assert.equal(
      applyAuthorDecisions(state, [issue], doc)[0].authorRetained,
      undefined,
    );
  const old = {};
  confirmed(old, finding, [finding.evidence[0]]);
  assert.equal(
    applyAuthorDecisions(old, [finding], doc)[0].authorRetained,
    undefined,
  );
  const changed = reviewDocument(
    [{ scene: 1, content: "她没有毛毯。" }],
    context,
  );
  assert.equal(
    applyAuthorDecisions(state, [finding], changed)[0].authorRetained,
    undefined,
  );
});

test("已答自定义问题仍需要执行时，模型不能再次返回needs_confirmation", () => {
  const issue = {
    ...finding,
    authorConstraintId: "saved-answer",
    authorInstruction: "将绣工写成未完成。",
  };
  assert.throws(
    () =>
      validateRepairPlan(
        {
          decisions: [
            {
              issueId: issue.id,
              decision: "needs_confirmation",
              reason: "请再确认",
              evidence: [{ sourceId: "scene:1", paragraph: 1 }],
              targets: [],
            },
          ],
        },
        [issue],
        doc,
      ),
    /作者已裁定.*不能再次needs_confirmation/,
  );
});

test("复审把整段缩为作者选定的一句并改换证据时，仍认得旧版保留裁定", () => {
  const state = {};
  confirmed(state);
  delete state.reviewWorkflow.constraints[0].kind;
  const narrowed = {
    ...finding,
    target: finding.evidence[1],
    evidence: [finding.evidence[1]],
  };
  assert.equal(
    applyAuthorDecisions(state, [narrowed], doc)[0].authorRetained,
    true,
  );
  const [original] = trackFindings(state, [narrowed], doc.version);
  const [retained] = trackFindings(
    state,
    applyAuthorDecisions(state, [original], doc),
    doc.version,
  );
  assert.equal(
    state.reviewWorkflow.issues.find((i) => i.id === retained.ledgerId).status,
    "closed",
  );
  for (const other of [
    { ...narrowed, kind: "contradiction" },
    { ...narrowed, target: { ...narrowed.target, quote: "杏枝" } },
    { ...narrowed, target: { ...narrowed.target, quote: "她抱着那条毛毯。" } },
  ])
    assert.equal(
      applyAuthorDecisions(state, [other], doc)[0].authorRetained,
      undefined,
    );
});

test("旧版重复问题投影为可恢复，复用原答案且不增加作答记录", () => {
  const state = stateFor();
  confirmed(state);
  state.status = "awaiting_input";
  state.pendingReview = {
    id: "repeated",
    documentVersion: doc.version,
    issues: [finding],
    automatic: [insertionIssue],
  };
  const before = structuredClone(state);
  assert.equal(reviewTaskState(state).resumable, true);
  assert.equal(reviewTaskState(state).review, null);
  assert.deepEqual(state, before, "状态投影不能修改任务");
  assert.equal(restoreRepeatedAuthorQuestions(state), true);
  assert.equal(state.pendingReview, undefined);
  assert.equal(state.reviewWorkflow.constraints.length, 1);
  assert.equal(state.reviewDecisions, undefined);
  assert.equal(state.paragraphReview.cycle.problems.length, 2);
  assert.equal(restoreRepeatedAuthorQuestions(state), false);
  const stale = structuredClone(before);
  stale.pendingReview.issues[0].target.sourceHash = "changed";
  assert.equal(restoreRepeatedAuthorQuestions(stale), false);
  assert.equal(reviewTaskState(stale).review.id, "repeated");
  const mixed = structuredClone(before);
  mixed.pendingReview.issues.push(insertionIssue);
  assert.equal(restoreRepeatedAuthorQuestions(mixed), false);
  assert.equal(reviewTaskState(mixed).review.issues.length, 2);
  const partial = structuredClone(before);
  partial.reviewDecisions = {
    repeated: { choices: [{ issueId: finding.id }] },
  };
  assert.equal(restoreRepeatedAuthorQuestions(partial), false);
});

test("当前问题集合不被旧作者决策缓存扩大", async () => {
  const state = stateFor(),
    answer = confirmed(state);
  state.paragraphReview.authorResolutions = {
    [doc.version]: [answer, insertionIssue],
  };
  const resolved = await resolveReviewProblems({
    state,
    doc,
    problems: [answer],
    round: 0,
    save: async () => {},
    ask: () => assert.fail("不应重新裁定"),
  });
  assert.deepEqual(
    resolved.map((i) => i.id),
    [answer.id],
  );
  const different = {
    ...answer,
    resolution: "remove_unsupported",
    preserve: [],
    authorInstruction: undefined,
    evidence: [{ ...finding.evidence[0], quote: "同段另一项事实。" }],
  };
  const untouched = await resolveReviewProblems({
    state,
    doc,
    problems: [different],
    round: 0,
    save: async () => {},
    ask: () => assert.fail("不应重新裁定"),
  });
  assert.equal(untouched[0].resolution, "remove_unsupported");
  assert.deepEqual(untouched[0].evidence, different.evidence);
});

const insertionPlan = (operation = "insert_after") =>
  validateRepairPlan(
    {
      decisions: [
        {
          issueId: insertionIssue.id,
          decision: "repair",
          reason: "补充现场承接。",
          evidence: [{ sourceId: "scene:1", paragraph: 1 }],
          targets: [
            {
              sourceId: "scene:1",
              quote: "她没有出声。",
              operation,
              fix: "补充她臂弯里拢着毛毯。",
            },
          ],
        },
      ],
    },
    [insertionIssue],
    doc,
  );

test("锚点前后补写保留正确原句，旧版replace仍必须消除错误片段", () => {
  for (const operation of ["insert_before", "insert_after"]) {
    const plan = insertionPlan(operation);
    const replacement =
      operation === "insert_after"
        ? "她没有出声。她臂弯里拢着毛毯。她按住箱盖。"
        : "她臂弯里拢着毛毯。她没有出声。她按住箱盖。";
    const patch = {
      baseVersion: doc.version,
      replacements: [
        {
          sourceId: "scene:1",
          paragraph: 2,
          issueIds: [insertionIssue.id],
          replacement,
        },
      ],
    };
    assert.equal(
      applyParagraphPatch(scenes, doc, plan.problems, patch).changes[0]
        .replacement,
      replacement,
    );
    const legacy = structuredClone(plan.problems);
    delete legacy[0].repairTargets[0].operation;
    assert.throws(
      () => applyParagraphPatch(scenes, doc, legacy, patch),
      /原错误片段仍未修改/,
    );
  }
});

test("补写不能漏改、删原句、改别句、只加标点或偷偷插到别处", () => {
  const plan = insertionPlan();
  for (const replacement of [
    "她没有出声。她按住箱盖。",
    "她臂弯里拢着毛毯。她按住箱盖。",
    "她没有出声。她臂弯里拢着毛毯。她丢掉箱盖。",
    "她没有出声。——她按住箱盖。",
    "她没有出声。她按住箱盖。她臂弯里拢着毛毯。",
  ])
    assert.throws(() =>
      applyParagraphPatch(scenes, doc, plan.problems, {
        baseVersion: doc.version,
        replacements: [
          {
            sourceId: "scene:1",
            paragraph: 2,
            issueIds: [insertionIssue.id],
            replacement,
          },
        ],
      }),
    );
});

test("一次确认后完成补写与独立复核，重审再报同一细节仍按裁定结案", async () => {
  let state = stateFor();
  state.paragraphReview.cycle.review.issues = trackFindings(
    state,
    [finding, insertionIssue],
    doc.version,
  );
  const [question, automatic] = state.paragraphReview.cycle.review.issues;
  await assert.rejects(
    pauseForAuthor([question], doc, state, async () => {}, "确认", [automatic]),
    { name: "WaitingForAuthor" },
  );
  submitReviewDecision(state, {
    taskId: state.id,
    pendingId: state.pendingReview.id,
    choices: [{ issueId: question.id, optionId: "evidence-2" }],
  });
  state = JSON.parse(JSON.stringify(state));
  const stages = [];
  const result = await reviewAndPatch({
    scenes,
    context,
    state,
    signal: new AbortController().signal,
    save: async () => {},
    ask: async (_key, messages, validate) => {
      const prompt = messages[0].content,
        data = JSON.parse(messages[1].content);
      const authorChecks = (data.authorConstraints || []).map((c) => ({
        id: c.id,
        respected: true,
        evidence: [{ sourceId: "scene:1", paragraph: 1, sentence: 2 }],
      }));
      if (prompt.includes("独立修订依据核对员")) {
        stages.push("grounding");
        assert.deepEqual(
          data.issues.map((i) => i.id),
          [automatic.id],
        );
        return validate({
          decisions: [
            {
              issueId: automatic.id,
              decision: "repair",
              reason: "补充承接",
              evidence: [{ sourceId: "scene:1", paragraph: 1 }],
              targets: [
                {
                  sourceId: "scene:1",
                  quote: "她没有出声。",
                  operation: "insert_after",
                  fix: "补写毛毯在臂弯。",
                },
              ],
            },
          ],
        });
      }
      if (prompt.includes("小说段落修订编辑")) {
        stages.push("patch");
        assert.equal(data.issues[0].repairTargets[0].operation, "insert_after");
        return validate({
          baseVersion: data.document.version,
          replacements: [
            {
              sourceId: "scene:1",
              paragraph: 2,
              issueIds: [automatic.id],
              replacement: "她没有出声。她臂弯里拢着毛毯。她按住箱盖。",
            },
          ],
        });
      }
      if (prompt.includes("独立补丁复核员")) {
        stages.push("verify");
        return validate({
          authorChecks,
          checks: [
            {
              issueId: automatic.id,
              resolved: true,
              preservedFacts: true,
              noUnsupportedAdditions: true,
              downstreamConsistent: true,
              evidence: [{ sourceId: "scene:1", paragraph: 2 }],
              explanation: "指定位置已补写，原文和作者裁定均保留。",
            },
          ],
        });
      }
      stages.push("review");
      return validate({ issues: [rawFinding], authorChecks });
    },
  });
  assert.deepEqual(stages, ["grounding", "patch", "verify", "review"]);
  assert.equal(result.commits.length, 1);
  assert.equal(state.pendingReview, undefined);
  assert.equal(state.reviewWorkflow.constraints.length, 1);
  assert.equal(state.authorReviewHistory.length, 1);
  assert.ok(
    result.scenes[0].content.startsWith(scenes[0].content.split("\n\n")[0]),
  );
  assert.equal(state.reviewWorkflow.phase, "completed");
});
