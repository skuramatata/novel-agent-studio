/** SSE 只在完整结束后交付正文；思考内容仅计数，不写入作品。 */
export async function readCompletionStream(response, signal, onDelta) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("模型流式响应为空。");
  const decoder = new TextDecoder();
  let buffer = "",
    text = "",
    finishReason = null,
    usage = null,
    model;
  let done = false;
  const consume = (frame) => {
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) return;
    if (payload.trim() === "[DONE]") {
      done = true;
      return;
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      throw Error("模型流式响应格式异常，未采纳不完整结果。");
    }
    if (data.error || (data.base_resp && data.base_resp.status_code !== 0))
      throw Error("模型流式接口返回业务错误，请检查模型与套餐权限。");
    if (data.usage) usage = data.usage;
    if (data.model) model = data.model;
    const choice =
      data.choices?.find((c) => c.index === 0) ?? data.choices?.[0];
    const delta = choice?.delta || {};
    const content = typeof delta.content === "string" ? delta.content : "";
    const reasoning =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : (delta.reasoning_details || [])
            .map((part) => part.text || "")
            .join("");
    text += content;
    onDelta({
      contentChars: [...content].length,
      reasoningChars: [...reasoning].length,
    });
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };
  const drain = () => {
    let match;
    while (!done && (match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consume(frame);
    }
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (!done) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) {
        buffer += decoder.decode();
        drain();
        if (!done && buffer.trim()) consume(buffer);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      drain();
    }
    if (!finishReason)
      throw Error("模型响应中途断流，未采纳不完整结果；可恢复任务重试。");
    return {
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      usage,
      model,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createStreamProgress(emit = () => {}) {
  const started = Date.now();
  let lastData = started,
    phase = "等待模型响应",
    contentChars = 0,
    reasoningChars = 0;
  const report = () => {
    const now = Date.now();
    const quiet = Math.floor((now - lastData) / 1000);
    emit(
      `${phase} · 本次请求 ${Math.floor((now - started) / 1000)} 秒` +
        (reasoningChars ? ` · 思考已接收 ${reasoningChars} 字` : "") +
        (contentChars ? ` · 内容已接收 ${contentChars} 字` : "") +
        (quiet >= 15 ? ` · ${quiet} 秒未收到新内容` : ""),
    );
  };
  report();
  const timer = setInterval(report, 1000);
  timer.unref?.();
  return {
    update(delta) {
      if (!delta.contentChars && !delta.reasoningChars) return;
      const previous = phase;
      contentChars += delta.contentChars;
      reasoningChars += delta.reasoningChars;
      lastData = Date.now();
      phase = delta.contentChars ? "正在生成" : "正在思考";
      if (previous !== phase) report();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
