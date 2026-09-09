import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal } from "../runtime/schema.mjs";
import { ProjectStore } from "../runtime/storage.mjs";
import { runAgent } from "../runtime/agent.mjs";
import {
  countWords,
  resolveTask,
  lengthIssues,
  validateReview,
  writerMessages,
  normalizeTaskWordTargets,
  taskMessages,
} from "../runtime/writing.mjs";
const config = {
  provider: "minimax",
  model: "MiniMax-M3",
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "test-only",
};
const planned = () => applyProposal(blankProject(), demoProposal(), 0);
const req = "扩写第一章到100字";
function fixture() {
  const p = planned();
  p.chapters[0].content = "原稿";
  const id = p.chapters[0].id;
  const task = {
    mode: "revise",
    targetIds: [id],
    totalWords: null,
    chapterWords: 100,
    scopeEvidence: "扩写第一章",
    explanation: "仅修改第一章",
  };
  const blueprint = {
    facts: ["既定事实"],
    continuityDecisions: [],
    chapters: [
      {
        chapterId: id,
        scenes: [
          {
            purpose: "调查",
            desire: "确认",
            obstacle: "拒绝",
            choice: "尝试",
            consequence: "损失",
            evidence: "痕迹",
            knowledge: "只知观察",
            words: 100,
          },
        ],
        payoff: "证据改变",
      },
    ],
  };
  return { p, id, task, blueprint };
}
function fetchSequence(values, seen = []) {
  let i = 0;
  return async (_url, options) => {
    seen.push(JSON.parse(options.body));
    assert.ok(i < values.length, "模型调用不应超过预期");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: JSON.stringify(values[i++]) },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 10 },
      }),
    );
  };
}
const clean = { issues: [], strengths: ["保留有效细节"] };
test("统计口径明确，不把标点空白算进字数", () =>
  assert.equal(countWords("中文，hello 2026！\n"), 4));
