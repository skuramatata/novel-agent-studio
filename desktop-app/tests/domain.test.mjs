import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject, demoProposal, demoChapter } from "../runtime/seed.mjs";
import {
  applyProposal,
  projectSchema,
  readyForChapter,
} from "../runtime/schema.mjs";
import { ProjectStore } from "../runtime/storage.mjs";
import { complete, validateProvider } from "../runtime/providers.mjs";
import { runAgent } from "../runtime/agent.mjs";
const planned = () => applyProposal(blankProject(), demoProposal(), 0);
test("规划可以采纳，但同一候选重复采纳会版本冲突", () => {
  const p = planned();
  assert.equal(p.premise.title, "潮声之外");
  assert.equal(readyForChapter(p), true);
  assert.throws(() => applyProposal(p, demoProposal(), 0), /过期/);
});
test("未采纳规划不能同轮直接生成正文", () => {
  const p = demoProposal();
  p.chapters[0].content = demoChapter;
  assert.throws(() => applyProposal(blankProject(), p, 0), /先采纳/);
});
test("正文只读：首次新增允许，后续修改或删除拒绝", () => {
  let p = planned();
  p = applyProposal(
    p,
    {
      summary: "正文",
      chapters: p.chapters.map((c, i) =>
        i === 0 ? { ...c, content: demoChapter } : c,
      ),
    },
    p.revision,
  );
  assert.throws(
    () =>
      applyProposal(
        p,
        {
          summary: "修改",
          chapters: p.chapters.map((c, i) =>
            i === 0 ? { ...c, content: "新正文" } : c,
          ),
        },
        p.revision,
      ),
    /不支持修改/,
  );
  assert.throws(
    () =>
      applyProposal(
        p,
        { summary: "删除", chapters: p.chapters.slice(1) },
        p.revision,
      ),
    /不支持修改/,
  );
});
test("关系必须连接不同且存在的人物，章节号不能重复", () => {
  const p = planned();
  assert.throws(() =>
    projectSchema.parse({
      ...p,
      relations: [{ ...p.relations[0], target: "不存在" }],
    }),
  );
  assert.throws(() =>
    projectSchema.parse({
      ...p,
      chapters: [p.chapters[0], { ...p.chapters[1], number: 1 }],
    }),
  );
});
test("文件存储重启恢复、旧版本拒绝、损坏文件不覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-store-"));
  try {
    const s = new ProjectStore(dir);
    const p = await s.load();
    await s.save({ ...p, premise: { ...p.premise, title: "恢复测试" } }, 0);
    assert.equal(
      (await new ProjectStore(dir).load()).premise.title,
      "恢复测试",
    );
    await assert.rejects(() => s.save(p, 0), /冲突/);
    await writeFile(join(dir, "project.json"), "broken");
    await assert.rejects(() => new ProjectStore(dir).load(), /损坏/);
    assert.equal(await readFile(join(dir, "project.json"), "utf8"), "broken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("供应商拒绝第三方地址、跨系列模型及计费回退", () => {
  assert.throws(() =>
    validateProvider({
      provider: "glm",
      model: "glm-5.2",
      baseUrl: "https://evil.test/v1",
    }),
  );
  assert.throws(() =>
    validateProvider({
      provider: "glm",
      model: "glm-5.2",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    }),
  );
  assert.throws(() =>
    validateProvider({
      provider: "minimax",
      model: "other-model",
      baseUrl: "https://api.minimaxi.com/v1",
    }),
  );
});
const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "test-only",
};
const response = (text) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { total_tokens: 100 },
    }),
  );
