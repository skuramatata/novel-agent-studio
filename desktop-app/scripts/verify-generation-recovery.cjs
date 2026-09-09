// 重放保存作者答复后的超时：真实 Electron IPC / 存储 / 检查点，模型调用处注入中断。
// 参数为包含 project.json.bak 和 chapter-task.json 的只读快照目录；不读取密钥。
const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const root = process.cwd();
  const out = path.resolve(
    process.argv[2] || "verification/generation-recovery",
  );
  const expectStale = process.argv.includes("--expect-stale");
  const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const project = await read(path.join(out, "project.json.bak"));
  const checkpoint = await read(path.join(out, "chapter-task.json"));
  const build = await read(path.join(root, "build-info.json"));
  const missingTurns = checkpoint.reviewConversation.filter(
    (m) => !project.messages.some((saved) => saved.id === m.id),
  );
  assert.ok(
    missingTurns.some((m) => m.role === "user"),
    "需要已保存但尚未同步到作品的作者答复",
  );
  const dir = await fs.mkdtemp(path.join(out, "desktop-"));
  const id = "generation-recovery-test";
  const store = path.join(dir, "projects", id);
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
    "ZAI_CODING_CN_API_KEY=test-only\nMAIN_MODEL=glm-5.2\n",
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
      globalThis.recoveryMode = "timeout";
      globalThis.recoveryCalls = 0;
      AbortSignal.timeout = (ms) => {
        if (ms !== 15 * 60 * 1000) return timeout(ms);
        globalThis.recoveryTimer = new AbortController();
        return globalThis.recoveryTimer.signal;
      };
      globalThis.fetch = async (_url, init) => {
        globalThis.recoveryCalls++;
        if (globalThis.recoveryMode === "timeout")
          globalThis.recoveryTimer.abort(
            new DOMException("Injected timeout", "TimeoutError"),
          );
        init.signal.throwIfAborted();
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        });
      };
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    const resume = page.getByRole("button", {
      name: "恢复上次任务",
      exact: true,
    });
    const alert = page.getByRole("alert");
    const savedRevision = () => page.locator(".topbar .saved").textContent();
    await resume.click();
    await alert.filter({ hasText: "任务超时" }).waitFor();
    await resume.waitFor();
    const saved = await page.evaluate(() => window.studio.load());
    const afterTimeout = await read(path.join(store, "chapter-task.json"));
    assert.equal(saved.revision, project.revision + 1);
    assert.deepEqual(saved.chapters, project.chapters);
    assert.deepEqual(saved.messages.slice(-missingTurns.length), missingTurns);
    assert.equal(afterTimeout.status, "interrupted");
    assert.equal(afterTimeout.stage, checkpoint.stage);
    assert.deepEqual(afterTimeout.reviewDecisions, checkpoint.reviewDecisions);
    assert.deepEqual(
      afterTimeout.reviewWorkflow.constraints,
      checkpoint.reviewWorkflow.constraints,
    );
    const drafts = (state) =>
      Object.fromEntries(
        Object.entries(state.values).filter(([k]) =>
          /^final-scene:\d+$/.test(k),
        ),
      );
    assert.deepEqual(drafts(afterTimeout), drafts(checkpoint));
    assert.equal(await app.evaluate(() => globalThis.recoveryCalls), 1);
    if (expectStale) {
      assert.match(await savedRevision(), new RegExp(`v${project.revision}$`));
      await resume.click();
      await alert.filter({ hasText: "作品版本已变化" }).waitFor();
      assert.equal(await app.evaluate(() => globalThis.recoveryCalls), 1);
      await fs.writeFile(
        path.join(out, "before-report.json"),
        JSON.stringify(
          {
            reproduced: true,
            version: build.displayVersion,
            uiRevision: project.revision,
            diskRevision: saved.revision,
            retryReachedModel: false,
          },
          null,
          2,
        ),
      );
      console.log(
        "旧版已复现：答复保存后超时，页面版本落后，恢复在模型调用前被拒绝。",
      );
      return;
    }
    assert.match(await savedRevision(), new RegExp(`v${saved.revision}$`));
    await page.screenshot({
      path: path.join(out, "timeout-synced.png"),
      fullPage: true,
    });
    await app.evaluate(() => {
      globalThis.recoveryMode = "hold";
    });
    await resume.click();
    // 模型桩第二次收到请求，证明恢复已越过版本检查并进入原来的批次。
    await page.waitForFunction(
      async (id) => (await window.studio.task(id)).status === "running",
      id,
    );
    const deadline = Date.now() + 15000;
    while ((await app.evaluate(() => globalThis.recoveryCalls)) < 2) {
      assert.ok(Date.now() < deadline, "恢复没有进入模型调用");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await page.getByRole("button", { name: "停止生成", exact: true }).click();
    await alert.filter({ hasText: "任务已停止" }).waitFor();
    await resume.waitFor();
    assert.match(await savedRevision(), new RegExp(`v${saved.revision}$`));
    assert.deepEqual(
      (await page.evaluate(() => window.studio.load())).messages,
      saved.messages,
    );
    // 真正的过期请求仍应拒绝；报错后页面必须同步，不能偷偷重发生成。
    const changed = await page.evaluate(async () => {
      const p = await window.studio.load();
      p.messages.push({
        id: "concurrent-message",
        role: "user",
        text: "隔离验证中的并发保存",
      });
      return window.studio.save(p, p.revision);
    });
    await resume.click();
    await alert.filter({ hasText: "作品版本已变化" }).waitFor();
    await resume.waitFor();
    assert.match(await savedRevision(), new RegExp(`v${changed.revision}$`));
    assert.equal(await app.evaluate(() => globalThis.recoveryCalls), 2);
    const task = await page.evaluate((id) => window.studio.task(id), id);
    assert.equal(task.resumable, true);
    assert.deepEqual(
      drafts(await read(path.join(store, "chapter-task.json"))),
      drafts(checkpoint),
    );
    const report = {
      passed: true,
      version: build.displayVersion,
      externalCalls: 0,
      timeoutSyncedRevision: saved.revision,
      resumedOriginalStage: task.stage,
      cancelPreservedAnswer: true,
      staleRequestRejectedWithoutRetry: true,
      conflictSyncedRevision: changed.revision,
      draftsAndDecisionsPreserved: true,
      formalProjectNotModified: true,
      directory: dir,
      scope:
        "真实检查点恢复与桌面版本同步；模型调用处注入超时/取消，不代表整章审稿通过",
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
