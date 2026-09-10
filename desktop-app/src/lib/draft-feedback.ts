import type { ChapterTask, DraftAction } from "./types";

export function draftActionSucceeded(
  task: ChapterTask | null,
  action: DraftAction,
) {
  if (task?.id !== action.taskId) return false;
  return ["keep", "edit", "restore"].includes(action.type)
    ? task.status === "awaiting_instruction"
    : task.status === "completed";
}

export function draftFeedback(task: ChapterTask | null | undefined): {
  kind: "success" | "attention" | "error";
  text: string;
} | null {
  const action = task?.workspace?.lastAction;
  if (!task || !action || !task.workspace?.canGuide) return null;
  const remaining = (task.reviewProgress?.issues || []).filter(
    (i) => !["closed", "verified", "stale"].includes(i.status),
  );
  const changed = action.changed ? "当前草稿已更新。" : "本次正文没有变化。";
  if (task.status === "failed" || task.status === "interrupted")
    return {
      kind: "error",
      text: `${changed}${task.error || "操作中断，已保存进度可继续处理。"}`,
    };
  if (["awaiting_input", "retryable"].includes(task.status))
    return {
      kind: "attention",
      text: `${changed}${task.error || task.reviewProgress?.failure?.summary || "需要补充具体修改要求或回答情节确认，才能继续处理。"}`,
    };
  if (action.type === "restore")
    return {
      kind: "success",
      text: action.changed
        ? "已恢复所选版本，右侧当前草稿已更新；恢复前的版本仍可找回。"
        : "所选版本与当前草稿相同，正文没有变化。",
    };
  if (action.type === "keep")
    return { kind: "success", text: "已保留所选原文，并关闭对应问题。" };
  if (action.type === "edit")
    return {
      kind: "success",
      text: action.changed
        ? "手动修改已保存，自动修订额度已重置。"
        : "已保存，正文与修改前相同。",
    };
  if (action.type === "deliver")
    return {
      kind: "success",
      text: `已生成待采纳候选，采纳后才更新正式章节。${remaining.length ? `仍有 ${remaining.length} 项问题或建议。` : ""}`,
    };
  return {
    kind:
      task.status === "awaiting_instruction" || remaining.length
        ? "attention"
        : "success",
    text: `${changed}${task.status === "awaiting_instruction" ? task.error || "本回合自动处理已结束，可补充要求后继续。" : "已生成待采纳候选。"}${remaining.length ? `仍有 ${remaining.length} 项问题或建议；标为“需补充要求”的条目需要说明怎么改，或选择保留原文。` : ""}`,
  };
}
