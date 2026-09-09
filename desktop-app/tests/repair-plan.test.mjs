import test from "node:test";
import assert from "node:assert/strict";
import {
  locateRepairAnchor,
  validateRepairPlan,
} from "../runtime/repair-plan.mjs";
import {
  reviewDocument,
  validateFindings,
  applyParagraphPatch,
  reviewAndPatch,
  REVIEW_VERSION,
} from "../runtime/paragraph-review.mjs";
import { retryReview, reviewWorkflow } from "../runtime/review-workflow.mjs";
import { digest } from "../runtime/memory.mjs";

const rows = Array.from(
  { length: 15 },
  (_, i) => `无关段落${i + 1}，原样保留。`,
);
rows[0] = "潮涨上来的时候，他在灯室里坐着。";
rows[8] = "不能再等一个月一回的舢板。先去查旧账。";
rows[10] = "等陈婆得等下半月那一回。";
rows[14] = "六天。这一回他等的不是船，是一个村。";
const scenes = [{ scene: 5, content: rows.join("\n\n") }];
const context = { recentText: "说好一个月两回，这是头一回。" };
const doc = reviewDocument(scenes, context);
const faultyReview = {
  issues: [
    {
      kind: "contradiction",
      target: { sourceId: "scene:5", paragraph: 1 },
      evidence: [
        { sourceId: "scene:5", paragraph: 1 },
        { sourceId: "recent", paragraph: 1 },
      ],
      preserve: [{ sourceId: "recent", paragraph: 1 }],
      resolution: "preserve_evidence",
      explanation: "第1段一个月一回与历史两回矛盾",
      fix: "只改第1段，同时将第15段六天改成半月",
    },
  ],
};
const problems = validateFindings(faultyReview, doc).issues;
const plannedResponse = {
  decisions: [
    {
      issueId: "finding-1",
      decision: "repair",
      reason: "频率错误实际在第9段，第15段等待时间也需统一",
      evidence: [{ sourceId: "recent", quote: context.recentText }],
      targets: [
        { sourceId: "scene:5", quote: "一个月一回的舢板", fix: "改为半月一回" },
        { sourceId: "scene:5", quote: "六天。", fix: "改为半月" },
      ],
    },
  ],
};
const plan = validateRepairPlan(plannedResponse, problems, doc);
const patch = {
  baseVersion: doc.version,
  replacements: [
    {
      sourceId: "scene:5",
      paragraph: 9,
      issueIds: ["finding-1"],
      replacement: rows[8].replace("一个月一回", "半月一回"),
    },
    {
      sourceId: "scene:5",
      paragraph: 15,
      issueIds: ["finding-1"],
      replacement: rows[14].replace("六天。", "还有半月。"),
    },
  ],
};

test("错误段号不作为授权依据，按逐字原文定位第9和15段", () => {
  assert.equal(problems[0].target.paragraph, 1);
  assert.deepEqual(
    plan.problems[0].repairTargets.map((t) => t.paragraph),
    [9, 15],
  );
  assert.equal(
    plan.problems[0].allowedTargets.some((t) => t.paragraph === 1),
    false,
  );
  const changed = applyParagraphPatch(scenes, doc, plan.problems, patch);
  const actual = changed.scenes[0].content.split("\n\n");
  for (let i = 0; i < rows.length; i++)
    if (![8, 14].includes(i)) assert.equal(actual[i], rows[i]);
});

test("原文锚点不接受拼接、改字、歧义、仅标点或历史编辑", () => {
  for (const quote of ["一个月两回的舢板", "六天。这次", "。"])
    assert.throws(() =>
      locateRepairAnchor(doc, { sourceId: "scene:5", quote }, true),
    );
  assert.throws(
    () =>
      locateRepairAnchor(
        doc,
        { sourceId: "recent", quote: context.recentText },
        true,
      ),
    /历史/,
  );
  const repeated = reviewDocument(
    [{ scene: 1, content: "船来了。\n\n船来了。" }],
    {},
  );
  assert.throws(
    () =>
      locateRepairAnchor(repeated, { sourceId: "scene:1", quote: "船来了" }),
    /不唯一/,
  );
});

