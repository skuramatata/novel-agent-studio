import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizedEnvPath, readAuthorizedEnv } from "../runtime/providers.mjs";

test("开发版配置定位到项目根目录，安装版使用独立应用数据目录", () => {
  const previous = process.env.NOVEL_AGENT_ENV;
  const cwd = process.cwd();
  try {
    delete process.env.NOVEL_AGENT_ENV;
    process.chdir(tmpdir());
    assert.equal(
      authorizedEnvPath(),
      fileURLToPath(new URL("../../.env", import.meta.url)),
    );
    const dataDir = join(tmpdir(), "novel-studio-config");
    assert.equal(
      authorizedEnvPath({ packaged: true, dataDir }),
      join(dataDir, ".env"),
    );
    process.env.NOVEL_AGENT_ENV = join(tmpdir(), "explicit.env");
    assert.equal(authorizedEnvPath(), process.env.NOVEL_AGENT_ENV);
    assert.equal(
      authorizedEnvPath({ packaged: true, dataDir }),
      process.env.NOVEL_AGENT_ENV,
    );
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.NOVEL_AGENT_ENV;
    else process.env.NOVEL_AGENT_ENV = previous;
  }
});

test("读取指定配置只导入支持字段，缺失文件不回退其他项目", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-provider-env-"));
  const previous = process.env.NOVEL_AGENT_ENV;
  try {
    const path = join(dir, ".env");
    await writeFile(
      path,
      '# 本测试只使用假密钥\nexport ZAI_CODING_CN_API_KEY="glm-test-only"\nMAIN_MODEL=glm-5.2\nMINIMAX_API_KEY=mini-test-only\nUNRELATED_SECRET=unused\n',
      { mode: 0o600 },
    );
    process.env.NOVEL_AGENT_ENV = path;
    const config = await readAuthorizedEnv();
    assert.deepEqual(Object.keys(config).sort(), ["glm", "minimax"]);
    assert.equal(config.glm.apiKey, "glm-test-only");
    assert.equal(config.glm.model, "glm-5.2");
    assert.equal(config.minimax.apiKey, "mini-test-only");
    assert.ok(!JSON.stringify(config).includes("unused"));
    assert.deepEqual(await readAuthorizedEnv(join(dir, "missing.env")), {});
  } finally {
    if (previous === undefined) delete process.env.NOVEL_AGENT_ENV;
    else process.env.NOVEL_AGENT_ENV = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
