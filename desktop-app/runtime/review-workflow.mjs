import { digest } from "./memory.mjs";
import { blockedStructuredRecovery } from "./structured-step.mjs";

const labels = {
  review: "核对审稿发现",
  arbitration: "裁定情节依据",
  grounding: "核对修订依据与实际段落",
  awaiting_author: "等待作者回答",
  patch: "修订问题段落",
  verify: "复核修订结果",
  completed: "审稿完成",
};
const failureSummary = {
  protocol_exhausted:
    "同一输入的纠错预算已用尽，已停止请求模型。草稿和诊断已保存，需修正输入或处理协议后继续。",
  invalid_result: "模型返回的结论仍不完整或未通过校验，可以从本步骤重试。",
  repeat_finding: "本轮重复提出已处理的问题，但没有新证据，需要重新审稿。",
  repair_limit: "本轮修订尚未通过复核，原稿和作者取舍已保存，可以继续修订。",
  round_limit: "本轮修订次数已用完，可以保留当前进度继续处理。",
  execution: "本步骤执行中断，已保存的进度可以恢复。",
};
const claim = (r) => [r.sourceId, r.quote?.trim() || ""];
const signature = (i) =>
  digest([i.kind, claim(i.target), i.evidence.map(claim).sort()]);

/** 审稿状态只存放在任务检查点；旧版记录按首次恢复导入。 */
export function reviewWorkflow(state) {
  if (!state.reviewWorkflow) {
    state.reviewWorkflow = {
      version: 1,
      phase: "review",
      retry: 0,
      issues: [],
      constraints: [],
      events: [],
    };
    for (const commit of state.paragraphReview?.commits || []) {
      const issues = trackFindings(
        state,
        commit.findings,
        commit.beforeVersion,
      );
      markIssues(state, issues, "verified", "从已通过复核的旧提交恢复");
    }
    for (const h of state.authorReviewHistory || [])
      rememberDecisions(state, h.pendingId, h.issues);
  }
  return state.reviewWorkflow;
}
function event(state, type, details = {}) {
  const w = reviewWorkflow(state);
  w.events.push({
    sequence: w.events.length + 1,
    at: new Date().toISOString(),
    type,
    ...details,
  });
}

/** 短 id 用于单次模型请求，ledgerId 用于跨轮追踪，不能拿模型序号当问题身份。 */
export function trackFindings(state, findings, documentVersion) {
  const w = reviewWorkflow(state);
  const before = structuredClone(w.issues),
    events = w.events.length;
  try {
    return registerFindings(state, findings, documentVersion);
  } catch (e) {
    w.issues = before;
    w.events.length = events;
    throw e;
  }
}
function registerFindings(state, findings, documentVersion) {
  const w = reviewWorkflow(state);
  const used = new Set();
  return findings.map((finding) => {
    const sig = signature(finding);
    let item = w.issues.find((i) => i.signatures.includes(sig));
    if (!item) {
      // 只在目标场景一致且有相同原文证据时关联；多个可能项则另建，避免误合并。
      const related = w.issues.filter(
        (i) =>
          !used.has(i.id) &&
          i.latest.kind === finding.kind &&
          i.latest.target.sourceId === finding.target.sourceId &&
          (i.latest.target.paragraph === finding.target.paragraph ||
            i.latest.target.quote === finding.target.quote) &&
          i.latest.evidence.some((a) =>
            finding.evidence.some(
              (b) => JSON.stringify(claim(a)) === JSON.stringify(claim(b)),
            ),
          ),
      );
      if (related.length === 1) item = related[0];
    }
    if (!item) {
      item = {
        id: `issue-${w.issues.length + 1}`,
        status: finding.blocking ? "open" : "advisory",
        signatures: [],
        occurrences: [],
      };
      w.issues.push(item);
    }
    used.add(item.id);
    const occurrence = digest([documentVersion, sig]);
    if (!item.occurrences.includes(occurrence)) {
      if (
        ["verified", "closed"].includes(item.status) &&
        !finding.authorRetained
      ) {
        if (item.signatures.includes(sig))
          throw new ReviewRetryableError(
            "review",
            "repeat_finding",
            "审稿重复提出已复核的问题，但没有新证据。请重试审稿，已完成的修订会保留。",
          );
        event(state, "issue_reopened", {
          issueId: item.id,
          reason: finding.explanation,
          documentVersion,
        });
      } else event(state, "issue_found", { issueId: item.id, documentVersion });
      item.occurrences.push(occurrence);
      item.signatures.push(sig);
      item.history ??= [];
      item.history.push({
        documentVersion,
        signature: sig,
        target: structuredClone(finding.target),
        evidence: structuredClone(finding.evidence),
        explanation: finding.explanation,
      });
      item.status = finding.authorRetained
        ? "closed"
        : finding.blocking
          ? "open"
          : "advisory";
    }
    if (finding.authorRetained)
      markIssues(
        state,
        [{ ...finding, ledgerId: item.id }],
        "closed",
        "作者已确认保留当前断言",
      );
    item.latest = structuredClone(finding);
    item.documentVersion = documentVersion;
    return { ...finding, ledgerId: item.id };
  });
}
export function markIssues(state, findings, status, reason) {
  const w = reviewWorkflow(state);
  for (const f of findings) {
    const item = w.issues.find(
      (i) => i.id === f.ledgerId || i.signatures.includes(signature(f)),
    );
    if (!item || item.status === status) continue;
    item.status = status;
    event(state, `issue_${status}`, { issueId: item.id, reason });
  }
}

