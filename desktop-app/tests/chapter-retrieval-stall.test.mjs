// 回归：本地检索（索引/检索）永不返回时，任务不得永久停在 running 且无错误。
// 现场证据：$TMPDIR/novel-sev-chain1-* 的 chapter-task.json 里
//   logOperations = [{ nodeId: "operation:index", status: "running" }]，无 error，
//   retrievalIndex/retrievedContext 均未写入，retrieval.sqlite 只写入第 1 章。
// 本测试用永不 resolve 的假 retrieval 服务驱动真实 runChapterAgent，锁定该挂起点。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal } from "../runtime/schema.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import stub from "../scripts/verify-story-events.model-stub.mjs";

process.env.NOVEL_E2E_FETCH_LOG = join(tmpdir(), `chapter-retrieval-stall-${process.pid}.jsonl`);

const never = () => new Promise(() => {});
const settled = (value) => Promise.resolve(value);

function fixture() {
  const base = applyProposal(blankProject(), demoProposal(), 0);
  const project = {
    ...base,
    revision: 1,
    messages: [],
    chapters: [
      { id: "c1", number: 1, title: "顺济号出航", summary: "", content: "林砚把铜扣交给父亲。汽笛响了三声，顺济号解缆离岸。" },
      { id: "c2", number: 2, title: "黑石岛", summary: "", content: "林砚在甲板上看见三十年前的旧船影子。父亲说那只是雾。" },
      { id: "c3", number: 3, title: "退潮之前", summary: "林砚独自下到船舱底层。", content: "" },
    ],
    characters: [
      { id: "c1", name: "林砚", role: "主角", goal: "", secret: "", voice: "", position: { x: 40, y: 40 } },
      { id: "c2", name: "林父", role: "父亲", goal: "", secret: "", voice: "", position: { x: 320, y: 40 } },
    ],
    relations: [{ id: "r1", source: "c1", target: "c2", label: "父子", detail: "林砚与林父。" }],
  };
  delete project.storyEvents;
  return project;
}

function taskState(dir) {
  return {
    id: `task-${Math.random().toString(16).slice(2)}`,
    version: 1,
    continuityVersion: 1,
    retrievalVersion: 1,
    memoryContextVersion: 2,
    base: "base",
    wordTolerance: { mode: "absolute", value: 500 },
    request: { instruction: "逐场景生成第3章", chapterId: "c3", mode: undefined, words: undefined },
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
    __dir: dir,
  };
}

const config = {
  provider: "glm",
  model: "glm-5.3",
  apiKey: "test-key",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};

async function run({ retrieval, retrievalWaitMs }) {
  const dir = await mkdtemp(join(tmpdir(), "chapter-retrieval-"));
  try {
    const checkpoint = new Checkpoint(dir);
    const state = taskState(dir);
    delete state.__dir;
    await checkpoint.write(state);
    const controller = new AbortController();
    const started = Date.now();
    try {
      const result = await runChapterAgent(
        fixture(),
        config,
        controller.signal,
        () => {},
        checkpoint,
        state,
        stub,
        { retrieval, ...(retrievalWaitMs ? { retrievalWaitMs } : {}) },
      );
      return { ok: true, result, state, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, error, state, ms: Date.now() - started };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "索引同步永不返回时，任务必须到限失败并写明步骤，而不是永久挂起",
  { timeout: 15000 },
  async () => {
    const outcome = await run({
      retrieval: { sync: never, search: never },
      retrievalWaitMs: 300,
    });
    assert.equal(outcome.ok, false, "索引同步永不返回时 runChapterAgent 必须拒绝，不能永久挂起");
    assert.equal(outcome.error.code, "RETRIEVAL_TIMEOUT");
    assert.match(outcome.error.message, /更新本地检索索引/);
    assert.match(outcome.error.message, /疑似本地 embedding/);
    assert.ok(
      outcome.ms >= 250 && outcome.ms < 10000,
      `应在约 300ms 到限，实测 ${outcome.ms}ms`,
    );
    const operation = (outcome.state.logOperations || []).find(
      (item) => item.nodeId === "operation:index",
    );
    assert.equal(operation?.status, "failed", "失败的索引操作必须落成 failed 并带原因");
    assert.ok(operation?.error, "索引操作必须记录错误原因，不能留空");
    assert.equal(outcome.state.retrievalIndex, undefined, "未完成的索引不得写入 retrievalIndex");
  },
);

test(
  "本地混合检索永不返回时，错误必须指明是检索而不是索引",
  { timeout: 15000 },
  async () => {
    const outcome = await run({
      retrieval: {
        sync: (project) => settled({ engine: "fake", embeddingId: "fake", chunks: 2 }),
        search: never,
      },
      retrievalWaitMs: 300,
    });
    assert.equal(outcome.ok, false, "检索永不返回时 runChapterAgent 必须拒绝");
    assert.equal(outcome.error.code, "RETRIEVAL_TIMEOUT");
    assert.match(outcome.error.message, /本地混合检索/);
    assert.match(outcome.error.message, /疑似本地 embedding/);
    assert.doesNotMatch(outcome.error.message, /更新本地检索索引/);
  },
);

test(
  "正常返回时行为不变：索引与检索结果原样采用，不追加等待",
  { timeout: 30000 },
  async () => {
    const calls = { sync: [], search: [] };
    const indexStats = { engine: "fake", embeddingId: "fake", chunks: 2 };
    const retrieved = {
      sources: [],
      coverage: { selected: 0, tokens: 0 },
    };
    const outcome = await run({
      retrieval: {
        sync: (project, options) => {
          calls.sync.push({ projectId: project.projectId, hasSignal: Boolean(options?.signal) });
          return settled(indexStats);
        },
        search: (project, chapterNumber, query) => {
          calls.search.push({ projectId: project.projectId, chapterNumber, query });
          return settled(retrieved);
        },
      },
      retrievalWaitMs: 300,
    });
    assert.equal(outcome.ok, true, `正常路径必须完成，实际错误：${outcome.error?.message}`);
    assert.equal(calls.sync.length, 1);
    assert.equal(calls.search.length, 1);
    assert.equal(calls.sync[0].hasSignal, true, "仍须把任务 signal 传给索引同步");
    assert.equal(calls.search[0].chapterNumber, 3);
    assert.deepEqual(outcome.state.retrievalIndex, indexStats);
    assert.deepEqual(outcome.state.retrievedContext, retrieved);
    const operation = (outcome.state.logOperations || []).find(
      (item) => item.nodeId === "operation:index",
    );
    assert.equal(operation?.status, "success");
    assert.equal(operation?.error, undefined);
  },
);
