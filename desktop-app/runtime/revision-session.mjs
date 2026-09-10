import { digest } from "./memory.mjs";

export const AUTOMATIC_REVISION_LIMIT = 2;
export const REVISION_POLICY = `作者允许自动改稿。没有明确裁定时，依次按既有事实与因果、人物动机和知情、章节意图与伏笔、最少连带改动，选择更符合文章的版本；不要仅因两种写法都可能成立就反复询问作者。既有作者裁定和已采纳事实优先，不能通过补造取回物品、过去对白等事件来圆错。
一次修订先确定统一方案，列齐全部受影响的段落并一起修改、一起复核；不能只改一边。模型方案只在本轮作为修订依据，不升格为永久作者裁定。复核使用相同事实与方案，不因新的文风偏好推翻前一次取舍；只有具体原文反证才调整方案，并重新检查所有受影响位置。无法遵守作者明确要求或确实缺少必要授权时才请求作者指导。`;

/** 自动恢复只读取额度；只有显式作者操作才能开启新的回合。 */
export function revisionBudget(state) {
  state.revisionBudget ??= {
    epoch: 0,
    limit: AUTOMATIC_REVISION_LIMIT,
    used: Math.min(AUTOMATIC_REVISION_LIMIT, state.paragraphReview?.round || 0),
    attempts: [],
    interventions: [],
  };
  return state.revisionBudget;
}

export function authorIntervenes(state, id, instruction = "作者要求继续") {
  if (typeof id !== "string" || !id.trim() || id.length > 200)
    throw Error("缺少有效的作者操作标识。");
  const budget = revisionBudget(state);
  if (budget.interventions.some((i) => i.id === id)) return false;
  budget.interventions.push({
    id,
    instruction,
    at: new Date().toISOString(),
    previousEpoch: budget.epoch,
    previousUsed: budget.used,
  });
  budget.epoch++;
  budget.used = 0;
  budget.attempts = [];
  if (state.paragraphReview)
    state.paragraphReview.reviewLimit =
      state.paragraphReview.round + budget.limit;
  return true;
}

export function takeRevisionAttempt(state, key) {
  const budget = revisionBudget(state);
  if (budget.attempts.includes(key)) return;
  if (budget.used >= budget.limit) {
    throw Object.assign(
      Error(
        `本回合已自动尝试修订 ${budget.limit} 轮，当前草稿已保存。可以补充要求、继续修改或选择范围重新生成。`,
      ),
      { code: "AUTHOR_REVISION_LIMIT", name: "AutomaticRevisionLimit" },
    );
  }
  budget.used++;
  budget.attempts.push(key);
}

export function draftScenes(state) {
  return Object.entries(state.values || {})
    .filter(
      ([key, text]) =>
        /^final-scene:\d+$/.test(key) && typeof text === "string",
    )
    .sort(([a], [b]) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
    .map(([key, content]) => ({
      scene: Number(key.split(":")[1]) + 1,
      content,
    }));
}
export const draftVersion = (state) => digest(draftScenes(state));

// 模糊作者要求不能伪装成已经定位的正文错误；旧记录也从实际审稿结果派生。
export function issueNeedsInstruction(issue) {
  return (
    issue.status === "awaiting_author" &&
    !!issue.latest?.authorRequested &&
    issue.latest?.grounding?.decision === "needs_confirmation" &&
    !issue.latest?.repairTargets?.length
  );
}

// 已变更原文上的旧发现保留在审稿历史，不继续当作当前待处理问题。
export function currentDraftIssueStatus(state, issue) {
  if (["closed", "verified"].includes(issue.status)) return issue.status;
  const ref = issue.latest?.target;
  const scene = /^scene:(\d+)$/.exec(ref?.sourceId || "");
  if (!scene || !ref?.quote) return issue.status;
  const content = state.values?.[`final-scene:${Number(scene[1]) - 1}`];
  return typeof content === "string" && !content.includes(ref.quote)
    ? "stale"
    : issue.status;
}

export function setDraftScenes(state, scenes) {
  for (const key of Object.keys(state.values))
    if (/^final-scene:\d+$/.test(key)) delete state.values[key];
  for (const scene of scenes)
    state.values[`final-scene:${scene.scene - 1}`] = scene.content;
}

export function recordDraftVersion(
  state,
  label = "已保存草稿",
  scenes = draftScenes(state),
  status = "saved",
  reason = "",
) {
  if (!scenes.some((s) => s.content.trim())) return null;
  state.draftVersions ??= [];
  const version = digest(scenes);
  // 待审候选复核后更新同一版本的状态，保留原稿为独立版本。
  const pending = state.draftVersions.find(
    (v) => v.version === version && v.status === "pending",
  );
  if (pending && status !== "pending")
    Object.assign(pending, { status, reason, label });
  const existing = state.draftVersions.find(
    (v) => v.version === version && v.status === status,
  );
  if (existing) return existing;
  const entry = {
    id: crypto.randomUUID(),
    version,
    label,
    status,
    reason,
    at: new Date().toISOString(),
    scenes: structuredClone(scenes),
  };
  state.draftVersions.push(entry);
  return entry;
}

export function pauseDraft(state, reason) {
  state.status = "awaiting_instruction";
  state.stage = "草稿已保存，等待作者指导";
  state.error = reason;
  recordDraftVersion(state, "自动修订结束时的草稿");
  const id = `draft-paused-${state.id}-${revisionBudget(state).epoch}`;
  state.reviewConversation ??= [];
  if (!state.reviewConversation.some((m) => m.id === id))
    state.reviewConversation.push({
      id,
      role: "assistant",
      text: `草稿已保存，本次自动处理已结束。${reason}\n\n可在下方草稿工作区查看正文和遗留问题，继续交代修改、保留原文或按范围重新生成。作者介入后会重置自动修订次数。`,
    });
}
