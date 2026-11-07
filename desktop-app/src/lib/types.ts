export interface Author {
  name: string;
  personality: string;
  chinese: string;
  western: string;
  habits: string;
  references: string;
  avoid: string;
}
export interface Premise {
  title: string;
  genre: string;
  setting: string;
  theme: string;
  narrator: string;
  chapterCount: number;
  chapterWords: number;
}
export interface Plan {
  outline: string;
  truth: string;
  timeline: string;
  reveals: string;
}
export interface Character {
  id: string;
  name: string;
  role: string;
  goal: string;
  secret: string;
  voice: string;
  position: { x: number; y: number };
}
export interface Relation {
  id: string;
  source: string;
  target: string;
  label: string;
  detail: string;
}
export interface Chapter {
  id: string;
  number: number;
  title: string;
  summary: string;
  content: string;
}
export interface Proposal {
  summary: string;
  memory?: StoryMemory;
  // 候选事件链：增量补丁（草稿形态）或已合并的完整图。
  storyEvents?: StoryEvents | StoryEventsPatch;
  revisionScope?: string[];
  author?: Author;
  premise?: Premise;
  plan?: Plan;
  characters?: Character[];
  relations?: Relation[];
  chapters?: Chapter[];
}
export interface Message {
  taskId?: string;
  createdAt?: string;
  handledAt?: string;
  id: string;
  role: "user" | "assistant";
  text: string;
  proposal?: Proposal;
  baseRevision?: number;
  status?: "pending" | "accepted" | "rejected";
  model?: string;
}
export interface Project {
  rewrite?: { epoch: string; backupId: string; instruction: string };
  writingSettings?: { wordTolerance: WordTolerance };
  projectId: string;
  schemaVersion: 1;
  revision: number;
  author: Author;
  premise: Premise;
  plan: Plan;
  characters: Character[];
  relations: Relation[];
  chapters: Chapter[];
  messages: Message[];
  demo: boolean;
  memory?: StoryMemory;
}
export interface WordTolerance {
  mode: "absolute" | "percent";
  value: number;
}
export interface MemoryRecord {
  kind: "event" | "state" | "knowledge" | "thread" | "foreshadow";
  text: string;
  entities: string[];
  storyTime: string;
  knownBy: string[];
  epistemic: "observed" | "belief" | "rumor" | "unknown";
  quote: string;
}
export interface MemoryEntry {
  dependencyScope?: "chapter";
  chapterId: string;
  sourceHash: string;
  part: number;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  summary: string;
  records: MemoryRecord[];
}
export interface StoryMemory {
  version: 1;
  entries: MemoryEntry[];
}
export interface MemoryView {
  version: number;
  entries: (MemoryEntry & { current: boolean })[];
  chapters: {
    id: string;
    number: number;
    title: string;
    hasContent: boolean;
    indexed: boolean;
  }[];
}
export interface ReviewDecision {
  taskId: string;
  pendingId: string;
  choices: { issueId: string; optionId: string; instruction?: string }[];
}
export interface PendingReview {
  answers?: { issueId: string; optionId: string; instruction?: string }[];
  id: string;
  documentVersion: string;
  reason: string;
  issues: {
    id: string;
    explanation: string;
    target: { sourceId: string; paragraph: number; quote: string };
    evidence: { sourceId: string; paragraph: number; quote: string }[];
    options: { id: string; label: string; action: string }[];
  }[];
}
export interface ChapterTask {
  workspace?: DraftWorkspaceState | null;
  reviewProgress?: {
    phase: string;
    label: string;
    failure: { kind: string; detail: string; summary: string } | null;
    issues: {
      id: string;
      status: string;
      explanation: string;
      requiresInstruction?: boolean;
    }[];
    decisions: number;
  } | null;
  review?: PendingReview | null;
  draft: string;
  id: string;
  status: string;
  stage: string;
  error: string;
  chapterId?: string;
  updatedAt: string;
  resumable: boolean;
  fragments: { key: string; text: string }[];
  manifest: {
    chapterId: string;
    part: number;
    sourceHash: string;
    reason: string;
  }[];
}
export interface DraftScope {
  kind: "chapter" | "scene" | "paragraph";
  sourceId?: string;
  paragraph?: number;
}
export interface DraftAction {
  id: string;
  taskId: string;
  draftVersion: string;
  type:
    | "continue"
    | "revise"
    | "regenerate"
    | "keep"
    | "edit"
    | "restore"
    | "deliver";
  scope?: DraftScope;
  issueIds?: string[];
  text?: string;
  versionId?: string;
}
export interface DraftWorkspaceState {
  version: string;
  canGuide: boolean;
  budget: { epoch: number; used: number; limit: number };
  lastInstruction: string;
  lastAction?: {
    id: string;
    type: DraftAction["type"];
    changed: boolean;
  } | null;
  scenes: {
    scene: number;
    sourceId: string;
    content: string;
    paragraphs: { paragraph: number; text: string }[];
  }[];
  versions: {
    id: string;
    label: string;
    status: string;
    at: string;
    reason: string;
    text: string;
  }[];
}
export interface GenerationOptions {
  authorAction?: DraftAction;
  authorInterventionId?: string;
  decision?: ReviewDecision;
  chapterId?: string;
  mode?: "memory";
  resume?: boolean;
  words?: number;
}
export type Provider = "glm" | "minimax";
export interface ProviderConfig {
  provider: Provider;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  limits?: Partial<ModelLimits>;
  limitKey?: string;
  capabilities?: ModelLimits & {
    contextLimit: number;
    confidence: string;
    source: string;
  };
}
export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  appContextCap: number;
  maxInputTokens: number | null;
  endpointContextLimit: number | null;
}
export type Settings = Record<Provider, ProviderConfig>;
export interface ProjectSummary {
  id: string;
  title: string;
  genre: string;
  chapters: number;
  revision: number;
  archived: boolean;
}
export type StoryEventKind =
  | "action"
  | "decision"
  | "discovery"
  | "handover"
  | "state-change"
  | "recall"
  | "other";
