import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal } from "../runtime/schema.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import {
  reviewDocument,
  evidenceAt,
  validateFindings,
} from "../runtime/paragraph-review.mjs";
import {
  trackFindings,
  applyAuthorDecisions,
  rememberDecisions,
} from "../runtime/review-workflow.mjs";
import {
  prepareDraftAction,
  draftWorkspaceView,
  replaceDraftScope,
} from "../runtime/draft-actions.mjs";
import {
  revisionBudget,
  authorIntervenes,
  takeRevisionAttempt,
  draftVersion,
  draftScenes,
} from "../runtime/revision-session.mjs";
import {
  createStructuredAsker,
  blockedStructuredRecovery,
} from "../runtime/structured-step.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import { workflowContract } from "../runtime/workflow-skill.mjs";
import { z } from "zod";
import ts from "typescript";

test("相同正文的新一轮主动审查重新调用模型，同回合恢复才复用", async (t) => {
  const f = await fixture(t),
    m = model();
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await f.checkpoint.read();
    const state = await f.checkpoint.begin(
      f.p,
      {
        instruction: "继续自动修改",
        authorAction: action(before, "continue"),
      },
      config,
    );
    const result = await run(f, state, m.fetcher);
    assert.ok(result.proposal);
    assert.equal(state.values["final-scene:0"], original);
    assert.equal(m.calls.length, attempt + 1, "主动审查不能返回上一轮缓存");
    await run(f, state, m.fetcher);
    assert.equal(m.calls.length, attempt + 1, "同回合恢复不重复调用");
  }
});

test("继续自动修改携带所选问题时进入所选问题的补丁与复核链", async (t) => {
  const f = await fixture(t),
    m = model();
  const tracked = trackFindings(
    f.state,
    issuesFor(f.state),
    reviewDocument(draftScenes(f.state), {}).version,
  );
  await f.checkpoint.write(f.state);
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "",
      authorAction: action(f.state, "continue", {
        issueIds: [tracked[0].ledgerId],
      }),
    },
    config,
  );
  const result = await run(f, state, m.fetcher);
  assert.ok(result.proposal);
  assert.deepEqual(m.calls, ["grounding", "patch", "verification", "review"]);
  assert.equal(
    state.values["final-scene:0"],
    original.replace("她仍攥着毛毯。", changed),
  );
  assert.equal(
    state.authorDirections?.length || 0,
    0,
    "按钮标题不写入作者要求",
  );
});

test("要求不明的旧问题先提示补充，明确要求后可完成修订，失败前不消耗回合", async (t) => {
  const f = await fixture(t),
    m = model();
  const tracked = trackFindings(
    f.state,
    issuesFor(f.state),
    reviewDocument(draftScenes(f.state), {}).version,
  );
  const issue = f.state.reviewWorkflow.issues[0];
  issue.status = "awaiting_author";
  Object.assign(issue.latest, {
    authorRequested: true,
    grounding: { decision: "needs_confirmation" },
    repairTargets: [],
  });
  await f.checkpoint.write(f.state);
  const before = structuredClone(f.state);
  const request = action(f.state, "revise", {
    issueIds: [tracked[0].ledgerId],
  });
  assert.throws(
    () => prepareDraftAction(f.state, request, ""),
    /补充具体修改要求/,
  );
  assert.deepEqual(f.state, before);
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "毛毯已交出，把仍攥着毛毯改为空手动作，其他情节保持",
      authorAction: request,
    },
    config,
  );
  const result = await run(f, state, m.fetcher);
  assert.ok(result.proposal);
  assert.equal(
    state.values["final-scene:0"],
    original.replace("她仍攥着毛毯。", changed),
  );
  assert.ok(
    !state.reviewWorkflow.issues.some((i) => i.status === "awaiting_author"),
  );
});

