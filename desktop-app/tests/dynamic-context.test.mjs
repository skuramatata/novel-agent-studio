import test from "node:test";
import assert from "node:assert/strict";
import {
  modelCapabilities,
  capabilityKey,
  requestOutput,
} from "../runtime/model-capabilities.mjs";
import {
  createBudgetProfile,
  ensureBudget,
  estimatedTokens,
} from "../runtime/model-budget.mjs";
import {
  batchReviewDocuments,
  assertVisibleReferences,
  runReviewBatches,
  issueGroups,
  localReviewDocument,
  runLocalTasks,
} from "../runtime/review-context.mjs";
import {
  reviewDocument,
  evidenceAt,
  validateFindings,
} from "../runtime/paragraph-review.mjs";
import { modelDocument } from "../runtime/review-payload.mjs";

const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};
const messagesFor = (doc) => [
  { role: "system", content: "仅核对已提供原文。" },
  {
    role: "user",
    content: JSON.stringify({
      document: modelDocument(doc, { explicitSentences: true }),
    }),
  },
];
test("能力随模型和入口切换，覆盖只绑定精确接入点，未知模型明确回退", () => {
  assert.equal(modelCapabilities(config).contextLimit, 120000);
  assert.equal(modelCapabilities(config).maxInputTokens, null);
  const custom = {
    ...config,
    limits: {
      contextWindow: 100000,
      appContextCap: 90000,
      maxOutputTokens: 12000,
      endpointContextLimit: 80000,
    },
    limitKey: capabilityKey(config),
  };
  assert.equal(modelCapabilities(custom).contextLimit, 80000);
  assert.equal(requestOutput(20000, createBudgetProfile(custom)), 12000);
  assert.equal(
    modelCapabilities({ ...custom, model: "glm-other" }).contextLimit,
    60000,
  );
  assert.match(
    modelCapabilities({ ...config, model: "glm-other" }).confidence,
    /未知模型/,
  );
  assert.equal(
    modelCapabilities({ ...custom, baseUrl: "https://different.test" })
      .contextLimit,
    120000,
  );
  assert.equal(
    modelCapabilities({ provider: "minimax", model: "MiniMax-M2.7" })
      .contextLimit,
    100000,
  );
  assert.throws(
    () => modelCapabilities({ ...custom, limits: { appContextCap: -1 } }),
    /预算/,
  );
});
test("输入上限和输出上限分别检查，较大模型不会沿用60000硬编码", () => {
  const messages = [
    { role: "user", content: "检查时间和钥匙归属。".repeat(8000) },
  ];
  const big = createBudgetProfile(config);
  assert.ok(estimatedTokens(messages, big) > 60000);
  assert.doesNotThrow(() => ensureBudget(messages, 6500, big));
  const small = createBudgetProfile({
    ...config,
    limits: { maxInputTokens: 16000 },
    limitKey: capabilityKey(config),
  });
  assert.throws(
    () => ensureBudget(messages, 1000, small),
    (e) => e.code === "CONTEXT_BUDGET",
  );
  assert.throws(
    () => ensureBudget([], 128001, big),
    (e) => e.code === "OUTPUT_BUDGET",
  );
});
test("审稿分批完整覆盖每对当前段落与其余原文，不重编号或接受未提供引用", () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content: Array.from(
          { length: 12 },
          (_, i) => `第${i + 1}段。` + "他在清晨核对铜钥匙。".repeat(70),
        ).join("\n\n"),
      },
    ],
    {
      recallSources: [
        {
          chapterId: "old",
          number: 1,
          content: Array.from(
            { length: 8 },
            (_, i) => `历史${i}。` + "夜里记录了旧锁的去向。".repeat(70),
          ).join("\n\n"),
        },
      ],
    },
  );
  const profile = createBudgetProfile({
    ...config,
    limits: { appContextCap: 20000 },
    limitKey: capabilityKey(config),
  });
  const before = JSON.stringify(doc);
  const views = batchReviewDocuments(doc, messagesFor, {
    profile,
    output: 3000,
  });
  assert.ok(views.length > 1);
  const all = doc.sources.flatMap((s) =>
    s.paragraphs.map((p) => `${s.sourceId}:${p.paragraph}`),
  );
  const ids = (view) =>
    new Set(
      view.sources.flatMap((s) =>
        s.paragraphs.map((p) => `${s.sourceId}:${p.paragraph}`),
      ),
    );
  for (const a of all.filter((k) => k.startsWith("scene:")))
    for (const b of all)
      assert.ok(
        views.some((v) => ids(v).has(a) && ids(v).has(b)),
        `缺少跨批检查 ${a}/${b}`,
      );
  for (const view of views) {
    ensureBudget(messagesFor(view), 3000, profile);
    assert.equal(view.version, doc.version);
    for (const s of view.sources)
      for (const p of s.paragraphs)
        assert.equal(
          evidenceAt(view, { sourceId: s.sourceId, paragraph: p.paragraph })
            .quote,
          evidenceAt(doc, { sourceId: s.sourceId, paragraph: p.paragraph })
            .quote,
        );
  }
  const partial = views.find((v) => ids(v).size < all.length),
    absent = all.find((k) => !ids(partial).has(k));
  const n = absent.lastIndexOf(":");
  assert.throws(
    () =>
      assertVisibleReferences(
        {
          target: {
            sourceId: absent.slice(0, n),
            paragraph: Number(absent.slice(n + 1)),
          },
        },
        partial,
      ),
    /不在本次提供/,
  );
  assert.equal(JSON.stringify(doc), before);
});
test("分批中断恢复复用已通过批次，不把未完成覆盖作为审稿完成", async () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content: Array.from(
          { length: 9 },
          (_, i) => `记录${i}：` + "钥匙放在柜里。".repeat(90),
        ).join("\n\n"),
      },
    ],
    {},
  );
  const profile = createBudgetProfile({
    ...config,
    limits: { appContextCap: 16000 },
    limitKey: capabilityKey(config),
  });
  const cache = new Map(),
    state = {};
  let calls = 0,
    fail = true;
  const ask = async (key, messages, validate) => {
    if (cache.has(key)) return cache.get(key);
    if (++calls === 2 && fail) throw Error("中断");
    const v = validate({ issues: [] });
    cache.set(key, v);
    return v;
  };
  const run = (key) =>
    runReviewBatches({
      doc,
      messagesFor,
      profile,
      output: 3000,
      state,
      save: async () => {},
      ask,
      key,
      label: "审稿",
      validate: (v, view) => validateFindings(v, view),
    });
  await assert.rejects(run("review:workflow-1:retry-0"), /中断/);
  assert.ok(
    Object.values(state.reviewCoverage).some((c) => c.completed < c.total),
  );
  fail = false;
  const out = await run("review:workflow-1:retry-1");
  assert.equal(out.batchCoverage.completed, out.batchCoverage.total);
  assert.equal(calls, cache.size + 1);
});
test("局部修订保留证据和邻段，共用修改目标的问题不会拆开", () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content: "前段。\n\n钥匙交给甲。\n\n紧接着甲离开。\n\n远处海面平静。",
      },
    ],
    { recentText: "昨天钥匙由乙保管。" },
  );
  const problem = {
    id: "i1",
    target: { sourceId: "scene:1", paragraph: 2 },
    evidence: [{ sourceId: "recent", paragraph: 1 }],
  };
  const view = localReviewDocument(doc, [problem], [], {
    profile: createBudgetProfile(config),
  });
  for (const paragraph of [1, 2, 3])
    assert.ok(evidenceAt(view, { sourceId: "scene:1", paragraph }));
  assert.ok(evidenceAt(view, problem.evidence[0]));
  const shared = { ...problem, id: "i2" };
  assert.equal(issueGroups([problem, shared], 1).length, 1);
});

