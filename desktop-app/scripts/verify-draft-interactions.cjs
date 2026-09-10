// 使用本地隔离快照及已记录的模型响应验证实际 Electron；不写入正式作品。
// NODE_PATH 指向已有 Playwright 依赖，参数为包含 project.before.json、task.before.json、live/ 的目录。
const { _electron } = require("playwright");
const { expect } = require("playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
(async () => {
  const root = process.cwd(),
    out = path.resolve(process.argv[2] || "verification/draft-interactions");
  const read = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
  const project = await read(path.join(out, "project.before.json"));
  const before = await read(path.join(out, "task.before.json"));
  const request = await read(path.join(out, "live/request.json"));
  const records = await read(path.join(out, "live/requests.json"));
  const expected = await read(path.join(out, "live/chapter-task.json"));
  const build = await read(path.join(root, "build-info.json"));
  const dir = await fs.mkdtemp(path.join(out, "desktop-")),
    id = "draft-interaction-test";
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
    JSON.stringify(before),
  );
  await fs.writeFile(
    path.join(dir, "test.env"),
    "ZAI_CODING_CN_API_KEY=replay-only\nMAIN_MODEL=glm-5.2\n",
  );
  let app;
  const launch = async () => {
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
    await app.evaluate((_, records) => {
      globalThis.replayIndex = 0;
      globalThis.calls = [];
      globalThis.verifyMode = "replay";
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body),
          phase = body.messages[0].content.match(/当前步骤：([^。]+)。/)[1];
        globalThis.calls.push({
          phase,
          messages: body.messages,
          mode: globalThis.verifyMode,
        });
        if (globalThis.verifyMode === "failure")
          throw Error("隔离验证：模型连接中断，请重试");
        if (globalThis.verifyMode === "replay") {
          const record = records[globalThis.replayIndex++];
          if (
            !record ||
            !record.response ||
            !record.messages[0].content.includes(`当前步骤：${phase}。`)
          )
            throw Error(`重放阶段不一致：${phase}`);
          // 留出渲染帧检查可见的运行状态。
          await new Promise((resolve) => setTimeout(resolve, 250));
          return new Response(JSON.stringify(record.response), {
            status: record.status,
          });
        }
        if (phase !== "review" && phase !== "continuity_review")
          throw Error(`预期只读重审，实际 ${phase}`);
        const data = JSON.parse(body.messages[1].content),
          source = data.document.sources[0],
          row = source.paragraphs[0];
        const authorChecks = (data.authorConstraints || []).map((c) => ({
          id: c.id,
          respected: true,
          evidence: [{ sourceId: source.sourceId, paragraph: row.paragraph }],
        }));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ issues: [], authorChecks }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { total_tokens: 10 },
          }),
        );
      };
    }, records);
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    return page;
  };
  const phase = (name) => console.log(JSON.stringify({ phase: name }));
  try {
    let page = await launch();
    const workspace = () => page.getByRole("region", { name: "草稿工作区" });
    const task = () => page.evaluate((id) => window.studio.task(id), id);
    const saved = () => read(path.join(store, "chapter-task.json"));
    const settle = async (previous) => {
      await page.waitForFunction(
        async ({ id, previous }) => {
          const t = await window.studio.task(id);
          return t?.workspace?.canGuide && t.updatedAt !== previous;
        },
        { id, previous },
        { timeout: 90000 },
      );
      await expect(workspace().locator(".draft-feedback")).toBeVisible();
      await expect(workspace().getByLabel("草稿修改要求")).toBeEnabled();
    };
    await workspace().waitFor();
    phase("需求不明确的所选问题有提示和焦点，零请求");
    const checkbox = workspace()
      .locator(".draft-issue-list label")
      .filter({ hasText: "问题 15" })
      .getByRole("checkbox");
    await checkbox.check();
    await workspace()
      .getByRole("button", { name: "补充要求后修改 1 项", exact: true })
      .click();
    await expect(workspace().getByLabel("草稿修改要求")).toBeFocused();
    assert.equal((await app.evaluate(() => globalThis.calls)).length, 0);
    assert.equal(
      (await saved()).authorActions.length,
      before.authorActions.length,
    );
    await page.screenshot({ path: path.join(out, "instruction-needed.png") });
    phase("勾选原问题，补充指令，经真实响应重放完成修改与复核");
    await workspace().getByLabel("草稿修改范围").selectOption("scene:1|1");
    await workspace().getByLabel("草稿修改要求").fill(request.instruction);
    const previous = (await task()).updatedAt;
    await workspace()
      .getByRole("button", { name: "按要求修改 1 项问题", exact: true })
      .click();
    await expect(workspace().locator(".draft-feedback")).toContainText(
      "正在处理",
    );
    await expect(
      workspace().getByRole("button", { name: "停止本次处理", exact: true }),
    ).toBeVisible();
    await settle(previous);
    const patched = await saved();
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(patched.values).filter(([k]) => /^final-scene:/.test(k)),
      ),
      Object.fromEntries(
        Object.entries(expected.values).filter(([k]) =>
          /^final-scene:/.test(k),
        ),
      ),
    );
    assert.equal(
      await app.evaluate(() => globalThis.replayIndex),
      records.length,
    );
    await expect(workspace().locator(".draft-feedback")).toContainText(
      "当前草稿已更新",
    );
    await page.screenshot({ path: path.join(out, "selected-repaired.png") });
    phase("当前版本不可重复恢复；恢复旧稿后有正文变化和结果反馈");
    await workspace().locator(".draft-history summary").click();
    const patchedView = await task(),
      currentVersion = patchedView.workspace.versions.find(
        (v) => v.text === patchedView.draft,
      );
    await workspace()
      .getByLabel("选择草稿历史版本")
      .selectOption(currentVersion.id);
    await expect(
      workspace().getByRole("button", { name: "已是当前草稿", exact: true }),
    ).toBeDisabled();
    const originalVersion = patchedView.workspace.versions.find(
      (v) => v.text !== patchedView.draft && v.status === "saved",
    );
    await workspace()
      .getByLabel("选择草稿历史版本")
      .selectOption(originalVersion.id);
    const beforeRestore = (await task()).updatedAt;
    await workspace()
      .getByRole("button", { name: "恢复这个版本", exact: true })
      .click();
    await settle(beforeRestore);
    assert.equal((await task()).draft, originalVersion.text);
    await expect(workspace().locator(".draft-feedback")).toContainText(
      "已恢复所选版本",
    );
    await page.screenshot({ path: path.join(out, "restored.png") });
    phase("失败提示在工作区可见，作者输入保留，可再次提交");
    await workspace().locator(".draft-history summary").click();
    await workspace()
      .getByLabel("草稿修改要求")
      .fill("只检查当前段落的原文依据");
    await app.evaluate(() => {
      globalThis.verifyMode = "failure";
    });
    const beforeFailure = (await task()).updatedAt;
    await workspace()
      .getByRole("button", { name: "按要求修改", exact: true })
      .click();
    await settle(beforeFailure);
    await expect(workspace().locator(".draft-feedback")).toContainText(
      "隔离验证：模型连接中断",
    );
    await expect(workspace().getByLabel("草稿修改要求")).toHaveValue(
      "只检查当前段落的原文依据",
    );
    await page.screenshot({ path: path.join(out, "failure-feedback.png") });
    phase("相同正文主动审查两次均有新请求，并显示正文没有变化");
    // 先通过可见恢复入口结束失败的局部修改，再检查独立的新一轮审查。
    await workspace().locator(".draft-history summary").click();
    await workspace()
      .getByLabel("选择草稿历史版本")
      .selectOption(currentVersion.id);
    const recoverAfterFailure = (await task()).updatedAt;
    await workspace()
      .getByRole("button", { name: "恢复这个版本", exact: true })
      .click();
    await settle(recoverAfterFailure);
    await workspace().locator(".draft-history summary").click();
    await workspace().getByLabel("草稿修改要求").fill("");
    await app.evaluate(() => {
      globalThis.verifyMode = "review";
    });
    for (let i = 0; i < 2; i++) {
      const previous = (await task()).updatedAt,
        count = await app.evaluate(() => globalThis.calls.length);
      await workspace()
        .getByRole("button", { name: "继续审查并自动修改", exact: true })
        .click();
      await settle(previous);
      assert.ok((await app.evaluate(() => globalThis.calls.length)) > count);
      await expect(workspace().locator(".draft-feedback")).toContainText(
        "本次正文没有变化",
      );
    }
    phase("重复交付不可点击，聊天与阅读页都能定位候选");
    await expect(
      workspace().getByRole("button", {
        name: "当前稿已生成候选",
        exact: true,
      }),
    ).toBeDisabled();
    await workspace()
      .getByRole("button", { name: "查看待采纳候选", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "采纳到作品", exact: true }).last(),
    ).toBeInViewport();
    const ch = project.chapters.find((c) => c.id === before.chapterId);
    await page
      .getByRole("button", { name: /章节阅读/ })
      .first()
      .click();
    await page
      .locator(".chapter-list button")
      .filter({ hasText: ch.title })
      .click();
    await workspace()
      .getByRole("button", { name: "查看待采纳候选", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "采纳本章与记忆", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: path.join(out, "reader-feedback.png") });
    const finalTask = await task(),
      finalProject = await page.evaluate(() => window.studio.load());
    assert.deepEqual(finalProject.chapters, project.chapters);
    const calls = await app.evaluate(() => globalThis.calls);
    await fs.writeFile(
      path.join(out, "desktop-calls.json"),
      JSON.stringify(calls, null, 2),
      { mode: 0o600 },
    );
    await app.close();
    app = null;
    page = await launch();
    assert.equal((await task()).draft, finalTask.draft);
    assert.equal(await app.evaluate(() => globalThis.calls.length), 0);
    const report = {
      version: build.displayVersion,
      status: "passed",
      replayCalls: records.length,
      externalCalls: 0,
      selectedIssue: "issue-15",
      pendingInstructionFocus: true,
      restored: true,
      errorVisible: true,
      activeReviewMakesNewCalls: true,
      candidateNavigation: ["chat", "reader"],
      chaptersUnchanged: true,
      restartPersisted: true,
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
