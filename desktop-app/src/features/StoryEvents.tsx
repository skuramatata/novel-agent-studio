import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  type NodeProps,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Crosshair,
  EyeOff,
  Filter,
  Flag,
  GitBranch,
  HelpCircle,
  Layers,
  ListChecks,
  Maximize2,
  Quote,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  StoryCandidateIssue,
  StoryCoverageStatus,
  StoryIssueDecision,
  StoryEventEdge,
  StoryEventKind,
  StoryEventNode,
  StoryEventStatus,
  StoryEventView,
  StoryIssue,
} from "../lib/types";
import { isDesktop } from "../lib/bridge";
import {
  STORY_DECISION_ACTIONS,
  canRebuild,
  canStartStoryBuild,
  hasStoryBuildTargets,
  issueNeedsDecision,
  primaryBuildLabel,
  primaryBuildMode,
  storyBuildLabel,
  storyBuildSummary,
  needsReview,
  useStoryEvents,
} from "./useStoryEvents";
import "./story-events.css";

const kindLabels: Record<StoryEventKind, string> = {
  action: "行动",
  decision: "决定",
  discovery: "发现",
  handover: "转交",
  "state-change": "状态变化",
  recall: "回忆",
  other: "其他",
};

const statusLabels: Record<StoryEventStatus, string> = {
  confirmed: "已确认",
  candidate: "候选",
  provisional: "暂定",
  conflict: "矛盾",
};

const basisLabels: Record<string, string> = {
  narration: "叙述",
  testimony: "证词",
  document: "文书",
  belief: "信念",
  rumor: "传闻",
  author: "作者设定",
};

const edgeTypeLabels: Record<string, string> = {
  causal: "因果",
  knowledge: "知情",
  "state-transfer": "状态转移",
  recall: "回忆",
  foreshadow: "伏笔",
  payoff: "回收",
  support: "支持",
  contradict: "冲突",
  related: "相关",
};

const edgeBasisLabels: Record<string, string> = {
  explicit: "显式",
  inferred: "推断",
  "author-confirmed": "作者确认",
  unverified: "待核对",
};

const reviewLabels: Record<string, string> = {
  unreviewed: "未核对",
  checked: "已核对",
  flagged: "已标疑",
  "author-confirmed": "作者确认",
};

const coverageLabels: Record<StoryCoverageStatus, string> = {
  extracted: "已抽取",
  partial: "部分抽取",
  failed: "抽取失败",
  pending: "未抽取",
};

// 状态不只靠颜色：每个状态都有文字缩写与图标形状差异（色弱可读）。
const statusGlyph: Record<StoryEventStatus, string> = {
  confirmed: "●",
  candidate: "◇",
  provisional: "◐",
  conflict: "▲",
};

