import { z } from "zod";
import { digest } from "./memory.mjs";
import { reviewDocument, evidenceAt } from "./paragraph-review.mjs";
import {
  reviewWorkflow,
  rememberDecisions,
  markIssues,
  retryReview,
} from "./review-workflow.mjs";
import {
  authorIntervenes,
  draftScenes,
  draftVersion,
  setDraftScenes,
  recordDraftVersion,
  revisionBudget,
  currentDraftIssueStatus,
  issueNeedsInstruction,
} from "./revision-session.mjs";

const scopeSchema = z
  .object({
    kind: z.enum(["chapter", "scene", "paragraph"]),
    sourceId: z.string().optional(),
    paragraph: z.number().int().positive().optional(),
  })
  .strict();
const actionSchema = z
  .object({
    id: z.string().min(1).max(200),
    taskId: z.string(),
    draftVersion: z.string(),
    type: z.enum([
      "continue",
      "revise",
      "regenerate",
      "keep",
      "edit",
      "restore",
      "deliver",
    ]),
    scope: scopeSchema.optional(),
    issueIds: z.array(z.string()).max(32).optional(),
    text: z.string().max(100000).optional(),
    versionId: z.string().optional(),
  })
  .strict();

export function scopedRows(scenes, scope = { kind: "chapter" }) {
  const doc = reviewDocument(scenes, {});
  const rows = doc.sources.flatMap((s) =>
    s.paragraphs.map((p) => ({
      sourceId: s.sourceId,
      paragraph: p.paragraph,
      text: p.text,
      start: p.start,
      end: p.end,
    })),
  );
  const selected = rows.filter(
    (r) =>
      scope.kind === "chapter" ||
      (r.sourceId === scope.sourceId &&
        (scope.kind === "scene" || r.paragraph === scope.paragraph)),
  );
  if (!selected.length) throw Error("所选段落或场景不存在，请重新选择范围。");
  return selected;
}

export function replaceDraftScope(scenes, scope, text) {
  const rows = scopedRows(scenes, scope);
  if (!text.trim()) throw Error("修改后的正文不能为空。");
  if (scope.kind === "chapter") return [{ scene: 1, content: text.trim() }];
  return scenes.map((s) => {
    if (`scene:${s.scene}` !== scope.sourceId) return s;
    if (scope.kind === "scene") return { ...s, content: text.trim() };
    const row = rows[0];
    return {
      ...s,
      content:
        s.content.slice(0, row.start) + text.trim() + s.content.slice(row.end),
    };
  });
}

/** 作者动作先在检查点副本中完整验证，再落盘；相同操作 ID 不产生第二次干预。 */
export function isDraftActionReplay(state, raw, instruction) {
  const receipt = state?.authorActions?.find((a) => a.id === raw?.id);
  if (!receipt) return false;
  const parsed = actionSchema.parse(raw);
  if (
    parsed.taskId !== state.id ||
    receipt.fingerprint !== digest([parsed, instruction])
  )
    throw Error("同一作者操作不能替换为另一条要求。");
  return true;
}

