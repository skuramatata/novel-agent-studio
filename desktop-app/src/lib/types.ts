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
export interface Bridge {
  logs: (id: string, options?: CreationLogOptions) => Promise<CreationLogView>;
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
declare global {
  interface Window {
    studio?: Bridge;
  }
}
