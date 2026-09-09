import { jsonrepair } from "jsonrepair";
import { estimatedTokens, CONTEXT_LIMIT } from "./model-budget.mjs";
import { inputLimit, contextLimit } from "./model-capabilities.mjs";

export const MAX_STRUCTURED_OUTPUT = 24000;
export function validationReason(error) {
  return error.name === "ZodError"
    ? error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；")
    : error.message;
}
export function largerStructuredOutput(messages, current, profile) {
  return Math.max(
    current,
    Math.min(
      current * 2,
      MAX_STRUCTURED_OUTPUT,
      profile?.capabilities?.maxOutputTokens ?? Infinity,
      contextLimit(profile) - estimatedTokens(messages, profile),
    ),
  );
}

// 保留原始任务与证据。过长的错误输出只留在检查点，不作为伪完整 JSON 截断回传。
export function structuredRetryMessages(
  messages,
  response,
  error,
  output,
  profile,
) {
  const reason = validationReason(error);
  const detail = String(reason).slice(0, 1600);
  const correction = {
    role: "user",
    content: `格式或证据校验失败：${detail}。依据原始任务与提供的原文重新生成完整JSON，不编造缺失证据。${error instanceof SyntaxError ? "上次响应不是合法JSON；从头输出一个完整顶层对象，把字段放在所属对象内，不在闭合对象后追加字段，不续写或拼接多个JSON。不要删除问题或证据来绕过格式校验。" : ""}`,
  };
  // 无法解析的响应不能作为下一轮格式范本，原文仍完整保存在检查点。
  if (error instanceof SyntaxError) return [...messages, correction];
  const attempt = { role: "assistant", content: response };
  const withAttempt = [...messages, attempt, correction];
  if (
    estimatedTokens([attempt], profile) <= 3000 &&
    estimatedTokens(withAttempt, profile) <= inputLimit(profile, output)
  )
    return withAttempt;
  return [
    ...messages,
    {
      ...correction,
      content: `${correction.content} 上次失败响应过长，未附入本次上下文；不要尝试续写该响应。`,
    },
  ];
}

// 只容许为未转义的双引号补反斜杠。绝不补截断正文、逗号、字段或括号。
export function parseStructured(text) {
  const source = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(source);
  } catch (originalError) {
    let repaired;
    try {
      repaired = jsonrepair(source);
    } catch {
      throw originalError;
    }
    let i = 0,
      j = 0;
    while (i < source.length && j < repaired.length) {
      if (source[i] === repaired[j]) {
        i++;
        j++;
      } else if (
        repaired[j] === "\\" &&
        repaired[j + 1] === '"' &&
        source[i] === '"'
      ) {
        j++;
      } else throw originalError;
    }
    if (i !== source.length || j !== repaired.length) throw originalError;
    return JSON.parse(repaired);
  }
}