export type StoryEventStatus =
  | "confirmed"
  | "candidate"
  | "provisional"
  | "conflict";
export type StoryEventBasis =
  | "narration"
  | "testimony"
  | "document"
  | "belief"
  | "rumor"
  | "author";
export type StoryEdgeType =
  | "causal"
  | "knowledge"
  | "state-transfer"
  | "recall"
  | "foreshadow"
  | "payoff"
  | "support"
  | "contradict"
  | "related";
export type StoryEdgeBasis =
  | "explicit"
  | "inferred"
  | "author-confirmed"
  | "unverified";
export type StoryCoverageStatus = "extracted" | "partial" | "failed" | "pending";
export type StoryIssueKind =
  | "missing-source"
  | "state-break"
  | "unsourced-knowledge"
  | "conflict"
  | "stale-evidence";
export type StoryIssueDisposition =
  | "open"
  | "kept"
  | "dismissed"
  | "author-decided";
export type StoryReviewState =
  | "unreviewed"
  | "checked"
  | "flagged"
  | "author-confirmed";
export interface StoryEvidence {
  chapterId: string;
  sourceHash: string;
  start: number;
  end: number;
  quote: string;
}
export interface StoryReview {
  state: StoryReviewState;
  note: string;
  at: string | null;
}
export interface StoryStale {
  at: string;
  reason: "source-changed" | "quote-missing" | "chapter-missing";
  expectedHash: string;
}
export interface StoryEventNode {
  id: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  storyTime: string;
  narrativeOffset: number;
  title: string;
  summary: string;
  kind: StoryEventKind;
  actors: string[];
  objects: string[];
  status: StoryEventStatus;
  basis: StoryEventBasis;
  evidence: StoryEvidence;
  review: StoryReview;
  stale: StoryStale | null;
}
export interface StoryEventEdge {
  id: string;
  source: string;
  target: string;
  type: StoryEdgeType;
  basis: StoryEdgeBasis;
  explanation: string;
  evidence: StoryEvidence[];
  review: StoryReview;
  stale: StoryStale | null;
}
export interface StoryCoverage {
  chapterId: string;
  status: StoryCoverageStatus;
  parts: number[];
  extractedAt: string | null;
  model: string;
  failure: string | null;
}
export interface StoryIssue {
  id: string;
  kind: StoryIssueKind;
  nodeIds: string[];
  edgeIds: string[];
  explanation: string;
  suggestion: string;
  disposition: StoryIssueDisposition;
}
export interface StoryEventPatchNode {
  chapterId: string;
  title: string;
  summary?: string;
  kind?: StoryEventKind;
  actors?: string[];
  objects?: string[];
  status?: StoryEventStatus;
  basis?: StoryEventBasis;
  storyTime?: string;
  evidence: { start: number; end: number; quote: string };
}
export interface StoryEventsPatch {
  nodes: StoryEventPatchNode[];
  edges?: unknown[];
  coverage?: StoryCoverage[];
}
export interface StoryEvents {
  version: 1;
  nodes: StoryEventNode[];
  edges: StoryEventEdge[];
  coverage: StoryCoverage[];
  issues: StoryIssue[];
}
export type StoryDirection = "up" | "down" | "both";
export interface StoryEventQuery {
  focusEventId?: string;
  chapterId?: string;
  direction?: StoryDirection;
  depth?: number;
}
export interface StoryEventChapter {
  id: string;
  number: number;
  title: string;
  hasContent: boolean;
  coverage: StoryCoverageStatus | null;
}
export interface CandidateOrigin {
  messageId: string;
  model?: string;
}
export type StoryEventCandidateNode = StoryEventNode & {
  origin: CandidateOrigin;
};
export type StoryEventCandidateEdge = StoryEventEdge & {
  origin: CandidateOrigin;
};
// R8 界面侧：候选自带的问题与正式图 issues 分开，不混为一谈。
export interface StoryCandidateIssue extends StoryIssue {
  origin: CandidateOrigin;
  // 候选问题附带的原文证据，由主进程按候选正文视图回填。
  evidence: StoryEvidence[];
}
export interface StoryEventView {
  graph: StoryEvents;
  view: { nodes: StoryEventNode[]; edges: StoryEventEdge[]; seeds: string[] };
  candidates: {
    nodes: StoryEventCandidateNode[];
    edges: StoryEventCandidateEdge[];
    issues: StoryCandidateIssue[];
  };
  chapters: StoryEventChapter[];
  focus: { eventId: string | null; direction: StoryDirection; depth: number };
  counts: {
    nodes: number;
    edges: number;
    staleNodes: number;
    staleEdges: number;
    candidates: number;
    issues: number;
  };
  warnings: string[];
}
// R7：历史建图的进度视图。字段对应主进程返回，未提供能力时 enabled=false。
export type StoryBuildChapterStatus = StoryCoverageStatus;
export interface StoryBuildChapter {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  status: StoryBuildChapterStatus;
  // 已完成的正文分片序号；空数组表示尚未开始。
  parts: number[];
  eventCount: number;
  failure: string | null;
}
export interface StoryBuildProgress {
  enabled: boolean;
  // idle=可开始；running=进行中；partial=有章失败或未建完；complete=全部已抽取。
  state: "idle" | "running" | "partial" | "complete" | "unsupported";
  mode: "build" | "complete";
  hasContent: boolean;
  chapters: StoryBuildChapter[];
  counts: {
    total: number;
    extracted: number;
    partial: number;
    failed: number;
    pending: number;
  };
  failure: string | null;
  // 只更新派生事件数据、不改正文，界面必须原样转述这句。
  touchesManuscript: false;
}
// R9：作者对单个问题的处理决定。沿用 runtime 既有 disposition 枚举，不另造。
export type StoryIssueDecision = Exclude<StoryIssueDisposition, "open">;
export interface StoryIssueDecisionRequest {
  projectId: string;
  issueId: string;
  decision: StoryIssueDecision;
  note?: string;
}
// R9：显式修订请求。只生成请求体交给既有草稿修订流程，不新建正文写入口。
export interface StoryRevisionRequest {
  issueId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  explanation: string;
  suggestion: string;
  evidence: StoryEvidence[];
  instruction: string;
}
export interface Bridge {
  storyBuild: (
    id: string,
    options?: { chapters?: string[]; mode?: "build" | "complete" },
  ) => Promise<StoryBuildProgress>;
  decideStoryIssue: (
    request: StoryIssueDecisionRequest,
  ) => Promise<StoryEvents>;
  storyEvents: (
    id: string,
    query?: StoryEventQuery,
  ) => Promise<StoryEventView>;
  rewrite: (
    id: string,
    revision: number,
    instruction: string,
  ) => Promise<Project>;
  rewriteBackups: (id: string) => Promise<RewriteBackup[]>;
  restoreRewrite: (
    id: string,
    backupId: string,
    revision: number,
  ) => Promise<Project>;
  logs: (id: string, options?: CreationLogOptions) => Promise<CreationLogView>;
  logNode: (
    id: string,
    taskId: string,
    nodeId: string,
  ) => Promise<ExecutionNodeDetail>;
  memory: (id: string) => Promise<MemoryView>;
  task: (id: string) => Promise<ChapterTask | null>;
  load: (id?: string) => Promise<Project>;
  list: () => Promise<ProjectSummary[]>;
  select: (id: string) => Promise<Project>;
  create: (title: string) => Promise<Project>;
  rename: (id: string, title: string) => Promise<Project>;
  archive: (id: string, archived: boolean) => Promise<Project>;
  save: (p: Project, r: number) => Promise<Project>;
  accept: (projectId: string, id: string) => Promise<Project>;
  settings: () => Promise<Settings>;
  saveSettings: (c: ProviderConfig & { apiKey: string }) => Promise<Settings>;
  test: (p: Provider) => Promise<{ text: string; model: string }>;
  generate: (r: {
    authorAction?: DraftAction;
    authorInterventionId?: string;
    projectId: string;
    instruction: string;
    provider: Provider;
    revision: number;
    chapterId?: string;
    mode?: "memory";
    resume?: boolean;
    decision?: ReviewDecision;
    words?: number;
  }) => Promise<Project>;
  cancel: () => Promise<void>;
  export: (id: string, format: "json" | "md") => Promise<boolean>;
  onProgress: (fn: (s: string) => void) => () => void;
}
export interface RewriteBackup {
  id: string;
  projectId: string;
  createdAt: string;
  reason: "rewrite" | "restore";
  title: string;
  revision: number;
  chapters: number;
}
export interface CreationLogOptions {
  taskId?: string;
  offset?: number;
  limit?: number;
  category?: string;
  query?: string;
  onlyProblems?: boolean;
}
export interface CreationLogTask {
  id: string;
  chapter: string;
  instruction: string;
  status: string;
  stage: string;
  model: string;
  calls: number;
  updatedAt: string | null;
  legacy: boolean;
}
export interface CreationLogEvent {
  id: string;
  at: string | null;
  category: string;
  status: string;
  title: string;
  details: Record<string, string | number>;
}
export interface CreationLogView {
  flow: {
    nodes: ExecutionNodeSummary[];
    edges: {
      id: string;
      source: string;
      target: string;
      kind: "dependency" | "sequence";
    }[];
    total: number;
  };
  tasks: CreationLogTask[];
  selected: CreationLogTask | null;
  events: CreationLogEvent[];
  total: number;
  matched: number;
  hasMoreEvents: boolean;
  offset: number;
  hasOlderTasks: boolean;
  warnings: string[];
}
export interface ExecutionNodeSummary {
  id: string;
  label: string;
  kind: string;
  category: string;
  status: string;
  source: string;
  startedAt: string | null;
  attemptCount: number;
  hasProblems: boolean;
}
export interface ExecutionAttempt {
  id: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  input?: unknown;
  request?: unknown;
  requestNote: string;
  rawOutput?: string;
  rawNote: string;
  parsedOutput?: unknown;
  acceptedOutput?: unknown;
  responseMeta?: { model?: string; finishReason?: string; usage?: unknown };
  validation?: { passed: boolean; stage?: string; detail: string };
  error?: string;
  partial?: boolean;
  resultKey?: string;
}
export interface ExecutionNodeDetail extends ExecutionNodeSummary {
  input?: unknown;
  inputNote?: string;
  acceptedOutput?: unknown;
  outputKey?: string;
  error?: string;
  contract?: string;
  details?: Record<string, string | number>;
  redacted?: boolean;
  attempts: ExecutionAttempt[];
  reuses?: unknown[];
  dependencies?: string[];
}
declare global {
  interface Window {
    studio?: Bridge;
  }
}
