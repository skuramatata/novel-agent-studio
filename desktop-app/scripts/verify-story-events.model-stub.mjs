// E2E 模型替身（仅非打包环境生效，见 electron/model-transport.mjs）。
// 记录每次请求正文到 JSONL，供报告断言"请求是否携带历史事件 id 与原文"；
// 返回符合抽取契约的合法 JSON，使真实 runChapterAgent 能继续往下走。
import { appendFileSync } from "node:fs";

const LOG = process.env.NOVEL_E2E_FETCH_LOG || "/tmp/novel-e2e-fetch.jsonl";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 从请求体里找出原文分片，抽一句可逐字引用的 quote。
function extractChunk(body) {
  try {
    const parsed = JSON.parse(body);
    const messages = parsed.messages || [];
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    return user;
  } catch {
    return "";
  }
}

// 阶段判定必须看**全部消息**：关键指令在 system（messages[0]），
// 只看 user 内容会漏判，导致场景规划阶段收到抽取用的 JSON。
function fullText(body) {
  try {
    const parsed = JSON.parse(body);
    return (parsed.messages || []).map((m) => m.content || "").join("\n");
  } catch {
    return "";
  }
}

function sentenceOf(text) {
  const cleaned = String(text || "").replace(/\\n/g, "\n");
  const matches = cleaned.match(/[\u4e00-\u9fa5][^。！？\n]{4,40}[。！？]/g);
  return matches && matches.length ? matches[0] : "";
}

// 按请求里的系统提示判断当前处于哪个业务阶段，返回该阶段契约要求的 JSON。
// 只覆盖链路验收会用到的阶段；未知阶段仍返回抽取结构，并由用例记录失败。
function stageOf(text) {
  if (text.includes("识别规划入口")) return "planning_intent";
  if (text.includes("为当前章设计恰好")) return "scene_plan";
  if (text.includes("仅写当前场景")) return "scene_write";
  // 三维专项审稿：只要求本维度一条结论，且必须给 evidence 才能判 consistent。
  if (text.includes("时间顺序专项审稿")) return "review_time";
  if (text.includes("人物与物件状态审稿")) return "review_state";
  if (text.includes("证据与推断专项审稿")) return "review_evidence";
  if (text.includes("小说连续性与文学审稿员")) return "review_general";
  // 故事事件抽取优先于记忆抽取：事件契约要求 events，记忆契约要求 records，
  // 两者提示词都含"抽取"，必须先判事件，避免把事件请求当记忆处理。
  if (text.includes("抽取故事事件")) return "story_events";
  if (text.includes("从提供的小说原文抽取") || text.includes('"records"'))
    return "memory_extract";
  return "story_events";
}

function scenesReply(text) {
  const m = text.match(/恰好(\d+)个连续场景/);
  const count = m ? Math.max(1, Math.min(8, Number(m[1]))) : 1;
  return {
    scenes: Array.from({ length: count }, (_, i) => ({
      goal: `第${i + 1}场：推进本章主线`,
      knowledge: "仅使用本章此前已交代的信息",
      time: { start: "当日上午", gap: "承接上一场", duration: "约一小时", end: "当日上午稍后" },
    })),
  };
}

// 写足篇幅的场景正文：产品按汉字数校验整章区间，替身不能只写一句。
function sceneProse() {
  const sentence =
    "林遥在舱底停下脚步，听见水声里夹着金属碰撞的轻响，随即把灯压低了一寸。";
  const target = 1300;
  let out = "";
  while (out.length < target) out += sentence;
  return out.slice(0, target) + "\n〈场景完成〉";
}

// 三维专项审稿与综合审稿的最小合法响应：无问题、本维度判 not_applicable。
// not_applicable 允许空 evidence，因此不会因为"缺依据"被拒。
function reviewReply(stage) {
  const dimension =
    stage === "review_time" ? "time" : stage === "review_state" ? "state" : "evidence";
  if (stage === "review_general") return { issues: [], authorChecks: [] };
  return {
    dimensions: [
      {
        dimension,
        verdict: "not_applicable",
        evidence: [],
        explanation: "E2E 替身：本次样本不涉及该维度的可判定事项。",
      },
    ],
    authorChecks: [],
  };
}

function buildReply(body) {
  const text = extractChunk(body);
  const stage = stageOf(fullText(body));
  if (stage === "planning_intent")
    return { mode: "legacy", chapterCount: null, chapterWords: null, countEvidence: "", wordsEvidence: "" };
  // 场景数写在 system 提示里，必须用 fullText，不能只用 user 内容。
  if (stage === "scene_plan") return scenesReply(fullText(body));
  if (stage === "memory_extract")
    // 记忆契约要求 summary + records；records 可空，表示本段无可抽取记录。
    return { summary: "E2E 替身：本段无可抽取记忆", records: [] };
  if (stage.startsWith("review_"))
    return reviewReply(stage);
  if (stage === "scene_write") return null; // 正文按纯文本返回，见下游分支
  const quote = sentenceOf(text);
  const base = {
    summary: "E2E 替身：按契约返回一条可核事件",
    events: [],
    relations: [],
  };
  if (!quote) return base;
  base.events.push({
    title: quote.slice(0, 16),
    summary: "替身为验收生成的事件（引文逐字来自请求原文）",
    kind: "action",
    actors: [],
    objects: [],
    basis: "narration",
    storyTime: "",
    start: 0,
    end: quote.length,
    quote,
  });
  return base;
}

export default async function fetchStub(url, init) {
  let body = "";
  try {
    body = typeof init?.body === "string" ? init.body : "";
  } catch {}
  appendFileSync(LOG, JSON.stringify({ url: String(url), body }) + "\n");
  const stage = stageOf(fullText(body));
  // 写作阶段要求纯文本正文并以〈场景完成〉收尾，不能返回 JSON。
  // 写作阶段要满足整章字数区间（脚本请求约 1200 字/场，产品按允许区间校验）。
  // 替身必须写足篇幅，否则链路会真实地停在"篇幅调整"而不是验证修订链路。
  const content =
    stage === "scene_write"
      ? sceneProse()
      : JSON.stringify(buildReply(body));
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
