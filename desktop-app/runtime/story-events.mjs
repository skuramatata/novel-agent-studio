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
  // 旧证据读取/合并时必须保留它建立时的哈希：
  // 用当前正文重算会悄悄"重新盖章"，让改稿后的失效消失（失效数变 0）。
  // 只有模型新草稿（无 sourceHash）才按当前正文建立哈希。
  const established =
    typeof raw.sourceHash === "string" && raw.sourceHash ? raw.sourceHash : null;
  return {
    chapterId,
    sourceHash: established ?? digest(source.content),
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

// 跨批次（历史节点 vs 新草稿）的匹配：同章且区间重叠或完全相同是硬条件。
// 只共享同一句引文不再构成匹配证据——同一句原文里可以抽出多件事，
// 且同一句在正文别处重复出现时也不能因此并成一条。
function matchScore(node, draft) {
  if (node.chapterId !== draft.chapterId) return 0;
  if (!overlaps(node.evidence, draft.evidence)) return 0;
  let score = 1;
  if (
    node.evidence.start === draft.evidence.start &&
    node.evidence.end === draft.evidence.end
  )
    score += 2;
  if (node.evidence.quote === draft.evidence.quote) score += 1;
  score += textScore(node.title, draft.title);
  if (textScore(node.summary, draft.summary) > 0) score += 1;
  const sharedActors = draft.actors.filter((a) => node.actors.includes(a)).length;
  const sharedObjects = draft.objects.filter((o) => node.objects.includes(o)).length;
  if (sharedActors) score += 1;
  if (sharedObjects) score += 1;
  return score;
}

// 集合比较：参与者与物件只比较集合，不比较列举顺序（顺序不承载身份语义）。
const setKey = (values) => [...new Set(values)].sort().join("|");

// 区间重叠只说明"位置接近"，不能证明是同一事件：同一句原文里可以抽出多件事。
// 因此先做语义判据，再看得分：标题毫无共词时，必须 kind 相同且实体集合相同，
// 才可能是同一事件的改写；否则一律按另一件事新建节点，保留各自身份与连线。
function sameEvent(node, draft, score) {
  if (score < 2) return false;
  // 标题高度相似（完全一致或互相包含）才是同一事件的强证据。
  // 仅"有共词"不足以判同一：同一句里"甲把钥匙交给乙"和"乙把钥匙交给丙"
  // 共词很多，却是两次不同交接，必须保留各自身份。
  const titleScore = textScore(node.title, draft.title);
  if (titleScore >= 2) return true;
  if (node.kind !== draft.kind) return false;
  return (
    setKey(node.objects) === setKey(draft.objects) &&
    setKey(node.actors) === setKey(draft.actors)
  );
}

// 同一批次内的两条草稿只有在标题、类型、区间、参与者集合、物件集合
// 全部相同时才算重复条目；否则各自建节点，避免同句多件事被并成一条。
function duplicateDraft(node, draft) {
  return (
    node.chapterId === draft.chapterId &&
    node.title === draft.title &&
    node.kind === draft.kind &&
    node.evidence.start === draft.evidence.start &&
    node.evidence.end === draft.evidence.end &&
    setKey(node.actors) === setKey(draft.actors) &&
    setKey(node.objects) === setKey(draft.objects)
  );
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
// 草稿预处理：章节缺失与引文不可核在进入身份裁定前就拒绝，
// 让后续归属只面对合法草稿，序号映射仍与输入一一对应（拒绝为 reject）。
function prepareDraft(raw, chapterById, chapters) {
  const source = chapterById.get(raw.chapterId);
  if (!source)
    return {
      reject: issueFor("missing-source", `事件所属章节 ${raw.chapterId} 不在当前作品中。`, {
        suggestion: "确认章节 id 后重新提交。",
      }),
    };
  const evidence = normalizeEvidence(raw.evidence, chapters, raw.chapterId);
  if (!evidence)
    return {
      reject: issueFor(
        "missing-source",
        `事件「${raw.title}」的引文不在第 ${source.number} 章当前正文中。`,
        { suggestion: "改用当前正文中的逐字引文与正确区间。" },
      ),
    };
  return { source, draft: { ...nodeDraft(raw), evidence } };
}

// 历史身份的唯一归属：候选对按得分从高到低裁定，一对身份只能归属一条草稿。
// 同分时用草稿自身签名打破平局（不依赖输入顺序），保证逆序提交结果一致。
// 未获归属的草稿一律新建：绝不与别人共享历史 id，也不会覆盖他人标题与证据。
function assignHistoryNodes(prepared, historyNodes) {
  // 同批等价草稿先按 duplicateDraft 判据归并：一组重复里只有最先出现的一条
  // 参与历史身份裁定，其余留到落点循环按 twin 复用同一节点。
  // 否则两份相同的 A 会分别抢走历史 A、B 两个身份，把 B 改写成第二份 A。
  const owners = [];
  for (const [index, entry] of prepared.entries()) {
    if (entry.reject) continue;
    if (owners.some((owner) => duplicateDraft(owner.draft, entry.draft))) continue;
    owners.push({ index, draft: entry.draft });
  }
  const pairs = [];
  for (const { index } of owners) {
    const entry = prepared[index];
    for (const node of historyNodes) {
      const score = matchScore(node, entry.draft);
      if (!sameEvent(node, entry.draft, score)) continue;
      pairs.push({ index, nodeId: node.id, score, tie: draftSignature(entry.draft) });
    }
  }
  pairs.sort(
    (a, b) => b.score - a.score || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : a.index - b.index),
  );
  const ownerByIndex = new Map();
  const usedNodeIds = new Set();
  for (const pair of pairs) {
    if (ownerByIndex.has(pair.index) || usedNodeIds.has(pair.nodeId)) continue;
    ownerByIndex.set(pair.index, pair.nodeId);
    usedNodeIds.add(pair.nodeId);
  }
  return ownerByIndex;
}

export function mergeStoryEvents(graph, nodeDrafts = [], options = {}) {
  const chapters = options.chapters || (options.chapter ? [options.chapter] : []);
  // 候选增量可引用正式历史端点：调用方声明已知节点后，本轮 edges 的端点
  // 允许指向它；未被声明的端点仍按缺失处理。
  const knownNodeIds =
    options.knownNodeIds instanceof Set
      ? options.knownNodeIds
      : new Set(options.knownNodeIds || []);
  const current = normalizeStoryEvents(
    { ...graph, chapters },
    { knownNodeIds },
  );
  const chapterById = chapterMap(chapters);
  const nodes = current.nodes.map((n) => ({ ...n }));
  // 跨批次匹配只能命中合并前已存在的节点：本批新建的节点不参与匹配，
  // 否则同批两条不同草稿会被后一条"重抽"进前一条，丢掉其中一个身份。
  // 匹配依据必须是合并前的快照，不能与后续原地写入共享引用：
  // 命中后会把 title/actors/evidence 等原地 Object.assign 进历史节点，
  // 共享引用会让下一条草稿按被改写过的内容重新判等，误判成同一事件。
  const historyNodes = current.nodes.map((n) => ({
    ...n,
    actors: [...n.actors],
    objects: [...n.objects],
    evidence: { ...n.evidence },
  }));
  // 本批已被占用的历史身份：一个历史节点在一批草稿里只能承接一条草稿。
  // 两条已被判为不同的事件不得借同一历史 id 互相覆盖——这正是
  // "同一件事只保留一个身份"的反面。真正重复的草稿仍走同批 duplicateDraft 复用。
  const prepared = nodeDrafts.map((raw) => prepareDraft(raw, chapterById, chapters));
  // 历史身份的唯一归属：先对全部草稿做一次快照匹配，再按证据强度全局裁定。
  // 若按遍历顺序"先到先得"，数组顺序就成了身份——同一批逆序提交时，
  // 先出现的那条会抢走历史 id，另一条被迫改名（甚至撞 id 退避），关系随之换指。
  const historyOwner = assignHistoryNodes(prepared, historyNodes);
  const issues = [...current.issues];
  const counts = { added: 0, merged: 0, updated: 0, stale: 0 };
  // 与输入 drafts 一一对应的落点：被拒为 null，新建/复用为节点 id。
  const draftIds = [];
  // 本批已落点的节点 id：同批重复判定只在这些节点里找，不碰历史节点。
  const batchNodeIds = [];
  for (const [index, entry] of prepared.entries()) {
    if (entry.reject) {
      draftIds.push(null);
      issues.push(entry.reject);
      continue;
    }
    const { source, draft } = entry;
    const historyId = historyOwner.get(index) ?? null;
    const best = historyId
      ? historyNodes.find((n) => n.id === historyId) ?? null
      : null;
    // 同批重复条目：只有与本批已落点草稿完全同形时才复用该草稿的节点。
    const twin = [...batchNodeIds]
      .reverse()
      .map((id) => nodes.find((n) => n.id === id))
      .find((node) => node && duplicateDraft(node, draft));
    if (best ?? twin) {
      const matched = best ?? twin;
      // best 来自合并前快照，必须回到 nodes 里的真实节点上写入，
      // 否则更新只落在快照副本上，输出图仍是旧内容。
      const target = nodes.find((n) => n.id === matched.id) ?? matched;
      Object.assign(target, {
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
        evidence: draft.evidence,
        stale: null,
      });
      counts.merged += 1;
      draftIds.push(target.id);
      if (!batchNodeIds.includes(target.id)) batchNodeIds.push(target.id);
      continue;
    }
    const candidate = storyNodeSchema.parse({
      ...draft,
      id: storyEventId({
        chapterId: draft.chapterId,
        title: draft.title,
        start: draft.evidence.start,
        end: draft.evidence.end,
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
    draftIds.push(candidate.id);
    batchNodeIds.push(candidate.id);
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
      knownNodeIds,
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
  // 关系端点可以指向本次增量之外的已存在事件（knownNodeIds / attachNodes）。
  // 输出图必须自洽（关系两端都在 nodes 里），但附挂/占位都只服务校验：
  // - attachNodes 提供真实副本，仅用于撑起收尾校验，不进入输出、不计入 added；
  // - 只声明 knownNodeIds 而无副本时，用最小占位同样只服务校验。
  // 需要展示跨章边的调用方（如候选预览）自行把被引用的正式节点补进视图。
  const attach = new Map(
    (options.attachNodes || []).filter(Boolean).map((n) => [n.id, n]),
  );
  const knownEndpointIds =
    options.knownNodeIds instanceof Set
      ? new Set(options.knownNodeIds)
      : new Set(options.knownNodeIds || []);
  const present = new Set(nodes.map((n) => n.id));
  const externalEndpoints = new Set();
  for (const edge of edges) {
    for (const id of [edge.source, edge.target]) {
      if (present.has(id)) continue;
      if (attach.has(id) || knownEndpointIds.has(id)) externalEndpoints.add(id);
      else
        throw Error(
          `关系指向不存在的事件：${id}；既不在本次节点中，也未通过 knownNodeIds 声明为已存在。`,
        );
    }
  }
  // 收尾校验用节点：真实节点 + 外部端点占位（真实副本优先，否则借用形状）。
  const schemaNodes = [...nodes];
  for (const id of externalEndpoints) {
    const source = attach.get(id) ?? nodes[0];
    schemaNodes.push({ ...source, id, evidence: { ...source.evidence } });
  }
  let storyEvents = storyEventsSchema.parse({
    version: 1,
    nodes: schemaNodes,
    edges,
    coverage,
    issues: dedupeIssues(issues),
  });
  if (externalEndpoints.size) {
    // 占位/附挂都不属于本次合并输出；边保留并继续指向正式事件 id。
    storyEvents = {
      ...storyEvents,
      nodes: storyEvents.nodes.filter((n) => !externalEndpoints.has(n.id)),
    };
  }
  if (chapters.length) {
    // 失效是派生状态：按当前正文复算，标记与报告，不删除节点或边。
    const impact = impactOf(storyEvents, { chapters });
    storyEvents = impact.storyEvents;
    counts.stale = impact.staleNodeIds.length + impact.staleEdgeIds.length;
  }
  // draftIds 与输入 drafts 一一对应（拒绝为 null）。调用方据此解析关系端点，
  // 不需要再按标题 + 区间回查——合并会覆盖 title，回查会指向错误事件。
  return { storyEvents, counts, draftIds };
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
    // 逐份检查：多证据关系里，失效的未必是第一份。
    // 只取 evidence[0] 会在"首份有效、后份失效"时得到 null 原因，
    // 导致 schema 拒绝、候选无法保存。
    const failedEvidence = edge.evidence.find((e) => check(e) !== null) || null;
    const evidenceStale = failedEvidence !== null;
    if (evidenceStale || staleSet.has(edge.source) || staleSet.has(edge.target)) {
      edge.stale = {
        at: now(),
        // 证据失效时必须用真正失效那一份的原因与原哈希；
        // 仅端点失效（证据本身仍有效）时沿用首份证据的哈希，原因记来源变化。
        reason: evidenceStale ? check(failedEvidence) : "source-changed",
        expectedHash: evidenceStale
          ? failedEvidence.sourceHash ?? ""
          : edge.evidence[0]?.sourceHash ?? "",
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
