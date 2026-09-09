// 只使用 verification 中的第三章快照；不写正式作品、不回答作者问题或采纳。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditContinuity,
  reviewDocument,
} from "../runtime/paragraph-review.mjs";
import { contextFor } from "../runtime/memory.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import { parseStructured } from "../runtime/structured.mjs";
import { createStructuredAsker } from "../runtime/structured-step.mjs";
import { complete, readAuthorizedEnv } from "../runtime/providers.mjs";

const root = resolve("verification/review-protocol");
const live = process.argv.includes("--live");
const read = async (file) =>
  JSON.parse(await readFile(join(root, file), "utf8"));
const write = async (file, value) =>
  writeFile(join(root, file), JSON.stringify(value, null, 2), { mode: 0o600 });
await mkdir(root, { recursive: true });
const before = await read("chapter-task.before.json"),
  project = await read("project.before.json");
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
};
const profile = createBudgetProfile(config, before.tokenBudget);
const chapter = project.chapters.find((c) => c.id === before.chapterId);
const { context } = contextFor(
  project,
  chapter,
  before.request.instruction,
  project.memory.entries,
  { continuity: true, profile, retrieved: before.retrievedContext },
);
Object.assign(context, {
  continuitySources: before.continuityEvidence.sources,
  continuityCoverage: before.continuityEvidence.coverage,
  sceneTimes: before.values["scene-plan"].scenes.map((s, i) => ({
    scene: i + 1,
    ...s.time,
  })),
});
const doc = reviewDocument(before.paragraphReview.inputScenes, context);
assert.equal(
  doc.version,
  before.paragraphReview.cycle.documentVersion,
  "必须使用故障发生时同一份原文",
);
let captured;
const stop = Error("已捕获第一批，验证不执行整章审稿");
await assert.rejects(
  auditContinuity({
    doc,
    context,
    profile,
    ledger: before.paragraphReview.cycle.continuityLedger,
    ask: async (key, messages, validate, tokens, label, options) => {
      captured = { key, messages, validate, tokens, label, options };
      throw stop;
    },
  }),
  (e) => e === stop,
);
await write("input.json", { ...captured, validate: undefined });
const baseline = await import(
  pathToFileURL(join(root, "baseline/runtime/paragraph-review.mjs"))
);
const report = {
  documentVersion: doc.version,
  scope: "第三章故障原文的一批专项审稿；未执行整章修订和采纳",
  syntaxErrors: [],
  sourceFailures: [],
  calls: 0,
};
for (const [key, text] of Object.entries(before.fragments)) {
  if (!key.startsWith("raw:bounded-review")) continue;
  let value;
  try {
    value = parseStructured(text);
  } catch (error) {
    report.syntaxErrors.push({
      key,
      detail: error.message,
      finishReason: before.responseMeta[key]?.finishReason,
    });
    continue;
  }
}
// 在旧版真正发出该响应的分批范围上对照，不能用别批材料冒充原输入。
try {
  await baseline.auditContinuity({
    doc,
    context,
    profile,
    ledger: before.paragraphReview.cycle.continuityLedger,
    ask: async (batchKey, messages, validate) => {
      const supplied = JSON.parse(messages[1].content).document;
      const view = {
        ...doc,
        sources: doc.sources.flatMap((s) => {
          const source = supplied.sources.find(
            (p) => p.sourceId === s.sourceId,
          );
          return source
            ? [
                {
                  ...s,
                  paragraphs: s.paragraphs.filter((p) =>
                    source.paragraphs.some((row) => row[0] === p.paragraph),
                  ),
                },
              ]
            : [];
        }),
      };
      for (const [key, raw] of Object.entries(before.fragments)) {
        if (!key.startsWith(`raw:${batchKey}:`)) continue;
        let value;
        try {
          value = parseStructured(raw);
        } catch {
          continue;
        }
        try {
          validate(value);
        } catch (error) {
          if (!error.message.includes("全部已提供来源")) continue;
          try {
            const modern = await auditContinuity({
              doc: view,
              context,
              ledger: before.paragraphReview.cycle.continuityLedger,
              ask: async (_, __, check) => check(value),
            });
            report.sourceFailures.push({
              key,
              batchKey,
              oldError: error.message,
              issuesRetained: modern.issues.length,
            });
          } catch {
            /* 存在其他真实错误，仍不能放行。 */
          }
        }
      }
      if (!Object.hasOwn(before.values, batchKey)) throw stop;
      return before.values[batchKey];
    },
  });
} catch (error) {
  if (error !== stop) throw error;
}