test("局部任务中断后缓存保留模型结构，重新校验并转换，已完成的问题组不重复调用", async () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content: Array.from(
          { length: 5 },
          (_, i) => `记录${i}：钥匙仍在柜中。`,
        ).join("\n\n"),
      },
    ],
    {},
  );
  const issues = Array.from({ length: 5 }, (_, i) => ({
    id: `issue-${i}`,
    target: { sourceId: "scene:1", paragraph: i + 1 },
  }));
  const cache = new Map();
  let calls = 0,
    fail = true;
  const ask = async (key, messages, validate) => {
    if (cache.has(key)) return validate(cache.get(key));
    if (++calls === 2 && fail) throw Error("中断");
    const { group } = JSON.parse(messages[1].content);
    const result = validate({
      decisions: group.map(({ id, target }) => ({ id, target })),
    });
    cache.set(key, result);
    return result;
  };
  const run = (key) =>
    runLocalTasks({
      doc,
      issues,
      constraints: [],
      profile: createBudgetProfile(config),
      output: 5500,
      stage: "grounding",
      key,
      label: "依据核对",
      ask,
      messagesFor: (view, group) => [
        { role: "system", content: "按问题核对已提供原文。" },
        {
          role: "user",
          content: JSON.stringify({ document: modelDocument(view), group }),
        },
      ],
      validate: (value, group) => {
        assert.ok(
          Array.isArray(value.decisions),
          "缓存仍需满足模型返回的原始契约",
        );
        assert.deepEqual(
          value.decisions.map((v) => v.id),
          group.map((v) => v.id),
        );
        return { problems: value.decisions };
      },
      merge: (results) => ({ problems: results.flatMap((r) => r.problems) }),
    });
  await assert.rejects(run("ground:retry-0"), /中断/);
  assert.equal(cache.size, 1);
  fail = false;
  const result = await run("ground:retry-1");
  assert.equal(result.problems.length, 5);
  assert.equal(calls, 3);
  assert.ok([...cache.values()].every((v) => Array.isArray(v.decisions)));
});
