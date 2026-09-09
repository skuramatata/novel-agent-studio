import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepairPlan,
  planParagraphRepairs,
} from "../runtime/repair-plan.mjs";
import {
  reviewDocument,
  validateFindings,
  reviewAndPatch,
  REVIEW_VERSION,
  auditContinuity,
} from "../runtime/paragraph-review.mjs";
import { reviewWorkflow, retryReview } from "../runtime/review-workflow.mjs";
import { submitReviewDecision } from "../runtime/review-resolution.mjs";
import { digest } from "../runtime/memory.mjs";

const scenes = [
  {
    scene: 1,
    content:
      "他握着半截毛毯。那是先前的毛毯。\n\n报到水手时顿了一下：“阿贵——未到。”",
  },
];
const context = { recentText: "她把毛毯搭在他肩上。" };
const doc = reviewDocument(scenes, context);
const problems = validateFindings(
  {
    issues: [
      {
        kind: "unsupported_inference",
        target: { sourceId: "scene:1", paragraph: 1 },
        evidence: [
          { sourceId: "recent", paragraph: 1 },
          { sourceId: "scene:1", paragraph: 1 },
        ],
        searchedSources: doc.sources.map((source) => source.sourceId),
        explanation: "毛毯是否同一条尚需核对。",
        resolution: "remove_unsupported",
        fix: "核对毛毯的来历。",
      },
    ],
  },
  doc,
).issues;
const pending = () => ({
  decisions: [
    {
      issueId: problems[0].id,
      decision: "needs_confirmation",
      reason: "已有原文不足以确定是否为同一条毛毯。",
      evidence: [{ sourceId: "recent", quote: context.recentText }],
      targets: [],
    },
  ],
});

test("需要作者确认可以没有修改目标，保留同版讨论位置且不授予修订范围", () => {
  const result = validateRepairPlan(pending(), problems, doc);
  const issue = result.problems[0];
  assert.equal(issue.resolution, "needs_confirmation");
  assert.deepEqual(issue.target, problems[0].target);
  assert.deepEqual(issue.repairTargets, []);
  assert.deepEqual(issue.allowedTargets, []);
  assert.equal(result.dismissed.length, 0);
});

test("待确认不能沿用已变更正文、历史正文或伪造讨论位置", () => {
  for (const target of [
    { ...problems[0].target, sourceHash: "stale" },
    { ...problems[0].target, quote: "不存在的段落" },
    { ...problems[0].target, paragraph: 99 },
    {
      sourceId: "recent",
      paragraph: 1,
      sourceHash: doc.sources[1].hash,
      quote: context.recentText,
    },
  ])
    assert.throws(
      () => validateRepairPlan(pending(), [{ ...problems[0], target }], doc),
      /原文位置已失效/,
    );
});

test("修订依据按明确段句编号回填逐字原文，旧引文格式继续可恢复", () => {
  const value = pending();
  value.decisions[0].evidence = [
    { sourceId: "scene:1", paragraph: 2, sentence: 1 },
  ];
  assert.equal(
    validateRepairPlan(value, problems, doc).problems[0].evidence[0].quote,
    doc.sources[0].paragraphs[1].sentences[0].text,
  );
  value.decisions[0].evidence = [
    { sourceId: "recent", quote: context.recentText },
  ];
  assert.equal(
    validateRepairPlan(value, problems, doc).problems[0].evidence[0].quote,
    context.recentText,
  );
});

test("引用编号越界、伪造来源、被排除的段落与编号后夹带错误引文均不放行", () => {
  for (const ref of [
    {
      sourceId: "scene:1",
      paragraph: 0,
      quote: scenes[0].content.split("\n\n")[0],
    },
    { sourceId: "timeAnchors", paragraph: 1 },
    { sourceId: "scene:1", paragraph: 99 },
    { sourceId: "scene:1", paragraph: 1, sentence: 99 },
    {
      sourceId: "scene:1",
      paragraph: 2,
      quote: "报到水手时顿一下：“阿贵——未到。”",
    },
  ]) {
    const value = pending();
    value.decisions[0].evidence = [ref];
    assert.throws(() => validateRepairPlan(value, problems, doc));
  }
  const view = { ...doc, sources: [doc.sources[0]] };
  assert.throws(
    () => validateRepairPlan(pending(), problems, view),
    /来源不存在/,
  );
});

