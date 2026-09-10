import { useStudio } from "../state/StudioContext";
import type { ChapterTask, DraftAction } from "../lib/types";
import { draftCommand } from "../lib/draft-command";
import { draftFeedback } from "../lib/draft-feedback";
const labels = {
  continue: "继续自动修改",
  revise: "按要求修改草稿",
  regenerate: "按指定范围重新生成",
  keep: "保留所选问题的原文",
  edit: "保存手动修改",
  restore: "恢复所选草稿版本",
  deliver: "交付当前草稿",
};
export function useDraftActions(task: ChapterTask | null | undefined) {
  const s = useStudio();
  const available = !!task?.workspace?.canGuide && !s.busy && !s.switching;
  const active = !!task && s.draftAction?.taskId === task.id;
  const candidate = s.project?.messages.find(
    (m) =>
      m.taskId === task?.id &&
      m.status === "pending" &&
      m.proposal?.chapters?.some(
        (c) => c.id === task?.chapterId && c.content === task?.draft,
      ),
  );
  const feedback =
    active && s.busy
      ? {
          kind: "running" as const,
          text: `${labels[s.draftAction!.type]}：${s.progress || "正在提交…"}`,
        }
      : s.error
        ? { kind: "error" as const, text: s.error }
        : draftFeedback(task);
  async function act(
    type: DraftAction["type"],
    instruction = "",
    extra: Partial<DraftAction> = {},
  ) {
    if (!task?.workspace || !available) return false;
    return s.generate(
      type === "revise" || type === "continue"
        ? instruction
        : instruction || labels[type],
      {
        authorAction: {
          ...extra,
          type,
          id: crypto.randomUUID(),
          taskId: task.id,
          draftVersion: extra.draftVersion || task.workspace.version,
        },
      },
    );
  }
  async function submit(text: string) {
    if (!task?.workspace) return false;
    try {
      const command = draftCommand(text, task.workspace);
      return await act(command.type, text, { scope: command.scope });
    } catch (error) {
      s.setError((error as Error).message);
      return false;
    }
  }
  return {
    available,
    act,
    submit,
    feedback,
    candidate,
    running: active && s.busy,
    cancel: s.cancel,
  };
}
