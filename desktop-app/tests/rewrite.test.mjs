import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectLibrary } from "../runtime/library.mjs";
import { demoProposal } from "../runtime/seed.mjs";
import { applyProposal, readyForChapter } from "../runtime/schema.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { rewriteInstruction } from "../runtime/rewrite-plan.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "novel-rewrite-"));
  try {
    const lib = new ProjectLibrary(dir);
    const empty = await lib.load();
    const p = applyProposal(empty, demoProposal(), empty.revision);
    p.chapters[0].content = "旧正文中的独有事件，不得污染下一轮。";
    p.memory = {
      version: 1,
      entries: [
        {
          chapterId: p.chapters[0].id,
          sourceHash: "old",
          part: 0,
          sourceStart: 0,
          sourceEnd: 1,
          sourceText: p.chapters[0].content,
          summary: "旧事件摘要",
          records: [],
        },
      ],
    };
    p.writingSettings = { wordTolerance: { mode: "percent", value: 12 } };
    p.messages = [
      {
        id: "old-candidate",
        role: "assistant",
        text: "旧候选",
        status: "pending",
        baseRevision: 1,
        proposal: { summary: "旧方案" },
      },
    ];
    const old = await lib.save(
      { ...p, projectId: empty.projectId },
      empty.revision,
    );
    await fn({ dir, lib, old });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("全书重写保留设定和身份，先备份全部旧稿，运行与检索目录跨重启隔离", () =>
  fixture(async ({ dir, lib, old }) => {
    const originalRun = await lib.runtimeDirectoryFor(old.projectId);
    const task = { id: "old-task", status: "completed", draft: "旧任务" };
    await writeFile(
      join(originalRun, "chapter-task.json"),
      JSON.stringify(task),
    );
    const next = await lib.rewrite(old.projectId, old.revision, "补齐人物动机");
    for (const key of [
      "projectId",
      "author",
      "premise",
      "characters",
      "relations",
      "writingSettings",
    ])
      assert.deepEqual(next[key], old[key], key);
    assert.equal(next.revision, old.revision + 1);
    assert.deepEqual(next.plan, {
      outline: "",
      truth: "",
      timeline: "",
      reveals: "",
    });
    assert.deepEqual(next.chapters, []);
    assert.deepEqual(next.messages, []);
    assert.deepEqual(next.memory.entries, []);
    assert.equal(next.rewrite.instruction, "补齐人物动机");
    const run = await lib.runtimeDirectoryFor(old.projectId);
    assert.notEqual(run, originalRun);
    assert.equal(await new Checkpoint(run).read(), null);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(originalRun, "chapter-task.json"), "utf8"),
      ),
      task,
    );
    const snapshots = await lib.rewriteBackups(old.projectId);
    assert.equal(snapshots.length, 1);
    const snapshot = JSON.parse(
      await readFile(
        join(originalRun, "rewrite-backups", snapshots[0].id + ".json"),
        "utf8",
      ),
    );
    const { projectId, ...body } = old;
    assert.deepEqual(snapshot.project, body);
    const restarted = new ProjectLibrary(dir);
    assert.deepEqual(await restarted.load(), next);
    assert.equal(await restarted.runtimeDirectoryFor(projectId), run);
    assert.equal((await restarted.list()).length, 1);
    await assert.rejects(() => lib.save(old, old.revision), /冲突/);
    assert.throws(
      () =>
        applyProposal(
          next,
          old.messages[0].proposal,
          old.messages[0].baseRevision,
        ),
      /过期/,
    );
  }));

test("恢复旧稿前备份当前稿，revision单调递增，候选失效且其他作品不变", () =>
  fixture(async ({ lib, old }) => {
    const other = await lib.create("另一本");
    await lib.select(old.projectId);
    const reset = await lib.rewrite(old.projectId, old.revision);
    const backup = (await lib.rewriteBackups(old.projectId))[0];
    const restored = await lib.restoreRewrite(
      old.projectId,
      backup.id,
      reset.revision,
    );
    for (const key of [
      "author",
      "premise",
      "characters",
      "relations",
      "plan",
      "chapters",
      "writingSettings",
    ])
      assert.deepEqual(restored[key], old[key], key);
    assert.equal(restored.revision, reset.revision + 1);
    assert.equal(restored.messages[0].status, "rejected");
    assert.notEqual(restored.rewrite.epoch, reset.rewrite.epoch);
    assert.equal(
      await new Checkpoint(await lib.runtimeDirectoryFor(old.projectId)).read(),
      null,
    );
    assert.deepEqual(await lib.load(other.projectId), other);
    assert.equal((await lib.rewriteBackups(old.projectId)).length, 2);
    const undone = await lib.restoreRewrite(
      old.projectId,
      restored.rewrite.backupId,
      restored.revision,
    );
    assert.deepEqual(undone.chapters, reset.chapters);
    assert.deepEqual(undone.plan, reset.plan);
  }));

