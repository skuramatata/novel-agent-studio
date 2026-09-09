import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./memory.mjs";
import { countWords } from "./writing.mjs";

export const logCategories = {
  task: "任务",
  planning: "规划",
  writing: "正文生成",
  review: "审稿与修订",
  memory: "故事记忆",
  adoption: "候选与采纳",
};
export function stageCategory(label = "") {
  if (/记忆|索引/.test(label)) return "memory";
  if (/审稿|复核|补丁|裁定|裁决|证据|作者回答/.test(label)) return "review";
  if (/起草|续写|修订第|场景.*\//.test(label)) return "writing";
  if (/规划|章纲|意图|计划|大纲/.test(label)) return "planning";
  return "task";
}
function clean(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
    .replace(
      /((?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[已隐藏]",
    );
}
/** 仅记录明确的过程摘要，不复制请求头、配置、完整提示词或模型思考内容。 */
export function appendCreationEvent(
  state,
  { category = "task", status = "info", title, details = {} },
  at = new Date().toISOString(),
) {
  state.creationLog ??= { version: 1, events: [] };
  const events = state.creationLog.events;
  events.push({
    id: `log-${events.length + 1}`,
    at,
    category,
    status,
    title: clean(title),
    details: Object.fromEntries(
      Object.entries(details)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === "number" ? v : clean(v)]),
    ),
  });
}
const statuses = {
  running: ["running", "任务开始或恢复"],
  awaiting_input: ["waiting", "等待作者回答"],
  retryable: ["failed", "任务暂停，可从失败步骤恢复"],
  failed: ["failed", "任务执行失败，进度已保存"],
  interrupted: ["waiting", "任务已中断，进度已保存"],
  ready: ["success", "候选已生成，等待保存"],
  completed: ["success", "本次任务完成"],
};
/** 与检查点同次写入；相同状态重复保存不会产生重复事件。 */
export function captureCheckpointLog(state) {
  const previous = state.creationLog?.snapshot;
  const migrating =
    !state.creationLog && Object.keys(state.values || {}).length > 0;
  if (migrating)
    state.creationLog = {
      version: 1,
      legacy: true,
      events: [
        {
          id: "legacy-baseline",
          at: null,
          category: "task",
          status: "info",
          title: "从旧版检查点接入日志",
          details: {
            最后步骤: state.stage || "未知",
            原有调用次数: state.calls || 0,
          },
        },
      ],
    };
  if (!previous && !state.creationLog)
    appendCreationEvent(state, {
      title: "开始记录创作过程",
      details: {
        请求: state.request?.instruction || "",
        模型: state.model || "",
      },
    });
  if (previous?.status !== state.status) {
    const [status, title] = statuses[state.status] || ["info", state.status];
    appendCreationEvent(
      state,
      {
        status,
        title,
        details: { 当前步骤: state.stage, 原因: state.error || undefined },
      },
      migrating ? null : undefined,
    );
  }
  const sceneHashes = {};
  for (const [key, text] of Object.entries(state.values || {})) {
    if (!/^final-scene:\d+$/.test(key)) continue;
    sceneHashes[key] = digest(text);
    if (previous?.sceneHashes?.[key] !== sceneHashes[key])
      appendCreationEvent(
        state,
        {
          category: "writing",
          status: "success",
          title: `场景 ${Number(key.split(":")[1]) + 1} ${previous?.sceneHashes?.[key] ? "修订已保存" : "正文已保存"}`,
          details: {
            字数: countWords(text),
            内容指纹: sceneHashes[key].slice(0, 12),
          },
        },
        migrating ? null : undefined,
      );
  }
  const nodes = {};
  for (const [graphId, graph] of Object.entries(state.graphs || {}))
    for (const [id, node] of Object.entries(graph.nodes || {})) {
      const key = `${graphId}:${id}`;
      nodes[key] = node.status;
      if (previous?.nodes?.[key] !== node.status)
        appendCreationEvent(
          state,
          {
            category: "planning",
            status:
              node.status === "completed"
                ? "success"
                : node.status === "failed"
                  ? "failed"
                  : "running",
            title: `规划节点${node.status === "completed" ? "完成" : node.status === "failed" ? "失败" : "开始"}`,
            details: { 节点: id, 原因: node.error },
          },
          migrating ? node.completedAt || node.startedAt || null : undefined,
        );
    }
  const turns = state.reviewConversation || [];
  for (const turn of turns.slice(previous?.turns || 0))
    appendCreationEvent(
      state,
      {
        category: "review",
        status: turn.role === "user" ? "success" : "info",
        title: turn.role === "user" ? "作者提交处理意见" : "审稿对话",
        details: { 内容: turn.text },
      },
      migrating ? null : undefined,
    );
  state.creationLog.snapshot = {
    status: state.status,
    sceneHashes,
    nodes,
    turns: turns.length,
  };
}
const reviewLabels = {
  phase: "审稿阶段变更",
  issue_found: "登记审稿问题",
  issue_reopened: "有新证据，重新检查问题",
  issue_grounded: "已核对问题依据与实际位置",
  issue_verified: "问题修订通过复核",
  issue_decided: "问题已由作者裁定",
  issue_awaiting_author: "问题等待作者回答",
  issue_repairing: "开始修订问题",
  issue_verifying: "开始复核问题",
  author_decided: "保存作者裁定",
  retry_required: "审稿步骤等待重试",
  resumed: "恢复审稿步骤",
  completed: "审稿完成",
};
const phaseLabels = {
  review: "核对审稿发现",
  arbitration: "裁定情节依据",
  grounding: "核对修订依据与实际段落",
  awaiting_author: "等待作者回答",
  patch: "修订问题段落",
  verify: "复核修订结果",
  completed: "审稿完成",
};
export function taskEvents(state, project) {
  const events = [...(state.creationLog?.events || [])];
  for (const [i, commit] of (state.paragraphReview?.commits || []).entries())
    events.push({
      id: `patch-${i}`,
      at: commit.committedAt || null,
      category: "review",
      status: "success",
      title: `修订 ${i + 1} 已通过复核并保存`,
      details: {
        修改段落: commit.changes?.length || 0,
        问题: commit.findings.map((f) => f.explanation).join("；"),
        修订对照: (commit.changes || [])
          .map(
            (c) =>
              `${c.sourceId.replace("scene:", "场景")} 第${c.paragraph}段\n修改前：${c.before}\n修改后：${c.replacement}`,
          )
          .join("\n\n"),
      },
    });
  for (const e of state.reviewWorkflow?.events || []) {
    const history = state.reviewWorkflow.issues
      ?.find((i) => i.id === e.issueId)
      ?.history?.find((h) => h.documentVersion === e.documentVersion);
    const decision = state.reviewWorkflow.constraints?.find(
      (c) => c.id === e.constraintId,
    );
    events.push({
      id: `review-${e.sequence}`,
      at: e.at,
      category: "review",
      status:
        e.type === "retry_required"
          ? "failed"
          : e.type === "completed" || e.type === "issue_verified"
            ? "success"
            : "info",
      title: reviewLabels[e.type] || "审稿问题状态更新",
      details: {
        ...(e.phase ? { 阶段: phaseLabels[e.phase] || e.phase } : {}),
        ...(e.issueId ? { 问题: e.issueId } : {}),
        ...(e.reason ? { 说明: clean(e.reason) } : {}),
        ...(history ? { 具体问题: clean(history.explanation) } : {}),
        ...(decision ? { 作者裁定: clean(decision.instruction) } : {}),
      },
    });
  }
  if (!state.creationLog) {
    events.push({
      id: "legacy-state",
      at: null,
      category: "task",
      status: "info",
      title: "旧版任务检查点",
      details: {
        最后状态: state.status,
        最后步骤: state.stage || "未知",
        调用次数: state.calls || 0,
        原因: clean(state.error || ""),
      },
    });
    for (const [key, value] of Object.entries(state.values || {}))
      if (/^final-scene:\d+$/.test(key))
        events.push({
          id: `legacy-${key}`,
          at: null,
          category: "writing",
          status: "success",
          title: `场景 ${Number(key.split(":")[1]) + 1} 已有存稿`,
          details: { 字数: countWords(value) },
        });
    for (const [i, turn] of (state.reviewConversation || []).entries())
      events.push({
        id: `legacy-turn-${i}`,
        at: null,
        category: "review",
        status: "info",
        title: turn.role === "user" ? "历史作者回答" : "历史审稿对话",
        details: { 内容: clean(turn.text) },
      });
  }
  for (const m of project.messages.filter(
    (m) => m.proposal && (m.taskId === state.id || m.id === state.candidateId),
  )) {
    const changes = Object.keys(m.proposal).some((key) => key !== "summary");
    events.push({
      id: `candidate-${m.id}`,
      at: m.createdAt || null,
      category: changes ? "adoption" : "task",
      status: "success",
      title: changes ? "候选已保存到对话" : "讨论回复已保存",
      details: { 结果: m.text },
    });
    if (changes && ["accepted", "rejected"].includes(m.status))
      events.push({
        id: `handled-${m.id}`,
        at: m.handledAt || null,
        category: "adoption",
        status: "success",
        title: m.status === "accepted" ? "候选已采纳到作品" : "候选已放弃",
        details: { 候选: m.id },
      });
  }
  return events.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
}
const readJson = async (file) => {
  const state = JSON.parse(await readFile(file, "utf8"));
  if (
    !state ||
    typeof state.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(state.id)
  )
    throw Error("任务文件缺少有效编号");
  return state;
};
const historySummaries = new Map();
function summary(state, project, isRunning = false) {
  const ch = project.chapters.find((c) => c.id === state.chapterId);
  return {
    id: state.id,
    chapter: ch ? `第${ch.number}章 · ${ch.title}` : "规划或综合任务",
    instruction: state.request?.instruction || "",
    status:
      state.status === "running" && !isRunning ? "interrupted" : state.status,
    stage: state.stage || "",
    model: state.model || "未知",
    calls: state.calls || 0,
    updatedAt: state.updatedAt || null,
    legacy: !state.creationLog || !!state.creationLog.legacy,
  };
}
/** 历史任务分批读取，选中的任务单独加载；参数不直接作为任意文件路径。 */
export async function readCreationLogs(
  directory,
  project,
  options = {},
  isRunning = false,
) {
  const { taskId, category = "", query = "", onlyProblems = false } = options;
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.max(100, Math.floor(Number(options.limit) || 200));
  if (taskId && !/^[a-zA-Z0-9-]{1,100}$/.test(taskId))
    throw Error("无效任务编号");
  if (typeof query !== "string" || query.length > 200)
    throw Error("搜索词最多200字");
  const warnings = [];
  let current;
  try {
    current = await readJson(join(directory, "chapter-task.json"));
  } catch (e) {
    if (e.code !== "ENOENT") warnings.push("当前任务文件无法读取");
  }
  let files = [];
  try {
    files = (await readdir(join(directory, "task-history"))).filter(
      (f) => /^[a-zA-Z0-9-]+\.json$/.test(f) && !f.includes("-before-"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") warnings.push("历史任务目录无法读取");
  }
  const dated = await Promise.all(
    files
      .filter((f) => f !== `${current?.id}.json`)
      .map(async (file) => {
        try {
          return {
            file,
            at: (await stat(join(directory, "task-history", file))).mtimeMs,
          };
        } catch {
          return { file, at: 0 };
        }
      }),
  );
  dated.sort((a, b) => b.at - a.at);
  const loaded = [];
  for (const { file, at } of dated.slice(offset, offset + 30)) {
    try {
      const path = join(directory, "task-history", file);
      let cached = historySummaries.get(path);
      if (!cached || cached.at !== at) {
        const state = await readJson(path);
        const {
          id,
          chapterId,
          request,
          status,
          stage,
          model,
          calls,
          updatedAt,
        } = state;
        cached = {
          at,
          value: {
            id,
            chapterId,
            request,
            status,
            stage,
            model,
            calls,
            updatedAt,
            creationLog: state.creationLog
              ? { legacy: state.creationLog.legacy }
              : undefined,
          },
        };
        historySummaries.set(path, cached);
        if (historySummaries.size > 200)
          historySummaries.delete(historySummaries.keys().next().value);
      }
      loaded.push(cached.value);
    } catch {
      warnings.push("一份历史任务文件无法读取");
    }
  }
  const states = [...(current ? [current] : []), ...loaded];
  let selected = taskId ? states.find((s) => s.id === taskId) : states[0];
  if (selected && selected !== current)
    selected = await readJson(
      join(directory, "task-history", `${selected.id}.json`),
    );
  if (taskId && !selected) {
    try {
      selected = await readJson(
        join(directory, "task-history", `${taskId}.json`),
      );
      if (selected.id !== taskId) throw Error();
    } catch {
      throw Error("所选任务不存在或无法读取");
    }
  }
  const all = selected ? taskEvents(selected, project) : [];
  const matched = all.filter(
    (e) =>
      (!category || e.category === category) &&
      (!onlyProblems || ["failed", "waiting"].includes(e.status)) &&
      (!query ||
        JSON.stringify(e)
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  return {
    tasks: states.map((s) =>
      summary(s, project, isRunning && s.id === current?.id),
    ),
    selected: selected
      ? summary(selected, project, isRunning && selected.id === current?.id)
      : null,
    events: matched.slice(-limit),
    total: all.length,
    matched: matched.length,
    hasMoreEvents: matched.length > limit,
    offset,
    hasOlderTasks: offset + 30 < dated.length,
    warnings,
  };
}
