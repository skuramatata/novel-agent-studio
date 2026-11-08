import { complete } from "../runtime/providers.mjs";
import { extractStoryEvents } from "../runtime/story-event-agent.mjs";
import { parseStructured } from "../runtime/structured.mjs";
import { emptyStoryEvents, mergeStoryEvents } from "../runtime/story-events.mjs";

const PROVIDER_LABELS = { glm: "GLM", minimax: "MiniMax" };

// 建图执行所需的 ask 构造。
//
// 背景：Electron IPC 不能传函数，"要求调用方注入 ask"不能作为产品前提。
// 正常桌面路径由主进程按当前 provider 配置在这里构造 ask。它不是另一套抽取实现：
// 消息、validate（现有抽取路径传入的 extractionSchema 解析）、token 预算都由
// extractStoryEvents 决定，这里只负责「把 messages 发给模型并解析回 JSON」。
export function createStoryEventAsker({
  config,
  signal,
  callComplete = complete,
  maxTokens = 4000,
} = {}) {
  if (!config || typeof config !== "object")
    throw new Error(
      "尚未配置模型供应商，请先在设置中填写 API Key 与模型后再建立事件图。",
    );
  const label = PROVIDER_LABELS[config.provider] ?? config.provider ?? "模型";
  if (!config.model)
    throw new Error(`尚未选择${label}模型，请先在设置中选择模型后再建立事件图。`);
  if (!config.apiKey)
    throw new Error(`尚未配置${label}的 API Key，请先在设置中填写后再建立事件图。`);
  return async function ask(key, messages, validate, tokens, taskLabel) {
    const result = await callComplete(
      config,
      messages,
      signal,
      fetch,
      Number.isInteger(tokens) ? tokens : maxTokens,
    );
    const text = typeof result?.text === "string" ? result.text : "";
    if (!text.trim()) throw new Error(`${taskLabel ?? key} 未返回内容。`);
    return validate(parseStructured(text));
  };
}

// 唯一的建图执行入口：注入的 ask 与主进程自建的 ask 走同一条业务路径，
// 区别只在 ask 来源。injected 仅限进程内调用（测试/验收），IPC 参数不得携带函数。
export function resolveStoryEventAsk({
  injected,
  config,
  signal,
  callComplete = complete,
} = {}) {
  if (typeof injected === "function")
    return { ask: injected, source: "injected" };
  return {
    ask: createStoryEventAsker({ config, signal, callComplete }),
    source: "provider",
  };
}

// 从项目配置里挑出实际可用的供应商。
// 常见情况是用户只配了一个，因此按「显式指定 > 已配置 Key > 唯一有模型的」顺序取。
export function resolveStoryProvider(providers = {}, requested) {
  const entries = Object.entries(providers || {});
  if (requested) {
    const picked = providers?.[requested];
    if (!picked) throw new Error(`未找到模型供应商「${requested}」。`);
    if (!picked.apiKey)
      throw new Error(
        `尚未配置 ${PROVIDER_LABELS[requested] ?? requested} 的 API Key，请先在设置中填写后再建立事件图。`,
      );
    return { provider: requested, config: { ...picked, provider: requested } };
  }
  const configured = entries.filter(([, v]) => v?.apiKey && v?.model);
  if (!configured.length)
    throw new Error(
      "尚未配置可用的模型供应商，请先在设置中填写 API Key 与模型后再建立事件图。",
    );
  const [provider, config] = configured[0];
  return { provider, config: { ...config, provider } };
}

// 只读进度视图：只读作品，绝不触发模型、绝不写作品。
export function storyBuildStatus(project, options = {}) {
  const mode = options?.mode === "complete" ? "complete" : "build";
  const chapters = (project.chapters || []).map((c) => {
    const coverage = (project.storyEvents?.coverage || []).find(
      (entry) => entry.chapterId === c.id,
    );
    const eventCount = (project.storyEvents?.nodes || []).filter(
      (n) => n.chapterId === c.id,
    ).length;
    return {
      chapterId: c.id,
      chapterNumber: c.number,
      chapterTitle: c.title,
      hasContent: Boolean(c.content.trim()),
      status: coverage?.status ?? "pending",
      parts: coverage?.parts || [],
      eventCount,
      failure: coverage?.failure ?? null,
    };
  });
  const counts = {
    total: chapters.length,
    extracted: chapters.filter((c) => c.status === "extracted").length,
    partial: chapters.filter((c) => c.status === "partial").length,
    failed: chapters.filter((c) => c.status === "failed").length,
    pending: chapters.filter((c) => c.status === "pending").length,
  };
  const hasContent = (project.chapters || []).some((c) => c.content.trim());
  const state =
    counts.total === 0 || counts.extracted + counts.partial === 0
      ? "idle"
      : counts.extracted === counts.total
        ? "complete"
        : "partial";
  // H6：补全的目标章 = 有正文但尚未抽取完成。没有正文的章不可能被抽取，
  // 因此不计入待补，否则「全部有正文章节已抽取」永远会被判成还有活可干。
  const pendingTargetIds = chapters
    .filter((c) => c.hasContent && c.status !== "extracted")
    .map((c) => c.chapterId);
  return {
    enabled: true,
    state,
    mode,
    hasContent,
    chapters,
    counts,
    // H6：界面据此决定是否提供可执行的补全动作；既有字段语义不变。
    pendingTargets: pendingTargetIds.length,
    hasPendingTargets: pendingTargetIds.length > 0,
    failure: chapters.find((c) => c.failure)?.failure ?? null,
    touchesManuscript: false,
  };
}

