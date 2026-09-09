import { runLocalTasks } from "./review-context.mjs";
import { z } from "zod";
import { workflowContract } from "./workflow-skill.mjs";
import { digest } from "./memory.mjs";
import { modelFindings, modelDocument } from "./review-payload.mjs";
import {
  reviewWorkflow,
  markIssues,
  rememberDecisions,
  authorConstraints,
  reuseAuthorDecisions,
} from "./review-workflow.mjs";

const arbitrationSchema = z.object({
  decisions: z
    .array(
      z.object({
        issueId: z.string(),
        action: z.enum([
          "preserve_evidence",
          "remove_unsupported",
          "needs_confirmation",
        ]),
        evidenceIndexes: z.array(z.number().int().positive()).max(8),
        reason: z.string().min(1).max(1200),
      }),
    )
    .max(32),
});

const arbitrationContract = workflowContract("arbitration", arbitrationSchema);
export function reviewQuestion(pending, issue) {
  const index = pending.issues.findIndex((i) => i.id === issue.id) + 1;
  const explanation = issue.explanation
    .replace(/scene:(\d+)/g, "场景$1")
    .replace(/paragraph\s*(\d+)/gi, "第$1段")
    .replace(/sentence\s*(\d+)/gi, "第$1句");
  const brief =
    explanation.length > 180 ? explanation.slice(0, 180) + "…" : explanation;
  return `需要你确认一个情节（${index}/${pending.issues.length}）：\n${brief}\n${["missing_history", "unsupported_inference"].includes(issue.kind) ? "这处无依据的断言要删除，还是按你的说明保留？" : "这些描写要以哪处原文为准？"}`;
}
function addTurn(state, id, role, text) {
  state.reviewConversation ??= [];
  if (!state.reviewConversation.some((m) => m.id === id))
    state.reviewConversation.push({ id, role, text });
}
function addQuestion(state, pending, issue) {
  if (issue)
    addTurn(
      state,
      `review-${pending.id}-${issue.id}`,
      "assistant",
      reviewQuestion(pending, issue),
    );
}
export class WaitingForAuthor extends Error {
  constructor() {
    super("有创作选择需要你处理，草稿已保存。");
    this.name = "WaitingForAuthor";
  }
}
const refKey = (r) => `${r.sourceId}:${r.paragraph}:${r.sentence ?? ""}`;
function choicesFor(issue) {
  const refs = issue.evidence.filter(
    (r, i, a) => a.findIndex((x) => refKey(x) === refKey(r)) === i,
  );
  return [
    ...refs.map((ref, i) => ({
      id: `evidence-${i + 1}`,
      label: `以这处原文为准：${ref.quote.slice(0, 70)}`,
      action: "preserve_evidence",
      preserve: [ref],
    })),
    ...(["missing_history", "unsupported_inference"].includes(issue.kind)
      ? [
          {
            id: "remove",
            label: "删除无出处的断言，不补写前情",
            action: "remove_unsupported",
            preserve: [],
          },
        ]
      : []),
    {
      id: "custom",
      label: "按我的说明修订",
      action: "author_direction",
      preserve: [],
    },
  ];
}
export async function pauseForAuthor(
  problems,
  doc,
  state,
  save,
  reason,
  automatic = [],
) {
  reviewWorkflow(state).phase = "awaiting_author";
  markIssues(state, problems, "awaiting_author", reason);
  state.pendingReview = {
    id: crypto.randomUUID(),
    documentVersion: doc.version,
    reason,
    automatic,
    issues: problems.map((i) => ({ ...i, options: choicesFor(i) })),
  };
  state.status = "awaiting_input";
  state.stage = "待作者处理连续性问题";
  state.error = "";
  addQuestion(state, state.pendingReview, state.pendingReview.issues[0]);
  await save();
  throw new WaitingForAuthor();
}
export function submitReviewDecision(state, request) {
  const parsed = z
    .object({
      taskId: z.string(),
      pendingId: z.string(),
      choices: z
        .array(
          z
            .object({
              issueId: z.string(),
              optionId: z.string(),
              instruction: z.string().max(2000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(32),
    })
    .strict()
    .parse(request);
  const pending = state.pendingReview;
  if (
    state.status !== "awaiting_input" ||
    parsed.taskId !== state.id ||
    pending?.id !== parsed.pendingId
  )
    throw Error("这份选择已经过期，请刷新问题面板。");
  if (
    new Set(parsed.choices.map((c) => c.issueId)).size !== parsed.choices.length
  )
    throw Error("同一问题不能重复提交。");
  const previous = state.reviewDecisions?.[pending.id]?.choices || [];
  for (const c of parsed.choices) {
    const issue = pending.issues.find((i) => i.id === c.issueId),
      option = issue?.options.find((o) => o.id === c.optionId);
    if (!option) throw Error("无效的问题或选项。");
    if (option.action === "author_direction" && !c.instruction?.trim())
      throw Error("请填写你的修订说明。");
  }
  state.reviewDecisions ??= {};
  const choices = [...previous];
  for (const c of parsed.choices) {
    const old = choices.find((x) => x.issueId === c.issueId);
    if (old && JSON.stringify(old) !== JSON.stringify(c))
      throw Error("该问题已经回答，不能覆盖已提交的选择。");
    if (!old) choices.push(c);
  }
  // 先验证整组，再更新状态；单题作答只推进到下一题，不启动模型。
  state.reviewDecisions[pending.id] = {
    documentVersion: pending.documentVersion,
    choices,
    submittedAt: new Date().toISOString(),
  };
  for (const c of parsed.choices) {
    const issue = pending.issues.find((i) => i.id === c.issueId),
      option = issue.options.find((o) => o.id === c.optionId);
    addQuestion(state, pending, issue);
    addTurn(
      state,
      `review-answer-${pending.id}-${issue.id}`,
      "user",
      c.instruction?.trim() || option.label,
    );
  }
  addQuestion(
    state,
    pending,
    pending.issues.find((i) => !choices.some((c) => c.issueId === i.id)),
  );
  return choices.length === pending.issues.length;
}
/** 相同答复的网络重发只确认收讫，不再启动模型或重复落消息。 */
export function isReviewDecisionReplay(state, request) {
  if (
    !request ||
    request.taskId !== state.id ||
    !Array.isArray(request.choices) ||
    !request.choices.length
  )
    return false;
  const receipt = state.reviewDecisions?.[request.pendingId];
  if (!receipt) return false;
  return request.choices.every((c) =>
    receipt.choices.some(
      (old) =>
        old.issueId === c.issueId &&
        old.optionId === c.optionId &&
        (old.instruction || "") === (c.instruction || ""),
    ),
  );
}
export async function resolveReviewProblems({
  problems,
  doc,
  state,
  ask,
  save,
  round,
  profile,
}) {
  const pending = state.pendingReview,
    decision = pending && state.reviewDecisions?.[pending.id];
  if (pending) {
    if (pending.documentVersion !== doc.version)
      throw Error("正文已变化，旧的作者选择不能应用。");
    if (!decision || decision.choices.length !== pending.issues.length)
      throw new WaitingForAuthor();
    const answered = pending.issues.map((issue) => {
      const choice = decision.choices.find((c) => c.issueId === issue.id),
        option = issue.options.find((o) => o.id === choice.optionId);
      return {
        ...issue,
        resolution: option.action,
        preserve: option.preserve,
        authorInstruction: choice.instruction || option.label,
        authorDecisionId: pending.id,
        allowedTargets: [issue.target, ...issue.evidence].filter(
          (r) => doc.sources.find((s) => s.sourceId === r.sourceId)?.editable,
        ),
        fix: "按作者选择统一冲突及直接相关段落，保留其他情节。",
      };
    });
    rememberDecisions(state, pending.id, answered);
    const resolved = reuseAuthorDecisions(
      state,
      [...(pending.automatic || []), ...answered],
      doc,
    );
    // 固定决策缓存保证中断恢复不重新请求作者，也不重复增加修订预算。
    state.paragraphReview.authorResolutions ??= {};
    state.paragraphReview.authorResolutions[doc.version] = resolved;
    state.paragraphReview.reviewLimit = Math.max(
      state.paragraphReview.reviewLimit || 2,
      round + 2,
    );
    state.authorReviewHistory ??= [];
    state.authorReviewHistory.push({
      pendingId: pending.id,
      choices: decision.choices,
      issues: answered,
    });
    markIssues(state, answered, "decided", "作者已经回答");
    delete state.pendingReview;
    await save();
    return resolved;
  }
  const cached = state.paragraphReview.authorResolutions?.[doc.version];
  if (cached) {
    // 缓存只恢复当前问题的作者答复，不复活本轮已经驳回的其他问题。
    problems = problems.map(
      (issue) =>
        cached.find(
          (old) =>
            old.id === issue.id &&
            old.kind === issue.kind &&
            old.target.sourceId === issue.target.sourceId &&
            old.target.quote === issue.target.quote &&
            digest(old.evidence) === digest(issue.evidence),
        ) || issue,
    );
  }
  problems = reuseAuthorDecisions(state, problems, doc);
  const uncertain = problems.filter(
    (i) => i.resolution === "needs_confirmation",
  );
  if (!uncertain.length) return problems;
  const result = await runLocalTasks({
    doc,
    issues: uncertain,
    constraints: authorConstraints(state, doc),
    profile,
    output: 3500,
    stage: "arbitrate",
    contract: arbitrationContract,
    ask,
    key: `arbitrate-v1:${doc.version}:${digest(uncertain)}`,
    messagesFor: (view, group) => [
      {
        role: "system",
        content:
          '你是连续性裁决员。不要因为审稿员写了需要确认就找作者。依据首次正面描写、明确时间及相关后文判断。能有依据统一时action=preserve_evidence，选择要保留的evidence编号（从1开始）；缺少前情且仅删除断言即可时action=remove_unsupported，不能编造对白或往事。只有关键剧情无法裁决时action=needs_confirmation。不得把人物谎言、感知差异或不同时刻武断合并。只输出JSON：{"decisions":[{"issueId":"...","action":"preserve_evidence","evidenceIndexes":[1],"reason":"具体依据"}]}。',
      },
      {
        role: "user",
        content: JSON.stringify({
          issues: modelFindings(group),
          authorConstraints: authorConstraints(state, doc),
          constraintPolicy:
            "必须遵守已有作者裁定，不能重新裁决或推翻；只有新的、未被裁定覆盖的关键事实才询问作者。",
          document: modelDocument(view),
        }),
      },
    ],
    validate: (v, group) => {
      const out = arbitrationSchema.parse(v);
      if (
        out.decisions.length !== group.length ||
        new Set(out.decisions.map((d) => d.issueId)).size !== group.length
      )
        throw Error("裁决必须逐项覆盖疑问。");
      for (const d of out.decisions) {
        const issue = group.find((i) => i.id === d.issueId);
        if (!issue) throw Error("未知裁决问题");
        if (
          d.action === "preserve_evidence" &&
          (!d.evidenceIndexes.length ||
            d.evidenceIndexes.some((n) => !issue.evidence[n - 1]))
        )
          throw Error("裁决缺少可定位的保留依据");
        if (
          d.action === "remove_unsupported" &&
          !["missing_history", "unsupported_inference"].includes(issue.kind)
        ) {
          d.action = "needs_confirmation";
          d.evidenceIndexes = [];
          d.reason =
            "现有证据无法确定矛盾双方应保留哪一方，需要作者确认；不能自动删除已有事实。";
        }
      }
      return out;
    },
    label: "核对原文与后文，尝试自动裁决",
    merge: (results) => ({ decisions: results.flatMap((r) => r.decisions) }),
  });
  const resolved = problems.map((i) => {
    const d = result.decisions.find((d) => d.issueId === i.id);
    return d
      ? {
          ...i,
          resolution: d.action,
          preserve:
            d.action === "preserve_evidence"
              ? d.evidenceIndexes.map((n) => i.evidence[n - 1])
              : [],
          arbitration: d.reason,
        }
      : i;
  });
  state.paragraphReview.lastArbitration = result;
  await save();
  if (resolved.some((i) => i.resolution === "needs_confirmation"))
    return pauseForAuthor(
      resolved.filter((i) => i.resolution === "needs_confirmation"),
      doc,
      state,
      save,
      "已核对原文和相关后文，仍需要作者决定。",
      resolved.filter((i) => i.resolution !== "needs_confirmation"),
    );
  return resolved;
}
