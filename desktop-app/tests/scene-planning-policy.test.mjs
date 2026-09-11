import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  planScenes,
  SCENE_PLANNING_POLICY,
} from "../runtime/scene-planning.mjs";
import {
  createStructuredAsker,
  blockedStructuredRecovery,
} from "../runtime/structured-step.mjs";
import { workflowContract } from "../runtime/workflow-skill.mjs";
import { createBudgetProfile } from "../runtime/model-budget.mjs";
import { reasoningExhausted } from "../runtime/reasoning-budget.mjs";
const config = {
  provider: "glm",
  model: "glm-5.3",
  baseUrl: "https://example.test",
};
const schema = z.object({
  scenes: z.array(
    z.object({
      goal: z.string(),
      knowledge: z.string(),
      time: z.object({
        start: z.string(),
        gap: z.string(),
        duration: z.string(),
        end: z.string(),
      }),
    }),
  ),
});
const contract = workflowContract("scene_plan", schema);
const scene = (n) => ({
  goal: `行动${n}`,
  knowledge: "仅现场所知",
  time: { start: "夜", gap: "紧接", duration: "片刻", end: "夜" },
});
const ok = (value) => ({ text: JSON.stringify(value), finishReason: "stop" });
const limit = (reasoning = 11950) => ({
  text: "{",
  finishReason: "length",
  usage: {
    completion_tokens: 12000,
    completion_tokens_details: { reasoning_tokens: reasoning },
  },
});
const messages = [
  { role: "system", content: "创作规则\n为当前章设计恰好2个场景" },
  {
    role: "user",
    content: JSON.stringify({
      facts: "完整事实证据",
      timeRequirements: "必须有time",
    }),
  },
];
function setup() {
  let state = {
      ...config,
      id: "task",
      values: {},
      fragments: {},
      status: "running",
    },
    saved;
  const budget = createBudgetProfile(config);
  const save = async () => {
    saved = JSON.stringify(state);
  };
  return {
    get state() {
      return state;
    },
    restart() {
      state = JSON.parse(saved);
    },
    asker(call) {
      return createStructuredAsker({ state, budget, call, save });
    },
    run(call) {
      return planScenes({
        state,
        ask: this.asker(call),
        save,
        messages,
        count: 2,
        contract,
        validate: (v) => {
          const parsed = schema.parse(v);
          assert.equal(parsed.scenes.length, 2);
          return parsed;
        },
      });
    },
  };
}
test("场景规划low成功只调用一次，已有规划和正文恢复不重做", async () => {
  const f = setup();
  let calls = 0;
  await f.run(async (_m, _t, _l, _p, options) => {
    calls++;
    assert.equal(options.reasoningEffort, "low");
    return ok({ scenes: [scene(1), scene(2)] });
  });
  f.state.values["scene:0:round:0"] = "已写正文";
  await f.run(() => {
    throw Error("不得请求");
  });
  assert.equal(calls, 1);
  assert.equal(f.state.values["scene:0:round:0"], "已写正文");
});
test("思考耗尽拆共同骨架后细化；断网恢复复用骨架和第一场，不刷新失败预算", async () => {
  const f = setup(),
    calls = [];
  const responder = async (m, _t, label) => {
    calls.push(label);
    if (label === "规划本章场景") return limit();
    assert.ok(m.some((x) => x.content.includes("完整事实证据")));
    if (label === "规划本章共同骨架") {
      assert.ok(!m.some((x) => x.content.includes('"timeRequirements"')));
      return ok({
        scenes: [
          { goal: "行动1", handoff: "引发行动2" },
          { goal: "行动2", handoff: "结尾" },
        ],
      });
    }
    if (label === "细化场景 1/2") return ok({ scenes: [scene(1)] });
    assert.equal(JSON.parse(m.at(-1).content).completedScenes.length, 1);
    throw Error("断网");
  };
  await assert.rejects(f.run(responder), /断网/);
  f.restart();
  const result = await f.run(async (m, _t, label) => {
    calls.push(label);
    assert.equal(label, "细化场景 2/2");
    const payload = JSON.parse(m.at(-1).content);
    assert.equal(payload.sharedOutline.length, 2);
    assert.deepEqual(payload.completedScenes, [scene(1)]);
    return ok({ scenes: [scene(2)] });
  });
  assert.equal(calls.filter((x) => x === "规划本章场景").length, 1);
  assert.equal(calls.filter((x) => x === "规划本章共同骨架").length, 1);
  assert.equal(result.scenes.length, 2);
});
test("low骨架也思考耗尽时停止，重复恢复不会重新请求", async () => {
  const f = setup();
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      f.run(async () => {
        calls++;
        return limit();
      }),
      /输出预算已用尽/,
    );
    f.restart();
  }
  assert.equal(calls, 2);
  assert.ok(blockedStructuredRecovery(f.state));
});
test("high思考耗尽只降一次low，断网后仍low；第二次耗尽不得扩容", async () => {
  const f = setup();
  const options = {
    contract: workflowContract("task_intent", z.object({ done: z.boolean() })),
  };
  const run = (call) =>
    f.asker(call)("intent", messages, (v) => v, 4000, "确定任务", options);
  let n = 0;
  await assert.rejects(
    run(async (_m, _t, _l, _p, o) => {
      n++;
      if (n === 1) return limit();
      assert.equal(o.reasoningEffort, "low");
      throw Error("断网");
    }),
    /断网/,
  );
  f.restart();
  await assert.rejects(
    run(async (_m, _t, _l, _p, o) => {
      assert.equal(o.reasoningEffort, "low");
      return limit();
    }),
    /输出预算已用尽/,
  );
  f.restart();
  await assert.rejects(
    run(() => {
      throw Error("不得再次请求");
    }),
    /输出预算已用尽/,
  );
  assert.equal(Object.values(f.state.structuredSteps)[0].expansions, 0);
});
test("只有带真实用量的思考占比达到80%才触发；答案截断仍可扩容", async () => {
  assert.equal(reasoningExhausted(limit()), true);
  assert.equal(reasoningExhausted(limit(100)), false);
  assert.equal(reasoningExhausted({ finishReason: "length" }), false);
  const f = setup();
  const tokens = [];
  await f.run(async (_m, t) => {
    tokens.push(t);
    return tokens.length === 1
      ? limit(100)
      : ok({ scenes: [scene(1), scene(2)] });
  });
  assert.ok(tokens[1] > tokens[0]);
});
test("旧场景输出失败可迁移，新拆分节点失败不可反复迁移", () => {
  const f = setup();
  f.state.structuredFailure = { stepId: "old", version: "old" };
  f.state.structuredSteps = {
    old: { contractId: "scene_plan", lastFailure: { kind: "output_limit" } },
  };
  assert.equal(blockedStructuredRecovery(f.state), null);
  f.state.structuredSteps.old.reasoningPolicy = SCENE_PLANNING_POLICY;
  f.state.structuredSteps.old.logicalKey = `scene-plan:${SCENE_PLANNING_POLICY}`;
  f.state.structuredSteps.old.lastFailure.reasoningExhausted = true;
  assert.equal(blockedStructuredRecovery(f.state), null);
});
