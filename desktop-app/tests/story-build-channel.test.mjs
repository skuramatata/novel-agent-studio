import test from "node:test";
import assert from "node:assert/strict";
import {
  createStoryEventAsker,
  previewStoryEvents,
  resolveStoryEventAsk,
  resolveStoryProvider,
  storyBuildStatus,
} from "../electron/story-build-channel.mjs";
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
