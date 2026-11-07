import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  Menu,
} from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { ProjectLibrary } from "../runtime/library.mjs";
import {
  StoryVectorIndex,
  localEmbedder,
} from "../runtime/story-retrieval.mjs";
import {
  modelCapabilities,
  capabilityKey,
  validateLimits,
} from "../runtime/model-capabilities.mjs";
import { projectExport } from "../runtime/export.mjs";
import {
  readAuthorizedEnv,
  authorizedEnvPath,
  providerDefaults,
  validateProvider,
  complete,
} from "../runtime/providers.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { Checkpoint, baseFingerprint } from "../runtime/checkpoint.mjs";
import {
  draftWorkspaceView,
  isDraftActionReplay,
} from "../runtime/draft-actions.mjs";
import { draftScenes } from "../runtime/revision-session.mjs";
import { isReviewDecisionReplay } from "../runtime/review-resolution.mjs";
import {
  readCreationLogs,
  readCreationLogNode,
  appendCreationEvent,
} from "../runtime/creation-log.mjs";
import {
  reviewTaskState,
  addRecoveryMessage,
} from "../runtime/review-workflow.mjs";
import { memoryView } from "../runtime/memory.mjs";
import {
  emptyStoryEvents,
  impactOf,
  mergeStoryEvents,
  normalizeStoryEvents,
  setIssueDisposition,
  storySubgraph,
} from "../runtime/story-events.mjs";
import { runAgent } from "../runtime/agent.mjs";
import { applyProposal, projectSchema } from "../runtime/schema.mjs";
import { resolveProposalStoryEvents } from "../runtime/story-events-apply.mjs";
import { extractStoryEvents } from "../runtime/story-event-agent.mjs";
import {
  previewStoryEvents,
  resolveStoryEventAsk,
  resolveStoryProvider,
  storyBuildStatus,
} from "./story-build-channel.mjs";
import { resolveModelTransport } from "./model-transport.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildInfo = JSON.parse(
  await readFile(join(root, "build-info.json"), "utf8"),
);
app.setName("小说工作室");
app.setAboutPanelOptions({
  applicationName: "小说工作室",
  applicationVersion: buildInfo.displayVersion,
  version: buildInfo.builtAtLabel,
});
app.setPath(
  "userData",
  process.env.NOVEL_AGENT_DATA_DIR ||
    join(app.getPath("appData"), "novel-agent-studio"),
);
const dataDir = process.env.NOVEL_AGENT_DATA_DIR || app.getPath("userData");
const sourceEnv = authorizedEnvPath({ packaged: app.isPackaged, dataDir });
const store = new ProjectLibrary(dataDir);
const embed = localEmbedder(
  app.isPackaged ? join(process.resourcesPath, "models") : join(root, "models"),
);
let win;
let active = null;
let configs;
let writeQueue = Promise.resolve();
const serial = (fn) => {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
};
const configFile = join(dataDir, "providers.json");
let configLoading;
async function writeConfigs(all) {
  const saved = Object.fromEntries(
    Object.entries(all).map(([k, v]) => [
      k,
      {
        provider: k,
        model: v.model,
        baseUrl: v.baseUrl,
        limits: v.limits,
        limitKey: v.limitKey,
        ...(v.encryptedKey ? { encryptedKey: v.encryptedKey } : {}),
      },
    ]),
  );
  await mkdir(dataDir, { recursive: true });
  await writeFile(configFile + ".tmp", JSON.stringify(saved), { mode: 0o600 });
  await rename(configFile + ".tmp", configFile);
}
async function loadConfig() {
  if (configs) return configs;
  if (configLoading) return configLoading;
  configLoading = (async () => {
    const next = structuredClone(providerDefaults);
    try {
      const saved = JSON.parse(await readFile(configFile, "utf8"));
      for (const key of ["glm", "minimax"])
        if (saved[key]) {
          const s = saved[key];
          next[key] = {
            ...next[key],
            ...s,
            apiKey: s.encryptedKey
              ? safeStorage.decryptString(Buffer.from(s.encryptedKey, "base64"))
              : "",
          };
        }
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error("无法读取模型配置或解密密钥。请检查系统钥匙串。");
    }
    if (["glm", "minimax"].some((k) => !next[k].apiKey)) {
      let timer;
      const imported = await Promise.race([
        readAuthorizedEnv(sourceEnv),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({}), 3000);
        }),
      ]).finally(() => clearTimeout(timer));
      let changed = false;
      for (const key of ["glm", "minimax"])
        if (!next[key].apiKey && imported[key]?.apiKey) {
          next[key] = { ...next[key], ...imported[key] };
          if (safeStorage.isEncryptionAvailable()) {
            next[key].encryptedKey = safeStorage
              .encryptString(next[key].apiKey)
              .toString("base64");
            changed = true;
          }
        }
      if (changed) await writeConfigs(next);
    }
    configs = next;
    return next;
  })();
  try {
    return await configLoading;
  } finally {
    configLoading = undefined;
  }
}
function publicConfigs(c) {
  return Object.fromEntries(
    Object.entries(c).map(([k, v]) => [
      k,
      {
        provider: k,
        model: v.model,
        baseUrl: v.baseUrl,
        hasKey: Boolean(v.apiKey),
        limits: v.limits,
        limitKey: v.limitKey,
        capabilities: modelCapabilities(v),
      },
    ]),
  );
}
// 故事事件视图的唯一适配层：入参/出参均为可 JSON 序列化的纯数据。
// renderer 不直接 import runtime（含 node:crypto），建图、失效传播与子图查询都在这里调纯函数。
function storyEventsView(project, query = {}) {
  const chapters = (project.chapters || []).map((c) => ({
    id: c.id,
    number: c.number,
    title: c.title,
    content: c.content,
  }));
  const warnings = [];
  const raw = project.storyEvents;
  let graph;
  if (raw === undefined || raw === null) {
    graph = emptyStoryEvents();
    warnings.push(
      "尚未建立事件链：这部作品还没有抽取过故事事件，事件图是空的，不代表故事里没有事件。",
    );
  } else {
    // 已落盘的图在保存时已通过 storyEventsSchema 校验，读取时不再用空章节表重跑
    // normalizeStoryEvents —— 那会把 explicit 边按“证据无法核对”丢弃，等于静默隐藏连线。
    // 这里只做两件事：补齐缺省字段（老数据兼容）与按当前正文复算 stale。
    graph = {
      version: 1,
      nodes: (raw.nodes || []).map((n) => ({
        ...n,
        review: n.review ?? { state: "unreviewed", note: "", at: null },
        stale: n.stale ?? null,
      })),
      edges: (raw.edges || []).map((e) => ({
        ...e,
        review: e.review ?? { state: "unreviewed", note: "", at: null },
        stale: e.stale ?? null,
      })),
      coverage: raw.coverage || [],
      issues: raw.issues || [],
    };
    if (chapters.some((c) => c.content.trim()))
      graph = impactOf(graph, { chapters }).storyEvents;
  }
  const candidateNodes = [];
  const candidateEdges = [];
  // R8-UI：候选自带的问题与正式图 graph.issues 分开存放，绝不合并。
  const candidateIssues = [];
  const missingEvidence = [];
  const formalNodeIds = new Set(graph.nodes.map((n) => n.id));
  const formalEdgeIds = new Set(graph.edges.map((e) => e.id));
  let overlapping = 0;
  for (const message of project.messages || []) {
    if (message.status !== "pending") continue;
    const patch = message.proposal?.storyEvents;
    if (!patch) continue;
    // R1：预览也用"候选最终正文视图"核验引文，与采纳路径同源。
    // 否则空白章候选在预览里看不到事件，采纳后却能出现，前后不一致。
    const previewChapters = proposedChapters(project, message.proposal).map(
      (c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        content: c.content,
      }),
    );
    // 候选增量只有内容与原文依据，id/章号/章名一律由 runtime 分配。
    // F8：候选可以引用正式历史事件做关系端点（如第一章交钥匙→第二章开门）。
    // previewStoryEvents 把正式图已有节点 id 作为已知端点传入临时视图，
    // 让跨章边在预览中可见；它只读 formalNodes，绝不把候选写回正式图。
    const preview = previewStoryEvents({
      formalNodes: graph.nodes,
      patch,
      chapters: previewChapters.filter((c) => c.content.trim()),
    });
    const built = { storyEvents: preview.graph };
    for (const node of built.storyEvents.nodes) {
      if (formalNodeIds.has(node.id)) {
        overlapping += 1;
        continue;
      }
      candidateNodes.push({
        ...node,
        origin: { messageId: message.id, model: message.model || "" },
      });
    }
    for (const edge of built.storyEvents.edges) {
      if (formalEdgeIds.has(edge.id)) {
        overlapping += 1;
        continue;
      }
      candidateEdges.push({ ...edge, origin: { messageId: message.id } });
    }
    // 候选问题来自 proposal.storyEvents.issues。
    // issue.nodeIds 可能指向本次候选新事件，也可能指向已有正式历史事件（跨章问题），
    // 因此先查候选图，再退回正式图；两边都没有才留空并在下方提示。
    const evidenceByNode = new Map(
      built.storyEvents.nodes.map((n) => [n.id, n.evidence]),
    );
    for (const node of graph.nodes)
      if (!evidenceByNode.has(node.id))
        evidenceByNode.set(node.id, node.evidence);
    for (const issue of patch.issues || []) {
      if (!issue || typeof issue.id !== "string") continue;
      const evidence = (issue.nodeIds || [])
        .map((nodeId) => evidenceByNode.get(nodeId))
        .filter(Boolean);
      if ((issue.nodeIds || []).length > 0 && evidence.length === 0)
        missingEvidence.push(issue.id);
      candidateIssues.push({
        ...issue,
        origin: { messageId: message.id, model: message.model || "" },
        evidence,
      });
    }
  }
  if (missingEvidence.length > 0)
    warnings.push(
      `有 ${missingEvidence.length} 条候选问题引用了当前事件图与候选图中都不存在的事件，已保留问题但无法显示原文。`,
    );
  if (overlapping > 0)
    warnings.push(
      `有 ${overlapping} 条候选与现有正式事件重合，已按重合处理，不重复显示。`,
    );
  const focus = {
    eventId: typeof query?.focusEventId === "string" ? query.focusEventId : null,
    direction: ["up", "down", "both"].includes(query?.direction)
      ? query.direction
      : "both",
    depth: Number.isInteger(query?.depth)
      ? Math.min(Math.max(query.depth, 1), 6)
      : 1,
  };
  let view = { nodes: graph.nodes, edges: graph.edges, seeds: [] };
  if (focus.eventId && graph.nodes.some((n) => n.id === focus.eventId))
    view = storySubgraph(graph, {
      eventIds: [focus.eventId],
      depth: focus.depth,
      direction: focus.direction,
    });
  else if (focus.eventId)
    warnings.push("要聚焦的事件不在当前事件图中，可能已被重新抽取替换。");
  const coverageByChapter = new Map(
    (graph.coverage || []).map((c) => [c.chapterId, c.status]),
  );
  return {
    graph,
    view,
    candidates: {
      nodes: candidateNodes,
      edges: candidateEdges,
      issues: candidateIssues,
    },
    chapters: (project.chapters || []).map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      hasContent: Boolean(c.content.trim()),
      coverage: coverageByChapter.get(c.id) ?? null,
    })),
    focus,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      staleNodes: graph.nodes.filter((n) => n.stale).length,
      staleEdges: graph.edges.filter((e) => e.stale).length,
      candidates: candidateNodes.length,
      issues: (graph.issues || []).filter((i) => i.disposition === "open").length,
    },
    warnings,
  };
}
function handle(name, fn) {
  ipcMain.handle("studio:" + name, async (event, ...args) => {
    if (
      event.sender !== win?.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw new Error("无效的桌面调用来源");
    try {
      return await fn(...args);
    } catch (e) {
      if (e.name === "ZodError")
        throw new Error("数据格式不完整，请检查必填项、数字范围和人物关系。");
      throw e;
    }
  });
}
handle("load", (id) => serial(() => store.load(id)));
handle("memory", (id) => serial(async () => memoryView(await store.load(id))));
handle("story-events", (id, query) =>
  serial(async () => storyEventsView(await store.load(id), query)),
);
// F1：只读建图状态。绝不抽取、绝不调模型、绝不写作品。
// 界面打开事件页走这条；只有作者点「建立/补全事件图」才走 story-build 执行。
handle("story-build-status", (projectId, options) =>
  serial(async () => {
    if (typeof projectId !== "string") throw Error("缺少作品标识");
    const p = await store.load(projectId);
    return storyBuildStatus(p, options || {});
  }),
);
// R9：只改问题处理状态，不改正文。未知 issueId / 非法 decision 一律抛错，不许静默写。
const STORY_DECISIONS = ["kept", "dismissed", "author-decided"];
handle("decide-story-issue", (request) =>
  serial(async () => {
    const { projectId, issueId, decision, expectedRevision } = request || {};
    if (typeof projectId !== "string") throw Error("缺少作品标识");
    if (typeof issueId !== "string" || !issueId)
      throw Error("缺少问题标识");
    if (!STORY_DECISIONS.includes(decision))
      throw Error(
        `处理决定必须是 ${STORY_DECISIONS.join("/")}，收到「${decision}」。`,
      );
    const p = await store.load(projectId);
    if (Number.isInteger(expectedRevision) && p.revision !== expectedRevision)
      throw Error("作品已发生变化，请重新载入后再处理问题。");
    const graph = p.storyEvents;
    if (!graph) throw Error("这部作品还没有事件图，无法处理问题。");
    if (!(graph.issues || []).some((i) => i.id === issueId))
      throw Error("问题不存在或已被重新抽取替换，请刷新后重试。");
    const next = setIssueDisposition(graph, issueId, decision);
    // 只许改 issues[i].disposition：nodes/edges/coverage 必须逐字不变，
    // 才能确证这次操作没有动到事件图结构（进而没有借道改正文）。
    const strip = (g) =>
      JSON.stringify({
        n: g.nodes || [],
        e: g.edges || [],
        c: g.coverage || [],
      });
    if (strip(next) !== strip(graph))
      throw Error("内部错误：处理问题不应改动事件图或正文。");
    // 正文同样复核：章节 id 与内容必须完全一致。
    const manuscript = JSON.stringify(
      p.chapters.map((c) => [c.id, c.content]),
    );
    const candidate = { ...p, storyEvents: next, projectId };
    if (
      JSON.stringify(candidate.chapters.map((c) => [c.id, c.content])) !==
      manuscript
    )
      throw Error("内部错误：处理问题不应改动正文。");
    const saved = await store.save(candidate, p.revision);
    return saved.storyEvents;
  }),
);
handle("logs", (id, options) =>
  serial(async () =>
    readCreationLogs(
      await store.runtimeDirectoryFor(id),
      await store.load(id),
      options,
      !!active,
    ),
  ),
);
handle("log-node", (id, taskId, nodeId) =>
  serial(async () =>
    readCreationLogNode(
      await store.runtimeDirectoryFor(id),
      await store.load(id),
      taskId,
      nodeId,
      !!active,
    ),
  ),
);
handle("task", (id) =>
  serial(async () => {
    const p = await store.load(id);
    const state = await new Checkpoint(
      await store.runtimeDirectoryFor(id),
    ).read();
    if (!state) return null;
    const taskView = reviewTaskState(state, !!active);
    const workspace = draftWorkspaceView(state);
    const status =
      state.status !== "completed" && state.base !== baseFingerprint(p)
        ? "stale"
        : taskView.status;
    return {
      id: state.id,
      status,
      stage: state.stage,
      error: state.error || "",
      chapterId: state.chapterId,
      review: status === "stale" ? null : taskView.review,
      reviewProgress: taskView.reviewProgress,
      workspace: workspace
        ? {
            ...workspace,
            canGuide: !active && state.base === baseFingerprint(p),
          }
        : null,
      updatedAt: state.updatedAt,
      manifest: state.manifest,
      draft: Object.entries(state.values)
        .filter(([k]) => /^final-scene:\d+$/.test(k))
        .sort(([a], [b]) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
        .map(([, text]) => text)
        .join("\n\n"),
      fragments: Object.entries(state.fragments)
        .filter(([k]) => k.startsWith("scene:"))
        .map(([key, text]) => ({ key, text })),
      resumable: status !== "stale" && taskView.resumable,
    };
  }),
);
handle("list", () => serial(() => store.list()));
const manage = (fn) =>
  serial(() => {
    if (active) throw new Error("请等待生成结束或停止任务后管理作品。");
    return fn();
  });
handle("select", (id) => manage(() => store.select(id)));
handle("create", (title) => manage(() => store.create(title)));
handle("rename", (id, title) => manage(() => store.rename(id, title)));
handle("archive", (id, archived) => manage(() => store.archive(id, archived)));
handle("rewrite-backups", (id) => serial(() => store.rewriteBackups(id)));
handle("rewrite", (id, revision, instruction) =>
  manage(() => store.rewrite(id, revision, instruction)),
);
handle("restore-rewrite", (id, backupId, revision) =>
  manage(() => store.restoreRewrite(id, backupId, revision)),
);
handle("save", (p, r) =>
  serial(async () => {
    if (typeof p?.projectId !== "string") throw Error("缺少作品标识");
    projectSchema.parse(p);
    const old = await store.load(p.projectId);
    for (const ch of old.chapters)
      if (
        ch.content &&
        !p.chapters.some((c) => c.id === ch.id && c.content === ch.content)
      )
        throw new Error("已有正文暂不支持修改。");
    for (const ch of p.chapters)
      if (
        ch.content &&
        !old.chapters.some((c) => c.id === ch.id && c.content === ch.content)
      )
        throw new Error("正文需要通过候选采纳。");
    const messages = p.messages.map((m) => {
      const prior = old.messages.find((x) => x.id === m.id);
      return prior
        ? {
            ...m,
            taskId: prior.taskId,
            createdAt: prior.createdAt,
            handledAt:
              prior.status === "pending" && m.status === "rejected"
                ? new Date().toISOString()
                : prior.handledAt,
          }
        : m;
    });
    return store.save(
      { ...p, messages, memory: old.memory, rewrite: old.rewrite },
      r,
    );
  }),
);
handle("accept", (projectId, id) =>
  serial(async () => {
    if (typeof projectId !== "string") throw Error("缺少作品标识");
    const p = await store.load(projectId);
    const m = p.messages.find((m) => m.id === id);
    if (!m?.proposal || m.status !== "pending")
      throw new Error("候选不存在或已经处理。");
    // R1：用"候选最终正文视图"核验事件引文——新章填入候选正文，改稿章按候选内容替换。
    // 否则空白章候选会出现正文可采纳、事件却因引文对不上旧正文而全丢。
    const finalChapters = proposedChapters(p, m.proposal);
    const merged = resolveProposalStoryEvents(
      projectWithChapters(p, finalChapters),
      m.proposal.storyEvents,
    );
    const next = applyProposal(
      p,
      merged ? { ...m.proposal, storyEvents: merged } : m.proposal,
      m.baseRevision,
    );
    next.messages = next.messages.map((x) =>
      x.id === id
        ? { ...x, status: "accepted", handledAt: new Date().toISOString() }
        : x,
    );
    return store.save({ ...next, projectId }, p.revision);
  }),
);
// R1：候选最终正文视图 = 现有章节中被 proposal.chapters 覆盖的章用候选内容替换，其余原样。
// 事件引文必须按这个视图核验，否则空白章候选会出现"正文能采纳、事件全被丢弃"。
function proposedChapters(project, proposal) {
  const incoming = new Map(
    (proposal?.chapters || []).map((chapter) => [chapter.id, chapter]),
  );
  return (project.chapters || []).map((chapter) => {
    const next = incoming.get(chapter.id);
    if (!next) return chapter;
    return {
      ...chapter,
      number: Number.isInteger(next.number) ? next.number : chapter.number,
      title: typeof next.title === "string" ? next.title : chapter.title,
      summary: typeof next.summary === "string" ? next.summary : chapter.summary,
      content: typeof next.content === "string" ? next.content : chapter.content,
    };
  });
}

// 交给 runtime 的作品形状：正文换成最终视图，其余不动。
function projectWithChapters(project, chapters) {
  return { ...project, chapters };
}

// 模型传输接缝：正常桌面走全局 fetch。
// 验收可在主进程内部替换：显式注入优先，其次读取 NOVEL_E2E_MODEL_STUB
// 指向的替身文件（仅非打包环境生效，生产包完全忽略）。
// 注入入口只存在于主进程内部，IPC 参数永不携带函数。
async function modelTransport() {
  const { fetch: transport } = await resolveModelTransport({
    isPackaged: app.isPackaged,
  });
  return transport;
}

// R7/F1：对已采纳正文建立/补全派生事件图。只写 storyEvents，绝不改正文。
// 模型通道由主进程按当前供应商配置自行构造；IPC 不传函数，
// 因此真实桌面按钮可用，而不是只有注入 ask 的测试路径能用。
handle("story-build", (projectId, options) =>
  serial(async () => {
    if (typeof projectId !== "string") throw Error("缺少作品标识");
    // 执行入口必须由界面显式声明模式；只读状态查询请走 story-build-status。
    if (options?.mode !== "build" && options?.mode !== "complete")
      throw Error(
        "建立事件图需要显式模式（build 或 complete）。只查看进度请调用只读状态接口。",
      );
    const p = await store.load(projectId);
    const hasContent = (p.chapters || []).some((c) => c.content.trim());
    if (!hasContent) throw Error("作品还没有已采纳正文，无法建立事件图。");
    // 目标章：显式 chapterIds 优先；mode=complete 时只补未完成的章，不重做已抽取章。
    const coverage = new Map(
      (p.storyEvents?.coverage || []).map((e) => [e.chapterId, e.status]),
    );
    let chapterIds = Array.isArray(options?.chapters)
      ? options.chapters
      : undefined;
    if (!chapterIds && options?.mode === "complete")
      chapterIds = (p.chapters || [])
        .filter((c) => c.content.trim())
        .filter((c) => coverage.get(c.id) !== "extracted")
        .map((c) => c.id);
    const manuscript = JSON.stringify(
      (p.chapters || []).map((c) => [c.id, c.content]),
    );
    // 供应商：显式字符串参数优先，否则自动选已配置的那个；参数必须可序列化。
    const { provider, config } = resolveStoryProvider(
      await loadConfig(),
      typeof options?.provider === "string" ? options.provider : undefined,
    );
    // 注入只用于主进程内部验收，正常桌面路径不会带；两者走同一个业务入口。
    const { ask, source } = resolveStoryEventAsk({
      injected: typeof options?.ask === "function" ? options.ask : undefined,
      config,
      signal: undefined,
      callComplete: async (cfg, messages, signal, fetcher, tokens) =>
        complete(cfg, messages, signal, await modelTransport(), tokens),
    });
    const result = await extractStoryEvents(p, ask, {
      chapterIds,
      model:
        typeof options?.model === "string"
          ? options.model
          : config.model || "",
      maxChars: Number.isInteger(options?.maxChars) ? options.maxChars : 4000,
    });
    if (
      JSON.stringify((p.chapters || []).map((c) => [c.id, c.content])) !==
      manuscript
    )
      throw Error("内部错误：建立事件图不应改动正文。");
    // 作者已有的处理决定不能被重跑抹掉。
    const decided = new Map(
      (p.storyEvents?.issues || [])
        .filter((i) => i.disposition && i.disposition !== "open")
        .map((i) => [i.id, i.disposition]),
    );
    const storyEvents = {
      ...result.storyEvents,
      issues: (result.storyEvents.issues || []).map((issue) =>
        decided.has(issue.id)
          ? { ...issue, disposition: decided.get(issue.id) }
          : issue,
      ),
    };
    const saved = await store.save(
      { ...p, storyEvents, projectId },
      p.revision,
    );
    return {
      ...storyBuildStatus(saved, options),
      provider,
      channel: source,
      failures: result.failures || [],
    };
  }),
);
handle("settings", async () => publicConfigs(await loadConfig()));
handle("save-settings", async (c) => {
  validateProvider(c);
  const all = await loadConfig();
  let encryptedKey = all[c.provider].encryptedKey;
  if (c.apiKey) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，密钥未保存。");
    encryptedKey = safeStorage.encryptString(c.apiKey).toString("base64");
  }
  const next = {
    ...all,
    [c.provider]: {
      ...all[c.provider],
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey || all[c.provider].apiKey,
      encryptedKey,
      limits: validateLimits(c.limits || {}),
      limitKey: capabilityKey(c),
    },
  };
  await writeConfigs(next);
  configs = next;
  return publicConfigs(next);
});
handle("test", async (provider) => {
  if (!["glm", "minimax"].includes(provider)) throw new Error("无效供应商");
  const c = (await loadConfig())[provider];
  const r = await complete(
    c,
    [{ role: "user", content: "仅回复：连接成功" }],
    AbortSignal.timeout(60000),
    fetch,
    1024,
  );
  return { model: r.model, text: "模型接口连接成功", usage: r.usage };
});
handle("generate", async (req) => {
  if (active) throw new Error("已有任务运行中，请等待或停止。");
  const controller = new AbortController();
  active = controller;
  try {
    return await executeGenerate(req, controller);
  } finally {
    active = null;
  }
});
async function executeGenerate(req, controller) {
  if (
    !["glm", "minimax"].includes(req.provider) ||
    typeof req.instruction !== "string"
  )
    throw new Error("无效生成请求");
  if (typeof req.projectId !== "string") throw Error("缺少作品标识");
  if (
    req.instruction.length > 12000 ||
    (req.words !== undefined &&
      (!Number.isInteger(req.words) || req.words < 100 || req.words > 10000))
  )
    throw Error("请输入有效创作要求和100—10000的整数字数。");
  if (req.decision && !req.resume) throw Error("作者选择只能用于恢复原任务。");
  if (req.mode !== undefined && req.mode !== "memory")
    throw Error("无效任务类型。");
  let p = await serial(() => store.load(req.projectId));
  if (req.decision) {
    const previous = await new Checkpoint(
      await store.runtimeDirectoryFor(req.projectId),
    ).read();
    // 收讫答复允许携带第一次发送时的 revision；它只返回当前作品，不再执行写作。
    if (
      previous?.base === baseFingerprint(p) &&
      previous.provider === req.provider &&
      isReviewDecisionReplay(previous, req.decision)
    )
      return p;
  }
  const runDir = await store.runtimeDirectoryFor(req.projectId);
  const oldTask = await new Checkpoint(runDir).read();
  const repeatAction =
    req.authorAction ||
    (req.resume &&
      req.authorInterventionId &&
      oldTask?.authorActions?.find((a) => a.id === req.authorInterventionId)
        ?.action);
  if (
    repeatAction &&
    oldTask?.base === baseFingerprint(p) &&
    oldTask.provider === req.provider &&
    isDraftActionReplay(oldTask, repeatAction, req.instruction || "")
  )
    return p;
  if (req.revision !== p.revision) throw new Error("作品版本已变化，请重试。");
  const guiding =
    !!req.authorAction ||
    !!(
      req.resume &&
      req.authorInterventionId &&
      oldTask &&
      draftScenes(oldTask).length
    );
  if (
    p.messages.some(
      (m) => m.status === "pending" && (!guiding || m.taskId !== oldTask?.id),
    )
  )
    throw new Error("请先采纳或放弃其他任务的方案。");
  // 长篇创作和分批审稿不自动超时，由作者点击停止或关闭窗口取消。
  const signal = controller.signal;
  const started = Date.now();
  const runId = crypto.randomUUID();
  const record = async (details) => {
    try {
      await mkdir(join(runDir, "runs"), { recursive: true });
      await writeFile(
        join(runDir, "runs", runId + ".json"),
        JSON.stringify(
          {
            runId,
            projectId: req.projectId,
            at: new Date().toISOString(),
            durationMs: Date.now() - started,
            provider: req.provider,
            baseRevision: p.revision,
            ...details,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {}
  };
  const send = (text) => {
    if (!win?.isDestroyed()) win.webContents.send("studio:progress", text);
  };
  const checkpoint = new Checkpoint(runDir);
  let checkpointState;
  const syncReviewMessages = () =>
    serial(async () => {
      const latest = await store.load(req.projectId);
      if (
        latest.revision !== p.revision ||
        baseFingerprint(latest) !== checkpointState.base
      )
        throw Error("作品已变化，不能将旧任务问答写入当前作品。");
      const turns = (checkpointState.reviewConversation || []).filter(
        (m) => !latest.messages.some((x) => x.id === m.id),
      );
      if (!turns.length) return latest;
      return store.save(
        { ...latest, messages: [...latest.messages, ...turns] },
        latest.revision,
      );
    });
  try {
    const config = (await loadConfig())[req.provider];
    checkpointState = await checkpoint.begin(p, req, config);
    if (checkpointState.authorReplay) return p;
    if (guiding && p.messages.some((m) => m.status === "pending")) {
      p = await serial(async () => {
        const latest = await store.load(req.projectId);
        if (latest.revision !== p.revision)
          throw Error("作品版本已变化，请重新操作。");
        return store.save(
          {
            ...latest,
            messages: latest.messages.map((m) =>
              m.status === "pending" && m.taskId === checkpointState.id
                ? {
                    ...m,
                    status: "rejected",
                    handledAt: new Date().toISOString(),
                  }
                : m,
            ),
          },
          latest.revision,
        );
      });
    }
    p = await syncReviewMessages();
    if (
      checkpointState.decisionReplay ||
      checkpointState.status === "awaiting_input"
    )
      return p;
    const retrieval = new StoryVectorIndex(runDir, embed);
    let generated;
    try {
      generated = await runChapterAgent(
        p,
        config,
        signal,
        send,
        checkpoint,
        checkpointState,
        // 同一个传输出口：正常桌面用全局 fetch，验收可在主进程内部替换。
        await modelTransport(),
        { retrieval },
      );
    } finally {
      retrieval.close();
    }
    if (generated.draftOnly) {
      await record({
        status: checkpointState.status,
        stage: checkpointState.stage,
        calls: checkpointState.calls,
      });
      return await syncReviewMessages();
    }
    const legacyBaseCalls = checkpointState.calls;
    const result = generated.legacy
      ? await runAgent(
          p,
          req.instruction,
          (await loadConfig())[req.provider],
          signal,
          send,
          fetch,
          {
            resolvedTask: generated.task,
            onTrace: async (record) => {
              const id = `call-${legacyBaseCalls + record.sequence}`;
              const records = (checkpointState.modelCalls ??= []);
              const index = records.findIndex((item) => item.id === id);
              const value = { ...record, id };
              if (index < 0) records.push(value);
              else records[index] = value;
              checkpointState.calls = legacyBaseCalls + record.sequence;
              checkpointState.updatedAt = new Date().toISOString();
              await checkpoint.write(checkpointState);
            },
            onLog: async (event) => {
              checkpointState.stage = event.title;
              if (typeof event.details?.调用次数 === "number")
                checkpointState.calls =
                  legacyBaseCalls + event.details.调用次数;
              appendCreationEvent(checkpointState, event);
              await checkpoint.write(checkpointState);
            },
            onArtifact: async (artifact) => {
              appendCreationEvent(checkpointState, {
                status: "success",
                title: `规划与讨论结果已保存：${artifact.stage}`,
                details: { 调用次数: artifact.calls },
              });
              await checkpoint.write(checkpointState);
              const directory = join(runDir, "runs", runId);
              await mkdir(directory, { recursive: true });
              await writeFile(
                join(directory, `${artifact.sequence}.json`),
                JSON.stringify(artifact, null, 2),
                { mode: 0o600 },
              );
            },
          },
        )
      : generated;
    if (generated.legacy) {
      checkpointState.calls = legacyBaseCalls + result.calls;
      checkpointState.usages.push(...result.usages);
    }
    signal.throwIfAborted();
    p = await syncReviewMessages();
    return await serial(async () => {
      signal.throwIfAborted();
      const latest = await store.load(req.projectId);
      if (latest.revision !== p.revision)
        throw new Error(
          "生成期间作品发生变化，结果未写入。请基于最新设定重新生成。",
        );
      if (result.memoryOnly) {
        const saved = await store.save(
          { ...latest, memory: result.memoryOnly },
          latest.revision,
        );
        checkpointState.status = "completed";
        appendCreationEvent(checkpointState, {
          category: "memory",
          status: "success",
          title: "已采纳正文的记忆索引已保存",
          details: { 索引片段: result.memoryOnly.entries.length },
        });
        await checkpoint.write(checkpointState);
        await record({
          status: "completed",
          calls: result.calls,
          usages: result.usages,
          promptVersion: result.promptVersion,
        });
        return saved;
      }
      const assistant = {
        id: crypto.randomUUID(),
        taskId: checkpointState.id,
        createdAt: new Date().toISOString(),
        role: "assistant",
        text: result.proposal.summary,
        proposal: result.proposal,
        baseRevision: p.revision + 1,
        status: Object.keys(result.proposal).some((k) => k !== "summary")
          ? "pending"
          : "accepted",
        model: result.model,
      };
      const next = {
        ...latest,
        messages: [
          ...latest.messages,
          ...(req.decision || guiding
            ? []
            : [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  text: req.instruction,
                },
              ]),
          assistant,
        ],
      };
      const saved = await store.save(next, latest.revision);
      checkpointState.candidateId = assistant.id;
      checkpointState.status = "completed";
      await checkpoint.write(checkpointState);
      await record({
        status: "completed",
        model: result.model,
        calls: result.calls,
        usages: result.usages,
        promptVersion: result.promptVersion,
        candidateId: assistant.id,
      });
      await writeFile(
        join(runDir, "last-run.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            durationMs: Date.now() - started,
            status: "completed",
            model: result.model,
            calls: result.calls,
            usages: result.usages,
            promptVersion: result.promptVersion,
          },
          null,
          2,
        ),
      ).catch(() => {});
      return saved;
    });
  } catch (e) {
    if (e.name === "ReviewRetryableError" && !signal.aborted) {
      checkpointState.status = "retryable";
      addRecoveryMessage(checkpointState);
      await checkpoint.write(checkpointState);
      await record({
        status: "retryable",
        stage: checkpointState.reviewWorkflow.phase,
        error: e.message,
        calls: checkpointState.calls,
      });
      return await syncReviewMessages();
    }
    if (e.name === "WaitingForAuthor" && !signal.aborted) {
      await record({ status: "awaiting_input", calls: checkpointState.calls });
      return await syncReviewMessages();
    }
    if (checkpointState && checkpointState.status !== "completed") {
      checkpointState.status = signal.aborted ? "interrupted" : "failed";
      checkpointState.error = e.message;
      await checkpoint.write(checkpointState);
    }
    await record({
      status: signal.aborted ? "cancelled" : "failed",
      error: signal.aborted ? "任务中断" : e.message,
      calls: e.details?.calls ?? null,
      usages: e.details?.usages ?? null,
      diagnostics: e.details ?? null,
    });
    if (signal.aborted) throw new Error("任务已停止，作品未改变。");
    throw e;
  }
}
handle("cancel", () => {
  active?.abort();
});
handle("export", async (projectId, format = "json") => {
  if (typeof projectId !== "string") throw Error("缺少作品标识");
  const p = await serial(() => store.load(projectId));
  const output = projectExport(p, format);
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: output.filename,
    filters: [
      {
        name: format === "md" ? "作品正文 Markdown" : "作品 JSON",
        extensions: [format],
      },
    ],
  });
  if (!filePath) return false;
  await writeFile(filePath, output.content, { mode: 0o600 });
  return true;
});
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
function createWindow() {
  if (!primaryInstance) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "小说工作室",
        submenu: [
          { label: "关于小说工作室", role: "about" },
          { type: "separator" },
          { label: "隐藏小说工作室", role: "hide" },
          { label: "退出", role: "quit" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { label: "撤销", role: "undo" },
          { label: "重做", role: "redo" },
          { type: "separator" },
          { label: "剪切", role: "cut" },
          { label: "复制", role: "copy" },
          { label: "粘贴", role: "paste" },
          { label: "全选", role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { label: "重新载入", role: "reload" },
          { label: "切换全屏", role: "togglefullscreen" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { label: "最小化", role: "minimize" },
          { label: "关闭窗口", role: "close" },
        ],
      },
    ]),
  );
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 740,
    title: `小说工作室 · ${buildInfo.displayVersion}`,
    backgroundColor: "#101719",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(root, "electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadURL(pathToFileURL(join(root, "dist/index.html")).href);
  win.on("closed", () => {
    active?.abort();
  });
}
app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
