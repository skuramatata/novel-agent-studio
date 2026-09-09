import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import {
  modelCapabilities,
  contextLimit,
  inputLimit,
} from "./model-capabilities.mjs";

// 应用自己的请求预算，不宣称等于 GLM / MiniMax 的模型窗口。
export const CONTEXT_LIMIT = 60000;
const DEFAULT_FACTOR = 1.25;
const PROFILE_VERSION = "o200k-base-v1";
const plainTextOptions = { disallowedSpecial: new Set() };
const messageCounts = new WeakMap();

export function createBudgetProfile(config = {}, previous) {
  const key = JSON.stringify([
    config.provider,
    config.model,
    config.baseUrl,
    config.reasoning === true,
  ]);
  const reusable =
    previous?.version === PROFILE_VERSION &&
    (previous.key === key ||
      (!config.reasoning &&
        previous.key ===
          JSON.stringify([config.provider, config.model, config.baseUrl]))) &&
    Number.isFinite(previous.factor) &&
    previous.factor >= DEFAULT_FACTOR &&
    Number.isSafeInteger(previous.samples) &&
    previous.samples >= 0;
  return {
    version: PROFILE_VERSION,
    key,
    factor: reusable ? previous.factor : DEFAULT_FACTOR,
    samples: reusable ? previous.samples : 0,
    capabilities: modelCapabilities(config),
  };
}

// 只数 messages 中的正文一次。特殊标记按普通文本计数，不赋予协议含义。
export function baseTokens(messages) {
  let total = 512;
  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "");
    let cached = messageCounts.get(message);
    if (cached?.content !== content) {
      cached = { content, count: countTokens(content, plainTextOptions) };
      messageCounts.set(message, cached);
    }
    total += 64 + cached.count;
  }
  return total;
}

// 本地 BPE 代理估算 + 至少 25% 余量，不冒充供应商 tokenizer。
export function estimatedTokens(messages, profile) {
  return Math.ceil(baseTokens(messages) * (profile?.factor ?? DEFAULT_FACTOR));
}

// 同一供应商、模型、入口的实际 usage 只能提高余量，不能靠几次低用量放宽预算。
export function observeTokenUsage(profile, messages, usage) {
  const actual = usage?.prompt_tokens;
  if (!Number.isSafeInteger(actual) || actual <= 0) return;
  profile.factor = Math.max(
    profile.factor,
    Math.ceil((actual / baseTokens(messages)) * 1.15 * 100) / 100,
  );
  profile.samples++;
}

export function ensureBudget(messages, output = 4000, profile) {
  if (!Number.isSafeInteger(output) || output < 0)
    throw new Error("输出预算必须为非负整数。");
  const input = estimatedTokens(messages, profile);
  const limit = contextLimit(profile);
  if (output > (profile?.capabilities?.maxOutputTokens ?? Infinity))
    throw Object.assign(Error("本次输出预留超过当前模型配置的输出上限。"), {
      code: "OUTPUT_BUDGET",
      outputBudget: output,
    });
  if (input > inputLimit(profile, output)) {
    const error = Error(
      `必需材料超过当前模型预算：本地BPE估算${input}（含安全余量，非供应商实际Token），输出预留${output}，有效上下文${limit}，输入上限${inputLimit(profile, output)}。已保留草稿和证据，需拆分本次处理范围。`,
    );
    error.code = "CONTEXT_BUDGET";
    error.inputEstimate = input;
    error.outputBudget = output;
    error.limit = limit;
    throw error;
  }
  return input;
}