function EventNode({ data, selected }: NodeProps) {
  const d = data as {
    node: StoryEventNode;
    dimmed: boolean;
  };
  const node = d.node;
  const review = needsReview(node);
  return (
    <div
      className={[
        "sev-node",
        `sev-status-${node.status}`,
        node.stale ? "sev-stale" : "",
        selected ? "selected" : "",
        d.dimmed ? "dimmed" : "",
        review ? "sev-needs-review" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="sev-node-head">
        <span className="sev-chapter">
          第 {node.chapterNumber} 章 · {node.chapterTitle}
        </span>
        <span className={`sev-status sev-status-${node.status}`}>
          <i aria-hidden="true">{statusGlyph[node.status]}</i>
          {statusLabels[node.status]}
        </span>
      </div>
      <b className="sev-node-title">{node.title}</b>
      <div className="sev-node-meta">
        <span>{kindLabels[node.kind]}</span>
        <span>·</span>
        <span>{basisLabels[node.basis] || node.basis}</span>
        {node.storyTime && (
          <>
            <span>·</span>
            <span>{node.storyTime}</span>
          </>
        )}
      </div>
      {node.actors.length > 0 && (
        <div className="sev-node-tags">
          {node.actors.slice(0, 3).map((a) => (
            <span key={a}>{a}</span>
          ))}
          {node.objects.slice(0, 2).map((o) => (
            <span className="sev-object" key={o}>
              {o}
            </span>
          ))}
        </div>
      )}
      {(node.stale || review) && (
        <div className="sev-node-flags">
          {node.stale && (
            <span className="sev-flag sev-flag-stale">
              <AlertTriangle size={11} />
              依据已失效
            </span>
          )}
          {!node.stale && node.review.state === "flagged" && (
            <span className="sev-flag sev-flag-flag">
              <Flag size={11} />
              已标疑
            </span>
          )}
          {!node.stale && node.review.state === "unreviewed" && (
            <span className="sev-flag sev-flag-review">
              <HelpCircle size={11} />
              待核对
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

const nodeTypes = { storyEvent: EventNode };

// 边样式：线型区分判断性质，颜色区分关系类型，标签写明两者文字，不只靠颜色。
function edgeAppearance(edge: StoryEventEdge) {
  const dashed = edge.basis === "inferred" || edge.basis === "unverified";
  const color =
    edge.type === "contradict"
      ? "var(--danger)"
      : edge.type === "causal"
        ? "var(--accent)"
        : edge.stale
          ? "var(--warning)"
          : "var(--muted)";
  const strokeDasharray = edge.stale
    ? "2 4"
    : edge.basis === "inferred"
      ? "7 4"
      : edge.basis === "unverified"
        ? "3 3"
        : undefined;
  return {
    label: `${edgeTypeLabels[edge.type] || edge.type} · ${
      edgeBasisLabels[edge.basis] || edge.basis
    }`,
    style: {
      stroke: color,
      strokeWidth: edge.type === "causal" ? 2 : 1.5,
      strokeDasharray,
      opacity: dashed ? 0.95 : 1,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color },
    labelStyle: { fill: "var(--text)", fontSize: 10 },
    labelBgStyle: { fill: "var(--surface)" },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
  };
}

function EmptyStates({ view }: { view: StoryEventView }) {
  const covered = view.chapters.filter((c) => c.coverage === "extracted");
  const partial = view.chapters.filter((c) => c.coverage === "partial");
  const failed = view.chapters.filter((c) => c.coverage === "failed");
  const pending = view.chapters.filter(
    (c) => c.hasContent && (!c.coverage || c.coverage === "pending"),
  );
  // 还没有正文的章节：既不是"未抽取"，也不是有事件，必须单独说清。
  const emptyChapters = view.chapters.filter((c) => !c.hasContent);
  // 有事件但当前一片空白 = 筛选/聚焦造成，不是"没有事件链"，必须先说清。
  const filteredOut = view.counts.nodes > 0;
  return (
    <div className="sev-empty">
      <GitBranch size={34} />
      <h3>
        {filteredOut ? "当前条件下没有命中事件" : "还没有可显示的故事事件"}
      </h3>
      <p className="sev-empty-lead">
        {filteredOut
          ? `作品里已有 ${view.counts.nodes} 个正式事件，只是被当前筛选或聚焦范围排除了。`
          : "这不是「故事里没有事件」，而是下面三种情况之一，请按下表判断："}
      </p>
      <ul className="sev-empty-list">
        {filteredOut ? (
          <li className="sev-empty-ok">
            <ShieldCheck size={14} />
            <span>
              <b>筛选或聚焦排除了全部事件</b>
              ：请清除聚焦、放宽章节/类型/状态筛选，或取消「只看待核对」。
            </span>
          </li>
        ) : covered.length > 0 ? (
          <li className="sev-empty-ok">
            <ShieldCheck size={14} />
            <span>
              <b>{covered.length} 章已抽取</b>
              ：这些章有覆盖记录，但没有产出通过校验的事件。可能出处在当前正文中已无法定位。
            </span>
          </li>
        ) : (
          <li className="sev-empty-none">
            <EyeOff size={14} />
            <span>
              <b>尚未建立事件链</b>
              ：全书没有任何章节完成抽取。事件图是空的，属正常初始状态。
            </span>
          </li>
        )}
        {emptyChapters.length > 0 && (
          <li className="sev-empty-none">
            <EyeOff size={14} />
            <span>
              <b>本章还没有正文</b>：
              {emptyChapters.slice(0, 4).map((c) => `第 ${c.number} 章`).join("、")}
              {emptyChapters.length > 4 && " 等"} 尚未写或未采纳正文，因此无可抽取的事件。
            </span>
          </li>
        )}
        {(partial.length > 0 || pending.length > 0) && (
          <li className="sev-empty-partial">
            <Layers size={14} />
            <span>
              <b>本章未抽取完</b>：
              {partial.length > 0 && `${partial.length} 章部分抽取`}
              {partial.length > 0 && pending.length > 0 && "，"}
              {pending.length > 0 && `${pending.length} 章待抽取`}
              （{pending.slice(0, 4).map((c) => `第 ${c.number} 章`).join("、")}
              {pending.length > 4 && " 等"}）。缺的事件不是不存在，是还没读。
            </span>
          </li>
        )}
        {failed.length > 0 && (
          <li className="sev-empty-failed">
            <CircleAlert size={14} />
            <span>
              <b>抽取失败</b>：
              {failed.map((c) => `第 ${c.number} 章（${c.title}）`).join("、")}
              。失败章的事件缺失，需要重跑抽取，不能当作无事件。
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

function coverageText(status: StoryCoverageStatus | null) {
  return status ? coverageLabels[status] : "未抽取";
}

function ChapterRail({
  view,
  chapterGroups,
  filters,
  onChapter,
}: {
  view: StoryEventView;
  chapterGroups: { id: string; number: number; title: string; nodes: StoryEventNode[] }[];
  filters: { chapterId: string };
  onChapter: (id: string) => void;
}) {
  const stats = new Map(
    chapterGroups.map((g) => [g.id, { total: g.nodes.length }]),
  );
  return (
    <aside className="sev-rail" aria-label="章节覆盖">
      <div className="sev-rail-head">
        <span className="eyebrow">章节覆盖</span>
        <span className="small muted">{view.chapters.length} 章</span>
      </div>
      <button
        className={"sev-chapter-item " + (filters.chapterId === "" ? "active" : "")}
        onClick={() => onChapter("")}
      >
        <b>全书</b>
        <span>{view.counts.nodes} 个事件</span>
      </button>
      {view.chapters.map((c) => {
        const stat = stats.get(c.id);
        const state = c.coverage;
        return (
          <button
            key={c.id}
            className={
              "sev-chapter-item " + (filters.chapterId === c.id ? "active" : "")
            }
            onClick={() => onChapter(filters.chapterId === c.id ? "" : c.id)}
            title={`第 ${c.number} 章 ${c.title}｜${coverageText(state)}`}
          >
            <span className="sev-chapter-line">
              <b>
                第 {c.number} 章 · {c.title}
              </b>
            </span>
            <span className={`sev-cov sev-cov-${state || "none"}`}>
              {coverageText(state)}
              {stat ? ` · ${stat.total} 个` : ""}
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function EdgeInspector({
  edge,
  nodesById,
  onClose,
  onFocus,
}: {
  edge: StoryEventEdge;
  nodesById: Map<string, StoryEventNode>;
  onClose: () => void;
  onFocus: (id: string) => void;
}) {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  return (
    <>
      <div className="inspector-title">
        <h3>关系依据</h3>
        <button className="icon-button" aria-label="关闭关系详情" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="sev-badges">
        <span className="sev-badge sev-edge-type">
          {edgeTypeLabels[edge.type] || edge.type}
        </span>
        <span className={`sev-badge sev-edge-basis basis-${edge.basis}`}>
          {edgeBasisLabels[edge.basis] || edge.basis}
        </span>
        <span className="sev-badge">{reviewLabels[edge.review.state]}</span>
        {edge.stale && <span className="sev-badge sev-warn">依据已失效</span>}
      </div>
      <p className="sev-edge-route">
        <button onClick={() => onFocus(edge.source)}>
          {source ? source.title : edge.source}
        </button>
        <ChevronRight size={13} />
        <button onClick={() => onFocus(edge.target)}>
          {target ? target.title : edge.target}
        </button>
      </p>
      <label className="sev-field">
        <span>为什么连这条线</span>
        <p>{edge.explanation.trim() || "（抽取方未给出解释）"}</p>
      </label>
      <label className="sev-field">
        <span>依据原文（{edge.evidence.length} 条）</span>
        {edge.evidence.length === 0 ? (
          <p className="sev-warn-text">
            没有可核对的原文引文。这是"无依据关系"，只能作为待核对线索，不能当结论。
          </p>
        ) : (
          edge.evidence.map((e, i) => (
            <blockquote key={`${e.chapterId}-${e.start}-${i}`} className="sev-quote">
              <Quote size={12} />
              <span>{e.quote}</span>
              <small>
                第 {nodesById.get(edge.source)?.chapterNumber ?? "?"} 章 · 字符{" "}
                {e.start}–{e.end}
              </small>
            </blockquote>
          ))
        )}
      </label>
      {edge.stale && (
        <p className="sev-warn-text">
          失效原因：{edge.stale.reason}（{edge.stale.at}）。改稿后这条依据已对不上当前正文，
          需要复核，但不会被自动删除。
        </p>
      )}
    </>
  );
}

function NodeInspector({
  node,
  edges,
  nodesById,
  onClose,
  onEdge,
  onFocus,
}: {
  node: StoryEventNode;
  edges: StoryEventEdge[];
  nodesById: Map<string, StoryEventNode>;
  onClose: () => void;
  onEdge: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  const incoming = edges.filter((e) => e.target === node.id);
  const outgoing = edges.filter((e) => e.source === node.id);
  return (
    <>
      <div className="inspector-title">
        <h3>事件详情</h3>
        <button className="icon-button" aria-label="关闭事件详情" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="sev-badges">
        <span className={`sev-badge sev-status-${node.status}`}>
          {statusLabels[node.status]}
        </span>
        <span className="sev-badge">{kindLabels[node.kind]}</span>
        <span className="sev-badge">{basisLabels[node.basis] || node.basis}</span>
        <span className="sev-badge">{reviewLabels[node.review.state]}</span>
        {node.stale && <span className="sev-badge sev-warn">依据已失效</span>}
      </div>
      <h4 className="sev-inspector-title">{node.title}</h4>
      <p className="sev-location">
        第 {node.chapterNumber} 章 · {node.chapterTitle}
        {node.storyTime && ` · ${node.storyTime}`}
      </p>
      {node.summary && <p className="sev-summary">{node.summary}</p>}
      {(node.actors.length > 0 || node.objects.length > 0) && (
        <div className="sev-entity-row">
          {node.actors.map((a) => (
            <span key={`a-${a}`} className="sev-entity">
              {a}
            </span>
          ))}
          {node.objects.map((o) => (
            <span key={`o-${o}`} className="sev-entity sev-object">
              {o}
            </span>
          ))}
        </div>
      )}
      <label className="sev-field">
        <span>原文引文</span>
        <blockquote className="sev-quote">
          <Quote size={12} />
          <span>{node.evidence.quote}</span>
          <small>
            字符 {node.evidence.start}–{node.evidence.end}
          </small>
        </blockquote>
      </label>
      {node.review.note && (
        <label className="sev-field">
          <span>核对备注</span>
          <p>{node.review.note}</p>
        </label>
      )}
      {node.stale && (
        <p className="sev-warn-text">
          失效原因：{node.stale.reason}。当前正文已与抽取时不一致，此事件需要复核；
          它不会被删除，也不会自动改写正文。
        </p>
      )}
      <button className="sev-action" onClick={() => onFocus(node.id)}>
        <Crosshair size={14} />
        聚焦此事件，查看前后因果
      </button>
      {incoming.length > 0 && (
        <div className="sev-edge-list">
          <span className="eyebrow">前因（{incoming.length}）</span>
          {incoming.map((e) => (
            <button key={e.id} onClick={() => onEdge(e.id)}>
              <b>{nodesById.get(e.source)?.title ?? e.source}</b>
              <span>
                {edgeTypeLabels[e.type] || e.type} ·{" "}
                {edgeBasisLabels[e.basis] || e.basis}
                {e.stale ? " · 依据已失效" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="sev-edge-list">
          <span className="eyebrow">后果（{outgoing.length}）</span>
          {outgoing.map((e) => (
            <button key={e.id} onClick={() => onEdge(e.id)}>
              <b>{nodesById.get(e.target)?.title ?? e.target}</b>
              <span>
                {edgeTypeLabels[e.type] || e.type} ·{" "}
                {edgeBasisLabels[e.basis] || e.basis}
                {e.stale ? " · 依据已失效" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function IssueList({
  issues,
  candidateIssues,
  nodesById,
  onSelectNode,
  authorActions,
}: {
  issues: StoryIssue[];
  candidateIssues: StoryCandidateIssue[];
  nodesById: Map<string, StoryEventNode>;
  onSelectNode: (id: string) => void;
  authorActions: {
    onDecide: (issueId: string, decision: StoryIssueDecision) => Promise<boolean>;
    onRevision: (
      issue: StoryIssue,
      node: StoryEventNode | null,
      instruction: string,
    ) => Promise<boolean>;
    deciding: boolean;
    error: string;
  };
}) {
  const { onDecide, onRevision, deciding, error: decisionError } = authorActions;
  const [kind, setKind] = useState("");
  // F10：按 issueId 记录作者填写的修订要求，避免所有问题共用一个输入框。
  const [revisionInput, setRevisionInput] = useState<Record<string, string>>({});
  const [revisionTarget, setRevisionTarget] = useState<string | null>(null);
  const [scope, setScope] = useState<"formal" | "candidates">("formal");
  const source = scope === "formal" ? issues : candidateIssues;
  const visible = kind ? source.filter((i) => i.kind === kind) : source;
  const formalOpen = issues.filter(issueNeedsDecision).length;
  const candidateOpen = candidateIssues.filter(issueNeedsDecision).length;
  return (
    <>
      <div className="inspector-title">
        <h3>问题与建议</h3>
        <span className="small muted">正式 {issues.length} · 候选 {candidateIssues.length}</span>
      </div>
      <p className="small muted">
        此处只列出待作者决定的问题，不会自动修改正文。保留、驳回、裁成都只改处理状态。
      </p>
      <div className="sev-scope-switch" role="tablist" aria-label="问题来源">
        <button
          role="tab"
          aria-selected={scope === "formal"}
          className={scope === "formal" ? "active" : ""}
          onClick={() => setScope("formal")}
        >
          正式图问题 {formalOpen > 0 ? `(${formalOpen} 待决)` : ""}
        </button>
        <button
          role="tab"
          aria-selected={scope === "candidates"}
          className={scope === "candidates" ? "active" : ""}
          onClick={() => setScope("candidates")}
        >
          候选问题 {candidateOpen > 0 ? `(${candidateOpen} 待决)` : ""}
        </button>
      </div>
      {decisionError && (
        <p className="sev-warn-text" role="alert" data-testid="sev-author-error">
          {decisionError}
        </p>
      )}
      <label className="sev-field">
        <span>按类型筛选</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部</option>
          <option value="missing-source">缺少出处</option>
          <option value="state-break">状态断裂</option>
          <option value="unsourced-knowledge">无来源知情</option>
          <option value="conflict">矛盾</option>
          <option value="stale-evidence">依据失效</option>
        </select>
      </label>
      {visible.length === 0 ? (
        <p className="small muted">当前没有待处理问题。</p>
      ) : (
        <div className="sev-issue-list">
          {visible.map((issue) => (
            <article key={issue.id} className={`sev-issue issue-${issue.disposition}`}>
              <div className="sev-issue-head">
                <b>{issue.kind}</b>
                <span className={`sev-badge sev-disp disp-${issue.disposition}`}>
                  {issue.disposition}
                </span>
              </div>
              <p>{issue.explanation}</p>
              {issue.suggestion && <p className="sev-suggestion">建议：{issue.suggestion}</p>}
              {issue.nodeIds.length > 0 && (
                <div className="sev-issue-links">
                  {issue.nodeIds.map((id) => {
                    const linked = nodesById.get(id);
                    return (
                      <button key={id} onClick={() => onSelectNode(id)}>
                        {linked?.title ?? id}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* R9：作者必须能看到问题对应的原文，才能判断保留/驳回/裁定。 */}
              {issue.nodeIds
                .map((id) => nodesById.get(id))
                .filter((n): n is StoryEventNode => Boolean(n))
                .slice(0, 2)
                .map((node) => (
                  <blockquote key={`${issue.id}-${node.id}`} className="sev-quote">
                    <Quote size={12} />
                    <span>{node.evidence.quote}</span>
                    <small>
                      第 {node.chapterNumber} 章 · {node.chapterTitle} · 字符{" "}
                      {node.evidence.start}–{node.evidence.end}
                    </small>
                  </blockquote>
                ))}
              {scope === "formal" && issueNeedsDecision(issue) ? (
                <div className="sev-decisions">
                  <span className="sev-decisions-label">
                    作者决定（只改处理状态，不改正文）
                  </span>
                  <div className="sev-decision-row">
                    {STORY_DECISION_ACTIONS.map((action) => (
                      <button
                        key={action.decision}
                        className="sev-decision-btn"
                        title={action.description}
                        disabled={deciding}
                        onClick={() => void onDecide(issue.id, action.decision)}
                      >
                        {action.label}
                      </button>
                    ))}
                    <button
                      className="sev-decision-btn sev-revision-trigger"
                      title="按此问题发起正文修订；会先进入既有草稿候选流程，采纳后才写入正文"
                      onClick={() =>
                        setRevisionTarget((current) =>
                          current === issue.id ? null : issue.id,
                        )
                      }
                    >
                      发起修订
                    </button>
                  </div>
                  {revisionTarget === issue.id && (
                    <div className="sev-revision-box">
                      <label>
                        <span>修订要求（会写入候选，不直接改正文）</span>
                        <textarea
                          rows={3}
                          aria-label="修订要求"
                          value={revisionInput[issue.id] || ""}
                          onChange={(e) =>
                            setRevisionInput((current) => ({
                              ...current,
                              [issue.id]: e.target.value,
                            }))
                          }
                          placeholder="例如：补写林遥如何得知钥匙在父亲手里，别改其他段落。"
                        />
                      </label>
                      <div className="sev-revision-actions">
                        <button
                          className="primary sev-decision-btn"
                          disabled={
                            deciding || !(revisionInput[issue.id] || "").trim()
                          }
                          onClick={async () => {
                            const target = issue.nodeIds
                              .map((id) => nodesById.get(id))
                              .find(Boolean) || null;
                            const ok = await onRevision(
                              issue,
                              target,
                              revisionInput[issue.id] || "",
                            );
                            if (ok) {
                              setRevisionTarget(null);
                              setRevisionInput((current) => ({
                                ...current,
                                [issue.id]: "",
                              }));
                            }
                          }}
                        >
                          生成修订候选
                        </button>
                        <button
                          className="sev-decision-btn"
                          onClick={() => setRevisionTarget(null)}
                        >
                          取消
                        </button>
                      </div>
                      <p className="small muted">
                        修订请求会进入既有草稿流程，生成的是候选；作者采纳后才改变正文。
                      </p>
                    </div>
                  )}
                </div>
              ) : scope === "formal" ? (
                <p className="small muted">已由作者处理，不再提示。</p>
              ) : (
                <p className="small muted">
                  候选问题尚未进入正式图，采纳前不能做作者决定。
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function StoryEvents() {
  const {
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
  } = useStoryEvents();
  const fitGraph = useRef<(() => void) | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [tab, setTab] = useState<"inspector" | "issues" | "coverage">("inspector");

  const edgesById = useMemo(
    () => new Map((view?.graph.edges || []).map((e) => [e.id, e])),
    [view],
  );

  const flowEdges = useMemo<Edge[]>(() => {
    if (!view) return [];
    return filtered.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      ...edgeAppearance(e),
      animated: false,
    }));
  }, [view, filtered.edges]);

  const actors = useMemo(() => {
    const set = new Set<string>();
    for (const n of view?.graph.nodes || []) n.actors.forEach((a) => set.add(a));
    return [...set].sort();
  }, [view]);

  const objects = useMemo(() => {
    const set = new Set<string>();
    for (const n of view?.graph.nodes || []) n.objects.forEach((o) => set.add(o));
    return [...set].sort();
  }, [view]);

  // 布局只做展示层排布：按章分列，按原文位置纵向排序；不改变任何业务判定。
  useEffect(() => {
    const kept = new Set(filtered.nodes.map((n) => n.id));
    const chapterIndex = new Map(
      (view?.chapters || []).map((c, i) => [c.id, i]),
    );
    setNodes((prev) => {
      const previous = new Map(prev.map((n) => [n.id, n.position]));
      const perChapter = new Map<string, StoryEventNode[]>();
      for (const node of filtered.nodes) {
        if (!perChapter.has(node.chapterId)) perChapter.set(node.chapterId, []);
        perChapter.get(node.chapterId)!.push(node);
      }
      return filtered.nodes.map((node) => {
        const siblings = perChapter.get(node.chapterId) || [];
        const row = siblings.indexOf(node);
        const cost = previous.get(node.id);
        return {
          id: node.id,
          type: "storyEvent",
          position:
            cost ??
            {
              x: (chapterIndex.get(node.chapterId) ?? 0) * 330,
              y: row * 175,
            },
          data: {
            node,
            dimmed: !!focusEventId && focusEventId !== node.id && !kept.has(node.id),
          },
        } as Node;
      });
    });
  }, [filtered.nodes, view, setNodes, focusEventId]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      setSelectedNode(node.id);
      setSelectedEdge(null);
      setTab("inspector");
    },
    [],
  );

  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      setSelectedEdge(edge.id);
      setSelectedNode(null);
      setTab("inspector");
    },
    [],
  );

  const focus = useCallback((id: string) => {
    setFocusEventId((current) => (current === id ? null : id));
    setSelectedNode(id);
    setSelectedEdge(null);
  }, [setFocusEventId]);

  if (loading && !view)
    return (
      <div className="graph-page sev-page">
        <div className="sev-loading">正在读取故事事件链…</div>
      </div>
    );

  if (error)
    return (
      <div className="graph-page sev-page">
        <div className="sev-error" role="alert">
          <CircleAlert size={18} />
          <div>
            <b>读取故事事件链失败</b>
            <p>{error}</p>
          </div>
        </div>
      </div>
    );

  if (!view) return null;

  const node = selectedNode ? nodesById.get(selectedNode) ?? null : null;
  const edge = selectedEdge ? edgesById.get(selectedEdge) ?? null : null;
  const openIssues = (view.graph.issues || []).filter(
    (i) => i.disposition === "open",
  );
  const candidates = view.candidates.nodes;
  const hasAnyNode = view.graph.nodes.length > 0;

  return (
    <div className="graph-page sev-page">
      <div className="page-intro sev-intro">
        <div>
          <span className="eyebrow">事件从哪里来，又改变了什么</span>
          <h1>故事事件链</h1>
          <p>
            每个节点是正文里的一处事件，每条线是可核对的前因后果。点击节点看原文，
            点击连线看依据；标"推断"或"待核对"的线不是结论。
          </p>
        </div>
        <div className="sev-headline">
          <span className="sev-headline-stat">
            <b>{view.counts.nodes}</b> 事件
          </span>
          <span className="sev-headline-stat">
            <b>{view.counts.edges}</b> 关系
          </span>
          <span className="sev-headline-stat sev-warn-stat">
            <b>{view.counts.staleNodes + view.counts.staleEdges}</b> 处依据失效
          </span>
          <span className="sev-headline-stat">
            <b>{view.counts.candidates}</b> 个候选
          </span>
          <span className="sev-headline-stat">
            <b>{view.counts.issues}</b> 个待决问题
          </span>
        </div>
      </div>

      {view.warnings.length > 0 && (
        <div className="sev-warnings" role="status">
          <HelpCircle size={15} />
          <div>
            {view.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        </div>
      )}

      {!isDesktop && (
        <div className="sev-preview-note" role="note">
          <EyeOff size={14} />
          <span>
            浏览器预览不合并未采纳增量，候选事件请在桌面应用中查看。
          </span>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="sev-candidate-bar">
          <Sparkles size={15} />
          <span>
            有 {candidates.length} 个候选事件来自未采纳的消息，没有进入正式事件图。
            候选只作预览，采纳前不会改变作品。
            {showCandidates
              ? "候选已叠加到画布（虚线框 + 候选徽标），可直接点开检查。"
              : "候选当前未显示在画布上。"}
          </span>
          <button
            className={"sev-toggle " + (showCandidates ? "active" : "")}
            aria-pressed={showCandidates}
            onClick={() => setShowCandidates(!showCandidates)}
          >
            <Sparkles size={12} />
            {showCandidates ? "隐藏候选" : "在画布上显示候选"}
          </button>
          <div className="sev-candidate-chapters">
            {[...new Set(candidates.map((c) => c.chapterNumber))].map((n) => (
              <span key={n} className="sev-chip sev-chip-candidate">
                第 {n} 章
              </span>
            ))}
          </div>
        </div>
      )}

      {/* R7：历史建图入口。只更新派生事件数据，不改正文。 */}
      <section className="sev-build" aria-label="历史建图">
        <div className="sev-build-main">
          <div className="sev-build-head">
            <Layers size={15} />
            <b>{storyBuildLabel(build)}</b>
            <span className="sev-build-scope">只更新事件数据，不改正文</span>
          </div>
          <p className="sev-build-summary">{storyBuildSummary(build)}</p>
          {buildError && (
            <p className="sev-warn-text" role="alert">
              建图状态读取失败：{buildError}
            </p>
          )}
          {build?.failure && (
            <p className="sev-warn-text">上次失败原因：{build.failure}</p>
          )}
        </div>
        <div className="sev-build-actions">
          {/* G5 主操作：未建图→建立（重建全部目标章）；已建图→补全（只补未完成章）。
              H6：全部章节已抽取时没有可执行动作，只说明原因；「重新建立」仍然保留。
              环境不支持/没有正文时按钮照旧显示但禁用，沿用原有说明。 */}
          {(!canStartStoryBuild(build) || hasStoryBuildTargets(build)) && (
            <button
              className="primary sev-build-btn"
              disabled={!canStartStoryBuild(build) || build?.state === "running"}
              title={
                build && !build.enabled
                  ? "该功能需要桌面端支持"
                  : build && !build.hasContent
                    ? "作品还没有正文"
                    : primaryBuildMode(build) === "build"
                      ? "对已采纳正文建立事件图（会重建目标章）"
                      : primaryBuildMode(build) === "none"
                        ? "全部章节已抽取，没有需要补全的内容"
                        : "只补未完成的章节，已完成章节不会被重做"
              }
              onClick={() => {
                const mode = primaryBuildMode(build);
                if (mode === "none") return;
                void startBuild(mode);
              }}
            >
              <Sparkles size={14} />
              {primaryBuildLabel(build)}
            </button>
          )}
          {build?.enabled &&
            build.hasContent &&
            !hasStoryBuildTargets(build) && (
              <span className="small muted" role="status">
                全部章节已抽取，没有需要补全的内容
              </span>
            )}
          {/* G5 独立动作：强制重建全部目标章，仅在已建过图时出现 */}
          {canRebuild(build) && (
            <button
              className="sev-build-btn sev-rebuild-btn"
              disabled={build?.state === "running"}
              title="强制重建全部目标章节的事件图；会重新请求模型，已完成章节也会重做"
              onClick={() => void startBuild("build")}
            >
              <RotateCcw size={13} />
              重新建立
            </button>
          )}
          {build && !build.enabled && (
            <span className="small muted">该功能需要桌面端支持</span>
          )}
        </div>
      </section>

      <div className="sev-toolbar" role="group" aria-label="事件筛选">
        <span className="sev-toolbar-label">
          <Filter size={14} />
          筛选
        </span>
        <select
          aria-label="按章节筛选"
          value={filters.chapterId}
          onChange={(e) => setFilters({ ...filters, chapterId: e.target.value })}
        >
          <option value="">全部章节</option>
          {view.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              第 {c.number} 章 · {c.title}
            </option>
          ))}
        </select>
        <select
          aria-label="按事件类型筛选"
          value={filters.kind}
          onChange={(e) => setFilters({ ...filters, kind: e.target.value })}
        >
          <option value="">全部类型</option>
          {Object.entries(kindLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          aria-label="按事件状态筛选"
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="">全部状态</option>
          {Object.entries(statusLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}（{statusCounts[k as StoryEventStatus]}）
            </option>
          ))}
        </select>
        <button
          className={"sev-toggle " + (filters.reviewOnly ? "active" : "")}
          aria-pressed={filters.reviewOnly}
          onClick={() => setFilters({ ...filters, reviewOnly: !filters.reviewOnly })}
        >
          <HelpCircle size={13} />
          只看待核对
        </button>
        <button
          className={"sev-toggle " + (filters.staleOnly ? "active" : "")}
          aria-pressed={filters.staleOnly}
          onClick={() => setFilters({ ...filters, staleOnly: !filters.staleOnly })}
        >
          <AlertTriangle size={13} />
          只看依据失效
        </button>
        <div className="sev-toolbar-spacer" />
        <div className="sev-depth">
          <span>展开层数</span>
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              className={"sev-depth-btn " + (depth === d ? "active" : "")}
              aria-pressed={depth === d}
              onClick={() => setDepth(d)}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="sev-depth">
          <span>方向</span>
          {(
            [
              ["up", "前因", ChevronLeft],
              ["down", "后果", ChevronRight],
              ["both", "双向", Layers],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              className={"sev-depth-btn " + (direction === value ? "active" : "")}
              aria-pressed={direction === value}
              onClick={() => setDirection(value)}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
        <button
          className="secondary sev-fit"
          onClick={() =>
            requestAnimationFrame(() => requestAnimationFrame(() => fitGraph.current?.()))
          }
        >
          <Maximize2 size={14} />
          全图定位
        </button>
      </div>

      {(actors.length > 0 || objects.length > 0) && (
        <div className="sev-entity-filters">
          {actors.length > 0 && (
            <div className="sev-entity-group">
              <span className="eyebrow">人物</span>
              {actors.map((a) => (
                <button
                  key={a}
                  className={
                    "sev-chip " + (filters.selectedActors.includes(a) ? "active" : "")
                  }
                  aria-pressed={filters.selectedActors.includes(a)}
                  onClick={() => toggleActor(a)}
                >
                  {a}
                </button>
              ))}
            </div>
          )}
          {objects.length > 0 && (
            <div className="sev-entity-group">
              <span className="eyebrow">物件</span>
              {objects.map((o) => (
                <button
                  key={o}
                  className={
                    "sev-chip sev-chip-object " +
                    (filters.selectedObjects.includes(o) ? "active" : "")
                  }
                  aria-pressed={filters.selectedObjects.includes(o)}
                  onClick={() => toggleObject(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="graph-layout sev-layout">
        <ChapterRail
          view={view}
          chapterGroups={chapterGroups}
          filters={filters}
          onChapter={(id) => setFilters({ ...filters, chapterId: id })}
        />
        <div className="graph-canvas sev-canvas">
          <div className="canvas-label">
            <span className="status-pill">
              <i />
              {filtered.nodes.length} 个事件 · {filtered.edges.length} 条关系
              {focusEventId ? " · 已聚焦" : ""}
            </span>
            <span>
              {focusEventId ? (
                <button className="sev-clear-focus" onClick={() => setFocusEventId(null)}>
                  <X size={12} />
                  清除聚焦，回到全书
                </button>
              ) : (
                <span>拖动节点整理视图，不改动作品数据</span>
              )}
            </span>
          </div>
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={(instance) => {
              fitGraph.current = () => {
                void instance.fitView({ padding: 0.22, maxZoom: 1.1 });
              };
            }}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => {
              setSelectedNode(null);
              setSelectedEdge(null);
            }}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
            minZoom={0.15}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--line)" gap={26} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor={(n) => {
                const d = n.data as { node: StoryEventNode };
                if (d?.node?.stale) return "var(--warning)";
                if (d?.node?.status === "candidate") return "var(--accent)";
                if (d?.node?.status === "conflict") return "var(--danger)";
                return "var(--muted)";
              }}
              maskColor="var(--overlay)"
            />
          </ReactFlow>
          {filtered.nodes.length === 0 && <EmptyStates view={view} />}
        </div>
        <aside className="graph-inspector sev-inspector">
          <div className="sev-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "inspector"}
              className={tab === "inspector" ? "active" : ""}
              onClick={() => setTab("inspector")}
            >
              <GitBranch size={13} />
              详情
            </button>
            <button
              role="tab"
              aria-selected={tab === "issues"}
              className={tab === "issues" ? "active" : ""}
              onClick={() => setTab("issues")}
            >
              <ListChecks size={13} />
              问题 {openIssues.length}
            </button>
            <button
              role="tab"
              aria-selected={tab === "coverage"}
              className={tab === "coverage" ? "active" : ""}
              onClick={() => setTab("coverage")}
            >
              <Layers size={13} />
              覆盖
            </button>
          </div>
          {tab === "inspector" ? (
            node ? (
              <NodeInspector
                key={node.id}
                node={node}
                edges={view.view.edges}
                nodesById={nodesById}
                onClose={() => setSelectedNode(null)}
                onEdge={(id) => setSelectedEdge(id)}
                onFocus={focus}
              />
            ) : edge ? (
              <EdgeInspector
                key={edge.id}
                edge={edge}
                nodesById={nodesById}
                onClose={() => setSelectedEdge(null)}
                onFocus={focus}
              />
            ) : (
              <>
                <div className="inspector-empty">
                  <GitBranch size={26} />
                  <h3>从一个事件开始</h3>
                  <p>
                    点击节点看事件与原文引文；点击连线看关系类型、解释与依据。
                    聚焦后可只保留前因或后果。
                  </p>
                </div>
                {!hasAnyNode && (
                  <p className="sev-hint-text">
                    作品尚无正式事件。切换到「覆盖」页可查看哪些章已抽取、哪些还没读。
                  </p>
                )}
                <div className="sev-legend">
                  <span className="eyebrow">图例（不依赖颜色也能分辨）</span>
                  <ul>
                    <li>
                      <span className="sev-legend-glyph">●</span> 已确认事件 · 实线框
                    </li>
                    <li>
                      <span className="sev-legend-glyph">◇</span> 候选事件 · 虚线框
                    </li>
                    <li>
                      <span className="sev-legend-glyph">◐</span> 暂定事件 · 点线框
                    </li>
                    <li>
                      <span className="sev-legend-glyph">▲</span> 矛盾事件 · 双线框
                    </li>
                    <li>
                      <span className="sev-legend-line solid" /> 实线 = 显式依据
                    </li>
                    <li>
                      <span className="sev-legend-line dashed" /> 长虚线 = 推断
                    </li>
                    <li>
                      <span className="sev-legend-line dotted" /> 短虚线 = 待核对
                    </li>
                    <li>
                      <span className="sev-legend-line stale" /> 点状橙线 = 依据已失效
                    </li>
                  </ul>
                </div>
              </>
            )
          ) : tab === "issues" ? (
            <IssueList
              issues={view.graph.issues || []}
              candidateIssues={view.candidates.issues || []}
              nodesById={nodesById}
              onSelectNode={(id) => {
                setSelectedNode(id);
                setTab("inspector");
              }}
              authorActions={{
                onDecide: decideIssue,
                onRevision: requestRevision,
                deciding,
                error: decisionError,
              }}
            />
          ) : (
            <>
              <div className="inspector-title">
                <h3>覆盖范围</h3>
              </div>
              <p className="small muted">
                未抽取和抽取失败不代表故事里没有事件，只代表这一章还没读。
              </p>
              <div className="sev-coverage-list">
                {view.chapters.map((c) => (
                  <div key={c.id} className="sev-coverage-row">
                    <b>
                      第 {c.number} 章 · {c.title}
                    </b>
                    <span className={`sev-cov sev-cov-${c.coverage || "none"}`}>
                      {coverageText(c.coverage)}
                    </span>
                  </div>
                ))}
              </div>
              {(view.graph.issues || []).some((i) => i.kind === "stale-evidence") && (
                <p className="sev-warn-text">
                  存在依据失效的记录：改稿后这些事件的出处对不上当前正文。它们被保留并标记，
                  不会被自动删除或改写。
                </p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
