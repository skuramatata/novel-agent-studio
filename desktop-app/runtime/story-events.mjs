import { createHash } from "node:crypto";
import {
  storyEventsSchema,
  storyNodeSchema,
  storyEdgeSchema,
  storyCoverageSchema,
  storyIssueSchema,
  STORY_COVERAGE_STATUSES,
  STORY_ISSUE_DISPOSITIONS,
} from "./story-events-schema.mjs";

const shortHash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const now = () => new Date().toISOString();

export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

// 事件身份只由章节 ID（不是章号）、事件标题与本章内位置决定；
// 章号、章节标题、正文哈希与抽取批次都不参与，改稿、改名、重排不会换 id。
export function storyEventId({ chapterId, title, start, end }) {
  return `sev-${shortHash(JSON.stringify([chapterId, title, start, end]))}`;
}

export function storyEdgeId({ source, target, type }) {
  return `see-${shortHash(JSON.stringify([source, target, type]))}`;
}

export function emptyStoryEvents() {
  return { version: 1, nodes: [], edges: [], coverage: [], issues: [] };
}

const reviewDefault = () => ({ state: "unreviewed", note: "", at: null });

export function normalizeReview(review) {
  return review ? { ...reviewDefault(), ...review } : reviewDefault();
}

function chapterMap(chapters = []) {
  return new Map(chapters.filter(Boolean).map((c) => [c.id, c]));
}

function nodeMap(nodes = []) {
  return new Map(nodes.filter(Boolean).map((n) => [n.id, n]));
}

// 出处一律由程序按区间从当前正文回填，模型只给区间与引文，不能自造 sourceHash。
export function eventEvidence(chapterId, content, start, end) {
  return {
    chapterId,
    sourceHash: digest(content),
    start,
    end,
    quote: content.slice(start, end),
  };
}

export function normalizeEvidence(raw, chapters, fallbackChapterId) {
  const chapterId = raw?.chapterId || fallbackChapterId;
  if (!chapterId) return null;
  const start = Number.isInteger(raw?.start) ? raw.start : null;
  const end = Number.isInteger(raw?.end) ? raw.end : null;
  const quote = typeof raw?.quote === "string" ? raw.quote : "";
  if (start === null || end === null || end <= start || !quote.trim())
    return null;
  const source = chapterMap(chapters).get(chapterId);
  // 未提供作品正文时保留已存出处，供离线建图/界面读取；有正文则逐字核对。
  if (!source)
    return {
      chapterId,
      sourceHash: typeof raw.sourceHash === "string" ? raw.sourceHash : "",
      start,
      end,
      quote,
    };
  const slice = source.content.slice(start, end);
  // 区间与逐字引文必须完全一致：不接受"引文存在但区间指向别处"，
  // 否则会把同章另一段文字当成事件出处，并用当前哈希盖成有效证据。
  if (slice !== quote) return null;
  return {
    chapterId,
    sourceHash: digest(source.content),
    start,
    end,
    quote,
  };
}

function draftSignature(node) {
  return [node.chapterId, node.title, node.evidence.start, node.evidence.end].join(
    "|",
  );
}

// 已落盘但无法再核对的出处：保留原区间、原引文与原哈希，只标记失效原因。
// 用于改稿后回看旧原点；绝不改写引文，也绝不把当前哈希盖上去。
function staleEvidenceReason(evidence, chapters) {
  const source = chapterMap(chapters).get(evidence.chapterId);
  if (!source) return "chapter-missing";
  return source.content.includes(evidence.quote)
    ? "source-changed"
    : "quote-missing";
}

