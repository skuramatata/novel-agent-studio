// 隔离桌面重放：先注入一次输出截断，再重放本轮真实响应；验证自动扩容与重启持久化。
const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const root = process.cwd(),
    out = path.resolve("verification/review-output-fix");
  const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const live = path.join(out, process.argv[2] || "live-resume");
  const before = await read(path.join(live, "task.before.json"));
  const recorded = await read(path.join(live, "chapter-task.json"));
  const project = await read(path.join(live, "project.before.json"));
  const requests = await read(path.join(live, "requests.json"));
  const build = await read(path.join(root, "build-info.json"));
  assert.ok(["ready", "awaiting_input", "retryable"].includes(recorded.status));
  assert.ok(requests.every((r) => r.response));
  const initialBudget = requests[0].outputBudget;
  const dir = await fs.mkdtemp(path.join(out, "desktop-")),
    id = "review-output-test";
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
    "ZAI_CODING_CN_API_KEY=test-replay-only\nMAIN_MODEL=glm-5.2\n",
  );
  let app;
  const launch = async (responses) => {
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
    await app.evaluate((_, responses) => {
      globalThis.replayCalls = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body),
          call = globalThis.replayCalls.length;
        globalThis.replayCalls.push({ output: body.max_tokens });
        // 完整JSON也必须因length被拒绝，不能直接进入后续阶段。
        if (call === 0 && responses.length)
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: '{"issues":[]}' },
                  finish_reason: "length",
                },
              ],
              usage: {
                prompt_tokens: responses[0].response.usage.prompt_tokens,
                completion_tokens: body.max_tokens,
              },
            }),
          );
        const record = responses[call - 1];
        if (
          !record ||
          JSON.stringify(body.messages) !== JSON.stringify(record.messages)
        )
          throw Error("桌面重放请求与真实记录不一致");
        if (call === 1 && body.max_tokens !== responses[0].outputBudget * 2)
          throw Error("截断后没有自动扩大输出额度");
        return new Response(JSON.stringify(record.response));
      };
    }, responses);
    return app.firstWindow();
  };
  try {
    let page = await launch(requests);
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .click();
    // 旧任务本身也可能是 retryable，先等重放调用真正发生，不能误把初始状态当成完成。
    await app.evaluate(async (_, expected) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (globalThis.replayCalls.length >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw Error(
        `重放调用未完成：${globalThis.replayCalls.length}/${expected}`,
      );
    }, requests.length + 1);
    await page.waitForFunction(
      async ({ id, expected, initialUpdatedAt }) => {
        const task = await window.studio.task(id);
        return task?.status === expected && task.updatedAt !== initialUpdatedAt;
      },
      {
        id,
        expected: recorded.status === "ready" ? "completed" : recorded.status,
        initialUpdatedAt: before.updatedAt,
      },
      { timeout: 90000 },
    );
    const calls = await app.evaluate(() => globalThis.replayCalls);
    assert.equal(calls.length, requests.length + 1);
    assert.deepEqual(
      calls.slice(0, 2).map((c) => c.output),
      [initialBudget, initialBudget * 2],
    );
    const task = await page.evaluate((id) => window.studio.task(id), id);
    const current = await page.evaluate(() => window.studio.load());
    assert.deepEqual(current.chapters, project.chapters);
    if (task.status === "awaiting_input")
      assert.equal(
        task.review.issues.length,
        recorded.pendingReview.issues.length,
      );
    else if (task.status === "retryable") {
      assert.equal(task.error, recorded.error);
      assert.ok(!/输出.*上限|上下文预算/.test(task.error));
      await page
        .getByRole("button", { name: "恢复上次任务", exact: true })
        .waitFor();
    } else {
      const expected = await read(path.join(live, "result.json"));
      assert.deepEqual(
        current.messages.findLast((m) => m.status === "pending").proposal,
        expected.proposal,
      );
      await page
        .getByRole("button", { name: "采纳到作品", exact: true })
        .last()
        .waitFor();
    }
    await page.screenshot({
      path: path.join(out, "desktop-result.png"),
      fullPage: true,
    });
    const saved = await read(path.join(store, "chapter-task.json"));
    assert.ok(Object.values(saved.outputBudgets).includes(initialBudget * 2));
    assert.ok(
      Object.values(saved.responseMeta).some(
        (r) => r.finishReason === "length",
      ),
    );
    await app.close();
    app = null;
    page = await launch([]);
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    const restarted = await page.evaluate((id) => window.studio.task(id), id);
    assert.equal(restarted.status, task.status);
    assert.deepEqual(restarted.review, task.review);
    assert.equal(restarted.draft, task.draft);
    assert.deepEqual(await app.evaluate(() => globalThis.replayCalls), []);
    const report = {
      version: build.displayVersion,
      status: "passed",
      source: "注入一次length，随后重放本轮真实GLM响应",
      externalCalls: 0,
      singleResume: true,
      automaticOutputBudgets: calls.slice(0, 2).map((c) => c.output),
      replayCalls: calls.length,
      finalTaskStatus: task.status,
      remainingValidationError: task.error || null,
      scope: "验证输出扩容和检查点恢复；不跳过剩余审稿校验",
      persistedAcrossRestart: true,
      formalProjectNotOpened: true,
      isolatedChaptersUnchanged: true,
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
