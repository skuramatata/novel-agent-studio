const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

(async () => {
  const root = path.resolve(__dirname, "..");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-review-notice-"));
  let app;
  try {
    const { blankProject } = await import("../runtime/seed.mjs");
    await fs.writeFile(
      path.join(dir, "project.json"),
      JSON.stringify(blankProject()),
    );
    app = await electron.launch({
      executablePath:
        process.env.NOVEL_VERIFY_EXECUTABLE ||
        path.join(
          root,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
      args: process.env.NOVEL_VERIFY_EXECUTABLE ? [] : [root],
      env: {
        ...process.env,
        NOVEL_AGENT_DATA_DIR: dir,
        NOVEL_AGENT_ENV: path.join(dir, "missing.env"),
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("页面错误", e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.error(m.text());
    });
    await page.getByLabel("切换作品").waitFor();
    const project = await page.evaluate(() => window.studio.load());
    // 固定任务读取结果，隔离模型调用和用户作品，验证真实 React 页面切换。
    await app.evaluate(({ ipcMain }, id) => {
      globalThis.noticeStatus = "awaiting_instruction";
      ipcMain.removeHandler("studio:task");
      ipcMain.handle("studio:task", (_event, projectId) =>
        projectId !== id
          ? null
          : {
              id: "notice-regression",
              status: globalThis.noticeStatus,
              stage: "等待作者指导",
              error: "",
              chapterId: "",
              review: null,
              workspace: null,
              draft: "",
              fragments: [],
              manifest: [],
              resumable: false,
            },
      );
    }, project.projectId);
    const notice = page.getByRole("button", {
      name: "打开创作对话",
      exact: true,
    });
    const navigate = async (name) => {
      console.log(`切换至 ${name}`);
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(await page.locator(".topbar b").innerText(), name);
    };
    for (const status of ["awaiting_instruction", "awaiting_input"]) {
      await app.evaluate((_electron, value) => {
        globalThis.noticeStatus = value;
      }, status);
      for (let i = 0; i < 3; i++) {
        for (const name of [
          "故事记忆",
          "作品管理",
          "人物关系",
          "作者与作品",
          "章节阅读",
          "创作日志",
        ]) {
          await navigate(name);
          await notice.first().waitFor();
          assert.equal(
            await notice.count(),
            1,
            `${status} ${name} 提示应只有一条`,
          );
          await notice.click();
          await page.waitForFunction(
            () =>
              document.querySelector(".topbar b")?.textContent === "创作对话",
          );
          assert.equal(await notice.count(), 0, "创作对话中不应残留全局提示");
        }
      }
    }
    await navigate("作品管理");
    await page.getByLabel("新作品名称").fill("无待处理草稿的作品");
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.waitForFunction(
      (id) =>
        document.querySelector('select[aria-label="切换作品"]').value !== id,
      project.projectId,
    );
    assert.equal(await notice.count(), 0, "切换作品应移除旧提示");
    await page.getByLabel("切换作品").selectOption(project.projectId);
    await notice.waitFor();
    await navigate("故事记忆");
    assert.equal(await notice.count(), 1);
    await fs.mkdir(path.join(root, "verification/review-notice"), {
      recursive: true,
    });
    await page.screenshot({
      path: path.join(root, "verification/review-notice/fixed.png"),
    });
    await app.evaluate(() => {
      globalThis.noticeStatus = "completed";
    });
    await navigate("创作对话");
    await navigate("故事记忆");
    await notice.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    const version = await page.locator(".version code").innerText();
    assert.equal(
      version,
      JSON.parse(await fs.readFile(path.join(root, "build-info.json"), "utf8"))
        .displayVersion,
    );
    console.log(
      JSON.stringify({
        passed: true,
        version,
        checks: [
          "两种等待状态下反复切换六个页面",
          "提示入口返回创作对话",
          "跨作品隔离",
          "已完成任务不显示",
          "界面构建版本一致",
        ],
      }),
    );
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