test("草稿操作反馈区分正文不变、版本恢复、等待回答和失败", async () => {
  const source = await readFile(
    new URL("../src/lib/draft-feedback.ts", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const { draftFeedback, draftActionSucceeded } = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
  const task = {
    status: "completed",
    workspace: {
      canGuide: true,
      lastAction: { type: "continue", changed: false },
    },
  };
  assert.match(draftFeedback(task).text, /本次正文没有变化/);
  task.reviewProgress = {
    issues: [
      ...Array.from({ length: 25 }, () => ({ status: "open" })),
      ...Array.from({ length: 8 }, () => ({ status: "advisory" })),
    ],
  };
  task.status = "awaiting_instruction";
  assert.match(draftFeedback(task).text, /25 项待核对，8 项可选建议/);
  assert.match(draftFeedback(task).text, /当前没有待回答的情节选择/);
  assert.doesNotMatch(draftFeedback(task).text, /33/);
  task.workspace.lastAction = { type: "restore", changed: true };
  assert.match(draftFeedback(task).text, /已恢复所选版本/);
  task.status = "awaiting_input";
  assert.equal(draftFeedback(task).kind, "attention");
  task.status = "failed";
  task.error = "网络中断";
  assert.match(draftFeedback(task).text, /网络中断/);
  const operation = { taskId: "task", type: "revise" };
  for (const status of [
    "awaiting_input",
    "retryable",
    "failed",
    "interrupted",
    "awaiting_instruction",
  ])
    assert.equal(
      draftActionSucceeded({ id: "task", status }, operation),
      false,
    );
  assert.equal(
    draftActionSucceeded({ id: "task", status: "completed" }, operation),
    true,
  );
  assert.equal(
    draftActionSucceeded(
      { id: "task", status: "awaiting_instruction" },
      { ...operation, type: "restore" },
    ),
    true,
  );
});

test("重生成使整章字数越界时有限重试，保留原稿且不进入复核", async (t) => {
  const f = await fixture(t),
    m = model();
  f.state.wordTarget = { min: 300, max: 400 };
  await f.checkpoint.write(f.state);
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "重写第二段",
      authorAction: action(f.state, "regenerate", {
        scope: { kind: "paragraph", ...ref(2) },
      }),
    },
    config,
  );
  const result = await run(f, state, m.fetcher);
  assert.equal(result.draftOnly, true);
  assert.equal(state.revisionBudget.used, 2);
  assert.equal(state.values["final-scene:0"], original);
  assert.deepEqual(m.calls, ["author_revision", "author_revision"]);
  assert.ok(
    state.draftVersions.some(
      (v) => v.status === "rejected" && v.reason.includes("字数"),
    ),
  );
});
test("旧引用对应正文已变化时只作为历史记录，恢复原文后重新可核对", async () => {
  const { currentDraftIssueStatus } =
    await import("../runtime/revision-session.mjs");
  const s = plainState(),
    issue = { status: "open", latest: issuesFor(s)[0] };
  assert.equal(currentDraftIssueStatus(s, issue), "open");
  s.values["final-scene:0"] = original.replace("她仍攥着毛毯。", changed);
  assert.equal(currentDraftIssueStatus(s, issue), "stale");
  s.values["final-scene:0"] = original;
  assert.equal(currentDraftIssueStatus(s, issue), "open");
});

test("模型回填短裁定编号，保存结果恢复为原ID；未知短编号或相似UUID仍拒绝", async () => {
  const { authorIdProtocol } = await import("../runtime/review-author-ids.mjs");
  const longId = "d6897897-fa43-4f8f-a71f-daa1e81522f0:finding-5";
  const input = [
    { role: "system", content: "规则" },
    {
      role: "user",
      content: JSON.stringify({
        instruction: "原文保持不变",
        authorConstraints: [{ id: longId, instruction: "保留人物决定" }],
      }),
    },
  ];
  const codec = authorIdProtocol(input);
  assert.equal(
    JSON.parse(codec.messages[1].content).authorConstraints[0].id,
    "author-1",
  );
  assert.equal(JSON.parse(input[1].content).authorConstraints[0].id, longId);
  assert.equal(
    codec.decode({ authorChecks: [{ id: "author-1", respected: true }] })
      .authorChecks[0].id,
    longId,
  );
  assert.equal(
    codec.decode({ authorChecks: [{ id: "author-2", respected: true }] })
      .authorChecks[0].id,
    "author-2",
  );
  assert.equal(
    codec.decode({
      authorChecks: [{ id: longId.replace("a71f", "a71d"), respected: true }],
    }).authorChecks[0].id,
    longId.replace("a71f", "a71d"),
  );
  assert.equal(codec.diagnostic("只能填写" + longId), "只能填写author-1");
});