test("同次反馈全部问题的引用错误与缺失修改目标，不以待确认规则放行repair", () => {
  const value = pending();
  value.decisions[0].decision = "repair";
  value.decisions[0].evidence[0].quote = "伪造的历史";
  value.decisions.push({ ...value.decisions[0], issueId: "second" });
  assert.throws(
    () =>
      validateRepairPlan(
        value,
        [...problems, { ...problems[0], id: "second" }],
        doc,
      ),
    (error) => {
      for (const id of [problems[0].id, "second"])
        for (const field of ["targets", "evidence[0]"])
          assert.ok(error.message.includes(`${id}.${field}`));
      return true;
    },
  );
});

test("修订核对使用显式原始句号且允许两次有限纠错", async () => {
  const result = await planParagraphRepairs({
    problems,
    doc,
    authorConstraints: [],
    retry: 0,
    ask: async (_key, messages, validate, _output, _label, options) => {
      assert.equal(options.maxCorrections, 2);
      const data = JSON.parse(messages[1].content);
      assert.deepEqual(data.document.sources[0].paragraphs[1][1], [
        1,
        doc.sources[0].paragraphs[1].sentences[0].text,
      ]);
      return validate(pending());
    },
  });
  assert.equal(result.problems[0].resolution, "needs_confirmation");
});

test("恢复旧失败任务进入作者确认，重启保留问题，回答后重新核定范围再继续", async () => {
  let state = {
    id: "resume-grounding",
    values: { "final-scene:0": scenes[0].content },
    paragraphReview: {
      contextHash: digest([REVIEW_VERSION, context, 0, null]),
      inputScenes: structuredClone(scenes),
      round: 0,
      commits: [],
      cycle: {
        documentVersion: doc.version,
        attempt: 0,
        review: { issues: problems },
        problems,
      },
    },
  };
  reviewWorkflow(state).failure = {
    phase: "grounding",
    kind: "invalid_result",
    detail: "需要处理的问题必须明确实际出错的原文片段。",
  };
  retryReview(state);
  const run = (ask) =>
    reviewAndPatch({
      scenes,
      context,
      state,
      signal: new AbortController().signal,
      save: async () => {},
      ask,
    });
  let calls = 0;
  await assert.rejects(
    run(async (key, _messages, validate) => {
      assert.ok(key.includes(":grounding:"));
      calls++;
      return validate(pending());
    }),
    { name: "WaitingForAuthor" },
  );
  assert.equal(calls, 1);
  assert.equal(state.status, "awaiting_input");
  assert.equal(state.error, "");
  assert.equal(state.reviewWorkflow.failure, undefined);
  assert.deepEqual(state.paragraphReview.commits, []);
  assert.equal(state.values["final-scene:0"], scenes[0].content);
  const pendingId = state.pendingReview.id;
  state = JSON.parse(JSON.stringify(state));
  await assert.rejects(
    run(async () => assert.fail("未作答前不得调用模型")),
    { name: "WaitingForAuthor" },
  );
  assert.equal(state.pendingReview.id, pendingId);
  submitReviewDecision(state, {
    taskId: state.id,
    pendingId,
    choices: [
      {
        issueId: problems[0].id,
        optionId: "custom",
        instruction: "这是同一条毛毯，保留原文。",
      },
    ],
  });
  const result = await run(async (key, messages, validate) => {
    assert.ok(key.includes(":grounding:"));
    assert.match(messages[1].content, /这是同一条毛毯/);
    const dismissed = pending();
    dismissed.decisions[0].decision = "dismiss";
    dismissed.decisions[0].reason = "作者已经确认，原文可保留。";
    return validate(dismissed);
  });
  assert.deepEqual(result.scenes, scenes);
  assert.deepEqual(result.commits, []);
  assert.equal(state.pendingReview, undefined);
});

test("问题已列出但证据校验失败时，不误报专项漏列问题", async () => {
  const value = {
    issues: [
      {
        kind: "contradiction",
        target: { sourceId: "scene:1", paragraph: 1 },
        evidence: [
          { sourceId: "scene:1", paragraph: 1 },
          { sourceId: "scene:1", paragraph: 1 },
        ],
        explanation: "同段重复证据不能证明矛盾",
        resolution: "remove_unsupported",
        fix: "重新核实",
      },
    ],
    continuityChecks: ["time", "state", "evidence"].map((dimension) => ({
      dimension,
      verdict: dimension === "state" ? "problem" : "not_applicable",
      evidence:
        dimension === "state" ? [{ sourceId: "scene:1", paragraph: 1 }] : [],
      explanation: "核对原文",
    })),
  };
  await assert.rejects(
    auditContinuity({
      doc,
      context,
      ask: async (_key, _messages, validate) => validate(value),
    }),
    (error) => {
      assert.match(error.message, /矛盾需要两处不同陈述/);
      assert.doesNotMatch(error.message, /issues 未定位对应段落/);
      return true;
    },
  );
});
