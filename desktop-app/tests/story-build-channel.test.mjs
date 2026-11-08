import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStoryEventAsker,
  planStoryBuild,
  previewStoryEvents,
  resolveStoryEventAsk,
  resolveStoryProvider,
  runStoryBuild,
  storyBuildStatus,
} from "../electron/story-build-channel.mjs";
import { ProjectStore } from "../runtime/storage.mjs";
import { blankProject } from "../runtime/seed.mjs";
import {
  emptyStoryEvents,
  mergeStoryEvents,
  storyEventId,
} from "../runtime/story-events.mjs";
import { extractStoryEvents } from "../runtime/story-event-agent.mjs";
import { complete } from "../runtime/providers.mjs";

const chapter = (id, number, title, content) => ({
  id,
  number,
  title,
  summary: "",
  content,
});

const span = (text, fragment) => {
  const start = text.indexOf(fragment);
  assert.notEqual(start, -1, `夹具引文必须出现在正文中：${fragment}`);
  return { start, end: start + fragment.length, quote: fragment };
};

const providerConfig = {
  provider: "glm",
  model: "glm-4.6",
  apiKey: "test-key",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};

// 供应商返回的报文：与真实模型一致，是文本 JSON。
const replyWith = (payload) => async () => ({
  text: JSON.stringify(payload),
  usage: null,
  model: "glm-4.6",
  finishReason: "stop",
});

const ch1Text = "林砚把铜扣交给父亲。";
const extractionPayload = {
  summary: "交出铜扣",
  events: [
    {
      title: "林砚把铜扣交给父亲",
      summary: "在码头交出铜扣。",
      kind: "handover",
      actors: ["林砚", "林父"],
      objects: ["铜扣"],
      basis: "narration",
      quote: "林砚把铜扣交给父亲。",
      sourceId: 1,
    },
  ],
  relations: [],
};

// ---------- F1：不注入 ask 也能走真实入口 ----------

test("F1 未注入 ask 时用主进程模型通道建图，产出非空事件", async () => {
  const calls = [];
  const callComplete = async (config, messages, signal, fetcher, tokens) => {
    calls.push({ provider: config.provider, model: config.model, tokens });
    return replyWith(extractionPayload)(config, messages, signal, fetcher, tokens);
  };
  const resolved = resolveStoryEventAsk({
    config: providerConfig,
    callComplete,
  });
  assert.equal(resolved.source, "provider", "未注入时必须走主进程模型通道");
  assert.equal(typeof resolved.ask, "function");

  const project = {
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: emptyStoryEvents(),
  };
  const built = await extractStoryEvents(project, resolved.ask, {
    chapterIds: ["ch1"],
    model: "glm-4.6",
  });
  assert.equal(built.storyEvents.nodes.length, 1, "真实入口必须产出事件");
  assert.equal(built.storyEvents.nodes[0].title, "林砚把铜扣交给父亲");
  assert.equal(built.storyEvents.nodes[0].evidence.quote, "林砚把铜扣交给父亲。");
  assert.ok(calls.length >= 1, "必须真的调用模型通道");
  assert.equal(calls[0].provider, "glm");
  assert.equal(calls[0].model, "glm-4.6");
});

test("F1 注入 ask 与不注入 ask 走同一业务入口，产出结构同构", async () => {
  const project = {
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: emptyStoryEvents(),
  };
  const injected = async (key, messages, validate) =>
    validate({ ...extractionPayload });
  const viaInjected = await extractStoryEvents(project, injected, {
    chapterIds: ["ch1"],
  });
  const resolved = resolveStoryEventAsk({
    config: providerConfig,
    callComplete: replyWith(extractionPayload),
  });
  const viaProvider = await extractStoryEvents(project, resolved.ask, {
    chapterIds: ["ch1"],
  });
  assert.equal(resolved.source, "provider");
  const shape = (graph) =>
    graph.nodes.map((n) => ({
      title: n.title,
      kind: n.kind,
      actors: n.actors,
      objects: n.objects,
      quote: n.evidence.quote,
      start: n.evidence.start,
      end: n.evidence.end,
    }));
  assert.deepEqual(
    shape(viaProvider.storyEvents),
    shape(viaInjected.storyEvents),
    "两条路径必须产出同构结果，证明产品不依赖注入函数",
  );
  assert.equal(
    viaProvider.storyEvents.nodes[0].id,
    viaInjected.storyEvents.nodes[0].id,
    "同一事件在两条路径下身份一致",
  );
});