test("自然语言指导绑定当前草稿，重生成必须明确范围，中文段号定位准确", async () => {
  const source = await readFile(
    new URL("../src/lib/draft-command.ts", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const { draftCommand } = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
  const workspace = draftWorkspaceView(plainState());
  assert.deepEqual(draftCommand("继续改", workspace), { type: "continue" });
  assert.deepEqual(draftCommand("把第一场第二段写得克制一点", workspace), {
    type: "revise",
    scope: { kind: "paragraph", ...ref(2) },
  });
  assert.deepEqual(draftCommand("重新生成第二场", workspace), {
    type: "regenerate",
    scope: { kind: "scene", sourceId: "scene:2" },
  });
  assert.deepEqual(draftCommand("重写整章", workspace), {
    type: "regenerate",
    scope: { kind: "chapter" },
  });
  assert.deepEqual(draftCommand("改第4段", workspace), {
    type: "revise",
    scope: { kind: "paragraph", sourceId: "scene:2", paragraph: 1 },
  });
  assert.throws(() => draftCommand("重新生成", workspace), /说明重写哪/);
  assert.throws(() => draftCommand("重写第5场", workspace), /没有该场景/);
});

test("选定多个问题用同一批补丁统一解决，不能只修改其中一个", async (t) => {
  const f = await fixture(t);
  f.state.values["final-scene:0"] =
    "苏婉清把毛毯交给女生。\n\n她仍攥着毛毯。\n\n她又把毛毯搭在肩上。";
  const doc = reviewDocument(draftScenes(f.state), {});
  const base = issuesFor(f.state)[0];
  const issues = trackFindings(
    f.state,
    [
      base,
      {
        ...base,
        id: "finding-2",
        target: evidenceAt(doc, ref(3)),
        evidence: [evidenceAt(doc, ref(1)), evidenceAt(doc, ref(3))],
        explanation: "肩上又出现已交出的毛毯",
      },
    ],
    doc.version,
  );
  await f.checkpoint.write(f.state);
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "统一这两处持物动作，以交出毛毯为准",
      authorAction: action(f.state, "revise", {
        issueIds: issues.map((i) => i.ledgerId),
      }),
    },
    config,
  );
  const normal = model();
  const result = await run(f, state, async (url, init) => {
    const b = JSON.parse(init.body),
      d = JSON.parse(b.messages[1].content);
    if (b.messages[0].content.includes("当前步骤：grounding。"))
      return response({
        decisions: d.issues.map((i, n) => ({
          issueId: i.id,
          decision: "repair",
          reason: "对应的持物动作与交出矛盾",
          evidence: [ref(1), ref(n + 2)],
          targets: [
            {
              sourceId: "scene:1",
              quote: n ? "她又把毛毯搭在肩上。" : "她仍攥着毛毯。",
              operation: "replace",
              fix: "改为空手动作",
            },
          ],
        })),
      });
    if (b.messages[0].content.includes("当前步骤：patch。")) {
      assert.equal(d.issues.length, 2);
      return response({
        replacements: d.issues.map((i, n) => ({
          ...ref(n + 2),
          issueIds: [i.id],
          replacement: n ? "她把手搭在肩上。" : changed,
        })),
      });
    }
    return normal.fetcher(url, init);
  });
  assert.ok(result.proposal, state.error);
  assert.equal(state.revisionBudget.used, 1);
  assert.equal(state.paragraphReview.commits[0].patch.replacements.length, 2);
  assert.ok(!state.values["final-scene:0"].includes("她仍攥着毛毯"));
});

