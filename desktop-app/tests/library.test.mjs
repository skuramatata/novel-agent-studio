import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectLibrary } from "../runtime/library.mjs";
import { blankProject } from "../runtime/seed.mjs";
import { projectExport } from "../runtime/export.mjs";
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "novel-library-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("迁移保留旧作品、版本和候选，原文件不变，重启不重复迁入", () =>
  fixture(async (dir) => {
    const old = blankProject();
    old.revision = 7;
    old.premise.title = "旧作品";
    old.messages = [
      {
        id: "candidate",
        role: "assistant",
        text: "方案",
        status: "pending",
        baseRevision: 7,
        proposal: { summary: "方案" },
      },
    ];
    const raw = JSON.stringify(old);
    await writeFile(join(dir, "project.json"), raw);
    const lib = new ProjectLibrary(dir);
    const p = await lib.load();
    assert.equal(p.revision, 7);
    assert.deepEqual(p.messages, old.messages);
    assert.equal(await readFile(join(dir, "project.json"), "utf8"), raw);
    const again = new ProjectLibrary(dir);
    assert.equal((await again.list()).length, 1);
    assert.equal((await again.load()).projectId, p.projectId);
  }));
test("同版本多作品隔离，迟到保存只更新所属作品，路径穿越和无身份写入拒绝", () =>
  fixture(async (dir) => {
    const lib = new ProjectLibrary(dir);
    const a = await lib.load();
    const b = await lib.create("第二本");
    assert.equal(a.revision, b.revision);
    const saved = await lib.save(
      {
        ...a,
        premise: { ...a.premise, title: "第一本" },
        messages: [{ id: "a", role: "user", text: "仅属于A" }],
      },
      a.revision,
    );
    assert.equal(saved.projectId, a.projectId);
    assert.equal((await lib.load()).projectId, b.projectId);
    assert.equal((await lib.load(b.projectId)).messages.length, 0);
    assert.equal((await lib.load(a.projectId)).messages[0].text, "仅属于A");
    await assert.rejects(() => lib.save(a, a.revision), /冲突/);
    await assert.rejects(() => lib.load("../providers"), /不存在/);
    await assert.rejects(() => lib.save(blankProject(), 0), /不存在/);
    assert.equal((await new ProjectLibrary(dir).load()).projectId, b.projectId);
  }));
test("重命名、归档、恢复不丢失数据，最后一部作品不能归档", () =>
  fixture(async (dir) => {
    const lib = new ProjectLibrary(dir);
    const a = await lib.load();
    await assert.rejects(() => lib.archive(a.projectId, true), /至少/);
    const b = await lib.create("B");
    await lib.rename(b.projectId, "新书名");
    assert.equal((await lib.archive(b.projectId, true)).projectId, a.projectId);
    await assert.rejects(() => lib.select(b.projectId), /归档/);
    await assert.rejects(() => lib.save(b, b.revision), /归档/);
    await lib.archive(b.projectId, false);
    assert.equal((await lib.select(b.projectId)).premise.title, "新书名");
    assert.equal((await new ProjectLibrary(dir).load()).projectId, b.projectId);
  }));
test("损坏旧作品和丢失作品文件均不静默重置", () =>
  fixture(async (dir) => {
    await writeFile(join(dir, "project.json"), "broken");
    await assert.rejects(() => new ProjectLibrary(dir).load(), /损坏/);
    assert.equal(await readFile(join(dir, "project.json"), "utf8"), "broken");
    await writeFile(join(dir, "project.json"), JSON.stringify(blankProject()));
    const lib = new ProjectLibrary(dir);
    const p = await lib.load();
    await rm(join(lib.directoryFor(p.projectId), "project.json"));
    await assert.rejects(() => new ProjectLibrary(dir).load(), /ENOENT/);
  }));
test("正文导出按章排序，仅含已采纳正文，不泄露设定、真相和候选", () => {
  const p = blankProject();
  p.premise.title = "书/名";
  p.plan.truth = "秘密真相";
  p.chapters = [
    {
      id: "b",
      number: 2,
      title: "第二章标题",
      summary: "隐藏梗概",
      content: "第二章正文\n\n保留段落",
    },
    { id: "empty", number: 3, title: "未写章节", summary: "", content: " " },
    {
      id: "a",
      number: 1,
      title: "第一章标题",
      summary: "",
      content: "第一章正文",
    },
  ];
  p.messages = [{ id: "x", role: "assistant", text: "未采纳内容" }];
  const md = projectExport(p, "md");
  assert.equal(md.filename, "书_名-正文.md");
  assert.ok(
    md.content.indexOf("第一章正文") < md.content.indexOf("第二章正文"),
  );
  for (const forbidden of ["秘密真相", "隐藏梗概", "未写章节", "未采纳内容"])
    assert.ok(!md.content.includes(forbidden));
  assert.ok(md.content.includes("第二章正文\n\n保留段落"));
  assert.throws(() => projectExport(blankProject(), "md"), /还没有/);
  assert.throws(() => projectExport(p, "html"), /不支持/);
  assert.deepEqual(
    JSON.parse(
      projectExport({ ...p, projectId: "local-only" }, "json").content,
    ),
    p,
  );
});
