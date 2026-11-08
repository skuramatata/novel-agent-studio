// 回归：模型调用永不返回时，结构化步骤不得永久停在 requesting。
// 现场证据（verification/story-event-chain/round4/e2e/runs/2026-11-08T04-57-04-739Z-9448-a61bd2/
// chain1-generate-checkpoint.json）：
//   step1 整理第 1 章记忆 = succeeded(calls=1, rawKey 有值)
//   step2 整理第 2 章记忆 = requesting(calls=0, rawKey=null)
//   state.calls 仍为 1、modelCalls 只有 1 条、stage 仍是第 1 步标签
// 说明卡在 structured-step.mjs:322 的 save() 之后、call() 内部（beginModelRecord 之前），
// 即 providers.mjs 的 fetcher / SSE 读取永不 settle。
// 本测试用永不返回的假 fetcher 驱动真实 createStructuredAsker，锁定该挂起点。
import test from "node:test";
import assert from "node:assert/strict";
import { createStructuredAsker } from "../runtime/structured-step.mjs";
import { complete } from "../runtime/providers.mjs";
import { memoryExtractionContract } from "../runtime/memory.mjs";

const config = {
  provider: "glm",
  model: "glm-5.3",
  apiKey: "test-key",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};

const never = () => new Promise(() => {});

function budget() {
  return {
    version: "probe",
    key: "[\"glm\",\"glm-5.3\",false]",
    factor: 1.25,
    samples: 1,
    highReasoning: true,
    reasoningPeaks: {},
    capabilities: {
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      appContextCap: 120000,
      maxInputTokens: null,
      endpointContextLimit: null,
      source: "probe",
      confidence: "probe",
      checkedAt: "2026-11-08",
      contextLimit: 120000,
      outputParameter: "max_tokens",
      version: "model-capabilities-1",
    },
  };
}

function state() {
  return {
    id: "probe-task",
    version: 1,
    continuityVersion: 1,
    retrievalVersion: 1,
    memoryContextVersion: 2,
    base: "base",
    request: { instruction: "起草第3章", chapterId: "c3" },
    provider: "glm",
    model: "glm-5.3",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    status: "running",
    stage: "准备",
    values: {},
    fragments: {},
    calls: 0,
    usages: [],
    manifest: [],
    updatedAt: new Date().toISOString(),
  };
}

const messages = [
  { role: "system", content: "从提供的小说原文抽取有出处的记忆，只输出JSON。" },
  { role: "user", content: JSON.stringify({ chapter: 1, part: 1, sources: [{ sourceId: 1, text: "林砚把铜扣交给父亲。" }] }) },
];

test(
  "模型 fetcher 永不返回时，ask 必须到限失败并带 label，而不是永久停在 requesting",
  { timeout: 20000 },
  async () => {
    const st = state();
    const save = async () => {};
    const ask = createStructuredAsker({
      state: st,
      budget: budget(),
      signal: new AbortController().signal,
      save,
      call: (msgs, tokens, label, partial, providerOptions) =>
        complete(
          config,
          msgs,
          new AbortController().signal,
          never,
          tokens,
          { ...providerOptions, allowPartial: true },
        ),
    });
    const contract = memoryExtractionContract({ continuity: true, compact: true });
    const started = Date.now();
    let error = null;
    try {
      await ask(
        "memory:probe",
        messages,
        (value) => value,
        12000,
        "整理第 1 章记忆 · 1/1",
        { contract, callDeadlineMs: 400 },
      );
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - started;
    assert.ok(error, "fetcher 永不返回时 ask 必须拒绝，不能永久挂起");
    assert.equal(error.code, "MODEL_CALL_TIMEOUT");
    assert.match(error.message, /整理第 1 章记忆 · 1\/1/);
    assert.ok(elapsed < 15000, `应在超时上限内返回，实测 ${elapsed}ms`);
    const step = Object.values(st.structuredSteps || {})[0];
    assert.ok(step, "必须落盘结构化步骤");
    assert.equal(step.status, "failed", "步骤必须落到可辨识的失败态，不能停在 requesting");
    assert.ok(step.lastFailure?.detail, "失败原因必须可读");
  },
);

test(
  "SSE 响应体永不结束时，同样必须到限失败",
  { timeout: 20000 },
  async () => {
    // 返回一个头是 event-stream、但 body 永不结束的响应
    const stalledStream = new ReadableStream({
      start() {},
    });
    const fetcher = async () =>
      new Response(stalledStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const st = state();
    const ask = createStructuredAsker({
      state: st,
      budget: budget(),
      signal: new AbortController().signal,
      save: async () => {},
      call: (msgs, tokens, label, partial, providerOptions) =>
        complete(
          config,
          msgs,
          new AbortController().signal,
          fetcher,
          tokens,
          { ...providerOptions, allowPartial: true },
        ),
    });
    const contract = memoryExtractionContract({ continuity: true, compact: true });
    const started = Date.now();
    let error = null;
    try {
      await ask(
        "memory:probe-sse",
        messages,
        (value) => value,
        12000,
        "整理第 2 章记忆 · 1/1",
        { contract, callDeadlineMs: 400 },
      );
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - started;
    assert.ok(error, "SSE 永不结束时 ask 必须拒绝");
    assert.equal(error.code, "MODEL_CALL_TIMEOUT");
    assert.match(error.message, /整理第 2 章记忆 · 1\/1/);
    assert.ok(elapsed < 15000, `应在超时上限内返回，实测 ${elapsed}ms`);
  },
);

test(
  "正常返回时行为不变：不追加等待、不改请求、返回值原样采用",
  { timeout: 20000 },
  async () => {
    let fetchCalls = 0;
    let seenBody = null;
    const payload = {
      summary: "摘要",
      records: [
        {
          kind: "event",
          text: "林砚把铜扣交给父亲。",
          entities: [],
          storyTime: "",
          knownBy: [],
          epistemic: "observed",
          quote: "林砚把铜扣交给父亲。",
          continuity: {
            assertion: "narration",
            actor: "",
            action: "",
            object: "",
            before: "",
            after: "",
            evidenceForm: "unknown",
            time: null,
          },
        },
      ],
    };
    const fetcher = async (url, init) => {
      fetchCalls++;
      seenBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const st = state();
    const ask = createStructuredAsker({
      state: st,
      budget: budget(),
      signal: new AbortController().signal,
      save: async () => {},
      call: (msgs, tokens, label, partial, providerOptions) =>
        complete(
          config,
          msgs,
          new AbortController().signal,
          fetcher,
          tokens,
          { ...providerOptions, allowPartial: true },
        ),
    });
    const contract = memoryExtractionContract({ continuity: true, compact: true });
    const started = Date.now();
    const value = await ask(
      "memory:probe-ok",
      messages,
      (raw) => contract.parse(raw),
      12000,
      "整理第 3 章记忆 · 1/1",
      { contract, callDeadlineMs: 400 },
    );
    const elapsed = Date.now() - started;
    assert.equal(fetchCalls, 1, "正常路径只请求一次");
    assert.equal(seenBody.stream, true, "不得为了规避超时而关闭 stream");
    assert.equal(value.summary, "摘要");
    assert.equal(value.records.length, 1);
    assert.ok(elapsed < 5000, `正常路径不应有额外等待，实测 ${elapsed}ms`);
    const step = Object.values(st.structuredSteps || {})[0];
    assert.equal(step.status, "succeeded");
  },
);
