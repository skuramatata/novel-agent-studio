import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerDefaults } from "./catalog.mjs";
import { modelCapabilities, validateLimits } from "./model-capabilities.mjs";
export { providerDefaults } from "./catalog.mjs";
export function authorizedEnvPath({ packaged = false, dataDir } = {}) {
  return (
    process.env.NOVEL_AGENT_ENV ||
    (packaged
      ? join(dataDir, ".env")
      : fileURLToPath(new URL("../../.env", import.meta.url)))
  );
}
export async function readAuthorizedEnv(path = authorizedEnvPath()) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of contents.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return {
    glm: {
      ...providerDefaults.glm,
      model: /^glm-/i.test(env.MAIN_MODEL || "")
        ? env.MAIN_MODEL
        : providerDefaults.glm.model,
      apiKey: env.ZAI_CODING_CN_API_KEY || "",
    },
    minimax: { ...providerDefaults.minimax, apiKey: env.MINIMAX_API_KEY || "" },
  };
}
export function validateProvider(c) {
  if (c.limits !== undefined) validateLimits(c.limits);
  const hosts =
    c.provider === "glm"
      ? ["open.bigmodel.cn"]
      : c.provider === "minimax"
        ? ["api.minimaxi.com", "api.minimax.cn", "api.minimax.io"]
        : [];
  const url = new URL(c.baseUrl);
  if (
    url.protocol !== "https:" ||
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请使用该供应商的官方 HTTPS 接口。");
  if (
    c.provider === "glm" &&
    url.pathname.replace(/\/$/, "") !== "/api/coding/paas/v4"
  )
    throw new Error("此原型仅使用 GLM Coding Plan 入口，不自动切换按量计费。");
  if (c.provider === "minimax" && url.pathname.replace(/\/$/, "") !== "/v1")
    throw new Error("MiniMax 接口路径应为 /v1。");
  if (
    !c.model ||
    !(c.provider === "glm" ? /^glm-/i : /^MiniMax-/i).test(c.model)
  )
    throw new Error("模型名称须属于选中的 GLM 或 MiniMax 系列。");
  return c;
}
export async function complete(
  config,
  messages,
  signal,
  fetcher = fetch,
  maxTokens = 8000,
  options = {},
) {
  validateProvider(config);
  if (!config.apiKey) throw new Error("尚未配置此供应商的 API Key。");
  const response = await fetcher(
    config.baseUrl.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        [modelCapabilities(config).outputParameter]: Math.min(
          maxTokens,
          modelCapabilities(config).maxOutputTokens,
        ),
        ...(config.provider === "minimax"
          ? {
              reasoning_split: true,
              ...(/^MiniMax-M3/i.test(config.model)
                ? {
                    thinking: {
                      type: options.reasoning ? "adaptive" : "disabled",
                    },
                  }
                : {}),
            }
          : {
              thinking: { type: options.reasoning ? "enabled" : "disabled" },
              ...(options.reasoning && /^glm-5\.2/i.test(config.model)
                ? { reasoning_effort: "high" }
                : {}),
            }),
      }),
    },
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const code = String(errorBody?.error?.code || errorBody?.code || "");
    const message = String(
      errorBody?.error?.message || errorBody?.message || "",
    );
    if (
      /context_length|context_window|maximum context|上下文|输入.*token.*超/i.test(
        code + " " + message,
      )
    )
      throw Object.assign(
        Error(
          "供应商拒绝了本次上下文长度。请核对当前模型及接口的预算配置；草稿与检查点保留，未自动切换模型或计费入口。",
        ),
        { code: "REMOTE_CONTEXT_LIMIT", providerCode: code },
      );
    throw new Error(
      `模型接口返回 HTTP ${response.status}。请检查套餐密钥、模型权限或额度；未切换其他计费入口。`,
    );
  }
  const data = await response.json();
  if (data.base_resp && data.base_resp.status_code !== 0)
    throw new Error(
      `MiniMax 业务错误 ${data.base_resp.status_code}，请检查密钥与套餐权限。`,
    );
  if (data.error)
    throw new Error("模型接口返回业务错误，请检查模型与套餐权限。");
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const result = {
    text:
      typeof content === "string"
        ? content.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
        : "",
    usage: data.usage ?? null,
    model: data.model || config.model,
    finishReason: choice?.finish_reason || "unknown",
  };
  // length 可能只消耗了思考额度，正文为空；仍保留结束原因与实际用量。
  if (result.finishReason === "length") {
    if (options.allowPartial) return result;
    const error = Error("输出达到上限，候选未完成。任务进度已保留。");
    error.code = "OUTPUT_LIMIT";
    error.outputBudget = maxTokens;
    error.result = result;
    throw error;
  }
  if (!result.text) throw new Error("模型未返回有效正文。");
  return result;
}