test("F1 注入 ask 优先于 provider 配置，且不构造模型通道", async () => {
  let providerCalls = 0;
  const injected = async () => ({ ...extractionPayload });
  const resolved = resolveStoryEventAsk({
    injected,
    config: providerConfig,
    callComplete: async () => {
      providerCalls += 1;
      return replyWith(extractionPayload)();
    },
  });
  assert.equal(resolved.source, "injected");
  assert.equal(resolved.ask, injected);
  assert.equal(providerCalls, 0, "注入时不得再去调真实通道");
});

test("F1 未配置模型时报可读错误，而不是要求注入 ask", async () => {
  assert.throws(
    () => createStoryEventAsker({ config: null }),
    /尚未配置模型供应商/,
  );
  assert.throws(
    () => createStoryEventAsker({ config: { provider: "glm", model: "glm-4.6" } }),
    /API Key/,
  );
  assert.throws(
    () => createStoryEventAsker({ config: { provider: "glm", apiKey: "k" } }),
    /选择.*模型/,
  );
  // 关键判据：错误信息不得再把「注入 ask」当成产品前提。
  for (const bad of [null, { provider: "glm", model: "glm-4.6" }]) {
    try {
      createStoryEventAsker({ config: bad });
      assert.fail("应当抛错");
    } catch (error) {
      assert.equal(
        /注入|inject|ask/i.test(error.message),
        false,
        `错误信息不得要求注入 ask，实际：${error.message}`,
      );
    }
  }
});

test("F1 provider 选择：显式指定 > 已配置，且只配一个供应商时可直接用", () => {
  const only = { glm: providerConfig };
  const picked = resolveStoryProvider(only);
  assert.equal(picked.provider, "glm");
  assert.equal(picked.config.apiKey, providerConfig.apiKey);

  const both = {
    glm: providerConfig,
    minimax: { provider: "minimax", model: "MiniMax-M3", apiKey: "k2" },
  };
  assert.equal(resolveStoryProvider(both, "minimax").provider, "minimax");
  assert.throws(() => resolveStoryProvider(both, "nope"), /未找到模型供应商/);
  assert.throws(() => resolveStoryProvider({}), /尚未配置可用的模型供应商/);
  assert.throws(
    () => resolveStoryProvider({ glm: { provider: "glm", model: "glm-4.6" } }),
    /API Key/,
  );
});

// ---------- F1：只读状态绝不调用模型 ----------

test("F1 只读状态查询不调用模型，也不写作品", () => {
  let calls = 0;
  const project = {
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: emptyStoryEvents(),
  };
  const before = JSON.stringify(project);
  const status = storyBuildStatus(project, { mode: "build" });
  assert.equal(calls, 0, "只读状态不得触发模型调用");
  assert.equal(status.touchesManuscript, false);
  assert.equal(status.hasContent, true);
  assert.equal(status.counts.total, 1);
  assert.equal(status.state, "idle");
  assert.equal(JSON.stringify(project), before, "只读状态不得改动作品");
});

test("F1 只读状态在有覆盖记录时给出进度", () => {
  const project = {
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: {
      ...emptyStoryEvents(),
      coverage: [
        {
          chapterId: "ch1",
          status: "extracted",
          parts: [0],
          extractedAt: null,
          model: "glm-4.6",
          failure: null,
        },
      ],
    },
  };
  const status = storyBuildStatus(project);
  assert.equal(status.counts.extracted, 1);
  assert.equal(status.state, "complete");
  assert.equal(status.chapters[0].status, "extracted");
});

test("F1 无正文时只读状态如实报告 hasContent=false", () => {
  const project = {
    chapters: [chapter("ch1", 1, "空章", "   ")],
    storyEvents: emptyStoryEvents(),
  };
  const status = storyBuildStatus(project);
  assert.equal(status.hasContent, false);
  assert.equal(status.state, "idle");
});

// ---------- H6：空补全不得写版本，补全只补未完成章 ----------

const coverageEntry = (chapterId, status, extra = {}) => ({
  chapterId,
  status,
  parts: status === "extracted" ? [0] : [],
  extractedAt: null,
  model: "glm-4.6",
  failure: null,
  ...extra,
});

