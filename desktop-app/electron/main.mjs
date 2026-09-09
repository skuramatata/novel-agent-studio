import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  Menu,
} from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { ProjectLibrary } from "../runtime/library.mjs";
import {
  StoryVectorIndex,
  localEmbedder,
} from "../runtime/story-retrieval.mjs";
import {
  modelCapabilities,
  capabilityKey,
  validateLimits,
} from "../runtime/model-capabilities.mjs";
import { projectExport } from "../runtime/export.mjs";
import {
  readAuthorizedEnv,
  authorizedEnvPath,
  providerDefaults,
  validateProvider,
  complete,
} from "../runtime/providers.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { Checkpoint, baseFingerprint } from "../runtime/checkpoint.mjs";
import { isReviewDecisionReplay } from "../runtime/review-resolution.mjs";
import {
  readCreationLogs,
  appendCreationEvent,
} from "../runtime/creation-log.mjs";
import {
  reviewTaskState,
  addRecoveryMessage,
} from "../runtime/review-workflow.mjs";
import { memoryView } from "../runtime/memory.mjs";
import { runAgent, RUN_TIMEOUT_MS } from "../runtime/agent.mjs";
import { applyProposal, projectSchema } from "../runtime/schema.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildInfo = JSON.parse(
  await readFile(join(root, "build-info.json"), "utf8"),
);
app.setName("小说工作室");
app.setAboutPanelOptions({
  applicationName: "小说工作室",
  applicationVersion: buildInfo.displayVersion,
  version: buildInfo.builtAtLabel,
});
app.setPath(
  "userData",
  process.env.NOVEL_AGENT_DATA_DIR ||
    join(app.getPath("appData"), "novel-agent-studio"),
);
const dataDir = process.env.NOVEL_AGENT_DATA_DIR || app.getPath("userData");
const sourceEnv = authorizedEnvPath({ packaged: app.isPackaged, dataDir });
const store = new ProjectLibrary(dataDir);
const embed = localEmbedder(
  app.isPackaged ? join(process.resourcesPath, "models") : join(root, "models"),
);
let win;
let active = null;
let configs;
let writeQueue = Promise.resolve();
const serial = (fn) => {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
};
const configFile = join(dataDir, "providers.json");
let configLoading;
async function writeConfigs(all) {
  const saved = Object.fromEntries(
    Object.entries(all).map(([k, v]) => [
      k,
      {
        provider: k,
        model: v.model,
        baseUrl: v.baseUrl,
        limits: v.limits,
        limitKey: v.limitKey,
        ...(v.encryptedKey ? { encryptedKey: v.encryptedKey } : {}),
      },
    ]),
  );
  await mkdir(dataDir, { recursive: true });
  await writeFile(configFile + ".tmp", JSON.stringify(saved), { mode: 0o600 });
  await rename(configFile + ".tmp", configFile);
}
async function loadConfig() {
  if (configs) return configs;
  if (configLoading) return configLoading;
  configLoading = (async () => {
    const next = structuredClone(providerDefaults);
    try {
      const saved = JSON.parse(await readFile(configFile, "utf8"));
      for (const key of ["glm", "minimax"])
        if (saved[key]) {
          const s = saved[key];
          next[key] = {
            ...next[key],
            ...s,
            apiKey: s.encryptedKey
              ? safeStorage.decryptString(Buffer.from(s.encryptedKey, "base64"))
              : "",
          };
        }
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error("无法读取模型配置或解密密钥。请检查系统钥匙串。");
    }
    if (["glm", "minimax"].some((k) => !next[k].apiKey)) {
      let timer;
      const imported = await Promise.race([
        readAuthorizedEnv(sourceEnv),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({}), 3000);
        }),
      ]).finally(() => clearTimeout(timer));
      let changed = false;
      for (const key of ["glm", "minimax"])
        if (!next[key].apiKey && imported[key]?.apiKey) {
          next[key] = { ...next[key], ...imported[key] };
          if (safeStorage.isEncryptionAvailable()) {
            next[key].encryptedKey = safeStorage
              .encryptString(next[key].apiKey)
              .toString("base64");
            changed = true;
          }
        }
      if (changed) await writeConfigs(next);
    }
    configs = next;
    return next;
  })();
  try {
    return await configLoading;
  } finally {
    configLoading = undefined;
  }
}
function publicConfigs(c) {
  return Object.fromEntries(
    Object.entries(c).map(([k, v]) => [
      k,
      {
        provider: k,
        model: v.model,
        baseUrl: v.baseUrl,
        hasKey: Boolean(v.apiKey),
        limits: v.limits,
        limitKey: v.limitKey,
        capabilities: modelCapabilities(v),
      },
    ]),
  );
}
function handle(name, fn) {
  ipcMain.handle("studio:" + name, async (event, ...args) => {
    if (
      event.sender !== win?.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw new Error("无效的桌面调用来源");
    try {
      return await fn(...args);
    } catch (e) {
      if (e.name === "ZodError")
        throw new Error("数据格式不完整，请检查必填项、数字范围和人物关系。");
      throw e;
    }
  });
}
handle("load", (id) => serial(() => store.load(id)));
handle("memory", (id) => serial(async () => memoryView(await store.load(id))));
handle("logs", (id, options) =>
  serial(async () =>
    readCreationLogs(
      store.directoryFor(id),
      await store.load(id),
      options,
      !!active,
    ),
  ),
);
handle("task", (id) =>
  serial(async () => {
    const p = await store.load(id);
    const state = await new Checkpoint(store.directoryFor(id)).read();
    if (!state) return null;
    const taskView = reviewTaskState(state, !!active);
    const status =
      state.status !== "completed" && state.base !== baseFingerprint(p)
        ? "stale"
        : taskView.status;
    return {
      id: state.id,
      status,
      stage: state.stage,
      error: state.error || "",
      chapterId: state.chapterId,
      review: status === "stale" ? null : taskView.review,
      reviewProgress: taskView.reviewProgress,
      updatedAt: state.updatedAt,
      manifest: state.manifest,
      draft: Object.entries(state.values)
        .filter(([k]) => /^final-scene:\d+$/.test(k))
        .sort(([a], [b]) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
        .map(([, text]) => text)
        .join("\n\n"),
      fragments: Object.entries(state.fragments)
        .filter(([k]) => k.startsWith("scene:"))
        .map(([key, text]) => ({ key, text })),
      resumable: status !== "stale" && taskView.resumable,
    };
  }),
);
handle("list", () => serial(() => store.list()));
const manage = (fn) =>
  serial(() => {
    if (active) throw new Error("请等待生成结束或停止任务后管理作品。");
    return fn();
  });
handle("select", (id) => manage(() => store.select(id)));
handle("create", (title) => manage(() => store.create(title)));
handle("rename", (id, title) => manage(() => store.rename(id, title)));
handle("archive", (id, archived) => manage(() => store.archive(id, archived)));
handle("save", (p, r) =>
  serial(async () => {
    if (typeof p?.projectId !== "string") throw Error("缺少作品标识");
    projectSchema.parse(p);
    const old = await store.load(p.projectId);
    for (const ch of old.chapters)
      if (
        ch.content &&
        !p.chapters.some((c) => c.id === ch.id && c.content === ch.content)
      )
        throw new Error("已有正文暂不支持修改。");
    for (const ch of p.chapters)
      if (
        ch.content &&
        !old.chapters.some((c) => c.id === ch.id && c.content === ch.content)
      )
        throw new Error("正文需要通过候选采纳。");
    const messages = p.messages.map((m) => {
      const prior = old.messages.find((x) => x.id === m.id);
      return prior
        ? {
            ...m,
            taskId: prior.taskId,
            createdAt: prior.createdAt,
            handledAt:
              prior.status === "pending" && m.status === "rejected"
                ? new Date().toISOString()
                : prior.handledAt,
          }
        : m;
    });
    return store.save({ ...p, messages, memory: old.memory }, r);
  }),
);
handle("accept", (projectId, id) =>
  serial(async () => {
    if (typeof projectId !== "string") throw Error("缺少作品标识");
    const p = await store.load(projectId);
    const m = p.messages.find((m) => m.id === id);
    if (!m?.proposal || m.status !== "pending")
      throw new Error("候选不存在或已经处理。");
    const next = applyProposal(p, m.proposal, m.baseRevision);
    next.messages = next.messages.map((x) =>
      x.id === id
        ? { ...x, status: "accepted", handledAt: new Date().toISOString() }
        : x,
    );
    return store.save({ ...next, projectId }, p.revision);
  }),
);
handle("settings", async () => publicConfigs(await loadConfig()));
handle("save-settings", async (c) => {
  validateProvider(c);
  const all = await loadConfig();
  let encryptedKey = all[c.provider].encryptedKey;
  if (c.apiKey) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统安全存储不可用，密钥未保存。");
    encryptedKey = safeStorage.encryptString(c.apiKey).toString("base64");
  }
  const next = {
    ...all,
    [c.provider]: {
      ...all[c.provider],
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey || all[c.provider].apiKey,
      encryptedKey,
      limits: validateLimits(c.limits || {}),
      limitKey: capabilityKey(c),
    },
  };
  await writeConfigs(next);
  configs = next;
  return publicConfigs(next);
});
handle("test", async (provider) => {
  if (!["glm", "minimax"].includes(provider)) throw new Error("无效供应商");
  const c = (await loadConfig())[provider];
  const r = await complete(
    c,
    [{ role: "user", content: "仅回复：连接成功" }],
    AbortSignal.timeout(60000),
    fetch,
    1024,
  );
  return { model: r.model, text: "模型接口连接成功", usage: r.usage };
});
handle("generate", async (req) => {
  if (active) throw new Error("已有任务运行中，请等待或停止。");
  const controller = new AbortController();
  active = controller;
  try {
    return await executeGenerate(req, controller);
  } finally {
    active = null;
  }
});
async function executeGenerate(req, controller) {
  if (
    !["glm", "minimax"].includes(req.provider) ||
    typeof req.instruction !== "string"
  )
    throw new Error("无效生成请求");
  if (typeof req.projectId !== "string") throw Error("缺少作品标识");
  if (
    req.instruction.length > 12000 ||
    (req.words !== undefined &&
      (!Number.isInteger(req.words) || req.words < 100 || req.words > 10000))
  )
    throw Error("请输入有效创作要求和100—10000的整数字数。");
  if (req.decision && !req.resume) throw Error("作者选择只能用于恢复原任务。");
  if (req.mode !== undefined && req.mode !== "memory")
    throw Error("无效任务类型。");
  let p = await serial(() => store.load(req.projectId));
  if (req.decision) {
    const previous = await new Checkpoint(
      store.directoryFor(req.projectId),
    ).read();
    // 收讫答复允许携带第一次发送时的 revision；它只返回当前作品，不再执行写作。
    if (
      previous?.base === baseFingerprint(p) &&
      previous.provider === req.provider &&
      isReviewDecisionReplay(previous, req.decision)
    )
      return p;
  }
  if (req.revision !== p.revision) throw new Error("作品版本已变化，请重试。");
  if (p.messages.some((m) => m.status === "pending"))
    throw new Error("请先采纳或放弃上一份方案。");
  const runDir = store.directoryFor(req.projectId);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(RUN_TIMEOUT_MS),
  ]);
  const started = Date.now();
  const runId = crypto.randomUUID();
  const record = async (details) => {
    try {
      await mkdir(join(runDir, "runs"), { recursive: true });
      await writeFile(
        join(runDir, "runs", runId + ".json"),
        JSON.stringify(
          {
            runId,
            projectId: req.projectId,
            at: new Date().toISOString(),
            durationMs: Date.now() - started,
            provider: req.provider,
            baseRevision: p.revision,
            ...details,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch {}
  };
  const send = (text) => {
    if (!win?.isDestroyed()) win.webContents.send("studio:progress", text);
  };
  const checkpoint = new Checkpoint(runDir);
  let checkpointState;
  const syncReviewMessages = () =>
    serial(async () => {
      const latest = await store.load(req.projectId);
      if (
        latest.revision !== p.revision ||
        baseFingerprint(latest) !== checkpointState.base
      )
        throw Error("作品已变化，不能将旧任务问答写入当前作品。");
      const turns = (checkpointState.reviewConversation || []).filter(
        (m) => !latest.messages.some((x) => x.id === m.id),
      );
      if (!turns.length) return latest;
      return store.save(
        { ...latest, messages: [...latest.messages, ...turns] },
        latest.revision,
      );
    });
  try {
    const config = (await loadConfig())[req.provider];
    checkpointState = await checkpoint.begin(p, req, config);
    p = await syncReviewMessages();
    if (
      checkpointState.decisionReplay ||
      checkpointState.status === "awaiting_input"
    )
      return p;
    const retrieval = new StoryVectorIndex(runDir, embed);
    let generated;
    try {
      generated = await runChapterAgent(
        p,
        config,
        signal,
        send,
        checkpoint,
        checkpointState,
        fetch,
        { retrieval },
      );
    } finally {
      retrieval.close();
    }
    const legacyBaseCalls = checkpointState.calls;
    const result = generated.legacy
      ? await runAgent(
          p,
          req.instruction,
          (await loadConfig())[req.provider],
          signal,
          send,
          fetch,
          {
            onLog: async (event) => {
              checkpointState.stage = event.title;
              if (typeof event.details?.调用次数 === "number")
                checkpointState.calls =
                  legacyBaseCalls + event.details.调用次数;
              appendCreationEvent(checkpointState, event);
              await checkpoint.write(checkpointState);
            },
            onArtifact: async (artifact) => {
              appendCreationEvent(checkpointState, {
                status: "success",
                title: `规划与讨论结果已保存：${artifact.stage}`,
                details: { 调用次数: artifact.calls },
              });
              await checkpoint.write(checkpointState);
              const directory = join(runDir, "runs", runId);
              await mkdir(directory, { recursive: true });
              await writeFile(
                join(directory, `${artifact.sequence}.json`),
                JSON.stringify(artifact, null, 2),
                { mode: 0o600 },
              );
            },
          },
        )
      : generated;
    if (generated.legacy) {
      checkpointState.calls = legacyBaseCalls + result.calls;
      checkpointState.usages.push(...result.usages);
    }
    signal.throwIfAborted();
    p = await syncReviewMessages();
    return await serial(async () => {
      signal.throwIfAborted();
      const latest = await store.load(req.projectId);
      if (latest.revision !== p.revision)
        throw new Error(
          "生成期间作品发生变化，结果未写入。请基于最新设定重新生成。",
        );
      if (result.memoryOnly) {
        const saved = await store.save(
          { ...latest, memory: result.memoryOnly },
          latest.revision,
        );
        checkpointState.status = "completed";
        appendCreationEvent(checkpointState, {
          category: "memory",
          status: "success",
          title: "已采纳正文的记忆索引已保存",
          details: { 索引片段: result.memoryOnly.entries.length },
        });
        await checkpoint.write(checkpointState);
        await record({
          status: "completed",
          calls: result.calls,
          usages: result.usages,
          promptVersion: result.promptVersion,
        });
        return saved;
      }
      const assistant = {
        id: crypto.randomUUID(),
        taskId: checkpointState.id,
        createdAt: new Date().toISOString(),
        role: "assistant",
        text: result.proposal.summary,
        proposal: result.proposal,
        baseRevision: p.revision + 1,
        status: Object.keys(result.proposal).some((k) => k !== "summary")
          ? "pending"
          : "accepted",
        model: result.model,
      };
      const next = {
        ...latest,
        messages: [
          ...latest.messages,
          ...(req.decision
            ? []
            : [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  text: req.instruction,
                },
              ]),
          assistant,
        ],
      };
      const saved = await store.save(next, latest.revision);
      checkpointState.candidateId = assistant.id;
      checkpointState.status = "completed";
      await checkpoint.write(checkpointState);
      await record({
        status: "completed",
        model: result.model,
        calls: result.calls,
        usages: result.usages,
        promptVersion: result.promptVersion,
        candidateId: assistant.id,
      });
      await writeFile(
        join(runDir, "last-run.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            durationMs: Date.now() - started,
            status: "completed",
            model: result.model,
            calls: result.calls,
            usages: result.usages,
            promptVersion: result.promptVersion,
          },
          null,
          2,
        ),
      ).catch(() => {});
      return saved;
    });
  } catch (e) {
    if (e.name === "ReviewRetryableError" && !signal.aborted) {
      checkpointState.status = "retryable";
      addRecoveryMessage(checkpointState);
      await checkpoint.write(checkpointState);
      await record({
        status: "retryable",
        stage: checkpointState.reviewWorkflow.phase,
        error: e.message,
        calls: checkpointState.calls,
      });
      return await syncReviewMessages();
    }
    if (e.name === "WaitingForAuthor" && !signal.aborted) {
      await record({ status: "awaiting_input", calls: checkpointState.calls });
      return await syncReviewMessages();
    }
    if (checkpointState && checkpointState.status !== "completed") {
      checkpointState.status = signal.aborted ? "interrupted" : "failed";
      checkpointState.error = e.message;
      await checkpoint.write(checkpointState);
    }
    await record({
      status: signal.aborted
        ? controller.signal.aborted
          ? "cancelled"
          : "timeout"
        : "failed",
      error: signal.aborted ? "任务中断" : e.message,
      calls: e.details?.calls ?? null,
      usages: e.details?.usages ?? null,
      diagnostics: e.details ?? null,
    });
    if (signal.aborted)
      throw new Error(
        controller.signal.aborted
          ? "任务已停止，作品未改变。"
          : "任务超时，作品未改变。",
      );
    throw e;
  }
}
handle("cancel", () => {
  active?.abort();
});
handle("export", async (projectId, format = "json") => {
  if (typeof projectId !== "string") throw Error("缺少作品标识");
  const p = await serial(() => store.load(projectId));
  const output = projectExport(p, format);
  const { filePath } = await dialog.showSaveDialog(win, {
    defaultPath: output.filename,
    filters: [
      {
        name: format === "md" ? "作品正文 Markdown" : "作品 JSON",
        extensions: [format],
      },
    ],
  });
  if (!filePath) return false;
  await writeFile(filePath, output.content, { mode: 0o600 });
  return true;
});
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
function createWindow() {
  if (!primaryInstance) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "小说工作室",
        submenu: [
          { label: "关于小说工作室", role: "about" },
          { type: "separator" },
          { label: "隐藏小说工作室", role: "hide" },
          { label: "退出", role: "quit" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { label: "撤销", role: "undo" },
          { label: "重做", role: "redo" },
          { type: "separator" },
          { label: "剪切", role: "cut" },
          { label: "复制", role: "copy" },
          { label: "粘贴", role: "paste" },
          { label: "全选", role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { label: "重新载入", role: "reload" },
          { label: "切换全屏", role: "togglefullscreen" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { label: "最小化", role: "minimize" },
          { label: "关闭窗口", role: "close" },
        ],
      },
    ]),
  );
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 740,
    title: `小说工作室 · ${buildInfo.displayVersion}`,
    backgroundColor: "#101719",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(root, "electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadURL(pathToFileURL(join(root, "dist/index.html")).href);
  win.on("closed", () => {
    active?.abort();
  });
}
app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