// H6：把「这次要抽取哪些章」单独算清，只读、纯函数。
// mode=build 覆盖全部有正文的章；mode=complete 只补未完成章，
// 显式 chapterIds 优先（仍限定在有正文的章内，避免对空章发抽取请求）。
export function planStoryBuild(project, options = {}) {
  const chapters = (project.chapters || []).filter((c) => c.content.trim());
  const explicit = Array.isArray(options?.chapters)
    ? options.chapters
    : undefined;
  if (explicit) {
    const wanted = chapters
      .filter((c) => explicit.includes(c.id))
      .sort((a, b) => a.number - b.number)
      .map((c) => c.id);
    return { mode: "explicit", chapterIds: wanted, empty: wanted.length === 0 };
  }
  const mode = options?.mode === "complete" ? "complete" : "build";
  if (mode === "build") {
    const all = chapters.sort((a, b) => a.number - b.number).map((c) => c.id);
    return { mode, chapterIds: all, empty: all.length === 0 };
  }
  const coverage = new Map(
    (project.storyEvents?.coverage || []).map((e) => [e.chapterId, e.status]),
  );
  const missing = chapters
    .filter((c) => coverage.get(c.id) !== "extracted")
    .sort((a, b) => a.number - b.number)
    .map((c) => c.id);
  return { mode, chapterIds: missing, empty: missing.length === 0 };
}

// H6：story-build 的唯一执行入口。mode=complete 且筛选后没有目标章时，
// 直接返回当前只读状态并标记 skipped —— 不调模型、不写作品、不动 revision。
// resolveAsk 是懒工厂：只有确实存在目标章时才构造模型通道（读配置、解析供应商
// 都在工厂里），因此空路径连供应商配置都不会被读取。
export async function runStoryBuild({
  projectId,
  options,
  store,
  ask,
  resolveAsk,
  extract = extractStoryEvents,
} = {}) {
  if (typeof projectId !== "string") throw Error("缺少作品标识");
  // 执行入口必须由界面显式声明模式；只读状态查询请走 story-build-status。
  if (options?.mode !== "build" && options?.mode !== "complete")
    throw Error(
      "建立事件图需要显式模式（build 或 complete）。只查看进度请调用只读状态接口。",
    );
  const project = await store.load(projectId);
  const hasContent = (project.chapters || []).some((c) => c.content.trim());
  if (!hasContent) throw Error("作品还没有正文，无法建立事件图。");
  const plan = planStoryBuild(project, options);
  if (plan.empty) {
    // 契约：返回值始终是扁平 StoryBuildProgress，H6 信息只作为新增字段并入，
    // 既有调用方（界面 setBuild、验收脚本）读取 counts/chapters 不会变成 undefined。
    return {
      ...storyBuildStatus(project, options),
      skipped: true,
      skippedReason: "no-targets",
      targetChapterIds: [],
      failures: [],
      provider: null,
      channel: "none",
    };
  }
  const resolved =
    typeof ask === "function"
      ? { ask, source: "injected", provider: null }
      : await resolveAsk();
  const manuscript = JSON.stringify(
    (project.chapters || []).map((c) => [c.id, c.content]),
  );
  const result = await extract(project, resolved.ask, {
    chapterIds: plan.chapterIds,
    model: typeof options?.model === "string" ? options.model : "",
    maxChars: Number.isInteger(options?.maxChars) ? options.maxChars : 4000,
  });
  if (
    JSON.stringify((project.chapters || []).map((c) => [c.id, c.content])) !==
    manuscript
  )
    throw Error("内部错误：建立事件图不应改动正文。");
  // 作者已有的处理决定不能被重跑抹掉。
  const decided = new Map(
    (project.storyEvents?.issues || [])
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
    { ...project, storyEvents, projectId },
    project.revision,
  );
  return {
    ...storyBuildStatus(saved, options),
    skipped: false,
    skippedReason: null,
    targetChapterIds: plan.chapterIds,
    failures: result.failures || [],
    provider: resolved.provider ?? null,
    channel: resolved.source,
  };
}

// 候选预览的临时视图合并（F8）。
// 正式图节点 id 作为已知端点传入，让指向正式历史的跨章边在预览中可见。
// mergeStoryEvents 的 attachNodes 只在合并校验期使用，输出侧已由 runtime 剔除，
// 因此 graph.nodes 只含本轮候选事件；跨章边保留并指向正式事件 id。
// 界面若需要显示对端节点信息，用 referencedFormalNodes 查（它不在 nodes 里，
// 也就不会被当成候选新事件）；formalNodes 与正式图都不会被修改。
export function previewStoryEvents({ formalNodes = [], patch, chapters = [] } = {}) {
  const knownNodeIds = formalNodes.map((n) => n.id);
  const graph = mergeStoryEvents(emptyStoryEvents(), patch?.nodes || [], {
    chapters,
    edges: patch?.edges || [],
    knownNodeIds,
    attachNodes: formalNodes,
  }).storyEvents;
  // 只提供确实被跨章边引用到的正式节点，供界面按 id 查对端信息。
  const formalById = new Map(formalNodes.map((n) => [n.id, n]));
  const referenced = new Set();
  for (const edge of graph.edges) {
    if (!formalById.has(edge.source)) continue;
    referenced.add(edge.source);
  }
  for (const edge of graph.edges) {
    if (formalById.has(edge.target)) referenced.add(edge.target);
  }
  const referencedFormalNodes = [...referenced].map((id) => formalById.get(id));
  return {
    graph,
    knownNodeIds,
    referencedFormalNodes,
    referencedFormalNodeIds: [...referenced],
  };
}
