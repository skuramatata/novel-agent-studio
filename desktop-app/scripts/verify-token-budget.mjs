// 从现有第五章检查点组装真实形状请求；默认离线，--live 仅实测首个记忆片段。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import {
  contextFor,
  indexChapter,
  modelWritingContext,
} from "../runtime/memory.mjs";
import { reviewAndPatch } from "../runtime/paragraph-review.mjs";
import {
  estimatedTokens,
  baseTokens,
  ensureBudget,
  createBudgetProfile,
  observeTokenUsage,
} from "../runtime/model-budget.mjs";
import {
  parseStructured,
  structuredRetryMessages,
} from "../runtime/structured.mjs";
import { readAuthorizedEnv, complete } from "../runtime/providers.mjs";

const out = resolve("verification/token-budget-v2");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const fixture = resolve("verification/context-budget-fix");
const project = await read(join(fixture, "project.before.json"));
const before = await read(join(fixture, "chapter-task.before.json"));
const completed = await read(join(fixture, "live/chapter-task.json"));
const original = JSON.stringify(project);
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
  apiKey: "offline-only",
};
const samples = [];
const captured = Error("已捕获离线请求");
const capture = (sample) => {
  samples.push(sample);
  throw captured;
};
const offline = async (run) => {
  const count = samples.length;
  try {
    await run();
  } catch (error) {
    if (samples.length !== count + 1 || error.message !== captured.message)
      throw error;
  }
};
const started = Date.now();
await offline(() =>
  runChapterAgent(
    project,
    config,
    new AbortController().signal,
    () => {},
    { write: async () => {} },
    structuredClone(before),
    async (_url, init) => {
      const request = JSON.parse(init.body);
      capture({
        stage: "writing",
        messages: request.messages,
        output: request.max_tokens,
      });
    },
  ),
);
const chapter = project.chapters.find((c) => c.id === before.chapterId);
const { context } = contextFor(
  project,
  chapter,
  before.request.instruction,
  project.memory.entries,
);
const scenes = completed.values["scene-plan"].scenes.map((_, i) => ({
  scene: i + 1,
  content: completed.values[`final-scene:${i}`],
}));
await offline(() =>
  reviewAndPatch({
    scenes,
    context,
    state: {},
    save: async () => {},
    signal: new AbortController().signal,
    minWords: 4500,
    maxWords: 5750,
    ask: async (_key, messages, validate, output) =>
      capture({ stage: "review", messages, validate, output }),
  }),
);
await offline(() =>
  indexChapter(
    project,
    { ...chapter, content: scenes.map((s) => s.content).join("\n\n") },
    async (_key, messages, validate, output) =>
      capture({ stage: "memory", messages, validate, output }),
  ),
);
assert.equal(samples.length, 3);
assert.equal(JSON.stringify(project), original);

const { estimatedTokens: legacyEstimate } =
  await import("../verification/token-budget-v2/before/runtime/model-budget.mjs");
const { fitWritingContext: legacyFit } =
  await import("../verification/token-budget-v2/before/runtime/context-budget.mjs");
const report = {
  status: "passed",
  offline: [],
  assemblyMs: Date.now() - started,
};
for (const sample of samples) {
  ensureBudget(sample.messages, sample.output);
  const data = JSON.parse(sample.messages[1].content);
  let oldMessages = structuredClone(sample.messages);
  if (sample.stage === "writing") {
    const originalData = {
      ...data,
      ...modelWritingContext(context, {
        recentChapterId: data.recentChapterId,
      }),
    };
    delete originalData.historyCoverage;
    oldMessages[1].content = JSON.stringify(originalData);
    oldMessages = legacyFit(oldMessages, sample.output).messages;
  }
  if (sample.stage === "memory") {
    assert.ok(!Object.hasOwn(data, "source"));
    const source = data.sources.map((s) => s.text).join("");
    assert.ok(
      scenes
        .map((s) => s.content)
        .join("\n\n")
        .startsWith(source),
    );
    oldMessages[1].content = JSON.stringify({ ...data, source });
    // 还原修改前提示词，避免把本版新增的字段约束混入旧基线。
    const oldCode = await readFile(
      join(out, "before/runtime/memory.mjs"),
      "utf8",
    );
    oldMessages[0].content = oldCode.match(
      /content: `(从提供的小说原文抽取[^`]+)`/,
    )[1];
  }
  const currentBase = baseTokens(sample.messages);
  const oldBase = baseTokens(oldMessages);
  report.offline.push({
    stage: sample.stage,
    oldInputEstimate: legacyEstimate(oldMessages),
    newInputEstimate: estimatedTokens(sample.messages),
    outputBudget: sample.output,
    oldBpeWithMessagePadding: oldBase,
    newBpeWithMessagePadding: currentBase,
    inputBpeChangePercent: Number(
      ((currentBase / oldBase - 1) * 100).toFixed(1),
    ),
    ...(data.historyCoverage
      ? {
          selectedRecords: data.historyCoverage.includedRecords,
          totalRecords: data.historyCoverage.totalRecords,
        }
      : {}),
  });
}

await mkdir(out, { recursive: true });
await writeFile(
  join(out, "request-samples.json"),
  JSON.stringify(samples, null, 2),
);
await writeFile(
  join(out, "offline-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));

if (process.argv.includes("--live")) {
  const authorized = (await readAuthorizedEnv()).glm;
  if (!authorized?.apiKey) throw Error("缺少既有 GLM 配置");
  // 使用检查点的同一官方 Coding Plan 模型；不切换入口。
  const liveConfig = {
    ...authorized,
    model: before.model,
    baseUrl: before.baseUrl,
  };
  const budget = createBudgetProfile(liveConfig);
  const sample = samples.find((s) => s.stage === "memory");
  let messages = sample.messages;
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const inputEstimate = ensureBudget(messages, sample.output, budget);
    const response = await complete(
      liveConfig,
      messages,
      AbortSignal.timeout(120000),
      fetch,
      sample.output,
    );
    observeTokenUsage(budget, messages, response.usage);
    const attempt = {
      inputEstimate,
      usage: response.usage,
      finishReason: response.finishReason,
      text: response.text,
    };
    attempts.push(attempt);
    await writeFile(
      join(out, "live-memory-attempts.json"),
      JSON.stringify(attempts, null, 2),
    );
    try {
      const result = sample.validate(parseStructured(response.text));
      const liveReport = {
        status: "passed",
        requestedModel: liveConfig.model,
        model: response.model,
        calls: attempts.length,
        inputEstimate,
        actualInputTokens: response.usage?.prompt_tokens,
        records: result.records.length,
        allQuotesValidated: true,
        originalTextSentOnce: true,
        budget,
      };
      await writeFile(
        join(out, "live-memory-report.json"),
        JSON.stringify(liveReport, null, 2),
      );
      console.log(JSON.stringify(liveReport, null, 2));
      break;
    } catch (error) {
      if (i) throw error;
      messages = structuredRetryMessages(
        messages,
        response.text,
        error,
        sample.output,
        budget,
      );
    }
  }
}
