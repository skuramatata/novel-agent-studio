// 请求记录器：包装模型适配接缝，记录每次请求里是否含历史事件/原文引文。
// 纯逻辑，可独立单测；不依赖 Electron、不发网络请求。
// 本文件是 CommonJS（.cjs），与主脚本 verify-story-events.cjs 保持一致。
const SEV_ID = /sev-[0-9a-f]{12}/g;
const SEE_ID = /see-[0-9a-f]{12}/g;

function collectMatches(text, re) {
  const found = text.match(re);
  return found ? [...new Set(found)] : [];
}

// 从一次请求的 payload（任意可 JSON 序列化的结构）提取可判定字段。
function inspectPayload(payload, { quotes = [] } = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const historicalIds = [
    ...new Set([...collectMatches(text, SEV_ID), ...collectMatches(text, SEE_ID)]),
  ];
  const matchedQuotes = quotes.filter((q) => typeof q === "string" && q && text.includes(q));
  return {
    hasHistoricalEventIds: historicalIds.length > 0,
    historicalIds,
    hasQuotes: matchedQuotes.length > 0,
    matchedQuotes,
    userPayloadSize: text.length,
  };
}

// 创建记录器：每次 record 累积一条，报告里全量输出。
function createRequestRecorder() {
  const entries = [];
  const counters = new Map();

  const record = ({ caseId, stage, payload, quotes = [], historyCoverage = null }) => {
    const key = caseId || "unscoped";
    const callIndex = (counters.get(key) ?? 0) + 1;
    counters.set(key, callIndex);
    const inspected = inspectPayload(payload, { quotes });
    const entry = {
      caseId,
      callIndex,
      stage,
      ...inspected,
      historyCoverage:
        historyCoverage ?? (inspected.hasHistoricalEventIds ? null : "未声明覆盖说明"),
    };
    entries.push(entry);
    return entry;
  };

  const list = () => entries.map((e) => ({ ...e }));
  const forCase = (caseId) => entries.filter((e) => e.caseId === caseId).map((e) => ({ ...e }));
  const reset = () => {
    entries.length = 0;
    counters.clear();
  };

  // 包装一个 ask(promptKey, messages) 风格的桩，自动记录并透传返回值。
  const wrap = (ask, { caseId, stage, quotes, quotesOf } = {}) => async (
    promptKey,
    messages,
    ...rest
  ) => {
    const resolved =
      typeof quotesOf === "function" ? quotesOf({ promptKey, messages }) : quotes || [];
    record({
      caseId,
      stage,
      payload: messages ?? promptKey,
      quotes: resolved,
    });
    return ask(promptKey, messages, ...rest);
  };

  return { record, list, forCase, reset, wrap };
}

module.exports = { inspectPayload, createRequestRecorder, SEV_ID, SEE_ID };

// ── 偏移防线 ─────────────────────────────────────────────────────────
// 夹具 evidence 一律由本函数生成，禁止手写数字偏移。
function buildEvidence(chapters, chapterId, quote) {
  const chapter = chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error(`夹具引用了不存在的章节：${chapterId}`);
  const start = chapter.content.indexOf(quote);
  if (start < 0) throw new Error(`引文不在第 ${chapterId} 章正文中：${quote}`);
  return { chapterId, start, end: start + quote.length, quote };
}

// 启动自检：用真实 runtime 的 normalizeEvidence 校验每条夹具 evidence。
// 任何错位都在这里暴露，避免"改夹具后假通过"。
async function selfCheckEvidence(chapters, evidences) {
  const { normalizeEvidence } = await import("../runtime/story-events.mjs");
  const failures = [];
  for (const item of evidences) {
    let built;
    try {
      built =
        item.start === undefined
          ? buildEvidence(chapters, item.chapterId, item.quote)
          : { chapterId: item.chapterId, start: item.start, end: item.end, quote: item.quote };
    } catch (error) {
      failures.push({
        chapterId: item.chapterId,
        quote: item.quote,
        reason: error.message,
      });
      continue;
    }
    const normalized = normalizeEvidence(built, chapters);
    if (!normalized) {
      failures.push({
        chapterId: item.chapterId,
        quote: item.quote,
        reason: `normalizeEvidence 拒绝了该 evidence（区间与引文不匹配，或引文不在第 ${item.chapterId} 章正文中）`,
      });
    }
  }
  return { ok: failures.length === 0, checked: evidences.length, failures };
}

module.exports.buildEvidence = buildEvidence;
module.exports.selfCheckEvidence = selfCheckEvidence;
