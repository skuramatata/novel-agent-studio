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

export const STRUCTURED_RECOVERY_VERSION = `structured-recovery-1:${REVIEW_RESULT_VERSION}:${REPAIR_PLAN_VERSION}`;

export function blockedStructuredRecovery(state) {
  const failure = state.structuredFailure;
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
    const baseMessages = messages;
    const stableKey = key.replace(/:workflow-1:retry-\d+/g, "");
    const id = digest([
      STRUCTURED_RECOVERY_VERSION,
      budget.key,
      stableKey,
      baseMessages,
    ]);
    const resultOwner = state.structuredResults?.[key];
    // 旧缓存沿原检查点契约校验；新结果必须属于相同输入节点。
    if (
      Object.hasOwn(state.values, key) &&
      (!resultOwner || resultOwner === id)
    )
      return validate(structuredClone(state.values[key]));
    state.structuredSteps ??= {};
    const step = (state.structuredSteps[id] ??= {
      id,
      version: STRUCTURED_RECOVERY_VERSION,
      label,
      status: "pending",
      input: structuredClone(baseMessages),
      corrections: 0,
      expansions: 0,
      calls: 0,
      maxCorrections: options.maxCorrections === 2 ? 2 : 1,
      outputBudget: requestOutput(tokens, budget),
    });
    if (step.status === "succeeded") {
      const value = validate(parseStructured(state.fragments[step.rawKey]));
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
        value = validate(parseStructured(response.text));
      } catch (error) {
        const detail = validationReason(error);
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