export function recordGroundedFindings(state, findings, documentVersion) {
  const w = reviewWorkflow(state);
  for (const finding of findings) {
    const item = w.issues.find((i) => i.id === finding.ledgerId);
    if (!item) continue;
    const sig = signature(finding);
    if (!item.signatures.includes(sig)) {
      item.signatures.push(sig);
      item.history ??= [];
      item.history.push({
        documentVersion,
        signature: sig,
        target: structuredClone(finding.target),
        evidence: structuredClone(finding.evidence),
        explanation: finding.explanation,
      });
      event(state, "issue_grounded", {
        issueId: item.id,
        documentVersion,
        reason: finding.explanation,
      });
    }
    item.latest = structuredClone(finding);
    item.documentVersion = documentVersion;
  }
}

/** 保留作者决定时的事实文本，不把旧段落编号当成新版本事实。 */
export function rememberDecisions(state, pendingId, issues) {
  const w = reviewWorkflow(state);
  for (const i of issues) {
    const id = `${pendingId}:${i.id}`;
    if (w.constraints.some((c) => c.id === id)) continue;
    w.constraints.push({
      id,
      ledgerId: i.ledgerId,
      action: i.resolution,
      kind: i.kind,
      instruction: i.authorInstruction,
      facts: (i.preserve || []).map((r) => ({
        sourceId: r.sourceId,
        quote: r.quote,
      })),
      issueSignature: signature(i),
      target: structuredClone(i.target),
      evidence: structuredClone(i.evidence),
    });
    event(state, "author_decided", { constraintId: id, issueId: i.ledgerId });
  }
}
export function authorConstraints(state, doc) {
  return reviewWorkflow(state).constraints.map((c) => ({
    id: c.id,
    instruction: c.instruction,
    action: c.action,
    facts: c.facts.map((f) => {
      const source = doc.sources.find((s) => s.sourceId === f.sourceId);
      const matches = (source?.paragraphs || []).flatMap((p) => {
        if (p.text === f.quote)
          return [{ sourceId: f.sourceId, paragraph: p.paragraph }];
        return p.sentences
          .filter((s) => s.text === f.quote)
          .map((s) => ({
            sourceId: f.sourceId,
            paragraph: p.paragraph,
            sentence: s.sentence,
          }));
      });
      return {
        ...f,
        currentReference: matches.length === 1 ? matches[0] : null,
      };
    }),
  }));
}
export function reuseAuthorDecisions(state, problems, doc) {
  const w = reviewWorkflow(state);
  return problems.map((i) => {
    const c = [...w.constraints]
      .reverse()
      .find((c) => matchesAuthorDecision(c, i));
    if (!c) return i;
    return {
      ...i,
      resolution: c.action,
      preserve: authorConstraints(state, doc)
        .find((a) => a.id === c.id)
        .facts.flatMap((f) => {
          if (!f.currentReference) return [];
          const source = doc.sources.find((s) => s.sourceId === f.sourceId);
          return [
            { ...f.currentReference, quote: f.quote, sourceHash: source.hash },
          ];
        }),
      authorInstruction: c.instruction,
      authorConstraintId: c.id,
      allowedTargets: [i.target, ...i.evidence].filter((r) =>
        doc.sources.some((s) => s.sourceId === r.sourceId && s.editable),
      ),
    };
  });
}

