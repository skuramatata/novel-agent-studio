import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal } from "../runtime/schema.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
const out = resolve(process.argv[2] || "verification/chapter-memory-live");
const config = (await readAuthorizedEnv()).glm;
if (!config?.apiKey) throw Error("缺少既有授权模型配置");
const p = applyProposal(blankProject(), demoProposal(), 0);
p.premise.chapterWords = 6000;
const checkpoint = new Checkpoint(out);
await mkdir(out, { recursive: true });
const state = await checkpoint.begin(
  p,
  {
    chapterId: p.chapters[0].id,
    words: 6000,
    instruction:
      "起草第1章6000字，按已采纳章纲推进，保持恐怖氛围，关键人物通过具体行动承受后果。",
    resume: process.argv.includes("--resume"),
  },
  config,
);
const result = await runChapterAgent(
  p,
  config,
  AbortSignal.timeout(14 * 60 * 1000),
  (s) => console.log(s),
  checkpoint,
  state,
);
await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    model: result.model,
    calls: result.calls,
    summary: result.proposal.summary,
  }),
);
