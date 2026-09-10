// 隔离作品 + 实际打包应用、IPC、存储与恢复；仅模型网络返回使用确定性测试桩。
const { _electron } = require("playwright");
const { expect } = require("playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const root = path.resolve(__dirname, "..");
  const out = path.join(root, "verification/rewrite");
  await fs.mkdir(out, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-rewrite-ui-"));
  const { blankProject, demoProposal } = await import("../runtime/seed.mjs");
  const { applyProposal } = await import("../runtime/schema.mjs");
  const initial = applyProposal(blankProject(), demoProposal(), 0);
  initial.premise.title = "全部重写验收作品";
  initial.premise.chapterCount = 2;
  initial.premise.chapterWords = 200;
  initial.chapters = initial.chapters
    .slice(0, 2)
    .map((c) => ({ ...c, content: "禁止进入新轮次的旧正文" }));
  initial.messages = [
    {
      id: "old-candidate",
      role: "assistant",
      text: "旧候选",
      status: "pending",
      baseRevision: initial.revision,
      proposal: { summary: "旧方案" },
    },
  ];
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(initial));
  await fs.writeFile(
    path.join(dir, "test.env"),
    "ZAI_CODING_CN_API_KEY=isolated-test-only\nMAIN_MODEL=glm-5.3\n",
  );
  const executablePath = path.join(
    root,
    "release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app/Contents/MacOS/NovelAgentStudio",
  );
  let app, page;
  const errors = [];
  const launch = async (hold) => {
    app = await _electron.launch({
      executablePath,
      env: {
        ...process.env,
        NOVEL_AGENT_DATA_DIR: dir,
        NOVEL_AGENT_ENV: path.join(dir, "test.env"),
      },
    });
    await app.evaluate((_electron, hold) => {
      globalThis.rewriteRequests = [];
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        const sys = body.messages[0].content;
        const data = JSON.parse(body.messages[1].content);
        globalThis.rewriteRequests.push(body);
        if (JSON.stringify(body).includes("禁止进入新轮次的旧正文"))
          throw Error("旧正文进入请求");
        if (hold) {
          options.signal.throwIfAborted();
          return new Promise((_, reject) =>
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            ),
          );
        }
        let value;
        if (sys.includes("识别规划入口"))
          value = {
            mode: "prepare",
            chapterCount: null,
            chapterWords: null,
            countEvidence: "",
            wordsEvidence: "",
          };
        else if (sys.includes("补齐故事基础规划"))
          value = {
            plan: {
              outline: "新故事：主动调查。",
              truth: "新真相。",
              timeline: "首日调查，次日离开。",
              reveals: "首章提出疑点，第二章回收。",
            },
            characters: [],
            relations: [],
          };
        else if (sys.includes("生成指定章节"))
          value = {
            chapters: data.numbers.map((number) => ({
              number,
              title: "新章" + number,
              summary: "人物发现新证据，调查并承担行动后果。",
            })),
          };
        else if (sys.includes("设计恰好"))
          value = {
            scenes: [
              {
                goal: "调查新证据",
                knowledge: "只知眼前事实",
                time: {
                  start: "首日上午",
                  gap: "故事开始",
                  duration: "约一小时",
                  end: "首日上午稍后",
                },
              },
            ],
          };
        else if (sys.includes("仅写当前场景"))
          value =
            "新".repeat(Number(sys.match(/目标约(\d+)字/)[1])) +
            "\n〈场景完成〉";
        else if (sys.includes("从提供的小说原文抽取"))
          value = { summary: "新一轮正文摘要", records: [] };
        else if (sys.includes("本轮只执行时间"))
          value = {
            dimensions: ["time", "state", "evidence"].map((dimension) => ({
              dimension,
              verdict: "not_applicable",
              evidence: [],
              explanation: "测试正文无此类事实",
            })),
            authorChecks: (data.authorConstraints || []).map((c) => ({
              id: c.id,
              respected: true,
              evidence: [{ sourceId: "scene:1", paragraph: 1 }],
            })),
          };
        else if (sys.includes("小说连续性与文学审稿员"))
          value = {
            issues: [],
            authorChecks: (data.authorConstraints || []).map((c) => ({
              id: c.id,
              respected: true,
              evidence: [{ sourceId: "scene:1", paragraph: 1 }],
            })),
          };
        else throw Error("未处理的模型阶段：" + sys.slice(0, 120));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    typeof value === "string" ? value : JSON.stringify(value),
                },
                finish_reason: "stop",
              },
            ],
            usage: { total_tokens: 10 },
          }),
        );
      };
    }, hold);
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByLabel("切换作品").waitFor();
  };
  try {
    await launch(true);
    const old = await page.evaluate(() => window.studio.load());
    await page.getByRole("button", { name: "全部重写", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.deepEqual(await page.evaluate(() => window.studio.load()), old);
    await page.getByRole("button", { name: "全部重写", exact: true }).click();
    await page
      .getByLabel("本轮重写要求（选填）")
      .fill("人物主动追问，减少重复描写。");
    await page.screenshot({ path: path.join(out, "01-confirm.png") });
    await page
      .getByRole("button", { name: "备份旧稿并开始重写", exact: true })
      .click();
    await expect
      .poll(() => app.evaluate(() => globalThis.rewriteRequests.length))
      .toBeGreaterThan(0);
    await expect(
      page.getByRole("button", { name: "全部重写", exact: true }),
    ).toBeDisabled();
    const reset = await page.evaluate(() => window.studio.load());
    assert.equal(reset.projectId, old.projectId);
    assert.deepEqual(reset.chapters, []);
    for (const field of ["author", "premise", "characters", "relations"])
      assert.deepEqual(reset[field], old[field]);
    const blocked = await page.evaluate(async (p) => {
      try {
        await window.studio.rewrite(p.projectId, p.revision, "");
        return "";
      } catch (e) {
        return e.message;
      }
    }, reset);
    assert.match(blocked, /生成结束/);
    await page
      .getByRole("button", { name: "停止生成", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .waitFor();
    const interrupted = await page.evaluate(
      (id) => window.studio.task(id),
      old.projectId,
    );
    assert.equal(interrupted.resumable, true);
    await app.close();
    app = null;
    await launch(false);
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .click();
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .waitFor();
    const plannedCandidate = await page.evaluate(() => window.studio.load());
    assert.equal(
      plannedCandidate.messages.filter((m) => m.status === "pending").length,
      1,
    );
    await page.getByRole("button", { name: "采纳到作品", exact: true }).click();
    await page
      .getByRole("button", { name: "生成第1章正文", exact: true })
      .click();
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "采纳到作品", exact: true }).click();
    await page
      .getByRole("button", { name: "生成第2章正文", exact: true })
      .waitFor();
    const first = await page.evaluate(() => window.studio.load());
    assert.ok(first.chapters[0].content);
    assert.equal(first.chapters[1].content, "");
    assert.deepEqual(first.characters, old.characters);
    assert.ok(!JSON.stringify(first.memory).includes("禁止进入新轮次的旧正文"));
    await page.screenshot({ path: path.join(out, "02-first-chapter.png") });
    await page
      .getByRole("button", { name: "生成第2章正文", exact: true })
      .click();
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "采纳到作品", exact: true }).click();
    await page.getByText("本轮章节正文已全部采纳。", { exact: true }).waitFor();
    const written = await page.evaluate(() => window.studio.load());
    assert.ok(written.chapters.every((c) => c.content));
    await page.getByRole("button", { name: "重写备份", exact: true }).click();
    await page.getByRole("button", { name: "恢复此备份", exact: true }).click();
    await page
      .getByRole("button", { name: "备份当前稿并恢复", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.studio.load())).chapters[0]
            ?.content,
      )
      .toBe("禁止进入新轮次的旧正文");
    const restored = await page.evaluate(() => window.studio.load());
    assert.deepEqual(restored.chapters, old.chapters);
    assert.equal(restored.messages[0].status, "rejected");
    assert.equal(
      await page.evaluate((id) => window.studio.task(id), old.projectId),
      null,
    );
    const backups = await page.evaluate(
      (id) => window.studio.rewriteBackups(id),
      old.projectId,
    );
    assert.equal(backups.length, 2);
    for (const name of ["章节阅读", "作品管理", "创作对话"]) {
      await page.locator("nav button").filter({ hasText: name }).click();
      await page
        .getByRole("button", { name: "全部重写", exact: true })
        .waitFor();
    }
    await page.getByRole("button", { name: "重写备份", exact: true }).click();
    await page.screenshot({ path: path.join(out, "03-restored.png") });
    const build = JSON.parse(
      await fs.readFile(path.join(root, "build-info.json"), "utf8"),
    );
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(out, "result.json"),
      JSON.stringify(
        {
          version: build.displayVersion,
          passed: true,
          checks: [
            "取消不变更",
            "备份后重写",
            "保留设定与人物",
            "生成中前后端拦截",
            "停止并重启恢复规划",
            "采纳新规划",
            "生成并采纳两章与新记忆",
            "恢复旧稿并保留重写稿",
            "旧任务隔离",
            "三个入口可见",
          ],
          model: "确定性测试桩，无外部模型调用",
          dataDir: dir,
        },
        null,
        2,
      ),
    );
    console.log("全部重写桌面验收通过：" + build.displayVersion);
  } catch (e) {
    if (page)
      await page
        .screenshot({ path: path.join(out, "failure.png") })
        .catch(() => {});
    console.error("隔离数据目录：" + dir);
    throw e;
  } finally {
    if (app) await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
