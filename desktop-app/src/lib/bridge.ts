import {
  blankProject,
  demoProposal,
  demoChapter,
} from "../../runtime/seed.mjs";
import { applyProposal, projectSchema } from "../../runtime/schema.mjs";
import { projectExport } from "../../runtime/export.mjs";
import { providerDefaults } from "../../runtime/catalog.mjs";
import type { Bridge, Project, Settings } from "./types";
// 浏览器只用于交互预览：不导入任何密钥，不发起真实模型请求。
const key = "novel-studio-preview-library-1";
let cancelled = false;
let generating = false;
type Library = {
  activeId: string;
  entries: { id: string; archived: boolean; project: Project }[];
};
function library(): Library {
  const raw = localStorage.getItem(key);
  if (raw) return JSON.parse(raw) as Library;
  const old = localStorage.getItem("novel-studio-preview-1");
  const id = crypto.randomUUID();
  const project = {
    ...projectSchema.parse(old ? JSON.parse(old) : blankProject()),
    projectId: id,
  } as Project;
  const lib = { activeId: id, entries: [{ id, archived: false, project }] };
  saveLibrary(lib);
  return lib;
}
function saveLibrary(lib: Library) {
  localStorage.setItem(key, JSON.stringify(lib));
}
function load(id?: string): Project {
  const lib = library();
  const entry = lib.entries.find((e) => e.id === (id ?? lib.activeId));
  if (!entry) throw Error("作品不存在");
  return {
    ...projectSchema.parse(entry.project),
    projectId: entry.id,
  } as Project;
}
function persist(p: Project) {
  const lib = library();
  const entry = lib.entries.find((e) => e.id === p.projectId && !e.archived);
  if (!entry) throw Error("作品不存在或已归档");
  entry.project = {
    ...projectSchema.parse(p),
    projectId: p.projectId,
  } as Project;
  saveLibrary(lib);
  return entry.project;
}
function titleValue(title: string) {
  if (!title.trim() || title.trim().length > 200)
    throw Error("作品名称需为 1–200 个字符");
  return title.trim();
}
function canManage() {
  if (generating) throw Error("请等待生成结束或停止任务后管理作品。");
}
const preview: Bridge = {
  logs: async () => ({
    tasks: [],
    selected: null,
    events: [],
    total: 0,
    matched: 0,
    hasMoreEvents: false,
    offset: 0,
    hasOlderTasks: false,
    warnings: ["浏览器预览不执行真实创作任务，创作日志请在桌面端查看。"],
  }),
  memory: async (id) => {
    const p = load(id);
    return {
      version: 1,
      entries: (p.memory?.entries || []).map((e) => ({ ...e, current: false })),
      chapters: p.chapters.map((c) => ({
        id: c.id,
        number: c.number,
        title: c.title,
        hasContent: !!c.content,
        indexed: false,
      })),
    };
  },
  task: async () => null,
  load: async (id) => load(id),
  list: async () =>
    library().entries.map((e) => ({
      id: e.id,
      archived: e.archived,
      title: e.project.premise.title,
      genre: e.project.premise.genre,
      chapters: e.project.chapters.filter((c) => c.content.trim()).length,
      revision: e.project.revision,
    })),
  select: async (id) => {
    canManage();
    const lib = library();
    if (!lib.entries.some((e) => e.id === id && !e.archived))
      throw Error("作品不存在或已归档");
    saveLibrary({ ...lib, activeId: id });
    return load(id);
  },
  create: async (title) => {
    canManage();
    title = titleValue(title);
    const lib = library();
    const id = crypto.randomUUID();
    const p = { ...blankProject(), projectId: id } as Project;
    p.premise.title = title;
    saveLibrary({
      activeId: id,
      entries: [...lib.entries, { id, archived: false, project: p }],
    });
    return p;
  },
  rename: async (id, title) => {
    canManage();
    const p = load(id);
    return persist({
      ...p,
      revision: p.revision + 1,
      premise: { ...p.premise, title: titleValue(title) },
    });
  },
  archive: async (id, archived) => {
    canManage();
    const lib = library();
    const entry = lib.entries.find((e) => e.id === id);
    if (!entry) throw Error("作品不存在");
    entry.archived = archived;
    const available = lib.entries.filter((e) => !e.archived);
    if (!available.length) throw Error("至少保留一部未归档作品");
    if (!available.some((e) => e.id === lib.activeId))
      lib.activeId = available[0].id;
    saveLibrary(lib);
    return load();
  },
  save: async (p, r) => {
    if (load(p.projectId).revision !== r) throw Error("版本冲突");
    return persist({ ...p, revision: r + 1 });
  },
  accept: async (projectId, id) => {
    const p = load(projectId);
    const m = p.messages.find((m) => m.id === id);
    if (!m?.proposal || m.status !== "pending") throw Error("候选已处理");
    const n = {
      ...applyProposal(p, m.proposal, m.baseRevision),
      projectId,
    } as Project;
    n.messages = n.messages.map((x) =>
      x.id === id ? { ...x, status: "accepted" } : x,
    );
    return persist(n);
  },
  settings: async () =>
    Object.fromEntries(
      Object.entries(providerDefaults).map(([k, v]) => [
        k,
        { ...v, hasKey: false },
      ]),
    ) as Settings,
  saveSettings: async () => {
    throw Error("请在桌面端配置真实模型。");
  },
  test: async () => {
    throw Error("浏览器预览不调用模型。");
  },
  generate: async (req) => {
    if (req.mode || req.resume || req.chapterId)
      throw Error("记忆整理与逐章生成请在桌面端运行；浏览器仅展示界面。");
    if (generating) throw Error("已有任务运行中");
    generating = true;
    try {
      cancelled = false;
      await new Promise((r) => setTimeout(r, 900));
      if (cancelled) throw Error("演示已停止");
      const p = load(req.projectId);
      if (p.revision !== req.revision) throw Error("设定已变化");
      if (p.messages.some((m) => m.status === "pending"))
        throw Error("请先处理上一份候选");
      const proposal =
        req.instruction.includes("正文") && p.chapters.length
          ? {
              summary: "固定示例正文，仅用于演示章节阅读。",
              chapters: p.chapters.map((c, i) =>
                i === 0 && !c.content ? { ...c, content: demoChapter } : c,
              ),
            }
          : demoProposal();
      return persist({
        ...p,
        demo: true,
        revision: p.revision + 1,
        messages: [
          ...p.messages,
          { id: crypto.randomUUID(), role: "user", text: req.instruction },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: proposal.summary,
            proposal,
            baseRevision: p.revision + 1,
            status: "pending",
            model: "固定演示 · 非模型生成",
          },
        ],
      });
    } finally {
      generating = false;
    }
  },
  cancel: async () => {
    cancelled = true;
  },
  export: async (id, format) => {
    const output = projectExport(load(id), format);
    const url = URL.createObjectURL(
      new Blob([output.content], { type: output.mime }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = output.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  },
  onProgress: () => () => {},
};
const native = window.studio;
export const bridge: Bridge = native
  ? new Proxy({} as Bridge, {
      get(_target, property) {
        const fn = Reflect.get(native, property);
        if (typeof fn !== "function") return fn;
        return (...args: unknown[]) => {
          const result = fn(...args);
          if (result?.then)
            return result.catch((e: Error) => {
              throw new Error(
                e.message.replace(
                  /^Error invoking remote method '[^']+': (?:Error: )?/,
                  "",
                ),
              );
            });
          return result;
        };
      },
    })
  : preview;
export const isDesktop = Boolean(window.studio);
