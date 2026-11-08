import { useCallback, useEffect, useMemo, useState } from "react";
import { bridge } from "../lib/bridge";
import { useStudio } from "../state/StudioContext";
import type {
  StoryBuildProgress,
  StoryCandidateIssue,
  StoryDirection,
  StoryEventEdge,
  StoryEventNode,
  StoryEventQuery,
  StoryEventStatus,
  StoryEventView,
  StoryIssue,
  StoryIssueDecision,
  StoryRevisionRequest,
} from "../lib/types";

// ---- R7/R9/R8 展示层纯函数（不依赖 IPC，可单独验证） ----

// R7：建图入口文案。有正文无图=建立；已部分建图=补全；无正文=不可建。
export function storyBuildLabel(progress: StoryBuildProgress | null): string {
  if (!progress) return "建立事件图";
  if (!progress.hasContent) return "先写正文，再建立事件图";
  if (progress.counts.extracted === 0 && progress.counts.partial === 0)
    return "建立事件图";
  if (progress.counts.extracted < progress.counts.total) return "补全事件图";
  return "重新建立事件图";
}

// G5：主动作按钮的语义。未建图=建立；已部分/全部建图=补全（只补未完成章）。
// 「重新建立」是独立的强制重建动作，不能和补全共用一个按钮。
export function primaryBuildMode(
  progress: StoryBuildProgress | null,
): "build" | "complete" {
  if (!progress) return "build";
  const done =
    progress.counts.extracted + progress.counts.partial + progress.counts.failed;
  return done === 0 ? "build" : "complete";
}

// G5：主动作按钮文案，与 primaryBuildMode 严格一致。
export function primaryBuildLabel(progress: StoryBuildProgress | null): string {
  return primaryBuildMode(progress) === "build" ? "建立事件图" : "补全事件图";
}

// G5：只有已经建过图（有覆盖记录）才允许"重新建立"，避免无意义全量重跑。
export function canRebuild(
  progress: StoryBuildProgress | null,
): boolean {
  if (!progress || !progress.enabled || !progress.hasContent) return false;
  if (progress.state === "running") return false;
  return progress.counts.extracted + progress.counts.partial > 0;
}

// R7：是否可以触发建图。未启用（浏览器预览）或没有正文时必须禁用。
export function canStartStoryBuild(progress: StoryBuildProgress | null): boolean {
  if (!progress) return false;
  if (!progress.enabled) return false;
  if (!progress.hasContent) return false;
  return progress.state !== "running";
}

