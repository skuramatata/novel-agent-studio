import test from "node:test";
import assert from "node:assert/strict";
import {
  createStructuredAsker,
  blockedStructuredRecovery,
} from "../runtime/structured-step.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import {
  reviewStep,
  reviewTaskState,
  addRecoveryMessage,
} from "../runtime/review-workflow.mjs";

const messages = [
  { role: "system", content: "核对原文，只返回JSON" },
  { role: "user", content: "实际原文：纸页干燥。" },
];
const response = (text, finishReason = "stop") => ({ text, finishReason });
const validate = (v) => {
  if (v.paragraph !== 1) throw Error("引用必须为第1段");
  return v;
};
const json = JSON.stringify({ paragraph: 1 });
function fixture() {
  let state = { id: "task", status: "running", values: {}, fragments: {} },
    persisted;
  const budget = createBudgetProfile();
  const save = async () => {
    persisted = JSON.stringify(state);
  };
  return {
    get state() {
      return state;
    },
    restart() {
      state = JSON.parse(persisted);
    },
    ask(call, customSave = save) {
      return createStructuredAsker({ state, budget, call, save: customSave });
    },
    save,
  };
}
const run = (ask, retry = 0, input = messages) =>
  ask(
    `review:workflow-1:retry-${retry}`,
    input,
    validate,
    4000,
    "核对审稿发现",
    { maxCorrections: 2 },
  );

test("相同逻辑键但输入变化不能命中旧结果，恢复旧输入仍复用原响应", async () => {
  const f = fixture();
  const ask = f.ask(async (messages) =>
    response(JSON.stringify({ input: messages[0].content })),
  );
  assert.deepEqual(
    await ask("same-key", [{ role: "user", content: "旧原文" }], (v) => v),
    { input: "旧原文" },
  );
  assert.deepEqual(
    await ask("same-key", [{ role: "user", content: "新原文" }], (v) => v),
    { input: "新原文" },
  );
  f.restart();
  assert.deepEqual(
    await f.ask(async () => {
      throw Error("成功输入不可重跑");
    })("same-key", [{ role: "user", content: "旧原文" }], (v) => v),
    { input: "旧原文" },
  );
});

for (const bad of ['{"paragraph":30"}', '{"paragraph":30}']) {
  test(`失败后纠错遇断网，重启仍携带原始材料和诊断：${bad}`, async () => {
    const f = fixture();
    let count = 0,
      failedRequest;
    await assert.rejects(
      run(
        f.ask(async (sent) => {
          if (++count === 1) return response(bad);
          failedRequest = sent;
          throw Error("断网");
        }),
      ),
      /断网/,
    );
    f.restart();
    assert.equal(Object.values(f.state.structuredSteps)[0].corrections, 1);
    await run(
      f.ask(async (sent) => {
        assert.deepEqual(sent, failedRequest);
        assert.deepEqual(sent.slice(0, 2), messages);
        assert.match(sent.at(-1).content, /校验失败/);
        return response(json);
      }),
      3,
    );
    assert.ok(Object.values(f.state.fragments).includes(bad));
    assert.equal(Object.values(f.state.structuredSteps).length, 1);
    assert.equal(Object.values(f.state.structuredSteps)[0].calls, 2);
  });
}

test("协议耗尽跨重启/工作流编号仍零调用；状态和提示不再引导重复恢复", async () => {
  const f = fixture();
  let calls = 0;
  const call = async () => {
    calls++;
    return response('{"paragraph":30}');
  };
  await assert.rejects(
    reviewStep(f.state, "review", f.save, () => run(f.ask(call))),
    /预算已用尽/,
  );
  f.restart();
  assert.equal(calls, 3);
  assert.equal(reviewTaskState(f.state).resumable, false);
  assert.equal(
    reviewTaskState(f.state).reviewProgress.failure.kind,
    "protocol_exhausted",
  );
  addRecoveryMessage(f.state);
  assert.doesNotMatch(
    f.state.reviewConversation.at(-1).text,
    /点击“恢复上次任务”/,
  );
  for (const retry of [1, 2, 100])
    await assert.rejects(run(f.ask(call), retry), /预算已用尽/);
  assert.equal(calls, 3);
  assert.deepEqual(f.state.values, {});
  assert.ok(blockedStructuredRecovery(f.state));
  // 修改实际输入后是新节点；只换恢复编号不算。
  await run(
    f.ask(async () => response(json)),
    101,
    [...messages, { role: "user", content: "已核实新的材料" }],
  );
  assert.equal(blockedStructuredRecovery(f.state), null);
  f.state.structuredFailure = { version: "older-contract" };
  assert.equal(blockedStructuredRecovery(f.state), null);
});

test("已收到结果但校验前退出，重启先校验落盘结果且不再次请求", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    run(
      f.ask(
        async () => {
          calls++;
          return response(json);
        },
        async () => {
          await f.save();
          if (Object.values(f.state.structuredSteps)[0]?.status === "received")
            throw Error("进程退出");
        },
      ),
    ),
    /进程退出/,
  );
  f.restart();
  assert.deepEqual(
    await run(
      f.ask(async () => {
        throw Error("不应请求");
      }),
      2,
    ),
    { paragraph: 1 },
  );
  assert.equal(calls, 1);
  f.restart();
  await run(
    f.ask(async () => {
      throw Error("成功批次不重跑");
    }),
    3,
  );
});

test("纠错响应截断后断网，重启保留诊断、扩容量和所有已用次数", async () => {
  const f = fixture();
  const seen = [];
  let calls = 0;
  await assert.rejects(
    run(
      f.ask(async (sent, tokens) => {
        seen.push(tokens);
        if (++calls === 1) return response('{"paragraph":30}');
        assert.match(sent.at(-1).content, /引用必须为第1段/);
        if (calls === 2) return response(json, "length");
        throw Error("断网");
      }),
    ),
    /断网/,
  );
  f.restart();
  await assert.rejects(
    run(
      f.ask(async (sent, tokens) => {
        seen.push(tokens);
        assert.match(sent.at(-1).content, /引用必须为第1段/);
        return response(json, "length");
      }),
      9,
    ),
    /预算已用尽/,
  );
  assert.deepEqual(seen, [4000, 4000, 8000, 8000, 16000]);
  const step = Object.values(f.state.structuredSteps)[0];
  assert.equal(step.expansions, 2);
  assert.equal(step.corrections, 1);
  assert.deepEqual(f.state.values, {});
  f.restart();
  await assert.rejects(
    run(
      f.ask(async () => {
        throw Error("不应再请求");
      }),
      10,
    ),
    /预算已用尽/,
  );
});
