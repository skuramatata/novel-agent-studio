// 使用截图任务的隔离快照恢复到章节候选；不采纳，不写正式作品或任务。
// 默认重放最终原始核对响应中对应的问题；--live 使用原任务供应商。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { parseStructured } from "../runtime/structured.mjs";
import { reviewTaskState } from "../runtime/review-workflow.mjs";

const root = resolve("verification/author-decision-loop");
const live = process.argv.includes("--live");
const continuing = process.argv.includes("--continue");
const dir = join(root, live ? "live" : "replay");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
await mkdir(dir, { recursive: true });
const write = (name, value) =>
  writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const before = await read(join(root, "chapter-task.before.json"));
const after = await read(join(root, "chapter-task.after-user.json"));
const project = await read(join(root, "project.before.json"));
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
  apiKey: "isolated-replay-only",
};
if (live) {
  config.apiKey = (await readAuthorizedEnv())[before.provider]?.apiKey;
  assert.ok(config.apiKey, "未找到任务原供应商的已配置密钥");
}
const view = reviewTaskState(before);
assert.equal(view.review, null, "旧版重复问题应复用已有答案");
assert.equal(view.resumable, true);
const checkpoint = new Checkpoint(dir);
if (!continuing) await checkpoint.write(structuredClone(before));
const state = await checkpoint.begin(project, { resume: true }, config);
assert.equal(state.pendingReview, undefined);
const decisions = new Map();
for (const raw of Object.values(after.fragments)) {
  try {
    const result = parseStructured(raw);
    for (const decision of result.decisions || [])
      if (decision.decision) decisions.set(decision.issueId, decision);
  } catch {
    /* 非结构化正文无需重放。 */
  }
}
const calls = continuing ? await read(join(dir, "requests.json")) : [];
let result, failure;
try {
  result = await runChapterAgent(
    project,
    config,
    AbortSignal.timeout(900000),
    () => {},
    checkpoint,
    state,
    async (url, init) => {
      assert.ok(calls.length < 64, "隔离验收达到64次调用上限");
      const body = JSON.parse(init.body);
      const record = { stage: state.stage, messages: body.messages };
      calls.push(record);
      await write("requests.json", calls);
      console.log(
        JSON.stringify({
          call: calls.length,
          stage: state.stage,
          mode: live ? "live" : "replay",
        }),
      );
      if (live) {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.any([init.signal, AbortSignal.timeout(120000)]),
        });
        record.response = await response.clone().json();
        await write("requests.json", calls);
        console.log(
          JSON.stringify({ call: calls.length, http: response.status }),
        );
        return response;
      }
      assert.ok(
        body.messages[0].content.includes("独立修订依据核对员"),
        "重放只使用保存的最终核对响应，不能伪造其他阶段结果",
      );
      const issues = JSON.parse(body.messages[1].content).issues;
      assert.ok(issues.every((i) => decisions.has(i.id)));
      record.response = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                decisions: issues.map((i) => decisions.get(i.id)),
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 0 },
      };
      await write("requests.json", calls);
      return new Response(JSON.stringify(record.response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
} catch (error) {
  failure = { name: error.name, message: error.message };
}
await write("result.json", result || null);
const report = {
  passed: !failure && state.status === "ready" && !!result?.proposal,
  mode: live ? "原供应商实测" : "原始最终核对响应按本次问题组重放",
  status: state.status,
  phase: state.reviewWorkflow.phase,
  calls: calls.length,
  decisionsBefore: before.reviewWorkflow.constraints.length,
  decisionsAfter: state.reviewWorkflow.constraints.length,
  commitsBefore: before.paragraphReview.commits.length,
  commitsAfter: state.paragraphReview.commits.length,
  pendingQuestions: state.pendingReview?.issues.length || 0,
  projectUnchanged:
    JSON.stringify(project) ===
    JSON.stringify(await read(join(root, "project.before.json"))),
  scope: "从旧版重复待答恢复到正文与记忆候选；没有追加作者回答或调用采纳",
  failure,
};
await write("report.json", report);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.passed, true, failure?.message);
assert.equal(report.projectUnchanged, true);
assert.deepEqual(
  state.reviewWorkflow.constraints,
  before.reviewWorkflow.constraints,
);
assert.deepEqual(state.reviewDecisions, before.reviewDecisions);
assert.equal(state.pendingReview, undefined);
assert.ok(result.proposal.chapters && result.proposal.memory);
