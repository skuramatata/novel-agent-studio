// 隔离重现第六章当前审稿入口，保留草稿、已提交补丁和作者裁定；绝不改正式作品。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";

const out = resolve("verification/review-output-fix");
const live = join(out, "live");
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = (file, value) =>
  writeFile(join(live, file), JSON.stringify(value, null, 2), { mode: 0o600 });
const project = await read(join(out, "project.before.json"));
const original = JSON.stringify(project);
const before = await read(join(out, "task.before.json"));
const snapshot = structuredClone(before);
// 快照采集时用户已恢复到 grounding。只在副本中重审该轮，复现截图报错的 review 入口。
const version = before.paragraphReview.cycle.documentVersion;
before.paragraphReview.cycle = { documentVersion: version, attempt: 0 };
before.values = Object.fromEntries(
  Object.entries(before.values).filter(([key]) => !key.includes(version)),
);
before.reviewWorkflow.phase = "review";
before.status = "retryable";
before.error = "隔离验证：重现本轮审稿入口";
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
  apiKey: "offline-only",
};
if (process.argv.includes("--live")) {
  const env = await readAuthorizedEnv();
  config.apiKey = env[config.provider]?.apiKey;
  if (!config.apiKey) throw Error("未找到既有供应商密钥");
}
await mkdir(live, { recursive: true });
await write("task.before.json", before);
await write("project.before.json", project);
const checkpoint = new Checkpoint(live);
await checkpoint.write(before);
const state = await checkpoint.begin(project, { resume: true }, config);
const calls = [];
const start = Date.now();
let result, error;
try {
  result = await runChapterAgent(
    project,
    config,
    AbortSignal.timeout(600000),
    () => {},
    checkpoint,
    state,
    async (url, init) => {
      const body = JSON.parse(init.body);
      const record = {
        stage: state.stage,
        outputBudget: body.max_tokens,
        messages: body.messages,
      };
      calls.push(record);
      await write("requests.json", calls);
      console.log(
        JSON.stringify({
          call: calls.length,
          stage: state.stage,
          outputBudget: body.max_tokens,
        }),
      );
      if (!process.argv.includes("--live")) throw Error("离线请求已捕获");
      if (calls.length > 10) throw Error("隔离实测达到十次请求限制");
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([init.signal, AbortSignal.timeout(180000)]),
      });
      const data = await response.clone().json();
      record.response = data;
      await write("requests.json", calls);
      console.log(
        JSON.stringify({
          call: calls.length,
          status: response.status,
          finishReason: data.choices?.[0]?.finish_reason,
          model: data.model,
          usage: data.usage,
        }),
      );
      return response;
    },
  );
} catch (e) {
  error = { name: e.name, code: e.code, message: e.message };
}
assert.equal(JSON.stringify(project), original);
assert.deepEqual(
  snapshot.paragraphReview.commits,
  state.paragraphReview.commits.slice(
    0,
    snapshot.paragraphReview.commits.length,
  ),
);
assert.deepEqual(
  snapshot.reviewWorkflow.constraints,
  state.reviewWorkflow.constraints,
);
if (result) await write("result.json", result);
const report = {
  status: result ? "passed" : state.status,
  mode: process.argv.includes("--live") ? "真实官方Coding接口" : "离线捕获",
  fixture: "第六章快照副本重审当前轮，保留既有草稿和补丁",
  taskId: state.id,
  chapterId: state.chapterId,
  requestedModel: config.model,
  calls: calls.length,
  elapsedMs: Date.now() - start,
  existingCommitsPreserved: true,
  authorConstraintsPreserved: true,
  projectUnchanged: true,
  finalStage: state.stage,
  error,
};
await write("report.json", report);
console.log(JSON.stringify(report, null, 2));
if (
  error &&
  !["awaiting_input"].includes(state.status) &&
  process.argv.includes("--live")
)
  process.exitCode = 1;
