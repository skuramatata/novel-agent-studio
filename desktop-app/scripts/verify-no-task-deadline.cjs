// 在真实 Electron 中恢复隔离任务：加速旧的15分钟计时器，验证不再创建它且手动停止仍生效。
const { _electron } = require("playwright");
const { expect } = require("playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = process.cwd(),
    out = path.resolve(process.argv[2] || "verification/no-task-deadline");
  const read = async (f) => JSON.parse(await fs.readFile(f, "utf8"));
  const project = await read(path.join(out, "project.before.json"));
  const checkpoint = await read(path.join(out, "task.before.json"));
  const build = await read(path.join(root, "build-info.json"));
  const dir = await fs.mkdtemp(path.join(out, "desktop-")),
    id = "no-task-deadline-test",
    store = path.join(dir, "projects", id);
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(
    path.join(dir, "library.json"),
    JSON.stringify({
      version: 1,
      activeId: id,
      entries: [{ id, archived: false }],
    }),
  );
  await fs.writeFile(path.join(store, "project.json"), JSON.stringify(project));
  await fs.writeFile(
    path.join(store, "chapter-task.json"),
    JSON.stringify(checkpoint),
  );
  await fs.writeFile(
    path.join(dir, "test.env"),
    "ZAI_CODING_CN_API_KEY=test-no-network\nMAIN_MODEL=glm-5.2\n",
  );
  let app;
  try {
    app = await _electron.launch({
      executablePath: path.join(
        root,
        "release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app/Contents/MacOS/NovelAgentStudio",
      ),
      env: {
        ...process.env,
        NOVEL_AGENT_DATA_DIR: dir,
        NOVEL_AGENT_ENV: path.join(dir, "test.env"),
      },
    });
    await app.evaluate(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      globalThis.deadlines = [];
      globalThis.testCalls = 0;
      AbortSignal.timeout = (ms) => {
        globalThis.deadlines.push(ms);
        return timeout(ms === 15 * 60 * 1000 ? 25 : ms);
      };
      globalThis.fetch = (_url, init) => {
        globalThis.testCalls++;
        globalThis.pendingSignal = init.signal;
        init.signal.throwIfAborted();
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          ),
        );
      };
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    const workspace = page.getByRole("region", { name: "草稿工作区" });
    const taskBefore = await page.evaluate((id) => window.studio.task(id), id);
    await workspace
      .getByRole("button", { name: "继续审查并自动修改", exact: true })
      .click();
    await expect.poll(() => app.evaluate(() => globalThis.testCalls)).toBe(1);
    // 比加速后的旧时限长，旧包在此时会自动中断；新包应一直等待模型或作者停止。
    await app.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
    assert.deepEqual(await app.evaluate(() => globalThis.deadlines), []);
    assert.equal(
      await app.evaluate(() => globalThis.pendingSignal.aborted),
      false,
    );
    await expect(workspace.locator(".draft-feedback")).toContainText(
      "正在处理",
    );
    await expect(
      workspace.getByRole("button", { name: "停止本次处理", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: path.join(out, "running-without-deadline.png"),
    });
    await workspace
      .getByRole("button", { name: "停止本次处理", exact: true })
      .click();
    await expect(workspace.locator(".draft-feedback")).toContainText(
      "任务已停止",
    );
    const taskAfter = await page.evaluate((id) => window.studio.task(id), id);
    assert.equal(taskAfter.status, "interrupted");
    assert.equal(taskAfter.draft, taskBefore.draft);
    assert.equal(
      await app.evaluate(() => globalThis.pendingSignal.aborted),
      true,
    );
    assert.deepEqual(
      (await page.evaluate(() => window.studio.load())).chapters,
      project.chapters,
    );
    const saved = await read(path.join(store, "chapter-task.json"));
    const drafts = (s) =>
      Object.fromEntries(
        Object.entries(s.values).filter(([key]) => /^final-scene:/.test(key)),
      );
    assert.deepEqual(drafts(saved), drafts(checkpoint));
    for (const [key, value] of Object.entries(checkpoint.values))
      assert.deepEqual(
        saved.values[key],
        value,
        "已完成步骤应继续保留：" + key,
      );
    const runs = await fs.readdir(path.join(store, "runs"));
    const record = await read(
      path.join(
        store,
        "runs",
        runs.find((f) => f.endsWith(".json")),
      ),
    );
    assert.equal(record.status, "cancelled");
    await page.screenshot({
      path: path.join(out, "manual-stop-preserved.png"),
    });
    const report = {
      version: build.displayVersion,
      status: "passed",
      automaticDeadlinesCreated: 0,
      formerDeadlineAcceleratedToMs: 25,
      pendingAfterMs: 100,
      manualStopWorks: true,
      completedStepsPreserved: true,
      draftPreserved: true,
      formalChaptersUnchanged: true,
      externalCalls: 0,
      sourceTask: checkpoint.id,
      directory: dir,
    };
    await fs.writeFile(
      path.join(out, "desktop-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