test("版本冲突、备份失败、无效路径和跨作品恢复均不能清空当前作品", () =>
  fixture(async ({ lib, old }) => {
    await assert.rejects(
      () => lib.rewrite(old.projectId, old.revision - 1),
      /冲突/,
    );
    await assert.rejects(
      () => lib.rewrite(old.projectId, old.revision, "字".repeat(8001)),
      /8000/,
    );
    assert.equal((await lib.rewriteBackups(old.projectId)).length, 0);
    await assert.rejects(
      () => lib.restoreRewrite(old.projectId, "../project", old.revision),
      /无效/,
    );
    const other = await lib.create("其他作品");
    const otherReset = await lib.rewrite(other.projectId, other.revision);
    await assert.rejects(
      () =>
        lib.restoreRewrite(
          old.projectId,
          otherReset.rewrite.backupId,
          old.revision,
        ),
      /ENOENT/,
    );
    await writeFile(
      join(lib.directoryFor(old.projectId), "rewrite-backups"),
      "模拟无法写入备份",
    );
    await assert.rejects(() => lib.rewrite(old.projectId, old.revision));
    assert.deepEqual(await lib.load(old.projectId), old);
    const raw = JSON.parse(
      await readFile(
        join(lib.directoryFor(old.projectId), "project.json"),
        "utf8",
      ),
    );
    assert.deepEqual(raw.chapters, old.chapters);
  }));

test("重写规划沿用当前设定和规模，模型看不到旧事件，采纳后可从首章继续", () =>
  fixture(async ({ lib, old }) => {
    const p = await lib.rewrite(old.projectId, old.revision, "人物主动追问");
    const checkpoint = new Checkpoint(
      await lib.runtimeDirectoryFor(p.projectId),
    );
    const config = {
      provider: "glm",
      model: "glm-5.2",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "test",
    };
    const instruction = rewriteInstruction(p);
    const state = await checkpoint.begin(p, { instruction }, config);
    const seen = [];
    const fetcher = async (_url, options) => {
      const b = JSON.parse(options.body),
        system = b.messages[0].content,
        data = JSON.parse(b.messages[1].content);
      seen.push(b);
      let value;
      if (system.includes("识别规划入口"))
        value = {
          mode: "prepare",
          chapterCount: null,
          chapterWords: null,
          countEvidence: "",
          wordsEvidence: "",
        };
      else if (system.includes("补齐故事基础规划")) {
        assert.deepEqual(data.characters, old.characters);
        assert.deepEqual(data.relations, old.relations);
        value = {
          plan: {
            outline: "全新总纲",
            truth: "全新真相",
            timeline: "全新时间线",
            reveals: "全新伏笔",
          },
          characters: [],
          relations: [],
        };
      } else if (system.includes("生成指定章节"))
        value = {
          chapters: data.numbers.map((number) => ({
            number,
            title: "新章" + number,
            summary: "本章主动调查并推进事件，保持因果与人物知情一致。",
          })),
        };
      else throw Error("出现意外的生成分支：" + system.slice(0, 30));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify(value) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    };
    const result = await runChapterAgent(
      p,
      config,
      new AbortController().signal,
      () => {},
      checkpoint,
      state,
      fetcher,
    );
    const adopted = applyProposal(p, result.proposal, p.revision);
    assert.equal(readyForChapter(adopted), true);
    assert.deepEqual(adopted.characters, old.characters);
    assert.deepEqual(adopted.relations, old.relations);
    assert.deepEqual(adopted.premise, old.premise);
    assert.equal(adopted.chapters.length, p.premise.chapterCount);
    assert.ok(
      adopted.chapters.every(
        (c) => !c.content && !old.chapters.some((o) => o.id === c.id),
      ),
    );
    const all = JSON.stringify(seen);
    for (const forbidden of [
      old.chapters[0].content,
      old.plan.outline,
      "旧候选",
    ])
      assert.ok(!all.includes(forbidden));
    assert.ok(all.includes("人物主动追问"));
  }));
