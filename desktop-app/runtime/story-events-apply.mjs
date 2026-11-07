import { mergeStoryEvents, normalizeStoryEvents } from "./story-events.mjs";

// 采纳候选时的图合并入口。
// 单独成文件，是为了让 runtime/schema.mjs 的依赖树保持纯净：
// schema.mjs 会被 renderer（src/lib/bridge.ts）引用，而 story-events.mjs
// 依赖 node:crypto，不能进入浏览器包。需要合并的调用方只从本文件引入。
export function applyStoryEventPatch(project, patch) {
  if (!patch) return project.storyEvents;
  // 旧图必须带章节信息归一化：否则合法 explicit 边会因"没有正文可核"被丢弃。
  const chapters = project.chapters || [];
  const merged = mergeStoryEvents(
    normalizeStoryEvents({ ...project.storyEvents, chapters }),
    patch.nodes || [],
    {
      chapters,
      edges: patch.edges || [],
      coverage: patch.coverage || [],
    },
  ).storyEvents;
  return mergeIssues(merged, patch.issues || []);
}

// 候选问题必须随采纳落地；同 id 的既有问题保留作者已做出的处理决定，
// 避免无关合并把 kept/dismissed/author-decided 重置回 open。
export function mergeIssues(storyEvents, incoming = []) {
  if (!incoming.length) return storyEvents;
  const issues = [...(storyEvents.issues || [])];
  const indexById = new Map(issues.map((issue, index) => [issue.id, index]));
  for (const raw of incoming) {
    const index = indexById.get(raw.id);
    if (index === undefined) {
      issues.push(raw);
      indexById.set(raw.id, issues.length - 1);
      continue;
    }
    const existing = issues[index];
    // 作者已处理过的决定优先保留；仅当既有仍为 open 时才接受候选更新。
    issues[index] =
      existing.disposition && existing.disposition !== "open"
        ? existing
        : { ...existing, ...raw };
  }
  return { ...storyEvents, issues };
}

// 候选可能是增量补丁，也可能是已合并好的完整图；两者都要能落地。
export function resolveProposalStoryEvents(project, storyEvents) {
  if (!storyEvents) return project.storyEvents;
  if (storyEvents.version === 1 && Array.isArray(storyEvents.issues)) {
    const normalized = normalizeStoryEvents({
      ...storyEvents,
      chapters: project.chapters,
    });
    // 完整图候选同样不得抹掉作者在正式图上做过的处理决定。
    const decided = (project.storyEvents?.issues || []).filter(
      (issue) => issue.disposition && issue.disposition !== "open",
    );
    return mergeIssues(normalized, decided);
  }
  return applyStoryEventPatch(project, storyEvents);
}
