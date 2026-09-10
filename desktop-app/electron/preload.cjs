const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("studio", {
  load: (id) => ipcRenderer.invoke("studio:load", id),
  memory: (id) => ipcRenderer.invoke("studio:memory", id),
  task: (id) => ipcRenderer.invoke("studio:task", id),
  logs: (id, options) => ipcRenderer.invoke("studio:logs", id, options),
  list: () => ipcRenderer.invoke("studio:list"),
  select: (id) => ipcRenderer.invoke("studio:select", id),
  create: (title) => ipcRenderer.invoke("studio:create", title),
  rewrite: (id, revision, instruction) =>
    ipcRenderer.invoke("studio:rewrite", id, revision, instruction),
  rewriteBackups: (id) => ipcRenderer.invoke("studio:rewrite-backups", id),
  restoreRewrite: (id, backupId, revision) =>
    ipcRenderer.invoke("studio:restore-rewrite", id, backupId, revision),
  rename: (id, title) => ipcRenderer.invoke("studio:rename", id, title),
  archive: (id, archived) => ipcRenderer.invoke("studio:archive", id, archived),
  save: (p, r) => ipcRenderer.invoke("studio:save", p, r),
  accept: (projectId, id) => ipcRenderer.invoke("studio:accept", projectId, id),
  settings: () => ipcRenderer.invoke("studio:settings"),
  saveSettings: (c) => ipcRenderer.invoke("studio:save-settings", c),
  test: (p) => ipcRenderer.invoke("studio:test", p),
  generate: (r) => ipcRenderer.invoke("studio:generate", r),
  cancel: () => ipcRenderer.invoke("studio:cancel"),
  export: (id, format) => ipcRenderer.invoke("studio:export", id, format),
  onProgress: (fn) => {
    const handler = (_, data) => fn(data);
    ipcRenderer.on("studio:progress", handler);
    return () => ipcRenderer.removeListener("studio:progress", handler);
  },
});
