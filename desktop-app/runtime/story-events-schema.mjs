import { z } from "zod";

export const STORY_EVENT_KINDS = [
  "action",
  "decision",
  "discovery",
  "handover",
  "state-change",
  "recall",
  "other",
];
export const STORY_EVENT_STATUSES = [
  "confirmed",
  "candidate",
  "provisional",
  "conflict",
];
export const STORY_EVENT_BASES = [
  "narration",
  "testimony",
  "document",
  "belief",
  "rumor",
  "author",
];
export const STORY_EDGE_TYPES = [
  "causal",
  "knowledge",
  "state-transfer",
  "recall",
  "foreshadow",
  "payoff",
  "support",
  "contradict",
  "related",
];
export const STORY_EDGE_BASES = [
  "explicit",
  "inferred",
  "author-confirmed",
  "unverified",
];
export const STORY_COVERAGE_STATUSES = [
  "extracted",
  "partial",
  "failed",
  "pending",
];
export const STORY_ISSUE_KINDS = [
  "missing-source",
  "state-break",
  "unsourced-knowledge",
  "conflict",
  "stale-evidence",
];
export const STORY_ISSUE_DISPOSITIONS = [
  "open",
  "kept",
  "dismissed",
  "author-decided",
];
export const STORY_REVIEW_STATES = [
  "unreviewed",
  "checked",
  "flagged",
  "author-confirmed",
];

const short = (max) => z.string().max(max);
const id = z.string().min(1).max(120);
const quote = z.string().min(1).max(2000);

// 出处由 chapterId + 原文区间 + 逐字引文三件套构成，sourceHash 用于判定改稿后是否失效。
export const storyEvidenceSchema = z
  .object({
    chapterId: id,
    sourceHash: z.string().max(128),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    quote,
  })
  .strict();

export const storyReviewSchema = z
  .object({
    state: z.enum(STORY_REVIEW_STATES),
    note: short(2000),
    at: z.string().max(40).nullable(),
  })
  .strict();

export const storyStaleSchema = z
  .object({
    at: z.string().max(40),
    reason: z.enum(["source-changed", "quote-missing", "chapter-missing"]),
    expectedHash: z.string().max(128),
  })
  .strict();

export const storyNodeSchema = z
  .object({
    id,
    chapterId: id,
    chapterNumber: z.number().int().positive(),
    chapterTitle: short(400),
    storyTime: short(160),
    narrativeOffset: z.number().int(),
    title: z.string().min(1).max(200),
    summary: short(1200),
    kind: z.enum(STORY_EVENT_KINDS),
    actors: z.array(short(80)).max(24),
    objects: z.array(short(80)).max(24),
    status: z.enum(STORY_EVENT_STATUSES),
    basis: z.enum(STORY_EVENT_BASES),
    evidence: storyEvidenceSchema,
    review: storyReviewSchema,
    stale: storyStaleSchema.nullable(),
  })
  .strict();

export const storyEdgeSchema = z
  .object({
    id,
    source: id,
    target: id,
    type: z.enum(STORY_EDGE_TYPES),
    basis: z.enum(STORY_EDGE_BASES),
    explanation: z.string().max(2000),
    evidence: z.array(storyEvidenceSchema).max(24),
    review: storyReviewSchema,
    stale: storyStaleSchema.nullable(),
  })
  .strict();

export const storyCoverageSchema = z
  .object({
    chapterId: id,
    status: z.enum(STORY_COVERAGE_STATUSES),
    parts: z.array(z.number().int().nonnegative()).max(10000),
    extractedAt: z.string().max(40).nullable(),
    model: short(160),
    failure: z.string().max(2000).nullable(),
  })
  .strict();

export const storyIssueSchema = z
  .object({
    id,
    kind: z.enum(STORY_ISSUE_KINDS),
    nodeIds: z.array(id).max(200),
    edgeIds: z.array(id).max(200),
    explanation: z.string().max(2000),
    suggestion: z.string().max(2000),
    disposition: z.enum(STORY_ISSUE_DISPOSITIONS),
  })
  .strict();

const uniqueIds = (items, label) => {
  const ids = items.map((item) => item.id);
  return new Set(ids).size === ids.length ? null : `${label}标识重复`;
};

export const storyEventsSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(storyNodeSchema).max(20000),
    edges: z.array(storyEdgeSchema).max(40000),
    coverage: z.array(storyCoverageSchema).max(2000),
    issues: z.array(storyIssueSchema).max(20000),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    if (uniqueIds(graph.nodes, "事件")) ctx.addIssue({ code: "custom", message: uniqueIds(graph.nodes, "事件") });
    if (uniqueIds(graph.edges, "关系")) ctx.addIssue({ code: "custom", message: uniqueIds(graph.edges, "关系") });
    if (graph.edges.some((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target)))
      ctx.addIssue({ code: "custom", message: "关系必须连接两个存在的事件" });
  });

// 模型提交的增量：只给事件内容与原文依据，id 与 sourceHash 由程序分配。
export const storyNodeDraftSchema = storyNodeSchema
  .omit({ id: true, chapterNumber: true, chapterTitle: true, evidence: true })
  .extend({
    chapterId: id,
    evidence: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        quote: quote,
      })
      .strict(),
  })
  .partial({
    storyTime: true,
    narrativeOffset: true,
    summary: true,
    kind: true,
    actors: true,
    objects: true,
    status: true,
    basis: true,
    review: true,
    stale: true,
  });

export const storyEdgeDraftSchema = storyEdgeSchema
  .omit({ id: true, evidence: true })
  .extend({
    evidence: z
      .array(
        z
          .object({
            chapterId: id,
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            quote,
          })
          .strict(),
      )
      .max(24),
  })
  .partial({
    basis: true,
    explanation: true,
    evidence: true,
    review: true,
    stale: true,
  });

export const storyEventsPatchSchema = z
  .object({
    nodes: z.array(storyNodeDraftSchema).max(400),
    edges: z.array(storyEdgeDraftSchema).max(800),
    // 增量补丁允许省略边与覆盖记录：只提交本章新增事件也是合法候选。
    coverage: z.array(storyCoverageSchema).max(200).optional(),
    // 候选需要携带本轮发现的问题，否则问题无法随候选预览、采纳后保存。
    issues: z.array(storyIssueSchema).max(2000).optional(),
  })
  .strict()
  .partial({ edges: true });

// 候选既可是本章增量补丁（草稿形态，无 id/version），也兼容已存在的完整图候选。
export const storyEventsProposalSchema = z.union([
  storyEventsPatchSchema,
  storyEventsSchema,
]);
