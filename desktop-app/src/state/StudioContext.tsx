import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { bridge } from "../lib/bridge";
import type {
  Project,
  ProjectSummary,
  Provider,
  Settings,
  GenerationOptions,
} from "../lib/types";
function useStudioState() {
  const [project, setProject] = useState<Project | null>(null);
  const current = useRef<Project | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<Provider>(
    localStorage.getItem("novel-studio-provider") === "minimax"
      ? "minimax"
      : "glm",
  );
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [switching, setSwitching] = useState(false);
  const changing = useRef(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const queue = useRef(Promise.resolve());
  const put = (p: Project) => {
    current.current = p;
    setProject(p);
  };
  const list = async () => setProjects(await bridge.list());
  const refresh = async () => {
    try {
      put(await bridge.load());
      await list();
      setSettings(await bridge.settings());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    return bridge.onProgress(setProgress);
  }, []);
  useEffect(() => {
    localStorage.setItem("novel-studio-provider", provider);
  }, [provider]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  function enqueue(fn: () => Promise<void>): Promise<boolean> {
    const task = queue.current.then(fn).then(
      () => true,
      (e) => {
        setError((e as Error).message);
        return false;
      },
    );
    queue.current = task.then(() => {});
    return task;
  }
  function update(fn: (p: Project) => Project): Promise<boolean> {
    const id = project?.projectId;
    if (changing.current) return Promise.resolve(false);
    return enqueue(async () => {
      const p = current.current;
      if (!p || p.projectId !== id) throw Error("作品已切换，请重新操作");
      const next = fn(structuredClone(p));
      put(await bridge.save({ ...next, projectId: id! }, p.revision));
      await list();
    });
  }
  async function manage(action: () => Promise<Project>) {
    if (running.current || changing.current) {
      setError("请等待当前操作结束或停止生成后管理作品。");
      return false;
    }
    changing.current = true;
    setSwitching(true);
    try {
      return await enqueue(async () => {
        put(await action());
        setError("");
        setNotice("");
        setProgress("");
        await list();
      });
    } finally {
      changing.current = false;
      setSwitching(false);
    }
  }
  async function generate(
    instruction: string,
    options: GenerationOptions = {},
  ) {
    if (running.current || changing.current) return false;
    const id = project?.projectId;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await queue.current;
      const p = current.current;
      if (!p || p.projectId !== id) throw Error("作品已切换，请重新操作");
      setProgress("准备作者档案与作品上下文");
      const result = await bridge.generate({
        ...options,
        ...((options.resume || options.decision) && !options.authorAction
          ? {
              authorInterventionId:
                options.authorInterventionId || crypto.randomUUID(),
            }
          : {}),
        projectId: id!,
        instruction,
        provider,
        revision: p.revision,
      });
      // 保存/采纳与结果回填共用队列，避免旧版本覆盖刚刚保存的状态。
      return await enqueue(async () => {
        if (current.current?.projectId === id)
          put(await bridge.load(result.projectId));
        await list();
      });
    } catch (e) {
      const message = (e as Error).message;
      // 生成失败前也可能已保存作者答复；先同步版本，再开放恢复入口。
      await enqueue(async () => {
        let syncError = "";
        try {
          if (id && current.current?.projectId === id) {
            const latest = await bridge.load(id);
            if (current.current?.projectId === id) put(latest);
          }
          await list();
        } catch (e) {
          syncError = `\n重新载入作品失败：${(e as Error).message}`;
        }
        setError(message + syncError);
      });
      return false;
    } finally {
      running.current = false;
      setBusy(false);
      setProgress("");
    }
  }
  function accept(id: string) {
    const projectId = project?.projectId;
    if (changing.current) return Promise.resolve(false);
    return enqueue(async () => {
      if (!projectId || current.current?.projectId !== projectId)
        throw Error("作品已切换，请重新操作");
      put(await bridge.accept(projectId, id));
      await list();
      setNotice("已采纳，作品已保存");
    });
  }
  function exportProject(format: "json" | "md") {
    const id = project?.projectId;
    return enqueue(async () => {
      if (id && (await bridge.export(id, format)))
        setNotice(format === "md" ? "作品正文已导出" : "作品备份已导出");
    });
  }
  return {
    project,
    projects,
    settings,
    setSettings,
    provider,
    setProvider,
    busy,
    switching,
    progress,
    error,
    setError,
    notice,
    setNotice,
    update,
    generate,
    accept,
    refresh,
    exportProject,
    selectProject: (id: string) => manage(() => bridge.select(id)),
    createProject: (title: string) => manage(() => bridge.create(title)),
    renameProject: (id: string, title: string) =>
      manage(async () => {
        const p = await bridge.rename(id, title);
        return current.current?.projectId === id ? p : await bridge.load();
      }),
    archiveProject: (id: string, archived: boolean) =>
      manage(() => bridge.archive(id, archived)),
    cancel: () => bridge.cancel(),
  };
}
const StudioContext = createContext<ReturnType<typeof useStudioState> | null>(
  null,
);
export function StudioProvider({ children }: { children: ReactNode }) {
  return (
    <StudioContext.Provider value={useStudioState()}>
      {children}
    </StudioContext.Provider>
  );
}
export function useStudio() {
  const s = useContext(StudioContext);
  if (!s) throw Error("缺少工作室上下文");
  return s;
}