function matchesAuthorDecision(constraint, issue) {
  if (constraint.issueSignature === signature(issue)) return true;
  // 复审可能把整段目标缩到作者选定的完整一句；这仍是同一保留事实。
  // 只接受精确事实文本，不因共享段号、关键词或部分字符串而沿用授权。
  if (
    constraint.action === "preserve_evidence" &&
    ["missing_history", "unsupported_inference"].includes(issue.kind) &&
    constraint.facts.some(
      (fact) =>
        fact.sourceId === issue.target.sourceId &&
        fact.quote === issue.target.quote,
    )
  )
    return true;
  // 稳定编号只能辅助关联，不能把同段后来发现的另一个问题当作已经回答。
  return (
    constraint.kind === issue.kind &&
    constraint.ledgerId &&
    constraint.ledgerId === issue.ledgerId &&
    constraint.target.sourceId === issue.target.sourceId &&
    constraint.target.quote === issue.target.quote &&
    constraint.action === "preserve_evidence" &&
    constraint.facts.some((fact) =>
      issue.evidence.some(
        (ref) => ref.sourceId === fact.sourceId && ref.quote === fact.quote,
      ),
    )
  );
}

// 作者针对同一断言选定当前原文后，缺少前情/推断类发现已经得到取舍。
// 只处理稳定问题身份、相同目标原文与仍可定位的保留事实，不按段号批量放行。
export function applyAuthorDecisions(state, problems, doc) {
  return reuseAuthorDecisions(state, problems, doc).map((issue) => {
    const constraint = reviewWorkflow(state).constraints.find(
      (c) => c.id === issue.authorConstraintId,
    );
    if (
      !constraint ||
      constraint.action !== "preserve_evidence" ||
      !["missing_history", "unsupported_inference"].includes(issue.kind) ||
      constraint.target.sourceId !== issue.target.sourceId ||
      (constraint.target.quote !== issue.target.quote &&
        !constraint.facts.some(
          (fact) =>
            fact.sourceId === issue.target.sourceId &&
            fact.quote === issue.target.quote,
        )) ||
      !issue.preserve.some(
        (r) =>
          r.sourceId === issue.target.sourceId &&
          r.paragraph === issue.target.paragraph &&
          issue.target.quote.includes(r.quote),
      )
    )
      return issue;
    return {
      ...issue,
      blocking: false,
      authorRetained: true,
      fix: "作者已确认保留此处原文；不再以同一处缺少前情为由重问或强制修改。",
    };
  });
}

function repeatedAuthorAnswers(state) {
  const pending = state.pendingReview;
  if (
    !pending?.issues.length ||
    state.status === "completed" ||
    state.paragraphReview?.cycle?.documentVersion !== pending.documentVersion
  )
    return null;
  const answers = state.reviewDecisions?.[pending.id]?.choices || [];
  if (answers.length) return null;
  const restored = pending.issues.map((issue) => {
    const c = [...(state.reviewWorkflow?.constraints || [])]
      .reverse()
      .find(
        (c) =>
          matchesAuthorDecision(c, issue) &&
          c.target.sourceId === issue.target.sourceId &&
          c.target.sourceHash &&
          c.target.sourceHash === issue.target.sourceHash &&
          (c.target.quote === issue.target.quote ||
            c.facts.some(
              (fact) =>
                fact.sourceId === issue.target.sourceId &&
                fact.quote === issue.target.quote,
            )),
      );
    if (!c) return null;
    return {
      ...issue,
      resolution: c.action,
      authorInstruction: c.instruction,
      authorConstraintId: c.id,
      preserve: c.facts.flatMap((f) => {
        const ref = [c.target, ...c.evidence].find(
          (r) => r.sourceId === f.sourceId && r.quote === f.quote,
        );
        return ref ? [{ ...ref }] : [];
      }),
    };
  });
  return restored.some((i) => !i) ? null : restored;
}

// 旧版已经反复提问时，恢复已保存的答案，不伪造一次新的用户作答。
export function restoreRepeatedAuthorQuestions(state) {
  const pending = state.pendingReview,
    restored = repeatedAuthorAnswers(state);
  if (!restored) return false;
  const problems = [...(pending.automatic || []), ...restored];
  state.paragraphReview.cycle.problems = problems;
  delete state.paragraphReview.cycle.repairPlan;
  delete state.paragraphReview.cycle.patch;
  delete state.pendingReview;
  state.status = "retryable";
  state.error = "";
  reviewWorkflow(state).phase = "grounding";
  event(state, "author_answers_reused", {
    pendingId: pending.id,
    issues: restored.map((i) => i.id),
  });
  return true;
}

