// 独立作品库、模拟模型；验证真实 IPC、时间线、辅助流程图和打包后的页面。
const { _electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

(async () => {
  const root = path.resolve(__dirname, "..");
  const out = path.join(root, "verification/execution-logs");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "novel-execution-ui-"),
  );
  const errors = [];
  let app, page;
  try {
    await fs.mkdir(out, { recursive: true });
    const { blankProject, demoProposal } = await import("../runtime/seed.mjs");
    const { applyProposal } = await import("../runtime/schema.mjs");
    const { ProjectLibrary } = await import("../runtime/library.mjs");
    const { Checkpoint } = await import("../runtime/checkpoint.mjs");
    const { runChapterAgent } = await import("../runtime/chapter-agent.mjs");
    const seed = applyProposal(blankProject(), demoProposal(), 0);
    seed.chapters = [];
    seed.premise.chapterCount = 6;
    await fs.writeFile(
      path.join(directory, "project.json"),
      JSON.stringify(seed),
    );
    const library = new ProjectLibrary(directory);
    const project = await library.load();
    const runtime = await library.runtimeDirectoryFor(project.projectId);
    const cp = new Checkpoint(runtime);
    const config = {
      provider: "glm",
      model: "glm-5.2",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "test-only",
    };
    const state = await cp.begin(
      project,
      { instruction: "完善六章故事规划，保留人物的知情边界。" },
      config,
    );
    let intents = 0;
    await runChapterAgent(
      project,
      config,
      new AbortController().signal,
      () => {},
      cp,
      state,
      async (_, options) => {
        const request = JSON.parse(options.body);
        let value;
        if (request.messages[0].content.includes("识别规划入口"))
          value = {
            mode: ++intents === 1 ? "invalid" : "prepare",
            chapterCount: null,
            chapterWords: null,
            countEvidence: "",
            wordsEvidence: "",
          };
        else
          value = {
            chapters: JSON.parse(request.messages[1].content).numbers.map(
              (number) => ({
                number,
                title: `第${number}章`,
                summary: "调查门禁卡来源，人物依据已知事实采取行动。",
              }),
            ),
          };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify(value) },
                finish_reason: "stop",
              },
            ],
            model: "glm-5.2",
          }),
        );
      },
    );
    const longText =
      "已保存的历史原文，保持完整。".repeat(1800) + "原文终点标记";
    const legacy = {
      id: "legacy-log-sample",
      status: "retryable",
      stage: "历史记忆提取",
      request: { instruction: "历史任务 · 输入输出检查" },
      values: {},
      calls: 1,
      structuredSteps: {
        legacy: {
          id: "legacy",
          label: "历史记忆提取",
          status: "exhausted",
          contractId: "memory_extract",
          input: [
            {
              role: "user",
              content: JSON.stringify({
                numbers: [1, 2],
                active: true,
                empty: null,
                prompt: "门禁卡交给小李。\n保持原文。",
                unfinished: '{"unfinished":',
              }),
            },
          ],
          rawKey: "legacy-raw",
          lastFailure: {
            rawKey: "legacy-raw",
            kind: "validation",
            detail: "kind 类型不合法",
          },
        },
      },
      responseMeta: {
        "legacy-raw": { stepId: "legacy", finishReason: "stop" },
      },
      fragments: { "legacy-raw": longText },
    };
    await fs.mkdir(path.join(runtime, "task-history"), { recursive: true });
    const legacyPath = path.join(runtime, "task-history", legacy.id + ".json");
    await fs.writeFile(legacyPath, JSON.stringify(legacy));
    const legacyBefore = await fs.readFile(legacyPath, "utf8");
    const empty = await library.create("没有日志的隔离作品");
    await library.select(project.projectId);
    const launch = async () => {
      app = await _electron.launch({
        executablePath:
          process.env.NOVEL_VERIFY_EXECUTABLE ||
          path.join(
            root,
            "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
          ),
        args: process.env.NOVEL_VERIFY_EXECUTABLE ? [] : [root],
        env: {
          ...process.env,
          NOVEL_AGENT_DATA_DIR: directory,
          NOVEL_AGENT_ENV: path.join(directory, "missing.env"),
        },
      });
      page = await app.firstWindow();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "创作日志", exact: true }).click();
      await page.locator(".execution-timeline").waitFor();
    };
    await launch();
    assert.equal(
      await page
        .getByRole("button", { name: "执行时间线", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    const snapshot = await page.evaluate(async () => {
      const p = await window.studio.load();
      return window.studio.logs(p.projectId);
    });
    const intent = snapshot.flow.nodes.find((node) => node.attemptCount === 2);
    assert.ok(intent);
    assert.equal(await page.locator(".trace-detail").count(), 0);
    assert.deepEqual(
      await page
        .locator(".execution-timeline-title > strong")
        .allTextContents(),
      snapshot.flow.nodes.map((node) => node.label),
    );
    await page.locator(".execution-timeline").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, "timeline-overview.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: `展开步骤：${intent.label}`, exact: true })
      .click();
    const other = snapshot.flow.nodes.find((node) => node.id !== intent.id);
    await page
      .getByRole("button", { name: `展开步骤：${other.label}`, exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.trace-detail [role="tabpanel"]').length ===
        2,
    );
    await page
      .getByRole("button", { name: `收起步骤：${other.label}`, exact: true })
      .click();
    assert.equal(await page.locator(".trace-detail").count(), 1);
    assert.equal(
      await page
        .getByRole("button", { name: `收起步骤：${intent.label}`, exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    await page.getByLabel("选择节点尝试").selectOption({ index: 0 });
    await page.getByRole("tab", { name: "校验与错误", exact: true }).click();
    await page
      .getByRole("tabpanel")
      .getByText(/Invalid option/)
      .waitFor();
    await page.getByRole("tab", { name: "接收结果", exact: true }).click();
    await page
      .getByText("本次结果未被接收。请查看原始输出与校验原因。")
      .waitFor();
    await page.getByLabel("选择节点尝试").selectOption({ index: 1 });
    await page
      .getByRole("tabpanel")
      .locator(".log-json")
      .filter({ hasText: '"mode": "prepare"' })
      .waitFor();
    await page.getByRole("tab", { name: "模型请求", exact: true }).click();
    await page
      .getByRole("tabpanel")
      .locator(".log-json")
      .filter({ hasText: '"stream": true' })
      .waitFor();
    await page.getByRole("tab", { name: "接收结果", exact: true }).click();
    await page
      .locator(".execution-timeline-card")
      .filter({ has: page.locator(".trace-detail") })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, "timeline-expanded.png"),
      fullPage: true,
    });
    await page.getByRole("tab", { name: "原始输出", exact: true }).click();
    await page
      .getByRole("region", { name: "JSON 数据" })
      .filter({ hasText: '"mode": "prepare"' })
      .waitFor();
    await page.getByRole("button", { name: "节点流程", exact: true }).click();
    await page.getByLabel("定位执行节点").selectOption(intent.id);
    await page.getByRole("tab", { name: "模型请求", exact: true }).click();
    await page
      .getByRole("tabpanel")
      .locator(".log-json")
      .filter({ hasText: '"stream": true' })
      .waitFor();
    // 点击实际画布节点；不是只通过下拉选择验证。
    const target = page.locator(".react-flow__node.selected");
    await target.click();
    await page
      .locator(".trace-detail h2")
      .filter({ hasText: intent.label })
      .waitFor();
    await page.screenshot({
      path: path.join(out, "flow-request.png"),
      fullPage: true,
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1080, 760),
    );
    await page.waitForFunction(() => {
      const canvas = document
        .querySelector(".execution-flow-canvas")
        .getBoundingClientRect();
      const node = document
        .querySelector(".react-flow__node.selected")
        .getBoundingClientRect();
      return (
        node.top >= canvas.top &&
        node.bottom <= canvas.bottom &&
        node.left >= canvas.left &&
        node.right <= canvas.right
      );
    });
    await page.getByRole("button", { name: "执行时间线", exact: true }).click();
    await page.getByLabel("搜索创作日志").fill("invalid");
    await page.waitForFunction(
      () => document.querySelectorAll(".execution-timeline-item").length === 1,
    );
    await page.getByLabel("搜索创作日志").fill("");
    await page.getByLabel("仅异常与等待").check();
    await page.waitForFunction(
      () => document.querySelectorAll(".execution-timeline-item").length === 1,
    );
    await page.getByLabel("仅异常与等待").uncheck();
    await page.getByRole("button", { name: "事件记录", exact: true }).click();
    await page.locator(".creation-event").first().waitFor();
    await page.getByRole("button", { name: "执行时间线", exact: true }).click();
    await page.getByLabel("选择日志任务").selectOption(legacy.id);
    await page.getByText("时间未采集", { exact: true }).waitFor();
    assert.equal(await page.locator(".trace-detail").count(), 0);
    await page
      .getByRole("button", { name: "展开步骤：历史记忆提取", exact: true })
      .click();
    await page.getByRole("tab", { name: "模型请求", exact: true }).click();
    await page
      .getByRole("tabpanel")
      .getByText("最终模型请求未采集", { exact: true })
      .waitFor();
    await page.getByRole("tab", { name: "原始输出", exact: true }).click();
    const raw = page.getByRole("tabpanel").locator("pre");
    assert.equal(await raw.textContent(), longText);
    const scrolled = await raw.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop > 0;
    });
    assert.equal(scrolled, true);
    // 仅截获复制参数，不覆盖用户的系统剪贴板。
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          window.copiedLogText = text;
        },
      }),
    );
    await page.getByRole("button", { name: "复制全文", exact: true }).click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        (expected) => window.copiedLogText === expected,
        longText,
      ),
      true,
    );
    await raw.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, "legacy-full-output.png"),
      fullPage: true,
    });
    assert.equal(
      await page
        .locator(".creation-logs")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.getByRole("tab", { name: "节点输入", exact: true }).click();
    const contentBranch = page.locator('.log-json [data-json-field="content"]');
    await contentBranch.locator(":scope > summary").click();
    await contentBranch
      .locator('[data-json-field="numbers"] > summary')
      .click();
    await contentBranch
      .locator('[data-json-field="numbers"] .log-json-number')
      .first()
      .waitFor();
    assert.equal(
      await contentBranch
        .locator('[data-json-field="numbers"] .log-json-number')
        .allTextContents()
        .then((values) => values.join(",")),
      "1,2",
    );
    assert.equal(
      await contentBranch
        .locator('[data-json-field="prompt"] .log-json-string')
        .textContent(),
      '"门禁卡交给小李。\n保持原文。"',
    );
    assert.equal(
      await contentBranch
        .locator('[data-json-field="unfinished"] .log-json-string')
        .textContent(),
      '"{\"unfinished\":"',
    );
    await page.getByRole("button", { name: "复制全文", exact: true }).click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        (expected) => window.copiedLogText === expected,
        JSON.stringify(legacy.structuredSteps.legacy.input, null, 2),
      ),
      true,
    );
    await page.locator(".execution-timeline-card").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, "nested-json.png"),
      fullPage: true,
    });
    await contentBranch.locator(":scope > summary").click();
    await contentBranch
      .locator('[data-json-field="numbers"]')
      .waitFor({ state: "detached" });
    assert.equal(
      await contentBranch.locator('[data-json-field="numbers"]').count(),
      0,
    );
    await page.getByLabel("切换作品").selectOption(empty.projectId);
    await page.getByText("还没有创作任务", { exact: true }).waitFor();
    assert.equal(await page.locator(".trace-detail h2").count(), 0);
    await page.getByLabel("切换作品").selectOption(project.projectId);
    await page.locator(".execution-timeline").waitFor();
    await page.getByRole("button", { name: "故事记忆", exact: true }).click();
    await page.getByRole("button", { name: "创作日志", exact: true }).click();
    await page.locator(".execution-timeline").waitFor();
    await app.close();
    app = null;
    await launch();
    await page.getByLabel("选择日志任务").selectOption(legacy.id);
    await page
      .getByRole("button", { name: "展开步骤：历史记忆提取", exact: true })
      .click();
    await page.getByRole("tab", { name: "原始输出", exact: true }).click();
    assert.equal(
      await page.getByRole("tabpanel").locator("pre").textContent(),
      longText,
    );
    assert.equal(await fs.readFile(legacyPath, "utf8"), legacyBefore);
    assert.deepEqual(errors, []);
    const buildInfo = JSON.parse(
      await fs.readFile(path.join(root, "build-info.json"), "utf8"),
    );
    assert.ok(
      (await page.locator(".version").innerText()).includes(
        buildInfo.displayVersion,
      ),
    );
    const report = {
      version: buildInfo.displayVersion,
      packaged: !!process.env.NOVEL_VERIFY_EXECUTABLE,
      simulatedModel: true,
      nodes: snapshot.flow.nodes.length,
      defaultTimeline: true,
      inlineExpansion: true,
      multipleExpanded: true,
      timelineOrder: true,
      nodeSelection: true,
      attempts: true,
      finalRequest: true,
      structuredJson: true,
      rawJsonString: true,
      nestedJsonExpansion: true,
      multilineAndInvalidJsonPreserved: true,
      structuredCopyPreservesOriginal: true,
      failedAcceptance: true,
      fullOutputAndCopy: true,
      searchAndProblemFilter: true,
      eventView: true,
      narrowViewport: true,
      resizeKeepsSelectedNodeVisible: true,
      projectIsolation: true,
      navigationAndRestart: true,
      legacyReadOnly: true,
      pageErrors: errors,
    };
    await fs.writeFile(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (page)
      await page
        .screenshot({ path: path.join(out, "failure.png"), fullPage: true })
        .catch(() => {});
    throw error;
  } finally {
    if (app) await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
