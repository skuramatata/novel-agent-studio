// 真实归档草稿的隔离验收；不读取或修改正式作品。--live 使用已配置的原供应商。
// 默认逐字回放同目录 live 请求，验证最终协议与实际响应一致。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { draftVersion, draftScenes } from "../runtime/revision-session.mjs";
import { reviewDocument } from "../runtime/paragraph-review.mjs";
import { applyProposal } from "../runtime/schema.mjs";

const live = process.argv.includes("--live"),
  root = resolve("verification/author-revision-workspace");
const mode = live ? "live" : "replay",
  dir = join(root, mode);
const read = async (p) => JSON.parse(await readFile(p, "utf8"));
const old = resolve("verification/author-check-review-recovery");
const p = await read(join(old, "project.before.json")),
  before = await read(join(old, "live/chapter-task.json"));
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
  apiKey: "replay-only",
};
if (live) {
  config.apiKey = (await readAuthorizedEnv())[config.provider]?.apiKey;
  assert.ok(config.apiKey, "缺少原供应商密钥");
}
await mkdir(dir, { recursive: true });
const write = (name, v) =>
  writeFile(join(dir, name), JSON.stringify(v, null, 2), { mode: 0o600 });
const checkpoint = new Checkpoint(dir);
await checkpoint.write(structuredClone(before));
const instruction =
  "只修改第1场第2段：保留背风凹处能容二十来人、湿木料劈成细条垫底、生火的事实，把火光和黑暗的描写写得更克制，减少重复的形容；其他段落与人物行动不改。";
const state = await checkpoint.begin(
  p,
  {
    instruction,
    authorAction: {
      id: "live-author-style-1",
      taskId: before.id,
      draftVersion: draftVersion(before),
      type: "revise",
      scope: { kind: "paragraph", sourceId: "scene:1", paragraph: 2 },
    },
  },
  config,
);
const requests = [],
  recorded = live ? [] : await read(join(root, "live/requests.json"));
let result, failure;
try {
  result = await runChapterAgent(
    p,
    config,
    AbortSignal.timeout(20 * 60 * 1000),
    () => {},
    checkpoint,
    state,
    async (url, init) => {
      const body = JSON.parse(init.body),
        entry = {
          stage: state.stage,
          messages: body.messages,
          output: body.max_tokens,
        };
      requests.push(entry);
      await write("requests.json", requests);
      console.log(
        JSON.stringify({ call: requests.length, stage: state.stage, mode }),
      );
      let response;
      if (live)
        response = await fetch(url, {
          ...init,
          signal: AbortSignal.any([init.signal, AbortSignal.timeout(180000)]),
        });
      else {
        const record = recorded[requests.length - 1];
        assert.deepEqual(entry, {
          stage: record.stage,
          messages: record.messages,
          output: record.output,
        });
        response = new Response(JSON.stringify(record.response), {
          status: record.status,
        });
      }
      entry.status = response.status;
      entry.response = await response.clone().json();
      await write("requests.json", requests);
      return response;
    },
  );
} catch (e) {
  failure = { name: e.name, message: e.message };
}
const prior = reviewDocument(draftScenes(before), {}),
  after = reviewDocument(draftScenes(state), {});
for (const source of prior.sources)
  for (const row of source.paragraphs) {
    if (source.sourceId === "scene:1" && row.paragraph === 2) continue;
    assert.equal(
      after.sources
        .find((s) => s.sourceId === source.sourceId)
        .paragraphs.find((p) => p.paragraph === row.paragraph)?.text,
      row.text,
      "范围外原文必须保持一致",
    );
  }
assert.deepEqual(
  state.reviewWorkflow.constraints,
  before.reviewWorkflow.constraints,
);
assert.deepEqual(p, await read(join(old, "project.before.json")));
const report = {
  mode,
  status: state.status,
  calls: requests.length,
  failure,
  error: state.error,
  budget: state.revisionBudget,
  constraintsPreserved: state.reviewWorkflow.constraints.length,
  outsideUnchanged: true,
  changed:
    after.sources[0].paragraphs[1].text !== prior.sources[0].paragraphs[1].text,
  before: prior.sources[0].paragraphs[1].text,
  after: after.sources[0].paragraphs[1].text,
  completed: !!result?.proposal,
};
await write("report.json", report);
if (result) await write("result.json", result);
if (result?.proposal) applyProposal(p, result.proposal, p.revision);
console.log(
  JSON.stringify({
    status: report.status,
    calls: report.calls,
    changed: report.changed,
    completed: report.completed,
    error: report.error,
  }),
);
assert.ok(
  report.changed &&
    (report.completed || state.status === "awaiting_instruction"),
  JSON.stringify(report),
);