const storeWith = async (build) => {
  const dir = await mkdtemp(join(tmpdir(), "story-build-h6-"));
  const store = new ProjectStore(dir);
  const base = await store.load();
  const project = await store.save(build(base), base.revision);
  return { dir, store, project };
};

test("H6 全部章节已抽取时补全没有目标章，只读状态必须如实报告", () => {
  const project = {
    chapters: [
      chapter("ch1", 1, "顺流", ch1Text),
      chapter("ch2", 2, "开门", "乙用钥匙打开门。"),
    ],
    storyEvents: {
      ...emptyStoryEvents(),
      coverage: [
        coverageEntry("ch1", "extracted"),
        coverageEntry("ch2", "extracted"),
      ],
    },
  };
  const status = storyBuildStatus(project, { mode: "complete" });
  assert.equal(status.counts.extracted, 2);
  assert.equal(status.pendingTargets, 0, "全部已抽取时必须报告没有待补章节");
  assert.equal(status.hasPendingTargets, false, "界面据此禁用补全动作");
  assert.equal(status.hasContent, true, "既有字段语义不变");
  assert.equal(status.state, "complete", "既有状态语义不变");
});

test("H6 有未完成章时补全目标只含未完成章", () => {
  const project = {
    chapters: [
      chapter("ch1", 1, "顺流", ch1Text),
      chapter("ch2", 2, "开门", "乙用钥匙打开门。"),
      chapter("ch3", 3, "空章", "   "),
    ],
    storyEvents: {
      ...emptyStoryEvents(),
      coverage: [
        coverageEntry("ch1", "extracted"),
        coverageEntry("ch2", "failed", { failure: "网络中断" }),
      ],
    },
  };
  const status = storyBuildStatus(project, { mode: "complete" });
  assert.equal(status.hasPendingTargets, true);
  assert.equal(status.pendingTargets, 1, "无正文的空章不算待补目标");
  assert.deepEqual(
    status.chapters
      .filter((c) => c.hasContent && c.status !== "extracted")
      .map((c) => c.chapterId),
    ["ch2"],
    "无正文的空章不是待补目标",
  );
  const plan = planStoryBuild(project, { mode: "complete" });
  assert.deepEqual(plan.chapterIds, ["ch2"], "补全只能补未完成章");
  assert.equal(plan.empty, false);
});

