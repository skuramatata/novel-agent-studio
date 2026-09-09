// 在 verification 的作品/任务副本恢复截图故障；默认重放已保存的原始响应。
// --live 使用任务原供应商；只运行依据核对，到作者等待或补丁入口结束。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { parseStructured } from "../runtime/structured.mjs";

const out = resolve("verification/repair-anchor-recovery");
const live = process.argv.includes("--live");
const baseline = process.argv.includes("--baseline");
const dir = join(out, baseline ? "baseline" : live ? "live" : "replay");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const write = async (name, value) =>
  writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
await mkdir(dir, { recursive: true });
const before = await read(join(out, "chapter-task.before.json"));
const project = await read(join(out, "project.before.json"));
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
const checkpoint = new Checkpoint(dir);
await checkpoint.write(structuredClone(before));
const state = await checkpoint.begin(project, { resume: true }, config);
const responses = new Map();
for (const text of Object.values(before.fragments)) {
  let value;
  try {
    value = parseStructured(text);
  } catch {
    continue;
  }
  if (!value.decisions?.length || !value.decisions.every((d) => d.decision))
    continue;
  responses.set(
    value.decisions
      .map((d) => d.issueId)
      .sort()
      .join(","),
    text,
  );
}
const run = baseline
  ? (await import(pathToFileURL(join(out, "before/runtime/chapter-agent.mjs"))))
      .runChapterAgent
  : runChapterAgent;
const calls = [];
let error;
const sentinel = "隔离验证已通过修订依据核对，停在补丁生成入口";
try {
  await run(
    project,
    config,
    AbortSignal.timeout(240000),
    () => {},
    checkpoint,
    state,
    async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.messages[0].content.includes("你是独立修订依据核对员"))
        throw Object.assign(Error(sentinel), { code: "VERIFICATION_COMPLETE" });
      if (calls.length >= 6) throw Error("依据核对验证达到六次请求限制");
      const group = JSON.parse(body.messages[1].content)
        .issues.map((i) => i.id)
        .sort()
        .join(",");
      const record = {
        stage: state.stage,
        messages: body.messages,
        output: body.max_tokens ?? body.max_completion_tokens,
      };
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
          signal: AbortSignal.any([init.signal, AbortSignal.timeout(90000)]),
        });
        record.response = await response.clone().json();
        await write("requests.json", calls);
        console.log(
          JSON.stringify({
            call: calls.length,
            http: response.status,
            finishReason: record.response.choices?.[0]?.finish_reason,
          }),
        );
        return response;
      }
      assert.ok(responses.has(group), `缺少问题组原始响应：${group}`);
      record.response = {
        choices: [
          { message: { content: responses.get(group) }, finish_reason: "stop" },
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
} catch (e) {
  error = { name: e.name, code: e.code, message: e.message };
}
assert.deepEqual(project, await read(join(out, "project.before.json")));
assert.deepEqual(state.paragraphReview.commits, before.paragraphReview.commits);
assert.deepEqual(
  state.reviewWorkflow.constraints,
  before.reviewWorkflow.constraints,
);
for (const [key, value] of Object.entries(before.values).filter(([k]) =>
  k.startsWith("final-scene:"),
))
  assert.equal(state.values[key], value);
if (baseline) {
  assert.equal(state.status, "retryable");
  assert.match(state.error, /需要处理的问题必须明确实际出错的原文片段/);
} else {
  assert.ok(
    state.status === "awaiting_input" || error?.message === sentinel,
    JSON.stringify(error),
  );
  if (state.status === "awaiting_input") {
    assert.equal(state.error, "");
    assert.ok(state.pendingReview.issues.length > 0);
    assert.equal(state.paragraphReview.cycle.repairPlan, undefined);
    assert.equal(state.paragraphReview.cycle.patch, undefined);
  }
}
const report = {
  passed: true,
  mode: baseline ? "修复前重现" : live ? "原供应商实测" : "真实响应重放",
  status: state.status,
  calls: calls.length,
  model: config.model,
  pendingIssues: state.pendingReview?.issues.map((i) => i.id) || [],
  allSavedScenesPreserved: true,
  authorConstraintsPreserved: true,
  noPatchCommitted: true,
  scope:
    "保存的第二章任务副本，从依据核对恢复到作者等待或补丁入口；未采纳或改写正式作品",
  error,
};
await write("report.json", report);
console.log(JSON.stringify(report, null, 2));
