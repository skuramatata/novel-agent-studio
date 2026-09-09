// 在隔离作品库中重放真实 GLM 响应，检查打包应用一次恢复、候选展示、重启和采纳。
// 不连接正式作品目录，不发起外部模型请求。需要本机 Playwright。
const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const root = process.cwd();
  const out = path.resolve(
    root,
    process.argv[2] || "verification/review-grounding-fix",
  );
  const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const live = path.join(out, "live");
  const before = await read(path.join(live, "task.before.json"));
  const recorded = await read(path.join(live, "chapter-task.json"));
  const project = await read(path.join(live, "project.before.json"));
  const expected = await read(path.join(live, "result.json"));
  const build = await read(path.join(root, "build-info.json"));
  const replies = Object.entries(recorded.fragments)
    .filter(
      ([key]) =>
        (key.startsWith("raw:") ||
          key.startsWith("raw-scene:") ||
          key.startsWith("raw-repair:")) &&
        !Object.hasOwn(before.fragments, key),
    )
    .map(([key, text]) => ({
      text,
      stage: key.startsWith("raw-scene:")
        ? "write"
        : key.startsWith("raw-repair:")
          ? "resize"
          : key.includes(":grounding:")
            ? "grounding"
            : key.includes(":verify:")
              ? "verify"
              : key.includes(":review:")
                ? "review"
                : key.startsWith("raw:memory:")
                  ? "memory"
                  : "patch",
    }));
  assert.equal(replies.length, recorded.calls - before.calls);
  const dir = await fs.mkdtemp(path.join(out, "desktop-replay-"));
  const id = "repair-plan-verification";
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
      globalThis.replayStages = [];
      globalThis.fetch = async (_url, options) => {
        const sys = JSON.parse(options.body).messages[0].content;
        const stage = sys.includes("仅写当前场景")
          ? "write"
          : sys.includes("当前场景已结束但字数")
            ? "resize"
            : sys.includes("独立修订依据核对员")
              ? "grounding"
              : sys.includes("独立补丁复核员")
                ? "verify"
                : sys.includes("小说连续性与文学审稿员")
                  ? "review"
                  : sys.includes("从提供的小说原文抽取")
                    ? "memory"
                    : sys.includes("小说段落修订编辑")
                      ? "patch"
                      : "unexpected";
        const reply = responses[globalThis.replayStages.length];
        globalThis.replayStages.push(stage);
        if (!reply || reply.stage !== stage)
          throw Error(`重放阶段不匹配：预期${reply?.stage}，实际${stage}`);
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: reply.text }, finish_reason: "stop" },
            ],
          }),
        );
      };
    }, responses);
    return app.firstWindow();
  };
  try {
    let page = await launch(replies);
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .click();
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .last()
      .waitFor({ timeout: 90000 });
    const stages = await app.evaluate(() => globalThis.replayStages);
    assert.equal(stages.length, replies.length);
    assert.equal(stages[0], replies[0].stage);
    assert.ok(["grounding", "write"].includes(stages[0]));
    const current = await page.evaluate(() => window.studio.load());
    const candidate = current.messages.findLast((m) => m.status === "pending");
    const chapter = candidate.proposal.chapters.find(
      (c) => c.id === before.chapterId,
    );
    assert.equal(
      chapter.content,
      expected.proposal.chapters.find((c) => c.id === before.chapterId).content,
    );
    assert.equal(
      current.chapters.find((c) => c.id === before.chapterId).content,
      "",
    );
    assert.ok(
      candidate.proposal.memory.entries.some(
        (e) => e.chapterId === before.chapterId,
      ),
    );
    const task = await page.evaluate((id) => window.studio.task(id), id);
    assert.equal(task.status, "completed");
    assert.equal(task.reviewProgress.phase, "completed");
    await page.screenshot({
      path: path.join(out, "candidate-completed.png"),
      fullPage: true,
    });
    await app.close();
    app = null;
    page = await launch([]);
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .last()
      .waitFor();
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .last()
      .click();
    await page.waitForFunction(
      async ({ id, content }) =>
        (await window.studio.load()).chapters.find((c) => c.id === id)
          ?.content === content,
      { id: before.chapterId, content: chapter.content },
    );
    const adopted = await page.evaluate(() => window.studio.load());
    for (const original of project.chapters.filter(
      (c) => c.id !== before.chapterId,
    ))
      assert.equal(
        adopted.chapters.find((c) => c.id === original.id).content,
        original.content,
      );
    assert.deepEqual(await app.evaluate(() => globalThis.replayStages), []);
    const report = {
      version: build.displayVersion,
      status: "passed",
      singleResume: true,
      responseSource: "真实GLM响应离线重放",
      externalCalls: 0,
      replayedCalls: stages.length,
      stages,
      chapterCharacters: chapter.content.length,
      candidatePersistedAcrossRestart: true,
      adoptedInIsolatedLibrary: true,
      otherChaptersUnchanged: true,
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
