const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
(async () => {
  const root = path.resolve(__dirname, "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-library-ui-"));
  const { blankProject } = await import("../runtime/seed.mjs");
  const p = blankProject();
  p.premise.title = "迁移验证作品";
  p.chapters = [
    {
      id: "a",
      number: 1,
      title: "第一节",
      summary: "隐藏梗概",
      content: "已采纳的第一章正文。",
    },
  ];
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(p));
  const launch = () =>
    electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [root],
      env: {
        ...process.env,
        NOVEL_AGENT_DATA_DIR: dir,
        NOVEL_AGENT_ENV: path.join(dir, "missing.env"),
      },
    });
  let app;
  try {
    app = await launch();
    let page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("combobox", { name: "切换作品" }).waitFor();
    const a = await page.evaluate(() => window.studio.load());
    assert.equal(a.premise.title, "迁移验证作品");
    await page.getByRole("button", { name: "作品管理", exact: true }).click();
    await page.getByLabel("新作品名称").fill("第二部作品");
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="切换作品"]')
          ?.selectedOptions[0]?.textContent === "第二部作品",
    );
    const b = await page.evaluate(() => window.studio.load());
    assert.notEqual(a.projectId, b.projectId);
    assert.equal(b.chapters.length, 0);
    assert.equal(
      await page
        .getByRole("button", { name: "下载作品正文 (.md)", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "作者与作品", exact: true }).click();
    await page.getByLabel("暂定书名").fill("B未保存草稿");
    await page
      .getByRole("combobox", { name: "切换作品" })
      .selectOption(a.projectId);
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="切换作品"]')
          ?.selectedOptions[0]?.textContent === "迁移验证作品",
    );
    assert.equal(
      await page.getByLabel("暂定书名").inputValue(),
      "迁移验证作品",
    );
    await page.getByRole("button", { name: "章节阅读", exact: false }).click();
    await page.getByText("已采纳的第一章正文。", { exact: true }).waitFor();
    const mdPath = path.join(dir, "正文.md");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, mdPath);
    await page
      .getByRole("button", { name: "下载作品正文 (.md)", exact: true })
      .click();
    await page.getByText("作品正文已导出", { exact: true }).waitFor();
    const md = await fs.readFile(mdPath, "utf8");
    assert.ok(md.includes("已采纳的第一章正文。"));
    assert.ok(!md.includes("隐藏梗概"));
    const jsonPath = path.join(dir, "备份.json");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, jsonPath);
    await page
      .getByRole("button", { name: "下载作品备份", exact: true })
      .click();
    await page.getByText("作品备份已导出", { exact: true }).waitFor();
    assert.equal(
      JSON.parse(await fs.readFile(jsonPath, "utf8")).chapters[0].content,
      p.chapters[0].content,
    );
    await page.getByRole("button", { name: "作品管理", exact: true }).click();
    const card = page
      .locator(".work-card")
      .filter({
        has: page.getByRole("heading", { name: "第二部作品", exact: true }),
      });
    await card.getByRole("button", { name: "重命名", exact: true }).click();
    await card.getByLabel("作品名称", { exact: true }).fill("第二部作品改名");
    await card.getByRole("button", { name: "保存名称" }).click();
    await page
      .getByRole("heading", { name: "第二部作品改名", exact: true })
      .waitFor();
    const renamed = page
      .locator(".work-card")
      .filter({
        has: page.getByRole("heading", { name: "第二部作品改名", exact: true }),
      });
    await renamed.getByRole("button", { name: "归档", exact: true }).click();
    await page
      .getByRole("button", { name: "已归档（1）", exact: true })
      .click();
    await page.getByRole("button", { name: "恢复作品", exact: true }).click();
    await page
      .getByRole("button", { name: "创作中（2）", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "切换作品" })
      .selectOption(b.projectId);
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="切换作品"]')
          ?.selectedOptions[0]?.textContent === "第二部作品改名",
    );
    await page.screenshot({
      path: path.join(root, "verification/multi-work-desktop.png"),
    });
    assert.deepEqual(errors, []);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("combobox", { name: "切换作品" }).waitFor();
    const restored = await page.evaluate(() => window.studio.load());
    assert.equal(restored.projectId, b.projectId);
    assert.equal(restored.premise.title, "第二部作品改名");
    console.log(
      "桌面验证通过：迁移、新建、切换、表单隔离、章节阅读、MD/JSON文件导出、重命名、归档恢复、重启恢复。",
    );
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
