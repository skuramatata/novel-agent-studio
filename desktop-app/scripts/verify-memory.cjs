const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
(async () => {
  const root = path.resolve(__dirname, ".."),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-memory-ui-"));
  const { blankProject, demoProposal } = await import("../runtime/seed.mjs");
  const { applyProposal } = await import("../runtime/schema.mjs");
  const { digest, prefixHash } = await import("../runtime/memory.mjs");
  const p = applyProposal(blankProject(), demoProposal(), 0);
  p.premise.chapterWords = 2400;
  p.chapters[0].content =
    "姐姐在车站把钥匙交给陈默。他看到她手上的伤口，却不知道伤口的来源。";
  const ch = p.chapters[0];
  p.memory = {
    version: 1,
    entries: [
      {
        chapterId: ch.id,
        part: 0,
        sourceHash: digest(ch.content),
        prefixHash: prefixHash(p, ch),
        sourceStart: 0,
        sourceEnd: ch.content.length,
        sourceText: ch.content,
        summary: "姐姐在车站交出钥匙；陈默不知道伤口来源。",
        records: [
          {
            kind: "event",
            text: "姐姐在车站交出钥匙",
            entities: ["姐姐", "陈默", "钥匙"],
            storyTime: "雨夜",
            knownBy: ["陈默"],
            epistemic: "observed",
            quote: "姐姐在车站把钥匙交给陈默。",
          },
          {
            kind: "knowledge",
            text: "陈默不知道伤口来源",
            entities: ["陈默"],
            storyTime: "雨夜",
            knownBy: ["陈默"],
            epistemic: "unknown",
            quote: "却不知道伤口的来源。",
          },
        ],
      },
    ],
  };
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(p));
  await fs.writeFile(
    path.join(dir, "test.env"),
    "ZAI_CODING_CN_API_KEY=test-only\nMAIN_MODEL=glm-5.2\n",
  );
  let app;
  try {
    app = await electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [root],
      env: {
        ...process.env,
        NOVEL_AGENT_DATA_DIR: dir,
        NOVEL_AGENT_ENV: path.join(dir, "test.env"),
      },
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "故事记忆", exact: true }).click();
    await page.getByText("姐姐在车站交出钥匙", { exact: true }).waitFor();
    await page.getByLabel("记忆类型").selectOption("knowledge");
    await page.getByText("陈默不知道伤口来源", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("姐姐在车站交出钥匙", { exact: true }).count(),
      0,
    );
    await page.getByText("查看原文出处与前后文", { exact: true }).click();
    await page.getByText(ch.content, { exact: true }).waitFor();
    await page.getByLabel("搜索记忆").fill("没有这个人物");
    await page.getByText("没有匹配的记忆", { exact: true }).waitFor();
    await page.getByLabel("搜索记忆").fill("");
    await page.getByLabel("记忆类型").selectOption("");
    await fs.mkdir(path.join(root, "verification/memory-ui"), {
      recursive: true,
    });
    await page.screenshot({
      path: path.join(root, "verification/memory-ui/memory.png"),
    });
    const current = await page.evaluate(() => window.studio.load());
    await page.getByRole("button", { name: "作品管理", exact: true }).click();
    await page.getByLabel("新作品名称").fill("记忆隔离验证");
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('select[aria-label="切换作品"]')
          ?.selectedOptions[0]?.textContent === "记忆隔离验证",
    );
    await page.getByRole("button", { name: "故事记忆", exact: true }).click();
    await page.getByText("还没有正文记忆", { exact: true }).waitFor();
    await page.getByLabel("切换作品").selectOption(current.projectId);
    await page.getByText("姐姐在车站交出钥匙", { exact: true }).waitFor();
    await app.evaluate(() => {
      let failed = false;
      globalThis.fetch = async (_url, opts) => {
        const body = JSON.parse(opts.body),
          sys = body.messages[0].content,
          data = JSON.parse(body.messages[1].content);
        let content;
        if (sys.includes("设计恰好"))
          content = {
            scenes: Array.from({ length: 2 }, () => ({
              goal: "人物核查钥匙去向",
              knowledge: "仅知可观察的事件",
            })),
          };
        else if (sys.includes("仅写当前场景")) {
          if (data.sceneIndex === 2 && !failed) {
            failed = true;
            throw Error("验证用网络中断");
          }
          content =
            (data.sceneIndex === 1 ? "甲" : "乙").repeat(1200) + "〈场景完成〉";
        } else if (sys.includes("小说连续性与文学审稿员"))
          content = { issues: [] };
        else if (sys.includes("从提供的小说原文抽取"))
          content = {
            summary: "人物继续调查钥匙",
            records: [
              {
                kind: "event",
                text: "人物继续调查",
                entities: ["钥匙"],
                storyTime: "未知",
                knownBy: [],
                epistemic: "observed",
                sourceId: data.sources.find((s) => s.text.trim()).sourceId,
              },
            ],
          };
        else throw Error("未预期的验证请求");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    typeof content === "string"
                      ? content
                      : JSON.stringify(content),
                },
                finish_reason: "stop",
              },
            ],
            usage: { total_tokens: 10 },
          }),
        );
      };
    });
    await page.getByRole("button", { name: "章节阅读", exact: false }).click();
    await page.locator(".chapter-list button").nth(1).click();
    await page
      .getByRole("button", { name: "逐场景生成本章", exact: true })
      .click();
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .waitFor();
    await page
      .getByText("查看已保存的场景草稿（未采纳）", { exact: true })
      .click();
    await page.getByText("场景片段 1", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "恢复上次任务", exact: true })
      .click();
    await page
      .getByRole("button", { name: "采纳本章与记忆", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(root, "verification/memory-ui/chapter.png"),
    });
    await page
      .getByRole("button", { name: "采纳本章与记忆", exact: true })
      .click();
    await page.getByText("已采纳，作品已保存", { exact: true }).waitFor();
    const accepted = await page.evaluate(() => window.studio.load());
    assert.equal(accepted.chapters[1].content.replace(/\s/g, "").length, 2400);
    assert.ok(
      accepted.memory.entries.some(
        (e) => e.chapterId === accepted.chapters[1].id,
      ),
    );
    await page.getByRole("button", { name: "故事记忆", exact: true }).click();
    await page.getByText("人物继续调查钥匙", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          "菜单、筛选、原文出处",
          "切换作品记忆隔离",
          "真实IPC逐章生成",
          "模拟断网后恢复",
          "独立采纳章节与记忆",
        ],
        screenshot: "verification/memory-ui/memory.png",
      }),
    );
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
