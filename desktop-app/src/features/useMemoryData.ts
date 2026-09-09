import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { useStudio } from "../state/StudioContext";
import type { ChapterTask, MemoryView } from "../lib/types";
export function useMemoryData() {
  const { project, busy } = useStudio();
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [task, setTask] = useState<ChapterTask | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const refresh = async () => {
      try {
        const [m, t] = await Promise.all([
          bridge.memory(project!.projectId),
          bridge.task(project!.projectId),
        ]);
        if (alive) {
          setMemory(m);
          setTask(t);
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) {
          setLoading(false);
          if (busy) timer = setTimeout(refresh, 2500);
        }
      }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project?.projectId, project?.revision, busy]);
  return { memory, task, error, loading };
}
