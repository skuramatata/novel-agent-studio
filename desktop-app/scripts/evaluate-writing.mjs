import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runAgent, PROMPT_VERSION } from "../runtime/agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { projectSchema } from "../runtime/schema.mjs";
import { countWords } from "../runtime/writing.mjs";
const [
  input,
  output,
  provider = "minimax",
  request = "将这篇短篇整体扩写修订到8000字，保持3章。改善人物动机、行动与后果、连续性和伏笔兑现，保留作者风格与既定真相。",
] = process.argv.slice(2);
if (!input || !output)
  throw Error(
    "用法：node scripts/evaluate-writing.mjs 输入JSON 输出目录 [minimax|glm] [请求]",
  );
if (!["glm", "minimax"].includes(provider))
  throw Error("供应商只能为glm或minimax");
const raw = await readFile(resolve(input), "utf8");
const project = projectSchema.parse(JSON.parse(raw));
const configs = await readAuthorizedEnv();
const config = configs[provider];
if (!config?.apiKey)
  throw Error("授权配置中缺少所选模型密钥，未调用其他供应商。");
const out = resolve(output);
await mkdir(out, { recursive: true });
const save = (file, data) =>
  writeFile(join(out, file), JSON.stringify(data, null, 2), { mode: 0o600 });
await save("input.json", project);
const started = Date.now();
const runtimeHashes = Object.fromEntries(
  await Promise.all(
    [
      "agent.mjs",
      "writing.mjs",
      "horror.mjs",
      "providers.mjs",
      "schema.mjs",
      "structured.mjs",
    ].map(async (name) => [
      name,
      createHash("sha256")
        .update(await readFile(new URL(`../runtime/${name}`, import.meta.url)))
        .digest("hex"),
    ]),
  ),
);
const meta = {
  runtimeHashes,
  reasoning: process.env.NOVEL_AGENT_REASONING === "1",
  promptVersion: PROMPT_VERSION,
  provider,
  model: config.model,
  inputSha256: createHash("sha256").update(raw).digest("hex"),
  request,
  at: new Date().toISOString(),
  baselineWords: project.chapters.map((c) => ({
    id: c.id,
    words: countWords(c.content),
  })),
};
const replayDirectory = process.env.NOVEL_AGENT_REPLAY_DIR;
const replayStages = new Map(),
  replayDrafts = new Map();
let stage = "",
  liveCalls = 0,
  replayCalls = 0;
if (replayDirectory) {
  const previous = JSON.parse(
    await readFile(join(replayDirectory, "input.json"), "utf8"),
  );
  const report = JSON.parse(
    await readFile(join(replayDirectory, "report.json"), "utf8"),
  );
  if (
    JSON.stringify(previous) !== JSON.stringify(project) ||
    report.provider !== provider ||
    report.model !== config.model ||
    report.request !== request
  )
    throw Error("重放只允许同一输入作品、请求与模型的已保存阶段。");
  const files = (await readdir(replayDirectory))
    .filter((f) => /^stage-\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)));
  for (const file of files) {
    const item = JSON.parse(
      await readFile(join(replayDirectory, file), "utf8"),
    );
    if (
      ["确定写作范围与字数", "规划场景、人物选择与连续性"].includes(item.stage)
    )
      replayStages.set(
        item.stage,
        item.stage === "确定写作范围与字数"
          ? Object.fromEntries(
              Object.entries(item.value).filter(([key]) => key !== "targets"),
            )
          : item.value,
      );
    if (item.stage === "修正场景因果与动机")
      replayStages.set("规划场景、人物选择与连续性", item.value);
    if (
      /^(起草|修订)第/.test(item.stage) &&
      !item.stage.includes("原始输出") &&
      item.value.chapterId
    )
      replayDrafts.set(item.value.chapterId, item.value);
  }
}
const fetcher = async (url, init) => {
  let cached = replayStages.get(stage);
  const match = stage.match(/^起草第(\d+)章/);
  if (match)
    cached = replayDrafts.get(
      project.chapters.find((c) => c.number === Number(match[1]))?.id,
    );
  if (cached) {
    replayStages.delete(stage);
    if (match) replayDrafts.delete(cached.chapterId);
    replayCalls++;
    await save(`replay-${replayCalls}.json`, {
      source: resolve(replayDirectory),
      stage,
      value: cached,
    });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(cached) },
            finish_reason: "stop",
          },
        ],
        model: config.model,
      }),
    );
  }
  liveCalls++;
  return fetch(url, init);
};
try {
  const result = await runAgent(
    project,
    request,
    config,
    undefined,
    (text) => {
      stage = text;
      console.log(text);
    },
    fetcher,
    {
      reasoning: process.env.NOVEL_AGENT_REASONING === "1",
      onArtifact: (artifact) =>
        save(`stage-${artifact.sequence}.json`, artifact),
    },
  );
  await save("result.json", result);
  await writeFile(
    join(out, "candidate.md"),
    result.proposal.chapters
      .map((c) => `## ${c.number}. ${c.title}\n\n${c.content}`)
      .join("\n\n"),
  );
  await save("report.json", {
    ...meta,
    replayDirectory: replayDirectory || null,
    liveCalls,
    replayCalls,
    status: "completed",
    durationMs: Date.now() - started,
    calls: result.calls,
    usages: result.usages,
    summary: result.proposal.summary,
  });
  console.log(result.proposal.summary);
} catch (e) {
  await save("report.json", {
    ...meta,
    replayDirectory: replayDirectory || null,
    liveCalls,
    replayCalls,
    status: "failed",
    durationMs: Date.now() - started,
    error: e.message,
    details: e.details,
  });
  console.error(e.message);
  process.exitCode = 1;
}
