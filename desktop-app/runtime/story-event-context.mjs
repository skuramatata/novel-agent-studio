import { storySubgraph } from "./story-events.mjs";

const MAX_NODES = 24;
const MAX_EDGES = 40;

const compactNode = (node) => ({
  id: node.id,
  chapterId: node.chapterId,
  chapterNumber: node.chapterNumber,
  chapterTitle: node.chapterTitle,
  storyTime: node.storyTime,
  title: node.title,
  summary: node.summary,
  kind: node.kind,
  actors: node.actors,
  objects: node.objects,
  status: node.status,
  basis: node.basis,
  stale: node.stale,
  quote: node.evidence.quote,
});

const compactEdge = (edge) => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  type: edge.type,
  basis: edge.basis,
  explanation: edge.explanation,
  stale: edge.stale,
  quote: edge.evidence[0]?.quote ?? "",
});

// 规划前/写作中的事件链上下文：与界面共用同一份节点与边，不另造派生素材。
export function storyEventContext(project, target, { instruction = "", depth = 1 } = {}) {
  const graph = project.storyEvents;
  const coverage = (graph?.coverage || []).map((c) => ({
    chapterId: c.chapterId,
    status: c.status,
    parts: c.parts,
    failure: c.failure,
  }));
  if (target) {
    const known = coverage.some((c) => c.chapterId === target.id);
    const chapter = project.chapters?.find((c) => c.id === target.id);
    if (!known)
      coverage.push({
        chapterId: target.id,
        status: chapter?.content?.trim() ? "pending" : "pending",
        parts: [],
        failure: null,
      });
  }
  const coveredChapterIds = new Set(
    coverage.filter((c) => c.status === "extracted").map((c) => c.chapterId),
  );
  const query = [
    instruction,
    target?.summary ?? "",
    ...(project.characters || [])
      .filter((c) => (instruction + (target?.summary ?? "")).includes(c.name))
      .map((c) => c.name),
  ]
    .join(" ")
    .trim();
  const names = (project.characters || [])
    .map((c) => c.name)
    .filter((name) => query.includes(name));
  // 先以当前章与人物/物件为种子扩展前因后果；
  // 再用查询词命中的历史事件补齐，避免"只按当前章"把跨章线索全滤掉。
  const byQuery = graph
    ? graph.nodes.filter((node) =>
        [node.title, node.summary, ...node.actors, ...node.objects].some(
          (field) => field && query.includes(field),
        ),
      )
    : [];
  const seeds = new Set(byQuery.map((n) => n.id));
  const sub = graph
    ? storySubgraph(graph, {
        chapterIds: [
          ...(target ? [target.id] : []),
          ...byQuery.map((n) => n.chapterId),
        ],
        actors: names.length ? names : undefined,
        eventIds: [...seeds],
        depth,
        direction: "both",
      })
    : { nodes: [], edges: [], seeds: [] };
  const totalMatched = sub.nodes.length;
  const totalEdges = sub.edges.length;
  const nodes = sub.nodes.slice(0, MAX_NODES);
  const keep = new Set(nodes.map((n) => n.id));
  const edges = sub.edges
    .filter((e) => keep.has(e.source) && keep.has(e.target))
    .slice(0, MAX_EDGES);
  // 被上限截掉的部分必须如实说明，不能把未装入的事件算作已覆盖。
  const truncated =
    totalMatched > nodes.length || totalEdges > edges.length;
  const eventNodes = nodes.map(compactNode);
  const eventEdges = edges.map(compactEdge);
  const currentChapterId = target?.id;
  // 沿用历史与本章新增互斥划分，二者之和等于返回节点数。
  const historicalEventIds = eventNodes
    .filter((n) => n.chapterId !== currentChapterId && n.status !== "candidate")
    .map((n) => n.id);
  const newEventIds = eventNodes
    .filter((n) => !historicalEventIds.includes(n.id))
    .map((n) => n.id);
  const staleCount =
    eventNodes.filter((n) => n.stale).length + eventEdges.filter((e) => e.stale).length;
  const uncovered = coverage.filter((c) => c.status !== "extracted");
  const truncationNote = truncated
    ? `本次按预算截断：命中 ${totalMatched} 个事件 / ${totalEdges} 条关系，实际装入 ${nodes.length} 个 / ${edges.length} 条，其余未装入，不能视为已覆盖或不存在。`
    : "";
  const missNote = eventNodes.length
    ? `本次按第${target?.number ?? "?"}章、人物与物件取到 ${eventNodes.length} 个事件、${eventEdges.length} 条关系；${truncationNote}事件链未命中部分不代表全书不存在，未覆盖章节：${
        uncovered.length
          ? uncovered.map((c) => `${c.chapterId}(${c.status})`).join("、")
          : "无"
      }。`
    : `事件链检索未命中任何事件；这只说明当前检索范围（章节/人物/物件/已抽取覆盖）内没有可用事件，不代表全书不存在该事件。未覆盖章节：${
        uncovered.length
          ? uncovered.map((c) => `${c.chapterId}(${c.status})`).join("、")
          : "无"
      }。`;
  return {
    coverage,
    coveredChapterIds: [...coveredChapterIds],
    eventNodes,
    eventEdges,
    totalMatched,
    totalEdges,
    truncated,
    historicalEventIds,
    newEventIds,
    staleCount,
    missNote,
    rules:
      "事件节点与关系来自与界面同一份 storyEvents：id 为稳定身份，跨章沿用同 id。沿用历史时必须引用已有节点 id；本章新增用新事件描述，不得伪称前文已有该事件。时间相邻或共享人物、物件不构成因果，causal 关系必须有原文依据或显式标 inferred/unverified。检索未命中不等于全书不存在。",
  };
}

export function storyEventContextBlock(project, target, options) {
  const view = storyEventContext(project, target, options);
  return {
    storyEvents: {
      coverage: view.coverage,
      nodes: view.eventNodes,
      edges: view.eventEdges,
      truncated: view.truncated,
      totalMatched: view.totalMatched,
      totalEdges: view.totalEdges,
      historicalEventIds: view.historicalEventIds,
      newEventIds: view.newEventIds,
      staleCount: view.staleCount,
      missNote: view.missNote,
      rules: view.rules,
    },
  };
}
