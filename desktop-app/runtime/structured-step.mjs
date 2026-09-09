import { digest } from "./memory.mjs";
import { requestOutput } from "./model-capabilities.mjs";
import { stageCategory, appendCreationEvent } from "./creation-log.mjs";
import { fitWritingContext } from "./context-budget.mjs";
import {
  parseStructured,
  structuredRetryMessages,
  largerStructuredOutput,
  validationReason,
  MAX_STRUCTURED_OUTPUT,
} from "./structured.mjs";
import { REVIEW_RESULT_VERSION } from "./review-result.mjs";
import { REPAIR_PLAN_VERSION } from "./repair-plan.mjs";
import { revisionBudget } from "./revision-session.mjs";
import { authorIdProtocol } from "./review-author-ids.mjs";
import {
  AUTHOR_CONSTRAINT_CONTEXT_VERSION,
  ARBITRATION_EVIDENCE_VERSION,
} from "./review-payload.mjs";
import {
  WORKFLOW_SKILL,
  workflowMessages,
  assertWorkflowStage,
} from "./workflow-skill.mjs";

export const STRUCTURED_RECOVERY_VERSION = `structured-recovery-2:author-ids-1:${REVIEW_RESULT_VERSION}:${REPAIR_PLAN_VERSION}:${WORKFLOW_SKILL.hash}`;
const authorStages = new Set([
  "review",
  "continuity_review",
  "grounding",
  "arbitration",
  "patch",
  "verification",
]);

export function blockedStructuredRecovery(state) {
  const failure = state.structuredFailure;
  const step = state.structuredSteps?.[failure?.stepId];
  if (step && (state.revisionBudget?.epoch || 0) > (step.authorEpoch || 0))
    return null;
  if (
    step?.contractId === "arbitration" &&
    step.arbitrationEvidenceVersion !== ARBITRATION_EVIDENCE_VERSION
  )
    return null;
  // 只迁移受裁定上下文协议变更影响的旧失败。历史尝试及其他步骤预算仍保留。
  if (
    authorStages.has(step?.contractId) &&
    step.authorContextVersion !== AUTHOR_CONSTRAINT_CONTEXT_VERSION &&
    step.input?.some((message) => {
      if (message.role !== "user") return false;
      try {
        return JSON.parse(message.content).authorConstraints?.length > 0;
      } catch {
        return false;
      }
    })
  )
    return null;
  return state.status !== "completed" &&
    failure?.version === STRUCTURED_RECOVERY_VERSION
    ? failure
    : null;
}

function exhaustedError(step) {
  const last = step.lastFailure;
  const error = Error(
    `“${step.label}”同一输入的纠错预算已用尽，重复恢复不会再次请求模型。草稿与失败结果已保存，需要调整该批输入或处理协议后继续。最后原因：${last.detail}`,
  );
  error.name =
    last.name === "RepairScopeError"
      ? last.name
      : "StructuredRecoveryExhausted";
  error.code = "STRUCTURED_RECOVERY_EXHAUSTED";
  error.targets = last.targets;
  return error;
}

