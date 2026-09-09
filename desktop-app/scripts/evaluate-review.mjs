import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { complete, readAuthorizedEnv } from "../runtime/providers.mjs";
import { projectSchema } from "../runtime/schema.mjs";
import { parseStructured } from "../runtime/structured.mjs";
import {
  reviewMessages,
  factReviewMessages,
  reviewSchema,
  validateReview,
} from "../runtime/writing.mjs";
import { PROMPT_VERSION } from "../runtime/agent.mjs";

const [input, output, provider = "minimax"] = process.argv.slice(2);
if (!input || !output || !["glm", "minimax"].includes(provider))
  throw Error(
    "用法：node scripts/evaluate-review.mjs 输入作品.json 新输出目录 [minimax|glm]",
  );
const raw = await readFile(resolve(input), "utf8");
const project = projectSchema.parse(JSON.parse(raw));
const configs = await readAuthorizedEnv();
const config = configs[provider];
if (!config?.apiKey) throw Error("所选供应商缺少已授权密钥，未切换供应商。");
const out = resolve(output);
await mkdir(out, { recursive: true });
const save = (name, data) =>
  writeFile(join(out, name), JSON.stringify(data, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
await save("input.json", project);
const instruction =
  "评价全文是否兑现已采纳的题材目标，核对连续性，不改写正文。";
const task = {
  mode: "discuss",
  targetIds: [],
  totalWords: null,
  chapterWords: null,
  scopeEvidence: "",
  explanation: instruction,
};
const report = {
  promptVersion: PROMPT_VERSION,
  provider,
  model: config.model,
  inputSha256: createHash("sha256").update(raw).digest("hex"),
  calls: 0,
  reviews: [],
  status: "running",
};
try {
  for (const [name, messages] of [
    [
      "题材与综合审稿",
      reviewMessages(project, task, null, project.chapters, instruction),
    ],
    ["事实专项", factReviewMessages(project, project.chapters)],
  ]) {
    console.log(name);
    await save(`${name}-请求.json`, messages);
    report.calls++;
    const response = await complete(
      config,
      messages,
      AbortSignal.timeout(180000),
      fetch,
      6500,
    );
    await save(`${name}-原始输出.json`, response);
    const review = validateReview(
      reviewSchema.parse(parseStructured(response.text)),
      project.chapters,
    );
    await save(`${name}.json`, review);
    report.reviews.push({
      name,
      usage: response.usage,
      issues: review.issues.length,
    });
    for (const issue of review.issues)
      console.log(
        `${issue.severity} ${issue.category} ${issue.chapterId}:${issue.paragraph} ${issue.reason}`,
      );
  }
  report.status = "completed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await save("report.json", report);
}