export class ReviewRetryableError extends Error {
  constructor(phase, kind, message) {
    super(message);
    this.name = "ReviewRetryableError";
    this.phase = phase;
    this.kind = kind;
  }
}
export async function reviewStep(state, phase, save, run) {
  const w = reviewWorkflow(state);
  w.phase = phase;
  state.stage = labels[phase];
  if (w.events.at(-1)?.phase !== phase) event(state, "phase", { phase });
  await save();
  try {
    return await run();
  } catch (error) {
    if (
      error.name === "WaitingForAuthor" ||
      error.name === "AbortError" ||
      error.name === "TimeoutError"
    )
      throw error;
    const e =
      error instanceof ReviewRetryableError
        ? error
        : new ReviewRetryableError(
            phase,
            error.code === "STRUCTURED_RECOVERY_EXHAUSTED"
              ? "protocol_exhausted"
              : error.code === "MODEL_VALIDATION" || error.name === "ZodError"
                ? "invalid_result"
                : "execution",
            error.message,
          );
    w.failure = {
      phase: e.phase,
      kind: e.kind,
      detail: e.message,
      retry: w.retry,
      ...(error.name === "RepairScopeError"
        ? { replan: true, targets: error.targets }
        : {}),
    };
    if (error.name === "RepairScopeError") e.targets = error.targets;
    state.status = "retryable";
    state.error = e.message;
    event(state, "retry_required", { phase: e.phase, kind: e.kind });
    await save();
    throw e;
  }
}
export function retryReview(state) {
  const w = reviewWorkflow(state);
  if (w.failure) {
    w.retry++;
    const cycle = state.paragraphReview?.cycle;
    if (
      cycle &&
      (w.failure.replan ||
        /补丁超出问题指定段落|补丁没有实际修改|补丁未覆盖|原错误片段仍未修改/.test(
          w.failure.detail || "",
        ))
    ) {
      cycle.scopeFeedback = {
        reason: w.failure.detail,
        targets: w.failure.targets || [],
      };
      delete cycle.repairPlan;
      delete cycle.patch;
      cycle.attempt = 0;
      cycle.scopeExpansions = 0;
      w.phase = "grounding";
    }
    if (w.failure.kind === "repair_limit" && cycle) {
      cycle.attempt = 0;
      delete cycle.patch;
    }
    if (w.failure.kind === "round_limit")
      state.paragraphReview.reviewLimit = state.paragraphReview.round + 2;
    delete w.failure;
    event(state, "resumed", { phase: w.phase });
  }
}
export function finishReview(state) {
  const w = reviewWorkflow(state);
  if (w.phase === "completed") return;
  w.phase = "completed";
  delete w.failure;
  for (const item of w.issues)
    if (item.status === "verified") item.status = "closed";
  event(state, "completed");
}
export function addRecoveryMessage(state) {
  const w = reviewWorkflow(state);
  const continuation = blockedStructuredRecovery(state)
    ? "该输入的纠错预算已用尽，已停止请求模型。修正输入或处理协议后才能继续。"
    : "点击“恢复上次任务”将继续这一步。";
  const id = `review-recovery-${state.id}-${w.retry}-${w.phase}`;
  state.reviewConversation ??= [];
  if (!state.reviewConversation.some((m) => m.id === id))
    state.reviewConversation.push({
      id,
      role: "assistant",
      text: `任务停在“${labels[w.phase] || "审稿"}”。${w.failure?.detail ? `原因：${w.failure.detail}\n\n` : ""}草稿和已回答的情节取舍已保存，无需重新回答。${continuation}`,
    });
}
/** IPC 与前端使用同一份状态投影；未答问题优先于旧版错误状态。 */
export function reviewTaskState(state, active = false) {
  const pending = state.pendingReview;
  const repeatAnswered = !!repeatedAuthorAnswers(state);
  const answers = state.reviewDecisions?.[pending?.id]?.choices || [];
  const unanswered =
    !repeatAnswered &&
    pending?.issues.some((i) => !answers.some((a) => a.issueId === i.id));
  const status = repeatAnswered
    ? "retryable"
    : unanswered && state.status !== "completed"
      ? "awaiting_input"
      : state.status;
  const w = state.reviewWorkflow;
  return {
    status,
    review: unanswered ? { ...pending, answers } : null,
    resumable:
      !active &&
      !blockedStructuredRecovery(state) &&
      !unanswered &&
      [
        "retryable",
        "failed",
        "interrupted",
        "running",
        "ready",
        "awaiting_input",
      ].includes(status),
    reviewProgress: w
      ? {
          phase: repeatAnswered ? "grounding" : w.phase,
          label: repeatAnswered
            ? "已复用作者裁定，可继续任务"
            : labels[w.phase],
          failure: w.failure
            ? {
                kind: w.failure.kind,
                detail: w.failure.detail,
                summary:
                  failureSummary[w.failure.kind] || failureSummary.execution,
              }
            : null,
          issues: w.issues.map((i) => ({
            id: i.id,
            status: i.status,
            explanation: i.latest?.explanation || "",
          })),
          decisions: w.constraints.length,
        }
      : null,
  };
}
