import test from "node:test";
import assert from "node:assert/strict";
import { reviewDocument } from "../runtime/paragraph-review.mjs";
import { runLocalTasks } from "../runtime/review-context.mjs";
import { modelDocument, modelFindings } from "../runtime/review-payload.mjs";
import {
  createBudgetProfile,
  estimatedTokens,
  ensureBudget,
} from "../runtime/model-budget.mjs";
import { stageInputLimit } from "../runtime/model-capabilities.mjs";

const profile = createBudgetProfile({ provider: "glm", model: "glm-5.2" });
const doc = reviewDocument(
  [{ scene: 1, content: "钥匙由甲保管。\n\n乙尚未回到船上。" }],
  {},
);
const issue = (id, paragraph = 1) => ({
  id,
  kind: "contradiction",
  target: { sourceId: "scene:1", paragraph },
  evidence: [{ sourceId: "scene:1", paragraph }],
  explanation: "检查钥匙归属。",
});
const messagesFor = (view, group, constraints = []) => [
  { role: "system", content: "核对原文，保留已确定的事实。" },
  {
    role: "user",
    content: JSON.stringify({
      document: modelDocument(view),
      issues: modelFindings(group),
      constraints,
    }),
  },
];
function run(issues, options = {}) {
  return runLocalTasks({
    doc,
    issues,
    constraints: [],
    profile,
    output: 5500,
    stage: "grounding",
    key: "test",
    label: "依据核对",
    messagesFor,
    ask: async (_key, messages, validate) =>
      validate({
        ids: JSON.parse(messages[1].content).issues.map((i) => i.id),
      }),
    validate: (value, group) => {
      assert.deepEqual(
        value.ids,
        group.map((i) => i.id),
      );
      return value.ids;
    },
    merge: (parts) => parts.flat(),
    ...options,
  });
}

test("仅按实际发送字段计算预算，不把本地引文与问题历史重复扣除", async () => {
  const problems = [issue("one"), issue("two")].map((i) => ({
    ...i,
    target: { ...i.target, quote: "本地已保存引文。".repeat(5000) },
    history: [{ snapshot: "旧问题快照。".repeat(5000) }],
  }));
  let calls = 0;
  const result = await run(problems, {
    ask: async (_key, messages, validate) => {
      calls++;
      assert.ok(estimatedTokens(messages, profile) < 16000);
      assert.ok(!messages[1].content.includes("旧问题快照"));
      return validate({
        ids: JSON.parse(messages[1].content).issues.map((i) => i.id),
      });
    },
  });
  assert.deepEqual(new Set(result), new Set(["one", "two"]));
  assert.equal(calls, 1);
});

test("超长可选邻段不挤占必需目标、证据与作者裁定，原文编号不变", async () => {
  const large = reviewDocument(
    [
      {
        scene: 1,
        content: [
          "钥匙由甲保管。",
          "遥远的海面。".repeat(10000),
          "乙尚未回到船上。",
        ].join("\n\n"),
      },
    ],
    {},
  );
  const constraints = [
    {
      id: "author-1",
      instruction: "保留乙尚未回来。",
      facts: [
        {
          quote: "乙尚未回到船上。",
          currentReference: { sourceId: "scene:1", paragraph: 3 },
        },
      ],
    },
  ];
  const before = structuredClone(large);
  await run([issue("one")], {
    doc: large,
    constraints,
    messagesFor: (view, group) => messagesFor(view, group, constraints),
    ask: async (_key, messages, validate) => {
      const value = JSON.parse(messages[1].content);
      assert.deepEqual(
        value.document.sources[0].paragraphs.map((row) => row[0]),
        [1, 3],
      );
      assert.deepEqual(value.constraints, constraints);
      assert.deepEqual(value.document.coverage.supplied, [
        "scene:1:1",
        "scene:1:3",
      ]);
      assert.ok(
        estimatedTokens(messages, profile) <=
          stageInputLimit(profile, 5500, "grounding"),
      );
      return validate({ ids: ["one"] });
    },
  });
  assert.deepEqual(large, before);
});

