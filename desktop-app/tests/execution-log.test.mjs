import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { runAgent } from "../runtime/agent.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal } from "../runtime/schema.mjs";
import { complete } from "../runtime/providers.mjs";
import {
  executionNodes,
  executionGraph,
  traceOperation,
} from "../runtime/execution-log.mjs";
import {
  readCreationLogs,
  readCreationLogNode,
} from "../runtime/creation-log.mjs";

const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "private-test-key",
};
const response = (value) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(value) }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 10 },
      model: "glm-5.2",
    }),
  );

test("讨论入口同样记录最终请求、原文和每次失败校验", async () => {
  const records = [];
  let calls = 0;
  const result = await runAgent(
    blankProject(),
    "讨论故事设定",
    config,
    new AbortController().signal,
    () => {},
    async (_, options) => {
      assert.deepEqual(records.at(-1).request, JSON.parse(options.body));
      return response({ summary: ++calls === 1 ? 123 : "讨论完成" });
    },
    {
      onTrace: (record) => {
        records.push(structuredClone(record));
      },
    },
  );
  assert.equal(result.calls, 2);
  const finished = records.filter((record) => record.validation);
  assert.equal(finished[0].validation.passed, false);
  assert.equal(finished[0].acceptedOutput, undefined);
  assert.equal(finished[1].acceptedOutput.summary, "讨论完成");
  assert.equal(finished[0].nodeId, finished[1].nodeId);
  assert.ok(records.some((record) => record.rawOutput && !record.validation));
});

test("同一结果键被新输入覆盖时，旧节点不展示新节点的接收结果", () => {
  const state = {
    structuredSteps: {
      old: {
        id: "old",
        label: "旧输入",
        status: "succeeded",
        rawKey: "raw-old",
        resultKey: "shared",
      },
      newer: {
        id: "newer",
        label: "新输入",
        status: "succeeded",
        rawKey: "raw-new",
        resultKey: "shared",
      },
    },
    responseMeta: {
      "raw-old": { stepId: "old" },
      "raw-new": { stepId: "newer" },
    },
    fragments: { "raw-old": "旧回答", "raw-new": "新回答" },
    structuredResults: { shared: "newer" },
    values: { shared: "新结果" },
  };
  const nodes = executionNodes(state, []);
  assert.equal(nodes[0].acceptedOutput, undefined);
  assert.equal(nodes[0].attempts[0].acceptedOutput, undefined);
  assert.equal(nodes[1].acceptedOutput, "新结果");
});

