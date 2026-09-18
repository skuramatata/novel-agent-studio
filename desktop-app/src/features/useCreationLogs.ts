import { useEffect, useState } from "react";
import { useStudio } from "../state/StudioContext";
import { bridge } from "../lib/bridge";
import type {
  CreationLogOptions,
  CreationLogView,
  ExecutionNodeDetail,
} from "../lib/types";
export function useCreationLogs() {
  const { project, busy } = useStudio();
  const [selection, setSelection] = useState<{
    projectId?: string;
    options: CreationLogOptions;
  }>({ options: {} });
  const options =
    selection.projectId === project?.projectId ? selection.options : {};
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
    setError("");
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
      setSelection((old) => ({
        projectId: project?.projectId,
        options: {
          ...(old.projectId === project?.projectId ? old.options : {}),
          limit: 200,
          ...next,
        },
      })),
  };
}

export function useCreationLogNode(
  taskId: string,
  nodeId: string,
  updatedAt: string | null,
) {
  const { project } = useStudio();
  const key = JSON.stringify([project?.projectId, taskId, nodeId]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data?: ExecutionNodeDetail;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!project || !nodeId) return;
    void bridge.logNode(project.projectId, taskId, nodeId).then(
      (data) => {
        if (alive) setSnapshot({ key, data });
      },
      (error) => {
        if (alive) setSnapshot({ key, error: error.message });
      },
    );
    return () => {
      alive = false;
    };
  }, [key, updatedAt]);
  return snapshot?.key === key ? snapshot : null;
}
