import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject } from "../runtime/seed.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { complete } from "../runtime/providers.mjs";
import { largerStructuredOutput } from "../runtime/structured.mjs";
import {
  baseTokens,
  estimatedTokens,
  ensureBudget,
} from "../runtime/model-budget.mjs";

const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "test-only",
};
const response = (content, finish = "stop") =>
  new Response(
    JSON.stringify({
      model: "glm-5.3",
      choices: [{ message: { content }, finish_reason: finish }],
      usage: {
        prompt_tokens: 500,
        completion_tokens: 3500,
        completion_tokens_details: { reasoning_tokens: 3400 },
      },
    }),
  );
function valid(body) {
  const data = JSON.parse(body.messages[1].content);
  return JSON.stringify({
    summary: "钥匙交接",
    records: [
      {
        kind: "event",
        text: "他接过钥匙",
        entities: [],
        storyTime: "未知",
        knownBy: [],
        epistemic: "observed",
        sourceId: data.sources[0].sourceId,
        continuity: {
          assertion: "narration",
          actor: "他",
          action: "接过",
          object: "钥匙",
          before: "",
          after: "持有钥匙",
          evidenceForm: "unknown",
          time: null,
        },
      },
    ],
  });
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "structured-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = blankProject();
  project.chapters = [
    {
      id: "one",
      number: 1,
      title: "钥匙",
      plan: "交接",
      content: "他接过钥匙。",
    },
  ];
  const checkpoint = new Checkpoint(dir);
  const state = await checkpoint.begin(
    project,
    { mode: "memory", chapterId: "one", instruction: "整理记忆" },
    config,
  );
  return {
    project,
    checkpoint,
    state,
    run: (s, fetcher) =>
      runChapterAgent(
        project,
        config,
        new AbortController().signal,
        () => {},
        checkpoint,
        s,
        fetcher,
      ),
  };
}

test("结构化截断不采纳完整JSON，空正文与思考用量保留；扩容和纠错最多四次", async (t) => {
  const f = await fixture(t),
    seen = [],
    original = structuredClone(f.project);
  const result = await f.run(f.state, async (_, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (seen.length === 1) return response(valid(body), "length");
    if (seen.length === 2) return response("not json");
    if (seen.length === 3) return response(null, "length");
    return response(valid(body));
  });
  assert.deepEqual(
    seen.map((b) => b.max_tokens),
    [6000, 12000, 12000, 24000],
  );
  for (const body of seen)
    ensureBudget(body.messages, body.max_tokens, f.state.tokenBudget);
  assert.equal(result.memoryOnly.entries.length, 1);
  assert.deepEqual(f.project, original);
  const saved = await f.checkpoint.read();
  assert.equal(Object.keys(saved.fragments).length, 4);
  assert.equal(
    Object.values(saved.responseMeta).filter((r) => r.finishReason === "length")
      .length,
    2,
  );
  assert.equal(Object.values(saved.fragments)[2], "");
  assert.equal(
    saved.usages[2].completion_tokens_details.reasoning_tokens,
    3400,
  );
  assert.equal(Object.values(saved.outputBudgets)[0], 24000);
});

test("截断后遇断网，重启沿用提高后的额度并保留每次响应", async (t) => {
  const f = await fixture(t),
    seen = [];
  await assert.rejects(
    f.run(f.state, async (_, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.max_tokens);
      if (seen.length === 1) return response('{"summary":', "length");
      throw Error("模拟断网");
    }),
    /模拟断网/,
  );
  const saved = await f.checkpoint.read();
  assert.deepEqual(seen, [6000, 12000]);
  const resumed = await f.checkpoint.begin(f.project, { resume: true }, config);
  await f.run(resumed, async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 12000);
    return response(valid(body));
  });
  const final = await f.checkpoint.read();
  for (const [key, value] of Object.entries(saved.fragments))
    assert.equal(final.fragments[key], value);
  assert.equal(Object.keys(final.fragments).length, 2);
});

test("持续截断有明确上限，恢复也不能无限自动扩容或缓存假成功", async (t) => {
  const f = await fixture(t),
    budgets = [];
  const fetcher = async (_, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.max_tokens);
    return response(valid(body), "length");
  };
  await assert.rejects(
    f.run(f.state, fetcher),
    (e) => e.code === "STRUCTURED_RECOVERY_EXHAUSTED",
  );
  assert.deepEqual(budgets, [6000, 12000, 24000]);
  assert.deepEqual(f.state.values, {});
  await assert.rejects(
    f.checkpoint.begin(f.project, { resume: true }, config),
    /输出预算已用尽/,
  );
  assert.equal(budgets.length, 3);
  assert.equal(Object.keys((await f.checkpoint.read()).fragments).length, 3);
});

test("扩容遵守总上下文预算和24000输出上限", () => {
  const messages = [{ role: "user", content: "真实材料" }];
  assert.equal(largerStructuredOutput(messages, 13000), 24000);
  const profile = { factor: 48000 / baseTokens(messages) };
  const next = largerStructuredOutput(messages, 6500, profile);
  assert.equal(next, 60000 - estimatedTokens(messages, profile));
  ensureBudget(messages, next, profile);
  assert.equal(largerStructuredOutput(messages, next, profile), next);
});

test("供应商默认拒绝截断并携带诊断，allowPartial允许只有思考用量的length", async () => {
  const fetcher = async () => response(null, "length");
  await assert.rejects(complete(config, [], undefined, fetcher, 6500), (e) => {
    assert.equal(e.code, "OUTPUT_LIMIT");
    assert.equal(e.outputBudget, 6500);
    assert.equal(
      e.result.usage.completion_tokens_details.reasoning_tokens,
      3400,
    );
    return true;
  });
  const result = await complete(config, [], undefined, fetcher, 6500, {
    allowPartial: true,
  });
  assert.equal(result.text, "");
  assert.equal(result.finishReason, "length");
  assert.equal(result.model, "glm-5.3");
});
