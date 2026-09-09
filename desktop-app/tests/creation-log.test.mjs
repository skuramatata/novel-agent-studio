import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendCreationEvent,
  captureCheckpointLog,
  taskEvents,
  readCreationLogs,
  stageCategory,
} from "../runtime/creation-log.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { blankProject } from "../runtime/seed.mjs";
import { messageSchema } from "../runtime/schema.mjs";
const project = () => ({ chapters: [], messages: [] });
const state = (id = "task") => ({
  id,
  status: "running",
  stage: "起草",
  calls: 0,
  values: {},
  request: { instruction: "写第一章" },
  usages: [],
});

test("检查点重复保存不重复记日志，场景修订、失败和恢复保留顺序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-log-"));
  try {
    const cp = new Checkpoint(dir),
      p = blankProject(),
      config = { provider: "glm", model: "m", baseUrl: "u" };
    const s = await cp.begin(p, { instruction: "开始" }, config);
    const first = s.creationLog.events.length;
    await cp.write(s);
    assert.equal(s.creationLog.events.length, first);
    s.values["final-scene:0"] = "他抵达灯塔。";
    await cp.write(s);
    s.values["final-scene:0"] = "他夜里抵达灯塔。";
    await cp.write(s);
    s.status = "failed";
    s.error = "模拟断网";
    await cp.write(s);
    const resumed = await cp.begin(p, { resume: true }, config);
    const events = resumed.creationLog.events;
    assert.equal(
      events.filter((e) => e.title.includes("正文已保存")).length,
      1,
    );
    assert.equal(
      events.filter((e) => e.title.includes("修订已保存")).length,
      1,
    );
    assert.ok(events.some((e) => e.details.原因 === "模拟断网"));
    assert.ok(events.some((e) => e.title === "恢复已有任务"));
    assert.deepEqual((await cp.read()).creationLog, resumed.creationLog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("日志详情只包含明确提供字段，常见凭据字符串被隐藏", () => {
  const s = state();
  appendCreationEvent(s, {
    title: "请求失败",
    details: { 原因: "Bearer secret123 api_key=private123", 耗时毫秒: 10 },
  });
  assert.doesNotMatch(JSON.stringify(s.creationLog), /secret123|private123/);
  assert.equal(s.creationLog.events[0].details.耗时毫秒, 10);
  assert.equal(stageCategory("整理第 1 章记忆"), "memory");
  assert.equal(stageCategory("起草第 1 章 · 场景 1/5"), "writing");
});
test("历史修订可查看前后对照，旧数据不补造时间", () => {
  const s = state();
  s.values["final-scene:0"] = "正文";
  s.paragraphReview = {
    commits: [
      {
        findings: [{ explanation: "干湿冲突" }],
        changes: [
          {
            sourceId: "scene:1",
            paragraph: 2,
            before: "湿的",
            replacement: "干的",
          },
        ],
      },
    ],
  };
  const old = taskEvents(s, project());
  assert.ok(old.every((e) => e.at === null));
  assert.match(
    old.find((e) => e.id === "patch-0").details.修订对照,
    /修改前：湿的\n修改后：干的/,
  );
  captureCheckpointLog(s);
  assert.equal(s.creationLog.legacy, true);
  assert.equal(
    s.creationLog.events.find((e) => e.category === "writing").at,
    null,
  );
});
test("采纳和放弃按任务关联，讨论回复不冒充作品采纳", () => {
  const s = state(),
    p = project();
  const base = {
    role: "assistant",
    text: "结果",
    createdAt: "2026-09-08T10:00:00.000Z",
    handledAt: "2026-09-08T10:01:00.000Z",
    taskId: "task",
    status: "accepted",
  };
  p.messages = [
    messageSchema.parse({ ...base, id: "a", proposal: { summary: "讨论" } }),
    messageSchema.parse({
      ...base,
      id: "b",
      proposal: { summary: "正文", chapters: [] },
    }),
    messageSchema.parse({
      ...base,
      id: "c",
      taskId: "another",
      proposal: { summary: "其他作品候选", chapters: [] },
    }),
  ];
  let events = taskEvents(s, p);
  assert.equal(events.filter((e) => e.title === "候选已采纳到作品").length, 1);
  assert.ok(events.some((e) => e.title === "讨论回复已保存"));
  assert.ok(!events.some((e) => e.id === "candidate-c"));
  p.messages[1].status = "rejected";
  events = taskEvents(s, p);
  assert.equal(events.find((e) => e.id === "handled-b").title, "候选已放弃");
});
test("日志跨历史任务读取，筛选搜索覆盖全部事件，读取不会修改原文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-history-log-"));
  try {
    await mkdir(join(dir, "task-history"));
    const s = state();
    for (let i = 0; i < 230; i++)
      appendCreationEvent(s, {
        category: i === 0 ? "review" : "writing",
        status: i === 0 ? "failed" : "success",
        title: i === 0 ? "最早的校验失败" : `场景${i}`,
      });
    const raw = JSON.stringify(s);
    await writeFile(join(dir, "task-history/task.json"), raw);
    await writeFile(
      join(dir, "chapter-task.json"),
      JSON.stringify(state("current")),
    );
    const view = await readCreationLogs(dir, project(), { taskId: "task" });
    assert.equal(view.events.length, 200);
    assert.equal(view.hasMoreEvents, true);
    const filtered = await readCreationLogs(dir, project(), {
      taskId: "task",
      query: "最早",
      onlyProblems: true,
      category: "review",
    });
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].title, "最早的校验失败");
    assert.equal(
      (await readCreationLogs(dir, project(), { taskId: "task", limit: 400 }))
        .events.length,
      230,
    );
    assert.equal(
      await readFile(join(dir, "task-history/task.json"), "utf8"),
      raw,
    );
    await assert.rejects(
      () => readCreationLogs(dir, project(), { taskId: "../task" }),
      /无效/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("损坏历史任务单独报告，不阻止有效任务展示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-broken-log-"));
  try {
    await mkdir(join(dir, "task-history"));
    await writeFile(join(dir, "chapter-task.json"), JSON.stringify(state()));
    await writeFile(join(dir, "task-history/broken.json"), "bad json");
    const view = await readCreationLogs(dir, project());
    assert.equal(view.selected.id, "task");
    assert.equal(view.selected.status, "interrupted");
    assert.equal(
      (await readCreationLogs(dir, project(), {}, true)).selected.status,
      "running",
    );
    assert.equal(view.warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
