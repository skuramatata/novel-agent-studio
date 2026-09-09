// 隔离验证：只读用户指定正文，不生成候选、不改作品，不输出密钥。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readAuthorizedEnv, complete } from "../runtime/providers.mjs";
import {
  parseStructured,
  structuredRetryMessages,
} from "../runtime/structured.mjs";
import {
  continuityLedger,
  retrieveContinuitySources,
  timelineChecks,
} from "../runtime/continuity.mjs";
import {
  reviewDocument,
  auditContinuity,
} from "../runtime/paragraph-review.mjs";
import { indexChapter } from "../runtime/memory.mjs";
import { ensureBudget } from "../runtime/model-budget.mjs";

const file = process.argv.find((arg) => arg.endsWith(".md"));
if (!file) throw Error("请传入待验证正文的.md路径，增加--live才调用真实模型。");
const out = resolve("verification/continuity-v1/live");
await mkdir(out, { recursive: true });
const text = await readFile(file, "utf8");
const chapters = [
  ...text.matchAll(
    /^## 第(\d+)章[^\n]*\n([\s\S]*?)(?=^## 第\d+章|$(?![\s\S]))/gm,
  ),
].map((m) => ({
  id: `ch${m[1]}`,
  number: Number(m[1]),
  title: `第${m[1]}章`,
  summary: "",
  content: m[2].trim(),
}));
assert.equal(chapters.length, 7);
const pick = (n, patterns) =>
  chapters[n - 1].content
    .split(/\n\s*\n/)
    .filter((p) => patterns.some((pattern) => pattern.test(p)))
    .join("\n\n");
const cases = [
  {
    id: "arrival",
    name: "日志首页到岗日期漂移",
    number: 6,
    draft: pick(6, [/他上岛，是今年三月初九/, /他又去翻日志/]),
    expected: /初九|十二|日期/,
  },
  {
    id: "elapsed",
    name: "一个月写成三个月",
    number: 4,
    draft: pick(4, [/把三个月的鱼账念/, /^四月十五/]),
    expected: /三个月|一个月|时间|一个多月/,
  },
  {
    id: "actor",
    name: "主角摆放遗物变成老葛藏物证据",
    number: 5,
    draft: pick(5, [/老葛知道这个洞。封存/]),
    expected: /成诚|摆放|搬|主体/,
  },
  {
    id: "transcript",
    name: "誊抄件推断原签名笔迹",
    number: 6,
    draft: pick(6, [
      /回电是海燕号的报务员/,
      /底下还有一行：签收单存根抄件附后/,
      /抄件折成四折/,
      /这回不为对日子/,
      /他先看整体/,
      /抄件上，那个顿/,
      /伪造的怕不像/,
    ]),
    expected: /誊|抄|笔迹|签名/,
  },
  {
    id: "intentional",
    name: "有明确对照的档案异常应保留",
    number: 2,
    history: [
      {
        id: "ch1",
        number: 1,
        content: "成诚在日志首页写下：三月十二日，到岗。",
      },
    ],
    draft:
      "他收到一份调令抄件，上面记载他去年腊月十六就接了塔。\n\n他打开自己的日志，三月十二日，到岗，仍是自己亲手写下的那一行。他把两份记录并排放着：差了几个月。他确定自己三月才来，档案却坚持他腊月已经到了。那张纸到底替谁办的交接？",
    expected: null,
  },
  {
    id: "facsimile",
    name: "原签名照片与誊抄件分别使用应保留",
    number: 1,
    history: [],
    draft:
      "段里寄来签收单的誊抄件，另附原件照片。\n\n他把誊抄件放到一边，只用照片比对签名的笔迹。照片足够清晰，末笔的顿挫落在他熟悉的位置。他只能确定照片上的字与自己的习惯相似，仍不能证明是谁签的。",
    expected: null,
  },
];
const only = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",");
const selectedCases = only
  ? cases.filter((item) => only.includes(item.id))
  : cases;
