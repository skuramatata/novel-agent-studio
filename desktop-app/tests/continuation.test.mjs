import test from "node:test";
import assert from "node:assert/strict";
import { continuationTask } from "../runtime/continuation.mjs";

const project = () => ({
  premise: { chapterWords: 5000 },
  chapters: [
    { id: "a", number: 1, content: "" },
    { id: "b", number: 2, content: "" },
  ],
});
test("继续使用已采纳字数并只选下一空白章", () => {
  const p = project();
  assert.deepEqual(continuationTask(p, "继续").targetIds, ["a"]);
  p.chapters[0].content = "已采纳正文";
  const task = continuationTask(p, "继续吧");
  assert.deepEqual(task.targetIds, ["b"]);
  assert.equal(task.chapterWords, 5000);
  assert.equal(task.totalWords, null);
});
test("全部已写完时不把继续当作重写授权，具体修改请求交给正常解析", () => {
  const p = project();
  p.chapters.forEach((c) => (c.content = "已有正文"));
  assert.deepEqual(continuationTask(p, "接着写"), { complete: true });
  assert.equal(continuationTask(p, "继续修改第一章"), null);
  assert.equal(continuationTask(p, "继续，把第一章改成3000字"), null);
});