const heavy = () =>
  Array.from({ length: 4 }, (_, i) => ({
    ...issue(`issue-${i}`),
    explanation: "constraint detail ".repeat(2200),
  }));

test("共用段落的依据核对可按预算拆批，重启复用已完成批次且不漏问题", async () => {
  let cache = {},
    fail = true,
    calls = 0;
  const labels = [];
  const ask = async (key, messages, validate, output, label) => {
    assert.ok(
      estimatedTokens(messages, profile) <=
        stageInputLimit(profile, output, "grounding"),
    );
    ensureBudget(messages, output, profile);
    labels.push(label);
    if (cache[key]) return validate(cache[key]);
    if (++calls === 2 && fail) throw Error("模拟重启");
    const ids = JSON.parse(messages[1].content).issues.map((i) => i.id);
    cache[key] = { ids };
    return validate(cache[key]);
  };
  await assert.rejects(run(heavy(), { ask }), /模拟重启/);
  cache = JSON.parse(JSON.stringify(cache));
  fail = false;
  const result = await run(heavy(), { ask });
  assert.deepEqual(new Set(result), new Set(heavy().map((i) => i.id)));
  assert.equal(result.length, 4);
  assert.equal(Object.keys(cache).length, 2);
  assert.equal(calls, 3);
  assert.ok(labels.every((l) => /问题组 [12]\/2/.test(l)));
});

test("生成补丁时共用段落仍为一组，超限不生成互相覆盖的独立补丁", async () => {
  let calls = 0;
  await assert.rejects(
    run(heavy(), {
      stage: "patch",
      ask: async () => {
        calls++;
      },
    }),
    (error) => {
      assert.equal(error.code, "CONTEXT_BUDGET");
      assert.match(error.message, /共用修改段落/);
      return true;
    },
  );
  assert.equal(calls, 0);
  const result = await run([issue("one"), issue("two")], {
    stage: "patch",
    ask: async (_key, messages, validate) => {
      calls++;
      const ids = JSON.parse(messages[1].content).issues.map((i) => i.id);
      assert.equal(ids.length, 2);
      return validate({ ids });
    },
  });
  assert.equal(result.length, 2);
  assert.equal(calls, 1);
});

test("后续单个问题真正无法装入时在任何模型调用前报出估算与问题编号", async () => {
  const many = reviewDocument(
    [
      {
        scene: 1,
        content: Array.from({ length: 5 }, (_, i) => `第${i + 1}段事实。`).join(
          "\n\n",
        ),
      },
    ],
    {},
  );
  const problems = Array.from({ length: 5 }, (_, i) =>
    issue(`issue-${i}`, i + 1),
  );
  problems[4].explanation = "mandatory context ".repeat(12000);
  let calls = 0;
  await assert.rejects(
    run(problems, {
      doc: many,
      ask: async () => {
        calls++;
      },
    }),
    (error) => {
      assert.equal(error.code, "CONTEXT_BUDGET");
      assert.ok(error.inputEstimate > error.limit);
      assert.match(error.message, /issue-4.*已无法继续拆批/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("局部请求同时遵守当前模型输入硬上限和阶段额度", async () => {
  const limited = {
    ...profile,
    capabilities: { ...profile.capabilities, maxInputTokens: 5000 },
  };
  const problems = [issue("one"), issue("two")].map((i) => ({
    ...i,
    explanation: "constraint detail ".repeat(750),
  }));
  let calls = 0;
  const result = await run(problems, {
    profile: limited,
    ask: async (_key, messages, validate, output) => {
      calls++;
      assert.ok(
        estimatedTokens(messages, limited) <=
          stageInputLimit(limited, output, "grounding"),
      );
      ensureBudget(messages, output, limited);
      return validate({
        ids: JSON.parse(messages[1].content).issues.map((i) => i.id),
      });
    },
  });
  assert.equal(result.length, 2);
  assert.equal(calls, 2);
});