test("作者每个有效回答都会重置次数，重复提交已回答问题不再重置", async (t) => {
  const f = await fixture(t);
  const { pauseForAuthor } = await import("../runtime/review-resolution.mjs");
  const s = f.state,
    doc = reviewDocument(draftScenes(s), {});
  const findings = trackFindings(s, issuesFor(s), doc.version);
  s.paragraphReview = {
    round: 0,
    commits: [],
    cycle: { documentVersion: doc.version },
  };
  await assert.rejects(
    pauseForAuthor(findings, doc, s, () => f.checkpoint.write(s), "请选择"),
    { name: "WaitingForAuthor" },
  );
  takeRevisionAttempt(s, "a");
  takeRevisionAttempt(s, "b");
  await f.checkpoint.write(s);
  const req = {
    resume: true,
    instruction: "以交出为准",
    authorInterventionId: "answer-1",
    decision: {
      taskId: s.id,
      pendingId: s.pendingReview.id,
      choices: [{ issueId: findings[0].id, optionId: "evidence-1" }],
    },
  };
  const answered = await f.checkpoint.begin(f.p, req, config);
  assert.equal(answered.revisionBudget.used, 0);
  assert.equal(answered.revisionBudget.epoch, 1);
  takeRevisionAttempt(answered, "after-answer");
  await f.checkpoint.write(answered);
  const replay = await f.checkpoint.begin(f.p, req, config);
  assert.equal(replay.decisionReplay, true);
  assert.equal(replay.revisionBudget.used, 1);
});

const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "test-only",
};
const original = "苏婉清把毛毯交给女生。\n\n她仍攥着毛毯。\n\n远处传来海浪声。";
const changed = "她把空手拢进袖子。";
const ref = (paragraph) => ({ sourceId: "scene:1", paragraph });
const plainState = () => ({
  id: "task",
  status: "awaiting_instruction",
  values: { "final-scene:0": original, "final-scene:1": "无人离开营地。" },
  fragments: {},
  request: { instruction: "继续故事" },
});
const action = (state, type, extra = {}) => ({
  id: crypto.randomUUID(),
  taskId: state.id,
  draftVersion: draftVersion(state),
  type,
  ...extra,
});
const issuesFor = (state) =>
  validateFindings(
    {
      issues: [
        {
          kind: "contradiction",
          target: ref(2),
          evidence: [ref(1), ref(2)],
          explanation: "毛毯已交出却仍攥着",
          resolution: "preserve_evidence",
          preserve: [ref(1)],
          fix: "统一持物动作",
        },
      ],
    },
    reviewDocument(draftScenes(state), {}),
  ).issues;