assert.ok(report.syntaxErrors.length);
assert.ok(
  report.sourceFailures.length,
  "至少一个真实响应只因漏抄范围失败，新协议保留原问题后通过",
);
let state = {
  id: "isolated-review",
  status: "running",
  values: {},
  fragments: {},
};
const save = async () => write("replay-state.json", state);
let calls = 0;
const bad =
  before.fragments[
    report.syntaxErrors.find((r) => r.detail.includes("1378"))?.key ||
      report.syntaxErrors[0].key
  ];
const call = async () => {
  calls++;
  return { text: bad, finishReason: "stop" };
};
const run = (ask, retry = 0) =>
  ask(
    `${captured.key}:workflow-1:retry-${retry}`,
    captured.messages,
    captured.validate,
    captured.tokens,
    captured.label,
    captured.options,
  );
await assert.rejects(
  run(createStructuredAsker({ state, budget: profile, call, save })),
  /预算已用尽/,
);
state = await read("replay-state.json");
for (const retry of [1, 2, 3])
  await assert.rejects(
    run(createStructuredAsker({ state, budget: profile, call, save }), retry),
    /预算已用尽/,
  );
assert.equal(calls, 3);
report.replay = {
  calls,
  additionalCallsAfterThreeRestarts: 0,
  acceptedInvalidResults: Object.keys(state.values).length,
};
await write("replay-report.json", report);
console.log(JSON.stringify(report));
if (live) {
  config.apiKey = (await readAuthorizedEnv())[config.provider]?.apiKey;
  assert.ok(config.apiKey, "未找到已配置的原供应商密钥");
  state = {
    id: "isolated-live-review",
    status: "running",
    values: {},
    fragments: {},
  };
  const requests = [];
  const liveSave = async () => write("live-state.json", state);
  const liveCall = async (messages, tokens) => {
    const record = { messages, tokens };
    requests.push(record);
    await write("live-requests.json", requests);
    console.log(
      JSON.stringify({ call: requests.length, stage: captured.label }),
    );
    const response = await complete(
      config,
      messages,
      AbortSignal.timeout(120000),
      fetch,
      tokens,
      { allowPartial: true },
    );
    record.response = response;
    await write("live-requests.json", requests);
    return response;
  };
  try {
    const result = await run(
      createStructuredAsker({
        state,
        budget: profile,
        call: liveCall,
        save: liveSave,
      }),
    );
    assert.ok(result.dimensions, "新模型响应须使用单一问题来源格式");
    state = await read("live-state.json");
    await run(
      createStructuredAsker({
        state,
        budget: profile,
        call: async () => {
          throw Error("成功批次不能再调用模型");
        },
        save: liveSave,
      }),
      4,
    );
    report.live = {
      passed: true,
      calls: requests.length,
      dimensions: result.dimensions.map((d) => ({
        dimension: d.dimension,
        verdict: d.verdict,
        issues: d.issues?.length || 0,
      })),
      replayCalls: 0,
    };
  } catch (error) {
    report.live = {
      passed: false,
      calls: requests.length,
      error: error.message,
    };
    process.exitCode = 1;
  }
  await write("live-report.json", report);
  console.log(JSON.stringify(report.live));
}
