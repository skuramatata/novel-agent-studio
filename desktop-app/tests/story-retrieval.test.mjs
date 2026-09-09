import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoryVectorIndex, sourceChunks } from "../runtime/story-retrieval.mjs";

const embed = async (texts) =>
  texts.map((t) => (t.includes("钥匙") ? [1, 0] : [0, 1]));
const project = {
  projectId: "book-a",
  chapters: [
    { id: "one", number: 1, content: "钥匙由守塔人保管。\n\n窗外狂风大作。" },
    { id: "two", number: 2, content: "未来章节的钥匙已经销毁。" },
  ],
};
test("SQLite向量检索只返回当前作品、当前版本、已采纳此前原文，重启仍可查", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novel-vector-test-"));
  let calls = 0;
  const tracked = async (texts) => {
    calls += texts.length;
    return embed(texts);
  };
  let index = new StoryVectorIndex(directory, tracked, "test-v1");
  try {
    await index.sync(project);
    const initial = calls;
    await index.sync(project);
    assert.equal(calls, initial);
    await index.sync({ ...project, projectId: "book-b" });
    let found = await index.search(project, 2, "钥匙在哪", { maxTokens: 2000 });
    assert.equal(found.sources[0].text, "钥匙由守塔人保管。");
    assert.ok(found.sources.every((s) => s.number < 2));
    const changed = structuredClone(project);
    changed.chapters[0].content = "钥匙已交还船长。";
    assert.equal((await index.search(changed, 2, "钥匙")).sources.length, 0);
    await index.sync(changed);
    index.close();
    index = new StoryVectorIndex(directory, tracked, "test-v1");
    found = await index.search(changed, 2, "钥匙");
    assert.equal(found.sources[0].text, changed.chapters[0].content);
    assert.equal(
      (await index.search({ ...project, projectId: "missing" }, 2, "钥匙"))
        .sources.length,
      0,
    );
    assert.equal((await index.search(project, 2, "钥匙")).sources.length, 0);
    assert.ok(
      (await index.search({ ...project, projectId: "book-b" }, 2, "钥匙"))
        .sources.length,
    );
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("索引失败与取消不覆盖旧数据，Embedding变更隔离旧向量", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novel-vector-failure-"));
  const index = new StoryVectorIndex(directory, embed, "one");
  try {
    await index.sync(project);
    const changed = structuredClone(project);
    changed.chapters[0].content += "新增线索。";
    index.embed = async () => {
      throw Error("模拟推理故障");
    };
    await assert.rejects(index.sync(changed), /模拟推理/);
    index.embed = embed;
    assert.ok((await index.search(project, 2, "钥匙")).sources.length);
    await assert.rejects(index.sync(changed, { signal: AbortSignal.abort() }));
    index.embeddingId = "two";
    assert.equal((await index.search(project, 2, "钥匙")).sources.length, 0);
    await index.sync(project);
    assert.ok((await index.search(project, 2, "钥匙")).sources.length);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("章节重排更新检索范围，正文未变时复用向量", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novel-vector-reorder-"));
  let calls = 0;
  const index = new StoryVectorIndex(
    directory,
    async (texts) => {
      calls += texts.length;
      return embed(texts);
    },
    "test",
  );
  try {
    await index.sync(project);
    const before = calls;
    const reordered = structuredClone(project);
    reordered.chapters[0].number = 2;
    reordered.chapters[1].number = 1;
    await index.sync(reordered);
    assert.equal(calls, before);
    const result = await index.search(reordered, 2, "钥匙");
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].chapterId, "two");
    assert.equal(result.sources[0].number, 1);
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("长段按索引片段切分后仍逐字对应原文偏移，检索装包遵守Token额度", async () => {
  const p = {
    projectId: "budget",
    chapters: [
      {
        id: "long",
        number: 1,
        content: "钥匙🔑保管记录。".repeat(300) + "\n\n另一段。",
      },
    ],
  };
  for (const c of sourceChunks(p.chapters[0]))
    assert.equal(p.chapters[0].content.slice(c.start, c.end), c.text);
  const directory = await mkdtemp(join(tmpdir(), "novel-vector-budget-"));
  const index = new StoryVectorIndex(directory, embed, "test");
  try {
    await index.sync(p);
    const result = await index.search(p, 2, "钥匙", { maxTokens: 1500 });
    assert.ok(result.coverage.tokens <= 1500);
    assert.ok(!result.sources.some((s) => s.text.length > 3000));
  } finally {
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