// R7：进度文案要能如实区分四种覆盖状态，不能把"没读"说成"没有"。
export function storyBuildSummary(progress: StoryBuildProgress | null): string {
  if (!progress) return "尚未读取建图状态";
  if (progress.state === "unsupported")
    return progress.failure || "当前环境不支持建立事件图";
  if (progress.state === "running")
    return `正在建立事件图 · 已处理 ${progress.counts.extracted + progress.counts.partial}/${progress.counts.total} 章`;
  const parts = [
    `${progress.counts.extracted} 章已抽取`,
    progress.counts.partial > 0 ? `${progress.counts.partial} 章部分抽取` : "",
    progress.counts.failed > 0 ? `${progress.counts.failed} 章抽取失败` : "",
    progress.counts.pending > 0 ? `${progress.counts.pending} 章未抽取` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

// R9：作者决定动作。沿用 runtime 的 disposition 枚举，只暴露三个可操作项。
export const STORY_DECISION_ACTIONS: {
  decision: StoryIssueDecision;
  label: string;
  description: string;
}[] = [
  {
    decision: "kept",
    label: "保留",
    description: "保留这条问题记录，暂不处理。只改处理状态，不改正文。",
  },
  {
    decision: "dismissed",
    label: "驳回",
    description: "判定这不是问题，日后不再提示。只改处理状态，不改正文。",
  },
  {
    decision: "author-decided",
    label: "裁定",
    description: "由作者做最终判断并留档。只改处理状态，不改正文。",
  },
];

// R9：问题是否还能被作者处理。已处理过的不再重复提示为"待决定"。
export function issueNeedsDecision(issue: StoryIssue): boolean {
  return issue.disposition === "open";
}

// R9：显式修订请求。只组装请求体，交给既有草稿修订流程，不写正文。
export function buildRevisionRequest(
  issue: StoryIssue,
  node: StoryEventNode | null,
  instruction: string,
): StoryRevisionRequest | null {
  if (!node) return null;
  const trimmed = instruction.trim();
  if (!trimmed) return null;
  return {
    issueId: issue.id,
    chapterId: node.chapterId,
    chapterNumber: node.chapterNumber,
    chapterTitle: node.chapterTitle,
    explanation: issue.explanation,
    suggestion: issue.suggestion,
    evidence: [node.evidence],
    instruction: trimmed,
  };
}

// R8：候选问题与正式图问题分开统计，避免把候选缺口算进正式历史。
export function splitIssues(
  formal: StoryIssue[],
  candidates: StoryCandidateIssue[],
) {
  return {
    formal,
    candidates,
    formalOpen: formal.filter(issueNeedsDecision).length,
    candidateOpen: candidates.filter(issueNeedsDecision).length,
  };
}

export interface StoryFilters {
  chapterId: string;
  kind: string;
  status: string;
  staleOnly: boolean;
  reviewOnly: boolean;
  selectedActors: string[];
  selectedObjects: string[];
}

export const emptyFilters: StoryFilters = {
  chapterId: "",
  kind: "",
  status: "",
  staleOnly: false,
  reviewOnly: false,
  selectedActors: [],
  selectedObjects: [],
};

// 待核对判定只读运行时结论（review.state / stale），前端不自行推断。
export function needsReview(node: StoryEventNode) {
  return Boolean(
    node.stale ||
      node.review.state === "unreviewed" ||
      node.review.state === "flagged",
  );
}

function matchesNode(node: StoryEventNode, filters: StoryFilters) {
  if (filters.chapterId && node.chapterId !== filters.chapterId) return false;
  if (filters.kind && node.kind !== filters.kind) return false;
  if (filters.status && node.status !== filters.status) return false;
  if (filters.staleOnly && !node.stale) return false;
  if (filters.reviewOnly && !needsReview(node)) return false;
  if (
    filters.selectedActors.length &&
    !filters.selectedActors.some((a) => node.actors.includes(a))
  )
    return false;
  if (
    filters.selectedObjects.length &&
    !filters.selectedObjects.some((o) => node.objects.includes(o))
  )
    return false;
  return true;
}

export function useStoryEvents() {
  const { project, busy, refresh, generate } = useStudio();
  const [view, setView] = useState<StoryEventView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const [direction, setDirection] = useState<StoryDirection>("both");
  const [depth, setDepth] = useState(1);
  const [filters, setFilters] = useState<StoryFilters>(emptyFilters);
  // 候选默认叠加显示：需求要求“采纳前可检查”，只看横幅数量不算可检查。
  const [showCandidates, setShowCandidates] = useState(true);
  const [build, setBuild] = useState<StoryBuildProgress | null>(null);
  const [buildError, setBuildError] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");

  const query = useMemo<StoryEventQuery>(
    () => ({ focusEventId: focusEventId || undefined, direction, depth }),
    [focusEventId, direction, depth],
  );

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const refresh = async () => {
      try {
        const next = await bridge.storyEvents(project!.projectId, query);
        if (alive) {
          setView(next);
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) {
          setLoading(false);
          if (busy) timer = setTimeout(refresh, 2500);
        }
      }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project?.projectId, project?.revision, busy, query]);

  useEffect(() => {
    setFocusEventId(null);
    setFilters(emptyFilters);
    setBuild(null);
    setBuildError("");
    setDecisionError("");
  }, [project?.projectId]);

  // R7：建图进度与事件图一起刷新；进度读取失败不能静默，要能在界面说明。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await bridge.storyBuildStatus(project!.projectId);
        if (alive) {
          setBuild(next);
          setBuildError("");
        }
      } catch (e) {
        if (alive) setBuildError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [project?.projectId, project?.revision]);

  const nodesById = useMemo(() => {
    const map = new Map<string, StoryEventNode>(
      (view?.graph.nodes || []).map((n) => [n.id, n]),
    );
    for (const node of view?.candidates.nodes || [])
      if (!map.has(node.id)) map.set(node.id, node);
    return map;
  }, [view]);

  const filtered = useMemo(() => {
    if (!view) return { nodes: [] as StoryEventNode[], edges: [] as StoryEventEdge[] };
    const inView = new Set(view.view.nodes.map((n) => n.id));
    const formal = view.view.nodes.filter(
      (n) => inView.has(n.id) && matchesNode(n, filters),
    );
    const extra = showCandidates
      ? view.candidates.nodes.filter((n) => matchesNode(n, filters))
      : [];
    const seen = new Set(formal.map((n) => n.id));
    const nodes = [...formal, ...extra.filter((n) => !seen.has(n.id))];
    const kept = new Set(nodes.map((n) => n.id));
    // 边只在两端都保留时显示；被筛掉的边不隐藏成"没发生"，而是在统计里计数。
    const allEdges = showCandidates
      ? [...view.view.edges, ...view.candidates.edges]
      : view.view.edges;
    const edgeSeen = new Set<string>();
    const edges = allEdges.filter((e) => {
      if (!kept.has(e.source) || !kept.has(e.target)) return false;
      if (edgeSeen.has(e.id)) return false;
      edgeSeen.add(e.id);
      return true;
    });
    return { nodes, edges };
  }, [view, filters, showCandidates]);

  const chapterGroups = useMemo(() => {
    if (!view) return [];
    const byChapter = new Map<
      string,
      { id: string; number: number; title: string; nodes: StoryEventNode[] }
    >();
    for (const chapter of view.chapters)
      byChapter.set(chapter.id, { ...chapter, nodes: [] });
    for (const node of filtered.nodes) {
      const group = byChapter.get(node.chapterId);
      if (group) group.nodes.push(node);
    }
    return [...byChapter.values()]
      .map((g) => ({
        ...g,
        nodes: g.nodes.sort(
          (a, b) =>
            a.evidence.start - b.evidence.start ||
            a.narrativeOffset - b.narrativeOffset,
        ),
      }))
      .sort((a, b) => a.number - b.number);
  }, [view, filtered.nodes]);

  const toggleActor = useCallback((name: string) => {
    setFilters((f) => ({
      ...f,
      selectedActors: f.selectedActors.includes(name)
        ? f.selectedActors.filter((x) => x !== name)
        : [...f.selectedActors, name],
    }));
  }, []);

  const toggleObject = useCallback((name: string) => {
    setFilters((f) => ({
      ...f,
      selectedObjects: f.selectedObjects.includes(name)
        ? f.selectedObjects.filter((x) => x !== name)
        : [...f.selectedObjects, name],
    }));
  }, []);

  // R9：提交作者决定。写操作只经主进程 IPC，前端不改作品文件、不改正文。
  const decideIssue = useCallback(
    async (issueId: string, decision: StoryIssueDecision) => {
      setDeciding(true);
      setDecisionError("");
      try {
        const next = await bridge.decideStoryIssue({
          projectId: project!.projectId,
          issueId,
          decision,
        });
        setView((current) =>
          current ? { ...current, graph: next } : current,
        );
        // F9：主进程已把改动写入作品并递增 revision。只更新局部图会让
        // 共享 project 停留在旧 revision，后续保存/生成会被判版本冲突。
        // 这里同步整份共享状态（含 revision 与 storyEvents），不绕过版本校验。
        await refresh();
        return true;
      } catch (e) {
        setDecisionError((e as Error).message);
        return false;
      } finally {
        setDeciding(false);
      }
    },
    [project?.projectId, refresh],
  );

  // F10：显式修订。组装请求后交给既有章节生成流程（s.generate + chapterId + words），
  // 只产生草稿候选，未采纳不改正式正文；不新建绕过采纳的写入口。
  const requestRevision = useCallback(
    async (issue: StoryIssue, node: StoryEventNode | null, instruction: string) => {
      const request = buildRevisionRequest(issue, node, instruction);
      if (!request) {
        setDecisionError("请填写修订要求，并选择一条有原文依据的问题。");
        return false;
      }
      const words =
        node && project
          ? project.premise.chapterWords || 3000
          : 3000;
      const prompt = [
        `修订第${request.chapterNumber}章（${request.chapterTitle}）。`,
        `针对问题：${request.explanation}`,
        request.suggestion ? `原建议：${request.suggestion}` : "",
        `原文依据：「${request.evidence[0]?.quote ?? ""}」`,
        `作者要求：${request.instruction}`,
        "只按上述要求修订本章，不要改动其他章节。",
      ]
        .filter(Boolean)
        .join("\n");
      // F10：不能只把 generate 的返回值原样抛回。generate 失败时只写共享 error，
      // 问题面板读的是 decisionError，结果作者点了按钮却看不到任何反馈。
      // 因此这里按返回值分支，把可读原因落到本页的错误位上。
      // generate 内部按 current.current.revision 提交。若本页刚做过作者决定或采纳，
      // 共享状态可能还没同步到磁盘真值，会以"作品版本已变化"失败。
      // 先刷新一次共享作品，确保提交用的是最新 revision（不绕过版本校验）。
      await refresh();
      const started = await generate(prompt, {
        chapterId: request.chapterId,
        words,
      });
      if (!started) {
        setDecisionError(
          "未能生成修订候选：任务没有启动或已失败。请检查模型配置与当前是否有其他生成任务，或稍后重试。",
        );
        return false;
      }
      return true;
    },
    [project?.premise?.chapterWords, generate, refresh],
  );

  // R7：触发建图。失败不清空已有结果，也不重置作者决定（由主进程保证）。
  const startBuild = useCallback(
    async (mode: "build" | "complete") => {
      setBuildError("");
      try {
        const next = await bridge.storyBuild(project!.projectId, { mode });
        setBuild(next);
        // G4/F9 同源：建图会写作品并递增 revision，
        // 只更新局部 build 会让共享 project 停在旧 revision，后续保存被拒。
        await refresh();
        return next;
      } catch (e) {
        setBuildError((e as Error).message);
        return null;
      }
    },
    [project?.projectId, refresh],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<StoryEventStatus, number> = {
      confirmed: 0,
      candidate: 0,
      provisional: 0,
      conflict: 0,
    };
    for (const node of view?.graph.nodes || []) counts[node.status] += 1;
    return counts;
  }, [view]);

  return {
    view,
    error,
    loading,
    filters,
    setFilters,
    focusEventId,
    setFocusEventId,
    direction,
    setDirection,
    depth,
    setDepth,
    filtered,
    chapterGroups,
    nodesById,
    statusCounts,
    toggleActor,
    toggleObject,
    showCandidates,
    setShowCandidates,
    build,
    buildError,
    startBuild,
    deciding,
    decisionError,
    decideIssue,
    requestRevision,
  };
}
