// 只启动独立数据目录中的验证实例，不退出或替换用户正在运行的应用。
const { _electron } = require("playwright");
const { extractFile } = require("@electron/asar");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const root = process.cwd();
  const out = path.join(root, "verification/continuity-v1/desktop");
  await fs.mkdir(out, { recursive: true });
  const bundle = path.join(
    root,
    "release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app",
  );
  const archive = path.join(bundle, "Contents/Resources/app.asar");
  const info = JSON.parse(await fs.readFile("build-info.json", "utf8"));
  const packed = JSON.parse(extractFile(archive, "build-info.json").toString());
  assert.deepEqual(packed, info);
  assert.equal(
    JSON.parse(extractFile(archive, "package.json").toString()).version,
    info.version,
  );
  for (const file of [
    "continuity.mjs",
    "continuity-schema.mjs",
    "chapter-agent.mjs",
    "memory.mjs",
    "memory-schema.mjs",
    "paragraph-review.mjs",
    "review-resolution.mjs",
    "repair-plan.mjs",
    "checkpoint.mjs",
  ]) {
    assert.equal(
      extractFile(archive, `runtime/${file}`).toString(),
      await fs.readFile(path.join(root, "runtime", file), "utf8"),
    );
  }
  const directory = await fs.mkdtemp(path.join(out, "data-"));
  const envFile = path.join(directory, "test.env");
  await fs.writeFile(
    envFile,
    "ZAI_CODING_CN_API_KEY=verification-only\nMAIN_MODEL=glm-5.2\n",
    { mode: 0o600 },
  );
  let app;
  try {
    app = await _electron.launch({
      executablePath: path.join(bundle, "Contents/MacOS/NovelAgentStudio"),
      env: {
        ...process.env,
        NOVEL_AGENT_DATA_DIR: directory,
        NOVEL_AGENT_ENV: envFile,
      },
      timeout: 30000,
    });
    const page = await app.firstWindow();
    await page
      .getByText(info.displayVersion, { exact: true })
      .waitFor({ timeout: 20000 });
    const windowTitle = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getTitle(),
    );
    assert.ok(windowTitle.includes(info.displayVersion));
    await page.screenshot({
      path: path.join(out, "version.png"),
      fullPage: true,
    });
    const report = {
      passed: true,
      displayVersion: info.displayVersion,
      packagedMetadataMatches: true,
      runtimeMatches: true,
      visibleVersionMatches: true,
      windowTitle,
      isolatedDataDirectory: directory,
    };
    await fs.writeFile(
      path.join(out, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    if (app) await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
