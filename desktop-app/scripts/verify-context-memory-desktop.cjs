// 隔离作品库；真实打包UI/IPC/SQLite/本地Embedding，写作模型使用测试响应。
const { _electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const root = process.cwd(),
    out = path.resolve("verification/context-memory-v3");
  const dir = await fs.mkdtemp(path.join(out, "desktop-"));
  const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  const { blankProject, demoProposal } = await import("../runtime/seed.mjs");
  const { applyProposal } = await import("../runtime/schema.mjs");
  const p = applyProposal(blankProject(), demoProposal(), 0);
  p.premise.chapterWords = 1200;
  p.chapters[0].content =
    "姐姐在车站把铜钥匙交给陈默。陈默把钥匙放进上衣口袋。\n\n昨夜下过雨，地面还没有干。";
  p.chapters[1].summary = "陈默核对铜钥匙及保管记录。";
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(p));
  await fs.writeFile(
    path.join(dir, "test.env"),
    "ZAI_CODING_CN_API_KEY=test-only\nMAIN_MODEL=glm-5.2\nMINIMAX_API_KEY=test-only\n",
  );
  const build = await read(path.join(root, "build-info.json"));
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
    const page = await app.firstWindow();
    await page.getByText(build.displayVersion, { exact: true }).waitFor();
    return page;
  };
  try {
    let page = await launch();
    await page.getByRole("button", { name: "模型连接", exact: true }).click();
    await page.locator(".model-budget-fields summary").click();
    await page.getByLabel("应用单次预算", { exact: true }).fill("48000");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.getByText("配置已保存", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "MiniMax Token Plan", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("应用单次预算", { exact: true }).inputValue(),
      "",
    );
    await page.getByLabel("应用单次预算", { exact: true }).fill("64000");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.getByText("配置已保存", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(out, "model-budget-settings.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "关闭模型设置", exact: true })
      .click();
    const original = await page.evaluate(() => window.studio.load());
    await app.evaluate(() => {
      globalThis.testModelCalls = [];
      globalThis.fetch = async (_url, opts) => {
        const body = JSON.parse(opts.body),
          sys = body.messages[0].content,
          data = JSON.parse(body.messages[1].content);
        globalThis.testModelCalls.push({
          model: body.model,
          output: body.max_tokens ?? body.max_completion_tokens,
          stage: sys.slice(0, 45),
        });
        let value;
        if (sys.includes("从提供的小说原文抽取"))
          value = {
            summary: "人物保管钥匙并核查记录",
            records: [
              {
                kind: "event",
                text: "人物核查钥匙",
                entities: ["陈默", "钥匙"],
                storyTime: "未知",
                knownBy: ["陈默"],
                epistemic: "observed",
                sourceId: data.sources.find((s) => s.text.trim()).sourceId,
                continuity: {
                  assertion: "narration",
                  actor: "陈默",
                  action: "核查",
                  object: "钥匙",
                  before: "",
                  after: "",
                  evidenceForm: "original",
                  time: null,
                },
              },
            ],
          };
        else if (sys.includes("设计恰好"))
          value = {
            scenes: [
              {
                goal: "核查钥匙",
                knowledge: "只知道手中的铜钥匙",
                time: {
                  start: "次日清晨",
                  gap: "一夜",
                  duration: "一刻",
                  end: "清晨",
                },
              },
            ],
          };
        else if (sys.includes("仅写当前场景"))
          value = "陈默检查铜钥匙。".repeat(160) + "〈场景完成〉";
        else if (sys.includes("小说连续性与文学审稿员"))
          value = {
            issues: [],
            priorFindings: [],
            authorChecks: [],
            ...(data.continuity
              ? {
                  continuityChecks: ["time", "state", "evidence"].map(
                    (dimension) => ({
                      dimension,
                      verdict: "not_applicable",
                      evidence: [],
                      explanation: "这是工程验证响应，不用于文学评价。",
                    }),
                  ),
                }
              : {}),
          };
        else throw Error("未预期的测试请求：" + sys.slice(0, 80));
        return new Response(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content:
                    typeof value === "string" ? value : JSON.stringify(value),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 100,
              total_tokens: 200,
            },
          }),
        );
      };
    });
    await page.evaluate(async (p) => {
      await window.studio.generate({
        projectId: p.projectId,
        revision: p.revision,
        provider: "glm",
        instruction: "核查本章钥匙保管",
        chapterId: p.chapters[1].id,
        words: 1200,
      });
    }, original);
    const candidate = await page.evaluate(() => window.studio.load());
    assert.equal(candidate.chapters[1].content, "");
    const proposed = candidate.messages.findLast((m) => m.status === "pending");
    assert.ok(proposed.proposal.memory.entries.length);
    const task = await read(
      path.join(dir, "projects", original.projectId, "chapter-task.json"),
    );
    assert.ok(task.retrievalIndex.chunks > 0);
    assert.ok(task.retrievedContext.sources.length > 0);
    assert.equal(task.tokenBudget.capabilities.contextLimit, 48000);
    const calls = await app.evaluate(() => globalThis.testModelCalls);
    await app.close();
    app = null;
    page = await launch();
    const settings = await page.evaluate(() => window.studio.settings());
    assert.equal(settings.glm.capabilities.contextLimit, 48000);
    assert.equal(settings.minimax.capabilities.contextLimit, 64000);
    assert.ok(
      (await page.evaluate(() => window.studio.load())).messages.some(
        (m) => m.id === proposed.id && m.status === "pending",
      ),
    );
    await page
      .getByRole("button", { name: "采纳到作品", exact: true })
      .last()
      .click();
    await page.getByText("已采纳，作品已保存", { exact: true }).waitFor();
    const accepted = await page.evaluate(() => window.studio.load());
    assert.ok(accepted.chapters[1].content);
    assert.equal(accepted.chapters[0].content, original.chapters[0].content);
    assert.ok(
      accepted.memory.entries.some(
        (e) => e.chapterId === accepted.chapters[1].id,
      ),
    );
    await page.getByRole("button", { name: "创作日志", exact: true }).click();
    await page.screenshot({
      path: path.join(out, "desktop-result.png"),
      fullPage: true,
    });
    const report = {
      status: "passed",
      version: build.displayVersion,
      isolatedData: dir,
      realLocalEmbedding: true,
      externalWritingCalls: 0,
      simulatedWritingCalls: calls.length,
      checks: [
        "预算UI与模型隔离",
        "配置重启持久化",
        "真实本地Embedding与SQLite",
        "按预算生成正文和记忆候选",
        "重启候选保留",
        "人工采纳正文和记忆",
        "前章正文保持不变",
      ],
      retrieval: task.retrievedContext.coverage,
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
