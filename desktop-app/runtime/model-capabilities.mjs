// 能力记录与应用策略分开；未核实的入口/输出上限明确使用保守回退。
export const CAPABILITY_VERSION = "model-capabilities-1";
const defaults = {
  contextWindow: 60000,
  maxOutputTokens: 24000,
  appContextCap: 60000,
  maxInputTokens: null,
  endpointContextLimit: null,
};
const catalog = {
  "glm:glm-5.3": {
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    appContextCap: 120000,
    source: "https://docs.z.ai/guides/llm/glm-5.3",
    confidence: "官方模型规格；当前套餐入口上限未单独核实",
    checkedAt: "2026-09-10",
  },
  "glm:glm-5.2": {
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    appContextCap: 120000,
    source: "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2",
    confidence: "官方模型规格；当前套餐入口上限未单独核实",
  },
  "minimax:MiniMax-M3": {
    contextWindow: 512000,
    maxOutputTokens: 24000,
    appContextCap: 120000,
    source: "https://www.minimax.io/models/text/m3",
    confidence: "采用官方最低512K窗口；输出使用24000保守回退",
  },
  "minimax:MiniMax-M2.7": {
    contextWindow: 204800,
    maxOutputTokens: 24000,
    appContextCap: 100000,
    source: "https://platform.minimaxi.com/docs/api-reference/api-overview",
    confidence: "官方上下文；输出使用24000保守回退",
  },
  "minimax:MiniMax-M2.5": {
    contextWindow: 204800,
    maxOutputTokens: 24000,
    appContextCap: 100000,
    source: "https://platform.minimaxi.com/docs/api-reference/api-overview",
    confidence: "官方上下文；输出使用24000保守回退",
  },
};
export const LIMIT_FIELDS = Object.keys(defaults);
export function capabilityKey(config) {
  return JSON.stringify([
    config.provider,
    String(config.baseUrl || "").replace(/\/$/, ""),
    config.model,
    config.reasoning === true,
  ]);
}
export function validateLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("模型预算配置无效。");
  const result = {};
  for (const key of Object.keys(value)) {
    if (!LIMIT_FIELDS.includes(key)) throw Error(`未知预算字段：${key}`);
    const n = value[key];
    if (n === null || n === undefined) continue;
    if (
      !Number.isSafeInteger(n) ||
      n < (key === "maxOutputTokens" ? 256 : 4096) ||
      n > 2000000
    )
      throw Error(`预算 ${key} 需要为有效整数字段。`);
    result[key] = n;
  }
  return result;
}
export function modelCapabilities(config = {}) {
  const known = catalog[`${config.provider}:${config.model}`];
  // 设置与精确入口/模型绑定，编辑模型名称后不会继承另一模型的覆盖值。
  const override =
    config.limitKey === capabilityKey(config)
      ? validateLimits(config.limits)
      : {};
  const limits = { ...defaults, ...known, ...override };
  const contextLimit = Math.min(
    limits.contextWindow,
    limits.endpointContextLimit ?? Infinity,
    limits.appContextCap,
  );
  return {
    ...limits,
    contextLimit,
    maxInputTokens:
      limits.maxInputTokens === null
        ? null
        : Math.min(limits.maxInputTokens, contextLimit),
    source: known?.source || "",
    confidence: Object.keys(override).length
      ? "使用当前模型与入口的自定义配置"
      : known?.confidence ||
        "未知模型：60000上下文与24000输出保守回退，可按接口文档设置",
    checkedAt: known?.checkedAt || (known ? "2026-09-09" : null),
    outputParameter:
      config.provider === "minimax" ? "max_completion_tokens" : "max_tokens",
    version: CAPABILITY_VERSION,
  };
}

export function requestOutput(desired, profile) {
  return Math.min(desired, profile?.capabilities?.maxOutputTokens ?? Infinity);
}
export function contextLimit(profile) {
  return profile?.capabilities?.contextLimit ?? 60000;
}
export function inputLimit(profile, output = 0) {
  return Math.min(
    profile?.capabilities?.maxInputTokens ?? Infinity,
    contextLimit(profile) - output,
  );
}
// 各阶段软额度允许拆分；总量最终仍由 ensureBudget 核对。
export function stageInputLimit(profile, output, stage = "review") {
  const soft =
    {
      review: 22000,
      continuity: 22000,
      grounding: 16000,
      patch: 14000,
      verify: 16000,
      arbitrate: 16000,
    }[stage] ?? 22000;
  return Math.min(soft, inputLimit(profile, output) - 1600);
}
