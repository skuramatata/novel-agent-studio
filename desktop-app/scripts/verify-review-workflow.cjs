// 仅使用隔离临时目录和模拟模型，不连接正式作品或外部接口。
const { _electron } = require("playwright");
const fs = require("fs/promises"),
  path = require("path"),
  os = require("os"),
  assert = require("assert/strict");
(async () => {
  const root = process.cwd(),
    out = path.join(root, "verification/review-workflow");
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "novel-review-workflow-"),
  );
  let app;
  async function launch(mode) {
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
    await app.evaluate((_, mode) => {
      let reviewed = mode !== "new";
      globalThis.testStages = [];
      globalThis.fetch = async (u, o) => {
        const b = JSON.parse(o.body),
          sys = b.messages[0].content,
          d = JSON.parse(b.messages[1].content);
        const authorChecks = (d.authorConstraints || []).map((c) => ({
          id: c.id,
          respected: true,
          evidence: [{ sourceId: "scene:1", paragraph: 1 }],
        }));
        let v, stage;
        if (sys.includes("设计恰好")) {
          stage = "plan";
          v = { scenes: [{ goal: "调查", knowledge: "眼前事实" }] };
        } else if (sys.includes("仅写当前场景")) {
          stage = "write";
          v = "甲".repeat(600) + "\n\n" + "乙".repeat(600) + "〈场景完成〉";
        } else if (sys.includes("小说连续性与文学审稿员")) {
          stage = "review";
          v = {
            authorChecks,
            issues: reviewed
              ? []
              : [1, 2].map((n) => ({
                  kind: "missing_history",
                  target: { sourceId: "scene:1", paragraph: n },
                  evidence: [{ sourceId: "scene:1", paragraph: n }],
                  searchedSources: d.document.sources.map((s) => s.sourceId),
                  explanation:
                    n === 1 ? "前文未交代检查。" : "前文未交代应答。",
                  resolution: "needs_confirmation",
                  fix: "核实前情",
                })),
          };
          reviewed = true;
        } else if (sys.includes("连续性裁决员")) {
          stage = "arbitration";
          v = {
            decisions: d.issues.map((i) => ({
              issueId: i.id,
              action: "needs_confirmation",
              evidenceIndexes: [],
              reason: "关键前情需要作者取舍",
            })),
          };
        } else if (sys.includes("小说段落修订编辑")) {
          stage = "patch";
          v = {
            baseVersion: d.document.version,
            replacements: d.issues.map((i) => ({
              sourceId: "scene:1",
              paragraph: i.target.paragraph,
              issueIds: [i.id],
              replacement: (i.target.paragraph === 1 ? "改" : "修").repeat(600),
            })),
          };
        } else if (sys.includes("独立补丁复核员")) {
          stage = "verify";
          v =
            mode === "fail"
              ? { checks: [] }
              : {
                  authorChecks,
                  checks: d.issues.map((i) => ({
                    issueId: i.id,
                    resolved: true,
                    preservedFacts: true,
                    noUnsupportedAdditions: true,
                    downstreamConsistent: true,
                    evidence: [i.target],
                    explanation: "作者取舍已执行",
                  })),
                };
        } else if (sys.includes("从提供的小说原文抽取")) {
          stage = "memory";
          v = {
            summary: "按裁定修订",
            records: [
              {
                kind: "event",
                text: "调查",
                entities: [],
                storyTime: "未知",
                knownBy: [],
                epistemic: "observed",
                quote: d.source.slice(0, 20),
              },
            ],
          };
        } else throw Error("未预期调用 " + sys.slice(0, 20));
        globalThis.testStages.push(stage);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: typeof v === "string" ? v : JSON.stringify(v),
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      };
    }, mode);
    return app.firstWindow();
  }
  try {
    await fs.mkdir(out, { recursive: true });
    const { blankProject, demoProposal } = await import(
      path.join(root, "runtime/seed.mjs")
    );
    const { applyProposal } = await import(
      path.join(root, "runtime/schema.mjs")
    );
    const p = applyProposal(blankProject(), demoProposal(), 0);
    p.premise.chapterWords = 1200;
    await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(p));
    await fs.writeFile(
      path.join(dir, "test.env"),
      "ZAI_CODING_CN_API_KEY=test-only\nMAIN_MODEL=glm-5.2\n",
    );
    let page = await launch("new");
    await page.getByLabel("创作请求", { exact: true }).fill("继续");
    await page.getByLabel("发送创作请求", { exact: true }).click();
    await page.getByText(/需要你确认一个情节（1\/2）/).waitFor();
    const before = await app.evaluate(() => globalThis.testStages.length);
    await page
      .getByLabel("创作请求", { exact: true })
      .fill("删除这次没有交代的检查。");
    await page.getByLabel("发送创作请求", { exact: true }).click();
    await page.getByText(/需要你确认一个情节（2\/2）/).waitFor();
    assert.equal(
      await app.evaluate(() => globalThis.testStages.length),
      before,
    );
    await app.close();
    app = null;
    page = await launch("fail");
    await page.getByText(/需要你确认一个情节（2\/2）/).waitFor();
    const request = await page.evaluate(async () => {
      const p = await window.studio.load(),
        t = await window.studio.task(p.projectId);
      return {
        projectId: p.projectId,
        revision: p.revision,
        provider: "glm",
        instruction: "回答",
        resume: true,
        decision: {
          taskId: t.id,
          pendingId: t.review.id,
          choices: [{ issueId: t.review.issues[1].id, optionId: "remove" }],
        },
      };
    });
    await page
      .getByRole("button", { name: "删除无出处的前情", exact: false })
      .click();
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .waitFor();
    const failed = await page.evaluate(async () => {
      const p = await window.studio.load();
      return { p, t: await window.studio.task(p.projectId) };
    });
    assert.equal(failed.t.status, "retryable");
    assert.equal(failed.t.reviewProgress.phase, "verify");
    assert.equal(failed.t.review, null);
    assert.equal(failed.p.chapters[0].content, "");
    assert.equal(
      failed.p.messages.filter((m) => m.id.startsWith("review-answer-")).length,
      2,
    );
    assert.deepEqual(await app.evaluate(() => globalThis.testStages), [
      "patch",
      "verify",
      "verify",
    ]);
    await page.locator(".review-progress > summary").click();
    await page.screenshot({ path: path.join(out, "retry-in-chat.png") });
    // 丢失应答后的原始请求重发：旧 revision 仍然确认收讫，不再调用模型。
    const replay = await page.evaluate(
      (r) => window.studio.generate(r),
      request,
    );
    assert.equal(replay.revision, failed.p.revision);
    assert.equal(await app.evaluate(() => globalThis.testStages.length), 3);
    await app.close();
    app = null;
    page = await launch("resume");
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .click();
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .last()
      .waitFor();
    assert.deepEqual(await app.evaluate(() => globalThis.testStages), [
      "verify",
      "review",
      "memory",
    ]);
    const candidate = await page.evaluate(() => window.studio.load());
    assert.equal(candidate.chapters[0].content, "");
    assert.equal(
      candidate.messages.filter((m) => m.id.startsWith("review-answer-"))
        .length,
      2,
    );
    assert.ok(
      candidate.messages.find((m) => m.status === "pending").proposal.memory
        .entries.length,
    );
    await page.evaluate((r) => window.studio.generate(r), request);
    assert.equal(await app.evaluate(() => globalThis.testStages.length), 3);
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .last()
      .click();
    await page.waitForFunction(
      async () =>
        (await window.studio.load()).chapters[0].content.length === 1202,
    );
    await page.getByRole("button", { name: "创作日志", exact: true }).click();
    await page.getByText("候选已采纳到作品", { exact: true }).waitFor();
    const logData = await page.evaluate(async () => {
      const p = await window.studio.load();
      return window.studio.logs(p.projectId);
    });
    for (const category of ["writing", "review", "memory", "adoption"])
      assert.ok(logData.events.some((e) => e.category === category));
    assert.ok(logData.events.some((e) => e.title.includes("恢复已有任务")));
    await page
      .getByLabel("按创作阶段筛选", { exact: true })
      .selectOption("review");
    await page.getByLabel("仅异常与等待", { exact: true }).check();
    await page.getByLabel("搜索创作日志", { exact: true }).fill("validation");
    await page
      .locator(".creation-event strong")
      .filter({ hasText: "校验未通过" })
      .first()
      .waitFor();
    await page.screenshot({
      path: path.join(out, "creation-logs-filtered.png"),
    });
    // 新任务归档旧任务，重启后仍能选择并查看已采纳记录。
    await page.evaluate(async () => {
      const p = await window.studio.load();
      await window.studio.generate({
        projectId: p.projectId,
        revision: p.revision,
        provider: "glm",
        instruction: "整理记忆",
        mode: "memory",
      });
    });
    await app.close();
    app = null;
    page = await launch("resume");
    await page.getByRole("button", { name: "创作日志", exact: true }).click();
    await page
      .getByText("已采纳正文的记忆索引已保存", { exact: true })
      .waitFor();
    await page
      .getByLabel("选择日志任务", { exact: true })
      .selectOption(request.decision.taskId);
    await page.getByText("候选已采纳到作品", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(out, "creation-logs-history.png"),
    });
    await page.evaluate(() => window.studio.create("日志隔离验证"));
    await page.reload();
    await page.getByRole("button", { name: "创作日志", exact: true }).click();
    await page.getByText("还没有创作任务", { exact: true }).waitFor();
    assert.equal(await page.locator(".creation-event").count(), 0);
    const info = JSON.parse(
      await fs.readFile(path.join(root, "build-info.json"), "utf8"),
    );
    await page
      .getByText(info.displayVersion, { exact: false })
      .first()
      .waitFor();
    const report = {
      version: info.displayVersion,
      partialAnswerRestart: true,
      noModelUntilAllAnswered: true,
      technicalFailureInChat: true,
      duplicateAnswerNoop: true,
      restartResumesOnlyVerification: true,
      authorAnswersPreserved: 2,
      candidateMemoryAndAccept: true,
      creationLogFilters: true,
      creationLogArchiveAndRestart: true,
      creationLogProjectIsolation: true,
    };
    await fs.writeFile(
      path.join(out, "ui-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(report);
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
