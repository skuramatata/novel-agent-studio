import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveReviewProblems,
  pauseForAuthor,
  submitReviewDecision,
} from "../runtime/review-resolution.mjs";
import {
  reviewDocument,
  validateFindings,
  applyParagraphPatch,
} from "../runtime/paragraph-review.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { blankProject } from "../runtime/seed.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const scenes = [
  { scene: 1, content: "当晚有橹声。\n\n那晚只有风，没有橹声。" },
];
const doc = reviewDocument(scenes, {}),
  ref = (n) => ({ sourceId: "scene:1", paragraph: n });
const problems = validateFindings(
  {
    issues: [
      {
        kind: "contradiction",
        target: ref(2),
        evidence: [ref(1), ref(2)],
        explanation: "同夜声音冲突",
        resolution: "needs_confirmation",
        fix: "统一叙述",
      },
    ],
  },
  doc,
).issues;
const state = () => ({
  id: "task",
  status: "running",
  values: {},
  paragraphReview: {},
});
const save = async () => {};
test("多问题逐题作答，已答即存档，全部答完前保持等待", async () => {
  const s = state(),
    two = [...problems, { ...problems[0], id: "second" }];
  await assert.rejects(() => pauseForAuthor(two, doc, s, save, "逐题确认"));
  const base = { taskId: s.id, pendingId: s.pendingReview.id };
  const first = { issueId: two[0].id, optionId: "evidence-1" };
  assert.equal(submitReviewDecision(s, { ...base, choices: [first] }), false);
  assert.deepEqual(
    s.reviewConversation.map((m) => m.role),
    ["assistant", "user", "assistant"],
  );
  assert.match(s.reviewConversation[2].text, /2\/2/);
  assert.equal(submitReviewDecision(s, { ...base, choices: [first] }), false);
  assert.equal(s.reviewConversation.length, 3);
  assert.equal(
    submitReviewDecision(s, {
      ...base,
      choices: [
        {
          issueId: "second",
          optionId: "custom",
          instruction: "删除无依据说法",
        },
      ],
    }),
    true,
  );
  assert.equal(s.reviewDecisions[base.pendingId].choices.length, 2);
  assert.equal(s.reviewConversation.at(-1).text, "删除无依据说法");
});
test("模型说需确认后先独立裁决，能保留证据时自动修复", async () => {
  const s = state();
  let called = 0;
  const result = await resolveReviewProblems({
    problems,
    doc,
    state: s,
    save,
    round: 0,
    ask: async (k, m, validate) => {
      called++;
      return validate({
        decisions: [
          {
            issueId: problems[0].id,
            action: "preserve_evidence",
            evidenceIndexes: [1],
            reason: "首次正面描写和后文一致",
          },
        ],
      });
    },
  });
  assert.equal(called, 1);
  assert.equal(result[0].preserve[0].quote, "当晚有橹声。");
  assert.equal(result[0].resolution, "preserve_evidence");
  assert.equal(s.pendingReview, undefined);
});
test("无法裁决暂停为待处理，提交作者选择后恢复原问题并允许相关段落修订", async () => {
  const s = state();
  await assert.rejects(
    () => pauseForAuthor(problems, doc, s, save, "需要选择"),
    { name: "WaitingForAuthor" },
  );
  assert.equal(s.status, "awaiting_input");
  const pendingId = s.pendingReview.id;
  assert.throws(
    () => submitReviewDecision(s, { taskId: "wrong", pendingId, choices: [] }),
    /过期|small/i,
  );
  submitReviewDecision(s, {
    taskId: s.id,
    pendingId,
    choices: [{ issueId: problems[0].id, optionId: "evidence-2" }],
  });
  const result = await resolveReviewProblems({
    problems,
    doc,
    state: s,
    save,
    round: 2,
    ask: () => {
      throw Error("作者选择后不应重复裁决");
    },
  });
  assert.equal(result[0].preserve[0].quote, "那晚只有风，没有橹声。");
  assert.ok(result[0].authorInstruction);
  assert.equal(s.pendingReview, undefined);
  const patched = applyParagraphPatch(scenes, doc, result, {
    baseVersion: doc.version,
    replacements: [
      {
        sourceId: "scene:1",
        paragraph: 1,
        issueIds: [result[0].id],
        replacement: "当晚只有风。",
      },
    ],
  });
  assert.equal(
    patched.scenes[0].content,
    "当晚只有风。\n\n那晚只有风，没有橹声。",
  );
  const again = await resolveReviewProblems({
    problems,
    doc,
    state: s,
    save,
    round: 2,
    ask: () => {
      throw Error("不应重问");
    },
  });
  assert.deepEqual(again, result);
  assert.equal(s.authorReviewHistory.length, 1);
});
test("自定义需非空说明、过期和重复选项不得提交", async () => {
  const s = state();
  await assert.rejects(() => pauseForAuthor(problems, doc, s, save, "选择"));
  const base = { taskId: s.id, pendingId: s.pendingReview.id };
  assert.throws(
    () =>
      submitReviewDecision(s, {
        ...base,
        choices: [{ issueId: problems[0].id, optionId: "custom" }],
      }),
    /说明/,
  );
  assert.throws(
    () =>
      submitReviewDecision(s, {
        ...base,
        pendingId: "old",
        choices: [
          {
            issueId: problems[0].id,
            optionId: "custom",
            instruction: "保留橹声",
          },
        ],
      }),
    /过期/,
  );
  assert.throws(
    () =>
      submitReviewDecision(s, {
        ...base,
        choices: [
          { issueId: "unknown", optionId: "custom", instruction: "保留橹声" },
        ],
      }),
    /无效/,
  );
  assert.equal(s.reviewDecisions, undefined);
});
test("待作者状态跨检查点保存，恢复必须先做选择；作品变化拒绝旧选择", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-author-decision-"));
  try {
    const cp = new Checkpoint(dir),
      p = blankProject(),
      config = { provider: "glm", model: "m", baseUrl: "u" };
    const s = await cp.begin(p, { instruction: "写作" }, config);
    await assert.rejects(() =>
      pauseForAuthor(problems, doc, s, () => cp.write(s), "选择"),
    );
    await assert.rejects(
      () => cp.begin(p, { resume: true }, config),
      /先在创作对话/,
    );
    const decision = {
      taskId: s.id,
      pendingId: s.pendingReview.id,
      choices: [{ issueId: problems[0].id, optionId: "evidence-1" }],
    };
    await assert.rejects(
      () =>
        cp.begin(
          { ...p, premise: { ...p.premise, title: "changed" } },
          { resume: true, decision },
          config,
        ),
      /作品或生成流程/,
    );
    const restored = await cp.begin(p, { resume: true, decision }, config);
    assert.equal(restored.status, "running");
    assert.ok(restored.reviewDecisions[decision.pendingId]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
