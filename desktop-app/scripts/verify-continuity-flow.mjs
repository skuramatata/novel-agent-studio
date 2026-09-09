// 在隔离作品中运行真实逐章流程，覆盖场景时间规划、提取、回查、专项审稿与候选。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { blankProject } from "../runtime/seed.mjs";
import { projectSchema } from "../runtime/schema.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { readAuthorizedEnv } from "../runtime/providers.mjs";

const out = resolve("verification/continuity-v1/flow");
await mkdir(out, { recursive: true });
const project = blankProject();
Object.assign(project.premise, {
  title: "连续性验证样本",
  genre: "现实题材",
  setting: "公历2026年春天的一座灯塔",
  theme: "认真核对交接",
  narrator: "第三人称限知 · 成诚",
  chapterCount: 2,
  chapterWords: 1200,
});
project.plan = {
  outline: "成诚到岛接班，次日清点遗物和补记交接日志。",
  truth: "没有隐藏真相，遗物是成诚自己摆放的。",
  timeline: "公历2026年3月12日到岛；3月13日清点自己前一天搬的棉袄。",
  reveals: "两章只写清点与登记，不增加秘密或新往事。",
};
project.characters = [
  {
    id: "cheng",
    name: "成诚",
    role: "the-lighthouse-keeper",
    goal: "核实交接",
    secret: "无",
    voice: "平实谨慎",
    position: { x: 0, y: 0 },
  },
];
project.chapters = [
  {
    id: "arrival",
    number: 1,
    title: "到岛",
    summary: "到岛并搬放遗物",
    content:
      "公历2026年3月12日，成诚到岛。他把到岗日期写进日志首页。\n\n成诚把老葛的棉袄从二层搬到底层储物间，放在铁架底层。那件棉袄没有包裹，也没有封条。\n\n当天晚饭前，他决定明天把棉袄的数量和存放位置补记进日志。",
  },
  {
    id: "inventory",
    number: 2,
    title: "登记",
    summary:
      "三月十三日上午，成诚查看自己昨天搬到储物间的棉袄，核对其数量和存放位置，完成补记后回到二层。当天上午结束。",
    content: "",
  },
];
projectSchema.parse(project);
const before = structuredClone(project);
const config = (await readAuthorizedEnv()).glm;
if (!config?.apiKey) throw Error("缺少既有授权模型配置");
const checkpoint = new Checkpoint(out);
const previous = await checkpoint.read();
const decision = process.argv.includes("--resolve")
  ? {
      taskId: previous.id,
      pendingId: previous.pendingReview.id,
      choices: previous.pendingReview.issues.map((issue) => ({
        issueId: issue.id,
        optionId: "custom",
        instruction:
          "这是隔离验证作品的明确事实取舍：以第一章为准，三月十二只写了到岗日期，没有记棉袄情况。收回本章关于昨日记下棉袄、三行日志和昨日犹豫的无出处往事断言，保留昨日搬放及今天核对、补记的行动。日期、数量和存放位置依照第一章和本章规划，不新增其他往事。",
      })),
    }
  : undefined;
const state = await checkpoint.begin(
  project,
  {
    chapterId: "inventory",
    words: 1200,
    resume: process.argv.includes("--resume") || !!decision,
    decision,
    instruction:
      "起草第2章1200字。按三月十三日上午的章纲完成清点和登记，依据第一章实际搬放经过，人物可用实际行动检查物件，不凭空补写过去。",
  },
  config,
);
await writeFile(
  join(out, "project.before.json"),
  JSON.stringify(project, null, 2),
);
await writeFile(join(out, "task.before.json"), JSON.stringify(state, null, 2));
const calls = [];
try {
  const result = await runChapterAgent(
    project,
    config,
    AbortSignal.timeout(600000),
    (label) => console.log(label),
    checkpoint,
    state,
    async (url, init) => {
      if (calls.length >= 18)
        throw Error("隔离验证达到18次模型调用上限，保留检查点。");
      const request = JSON.parse(init.body);
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([init.signal, AbortSignal.timeout(180000)]),
      });
      calls.push({
        stage: state.stage,
        request,
        response: await response.clone().json(),
      });
      await writeFile(
        join(out, "requests.json"),
        JSON.stringify(calls, null, 2),
        { mode: 0o600 },
      );
      return response;
    },
  );
  assert.deepEqual(project, before);
  assert.equal(result.proposal.chapters[0].content, before.chapters[0].content);
  assert.ok(
    state.values["scene-plan"].scenes.every(
      (s) => s.time?.start && s.time?.end,
    ),
  );
  assert.ok(
    state.continuityEvidence.sources.some((s) =>
      s.text.includes("成诚把老葛的棉袄"),
    ),
  );
  assert.equal(state.paragraphReview.latestReview.continuityChecks.length, 3);
  assert.ok(
    result.proposal.memory.entries.every((e) => e.continuityVersion === 1),
  );
  const report = {
    passed: true,
    simulatedAuthorDecision: !!decision,
    calls: calls.length,
    stages: calls.map((r) => r.stage),
    plan: state.values["scene-plan"],
    review: state.paragraphReview.latestReview,
    summary: result.proposal.summary,
  };
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      calls: calls.length,
      summary: report.summary,
    }),
  );
} catch (error) {
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      {
        passed: false,
        error: error.message,
        status: state.status,
        stage: state.stage,
        calls: calls.length,
      },
      null,
      2,
    ),
  );
  console.error(error.message);
  process.exitCode = 1;
}