test("接口报错不暴露密钥，业务错误与输出截断不能当成功", async () => {
  await assert.rejects(
    () =>
      complete(
        config,
        [],
        undefined,
        async () => new Response("test-only", { status: 401 }),
      ),
    (e) => e.message.includes("401") && !e.message.includes("test-only"),
  );
  await assert.rejects(
    () =>
      complete(
        config,
        [],
        undefined,
        async () =>
          new Response(JSON.stringify({ base_resp: { status_code: 1004 } })),
      ),
    /业务错误/,
  );
  await assert.rejects(
    () =>
      complete(
        config,
        [],
        undefined,
        async () =>
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "length" }] }),
          ),
      ),
    /上限/,
  );
});
test("一次无效结果后受限修复，不超过两次模型调用", async () => {
  let calls = 0;
  const result = await runAgent(
    blankProject(),
    "生成规划",
    config,
    new AbortController().signal,
    () => {},
    async () =>
      response(++calls === 1 ? "not json" : JSON.stringify(demoProposal())),
  );
  assert.equal(result.calls, 2);
  assert.equal(result.proposal.premise.title, "潮声之外");
});
test("连续无效结果结束任务，不写作品", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runAgent(
        blankProject(),
        "生成规划",
        config,
        new AbortController().signal,
        () => {},
        async () => {
          calls++;
          return response("bad");
        },
      ),
    /两次/,
  );
  assert.equal(calls, 2);
});
test("取消信号终止调用，不能返回候选", async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(() =>
    runAgent(
      blankProject(),
      "生成规划",
      config,
      c.signal,
      () => {},
      async () => response(JSON.stringify(demoProposal())),
    ),
  );
});
test("创作不创建自动超时信号，直接传递取消信号且支持未传入信号", async (t) => {
  const deadline = t.mock.method(AbortSignal, "timeout", () => {
    throw Error("创作不应设置计时中断");
  });
  for (const signal of [new AbortController().signal, undefined]) {
    const result = await runAgent(
      blankProject(),
      "生成规划",
      config,
      signal,
      () => {},
      async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        if (signal) assert.equal(init.signal, signal);
        return response(JSON.stringify(demoProposal()));
      },
    );
    assert.equal(result.proposal.premise.title, "潮声之外");
  }
  assert.equal(deadline.mock.callCount(), 0);
});
test("取消正在等待的模型请求立即中断，不能返回候选", async () => {
  const control = new AbortController();
  let entered;
  const called = new Promise((resolve) => {
    entered = resolve;
  });
  const running = runAgent(
    blankProject(),
    "生成规划",
    config,
    control.signal,
    () => {},
    (_url, init) => {
      entered();
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        ),
      );
    },
  );
  const stopped = assert.rejects(running, { name: "AbortError" });
  await called;
  control.abort();
  await stopped;
});
test("MiniMax M3默认开启思考，M2不传不支持的开关", async () => {
  for (const model of ["MiniMax-M3", "MiniMax-M2.7"]) {
    let body;
    await complete(
      {
        provider: "minimax",
        model,
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "test-only",
      },
      [],
      undefined,
      async (_url, options) => {
        body = JSON.parse(options.body);
        return response('{"summary":"测试"}');
      },
    );
    assert.equal(body.reasoning_split, true);
    assert.equal(
      body.thinking?.type,
      model === "MiniMax-M3" ? "adaptive" : undefined,
    );
  }
});
test("无效候选记录失败次数与验证原因", async () => {
  try {
    await runAgent(
      blankProject(),
      "规划",
      config,
      new AbortController().signal,
      () => {},
      async () => response("bad"),
    );
    assert.fail("应失败");
  } catch (e) {
    assert.equal(e.details.calls, 2);
    assert.equal(e.details.stage, "validation");
    assert.ok(e.details.lastValidationError);
  }
});

test("M3普通与增强调用均开启思考，M2不传开关", async () => {
  for (const [model, reasoning] of [
    ["MiniMax-M3", false],
    ["MiniMax-M3", true],
    ["MiniMax-M2.7", true],
  ]) {
    let body;
    await complete(
      {
        provider: "minimax",
        model,
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "test-only",
      },
      [],
      undefined,
      async (_url, options) => {
        body = JSON.parse(options.body);
        return response('{"summary":"结果"}');
      },
      12000,
      { reasoning },
    );
    assert.equal(
      body.thinking?.type,
      model === "MiniMax-M3" ? "adaptive" : undefined,
    );
    assert.equal(body.max_completion_tokens, 12000);
  }
});