export function prepareDraftAction(state, raw, instruction) {
  const action = actionSchema.parse(raw);
  if (action.taskId !== state.id) throw Error("任务已经变化，请刷新草稿。");
  const fingerprint = digest([action, instruction]);
  if (isDraftActionReplay(state, action, instruction)) {
    Object.defineProperty(state, "authorReplay", { value: true });
    return state;
  }
  if (action.draftVersion !== draftVersion(state))
    throw Error("草稿已变化，请查看最新版本后再操作。");
  const scenes = draftScenes(state);
  if (!scenes.some((s) => s.content.trim()))
    throw Error("当前任务还没有可修改的草稿。");
  if (action.type === "regenerate" && !action.scope)
    throw Error("请选择重新生成的范围：段落、场景或整章。");
  const scope = action.scope || { kind: "chapter" };
  scopedRows(scenes, scope);
  const selected = (action.issueIds || []).map((id) => {
    const issue = state.reviewWorkflow?.issues.find((i) => i.id === id);
    if (!issue?.latest) throw Error("所选问题不存在，请重新载入审稿记录。");
    if (
      ["closed", "verified", "stale"].includes(
        currentDraftIssueStatus(state, issue),
      )
    )
      throw Error("所选问题已处理或原文已变化，请重新选择当前问题。");
    return issue;
  });
  if (action.type === "keep" && !selected.length)
    throw Error("请先选择要保留原文的问题。");
  if (action.type === "revise" && !instruction.trim() && !selected.length)
    throw Error("请输入修改要求或选择问题。");
  if (
    ["revise", "continue"].includes(action.type) &&
    selected.some(issueNeedsInstruction) &&
    !instruction.trim()
  )
    throw Error(
      "所选问题中有尚未说明怎么改的作者要求，请补充具体修改要求，或选择保留原文。",
    );
  let replacement;
  if (action.type === "edit")
    replacement = replaceDraftScope(scenes, scope, action.text || "");
  if (action.type === "restore") {
    const version = state.draftVersions?.find(
      (v) => v.id === action.versionId && v.status === "saved",
    );
    if (!version) throw Error("原版本不存在或尚未通过保存条件。");
    replacement = structuredClone(version.scenes);
  }
  const doc = reviewDocument(scenes, {});
  const kept =
    action.type === "keep"
      ? selected.map((item) => {
          const original = item.latest.target;
          const source = doc.sources.find(
            (s) => s.sourceId === original.sourceId,
          );
          const matches = (source?.paragraphs || []).filter((p) =>
            p.text.includes(original.quote),
          );
          if (matches.length !== 1)
            throw Error("所选问题的原文已变化，请重新核对后选择保留。");
          const target = {
            ...original,
            paragraph: matches[0].paragraph,
            sourceHash: source.hash,
          };
          return {
            ...item.latest,
            ledgerId: item.id,
            target,
            preserve: [target],
            resolution: "keep_current",
            authorInstruction:
              instruction || "作者选择保留此处原文，不再按同一问题修改。",
          };
        })
      : [];

  const previousWork = state.draftWork;
  const continuing =
    action.type === "continue" &&
    !selected.length &&
    previousWork &&
    previousWork.status !== "done" &&
    !state.pendingReview;
  recordDraftVersion(state, "作者介入前的草稿");
  state.reviewSessions ??= [];
  if (state.paragraphReview && !continuing)
    state.reviewSessions.push({
      actionId: action.id,
      review: state.paragraphReview,
      pending: state.pendingReview || null,
    });
  // 已提交的部分作者答复也继承，不能因另一项新操作丢失。
  const pending = state.pendingReview;
  for (const choice of state.reviewDecisions?.[pending?.id]?.choices || []) {
    const issue = pending.issues.find((i) => i.id === choice.issueId);
    const option = issue?.options.find((o) => o.id === choice.optionId);
    if (option)
      rememberDecisions(state, pending.id, [
        {
          ...issue,
          resolution: option.action,
          preserve: option.preserve,
          authorInstruction: choice.instruction || option.label,
        },
      ]);
  }
  authorIntervenes(state, action.id, instruction || action.type);
  const workflow = reviewWorkflow(state);
  retryReview(state, true);
  delete workflow.failure;
  workflow.phase = "review";
  if (!continuing) delete state.paragraphReview;
  else if (state.paragraphReview) {
    state.paragraphReview.reviewLimit =
      state.paragraphReview.round + revisionBudget(state).limit;
    if (state.paragraphReview.cycle) {
      state.paragraphReview.cycle.attempt = 0;
      delete state.paragraphReview.cycle.patch;
    }
  }
  delete state.pendingReview;
  // 旧失败及原始响应仍留在 structuredSteps；新回合用独立步骤身份执行。
  delete state.structuredFailure;
  if (kept.length) {
    rememberDecisions(state, action.id, kept);
    markIssues(state, kept, "closed", "作者保留当前原文");
  }
  if (replacement) {
    setDraftScenes(state, replacement);
    recordDraftVersion(
      state,
      action.type === "restore" ? "作者恢复的版本" : "作者手动编辑",
    );
    state.authorDirections ??= [];
    state.authorDirections.push({
      id: action.id,
      scope: action.type === "restore" ? { kind: "chapter" } : scope,
      instruction: `作者${action.type === "restore" ? "主动恢复了所选旧版本" : "手动编辑了指定范围"}。本次变更涉及的事实取舍以当前原文为准，未变更的其他作者裁定继续有效。`,
    });
    // 场景结构可能改变，旧时间锚点不能冒充新场景的计划。
    if (scope.kind === "chapter" || action.type === "restore") {
      if (state.reviewContext) {
        delete state.reviewContext.sceneTimes;
        delete state.reviewContext.continuity;
      }
    }
  }
  if (["revise", "regenerate"].includes(action.type) && instruction.trim()) {
    state.authorDirections ??= [];
    state.authorDirections.push({ id: action.id, instruction, scope });
  }
  for (const item of selected) if (action.type !== "keep") item.status = "open";
  state.draftWork = continuing
    ? { ...previousWork, id: action.id, attempt: 0 }
    : {
        ...action,
        type:
          action.type === "continue" && selected.length
            ? "revise"
            : action.type,
        scope,
        instruction,
        selectedIssues: selected.map((i) => structuredClone(i.latest)),
        baseScenes: scenes,
        status: "pending",
      };
  state.reviewConversation ??= [];
  state.reviewConversation.push({
    id: `author-action-${action.id}`,
    role: "user",
    text: instruction || action.type,
  });
  state.authorActions ??= [];
  state.authorActions.push({
    id: action.id,
    fingerprint,
    action,
    at: new Date().toISOString(),
  });
  state.status = "running";
  state.error = "";
  state.stage = "执行作者指导";
  return state;
}

export function draftWorkspaceView(state) {
  const scenes = draftScenes(state);
  if (!scenes.some((s) => s.content.trim())) return null;
  return {
    version: draftVersion(state),
    scenes: scenes.map((s) => ({
      ...s,
      sourceId: `scene:${s.scene}`,
      paragraphs: scopedRows([s]).map((r) => ({
        paragraph: r.paragraph,
        text: r.text,
      })),
    })),
    versions: (state.draftVersions || []).map((v) => ({
      id: v.id,
      label: v.label,
      status: v.status,
      at: v.at,
      reason: v.reason,
      text: v.scenes.map((s) => s.content).join("\n\n"),
    })),
    budget: {
      epoch: revisionBudget(state).epoch,
      used: revisionBudget(state).used,
      limit: revisionBudget(state).limit,
    },
    lastInstruction: state.draftWork?.instruction || "",
    lastAction: state.authorActions?.length
      ? {
          id: state.authorActions.at(-1).id,
          type: state.authorActions.at(-1).action.type,
          changed:
            state.authorActions.at(-1).action.draftVersion !==
            draftVersion(state),
        }
      : null,
  };
}
