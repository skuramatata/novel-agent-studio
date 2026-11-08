// E2E 模型替身（仅 app.isPackaged === false 且 NOVEL_E2E_MODEL_STUB 指向本文件时生效）。
// 职责：
//   1. 把每次请求正文写入 JSONL，供报告断言"请求是否携带历史事件 id 与原文"；
//   2. 按请求所处的业务阶段返回**符合该阶段契约**的 JSON，让真实 runChapterAgent 能继续。
// 红线：只在本文件内伪造模型输出；不联网、不回落真实 fetch。
import { appendFileSync } from "node:fs";

const LOG = process.env.NOVEL_E2E_FETCH_LOG || "/tmp/novel-e2e-fetch.jsonl";
// 写作正文按调用序号递增，避免"续写重复已有结尾"（产品会拒绝与已有结尾相同的续写）。
let proseCounter = 0;

function systemText(body) {
  try {
    const parsed = JSON.parse(body);
    return (parsed.messages || [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
  } catch {
    return "";
  }
}

function userText(body) {
  try {
    const parsed = JSON.parse(body);
    return (parsed.messages || [])
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
  } catch {
    return "";
  }
}

function firstSentence(text) {
  const m = String(text || "").match(/[\u4e00-\u9fa5][^。！？\n]{4,40}[。！？]/);
  return m ? m[0] : "";
}

// 各阶段返回值的构造：顺序即优先级，靠 system prompt 关键字识别。
function buildByStage(sys, usr) {
  // 章节任务意图（mode/targetIds/scopeEvidence 等）
  if (sys.includes("targetIds") || /确定章节任务|章节任务/.test(sys)) {
    const evidence = firstSentence(usr) || String(usr).slice(0, 20);
    // targetIds 必须是作品里**真实存在**的章节 ID，从 user payload 的 chapters 读取；
    // 取第一个尚无正文的章（没有就取最后一章），符合"起草空白新章"的验收场景。
    let targetIds = [];
    let chapterWords = null;
    let mode = "draft";
    let scope = evidence;
    try {
      const payload = JSON.parse(usr);
      const chapters = payload.chapters || [];
      // 产品规则：draft 模式不允许改已有正文（chapter-agent.mjs:380）。
      // 有 words>0 的章视为已有正文 → 用 revise，并让 scopeEvidence 逐字取自作者请求
      // （revise 要求 instruction.includes(scopeEvidence)）。
      const blank = chapters.find((c) => !c.words || Number(c.words) === 0);
      if (blank) {
        targetIds = [blank.id];
      } else if (chapters.length) {
        targetIds = [chapters[chapters.length - 1].id];
        mode = "revise";
        scope = String(payload.instruction || evidence).trim();
      }
      if (payload.instruction) {
        const m = payload.instruction.match(/(\d+)\s*字/);
        if (m) chapterWords = Number(m[1]);
      }
    } catch {}
    return {
      mode,
      targetIds,
      totalWords: null,
      chapterWords,
      scopeEvidence: scope,
      explanation: "E2E 替身：按作者请求起草一章。",
    };
  }
  // 记忆整理（必须在事件抽取之前判，避免被宽泛关键字抢先）
  if (/抽取有出处的记忆|记忆/.test(sys)) {
    const quote = firstSentence(usr);
    return {
      summary: "E2E 替身：本章记忆摘要",
      records: quote
        ? [
            {
              kind: "event",
              text: quote.slice(0, 120),
              entities: [],
              storyTime: "",
              knownBy: [],
              epistemic: "observed",
              quote,
              continuity: {
                assertion: "narration",
                actor: "",
                action: "",
                object: "",
                before: "",
                after: "",
                evidenceForm: "unknown",
                time: null,
              },
            },
          ]
        : [],
    };
  }
  // 事件抽取
  if (/抽取故事事件|story-events|events 最多/.test(sys)) {
    const quote = firstSentence(usr);
    void 0;
    if (!quote) return { summary: "E2E 替身：无可用引文", events: [], relations: [] };
    // 返回两条相关事件 + 一条显式关系：预览验收要求"跨章边"这个硬证据，
    // 只有单事件时 edges 恒为 0（产品不会凭空生成关系）。
    // 区间必须相对**当前分片的正文文本**（sources[].text），
    // 而不是整个 JSON payload——否则 start/end 会错位。
    let partText = usr;
    try {
      const payload = JSON.parse(usr);
      const src = (payload.sources || [])[0];
      if (src && typeof src.text === "string") partText = src.text;
    } catch {}
    const afterFirst = partText.indexOf(quote) + quote.length;
    const rest = partText.slice(afterFirst);
    const secondRel = rest.search(/[\u4e00-\u9fa5][^。！？\n]{3,40}[。！？]/);
    const second = secondRel >= 0
      ? rest.slice(secondRel, secondRel + (rest.slice(secondRel).match(/^[^。！？\n]*[。！？]/) || [""])[0].length)
      : "";
    const secondStart = secondRel >= 0 ? afterFirst + secondRel : 0;
    return {
      summary: "E2E 替身：按契约返回两条可核事件与一条显式关系",
      events: [
        {
          title: quote.slice(0, 16),
          summary: "替身为验收生成的事件（引文逐字来自请求原文）",
          kind: "action",
          actors: [],
          objects: ["铜扣"],
          basis: "narration",
          storyTime: "",
          start: 0,
          end: quote.length,
          quote,
        },
        ...(second
          ? [
              {
                title: second.slice(0, 16),
                summary: "替身为验收生成的后续事件",
                kind: "state-change",
                actors: [],
                objects: ["铜扣"],
                basis: "narration",
                storyTime: "",
                start: secondStart,
                end: secondStart + second.length,
                quote: second,
              },
            ]
          : []),
      ],
      relations: second ? [
        {
          sourceId: 1,
          targetId: 2,
          type: "causal",
          basis: "explicit",
          explanation: "前后事件由同一物件铜扣承接，前事为后事前提。",
          evidenceSourceId: 1,
        },
      ] : [],
    };
  }
  // 规划意图
  if (/prepare|legacy|chapterCount/.test(sys))
    return {
      mode: "prepare",
      chapterCount: 2,
      chapterWords: 1200,
      countEvidence: "两章",
      wordsEvidence: "1200字",
    };
  // 场景规划（必须精确：写作提示词里也含"场景"字样，不能误吞）
  // 真实提示词形如：`为当前章设计恰好N个连续场景…只输出JSON：{"scenes":[...]}`
  if (/设计恰好\d*\s*个连续场景|只输出JSON：\{"scenes"/.test(sys)) {
    // 场景数量必须等于产品要求的数量（提示词："为当前章设计恰好N个连续场景"，
    // 产品在数量不符时抛「必须规划N个场景」）。
    const want = Number((sys.match(/设计恰好\s*(\d+)\s*个连续场景/) || [])[1] || 1);
    const count = Number.isInteger(want) && want > 0 ? want : 1;
    return {
      scenes: Array.from({ length: count }, (_, i) => ({
        goal: `按替身脚本推进本章目标（场景 ${i + 1}/${count}）`,
        knowledge: "无额外知识",
        time: {
          start: i === 0 ? "当日清晨" : `第${i}段之后`,
          gap: "稍后",
          duration: "约一小时",
          end: "当日上午稍后",
        },
      })),
    };
  }
  // 统计类问题：直接给一个可读对象
  // 专项审稿：产品对 time/state/evidence 三个维度**各发一次独立请求**，
  // 每次只允许返回该维度的一条结论（paragraph-review.mjs 的 dimensionContracts
  // 要求 dimensions.length === 1 且 dimension 必须匹配当前维度 literal）。
  // 漏一个维度会被判「专项漏列问题」→ 进入待作者裁定 → 生成不产出候选。
  // 只有带「本轮仅执行<维度>专项审稿」的请求才是专项格式（dimensions）；
  // 其余带证据审稿请求仍要求顶层 issues 数组，二者不能混为一谈。
  if (/本轮仅执行[^\n]*审稿/.test(sys)) {
    const dimension = sys.includes("时间顺序")
      ? "time"
      : sys.includes("人物与物件状态")
        ? "state"
        : "evidence";
    return {
      dimensions: [
        {
          dimension,
          verdict: "not_applicable",
          evidence: [],
          explanation: "E2E 替身：本次样本不涉及该维度的可判定事项。",
          // 该 verdict 分支只允许 dimension/verdict/evidence/explanation；
          // 只有 verdict==="issues" 时才允许 dimensions[].issues（见 paragraph-review.mjs:164-175）。
        },
      ],
      authorChecks: [],
      // 专项格式不得再带顶层 issues/continuityChecks（会报"含未声明字段"）。
    };
  }
  // 普通带证据审稿：要求顶层 issues 数组（缺失会报
  // "issues: Invalid input: expected array, received undefined"）。
  if (/审稿员|带证据的审稿|issues/.test(sys))
    return { issues: [], authorChecks: [], priorFindings: [] };
  return null;
}

export default async function fetchStub(url, init) {
  let body = "";
  try {
    body = typeof init?.body === "string" ? init.body : "";
  } catch {}
  appendFileSync(LOG, JSON.stringify({ url: String(url), body }) + "\n");

  const sys = systemText(body);
  const usr = userText(body);
  const staged = buildByStage(sys, usr);

  // 结构化调用要求输出 JSON；非结构化（正文起草）返回中文正文。
  let payload;
  if (staged) {
    payload = staged;
  } else {
    proseCounter += 1;
    // 每次生成使用独立句子与唯一收尾，确保不与任何已有正文结尾相同
    //（产品会拒绝 text.endsWith(next) 的"续写重复"）。
    const n = proseCounter;
    const uniq = `${process.hrtime.bigint()}-${n}`;
    // 目标 1200 字（产品允许 700—1700）：每句 ~38 字 × 32 句 ≈ 1216。
    const sentences = Array.from({ length: 32 }, (_, i) =>
      `轮${n}句${i + 1}号${uniq}：林遥把铜钥匙贴近灯下，划痕在光里忽深忽浅，潮气顺着舷窗渗进来。`,
    ).join("");
    payload = `${sentences}\n收尾标记${uniq}〈场景完成〉`;
  }

  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: typeof payload === "string" ? payload : JSON.stringify(payload),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