test("真实编排先保存最终请求和原文；纠错、接收结果、复用与历史读取分别可查", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novel-execution-log-"));
  try {
    const project = applyProposal(blankProject(), demoProposal(), 0);
    project.chapters = [];
    const checkpoint = new Checkpoint(directory);
    const state = await checkpoint.begin(
      project,
      { instruction: "完善故事规划" },
      config,
    );
    const sent = [];
    let intentAttempts = 0;
    const fetcher = async (_, options) => {
      const request = JSON.parse(options.body);
      sent.push(request);
      const saved = await checkpoint.read();
      assert.deepEqual(saved.modelCalls.at(-1).request, request);
      assert.doesNotMatch(
        JSON.stringify(saved.modelCalls),
        /private-test-key|Authorization/,
      );
      if (request.messages[0].content.includes("识别规划入口"))
        return response({
          mode: ++intentAttempts === 1 ? "invalid" : "prepare",
          chapterCount: null,
          chapterWords: null,
          countEvidence: "",
          wordsEvidence: "",
        });
      const data = JSON.parse(request.messages[1].content);
      return response({
        chapters: data.numbers.map((number) => ({
          number,
          title: `第${number}章`,
          summary: "保留已有事实并推进事件。",
        })),
      });
    };
    let rawSavedBeforeValidation = false;
    const write = checkpoint.write.bind(checkpoint);
    checkpoint.write = async (value) => {
      const last = value.modelCalls?.at(-1);
      if (last?.status === "received" && last.rawOutput && !last.validation)
        rawSavedBeforeValidation = true;
      await write(value);
    };
    await runChapterAgent(
      project,
      config,
      new AbortController().signal,
      () => {},
      checkpoint,
      state,
      fetcher,
    );
    assert.equal(rawSavedBeforeValidation, true);
    const view = await readCreationLogs(directory, project);
    const intent = view.flow.nodes.find((node) => node.label.includes("识别"));
    assert.ok(intent);
    const detail = await readCreationLogNode(
      directory,
      project,
      state.id,
      intent.id,
    );
    assert.equal(detail.attempts.length, 2);
    assert.equal(detail.attempts[0].validation.passed, false);
    assert.equal(detail.attempts[0].acceptedOutput, undefined);
    assert.equal(detail.attempts[0].parsedOutput.mode, "invalid");
    assert.equal(detail.attempts[1].validation.passed, true);
    assert.equal(detail.attempts[1].acceptedOutput.mode, "prepare");
    assert.deepEqual(
      detail.attempts.map((item) => item.request),
      sent.slice(0, 2),
    );
    assert.ok(view.flow.edges.some((edge) => edge.kind === "dependency"));
    assert.ok(
      (
        await readCreationLogs(directory, project, { onlyProblems: true })
      ).flow.nodes.some((node) => node.id === intent.id),
    );
    await runChapterAgent(
      project,
      config,
      new AbortController().signal,
      () => {},
      checkpoint,
      state,
      async () => {
        throw Error("不应再次请求模型");
      },
    );
    assert.equal(state.modelCalls.length, sent.length);
    assert.ok(
      (await readCreationLogNode(directory, project, state.id, intent.id))
        .reuses.length,
    );
    await checkpoint.begin(project, { instruction: "新任务" }, config);
    const before = await readFile(
      join(directory, "task-history", `${state.id}.json`),
      "utf8",
    );
    assert.equal(
      (await readCreationLogNode(directory, project, state.id, intent.id))
        .attempts.length,
      2,
    );
    assert.equal(
      await readFile(
        join(directory, "task-history", `${state.id}.json`),
        "utf8",
      ),
      before,
    );
    await assert.rejects(
      () => readCreationLogNode(directory, project, "../escape", intent.id),
      /无效任务/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("历史节点不重建最终请求，未知校验保持未知；查看脱敏不改变原数据", () => {
  const state = {
    structuredSteps: {
      s: {
        id: "s",
        label: "记忆抽取",
        status: "exhausted",
        input: [{ content: "Bearer private-token" }],
        rawKey: "r2",
        lastFailure: { rawKey: "r2", kind: "validation", detail: "类型不合法" },
      },
    },
    responseMeta: { r1: { stepId: "s" }, r2: { stepId: "s" } },
    fragments: { r1: "第一次", r2: "第二次" },
  };
  const snapshot = JSON.stringify(state);
  const nodes = executionNodes(state, []);
  assert.equal(nodes[0].attempts[0].status, "unknown");
  assert.equal(nodes[0].attempts[1].validation.passed, false);
  assert.equal(nodes[0].attempts[1].request, undefined);
  assert.equal(nodes[0].redacted, true);
  assert.doesNotMatch(JSON.stringify(nodes), /private-token/);
  assert.equal(JSON.stringify(state), snapshot);
  assert.deepEqual(executionGraph(nodes).edges, []);
});

test("流式中断保留已收到的可见原文，不接收部分结果或保存隐藏思考", async () => {
  const packets = [
    {
      choices: [
        { delta: { reasoning_content: "隐藏思考", content: "半段正文" } },
      ],
      model: "glm-5.2",
    },
  ];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          packets.map((data) => `data: ${JSON.stringify(data)}\n\n`).join(""),
        ),
      );
      controller.close();
    },
  });
  let record;
  await assert.rejects(
    () =>
      complete(
        config,
        [{ role: "user", content: "写作" }],
        new AbortController().signal,
        async () =>
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          }),
        1000,
        {
          onResponse: (result) => {
            record = result;
          },
        },
      ),
    /断流/,
  );
  assert.equal(record.text, "半段正文");
  assert.equal(record.partial, true);
  assert.doesNotMatch(JSON.stringify(record), /隐藏思考/);
});

test("程序检索节点记录输入输出和失败；不同运行实例的节点详情互不混淆", async () => {
  const state = {},
    saved = [];
  const save = async () => {
    saved.push(structuredClone(state));
  };
  await traceOperation(
    state,
    { key: "retrieval", label: "记忆检索", input: { query: "门禁卡" } },
    async () => ({ passages: ["卡交给小李"] }),
    save,
  );
  await assert.rejects(
    () =>
      traceOperation(
        state,
        { key: "retrieval", label: "记忆检索", input: { query: "断网" } },
        async () => {
          throw Error("索引不可用");
        },
        save,
      ),
    /索引不可用/,
  );
  const nodes = executionNodes(state, []);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].attempts.length, 2);
  assert.deepEqual(nodes[0].attempts[0].acceptedOutput, {
    passages: ["卡交给小李"],
  });
  assert.equal(nodes[0].attempts[1].acceptedOutput, undefined);
  assert.equal(nodes[0].attempts[1].error, "索引不可用");
  assert.equal(saved[0].logOperations[0].status, "running");
  assert.deepEqual(executionNodes({}, []), []);
});