test("错误来源和改写标点仍被拒绝，纠错同时列出每条问题及真实原文候选", () => {
  const evidenceDoc = reviewDocument(
    [{ scene: 1, content: "“滩上。”她说，“人还站着。”" }],
    { recentText: "葛姓守塔人调令经查无档。交接手续档案未载。" },
  );
  const invalid = {
    decisions: [
      {
        issueId: "finding-1",
        decision: "dismiss",
        reason: "需核对原文",
        targets: [],
        evidence: [
          { sourceId: "scene:1", quote: "葛姓守塔人调令经查无档。" },
          { sourceId: "scene:1", quote: '"滩上。"她说，"人还站着。"' },
        ],
      },
    ],
  };
  assert.throws(
    () => validateRepairPlan(invalid, problems, evidenceDoc),
    (error) => {
      assert.match(error.message, /evidence\[0\]/);
      assert.match(error.message, /evidence\[1\]/);
      assert.match(error.message, /"sourceId":"recent"/);
      assert.match(error.message, /“滩上。”她说，“人还站着。”/);
      assert.match(error.message, /未自动接受/);
      return true;
    },
  );
  invalid.decisions[0].evidence = [
    { sourceId: "recent", quote: "葛姓守塔人调令经查无档。" },
    { sourceId: "scene:1", quote: "“滩上。”她说，“人还站着。”" },
  ];
  assert.equal(
    validateRepairPlan(invalid, problems, evidenceDoc).dismissed.length,
    1,
  );
});

test("不能通过漏改后文或只改无关句子骗过复核", () => {
  assert.throws(
    () =>
      applyParagraphPatch(scenes, doc, plan.problems, {
        ...patch,
        replacements: patch.replacements.slice(0, 1),
      }),
    /第15段/,
  );
  const misleading = structuredClone(patch);
  misleading.replacements[0].replacement = rows[8].replace("查旧账", "翻旧账");
  assert.throws(
    () => applyParagraphPatch(scenes, doc, plan.problems, misleading),
    /原错误片段仍未修改/,
  );
});

test("核对计划逐项覆盖问题，不能遗漏、重复、或悄悄授权历史正文", () => {
  assert.throws(
    () => validateRepairPlan({ decisions: [] }, problems, doc),
    /逐项/,
  );
  assert.throws(
    () =>
      validateRepairPlan(
        {
          decisions: [
            plannedResponse.decisions[0],
            plannedResponse.decisions[0],
          ],
        },
        problems,
        doc,
      ),
    /逐项/,
  );
  const bad = structuredClone(plannedResponse);
  bad.decisions[0].targets[0] = {
    sourceId: "recent",
    quote: context.recentText,
    fix: "改旧文",
  };
  assert.throws(() => validateRepairPlan(bad, problems, doc), /历史/);
});

test("恢复旧版错误审稿缓存先核对实际范围，旧提交不消耗本次预算", async () => {
  const original = [
    {
      scene: 5,
      content: scenes[0].content.replace(rows[10], "等陈婆是月底。"),
    },
  ];
  const originalDoc = reviewDocument(original, context);
  const oldFindings = validateFindings(
    {
      issues: [
        {
          ...faultyReview.issues[0],
          target: { sourceId: "scene:5", paragraph: 11 },
        },
      ],
    },
    originalDoc,
  ).issues;
  const oldPatch = {
    baseVersion: originalDoc.version,
    replacements: [
      {
        sourceId: "scene:5",
        paragraph: 11,
        issueIds: ["finding-1"],
        replacement: rows[10],
      },
    ],
  };
  const oldResult = applyParagraphPatch(
    original,
    originalDoc,
    oldFindings,
    oldPatch,
  );
  const commit = {
    beforeVersion: originalDoc.version,
    afterHash: digest(oldResult.scenes),
    findings: oldFindings,
    patch: oldPatch,
  };
  const state = {
    values: { "final-scene:4": scenes[0].content },
    paragraphReview: {
      contextHash: digest([REVIEW_VERSION, context, 0, null]),
      inputScenes: original,
      round: 1,
      reviewLimit: 1,
      commits: [commit],
      cycle: {
        documentVersion: doc.version,
        attempt: 0,
        review: { issues: problems },
        problems,
      },
    },
  };
  reviewWorkflow(state).failure = {
    kind: "invalid_result",
    phase: "patch",
    detail: "补丁超出问题指定段落；需要扩大范围时先列出新问题和依据。",
  };
  retryReview(state);
  assert.equal(state.reviewWorkflow.phase, "grounding");
  const calls = [];
  const result = await reviewAndPatch({
    scenes,
    context,
    state,
    maxRounds: 1,
    signal: new AbortController().signal,
    save: async () => {},
    ask: async (key, messages, validate) => {
      if (key.includes(":grounding:")) {
        calls.push("grounding");
        return validate(plannedResponse);
      }
      if (key.includes(":review:")) {
        calls.push("review");
        return validate({ issues: [] });
      }
      if (key.includes(":verify:")) {
        calls.push("verify");
        return validate({
          checks: [
            {
              issueId: "finding-1",
              resolved: true,
              preservedFacts: true,
              noUnsupportedAdditions: true,
              downstreamConsistent: true,
              evidence: [
                { sourceId: "scene:5", paragraph: 9 },
                { sourceId: "scene:5", paragraph: 15 },
              ],
              explanation: "两处均已改",
            },
          ],
        });
      }
      calls.push("patch");
      const data = JSON.parse(messages[1].content);
      assert.deepEqual(
        data.issues[0].repairTargets.map((t) => t.paragraph),
        [9, 15],
      );
      return validate(patch);
    },
  });
  assert.deepEqual(calls, ["grounding", "patch", "verify", "review"]);
  assert.equal(state.reviewWorkflow.phase, "completed");
  assert.equal(result.commits.length, 2);
});

