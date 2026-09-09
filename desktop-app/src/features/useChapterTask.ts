import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { useStudio } from "../state/StudioContext";
import type { ChapterTask } from "../lib/types";
// 全局处理面板只读任务，不在每次轮询时加载全书记忆。
export function useChapterTask() {
  const { project, busy } = useStudio();
  const [snapshot, setSnapshot] = useState<{
    projectId: string;
    task: ChapterTask | null;
  } | null>(null);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await bridge.task(project!.projectId);
        if (alive) setSnapshot({ projectId: project!.projectId, task: next });
      } catch {
        if (alive) setSnapshot(null);
      } finally {
        if (alive && busy) timer = setTimeout(refresh, 2500);
      }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project?.projectId, project?.revision, busy]);
  return snapshot?.projectId === project?.projectId
    ? snapshot?.task || null
    : null;
}
