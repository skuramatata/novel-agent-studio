import test from "node:test";
import assert from "node:assert/strict";
import { providerDefaults, complete } from "../runtime/providers.mjs";
import {
  modelCapabilities,
  capabilityKey,
} from "../runtime/model-capabilities.mjs";

test("GLM默认5.3，保留1M/128K模型规格与120K应用预算", () => {
  assert.equal(providerDefaults.glm.model, "glm-5.3");
  assert.equal(
    providerDefaults.glm.baseUrl,
    "https://open.bigmodel.cn/api/coding/paas/v4",
  );
  const profile = modelCapabilities(providerDefaults.glm);
  assert.equal(profile.contextWindow, 1000000);
  assert.equal(profile.maxOutputTokens, 128000);
  assert.equal(profile.contextLimit, 120000);
  assert.equal(profile.checkedAt, "2026-09-10");
  const old = {
    ...providerDefaults.glm,
    model: "glm-5.2",
    limits: { appContextCap: 60000 },
  };
  old.limitKey = capabilityKey(old);
  assert.equal(
    modelCapabilities({ ...old, model: "glm-5.3" }).contextLimit,
    120000,
  );
});

test("GLM5.3始终开启思考，默认high，普通与增强调用一致，旧型号请求保持兼容", async () => {
  for (const [model, reasoning, type, effort] of [
    ["glm-5.3", undefined, "enabled", "high"],
    ["glm-5.3", false, "enabled", "high"],
    ["glm-5.3", true, "enabled", "high"],
    ["glm-5.2", false, "disabled", undefined],
    ["glm-5.2", true, "enabled", "high"],
  ]) {
    let sent;
    const config = { ...providerDefaults.glm, model, apiKey: "test-only" };
    const result = await complete(
      config,
      [{ role: "user", content: "连接测试" }],
      new AbortController().signal,
      async (url, request) => {
        assert.equal(
          url,
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        );
        sent = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            model,
            choices: [
              {
                message: {
                  content: "连接成功",
                  reasoning_content: "不应进入正文",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      },
      1024,
      { reasoning },
    );
    assert.equal(sent.model, model);
    assert.deepEqual(sent.thinking, { type });
    assert.equal(sent.reasoning_effort, effort);
    assert.equal(sent.max_tokens, 1024);
    assert.equal(result.text, "连接成功");
  }
});