const response = (value) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
      ],
      usage: { total_tokens: 10 },
    }),
  );
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "author-draft-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const p = applyProposal(blankProject(), demoProposal(), 0);
  const checkpoint = new Checkpoint(directory);
  const state = await checkpoint.begin(
    p,
    { instruction: "起草第一章", chapterId: p.chapters[0].id, words: 100 },
    config,
  );
  state.chapterId = p.chapters[0].id;
  state.values = plainState().values;
  state.wordTarget = { min: 0, max: 1000 };
  state.reviewContext = { instruction: "继续故事", chapter: p.chapters[0] };
  state.status = "awaiting_instruction";
  await checkpoint.write(state);
  return { p, state, checkpoint };
}
function model({
  reject = false,
  outside = false,
  regenerate = false,
  issueAfter = false,
} = {}) {
  const calls = [];
  const fetcher = async (_url, init) => {
    const b = JSON.parse(init.body);
    const phase = b.messages[0].content.match(/当前步骤：([^。]+)。/)[1];
    const d = JSON.parse(b.messages[1].content);
    calls.push(phase);
    const authorChecks = (d.authorConstraints || []).map((c) => ({
      id: c.id,
      respected: true,
      evidence: [ref(1)],
    }));
    if (phase === "grounding")
      return response({
        decisions: d.issues.map((i) => ({
          issueId: i.id,
          decision: "repair",
          reason: "保留已交出的事实，统一空手动作",
          evidence: [ref(1), ref(2)],
          targets: [
            {
              sourceId: "scene:1",
              quote: outside ? "苏婉清把毛毯交给女生。" : "她仍攥着毛毯。",
              operation: "replace",
              fix: "统一持物动作",
            },
          ],
        })),
      });
    if (phase === "patch")
      return response({
        replacements: [
          {
            ...ref(2),
            issueIds: d.issues.map((i) => i.id),
            replacement: changed,
          },
        ],
      });
    if (phase === "author_revision") return response({ text: changed });
    if (phase === "verification" || phase === "author_verification")
      return response({
        checks: d.issues.map((i) => ({
          issueId: i.id,
          resolved: !reject,
          preservedFacts: true,
          noUnsupportedAdditions: true,
          downstreamConsistent: !reject,
          evidence: [ref(2)],
          explanation: reject ? "后文仍有矛盾" : "前后已统一",
        })),
        authorChecks,
      });
    if (phase === "review")
      return response({
        issues: issueAfter
          ? [
              {
                kind: "missing_history",
                target: { sourceId: "scene:2", paragraph: 1 },
                evidence: [{ sourceId: "scene:2", paragraph: 1 }],
                explanation: "营地记录仍需作者检查",
                resolution: "remove_unsupported",
                fix: "检查记录",
              },
            ]
          : [],
        authorChecks,
      });
    throw Error("意外阶段 " + phase);
  };
  return { fetcher, calls };
}
const run = (f, state, fetcher) =>
  runChapterAgent(
    f.p,
    config,
    new AbortController().signal,
    () => {},
    f.checkpoint,
    state,
    fetcher,
  );

test("额度限制连续自主修订，失败也计数，自动恢复与相同作者操作重发都不续杯", () => {
  let s = plainState();
  takeRevisionAttempt(s, "a");
  takeRevisionAttempt(s, "a");
  takeRevisionAttempt(s, "b");
  assert.equal(revisionBudget(s).used, 2);
  s = JSON.parse(JSON.stringify(s));
  assert.throws(() => takeRevisionAttempt(s, "c"), /已自动尝试修订 2 轮/);
  assert.equal(authorIntervenes(s, "author-1", "继续改"), true);
  assert.equal(revisionBudget(s).used, 0);
  takeRevisionAttempt(s, "c");
  assert.equal(authorIntervenes(s, "author-1", "继续改"), false);
  assert.equal(revisionBudget(s).used, 1);
});

test("手动编辑指定段落保留其余字节，恢复原版本可逆；过期操作被拒绝", () => {
  const s = plainState(),
    before = draftVersion(s);
  takeRevisionAttempt(s, "a");
  takeRevisionAttempt(s, "b");
  const req = action(s, "edit", {
    scope: { kind: "paragraph", ...ref(2) },
    text: changed,
  });
  prepareDraftAction(s, req, "修改持物动作");
  assert.equal(
    s.values["final-scene:0"],
    original.replace("她仍攥着毛毯。", changed),
  );
  assert.equal(s.values["final-scene:1"], "无人离开营地。");
  assert.equal(s.revisionBudget.used, 0);
  const clone = JSON.parse(JSON.stringify(s));
  prepareDraftAction(clone, req, "修改持物动作");
  assert.equal(clone.authorReplay, true);
  assert.equal(clone.revisionBudget.epoch, 1);
  assert.throws(
    () => prepareDraftAction(s, { ...req, id: "stale" }, "修改持物动作"),
    /草稿已变化/,
  );
  prepareDraftAction(
    s,
    action(s, "restore", { versionId: s.draftVersions[0].id }),
    "恢复原稿",
  );
  assert.equal(draftVersion(s), before);
  assert.equal(s.revisionBudget.epoch, 2);
  assert.equal(s.draftVersions.length, 2);
  assert.equal(s.reviewConversation.filter((m) => m.role === "user").length, 2);
});

