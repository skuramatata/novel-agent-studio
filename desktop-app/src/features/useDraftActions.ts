import { useStudio } from "../state/StudioContext";
import type { ChapterTask, DraftAction } from "../lib/types";
import { draftCommand } from "../lib/draft-command";
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
  const available = !!task?.workspace?.canGuide && !s.busy;
  async function act(
    type: DraftAction["type"],
    instruction = "",
    extra: Partial<DraftAction> = {},
  ) {
    if (!task?.workspace || !available) return false;
    return s.generate(instruction || labels[type], {
      authorAction: {
        ...extra,
        type,
        id: crypto.randomUUID(),
        taskId: task.id,
        draftVersion: extra.draftVersion || task.workspace.version,
      },
    });
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
  return { available, act, submit };
}
