import { mergeStoryEvents, normalizeStoryEvents } from "./story-events.mjs";

// 采纳候选时的图合并入口。
// 单独成文件，是为了让 runtime/schema.mjs 的依赖树保持纯净：
// schema.mjs 会被 renderer（src/lib/bridge.ts）引用，而 story-events.mjs
// 依赖 node:crypto，不能进入浏览器包。需要合并的调用方只从本文件引入。
export function applyStoryEventPatch(project, patch) {
  if (!patch) return project.storyEvents;
  // 旧图必须带章节信息归一化：否则合法 explicit 边会因"没有正文可核"被丢弃。
  const chapters = project.chapters || [];
  return mergeStoryEvents(
    normalizeStoryEvents({ ...project.storyEvents, chapters }),
    patch.nodes || [],
    {
      chapters,
      edges: patch.edges || [],
      coverage: patch.coverage || [],
    },
  ).storyEvents;
}

// 候选可能是增量补丁，也可能是已合并好的完整图；两者都要能落地。
export function resolveProposalStoryEvents(project, storyEvents) {
  if (!storyEvents) return project.storyEvents;
  if (storyEvents.version === 1 && Array.isArray(storyEvents.issues))
    return normalizeStoryEvents({
      ...storyEvents,
      chapters: project.chapters,
    });
  return applyStoryEventPatch(project, storyEvents);
}