test("整篇8000字分配覆盖已有短章，旧请求不锁定新任务", () => {
  const p = planned();
  p.chapters[0].content = "已有正文";
  const t = resolveTask(
    p,
    {
      mode: "revise",
      targetIds: p.chapters.map((c) => c.id),
      totalWords: 8000,
      chapterWords: null,
      scopeEvidence: "8000 字",
    },
    "太短了，调整一下，8000 字，3 个章节的短篇",
  );
  assert.equal(
    t.targets.reduce((n, t) => n + t.words, 0),
    8000,
  );
  assert.equal(t.targets.length, p.chapters.length);
});
test("目标字数扣除保留章节；范围、重复与空白起草冲突拒绝", () => {
  const { p, task } = fixture();
  assert.throws(
    () => resolveTask(p, { ...task, mode: "draft" }, req),
    /已有正文/,
  );
  assert.throws(
    () => resolveTask(p, { ...task, targetIds: ["missing"] }, req),
    /不存在/,
  );
  assert.throws(
    () => resolveTask(p, { ...task, scopeEvidence: "用户没说过" }, req),
    /依据/,
  );
  const other = p.chapters[1].id;
  const t = resolveTask(
    p,
    {
      ...task,
      targetIds: [other],
      totalWords: 500,
      chapterWords: null,
      scopeEvidence: "整篇调整到500字",
    },
    "保留第一章，只改第二章，将整篇调整到500字。",
  );
  assert.equal(t.targets[0].words, 498);
});
test("无明确字数的章节请求忽略模型推算，默认值由作品设置决定", () => {
  const p = planned();
  p.premise.chapterWords = 4500;
  p.chapters[0].content = "稿".repeat(4135);
  const instruction = "开始第二章创作";
  const task = {
    mode: "draft",
    targetIds: [p.chapters[1].id],
    totalWords: 45000,
    chapterWords: 4500,
    scopeEvidence: instruction,
  };
  const before = structuredClone(task);
  const resolved = resolveTask(p, task, instruction);
  assert.equal(resolved.totalWords, null);
  assert.equal(resolved.targets[0].words, 4500);
  assert.deepEqual(task, before);
  const payload = JSON.parse(taskMessages(p, instruction)[1].content);
  assert.equal(payload.premise.chapterCount, undefined);
  assert.equal(payload.premise.chapterWords, undefined);
});
test("明确字数必须在本次请求中找到相符数值，不能引用历史或计算值", () => {
  const task = {
    mode: "draft",
    targetIds: ["b"],
    totalWords: null,
    chapterWords: 4500,
  };
  assert.throws(
    () =>
      normalizeTaskWordTargets(
        { ...task, totalWords: 45000 },
        "第二章写4500字",
      ),
    /相符的字数依据/,
  );
  assert.throws(
    () =>
      normalizeTaskWordTargets(
        { ...task, chapterWordsEvidence: "历史要求4500字" },
        "第二章写4500字",
      ),
    /相符的字数依据/,
  );
  const v = normalizeTaskWordTargets(
    { ...task, totalWords: 4500 },
    "开始第二章，写4500字",
  );
  assert.equal(v.totalWords, null);
  assert.equal(v.chapterWords, 4500);
  assert.equal(v.chapterWordsEvidence, "4500字");
});
test("明确的阿拉伯、中文及缩写字数保留，总目标和单章目标分开", () => {
  for (const [instruction, words] of [
    ["第二章五千字", 5000],
    ["第二章５０００字", 5000],
    ["第二章5,000字", 5000],
    ["第二章5k字", 5000],
    ["第二章字数为5000", 5000],
  ]) {
    const task = normalizeTaskWordTargets(
      {
        mode: "draft",
        targetIds: ["b"],
        totalWords: null,
        chapterWords: words,
      },
      instruction,
    );
    assert.equal(task.chapterWords, words);
    assert.ok(task.chapterWordsEvidence);
  }
  for (const instruction of ["全书调整为四万五千字", "整篇4.5万字"]) {
    const task = normalizeTaskWordTargets(
      {
        mode: "revise",
        targetIds: ["a", "b"],
        totalWords: 45000,
        chapterWords: null,
      },
      instruction,
    );
    assert.equal(task.totalWords, 45000);
  }
});
test("不足字数不会被模型的完成声明替代", () => {
  assert.equal(
    lengthIssues([{ id: "a", content: "短" }], [{ chapterId: "a", words: 100 }])
      .length,
    1,
  );
  assert.equal(
    lengthIssues(
      [{ id: "a", content: "字".repeat(100) }],
      [{ chapterId: "a", words: 100 }],
    ).length,
    0,
  );
});
test("4500字章节按4000—5000字含边界验收", () => {
  for (const words of [3999, 4000, 4500, 5000, 5001]) {
    const issues = lengthIssues(
      [{ id: "a", content: "字".repeat(words) }],
      [{ chapterId: "a", words: 4500 }],
    );
    assert.equal(issues.length, words < 4000 || words > 5000 ? 1 : 0);
    if (issues.length) assert.match(issues[0].reason, /允许4000—5000字/);
  }
});
test("审稿引文须定位到指定章节", () => {
  assert.throws(
    () =>
      validateReview({ issues: [{ chapterId: "a", quote: "不存在" }] }, [
        { id: "a", content: "正文" },
      ]),
    /定位/,
  );
});
test("写作阶段不直接接收作者真相或人物秘密", () => {
  const { p, task, blueprint } = fixture();
  p.plan.truth = "隐藏真相标记XYZ";
  p.characters[0].secret = "秘密标记ABC";
  const input = JSON.stringify(
    writerMessages(
      p,
      task,
      blueprint,
      { chapterId: p.chapters[0].id, words: 100 },
      p.chapters,
    ),
  );
  assert.ok(!input.includes("隐藏真相标记XYZ"));
  assert.ok(!input.includes("秘密标记ABC"));
});
test("完整流程按证据修订，保留未授权章节并生成真实字数说明", async () => {
  const { p, id, task, blueprint } = fixture(),
    before = structuredClone(p);
  const bad = "错".repeat(100),
    good = "好".repeat(100);
  const review = {
    issues: [
      {
        chapterId: id,
        severity: "blocking",
        category: "continuity",
        quote: "错错",
        reason: "时间矛盾",
        fix: "修正时间",
      },
    ],
    strengths: [],
  };
  const result = await runAgent(
    p,
    req,
    config,
    undefined,
    () => {},
    fetchSequence([
      task,
      blueprint,
      clean,
      { chapterId: id, content: bad },
      review,
      { chapterId: id, content: good },
      clean,
      clean,
    ]),
  );
  assert.equal(result.calls, 8);
  assert.equal(result.proposal.chapters[0].content, good);
  assert.deepEqual(result.proposal.chapters.slice(1), p.chapters.slice(1));
  assert.deepEqual(p, before);
  assert.deepEqual(result.proposal.revisionScope, [id]);
  assert.equal(
    result.proposal.premise,
    undefined,
    "单章字数请求不能更改全书默认值",
  );
  assert.match(result.proposal.summary, /实测100字/);
  assert.equal(
    applyProposal(p, result.proposal, p.revision).chapters[0].content,
    good,
  );
});
test("模型审稿放行仍拦截长度，两次修订后失败且不改作品", async () => {
  const { p, id, task, blueprint } = fixture(),
    before = structuredClone(p);
  const d = { chapterId: id, content: "短稿" };
  await assert.rejects(
    () =>
      runAgent(
        p,
        req,
        config,
        undefined,
        () => {},
        fetchSequence([
          task,
          blueprint,
          clean,
          d,
          clean,
          clean,
          d,
          clean,
          clean,
          d,
          clean,
          clean,
        ]),
      ),
    /两轮修订/,
  );
  assert.deepEqual(p, before);
});
test("讨论任务不执行正文流水线，也不接受修改字段", async () => {
  const p = planned();
  const task = {
    mode: "discuss",
    targetIds: [],
    totalWords: null,
    chapterWords: null,
    scopeEvidence: "",
    explanation: "仅讨论",
  };
  const result = await runAgent(
    p,
    "评价一下",
    config,
    undefined,
    () => {},
    fetchSequence([task, { summary: "评价" }]),
  );
  assert.deepEqual(result.proposal, { summary: "评价" });
  assert.equal(result.calls, 2);
});
test("正文起草后取消不能返回或采纳候选", async () => {
  const { p, id, task, blueprint } = fixture();
  const control = new AbortController();
  await assert.rejects(
    () =>
      runAgent(
        p,
        req,
        config,
        control.signal,
        () => {},
        fetchSequence([
          task,
          blueprint,
          clean,
          { chapterId: id, content: "字".repeat(100) },
        ]),
        {
          onArtifact: (a) => {
            if (a.stage.startsWith("起草")) control.abort();
          },
        },
      ),
    /abort/i,
  );
  assert.equal(p.chapters[0].content, "原稿");
});
test("修订范围不能授权删除或修改其他章节，过期修订拒绝", () => {
  const { p, id } = fixture();
  p.chapters[1].content = "另一章";
  const chapters = p.chapters.map((c) => ({ ...c, content: "修改" }));
  assert.throws(
    () =>
      applyProposal(
        p,
        { summary: "", revisionScope: [id], chapters },
        p.revision,
      ),
    /不支持修改/,
  );
  assert.throws(
    () =>
      applyProposal(
        p,
        { summary: "", revisionScope: [id], chapters: p.chapters.slice(1) },
        p.revision,
      ),
    /不支持修改/,
  );
  assert.throws(
    () =>
      applyProposal(
        p,
        { summary: "", revisionScope: [id], chapters },
        p.revision - 1,
      ),
    /过期/,
  );
});
test("采纳修订前永久存原稿；后续保存不覆盖原稿版本", async () => {
  const dir = await mkdtemp(join(tmpdir(), "novel-revision-"));
  try {
    const store = new ProjectStore(dir);
    await store.load();
    let { p, id } = fixture();
    p = await store.save({ ...p, revision: 0 }, 0);
    const oldRevision = p.revision;
    const next = applyProposal(
      p,
      {
        summary: "修订",
        revisionScope: [id],
        chapters: p.chapters.map((c) =>
          c.id === id ? { ...c, content: "新正文" } : c,
        ),
      },
      p.revision,
    );
    await store.save(next, p.revision);
    const restored = JSON.parse(
      await readFile(
        join(dir, "versions", `revision-${oldRevision}.json`),
        "utf8",
      ),
    );
    assert.equal(restored.chapters[0].content, "原稿");
    assert.equal(
      (await new ProjectStore(dir).load()).chapters[0].content,
      "新正文",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("场景篇幅由程序归一化，模型算术偏差不浪费一次重试", async () => {
  const { p, id, task, blueprint } = fixture();
  blueprint.chapters[0].scenes[0].words = 73;
  const result = await runAgent(
    p,
    req,
    config,
    undefined,
    () => {},
    fetchSequence([
      task,
      blueprint,
      clean,
      { chapterId: id, content: "字".repeat(100) },
      clean,
      clean,
    ]),
  );
  assert.equal(result.calls, 6);
  const plan = result.artifacts.find(
    (a) => a.stage === "规划场景、人物选择与连续性",
  ).value;
  assert.equal(plan.chapters[0].scenes[0].words, 100);
});
test("动机或因果缺口先修场景计划，再进入正文", async () => {
  const { p, id, task, blueprint } = fixture();
  const bad = {
    issues: [
      {
        chapterId: id,
        severity: "blocking",
        category: "causality",
        quote: "尝试",
        reason: "没有具体行动",
        fix: "明确行动和代价",
      },
    ],
    strengths: [],
  };
  const fixed = structuredClone(blueprint);
  fixed.chapters[0].scenes[0].choice = "申请查阅被拒后承担停职风险自行核对";
  const result = await runAgent(
    p,
    req,
    config,
    undefined,
    () => {},
    fetchSequence([
      task,
      blueprint,
      bad,
      fixed,
      clean,
      { chapterId: id, content: "字".repeat(100) },
      clean,
      clean,
    ]),
  );
  assert.equal(result.calls, 8);
  assert.ok(result.artifacts.some((a) => a.stage === "修正场景因果与动机"));
});
test("阶段存档失败立即终止，不能误当模型格式问题重试", async () => {
  const { p, task } = fixture();
  const seen = [];
  await assert.rejects(
    () =>
      runAgent(
        p,
        req,
        config,
        undefined,
        () => {},
        fetchSequence([task], seen),
        {
          onArtifact: () => {
            throw Error("磁盘不可写");
          },
        },
      ),
    /磁盘不可写/,
  );
  assert.equal(seen.length, 1);
});

test("仅修复引号转义，不补齐截断稿件或字段", async () => {
  const { parseStructured } = await import("../runtime/structured.mjs");
  assert.deepEqual(parseStructured('{"reason":"仅"维持秩序"不能解释冒险。"}'), {
    reason: '仅"维持秩序"不能解释冒险。',
  });
  assert.throws(() => parseStructured('{"chapterId":"a","content":"半截正文'));
  assert.throws(() => parseStructured('{"a":1 "b":2}'));
  assert.throws(() =>
    parseStructured('{"chapters":[]} {"summary":"多一个对象"}'),
  );
  assert.deepEqual(parseStructured('```json\n{"content":"完整正文"}\n```'), {
    content: "完整正文",
  });
});

test("审稿用段落编号定位，程序回填原句并拒绝不存在的编号", () => {
  const chapters = [{ id: "a", content: "第一段。\n\n第二段的真实原文。" }];
  const result = validateReview(
    { issues: [{ chapterId: "a", paragraph: 2, quote: "模型抄错的引文" }] },
    chapters,
  );
  assert.equal(result.issues[0].quote, "第二段的真实原文。");
  assert.throws(
    () =>
      validateReview({ issues: [{ chapterId: "a", paragraph: 3 }] }, chapters),
    /不存在第3段/,
  );
  assert.throws(
    () => validateReview({ issues: [{ chapterId: "a" }] }, chapters),
    /定位/,
  );
});

test("综合审稿放行后，事实专项发现矛盾仍必须修订并复核", async () => {
  const { p, id, task, blueprint } = fixture();
  const bad = "错".repeat(100),
    good = "好".repeat(100);
  const facts = {
    issues: [
      {
        chapterId: id,
        paragraph: 1,
        severity: "blocking",
        category: "continuity",
        reason: "同一对象被描述为两个互斥状态",
        fix: "统一指代与事实",
      },
    ],
    strengths: [],
  };
  const seen = [];
  const result = await runAgent(
    p,
    req,
    {
      provider: "glm",
      model: "glm-5.2",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: "test-only",
    },
    undefined,
    () => {},
    fetchSequence(
      [
        task,
        blueprint,
        clean,
        { chapterId: id, content: bad },
        clean,
        facts,
        { chapterId: id, content: good },
        clean,
        clean,
      ],
      seen,
    ),
  );
  assert.equal(result.proposal.chapters[0].content, good);
  assert.equal(
    result.artifacts.find((a) => a.stage === "第1轮整篇审稿").value.issues
      .length,
    0,
    "后续专项意见不能回写先前审稿快照",
  );
  assert.equal(seen[5].thinking.type, "disabled");
  assert.equal(seen[5].reasoning_effort, undefined);
  assert.ok(seen[5].messages[0].content.includes("事实与逻辑校对员"));
  assert.equal(seen[3].thinking.type, "disabled");
  assert.equal(
    result.artifacts.filter((a) => a.stage === "事实与知情专项复核").length,
    2,
  );
});

test("最终候选存档期间取消也不能返回可采纳结果", async () => {
  const { p, id, task, blueprint } = fixture();
  const control = new AbortController();
  await assert.rejects(
    () =>
      runAgent(
        p,
        req,
        config,
        control.signal,
        () => {},
        fetchSequence([
          task,
          blueprint,
          clean,
          { chapterId: id, content: "字".repeat(100) },
          clean,
          clean,
        ]),
        {
          onArtifact: (a) => {
            if (a.stage === "最终候选") control.abort();
          },
        },
      ),
    /abort/i,
  );
});

test("恐怖承诺缺失进入修订闭环，本次风格要求传到计划审查、写作及复审", async () => {
  const { p, id, task, blueprint } = fixture();
  const instruction = "扩写第一章到100字，加强克苏鲁恐怖，保持冷静叙述";
  const bad = "旧".repeat(100),
    good = "新".repeat(100);
  const seen = [];
  const result = await runAgent(
    p,
    instruction,
    config,
    undefined,
    () => {},
    fetchSequence(
      [
        task,
        blueprint,
        clean,
        { chapterId: id, content: bad },
        {
          issues: [
            {
              chapterId: id,
              paragraph: 1,
              severity: "blocking",
              category: "horror",
              reason:
                "本次要求加强恐怖，但关键场景只复述已有证据，人物依靠和选择均未改变",
              fix: "把重复总结改为合理验证失效的可见后果，保留限知和既定真相",
            },
          ],
          strengths: [],
        },
        { chapterId: id, content: good },
        clean,
        clean,
      ],
      seen,
    ),
  );
  assert.equal(result.proposal.chapters[0].content, good);
  assert.equal(result.calls, 8);
  for (const index of [1, 2, 3, 4, 5, 6]) {
    assert.equal(
      JSON.parse(seen[index].messages[1].content).instruction,
      instruction,
    );
  }
  const revision = JSON.parse(seen[5].messages[1].content);
  assert.equal(revision.feedback[0].category, "horror");
  assert.equal(revision.feedback[0].quote, bad);
  assert.deepEqual(result.proposal.chapters.slice(1), p.chapters.slice(1));
  assert.equal(p.chapters[0].content, "原稿");
});

test("恐怖效果的普通建议不会强制重写或冒充硬性失败", async () => {
  const { p, id, task, blueprint } = fixture();
  const result = await runAgent(
    p,
    req,
    config,
    undefined,
    () => {},
    fetchSequence([
      task,
      blueprint,
      clean,
      { chapterId: id, content: "稿".repeat(100) },
      {
        issues: [
          {
            chapterId: id,
            paragraph: 1,
            severity: "suggestion",
            category: "horror",
            reason: "开篇已有具体不安，可考虑增加感官细节",
            fix: "可选调整，不必提前揭示",
          },
        ],
        strengths: [],
      },
      clean,
    ]),
  );
  assert.equal(result.calls, 6);
  assert.match(result.proposal.summary, /仍有编辑建议/);
});

test("恐怖缺口修订后仍未解决，不能返回可采纳候选", async () => {
  const { p, id, task, blueprint } = fixture();
  const review = {
    issues: [
      {
        chapterId: id,
        paragraph: 1,
        severity: "blocking",
        category: "horror",
        reason: "明确的恐怖承诺仍未兑现",
        fix: "补足关键场景后果",
      },
    ],
    strengths: [],
  };
  const draft = { chapterId: id, content: "稿".repeat(100) };
  await assert.rejects(
    () =>
      runAgent(
        p,
        req,
        config,
        undefined,
        () => {},
        fetchSequence([
          task,
          blueprint,
          clean,
          draft,
          review,
          draft,
          review,
          draft,
          review,
        ]),
      ),
    /两轮修订后仍有未解决问题/,
  );
  assert.equal(p.chapters[0].content, "原稿");
});
