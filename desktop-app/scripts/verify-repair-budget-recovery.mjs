// 在作品/任务副本重现预算故障并恢复依据核对；不修改正式作品。
// --live 仅调用任务原供应商的依据核对，进入补丁请求或作者等待后停止。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { ensureBudget, estimatedTokens } from "../runtime/model-budget.mjs";
import { stageInputLimit } from "../runtime/model-capabilities.mjs";

const out = resolve(
  process.argv.find((arg, i) => i > 1 && !arg.startsWith("--")) ||
    "verification/repair-budget-recovery",
);
const baseline = process.argv.includes("--baseline");
const live = process.argv.includes("--live");
const mode = baseline ? "baseline" : live ? "live" : "replay";
const dir = join(out, mode);
await mkdir(dir, { recursive: true });
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const write = async (name, value) =>
  writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
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
  assert.ok(config.apiKey, "缺少任务原供应商的本地密钥");
}
const checkpoint = new Checkpoint(dir);
await checkpoint.write(structuredClone(before));
const state = await checkpoint.begin(project, { resume: true }, config);
const records =
  !baseline && !live ? await read(join(out, "live", "requests.json")) : [];
const run = baseline
  ? (await import(pathToFileURL(join(out, "before/runtime/chapter-agent.mjs"))))
      .runChapterAgent
  : runChapterAgent;
const calls = [];
let nextRequest, error;
try {
  await run(
    project,
    config,
    AbortSignal.timeout(600000),
    () => {},
    checkpoint,
    state,
    async (url, init) => {
      const body = JSON.parse(init.body);
      const grounding =
        body.messages[0].content.includes("你是独立修订依据核对员");
      const record = {
        messages: body.messages,
        output: body.max_tokens ?? body.max_completion_tokens,
        stage: state.stage,
      };
      ensureBudget(body.messages, record.output, state.tokenBudget);
      record.inputEstimate = estimatedTokens(body.messages, state.tokenBudget);
      if (!grounding) {
        nextRequest = record;
        await write("next-request.json", record);
        throw Object.assign(Error("隔离验证已通过依据核对并组装下一阶段请求"), {
          code: "VERIFICATION_COMPLETE",
        });
      }
      assert.ok(calls.length < 8, "依据核对验证达到八次调用限制");
      if (
        !body.messages.some((m) =>
          m.content.includes("修复格式、编号或越界引用"),
        )
      ) {
        // 纠错会带入上次响应，最终仍通过输入硬上限校验。
        record.stageLimit = stageInputLimit(
          state.tokenBudget,
          record.output,
          "grounding",
        );
      }
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
      if (live) {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.any([init.signal, AbortSignal.timeout(120000)]),
        });
        record.response = await response.clone().json();
        record.status = response.status;
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
      const saved = records[calls.length - 1];
      assert.deepEqual(
        body.messages,
        saved?.messages,
        "重放请求必须与真实调用完全相同",
      );
      record.response = saved.response;
      await write("requests.json", calls);
      return new Response(JSON.stringify(saved.response), {
        status: saved.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
} catch (caught) {
  error = { name: caught.name, code: caught.code, message: caught.message };
}
assert.deepEqual(project, await read(join(out, "project.before.json")));
assert.deepEqual(
  state.reviewWorkflow.constraints,
  before.reviewWorkflow.constraints,
);
assert.deepEqual(state.paragraphReview.commits, before.paragraphReview.commits);
for (const [key, value] of Object.entries(before.values).filter(([key]) =>
  key.startsWith("final-scene:"),
))
  assert.equal(state.values[key], value);
const report = {
  mode,
  status: state.status,
  calls: calls.length,
  error,
  nextStage: nextRequest?.stage,
  authorConstraints: state.reviewWorkflow.constraints.length,
  sourceScenesPreserved: true,
  noPatchCommitted: true,
  savedGroundingPlan: !!state.paragraphReview.cycle.repairPlan,
  scope:
    "截图任务副本恢复依据核对，至作者等待或下一阶段模型请求；未验证整章完成。",
};
await write("report.json", report);
if (baseline) {
  assert.match(error?.message, /本组问题的必要原文超过/);
  assert.equal(calls.length, 0);
} else {
  assert.ok(
    state.status === "awaiting_input" ||
      (nextRequest &&
        error?.message === "隔离验证已通过依据核对并组装下一阶段请求"),
    JSON.stringify(report),
  );
  assert.ok(calls.length > 0);
  if (nextRequest) assert.match(nextRequest.stage, /补丁/);
}
console.log(JSON.stringify(report, null, 2));