test("H6 空目标 complete 不写版本、不调模型、不落盘", async () => {
  const { dir, store } = await storeWith((base) => ({
    ...base,
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: {
      ...emptyStoryEvents(),
      coverage: [coverageEntry("ch1", "extracted")],
    },
    projectId: "proj-h6",
  }));
  try {
    const before = await store.load();
    const beforeFile = JSON.stringify(before);
    const beforeRevision = before.revision;
    assert.equal(beforeRevision, 1, "夹具自身保存后应为 revision 1");

    let modelCalls = 0;
    const countingAsk = async (key, messages, validate) => {
      modelCalls += 1;
      return validate({ ...extractionPayload });
    };
    const result = await runStoryBuild({
      projectId: "proj-h6",
      options: { mode: "complete" },
      store,
      ask: countingAsk,
    });

    assert.equal(modelCalls, 0, "空目标不得触达模型");
    assert.equal(result.skipped, true, "必须留下明确的空目标标记");
    assert.equal(result.skippedReason, "no-targets");
    assert.equal(result.touchesManuscript, false);
    assert.equal(result.hasPendingTargets, false);

    const after = await store.load();
    assert.equal(after.revision, beforeRevision, "空目标不得递增 revision");
    assert.equal(JSON.stringify(after), beforeFile, "空目标不得写作品");
    const reloaded = await new ProjectStore(dir).load();
    assert.equal(reloaded.revision, beforeRevision, "磁盘上的版本也必须不变");
    assert.equal(
      JSON.stringify(reloaded),
      beforeFile,
      "空目标不得落盘产生新内容",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H6 部分完成时补全只补未完成章，且写版本", async () => {
  const ch2Text = "乙用钥匙打开门。";
  const { dir, store } = await storeWith((base) => ({
    ...base,
    chapters: [chapter("ch1", 1, "顺流", ch1Text), chapter("ch2", 2, "开门", ch2Text)],
    storyEvents: {
      ...emptyStoryEvents(),
      coverage: [coverageEntry("ch1", "extracted"), coverageEntry("ch2", "failed")],
    },
    projectId: "proj-h6-partial",
  }));
  try {
    const before = await store.load();
    const askedChapters = [];
    // 引文必须出现在本章正文里，否则覆盖状态会被判为失败。
    const ask = async (key, messages, validate) => {
      const payload = JSON.parse(messages[1].content);
      askedChapters.push(payload.chapterId);
      return validate({
        summary: "开门",
        events: [
          {
            title: "乙用钥匙打开门",
            summary: "",
            kind: "action",
            actors: ["乙"],
            objects: ["钥匙"],
            basis: "narration",
            quote: ch2Text,
            sourceId: 1,
          },
        ],
        relations: [],
      });
    };
    const result = await runStoryBuild({
      projectId: "proj-h6-partial",
      options: { mode: "complete" },
      store,
      ask,
    });
    assert.deepEqual(
      [...new Set(askedChapters)],
      ["ch2"],
      "补全不得重建已抽取章",
    );
    assert.equal(result.skipped, false);
    assert.equal(result.counts.extracted, 2);
    const after = await store.load();
    assert.equal(after.revision, before.revision + 1, "真正补全才写版本");
    assert.equal(after.chapters[1].content, ch2Text, "补全不得改正文");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("H6 build 模式仍然重建全部有正文的章", async () => {
  const { dir, store } = await storeWith((base) => ({
    ...base,
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: {
      ...emptyStoryEvents(),
      coverage: [coverageEntry("ch1", "extracted")],
    },
    projectId: "proj-h6-build",
  }));
  try {
    const before = await store.load();
    const askedChapters = [];
    const ask = async (key, messages, validate) => {
      askedChapters.push(JSON.parse(messages[1].content).chapterId);
      return validate({ ...extractionPayload });
    };
    const result = await runStoryBuild({
      projectId: "proj-h6-build",
      options: { mode: "build" },
      store,
      ask,
    });
    assert.deepEqual(askedChapters, ["ch1"], "build 必须重建目标章");
    assert.equal(result.skipped, false, "重建不得被当成空目标");
    const after = await store.load();
    assert.equal(after.revision, before.revision + 1, "重建照常写版本");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- F8：预览跨章边 ----------

const crossChapterFixture = () => {
  const ch1 = chapter("ch1", 1, "顺流", "甲把钥匙交给乙。");
  const ch2 = chapter("ch2", 2, "开门", "乙用钥匙打开门。");
  const formal = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("甲把钥匙交给乙。", "甲把钥匙交给乙"),
      },
    ],
    { chapters: [ch1, ch2] },
  ).storyEvents;
  const historyId = formal.nodes[0].id;
  const patch = {
    nodes: [
      {
        chapterId: "ch2",
        title: "乙用钥匙打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("乙用钥匙打开门。", "乙用钥匙打开门"),
      },
    ],
    edges: [
      {
        source: historyId,
        target: storyEventId({
          chapterId: "ch2",
          title: "乙用钥匙打开门",
          start: 0,
          end: 7,
        }),
        type: "recall",
        basis: "explicit",
        explanation: "第二章用到第一章交出的钥匙",
        evidence: [{ chapterId: "ch2", ...span("乙用钥匙打开门。", "乙用钥匙打开门") }],
      },
    ],
  };
  return { ch1, ch2, formal, historyId, patch };
};

test("F8 预览显示指向正式历史事件的跨章边", () => {
  const { ch1, ch2, formal, historyId, patch } = crossChapterFixture();
  const preview = previewStoryEvents({
    formalNodes: formal.nodes,
    patch,
    chapters: [ch1, ch2],
  });
  // 附挂只服务合并校验，输出侧由 runtime 剔除：预览 nodes 只含本次候选事件。
  assert.equal(preview.graph.nodes.length, 1, "预览只新增本次候选事件");
  assert.equal(preview.graph.nodes[0].chapterId, "ch2", "输出节点属于本轮章节");
  assert.equal(preview.graph.edges.length, 1, "跨章边必须在预览中显示");
  assert.equal(preview.graph.edges[0].source, historyId, "端点应指向正式历史事件");
  assert.deepEqual(preview.knownNodeIds, [historyId]);
  // 界面显示对端信息用这个引用（不在 nodes 里，不会被当成候选新事件）。
  assert.deepEqual(preview.referencedFormalNodeIds, [historyId]);
  assert.equal(preview.referencedFormalNodes[0].title, "甲把钥匙交给乙");
});

test("F8 预览不写正式图，正式图前后完全一致", () => {
  const { ch1, ch2, formal, patch } = crossChapterFixture();
  const before = JSON.stringify(formal);
  const preview = previewStoryEvents({
    formalNodes: formal.nodes,
    patch,
    chapters: [ch1, ch2],
  });
  assert.equal(JSON.stringify(formal), before, "预览不得修改正式图");
  assert.equal(formal.edges.length, 0, "正式图不应因预览出现边");
  assert.equal(formal.nodes.length, 1, "正式图节点数不变");
  // 预览里的跨章边端点就是正式图节点 id
  assert.ok(
    formal.nodes.some((n) => n.id === preview.graph.edges[0].source),
    "预览跨章边端点必须等于正式图节点 id",
  );
});

test("F8 预览丢弃两端都不存在的边并留下 missing-source", () => {
  const ch1 = chapter("ch1", 1, "顺流", ch1Text);
  const preview = previewStoryEvents({
    formalNodes: [],
    patch: {
      nodes: [],
      edges: [
        {
          source: "sev-nowhere",
          target: "sev-also-nowhere",
          type: "causal",
          basis: "inferred",
          explanation: "凭空指向不存在的事件",
          evidence: [],
        },
      ],
    },
    chapters: [ch1],
  });
  assert.equal(preview.graph.edges.length, 0, "两端都不存在的边必须丢弃");
  assert.ok(
    preview.graph.issues.some((i) => i.kind === "missing-source"),
    "必须留下 missing-source，不能凭空显示",
  );
});

// ---------- 模型传输接缝：替身 fetch 生效，真实网络不被发起 ----------

test("传输接缝：注入的 fetch 被模型通道使用，未发起真实网络请求", async () => {
  let realNetwork = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    realNetwork += 1;
    throw new Error("测试期间不得发起真实网络请求");
  };
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method ?? "GET" });
    if (!String(url).startsWith("https://open.bigmodel.cn/"))
      throw new Error(`不得访问非测试地址：${url}`);
    const body = JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify(extractionPayload) },
          finish_reason: "stop",
        },
      ],
      model: "glm-4.6",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const asker = createStoryEventAsker({
      config: providerConfig,
      callComplete: (cfg, messages, signal, fetcher, tokens) =>
        complete(cfg, messages, signal, fakeFetch, tokens),
    });
    const project = {
      chapters: [chapter("ch1", 1, "顺流", ch1Text)],
      storyEvents: emptyStoryEvents(),
    };
    const built = await extractStoryEvents(project, asker, {
      chapterIds: ["ch1"],
      model: "glm-4.6",
    });
    assert.equal(built.storyEvents.nodes.length, 1, "替身传输必须能产出事件");
    assert.ok(seen.length >= 1, "替身 fetch 必须被实际调用");
    assert.equal(realNetwork, 0, "不得发起真实网络请求");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("传输接缝：模型通道默认走 globalThis.fetch，替换后生效", async () => {
  const originalFetch = globalThis.fetch;
  let replacedCalls = 0;
  const replaced = async () => {
    replacedCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(extractionPayload) },
            finish_reason: "stop",
          },
        ],
        model: "glm-4.6",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  globalThis.fetch = replaced;
  try {
    // 不传 callComplete：验证默认路径确实取 globalThis.fetch（与 main.mjs 同一做法）。
    const asker = createStoryEventAsker({ config: providerConfig });
    const project = {
      chapters: [chapter("ch1", 1, "顺流", ch1Text)],
      storyEvents: emptyStoryEvents(),
    };
    const built = await extractStoryEvents(project, asker, { chapterIds: ["ch1"] });
    assert.equal(built.storyEvents.nodes.length, 1);
    assert.ok(replacedCalls >= 1, "替换 globalThis.fetch 后应被调用");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------- F1：只读状态查询与建图执行必须分开 ----------

test("F1 只读状态接口不调模型、不写作品，且与执行接口结构同构", async () => {
  const project = {
    chapters: [chapter("ch1", 1, "顺流", ch1Text)],
    storyEvents: emptyStoryEvents(),
    revision: 7,
  };
  let completeCalls = 0;
  const countingComplete = async () => {
    completeCalls += 1;
    return replyWith(extractionPayload)();
  };
  const before = JSON.stringify(project);

  // 只读路径：storyBuildStatus 是纯函数，绝不触碰模型或作品。
  const status = storyBuildStatus(project, { mode: "build" });
  assert.equal(completeCalls, 0, "只读状态不得调用模型");
  assert.equal(JSON.stringify(project), before, "只读状态不得写作品");
  assert.equal(project.revision, 7, "revision 不得改变");

  // 执行路径：确实走模型通道并产出事件。
  const resolved = resolveStoryEventAsk({
    config: providerConfig,
    callComplete: countingComplete,
  });
  const built = await extractStoryEvents(project, resolved.ask, {
    chapterIds: ["ch1"],
  });
  assert.ok(completeCalls >= 1, "执行路径必须真实调用模型通道");
  assert.equal(built.storyEvents.nodes.length, 1, "执行路径必须产出事件");

  // 结构同构：前端可用同一套渲染。
  const statusKeys = Object.keys(status).sort();
  const builtProgress = storyBuildStatus(
    { ...project, storyEvents: built.storyEvents },
    { mode: "build" },
  );
  assert.deepEqual(
    Object.keys(builtProgress).sort(),
    statusKeys,
    "只读与执行返回的进度结构必须同构",
  );
  assert.equal(builtProgress.counts.extracted, 1, "执行后覆盖记录应更新");
  assert.equal(status.counts.extracted, 0, "只读状态反映执行前的覆盖");
});

// ---------- H6：界面主动作判定 ----------

const loadStoryEventHelpers = async () => {
  const ts = (await import("typescript")).default;
  const source = await readFile(
    new URL("../src/features/useStoryEvents.ts", import.meta.url),
    "utf8",
  );
  // 该文件同时含 React hook，依赖 react/bridge 无法在 data: URL 里解析。
  // 这里只加载展示层纯函数：去掉 import 语句，其余顶层只有纯数据与函数声明。
  const pure = source.replace(/^import[\s\S]*?from\s*"[^"]*";\s*$/gm, "");
  const js = ts.transpileModule(pure, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
};

const progressFixture = (overrides = {}) => ({
  enabled: true,
  state: "complete",
  mode: "complete",
  hasContent: true,
  chapters: [],
  counts: {
    total: 2,
    extracted: 2,
    partial: 0,
    failed: 0,
    pending: 0,
  },
  hasPendingTargets: false,
  pendingTargets: 0,
  failure: null,
  touchesManuscript: false,
  ...overrides,
});

test("H6 全部章节已抽取时主动作判定为 none，按钮不可执行", async () => {
  const { primaryBuildMode, primaryBuildLabel, hasStoryBuildTargets } =
    await loadStoryEventHelpers();
  const progress = progressFixture();
  assert.equal(primaryBuildMode(progress), "none", "无待补章节时不得给出补全动作");
  assert.match(primaryBuildLabel(progress), /全部章节已抽取/);
  assert.equal(hasStoryBuildTargets(progress), false, "界面据此禁用补全动作");
});

test("H6 有未完成章时主动作仍为 complete", async () => {
  const { primaryBuildMode, primaryBuildLabel, hasStoryBuildTargets, canStartStoryBuild } =
    await loadStoryEventHelpers();
  const progress = progressFixture({
    state: "partial",
    counts: { total: 2, extracted: 1, partial: 0, failed: 1, pending: 0 },
    hasPendingTargets: true,
    pendingTargets: 1,
  });
  assert.equal(primaryBuildMode(progress), "complete");
  assert.match(primaryBuildLabel(progress), /补全事件图/);
  assert.equal(hasStoryBuildTargets(progress), true);
  assert.equal(canStartStoryBuild(progress), true);
});

test("H6 未建图时主动作仍为 build，且重新建立语义不变", async () => {
  const { primaryBuildMode, primaryBuildLabel, canRebuild, canStartStoryBuild } =
    await loadStoryEventHelpers();
  const idle = progressFixture({
    state: "idle",
    counts: { total: 2, extracted: 0, partial: 0, failed: 0, pending: 2 },
    hasPendingTargets: true,
    pendingTargets: 2,
  });
  assert.equal(primaryBuildMode(idle), "build");
  assert.equal(primaryBuildLabel(idle), "建立事件图");
  assert.equal(canStartStoryBuild(idle), true);
  assert.equal(canRebuild(idle), false, "没建过图不提供重新建立");

  const built = progressFixture();
  assert.equal(canRebuild(built), true, "全部已抽取时仍保留重新建立");
});

test("H6 环境不支持或无正文时仍保留按钮展示，只是不可执行", async () => {
  const { hasStoryBuildTargets, canStartStoryBuild, primaryBuildMode } =
    await loadStoryEventHelpers();
  const unsupported = progressFixture({
    enabled: false,
    state: "unsupported",
    counts: { total: 2, extracted: 0, partial: 0, failed: 0, pending: 2 },
    hasPendingTargets: true,
    pendingTargets: 2,
  });
  assert.equal(canStartStoryBuild(unsupported), false, "不支持时必须禁用");
  assert.equal(
    hasStoryBuildTargets(unsupported),
    true,
    "这不是无待补，按钮仍需展示以说明原因",
  );
  assert.equal(primaryBuildMode(unsupported), "build", "不支持时不宣称已抽取完");

  const noContent = progressFixture({
    hasContent: false,
    state: "idle",
    counts: { total: 0, extracted: 0, partial: 0, failed: 0, pending: 0 },
    hasPendingTargets: false,
    pendingTargets: 0,
  });
  assert.equal(canStartStoryBuild(noContent), false);
  assert.equal(primaryBuildMode(noContent), "build", "无正文不是已全部抽取");
});

// ---------- H6 契约：runStoryBuild 必须返回扁平 StoryBuildProgress ----------

test("H6 契约：runStoryBuild 返回扁平进度，渲染层纯函数可直接消费", async () => {
  const { storyBuildLabel, storyBuildSummary, canStartStoryBuild, canRebuild } =
    await loadStoryEventHelpers();

  // 成功路径：build 后返回值必须保持 IPC 既有扁平契约。
  {
    const { dir, store } = await storeWith((base) => ({
      ...base,
      chapters: [chapter("ch1", 1, "顺流", ch1Text)],
      storyEvents: emptyStoryEvents(),
      projectId: "proj-contract-ok",
    }));
    try {
      const result = await runStoryBuild({
        projectId: "proj-contract-ok",
        options: { mode: "build" },
        store,
        ask: async (key, messages, validate) => validate({ ...extractionPayload }),
      });
      assert.equal(typeof result.counts.extracted, "number", "顶层必须有 counts");
      assert.ok(Array.isArray(result.chapters), "顶层必须有 chapters");
      assert.equal(result.touchesManuscript, false, "既有字段必须保留");
      assert.equal(typeof result.state, "string", "顶层必须有 state");
      assert.equal(typeof result.hasContent, "boolean");
      assert.equal(result.skipped, false);
      assert.equal(result.skippedReason, null);
      assert.deepEqual(result.targetChapterIds, ["ch1"]);
      assert.ok(Array.isArray(result.failures));
      // 渲染层纯函数必须能直接吃这个返回值（原缺陷会在此抛错）。
      assert.doesNotThrow(() => storyBuildLabel(result));
      assert.doesNotThrow(() => storyBuildSummary(result));
      assert.equal(typeof canStartStoryBuild(result), "boolean");
      assert.equal(typeof canRebuild(result), "boolean");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 空目标路径：同样必须是扁平进度，而不是新的嵌套结构。
  {
    const { dir, store } = await storeWith((base) => ({
      ...base,
      chapters: [chapter("ch1", 1, "顺流", ch1Text)],
      storyEvents: {
        ...emptyStoryEvents(),
        coverage: [coverageEntry("ch1", "extracted")],
      },
      projectId: "proj-contract-empty",
    }));
    try {
      const result = await runStoryBuild({
        projectId: "proj-contract-empty",
        options: { mode: "complete" },
        store,
        ask: async () => {
          throw new Error("空目标不得调用模型");
        },
      });
      assert.equal(result.skipped, true);
      assert.equal(result.skippedReason, "no-targets");
      assert.deepEqual(result.targetChapterIds, []);
      assert.equal(typeof result.counts.extracted, "number", "空目标也必须有 counts");
      assert.ok(Array.isArray(result.chapters), "空目标也必须有 chapters");
      assert.equal(result.touchesManuscript, false);
      assert.doesNotThrow(() => storyBuildLabel(result));
      assert.doesNotThrow(() => storyBuildSummary(result));
      assert.equal(typeof canStartStoryBuild(result), "boolean");
      assert.equal(typeof canRebuild(result), "boolean");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