function keptStaleEvidence(raw, chapters) {
  const evidence = raw?.evidence;
  // 只有已落盘的出处才允许保留：它由程序分配过 id 与 sourceHash。
  // 模型新草稿没有 sourceHash，区间对不上仍必须按 R4 拒绝。
  if (!raw?.id) return null;
  if (typeof evidence?.sourceHash !== "string" || !evidence.sourceHash) return null;
  if (typeof evidence.quote !== "string" || !evidence.quote.trim()) return null;
  if (!Number.isInteger(evidence.start) || !Number.isInteger(evidence.end))
    return null;
  const chapterId = evidence.chapterId || raw.chapterId;
  if (!chapterId) return null;
  const normalized = {
    chapterId,
    sourceHash: evidence.sourceHash,
    start: evidence.start,
    end: evidence.end,
    quote: evidence.quote,
  };
  return {
    evidence: normalized,
    stale: {
      at: now(),
      reason: staleEvidenceReason(normalized, chapters),
      expectedHash: normalized.sourceHash,
    },
  };
}

function textScore(a = "", b = "") {
  if (!a || !b) return 0;
  if (a === b) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  const chars = new Set([...a]);
  let shared = 0;
  for (const ch of new Set([...b])) if (chars.has(ch)) shared += 1;
  return shared / Math.max(chars.size, new Set([...b]).size) >= 0.5 ? 1 : 0;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 同章重抽的匹配：区间重叠是硬条件，标题/实体相似度决定是否同一事件；
// 区间完全不重叠时只允许逐字引文相同，避免把相邻事件并成一条。
function matchScore(node, draft) {
  if (node.chapterId !== draft.chapterId) return 0;
  const sameQuote = node.evidence.quote === draft.evidence.quote;
  if (!sameQuote && !overlaps(node.evidence, draft.evidence)) return 0;
  let score = 0;
  if (sameQuote) score += 3;
  if (overlaps(node.evidence, draft.evidence)) score += 1;
  score += textScore(node.title, draft.title);
  if (textScore(node.summary, draft.summary) > 0) score += 1;
  const sharedActors = draft.actors.filter((a) => node.actors.includes(a)).length;
  const sharedObjects = draft.objects.filter((o) => node.objects.includes(o)).length;
  if (sharedActors) score += 1;
  if (sharedObjects) score += 1;
  return score;
}

// 区间重叠只说明"位置接近"，不能证明是同一事件：同一句原文里可以抽出多件事。
// 因此先做语义判据，再看得分：标题毫无共词时，必须 kind 相同且共享同一实体，
// 才可能是同一事件的改写；否则一律按另一件事新建节点，保留各自身份与连线。
function sameEvent(node, draft, score) {
  if (score < 2) return false;
  const titleScore = textScore(node.title, draft.title);
  if (titleScore > 0) return true;
  if (node.kind !== draft.kind) return false;
  const sharedActors = draft.actors.some((a) => node.actors.includes(a));
  const sharedObjects = draft.objects.some((o) => node.objects.includes(o));
  return sharedActors || sharedObjects;
}

function detectCoverageStatus(value) {
  if (!STORY_COVERAGE_STATUSES.includes(value))
    throw Error(
      `覆盖状态必须是 ${STORY_COVERAGE_STATUSES.join("/")}，收到「${value}」。`,
    );
  return value;
}

export function chapterCoverage({
  chapterId,
  status,
  parts = [],
  extractedAt = now(),
  model = "",
  failure = null,
}) {
  return {
    chapterId,
    status: detectCoverageStatus(status),
    parts: [...new Set(parts)].sort((a, b) => a - b),
    extractedAt,
    model,
    failure,
  };
}

const nodeDraft = (raw) => ({
  ...raw,
  storyTime: raw.storyTime ?? "",
  narrativeOffset: Number.isInteger(raw.narrativeOffset) ? raw.narrativeOffset : 0,
  summary: raw.summary ?? "",
  kind: raw.kind ?? "other",
  actors: raw.actors ?? [],
  objects: raw.objects ?? [],
  status: raw.status ?? "confirmed",
  basis: raw.basis ?? "narration",
});

export function validateStoryEdge(edge, nodes, chapters = [], knownNodeIds = new Set()) {
  // 端点合法性：本次 nodes ∪ 已知正式事件 id。候选增量只带本章节点时，
  // 指向正式历史的跨章边仍然成立；两处都没有才是真的指向不存在的事件。
  const endpointExists = (id) => nodeMap(nodes).has(id) || knownNodeIds.has(id);
  if (
    !endpointExists(edge.source) ||
    !endpointExists(edge.target) ||
    edge.source === edge.target
  )
    return {
      ok: false,
      reason: "关系必须连接两个存在且不同的事件。",
      issue: "missing-source",
    };
  if (!edge.explanation || !edge.explanation.trim())
    return {
      ok: false,
      reason: "关系必须写明 explanation，不能只凭时间先后或共享人物推断。",
      issue: "missing-source",
    };
  // 没有正文就无从核对：既不接受也不否定，原样保留已存证据。
  // 只有拿到了正文、且证据确实对不上，才判定为不可核。
  const chaptersKnown = chapters.length > 0;
  const evidence = chaptersKnown
    ? (edge.evidence || []).filter((e) =>
        chapters.some(
          (c) =>
            c.id === e.chapterId &&
            c.content.slice(e.start, e.end) === e.quote,
        ),
      )
    : edge.evidence || [];
  if (edge.basis === "explicit") {
    if (!evidence.length)
      return {
        ok: false,
        reason:
          "explicit 关系必须给出当前正文中逐字可核的 evidence；仅共享人物或物件、仅时间先后不构成因果。",
        issue: "missing-source",
      };
  } else if (edge.basis !== "inferred" && edge.basis !== "unverified") {
    return {
      ok: false,
      reason: "关系判断性质只能是 explicit/inferred/author-confirmed/unverified。",
      issue: "missing-source",
    };
  }
  return {
    ok: true,
    edge: {
      id: edge.id ?? storyEdgeId(edge),
      source: edge.source,
      target: edge.target,
      type: edge.type,
      basis: edge.basis,
      explanation: edge.explanation.trim(),
      evidence,
      review: normalizeReview(edge.review),
      stale: edge.stale ?? null,
    },
  };
}

// 归一化入口容错：逐条剔除无效节点/边并生成 missing-source 问题，
// 不为老作品或模型越界输出直接抛错。
//
// options.knownNodeIds：候选增量只带本章新事件时，关系端点允许指向正式历史里
// 已存在的事件。传入后端点合法性 = 本次 nodes ∪ knownNodeIds；两处都没有才丢弃。
// 这只扩大"合法端点集合"，不跳过端点校验，也不让候选节点冒充正式历史。
export function normalizeStoryEvents(value, options = {}) {
  if (value === undefined || value === null) return emptyStoryEvents();
  const base = emptyStoryEvents();
  const chapters = value.chapters || [];
  const chaptersKnown = chapters.length > 0;
  const knownNodeIds =
    options.knownNodeIds instanceof Set
      ? options.knownNodeIds
      : new Set(options.knownNodeIds || []);
  const nodes = [];
  const issues = [];
  const seen = new Set();
  for (const raw of Array.isArray(value.nodes) ? value.nodes : []) {
    const evidence = raw.evidence
      ? normalizeEvidence(raw.evidence, chapters, raw.chapterId)
      : null;
    if (!evidence) {
      // 已落盘的事件在改稿后无法再核对：保留旧节点与旧证据并标 stale，
      // 让 impactOf 能展示失效原点。删除节点会把失效计数清零，掩盖问题。
      const kept = keptStaleEvidence(raw, chapters);
      const parsedKept =
        kept &&
        storyNodeSchema.safeParse({
          ...nodeDraft(raw),
          id: raw.id,
          evidence: kept.evidence,
          review: normalizeReview(raw.review),
          stale: kept.stale,
        });
      if (parsedKept?.success && !seen.has(parsedKept.data.id)) {
        seen.add(parsedKept.data.id);
        nodes.push(parsedKept.data);
        continue;
      }
      issues.push(
        storyIssueSchema.parse({
          id: `sit-${shortHash(JSON.stringify(["missing-node", raw.title]))}`,
          kind: "missing-source",
          nodeIds: [],
          edgeIds: [],
          explanation: `事件「${raw.title ?? ""}」的出处无法在当前正文中定位。`,
          suggestion: "重新抽取或由作者补充可核对的原文区间。",
          disposition: "open",
        }),
      );
      continue;
    }
    const parsed = storyNodeSchema.safeParse({
      ...nodeDraft(raw),
      evidence,
      review: normalizeReview(raw.review),
      stale: raw.stale ?? null,
    });
    if (!parsed.success) continue;
    if (seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    nodes.push(parsed.data);
  }
  const edges = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const endpointExists = (id) => nodeIds.has(id) || knownNodeIds.has(id);
  for (const raw of Array.isArray(value.edges) ? value.edges : []) {
    if (!endpointExists(raw.source) || !endpointExists(raw.target)) {
      issues.push(
        storyIssueSchema.parse({
          id: `sit-${shortHash(JSON.stringify(["missing-edge", raw.source, raw.target, raw.type]))}`,
          kind: "missing-source",
          nodeIds: [],
          edgeIds: [],
          explanation: "关系指向不存在的事件。",
          suggestion: "关系两端必须引用当前图中存在的事件 id。",
          disposition: "open",
        }),
      );
      continue;
    }
    const normalizedEvidence = (raw.evidence || [])
      .map((e) => normalizeEvidence(e, chapters, raw.chapterId))
      .filter(Boolean);
    // 已落盘关系在改稿后证据对不上：保留原证据与连线，标 stale 待复核。
    // 判据同节点——必须是程序分配过 id 与 sourceHash 的既有数据，
    // 模型新草稿不能借这条绕过 R4 的严格核对。
    const persisted =
      Boolean(raw.id) && (raw.evidence || []).some((e) => e?.sourceHash);
    const lostEvidence = (raw.evidence || []).length > normalizedEvidence.length;
    if (persisted && lostEvidence) {
      const parsedKept = storyEdgeSchema.safeParse({
        id: raw.id,
        source: raw.source,
        target: raw.target,
        type: raw.type,
        basis: raw.basis,
        explanation: (raw.explanation || "").trim(),
        evidence: raw.evidence,
        review: normalizeReview(raw.review),
        stale:
          raw.stale ??
          {
            at: now(),
            reason: staleEvidenceReason(raw.evidence[0], chapters),
            expectedHash: raw.evidence[0]?.sourceHash ?? "",
          },
      });
      if (parsedKept.success) {
        edges.push(parsedKept.data);
        continue;
      }
    }
    const checked = validateStoryEdge(
      {
        ...raw,
        id: raw.id ?? storyEdgeId(raw),
        evidence: normalizedEvidence,
      },
      nodes,
      chapters,
      knownNodeIds,
    );
    if (!checked.ok) {
      issues.push(
        storyIssueSchema.parse({
          id: `sit-${shortHash(JSON.stringify(["invalid-edge", raw.source, raw.target, raw.type]))}`,
          kind: checked.issue,
          nodeIds: [raw.source, raw.target],
          edgeIds: [],
          explanation: checked.reason,
          suggestion: "补一条当前正文可核的引文，或显式改为 inferred/unverified。",
          disposition: "open",
        }),
      );
      continue;
    }
    edges.push(checked.edge);
  }
  const coverage = [];
  for (const raw of Array.isArray(value.coverage) ? value.coverage : []) {
    const parsed = storyCoverageSchema.safeParse(raw);
    if (parsed.success) coverage.push(parsed.data);
  }
  for (const raw of Array.isArray(value.issues) ? value.issues : []) {
    const candidate = {
      disposition: "open",
      nodeIds: [],
      edgeIds: [],
      explanation: "",
      suggestion: "",
      ...raw,
      id:
        raw?.id ||
        `sit-${shortHash(JSON.stringify([raw?.kind, raw?.explanation, raw?.nodeIds]))}`,
    };
    const parsed = storyIssueSchema.safeParse(candidate);
    if (parsed.success) issues.push(parsed.data);
  }
  return {
    version: 1,
    nodes,
    edges,
    coverage,
    issues: dedupeIssues([...issues, ...base.issues]),
  };
}

function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = `${issue.kind}|${issue.nodeIds.join(",")}|${issue.edgeIds.join(",")}|${issue.explanation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function issueFor(kind, explanation, { nodeIds = [], edgeIds = [], suggestion = "" } = {}) {
  return storyIssueSchema.parse({
    id: `sit-${shortHash(JSON.stringify([kind, nodeIds, edgeIds, explanation]))}`,
    kind,
    nodeIds,
    edgeIds,
    explanation,
    suggestion,
    disposition: "open",
  });
}

// 增量合并：先按章节与出处匹配已有事件复用 id，再补新事件与新关系。
// 已有图必须带着章节表归一化，否则合法 explicit 边会因为"无正文可核"被丢弃。
export function mergeStoryEvents(graph, nodeDrafts = [], options = {}) {
  const chapters = options.chapters || (options.chapter ? [options.chapter] : []);
  const current = normalizeStoryEvents({ ...graph, chapters });
  const chapterById = chapterMap(chapters);
  const nodes = current.nodes.map((n) => ({ ...n }));
  const issues = [...current.issues];
  const counts = { added: 0, merged: 0, updated: 0, stale: 0 };
  for (const raw of nodeDrafts) {
    const source = chapterById.get(raw.chapterId);
    if (!source) {
      issues.push(
        issueFor("missing-source", `事件所属章节 ${raw.chapterId} 不在当前作品中。`, {
          suggestion: "确认章节 id 后重新提交。",
        }),
      );
      continue;
    }
    const evidence = normalizeEvidence(raw.evidence, chapters, raw.chapterId);
    if (!evidence) {
      issues.push(
        issueFor(
          "missing-source",
          `事件「${raw.title}」的引文不在第 ${source.number} 章当前正文中。`,
          { suggestion: "改用当前正文中的逐字引文与正确区间。" },
        ),
      );
      continue;
    }
    const draft = { ...nodeDraft(raw), evidence };
    let best = null;
    let bestScore = 0;
    for (const node of nodes) {
      const score = matchScore(node, draft);
      if (score > bestScore && sameEvent(node, draft, score)) {
        best = node;
        bestScore = score;
      }
    }
    if (best) {
      Object.assign(best, {
        chapterNumber: source.number,
        chapterTitle: source.title,
        storyTime: draft.storyTime,
        narrativeOffset: draft.narrativeOffset,
        title: draft.title,
        summary: draft.summary,
        kind: draft.kind,
        actors: draft.actors,
        objects: draft.objects,
        status: draft.status,
        basis: draft.basis,
        evidence,
        stale: null,
      });
      counts.merged += 1;
      continue;
    }
    const candidate = storyNodeSchema.parse({
      ...draft,
      id: storyEventId({
        chapterId: draft.chapterId,
        title: draft.title,
        start: evidence.start,
        end: evidence.end,
      }),
      chapterNumber: source.number,
      chapterTitle: source.title,
      review: normalizeReview(draft.review),
      stale: null,
    });
    if (nodes.some((n) => n.id === candidate.id)) {
      candidate.id = `${candidate.id}-${shortHash(draftSignature(candidate)).slice(0, 4)}`;
    }
    nodes.push(candidate);
    counts.added += 1;
  }
  const edges = current.edges.map((e) => ({ ...e }));
  for (const raw of options.edges || []) {
    const checked = validateStoryEdge(
      {
        ...raw,
        id: raw.id ?? storyEdgeId(raw),
        evidence: (raw.evidence || [])
          .map((e) => normalizeEvidence(e, chapters, raw.chapterId))
          .filter(Boolean),
      },
      nodes,
      chapters,
    );
    if (!checked.ok) {
      issues.push(
        issueFor(checked.issue, checked.reason, {
          nodeIds: [raw.source, raw.target].filter(Boolean),
          suggestion: "补当前正文可核的引文或显式标记为 inferred/unverified。",
        }),
      );
      continue;
    }
    const existing = edges.find((e) => e.id === checked.edge.id);
    if (existing) {
      Object.assign(existing, checked.edge);
      counts.updated += 1;
    } else {
      edges.push(checked.edge);
      counts.added += 1;
    }
  }
  const coverage = [...current.coverage];
  for (const raw of options.coverage || []) {
    const entry = chapterCoverage(raw);
    const index = coverage.findIndex((c) => c.chapterId === entry.chapterId);
    if (index >= 0) coverage[index] = entry;
    else coverage.push(entry);
  }
  // 合并阶段不能再跑一遍全量归一化：那会把本轮没提到、但当时判定为
  // "无正文可核"的合法边删掉。只校验图自身的一致性（id 唯一、端点存在）。
  let storyEvents = storyEventsSchema.parse({
    version: 1,
    nodes,
    edges,
    coverage,
    issues: dedupeIssues(issues),
  });
  if (chapters.length) {
    // 失效是派生状态：按当前正文复算，标记与报告，不删除节点或边。
    const impact = impactOf(storyEvents, { chapters });
    storyEvents = impact.storyEvents;
    counts.stale = impact.staleNodeIds.length + impact.staleEdgeIds.length;
  }
  return { storyEvents, counts };
}

// 改稿失效传播：只标记与报告，不删除事件、不改正文、不自动补写前情。
export function impactOf(graph, project) {
  const chapters = chapterMap(project.chapters || []);
  const nodes = graph.nodes.map((n) => ({ ...n, stale: null }));
  const edges = graph.edges.map((e) => ({ ...e, stale: null }));
  const staleNodeIds = [];
  const staleEdgeIds = [];
  const issues = [...(graph.issues || [])];
  const check = (evidence) => {
    const source = chapters.get(evidence.chapterId);
    if (!source) return "chapter-missing";
    if (evidence.sourceHash === digest(source.content)) return null;
    return source.content.includes(evidence.quote)
      ? "source-changed"
      : "quote-missing";
  };
  const mark = (target, evidence) => {
    const reason = check(evidence);
    if (!reason) return false;
    target.stale = { at: now(), reason, expectedHash: evidence.sourceHash };
    return true;
  };
  for (const node of nodes) {
    if (!mark(node, node.evidence)) continue;
    staleNodeIds.push(node.id);
    issues.push(
      issueFor(
        "stale-evidence",
        `事件「${node.title}」的出处已与当前正文不一致（${node.stale.reason}）。`,
        {
          nodeIds: [node.id],
          suggestion: "复核该事件是否需要重抽；不要删除，也不要据此改写正文。",
        },
      ),
    );
  }
  const staleSet = new Set(staleNodeIds);
  for (const edge of edges) {
    const covered =
      edge.evidence.length > 0
        ? edge.evidence.every((e) => check(e) === null)
        : true;
    if (!covered || staleSet.has(edge.source) || staleSet.has(edge.target)) {
      edge.stale = {
        at: now(),
        reason: covered ? "source-changed" : check(edge.evidence[0]),
        expectedHash: edge.evidence[0]?.sourceHash ?? "",
      };
      staleEdgeIds.push(edge.id);
    }
  }
  for (const edge of edges) {
    if (!edge.stale) continue;
    issues.push(
      issueFor("stale-evidence", `关系「${edge.source} → ${edge.target}」的来源或端点已失效。`, {
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        suggestion: "核对依据后决定保留、改判为推断或由作者裁定。",
      }),
    );
  }
  const downstream = new Set();
  const queue = [...staleSet];
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge);
  }
  while (queue.length) {
    const current = queue.shift();
    for (const edge of adjacency.get(current) || []) {
      if (!downstream.has(edge.target)) {
        downstream.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  for (const id of staleSet) downstream.delete(id);
  const staleEdges = new Set(staleEdgeIds);
  for (const edge of edges)
    if (staleEdges.has(edge.id)) downstream.delete(edge.source);
  return {
    storyEvents: {
      version: 1,
      nodes,
      edges,
      coverage: graph.coverage || [],
      issues: dedupeIssues(issues),
    },
    staleNodeIds,
    staleEdgeIds,
    downstreamNodeIds: [...downstream],
    issues: issues.filter((i) => i.kind === "stale-evidence"),
  };
}

export function storySubgraph(
  graph,
  { chapterIds, eventIds, actors, objects, depth = 1, direction = "both" } = {},
) {
  const seed = new Set(eventIds || []);
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const node of graph.nodes) {
    if (chapterIds && chapterIds.includes(node.chapterId)) seed.add(node.id);
    if (actors && actors.length && node.actors.some((a) => actors.includes(a)))
      seed.add(node.id);
    if (objects && objects.length && node.objects.some((o) => objects.includes(o)))
      seed.add(node.id);
  }
  const included = new Set(seed);
  const edgeIn = new Map();
  const edgeOut = new Map();
  for (const edge of graph.edges) {
    if (!edgeIn.has(edge.target)) edgeIn.set(edge.target, []);
    edgeIn.get(edge.target).push(edge);
    if (!edgeOut.has(edge.source)) edgeOut.set(edge.source, []);
    edgeOut.get(edge.source).push(edge);
  }
  let frontier = [...seed];
  for (let level = 0; level < depth; level += 1) {
    const next = [];
    for (const id of frontier) {
      const pick = [];
      if (direction === "up" || direction === "both")
        pick.push(...(edgeIn.get(id) || []).map((e) => e.source));
      if (direction === "down" || direction === "both")
        pick.push(...(edgeOut.get(id) || []).map((e) => e.target));
      for (const other of pick)
        if (!included.has(other)) {
          included.add(other);
          next.push(other);
        }
    }
    frontier = next;
  }
  const edges = graph.edges.filter(
    (e) => included.has(e.source) && included.has(e.target),
  );
  return {
    nodes: [...included].map((id) => nodesById.get(id)).filter(Boolean),
    edges,
    seeds: [...seed],
  };
}

export function storyEventIssues(graph, { disposition, kind } = {}) {
  return (graph.issues || []).filter(
    (issue) =>
      (!disposition || issue.disposition === disposition) &&
      (!kind || issue.kind === kind),
  );
}

// 作者对某个问题的处理决定：只改目标 issue 的 disposition。
// 不做任何归一化——归一化会按"当前正文"重判证据，可能丢掉既有边、
// 也可能把别人已保存的处理结果清掉。这里只做不可变更新。
export function setIssueDisposition(graph, issueId, disposition) {
  if (!STORY_ISSUE_DISPOSITIONS.includes(disposition))
    throw Error(
      `处理状态必须是 ${STORY_ISSUE_DISPOSITIONS.join("/")}，收到「${disposition}」。`,
    );
  const issues = Array.isArray(graph?.issues) ? graph.issues : [];
  if (!issues.some((item) => item?.id === issueId))
    throw Error(`找不到要处理的问题「${issueId}」。`);
  return {
    ...graph,
    issues: issues.map((item) =>
      item?.id === issueId ? { ...item, disposition } : item,
    ),
  };
}