test("作者保留只约束所选问题，不放行同段其他发现，并保留旧裁定", () => {
  const s = plainState(),
    doc = reviewDocument(draftScenes(s), {});
  const tracked = trackFindings(s, issuesFor(s), doc.version);
  rememberDecisions(s, "old", [
    { ...tracked[0], id: "old", authorInstruction: "保留交出毛毯的事实" },
  ]);
  prepareDraftAction(
    s,
    action(s, "keep", { issueIds: [tracked[0].ledgerId] }),
    "保留此处原文",
  );
  const found = applyAuthorDecisions(s, issuesFor(s), doc);
  assert.equal(found[0].authorRetained, true);
  const unrelated = {
    ...issuesFor(s)[0],
    kind: "unsupported_inference",
    evidence: [evidenceAt(doc, ref(3))],
  };
  assert.equal(
    applyAuthorDecisions(s, [unrelated], doc)[0].authorRetained,
    undefined,
  );
  assert.equal(s.reviewWorkflow.constraints.length, 2);
});

test("失败结构化步骤自动恢复零请求，作者继续开启新步骤且保留旧失败响应", async () => {
  const s = plainState(),
    budget = createBudgetProfile(),
    contract = workflowContract(
      "task_intent",
      z.object({ value: z.boolean() }),
    );
  let calls = 0;
  const ask = createStructuredAsker({
    state: s,
    budget,
    save: async () => {},
    call: async () => ({ text: JSON.stringify({ value: ++calls > 2 }) }),
  });
  const go = () =>
    ask(
      "author-budget",
      [
        { role: "system", content: "只输出JSON" },
        { role: "user", content: "同一输入" },
      ],
      (v) => {
        if (!v.value) throw Error("无效");
        return v;
      },
      4000,
      "测试",
      { contract },
    );
  await assert.rejects(go, /纠错预算已用尽/);
  assert.ok(blockedStructuredRecovery(s));
  await assert.rejects(go, /纠错预算已用尽/);
  assert.equal(calls, 2);
  authorIntervenes(s, "continue-1", "继续");
  assert.equal(blockedStructuredRecovery(s), null);
  await go();
  assert.equal(calls, 3);
  assert.equal(
    Object.values(s.structuredSteps).filter((x) => x.status === "exhausted")
      .length,
    1,
  );
  authorIntervenes(s, "continue-2", "再继续");
  await go();
  assert.equal(calls, 3, "成功输入跨作者回合可复用");
});

test("作者指令经过范围核对、补丁、独立复核与全章只读复审后交付，范围外不变", async (t) => {
  const f = await fixture(t),
    m = model();
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "改第1场第2段，毛毯交出后只能空手",
      authorAction: action(f.state, "revise", {
        scope: { kind: "paragraph", ...ref(2) },
      }),
    },
    config,
  );
  const result = await run(f, state, m.fetcher);
  assert.ok(result.proposal, state.error);
  assert.deepEqual(m.calls, ["grounding", "patch", "verification", "review"]);
  assert.equal(state.revisionBudget.used, 1);
  assert.equal(
    state.values["final-scene:0"],
    original.replace("她仍攥着毛毯。", changed),
  );
  assert.equal(state.values["final-scene:1"], "无人离开营地。");
  assert.equal(f.p.chapters[0].content, "", "正式作品未被写入");
  assert.equal(
    applyProposal(f.p, result.proposal, f.p.revision).chapters[0].content,
    draftScenes(state)
      .map((s) => s.content)
      .join("\n\n"),
  );
});

test("局部重生成先复核再保存，后续发现范围外问题只留下记录不扩大修改", async (t) => {
  const f = await fixture(t),
    m = model({ regenerate: true, issueAfter: true });
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "重新生成第1场第2段",
      authorAction: action(f.state, "regenerate", {
        scope: { kind: "paragraph", ...ref(2) },
      }),
    },
    config,
  );
  const result = await run(f, state, m.fetcher);
  assert.equal(result.draftOnly, true);
  assert.equal(state.status, "awaiting_instruction");
  assert.deepEqual(m.calls, [
    "author_revision",
    "author_verification",
    "review",
  ]);
  assert.equal(
    state.values["final-scene:0"],
    original.replace("她仍攥着毛毯。", changed),
  );
  assert.equal(state.values["final-scene:1"], "无人离开营地。");
  assert.match(state.error, /调整修改范围/);
});

