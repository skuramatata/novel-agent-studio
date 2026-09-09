import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
const p = JSON.parse(await readFile(process.argv[2], "utf8"));
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true });
const instruction = process.argv[4] || "按 12 个章节，每章节 5000 字来";
const provider =
  process.argv
    .slice(5)
    .find((arg) => arg.startsWith("--provider="))
    ?.slice(11) || "glm";
if (!["glm", "minimax"].includes(provider))
  throw Error("供应商只能为glm或minimax");
const config = (await readAuthorizedEnv())[provider];
if (!config?.apiKey) throw Error("授权配置中缺少所选模型密钥。");
const checkpoint = new Checkpoint(out);
const state = await checkpoint.begin(
  p,
  { instruction, resume: process.argv.includes("--resume") },
  config,
);
try {
  const result = await runChapterAgent(
    p,
    config,
    AbortSignal.timeout(8 * 60 * 1000),
    console.log,
    checkpoint,
    state,
  );
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  const report = {
    status: "ready",
    provider,
    model: config.model,
    calls: result.calls,
    chapters: result.proposal.chapters.length,
    chapterWords: result.proposal.premise.chapterWords,
    bodyWords: result.proposal.chapters.reduce(
      (n, c) => n + c.content.length,
      0,
    ),
    nodes: Object.fromEntries(
      Object.entries(state.graphs["planning-v1"].nodes).map(([k, v]) => [
        k,
        v.status,
      ]),
    ),
    note: "真实模型只验证分批章纲；未生成章节正文，未修改正式作品。",
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (e) {
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      { status: "failed", calls: state.calls, error: e.message },
      null,
      2,
    ),
  );
  throw e;
}
