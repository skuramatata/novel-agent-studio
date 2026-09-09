import { useEffect, useState } from "react";
import { useStudio } from "../state/StudioContext";
import { bridge } from "../lib/bridge";
import type { CreationLogOptions, CreationLogView } from "../lib/types";
export function useCreationLogs() {
  const { project, busy } = useStudio();
  const [options, setOptions] = useState<CreationLogOptions>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    projectId: string;
    key: string;
    data: CreationLogView;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(options);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!project) return;
      try {
        const data = await bridge.logs(project.projectId, JSON.parse(key));
        if (alive) {
          setSnapshot({ projectId: project.projectId, key, data });
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
    setLoading(true);
    timer = setTimeout(refresh, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project?.projectId, project?.revision, busy, key, refreshKey]);
  return {
    data:
      snapshot?.projectId === project?.projectId && snapshot?.key === key
        ? snapshot.data
        : null,
    options,
    error,
    loading,
    refresh: () => setRefreshKey((n) => n + 1),
    change: (next: CreationLogOptions) =>
      setOptions((old) => ({ ...old, limit: 200, ...next })),
  };
}