/** 执行一个持久化结构化步骤；工作流重试编号不能刷新其纠错与扩容预算。 */
export function createStructuredAsker({ state, budget, call, save, signal }) {
  return async function ask(
    key,
    messages,
    validate,
    tokens = 4000,
    label = key,
    options = {},
  ) {
    signal?.throwIfAborted();
    const contract = options.contract;
    assertWorkflowStage(state, contract);
    messages = workflowMessages(messages, contract);
    const authorProtocol = authorIdProtocol(messages);
    messages = authorProtocol.messages;
    const validateResponse = (raw) => {
      raw = authorProtocol.decode(raw);
      let parsed;
      try {
        parsed = contract.parse(raw);
      } catch (error) {
        // 字段错误不掩盖本批原文范围等诊断；任何一层失败都不能接收结果。
        const reasons = [validationReason(error)];
        try {
          validate(raw);
        } catch (domainError) {
          reasons.push(validationReason(domainError));
        }
        throw Object.assign(Error([...new Set(reasons)].join("\n")), {
          code: "MODEL_CONTRACT",
        });
      }
      return validate(parsed);
    };
    const baseMessages = messages;
    const stableKey = key.replace(/:workflow-1:retry-\d+/g, "");
    const id = digest([
      STRUCTURED_RECOVERY_VERSION,
      budget.key,
      stableKey,
      baseMessages,
      revisionBudget(state).epoch,
    ]);
    const resultOwner = state.structuredResults?.[key];
    const previousStep = state.structuredSteps?.[resultOwner];
    const reusableAcrossRounds = ![
      "patch",
      "verification",
      "author_revision",
      "author_verification",
    ].includes(contract.id);
    // 旧缓存沿原检查点契约校验；新结果必须属于相同输入节点。
    if (
      Object.hasOwn(state.values, key) &&
      (!resultOwner ||
        resultOwner === id ||
        (reusableAcrossRounds &&
          previousStep?.status === "succeeded" &&
          digest(previousStep.input) === digest(baseMessages)))
    )
      return validate(structuredClone(state.values[key]));
    state.structuredSteps ??= {};
    const step = (state.structuredSteps[id] ??= {
      id,
      version: STRUCTURED_RECOVERY_VERSION,
      label,
      status: "pending",
      input: structuredClone(baseMessages),
      contractId: contract.id,
      authorEpoch: revisionBudget(state).epoch,
      ...(contract.id === "arbitration"
        ? { arbitrationEvidenceVersion: ARBITRATION_EVIDENCE_VERSION }
        : {}),
      ...(authorStages.has(contract.id)
        ? { authorContextVersion: AUTHOR_CONSTRAINT_CONTEXT_VERSION }
        : {}),
      skill: { ...WORKFLOW_SKILL },
      corrections: 0,
      expansions: 0,
      calls: 0,
      maxCorrections: options.maxCorrections === 2 ? 2 : 1,
      outputBudget: requestOutput(tokens, budget),
    });
    if (step.status === "succeeded") {
      const value = validateResponse(
        parseStructured(state.fragments[step.rawKey]),
      );
      state.values[key] = value;
      (state.structuredResults ??= {})[key] = id;
      await save();
      signal?.throwIfAborted();
      return value;
    }
    const stop = async () => {
      step.status = "exhausted";
      const error = exhaustedError(step);
      state.structuredFailure = {
        version: STRUCTURED_RECOVERY_VERSION,
        stepId: id,
        label,
        detail: error.message,
      };
      await save();
      throw error;
    };
    if (step.status === "exhausted") return stop();
    // 只有输入/协议确实变化并进入另一个步骤，才建立新的执行预算。
    if (state.structuredFailure?.stepId !== id) delete state.structuredFailure;
    const budgetKey = digest([budget.key, baseMessages]);
    state.outputBudgets ??= {};
    const previous = state.outputBudgets[budgetKey];
    tokens = requestOutput(
      Math.max(
        step.outputBudget,
        Number.isSafeInteger(previous) && previous <= MAX_STRUCTURED_OUTPUT
          ? previous
          : 0,
      ),
      budget,
    );
    const requestMessages = () => {
      if (!step.correction) return baseMessages;
      const error =
        step.correction.kind === "syntax"
          ? new SyntaxError(step.correction.detail)
          : Error(step.correction.detail);
      return structuredRetryMessages(
        baseMessages,
        state.fragments[step.correction.rawKey],
        error,
        tokens,
        budget,
      );
    };
    if (step.correction) {
      appendCreationEvent(state, {
        category: stageCategory(label),
        title: `${label} · 继续已保存的纠错步骤`,
        details: {
          已用纠错次数: step.corrections,
          失败原因: step.correction.detail,
        },
      });
    }
    for (;;) {
      signal?.throwIfAborted();
      messages = requestMessages();
      if (!step.pendingRaw) {
        step.status = "requesting";
        step.outputBudget = tokens;
        await save();
        // 网络中断保留本次纠错输入；不刷新格式纠错预算。
        const response = await call(messages, tokens, label, true);
        step.calls++;
        const rawKey = `raw:${key}:step-${id.slice(0, 12)}:${step.calls}`;
        state.fragments[rawKey] = response.text;
        state.responseMeta ??= {};
        state.responseMeta[rawKey] = {
          finishReason: response.finishReason,
          usage: response.usage,
          model: response.model,
          outputBudget: tokens,
          stepId: id,
        };
        step.rawKey = step.pendingRaw = rawKey;
        step.status = "received";
        // 结果已落盘而校验尚未完成时，重启直接校验此响应，不再调用模型。
        await save();
      }
      const rawKey = step.pendingRaw;
      const response = {
        ...state.responseMeta[rawKey],
        text: state.fragments[rawKey],
      };
      delete step.pendingRaw;
      if (response.finishReason === "length") {
        step.lastFailure = {
          kind: "output_limit",
          name: "OutputLimit",
          rawKey,
          detail: `输出达到${tokens}额度，响应尚未完成。`,
        };
        const selected = fitWritingContext(messages, tokens, budget);
        const next = largerStructuredOutput(selected.messages, tokens, budget);
        if (step.expansions >= 2 || next <= tokens) return stop();
        step.expansions++;
        state.outputBudgets[budgetKey] = tokens = next;
        step.outputBudget = tokens;
        appendCreationEvent(state, {
          category: stageCategory(label),
          status: "waiting",
          title: `${label} · 输出截断，自动增加预算重试`,
          details: { 新输出预算: tokens, 扩容次数: step.expansions },
        });
        await save();
        continue;
      }
      let value;
      try {
        value = validateResponse(parseStructured(response.text));
      } catch (error) {
        const detail = authorProtocol.diagnostic(validationReason(error));
        step.lastFailure = {
          kind: error instanceof SyntaxError ? "syntax" : "validation",
          name: error.name,
          rawKey,
          detail,
          ...(error.targets ? { targets: error.targets } : {}),
        };
        step.status = "correcting";
        appendCreationEvent(state, {
          category: stageCategory(label),
          status: "failed",
          title: `${label} · 校验未通过`,
          details: {
            原因: detail,
            已用纠错次数: step.corrections,
            纠错上限: step.maxCorrections,
          },
        });
        if (step.corrections >= step.maxCorrections) return stop();
        step.corrections++;
        step.correction = { ...step.lastFailure };
        await save();
        continue;
      }
      state.values[key] = value;
      (state.structuredResults ??= {})[key] = id;
      step.resultKey = key;
      step.status = "succeeded";
      delete step.lastFailure;
      delete step.correction;
      if (state.structuredFailure?.stepId === id)
        delete state.structuredFailure;
      appendCreationEvent(state, {
        category: stageCategory(label),
        status: "success",
        title: `${label} · 结果校验通过`,
      });
      await save();
      signal?.throwIfAborted();
      return value;
    }
  };
}