const live = process.argv.includes("--live");
const config = live ? (await readAuthorizedEnv()).glm : null;
if (live && !config?.apiKey) throw Error("缺少既有授权模型配置。");

function requester(id) {
  let calls = 0;
  return async (key, messages, validate, tokens, label) => {
    let error = null,
      previous = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent =
        attempt && error
          ? structuredRetryMessages(messages, previous, error, tokens)
          : messages;
      const record = {
        key,
        label,
        messages: sent,
        tokens,
        inputEstimate: ensureBudget(sent, tokens),
      };
      const path = join(out, `${id}-${++calls}.json`);
      await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
      if (!live) return null;
      const result = await complete(
        config,
        sent,
        AbortSignal.timeout(180000),
        fetch,
        tokens,
        { allowPartial: true },
      );
      record.response = result;
      previous = result.text;
      await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
      if (result.finishReason === "length") {
        tokens = Math.min(tokens * 2, 26000);
        error = null;
        continue;
      }
      try {
        return validate(parseStructured(result.text));
      } catch (e) {
        error = e;
      }
    }
    throw error || Error("三次调用后仍未取得完整可校验结果");
  };
}

const results = [];
// 每次最多两个独立样本，避免并发修改同一份检查点或作品。
for (let i = 0; i < selectedCases.length; i += 2) {
  const batch = await Promise.allSettled(
    selectedCases.slice(i, i + 2).map(async (item) => {
      console.log(`核对：${item.name}`);
      const retrieved = retrieveContinuitySources(
        item.history ?? chapters,
        item.number,
        item.draft,
      );
      const context = {
        instruction: "只检查给定候选的时间与事实问题，历史原文只读。",
        continuity: continuityLedger([]),
        continuitySources: retrieved.sources,
        continuityCoverage: retrieved.coverage,
      };
      const doc = reviewDocument([{ scene: 1, content: item.draft }], context);
      const review = await auditContinuity({
        doc,
        context,
        ask: requester(item.id),
      });
      const blocking = review?.issues.filter((issue) => issue.blocking) || [];
      const passed = !live
        ? null
        : item.expected
          ? blocking.some((issue) =>
              item.expected.test(issue.explanation + issue.fix),
            )
          : blocking.length === 0;
      const result = {
        id: item.id,
        name: item.name,
        passed,
        coverage: retrieved.coverage,
        review,
      };
      await writeFile(
        join(out, `${item.id}-result.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(
        `${item.name}：${passed === null ? "仅生成请求" : passed ? "通过" : "未通过"}`,
      );
      return result;
    }),
  );
  for (const [offset, result] of batch.entries())
    results.push(
      result.status === "fulfilled"
        ? result.value
        : {
            id: selectedCases[i + offset].id,
            passed: false,
            error: result.reason.message,
          },
    );
  await writeFile(
    join(out, only ? `results-${only.join("-")}.json` : "results.json"),
    JSON.stringify(results, null, 2),
  );
}

if (live && !only) {
  const content =
    "公历2026年3月12日，成诚到岛。\n\n公历2026年5月11日，成诚在日志里误写：距三月十二到岛已经九十天。";
  const chapter = { id: "calendar", number: 1, content };
  const entries = await indexChapter(
    { chapters: [chapter] },
    chapter,
    requester("extraction"),
    { continuity: true },
  );
  const records = entries.flatMap((e) => e.records);
  const calculations = timelineChecks(records);
  const result = {
    id: "extraction",
    passed: records.every((r) => r.continuity && content.includes(r.quote)),
    records,
    calculations,
  };
  results.push(result);
  await writeFile(
    join(out, only ? `results-${only.join("-")}.json` : "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    `结构化提取：${result.passed ? "通过" : "未通过"}，时间算术提示${calculations.length}条`,
  );
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

assert.equal(await readFile(file, "utf8"), text, "验证不能改动输入正文");
if (live && results.some((r) => !r.passed)) process.exitCode = 1;