test("两轮失败不覆盖草稿，失败候选可读；作者主动继续重置后可成功", async (t) => {
  const f = await fixture(t),
    m = model({ reject: true });
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "重新生成第1场第2段",
      authorAction: action(f.state, "regenerate", {
        scope: { kind: "paragraph", ...ref(2) },
      }),
    },
    config,
  );
  const result = await run(f, state, m.fetcher);
  assert.equal(result.draftOnly, true);
  assert.equal(state.status, "awaiting_instruction");
  assert.equal(state.revisionBudget.used, 2);
  assert.equal(state.values["final-scene:0"], original);
  assert.ok(
    draftWorkspaceView(state).versions.some(
      (v) => v.status === "rejected" && v.text.includes(changed),
    ),
  );
  const automatic = await f.checkpoint.begin(f.p, { resume: true }, config);
  const forbidden = () => {
    throw Error("已耗尽不能再请求模型");
  };
  const again = await run(f, automatic, forbidden);
  assert.equal(again.draftOnly, true);
  assert.equal(automatic.revisionBudget.used, 2);
  const continued = await f.checkpoint.begin(
    f.p,
    {
      instruction: "继续改",
      resume: true,
      authorInterventionId: "author-resume",
    },
    config,
  );
  assert.equal(continued.revisionBudget.used, 0);
  const success = await run(f, continued, model().fetcher);
  assert.ok(success.proposal, continued.error);
  assert.equal(continued.revisionBudget.used, 1);
});

test("越界修订计划拒绝落盘，旧稿仍可由作者交付且不宣称审稿通过", async (t) => {
  const f = await fixture(t),
    m = model({ outside: true });
  const state = await f.checkpoint.begin(
    f.p,
    {
      instruction: "只修改第2段",
      authorAction: action(f.state, "revise", {
        scope: { kind: "paragraph", ...ref(2) },
      }),
    },
    config,
  );
  assert.equal((await run(f, state, m.fetcher)).draftOnly, true);
  assert.match(state.error, /超出作者选定/);
  assert.equal(state.values["final-scene:0"], original);
  assert.ok(!m.calls.includes("patch"));
  const deliver = await f.checkpoint.begin(
    f.p,
    { instruction: "交付当前稿", authorAction: action(state, "deliver") },
    config,
  );
  const result = await run(f, deliver, () => {
    throw Error("交付不应请求模型");
  });
  assert.match(result.proposal.summary, /自动检查尚未全部完成/);
  assert.equal(
    result.proposal.chapters[0].content,
    original + "\n\n无人离开营地。",
  );
});

test("作者手动编辑、保留、恢复版本都不调用模型；操作与旧作者回答会留存", async (t) => {
  const f = await fixture(t);
  const tracked = trackFindings(f.state, issuesFor(f.state), "doc");
  await f.checkpoint.write(f.state);
  for (const [type, extra] of [
    ["keep", { issueIds: [tracked[0].ledgerId] }],
    [
      "edit",
      { scope: { kind: "scene", sourceId: "scene:2" }, text: "无人走出营地。" },
    ],
    ["restore", { versionId: null }],
  ]) {
    const current = await f.checkpoint.read();
    if (type === "restore") extra.versionId = current.draftVersions[0].id;
    const state = await f.checkpoint.begin(
      f.p,
      { instruction: type, authorAction: action(current, type, extra) },
      config,
    );
    const result = await run(f, state, () => {
      throw Error("作者直接操作不应请求模型");
    });
    assert.equal(result.draftOnly, true);
    assert.equal(state.status, "awaiting_instruction");
    assert.equal(state.revisionBudget.used, 0);
  }
  const final = await f.checkpoint.read();
  assert.equal(final.revisionBudget.epoch, 3);
  assert.equal(final.reviewWorkflow.constraints.length, 1);
});
