// 从截图任务的归档副本恢复至完整候选或真实作者等待；正式任务保持隔离。
// --live 使用原供应商；默认逐字匹配并重放 live/requests.json。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { ensureBudget } from "../runtime/model-budget.mjs";

const out = resolve(
  process.argv.find((arg, i) => i > 1 && !arg.startsWith("--")) ||
    "verification/author-check-review-recovery",
);
const live = process.argv.includes("--live"),
  probe = process.argv.includes("--probe");
const mode = probe ? "probe" : live ? "live" : "replay";
const dir = join(out, mode);
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const write = (name, value) =>
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
  config.apiKey = (await readAuthorizedEnv())[config.provider]?.apiKey;
  assert.ok(config.apiKey, "缺少原供应商本地密钥");
}
const checkpoint = new Checkpoint(dir);
if (!process.argv.includes("--continue"))
  await checkpoint.write(structuredClone(before));
const state = await checkpoint.begin(project, { resume: true }, config);
const calls = process.argv.includes("--continue")
  ? await read(join(dir, "requests.json"))
  : [];
const saved =
  !live && !probe ? await read(join(out, "live/requests.json")) : [];
let error, result;
try {
  result = await runChapterAgent(
    project,
    config,
    AbortSignal.timeout(60 * 60 * 1000),
    () => {},
    checkpoint,
    state,
    async (url, init) => {
      const body = JSON.parse(init.body);
      const output = body.max_tokens ?? body.max_completion_tokens;
      const record = {
        stage: state.stage,
        messages: body.messages,
        output,
        inputEstimate: ensureBudget(body.messages, output, state.tokenBudget),
      };
      calls.push(record);
      await write("requests.json", calls);
      console.log(
        JSON.stringify({
          call: calls.length,
          stage: state.stage,
          inputEstimate: record.inputEstimate,
          mode,
        }),
      );
      if (probe) throw Error("请求已捕获");
      if (live) {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.any([init.signal, AbortSignal.timeout(180000)]),
        });
        record.status = response.status;
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
      const original = saved[calls.length - 1];
      assert.deepEqual(
        record.messages,
        original?.messages,
        "重放请求与真实请求不一致",
      );
      record.status = original.status;
      record.response = original.response;
      return new Response(JSON.stringify(record.response), {
        status: record.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
} catch (caught) {
  error = { name: caught.name, message: caught.message };
}
const oldStep = before.structuredSteps[before.structuredFailure.stepId];
assert.deepEqual(
  state.structuredSteps[oldStep.id],
  oldStep,
  "原失败尝试和预算不应被抹掉",
);
assert.deepEqual(
  state.reviewWorkflow.constraints,
  before.reviewWorkflow.constraints,
  "裁定历史不能被删除或改写",
);
assert.deepEqual(project, await read(join(out, "project.before.json")));
assert.deepEqual(
  state.paragraphReview.commits.slice(0, before.paragraphReview.commits.length),
  before.paragraphReview.commits,
);
const report = {
  mode,
  status: state.status,
  calls: calls.length,
  error,
  authorConstraints: state.reviewWorkflow.constraints.length,
  oldFailurePreserved: true,
  commitsBefore: before.paragraphReview.commits.length,
  commitsAfter: state.paragraphReview.commits.length,
  pendingQuestions: state.pendingReview?.issues.length || 0,
  reviewCoverage: Object.values(state.reviewCoverage).slice(-2),
  completed: state.status === "ready" && !!result?.proposal,
};
await write("report.json", report);
if (result) await write("result.json", result);
console.log(JSON.stringify(report, null, 2));
if (!probe)
  assert.ok(
    report.completed || state.status === "awaiting_input",
    JSON.stringify(error),
  );
