// 基于保留的第三章故障快照和真实审稿响应，只验证其中一个问题组。
// --live 调用原供应商；原作品只读，不回答作者问题、不采纳作品。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { contextFor, digest } from "../runtime/memory.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import {
  reviewDocument,
  reviewAndPatch,
  validateFindings,
  REVIEW_VERSION,
} from "../runtime/paragraph-review.mjs";
import { retryReview, trackFindings } from "../runtime/review-workflow.mjs";
import { createStructuredAsker } from "../runtime/structured-step.mjs";
import { complete, readAuthorizedEnv } from "../runtime/providers.mjs";
import { WORKFLOW_SKILL } from "../runtime/workflow-skill.mjs";

const out = resolve("verification/workflow-skill");
const source = resolve("verification/review-protocol");
const read = async (name) => JSON.parse(await readFile(name, "utf8"));
const write = async (name, value) =>
  writeFile(join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
await mkdir(out, { recursive: true });
const before = await read(join(source, "chapter-task.before.json"));
const project = await read(join(source, "project.before.json"));
const original = digest(project);
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
};
const profile = createBudgetProfile(config, before.tokenBudget);
const chapter = project.chapters.find((c) => c.id === before.chapterId);
const { context } = contextFor(
  project,
  chapter,
  before.request.instruction,
  project.memory.entries,
  { continuity: true, profile, retrieved: before.retrievedContext },
);
Object.assign(context, {
  continuitySources: before.continuityEvidence.sources,
  continuityCoverage: before.continuityEvidence.coverage,
  sceneTimes: before.values["scene-plan"].scenes.map((s, i) => ({
    scene: i + 1,
    ...s.time,
  })),
});
// 聚焦已存在的一项真实发现；不把局部测试声称为整章专项审稿。
delete context.continuity;
const scenes = before.paragraphReview.inputScenes;
const doc = reviewDocument(scenes, context);
assert.equal(doc.version, before.paragraphReview.cycle.documentVersion);
const oldLive = await read(join(source, "live-state.json"));
const response = Object.values(oldLive.values).find((v) => v.dimensions);
const finding = response.dimensions
  .flatMap((d) => d.issues || [])
  .find((i) => i.target.sourceId === "scene:2" && i.target.paragraph === 30);
assert.ok(finding, "需要保留的原模型发现，不能由验证脚本编造问题");
const issues = validateFindings({ issues: [finding] }, doc).issues;
const contextHash = digest([REVIEW_VERSION, context, 0, null]);
let state = {
  id: "isolated-workflow-skill",
  status: "running",
  values: Object.fromEntries(
    scenes.map((s, i) => [`final-scene:${i}`, s.content]),
  ),
  fragments: {},
  paragraphReview: {
    root: digest([contextHash, scenes]),
    contextHash,
    inputScenes: structuredClone(scenes),
    round: 0,
    commits: [],
    cycle: { documentVersion: doc.version, attempt: 0 },
  },
};
state.paragraphReview.cycle.review = {
  issues: trackFindings(state, issues, doc.version),
  authorChecks: [],
  priorFindings: [],
};
const requests = [];
let injected = false,
  resumedAt = 0;
const save = async () => write("live-state.json", state);
const stop = Object.assign(Error("已完成目标问题组，停在后续新问题处理入口"), {
  code: "SCOPE_COMPLETE",
});
const call = async (messages, tokens, label) => {
  const phase = messages[0].content.match(/当前步骤：(\w+)。/)?.[1];
  assert.ok(phase, "每个真实请求均须有技能和阶段契约");
  assert.equal(messages[0].content.match(/必需工作流技能/g).length, 1);
  if (state.paragraphReview.commits.length && phase !== "review") throw stop;
  if (phase === "verification" && !injected) {
    injected = true;
    throw Error("验证注入：收到已校验补丁后、复核请求前断网");
  }
  if (!process.argv.includes("--live"))
    throw Error("实际供应商验证需传 --live");
  if (requests.length >= 12) throw Error("验证范围最多12次真实调用");
  const row = { phase, label, messages, tokens };
  requests.push(row);
  await write("live-requests.json", requests);
  console.log(JSON.stringify({ call: requests.length, phase, label }));
  row.response = await complete(
    config,
    messages,
    AbortSignal.timeout(120000),
    fetch,
    tokens,
    { allowPartial: true },
  );
  await write("live-requests.json", requests);
  console.log(
    JSON.stringify({
      call: requests.length,
      finishReason: row.response.finishReason,
    }),
  );
  return row.response;
};
if (process.argv.includes("--live")) {
  config.apiKey = (await readAuthorizedEnv())[config.provider]?.apiKey;
  assert.ok(config.apiKey, "缺少已授权的原供应商密钥");
}
const run = () =>
  reviewAndPatch({
    scenes: scenes.map((s, i) => ({
      ...s,
      content: state.values[`final-scene:${i}`],
    })),
    context,
    state,
    save,
    profile,
    maxRounds: 1,
    signal: AbortSignal.timeout(600000),
    ask: createStructuredAsker({ state, budget: profile, call, save }),
  });
let error;
try {
  try {
    await run();
  } catch (e) {
    if (!e.message.includes("验证注入：")) throw e;
    assert.equal(state.paragraphReview.commits.length, 0);
    for (const [i, s] of scenes.entries())
      assert.equal(state.values[`final-scene:${i}`], s.content);
    state = await read(join(out, "live-state.json"));
    retryReview(state);
    resumedAt = requests.length;
    await run();
  }
} catch (e) {
  error = { name: e.name, message: e.message };
}
assert.equal(digest(project), original);
const commits = state.paragraphReview.commits;
const report = {
  scope:
    "第三章故障原文中 scene:2 第30段的一项真实发现：依据核对、补丁、独立复核和复审；不是整章验收",
  skill: WORKFLOW_SKILL,
  passed:
    commits.length === 1 &&
    injected &&
    requests[resumedAt]?.phase === "verification",
  requestedModel: config.model,
  calls: requests.length,
  phases: requests.map((r) => r.phase),
  failureRecoveryInjected: injected,
  firstResumedPhase: requests[resumedAt]?.phase,
  patchesAfterResume: requests
    .slice(resumedAt)
    .filter((r) => r.phase === "patch").length,
  patchVersionBoundByRuntime:
    commits.length > 0 &&
    commits.every((c) => c.patch.baseVersion === c.beforeVersion),
  modelOmittedPatchVersion: requests
    .filter((r) => r.phase === "patch")
    .every((r) => !r.response?.text.includes('"baseVersion"')),
  commits: commits.length,
  nextReviewIssues: state.paragraphReview.cycle?.review?.issues?.length,
  pendingAuthorQuestions: state.pendingReview?.issues.length || 0,
  projectUnchanged: true,
  error,
};
await write("live-report.json", report);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