test("新补丁漏改时自动回到依据核对，完成前不写入草稿", async () => {
  const state = { values: { "final-scene:4": scenes[0].content } };
  let reviews = 0,
    plans = 0,
    patches = 0,
    verifications = 0;
  const result = await reviewAndPatch({
    scenes,
    context,
    state,
    signal: new AbortController().signal,
    save: async () => {},
    ask: async (key, messages, validate) => {
      if (key.includes(":review:"))
        return validate(++reviews === 1 ? faultyReview : { issues: [] });
      if (key.includes(":grounding:")) {
        if (++plans === 2) {
          assert.match(
            JSON.parse(messages[1].content).previousFailure.reason,
            /第15段/,
          );
          assert.equal(state.values["final-scene:4"], scenes[0].content);
        }
        return validate(plannedResponse);
      }
      if (key.includes(":verify:")) {
        verifications++;
        return validate({
          checks: [
            {
              issueId: "finding-1",
              resolved: true,
              preservedFacts: true,
              noUnsupportedAdditions: true,
              downstreamConsistent: true,
              evidence: [
                { sourceId: "scene:5", paragraph: 9 },
                { sourceId: "scene:5", paragraph: 15 },
              ],
              explanation: "都已改",
            },
          ],
        });
      }
      return validate(
        ++patches === 1
          ? { ...patch, replacements: patch.replacements.slice(0, 1) }
          : patch,
      );
    },
  });
  assert.deepEqual(
    { plans, patches, verifications },
    { plans: 2, patches: 2, verifications: 1 },
  );
  assert.equal(result.commits.length, 1);
  assert.equal(state.error, "");
  assert.equal(state.reviewWorkflow.failure, undefined);
});

test("有原文反证的错误审稿可驳回，保持正文不动", async () => {
  const state = { values: { "final-scene:4": scenes[0].content } };
  const dismissed = {
    decisions: [
      {
        issueId: "finding-1",
        decision: "dismiss",
        reason: "这是人物的猜测，原文并没有确认新事实",
        evidence: [{ sourceId: "scene:5", quote: rows[0] }],
        targets: [],
      },
    ],
  };
  const result = await reviewAndPatch({
    scenes,
    context,
    state,
    signal: new AbortController().signal,
    save: async () => {},
    ask: async (key, _messages, validate) => {
      if (key.includes(":review:")) return validate(faultyReview);
      if (key.includes(":grounding:")) return validate(dismissed);
      assert.fail("驳回后不生成补丁");
    },
  });
  assert.equal(result.commits.length, 0);
  assert.equal(result.scenes[0].content, scenes[0].content);
  assert.equal(result.review.issues.length, 0);
  assert.equal(state.reviewWorkflow.issues[0].status, "closed");
});
