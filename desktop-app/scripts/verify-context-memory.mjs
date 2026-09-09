// 真实本地Embedding + 作品副本预算核查；--live 最多两次真实审稿请求，不采纳。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  StoryVectorIndex,
  localEmbedder,
} from "../runtime/story-retrieval.mjs";
import {
  createBudgetProfile,
  estimatedTokens,
  ensureBudget,
} from "../runtime/model-budget.mjs";
import { contextFor, sourceParts } from "../runtime/memory.mjs";
import {
  reviewAndPatch,
  reviewDocument,
} from "../runtime/paragraph-review.mjs";
import { modelDocument } from "../runtime/review-payload.mjs";
import { complete, readAuthorizedEnv } from "../runtime/providers.mjs";
import {
  parseStructured,
  structuredRetryMessages,
} from "../runtime/structured.mjs";

const input = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!input)
  throw Error("用法：node scripts/verify-context-memory.mjs 作品JSON [--live]");
const raw = await readFile(resolve(input), "utf8");
const project = {
  ...JSON.parse(raw),
  projectId: "isolated-context-memory-verification",
};
const out = resolve("verification/context-memory-v3");
await mkdir(out, { recursive: true });
await writeFile(
  join(out, "project.before.json"),
  JSON.stringify(project, null, 2),
);
const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};
const profile = createBudgetProfile(config);
const embed = localEmbedder(resolve("models"));
const index = new StoryVectorIndex(join(out, "index"), embed);
const started = Date.now();
const stats = await index.sync(project, { progress: console.log });
const target = project.chapters.filter((c) => c.content).at(-1);
const retrieved = await index.search(
  project,
  target.number,
  "核对钥匙保管、送鱼周期、到任时间及此前人物行动",
  { profile, maxTokens: 6000 },
);
assert.ok(retrieved.sources.length);
for (const source of retrieved.sources)
  assert.ok(
    project.chapters
      .find((c) => c.id === source.chapterId)
      .content.includes(source.text),
  );
const instruction = `核对当前第${target.number}章的时间、物件和人物行动，参照第1章原文。`;
const context = contextFor(
  project,
  target,
  instruction,
  project.memory?.entries || [],
  { profile, retrieved },
).context;
const scenes = sourceParts(target.content).map((p, i) => ({
  scene: i + 1,
  content: p.text,
}));
const doc = reviewDocument(scenes, context);
const requests = [],
  live = process.argv.includes("--live"),
  state = {};
let liveRequests = 0;
const realConfig = live ? (await readAuthorizedEnv()).glm : null;
let liveResult;
try {
  await reviewAndPatch({
    scenes,
    context,
    profile,
    state,
    save: async () => {},
    signal: AbortSignal.timeout(180000),
    ask: async (key, messages, validate, output, label) => {
      ensureBudget(messages, output, profile);
      requests.push({
        label,
        inputEstimate: estimatedTokens(messages, profile),
        output,
        sourceCount: JSON.parse(messages[1].content).document?.sources.length,
      });
      if (live && liveRequests === 0) {
        let current = messages;
        for (let attempt = 0; attempt < 2; attempt++) {
          liveRequests++;
          const response = await complete(
            realConfig,
            current,
            AbortSignal.timeout(120000),
            fetch,
            output,
            { allowPartial: true },
          );
          await writeFile(
            join(out, `live-review-${attempt + 1}.json`),
            JSON.stringify({ messages: current, response }, null, 2),
          );
          try {
            assert.equal(response.finishReason, "stop");
            const value = validate(parseStructured(response.text));
            liveResult = {
              status: "validated",
              usage: response.usage,
              responseModel: response.model,
              issues: value.issues?.length,
            };
            break;
          } catch (error) {
            if (attempt) throw error;
            current = structuredRetryMessages(
              messages,
              response.text,
              error,
              output,
              profile,
            );
            ensureBudget(current, output, profile);
          }
        }
        // 真实调用只验证本批协议，后续离线覆盖不冒充整章质量评测。
      }
      return validate({ issues: [], priorFindings: [], authorChecks: [] });
    },
  });
  const [a, b, c] = await embed([
    "他将铜钥匙交给守塔人。",
    "钥匙由谁保管？",
    "海面今晚刮起大风。",
  ]);
  const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0);
  assert.ok(dot(a, b) > dot(a, c));
  const report = {
    status: "passed",
    scope:
      "本地真实向量推理；审稿覆盖与预算离线核查，真实模型仅验证第一批，不采纳",
    durationMs: Date.now() - started,
    index: stats,
    retrieval: retrieved.coverage,
    semantic: { related: dot(a, b), unrelated: dot(a, c) },
    fullDocumentEstimate: estimatedTokens(
      [
        {
          role: "user",
          content: JSON.stringify(
            modelDocument(doc, { explicitSentences: true }),
          ),
        },
      ],
      profile,
    ),
    requests,
    reviewCoverage: state.reviewCoverage,
    liveRequests,
    liveResult,
  };
  assert.equal(await readFile(resolve(input), "utf8"), raw);
  await writeFile(
    join(out, "verification-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  index.close();
}
