import { repairPlanResponse } from "./fixtures/repair-plan.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal } from "../runtime/schema.mjs";
import { Checkpoint } from "../runtime/checkpoint.mjs";
import { runChapterAgent } from "../runtime/chapter-agent.mjs";
import { countWords } from "../runtime/writing.mjs";
import {
  digest,
  isCurrent,
  contextFor,
  validateExtraction,
  memoryView,
  sourceParts,
  memorySources,
  indexChapter,
} from "../runtime/memory.mjs";
const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "test-only",
};
const planned = () => applyProposal(blankProject(), demoProposal(), 0);
const unknownContinuity = {
  assertion: "unknown",
  actor: "",
  action: "",
  object: "",
  before: "",
  after: "",
  evidenceForm: "unknown",
  time: null,
};
const sceneTime = {
  start: "当日上午",
  gap: "承接上一场景",
  duration: "约一小时",
  end: "当日上午稍后",
};
const response = (text, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              typeof text === "string"
                ? text
                : JSON.stringify({
                    ...text,
                    ...(Array.isArray(text?.issues)
                      ? {
                          continuityChecks: ["time", "state", "evidence"].map(
                            (dimension) => ({
                              dimension,
                              verdict: "not_applicable",
                              evidence: [],
                              explanation:
                                "本模拟样本只验证恢复和补丁流程，不含该项可检查的事实。",
                            }),
                          ),
                        }
                      : {}),
                    ...(Array.isArray(text?.scenes)
                      ? {
                          scenes: text.scenes.map((s) => ({
                            time: sceneTime,
                            ...s,
                          })),
                        }
                      : {}),
                    ...(Array.isArray(text?.records)
                      ? {
                          records: text.records.map((r) => ({
                            continuity: unknownContinuity,
                            ...r,
                          })),
                        }
                      : {}),
                  }),
          },
          finish_reason: finish,
        },
      ],
      usage: { total_tokens: 10 },
    }),
  );
function missingFinding(data) {
  return {
    issues: [
      {
        kind: "missing_history",
        target: { sourceId: "scene:1", paragraph: 1 },
        evidence: [{ sourceId: "scene:1", paragraph: 1 }],
        searchedSources: data.document.sources.map((s) => s.sourceId),
        explanation: "给定范围内缺少事件出处",
        resolution: "remove_unsupported",
        fix: "删除无依据断言",
      },
    ],
  };
}
function patchResponse(data) {
  return response({
    baseVersion: data.document.version,
    replacements: [
      {
        sourceId: "scene:1",
        paragraph: 1,
        issueIds: data.issues.map((i) => i.id),
        replacement: "改".repeat(1200),
      },
    ],
  });
}
function responder(seen = [], failAt = 0) {
  let n = 0;
  return async (_, options) => {
    const body = JSON.parse(options.body),
      sys = body.messages[0].content,
      data = JSON.parse(body.messages[1].content);
    seen.push(body);
    if (++n === failAt) throw Error("模拟网络断开");
    if (sys.includes("从提供的小说原文抽取"))
      return response({
        summary: "可定位的摘要",
        records: [
          {
            kind: "event",
            text: "原文事件",
            entities: ["钥匙"],
            storyTime: "未知",
            knownBy: [],
            epistemic: "observed",
            sourceId: data.sources.find((s) => s.text.trim()).sourceId,
          },
        ],
      });
    if (sys.includes("设计恰好")) {
      if (data.timeRequirements) assert.match(sys, /"time":\{"start":/);
      return response({
        scenes: Array.from(
          { length: Math.ceil(data.targetWords / 1200) },
          () => ({ goal: "调查钥匙", knowledge: "仅知眼前事实" }),
        ),
      });
    }
    if (sys.includes("仅写当前场景")) {
      const words = Number(sys.match(/目标约(\d+)字/)[1]);
      return response("稿".repeat(words) + "\n〈场景完成〉");
    }
    const authorChecks = (data.authorConstraints || []).map((c) => ({
      id: c.id,
      respected: true,
      evidence: [{ sourceId: "scene:1", paragraph: 1 }],
    }));
    if (sys.includes("独立修订依据核对员"))
      return response(repairPlanResponse(data));
    if (sys.includes("小说连续性与文学审稿员"))
      return response({ issues: [], authorChecks });
    if (sys.includes("小说段落修订编辑")) return patchResponse(data);
    if (sys.includes("独立补丁复核员"))
      return response({
        authorChecks,
        checks: data.issues.map((i) => ({
          issueId: i.id,
          resolved: true,
          preservedFacts: true,
          noUnsupportedAdditions: true,
          downstreamConsistent: true,
          evidence: [{ sourceId: "scene:1", paragraph: 1 }],
          explanation: "修订后原问题已删除",
        })),
      });
    throw Error("意外调用：" + sys.slice(0, 30));
  };
}
async function setup(words = 2400) {
  const p = planned(),
    dir = await mkdtemp(join(tmpdir(), "novel-memory-test-")),
    checkpoint = new Checkpoint(dir);
  const req = {
    instruction: `起草第一章${words}字`,
    chapterId: p.chapters[0].id,
    words,
  };
  const state = await checkpoint.begin(p, req, config);
  return { p, dir, checkpoint, req, state };
}
test("审稿连续出现JSON语法错误和索引伪地址时有限纠错，不重写已保存场景", async (t) => {
  const f = await setup(1200),
    normal = responder(),
    seen = [];
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const before = structuredClone(f.p);
  const result = await runChapterAgent(
    f.p,
    config,
    new AbortController().signal,
    () => {},
    f.checkpoint,
    f.state,
    async (url, init) => {
      const body = JSON.parse(init.body);
      if (!body.messages[0].content.includes("本轮只执行时间"))
        return normal(url, init);
      seen.push(body);
      if (seen.length === 1)
        return response(
          '{"issues":[]},"target":{"sourceId":"scene:1","paragraph":1}}',
        );
      if (seen.length === 2) {
        assert.match(body.messages.at(-1).content, /不在闭合对象后追加字段/);
        assert.ok(!body.messages.some((m) => m.role === "assistant"));
        return response(
          JSON.stringify({
            issues: [],
            continuityChecks: [
              {
                dimension: "time",
                verdict: "consistent",
                evidence: [
                  { sourceId: "timeAnchors", paragraph: 0, sentence: 0 },
                ],
                explanation: "错误索引",
              },
            ],
          }),
        );
      }
      assert.match(body.messages.at(-1).content, /sourceId只能是：scene:1/);
      return normal(url, init);
    },
  );
  assert.equal(seen.length, 3);
  assert.equal(f.state.status, "ready");
  assert.equal(result.proposal.chapters[0].content, "稿".repeat(1200));
  assert.deepEqual(f.p, before);
  assert.equal(
    Object.keys(f.state.fragments).filter((k) => k.startsWith("raw-scene:"))
      .length,
    1,
  );
});

test("三次审稿仍返回伪地址时保存失败，恢复沿用场景且不采纳无效结果", async (t) => {
  const f = await setup(1200),
    normal = responder();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  let reviewCalls = 0;
  await assert.rejects(
    runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (url, init) => {
        const body = JSON.parse(init.body);
        if (!body.messages[0].content.includes("本轮只执行时间"))
          return normal(url, init);
        reviewCalls++;
        return response(
          JSON.stringify({
            issues: [],
            continuityChecks: [
              {
                dimension: "time",
                verdict: "consistent",
                evidence: [{ sourceId: "timeAnchors", paragraph: 0 }],
                explanation: "错误索引",
              },
            ],
          }),
        );
      },
    ),
    /引用不在本次提供的原文范围/,
  );
  assert.equal(reviewCalls, 3);
  const saved = await f.checkpoint.read();
  assert.equal(saved.status, "retryable");
  assert.ok(!saved.paragraphReview.cycle.continuityReview);
  const resumed = await f.checkpoint.begin(f.p, { resume: true }, config);
  await runChapterAgent(
    f.p,
    config,
    new AbortController().signal,
    () => {},
    f.checkpoint,
    resumed,
    async (url, init) => {
      assert.ok(
        !JSON.parse(init.body).messages[0].content.includes("仅写当前场景"),
      );
      return normal(url, init);
    },
  );
  assert.equal(resumed.status, "ready");
  assert.equal(resumed.values["final-scene:0"], saved.values["final-scene:0"]);
});
test("审稿截断后恢复编号变化仍沿用13000预算，不重写已存场景", async (t) => {
  const f = await setup(1200),
    normal = responder(),
    seen = [];
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.messages[0].content.includes("小说连续性与文学审稿员")) {
      const data = JSON.parse(body.messages[1].content);
      assert.deepEqual(data.document.sources[0].paragraphs[0][1], [
        1,
        "稿".repeat(1200),
      ]);
      seen.push(body.max_tokens);
      if (seen.length === 1) return response("", "length");
      if (seen.length === 2) throw Error("审稿扩容后断网");
    }
    return normal(url, init);
  };
  const run = (state) =>
    runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      fetcher,
    );
  await assert.rejects(run(f.state), /审稿扩容后断网/);
  const saved = await f.checkpoint.read();
  const resumed = await f.checkpoint.begin(f.p, { resume: true }, config);
  assert.equal(resumed.reviewWorkflow.retry, saved.reviewWorkflow.retry + 1);
  const result = await run(resumed);
  assert.deepEqual(seen, [6500, 13000, 13000, 6500]);
  assert.equal(
    result.proposal.chapters[0].content,
    saved.values["final-scene:0"],
  );
  assert.equal(
    Object.keys(resumed.fragments).filter((key) => key.startsWith("raw-scene:"))
      .length,
    1,
  );
});
test("记忆抽取只发送一份可无损拼回的编号原文，校验和落盘仍保留原文引文", async () => {
  const p = planned();
  const content =
    "第一行保留  两个空格。\r\n\r\n第二行记载他接过钥匙。\n".repeat(160);
  const chapter = { ...p.chapters[0], content };
  const before = structuredClone(p);
  const sent = [];
  const entries = await indexChapter(
    p,
    chapter,
    async (_key, messages, validate) => {
      assert.match(messages[0].content, /records最多16条/);
      assert.match(messages[0].content, /不能把belief填入kind/);
      const data = JSON.parse(messages[1].content);
      assert.ok(!Object.hasOwn(data, "source"));
      sent.push(data.sources.map((s) => s.text).join(""));
      const source = data.sources.find((s) => s.text.trim());
      return validate({
        summary: "原文摘要",
        records: [
          {
            kind: "event",
            text: "人物接过钥匙",
            entities: ["钥匙"],
            storyTime: "未知",
            knownBy: [],
            epistemic: "observed",
            sourceId: source.sourceId,
          },
        ],
      });
    },
  );
  assert.equal(sent.join(""), content);
  assert.equal(entries.map((e) => e.sourceText).join(""), content);
  assert.ok(entries.every((e) => content.includes(e.records[0].quote)));
  assert.deepEqual(p, before);
});
test("继续绕过错误的历史意图缓存，直接按采纳章纲生成首个空白章", async () => {
  const f = await setup(1200);
  try {
    f.p.premise.chapterWords = 1200;
    const state = await f.checkpoint.begin(
      f.p,
      { instruction: "继续" },
      config,
    );
    state.values.intent = {
      mode: "draft",
      targetIds: f.p.chapters.map((c) => c.id),
      totalWords: 35000,
      chapterWords: 5000,
      scopeEvidence: "历史请求；继续",
    };
    await f.checkpoint.write(state);
    const resumed = await f.checkpoint.begin(f.p, { resume: true }, config);
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      resumed,
      responder(),
    );
    assert.equal(result.proposal.chapters[0].content.length, 1200);
    assert.ok(result.proposal.chapters.slice(1).every((c) => !c.content));
    assert.equal(resumed.values.intent.scopeEvidence, "继续");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("MiniMax新请求与失败缓存均按4500字写第二章，保留已采纳第一章", async () => {
  for (const resumed of [false, true]) {
    const f = await setup(4500);
    const minimax = {
      provider: "minimax",
      model: "MiniMax-M3",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "test-only",
    };
    try {
      f.p.premise.chapterWords = 4500;
      f.p.chapters[0].content = "旧".repeat(4135);
      const original = structuredClone(f.p),
        instruction = "开始第二章创作";
      const intent = {
        mode: "draft",
        targetIds: [f.p.chapters[1].id],
        totalWords: 45000,
        chapterWords: 4500,
        scopeEvidence: instruction,
        explanation: "10章，每章4500字，共45000字",
      };
      let state = await f.checkpoint.begin(f.p, { instruction }, minimax);
      if (resumed) {
        state.status = "failed";
        state.error = "单章目标需要为100—10000字，请调整章节范围或字数。";
        state.values["intent-v2"] = structuredClone(intent);
        state.fragments["raw:intent-v2:0"] = JSON.stringify(intent);
        await f.checkpoint.write(state);
        state = await f.checkpoint.begin(f.p, { resume: true }, minimax);
      }
      let intentCalls = 0;
      const normal = responder();
      const result = await runChapterAgent(
        f.p,
        minimax,
        new AbortController().signal,
        () => {},
        f.checkpoint,
        state,
        async (url, opts) => {
          const b = JSON.parse(opts.body);
          if (b.messages[0].content.includes("识别本次创作任务")) {
            intentCalls++;
            return response(intent);
          }
          if (b.messages[0].content.includes("设计恰好"))
            assert.equal(JSON.parse(b.messages[1].content).targetWords, 4500);
          return normal(url, opts);
        },
      );
      assert.equal(intentCalls, resumed ? 0 : 1);
      assert.equal(countWords(result.proposal.chapters[1].content), 4500);
      assert.equal(
        result.proposal.chapters[0].content,
        original.chapters[0].content,
      );
      assert.ok(result.proposal.chapters.slice(2).every((c) => !c.content));
      assert.equal(state.values["intent-v2"].totalWords, null);
      assert.equal(state.values["intent-v2"].chapterWords, null);
      assert.equal(state.wordTarget.words, 4500);
      assert.equal(state.wordTarget.source, "作品设置中的每章字数");
      if (resumed)
        assert.equal(
          state.fragments["raw:intent-v2:0"],
          JSON.stringify(intent),
        );
      assert.deepEqual(f.p, original);
      assert.equal(state.status, "ready");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("过长规划失败响应保存在检查点，纠错只重带任务材料并可完成章节", async () => {
  const f = await setup(1200);
  const normal = responder();
  const invalid = JSON.stringify({ scenes: "无效规划。\n".repeat(6000) });
  let attempts = 0;
  let originalInput;
  try {
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (url, options) => {
        const body = JSON.parse(options.body);
        if (body.messages[0].content.includes("设计恰好")) {
          if (++attempts === 1) {
            originalInput = body.messages[1].content;
            return response(invalid);
          }
          assert.equal(body.messages[1].content, originalInput);
          assert.equal(body.messages.length, 3);
          assert.match(body.messages[2].content, /未附入/);
          assert.ok(!JSON.stringify(body).includes(invalid));
        }
        return normal(url, options);
      },
    );
    assert.equal(attempts, 2);
    assert.equal(result.proposal.chapters[0].content.length, 1200);
    const saved = await f.checkpoint.read();
    assert.equal(saved.fragments["raw:scene-plan:0"], invalid);
    assert.equal(saved.tokenBudget.version, "o200k-base-v1");
    assert.equal(saved.tokenBudget.factor, 1.25);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("明确写作请求的模型依据引用错误时重试，不立即报授权错误", async () => {
  const f = await setup(1200),
    normal = responder();
  let attempts = 0;
  try {
    const state = await f.checkpoint.begin(
      f.p,
      { instruction: "起草第一章1200字" },
      config,
    );
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      async (u, o) => {
        const b = JSON.parse(o.body);
        if (b.messages[0].content.includes("识别本次创作任务")) {
          attempts++;
          return response({
            mode: "draft",
            targetIds: [f.p.chapters[0].id],
            totalWords: null,
            chapterWords: 1200,
            scopeEvidence:
              attempts === 1
                ? "历史指令；起草第一章1200字"
                : "起草第一章1200字",
            explanation: "起草首章",
          });
        }
        return normal(u, o);
      },
    );
    assert.equal(attempts, 2);
    assert.equal(result.proposal.chapters[0].content.length, 1200);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("6000字一章分五个场景，独立候选携带可验证记忆，采纳前正式作品不变", async () => {
  const f = await setup(6000),
    seen = [];
  try {
    const r = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      responder(seen),
    );
    assert.equal(
      r.proposal.chapters[0].content.replace(/\s/g, "").length,
      6000,
    );
    assert.equal(
      seen.filter((b) => b.messages[0].content.includes("仅写当前场景")).length,
      5,
    );
    assert.equal(f.p.chapters[0].content, "");
    assert.ok(r.proposal.memory.entries.length >= 2);
    const accepted = applyProposal(f.p, r.proposal, f.p.revision);
    assert.ok(accepted.memory.entries.every((e) => isCurrent(e, accepted)));
    assert.equal((await f.checkpoint.read()).status, "ready");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("第二场景断网后重启恢复，不重新生成第一场景；基础设定修改拒绝恢复", async () => {
  const f = await setup(),
    seen = [];
  try {
    await assert.rejects(
      () =>
        runChapterAgent(
          f.p,
          config,
          new AbortController().signal,
          () => {},
          f.checkpoint,
          f.state,
          responder(seen, 3),
        ),
      /网络断开/,
    );
    assert.ok((await f.checkpoint.read()).values["final-scene:0"]);
    const restarted = new Checkpoint(f.dir),
      state = await restarted.begin(f.p, { resume: true }, config),
      replayed = [];
    await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      restarted,
      state,
      responder(replayed),
    );
    assert.equal(
      replayed.filter((b) => b.messages[0].content.includes("仅写当前场景"))
        .length,
      1,
    );
    const changed = structuredClone(f.p);
    changed.premise.theme = "新主题";
    await assert.rejects(
      () => restarted.begin(changed, { resume: true }, config),
      /过期/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("length输出保存后续写，完整片段不丢失且不会被当成完整场景", async () => {
  const f = await setup(1200);
  let writes = 0;
  const normal = responder();
  try {
    const fetcher = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.messages[0].content.includes("仅写当前场景")) {
        if (++writes === 1) return response("甲".repeat(600), "length");
        assert.equal(
          JSON.parse(body.messages[1].content).alreadyWritten.length,
          600,
        );
        return response("乙".repeat(600) + "〈场景完成〉");
      }
      return normal(url, opts);
    };
    const r = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      fetcher,
    );
    assert.equal(writes, 2);
    assert.ok(r.proposal.chapters[0].content.startsWith("甲".repeat(600)));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("第58章引用第12章取回原文，其他章改稿不使本章记忆失效；未指定回忆来源拒绝猜测", () => {
  const p = planned();
  p.chapters = Array.from({ length: 58 }, (_, i) => ({
    id: `c${i + 1}`,
    number: i + 1,
    title: `章节${i + 1}`,
    summary: "调查",
    content: i === 57 ? "" : "普通事件。",
  }));
  p.chapters[11].content = "姐姐在车站交出钥匙，没有说明伤口来源。";
  p.chapters[34].content = "主角得知姐姐曾进入档案室。";
  const c = p.chapters[11];
  const entry = {
    chapterId: c.id,
    part: 0,
    sourceHash: digest(c.content),
    sourceStart: 0,
    sourceEnd: c.content.length,
    sourceText: c.content,
    summary: "姐姐交钥匙",
    records: [],
  };
  const ctx = contextFor(p, p.chapters[57], "回忆第12章交钥匙事件", [entry]);
  assert.equal(ctx.context.recallSources[0].content, c.content);
  assert.ok(!JSON.stringify(ctx.context).includes(p.plan.truth));
  assert.throws(
    () => contextFor(p, p.chapters[57], "回忆当年的事", [entry]),
    /来源/,
  );
  p.chapters[0].content = "改过的历史。";
  assert.equal(isCurrent(entry, p), true);
  assert.equal(
    contextFor(p, p.chapters[57], "调查", [entry]).context.evidence.length,
    0,
  );
});
test("记忆引用必须确实存在，只有章纲不计作记忆，超长必需证据明确拒绝", () => {
  assert.throws(
    () =>
      validateExtraction(
        {
          summary: "摘要",
          records: [
            {
              kind: "event",
              text: "事件",
              entities: [],
              storyTime: "未知",
              knownBy: [],
              epistemic: "observed",
              quote: "编造",
            },
          ],
        },
        "真实原文",
      ),
    /引用/,
  );
  const p = planned();
  assert.equal(
    memoryView(p).chapters.some((c) => c.indexed),
    false,
  );
  p.chapters[0].content = "文".repeat(40000);
  assert.throws(() => contextFor(p, p.chapters[1], "回忆第1章", []), /预算/);
  assert.equal(
    sourceParts("文".repeat(9000))
      .map((p) => p.text)
      .join("").length,
    9000,
  );
});

test("记忆按编号回填准确原文，拒绝越界编号并兼容已保存引文", () => {
  const source = "是鱼干，一层压一层码得实实的。\n\n" + "原文".repeat(800);
  const sources = memorySources(source);
  assert.equal(sources.map((s) => s.text).join(""), source);
  assert.ok(sources.every((s) => s.text.length <= 600));
  const record = {
    kind: "event",
    text: "鱼干堆叠",
    entities: [],
    storyTime: "未知",
    knownBy: [],
    epistemic: "observed",
    sourceId: 1,
    quote: "模型抄错的文本",
  };
  const value = { summary: "摘要", records: [record] };
  const result = validateExtraction(value, source);
  assert.equal(result.records[0].quote, sources[0].text);
  assert.equal(result.records[0].sourceId, undefined);
  assert.deepEqual(validateExtraction(result, source), result);
  for (const sourceId of [0, -1, 1.5, "1", 9999, 2]) {
    assert.throws(
      () =>
        validateExtraction(
          { ...value, records: [{ ...record, sourceId }] },
          source,
        ),
      /sourceId/,
    );
  }
});

test("旧任务的记忆编号失败后恢复只重做记忆，不重写场景或重跑审稿", async () => {
  const f = await setup(1200),
    normal = responder();
  delete f.state.continuityVersion;
  let invalid = true,
    memoryCalls = 0,
    otherCalls = 0;
  const fetcher = async (u, o) => {
    const b = JSON.parse(o.body);
    if (!b.messages[0].content.includes("从提供的小说原文抽取")) {
      otherCalls++;
      return normal(u, o);
    }
    memoryCalls++;
    const data = JSON.parse(b.messages[1].content);
    assert.ok(data.sources.length);
    return response({
      summary: "摘要",
      records: [
        {
          kind: "event",
          text: "正文事件",
          entities: [],
          storyTime: "未知",
          knownBy: [],
          epistemic: "observed",
          sourceId: invalid ? 9999 : 1,
        },
      ],
    });
  };
  try {
    await assert.rejects(
      () =>
        runChapterAgent(
          f.p,
          config,
          new AbortController().signal,
          () => {},
          f.checkpoint,
          f.state,
          fetcher,
        ),
      /sourceId/,
    );
    assert.equal(memoryCalls, 2);
    const callsBefore = otherCalls;
    const saved = await f.checkpoint.read();
    const text = saved.values["final-scene:0"];
    invalid = false;
    const state = await f.checkpoint.begin(f.p, { resume: true }, config);
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      fetcher,
    );
    assert.equal(otherCalls, callsBefore);
    assert.equal(result.proposal.chapters[0].content, text);
    assert.ok(
      result.proposal.memory.entries.every((e) =>
        e.records.every((r) => e.sourceText.includes(r.quote)),
      ),
    );
    assert.equal(state.status, "ready");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("同一检查点不能跨模型恢复，取消保留已完成产物但不返回候选", async () => {
  const f = await setup(),
    control = new AbortController();
  try {
    await assert.rejects(
      () =>
        f.checkpoint.begin(
          f.p,
          { resume: true },
          { ...config, model: "glm-other" },
        ),
      /原来的/,
    );
    const normal = responder();
    await assert.rejects(
      () =>
        runChapterAgent(
          f.p,
          config,
          control.signal,
          (label) => {
            if (label.includes("场景 2")) control.abort();
          },
          f.checkpoint,
          f.state,
          normal,
        ),
      /abort/i,
    );
    assert.ok((await f.checkpoint.read()).values["final-scene:0"]);
    assert.equal((await f.checkpoint.read()).status, "interrupted");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("完整短场景在整章容差内直接进入审稿，不为凑目标字数改写", async () => {
  const f = await setup(1200),
    normal = responder();
  let repairs = 0,
    writes = 0;
  try {
    const fetcher = async (url, opts) => {
      const body = JSON.parse(opts.body),
        sys = body.messages[0].content;
      if (sys.includes("仅写当前场景")) {
        writes++;
        return response("短".repeat(800) + "〈场景完成〉");
      }
      if (sys.includes("当前场景已结束但字数")) {
        repairs++;
        return response("长".repeat(1200) + "〈场景完成〉");
      }
      return normal(url, opts);
    };
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      fetcher,
    );
    assert.equal(writes, 1);
    assert.equal(repairs, 0);
    assert.equal(result.proposal.chapters[0].content, "短".repeat(800));
    assert.ok(
      Object.keys((await f.checkpoint.read()).fragments).some((k) =>
        k.startsWith("raw-scene:"),
      ),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("篇幅调整反复返回原稿或更长稿时不覆盖较优草稿，下一次携带实测反馈", async () => {
  const f = await setup(1200),
    normal = responder();
  let repairs = 0;
  try {
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (url, opts) => {
        const b = JSON.parse(opts.body),
          sys = b.messages[0].content;
        if (sys.includes("仅写当前场景"))
          return response("初".repeat(2200) + "〈场景完成〉");
        if (sys.includes("当前场景已结束但字数")) {
          const data = JSON.parse(b.messages[1].content);
          assert.equal(data.draft, "初".repeat(2200));
          assert.equal(data.attempts.length, repairs);
          repairs++;
          return response(
            (repairs === 1
              ? "坏".repeat(3000)
              : repairs === 2
                ? "初".repeat(2200)
                : "好".repeat(1200)) + "〈场景完成〉",
          );
        }
        return normal(url, opts);
      },
    );
    assert.equal(result.proposal.chapters[0].content, "好".repeat(1200));
    assert.deepEqual(
      Object.values(f.state.lengthRepairs)[0].attempts.map((a) => a.improved),
      [false, false, true],
    );
    assert.equal(
      Object.entries(f.state.fragments).find(([key]) =>
        key.startsWith("length-original:"),
      )[1],
      "初".repeat(2200),
    );
    assert.equal(
      Object.keys(f.state.fragments).filter((k) => k.startsWith("raw-repair:"))
        .length,
      3,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("篇幅失败后恢复保留较优原稿与调整历史，不重写已完成场景", async () => {
  const f = await setup(1200),
    normal = responder();
  let writes = 0;
  const fail = async (url, opts) => {
    const sys = JSON.parse(opts.body).messages[0].content;
    if (sys.includes("仅写当前场景")) {
      writes++;
      return response("初".repeat(2200) + "〈场景完成〉");
    }
    if (sys.includes("当前场景已结束但字数"))
      return response("坏".repeat(3000) + "〈场景完成〉");
    return normal(url, opts);
  };
  try {
    await assert.rejects(
      () =>
        runChapterAgent(
          f.p,
          config,
          new AbortController().signal,
          () => {},
          f.checkpoint,
          f.state,
          fail,
        ),
      /整章篇幅调整后仍超出700—1700字/,
    );
    const state = await f.checkpoint.begin(f.p, { resume: true }, config);
    assert.equal(state.fragments["scene:0:round:0"], "初".repeat(2200));
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      async (url, opts) => {
        const b = JSON.parse(opts.body);
        if (b.messages[0].content.includes("当前场景已结束但字数")) {
          const data = JSON.parse(b.messages[1].content);
          assert.equal(data.attempts.length, 3);
          assert.equal(data.draft, "初".repeat(2200));
          return response("好".repeat(1200));
        }
        return fail(url, opts);
      },
    );
    assert.equal(writes, 1);
    assert.equal(result.proposal.chapters[0].content, "好".repeat(1200));
    assert.equal(Object.values(state.lengthRepairs)[0].attempts.length, 4);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("修订输入保留原章，后续章节不作为当前章的既有事实", () => {
  const p = planned();
  p.chapters[0].content = "本章已采纳原稿";
  p.chapters[1].content = "未来章节秘密标记";
  const c = contextFor(p, p.chapters[0], "修订本章", []).context;
  assert.equal(c.originalChapter, "本章已采纳原稿");
  assert.ok(!JSON.stringify(c).includes("未来章节秘密标记"));
});

test("修订后审稿断网仍可恢复，不拿旧引文去校验新正文", async () => {
  const f = await setup(1200),
    normal = responder();
  let reviewCount = 0,
    repairCount = 0;
  try {
    const fetcher = async (url, opts) => {
      const b = JSON.parse(opts.body),
        sys = b.messages[0].content;
      if (sys.includes("小说连续性与文学审稿员")) {
        reviewCount++;
        if (reviewCount === 1)
          return response(missingFinding(JSON.parse(b.messages[1].content)));
        if (reviewCount === 2) throw Error("审稿网络中断");
      }
      if (sys.includes("小说段落修订编辑")) {
        repairCount++;
        return patchResponse(JSON.parse(b.messages[1].content));
      }
      return normal(url, opts);
    };
    await assert.rejects(
      () =>
        runChapterAgent(
          f.p,
          config,
          new AbortController().signal,
          () => {},
          f.checkpoint,
          f.state,
          fetcher,
        ),
      /网络中断/,
    );
    const state = await f.checkpoint.begin(f.p, { resume: true }, config);
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      fetcher,
    );
    assert.equal(result.proposal.chapters[0].content, "改".repeat(1200));
    assert.equal(repairCount, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("当前章后续场景保留本章此前完整正文，不能丢掉开头的地点与物件状态", async () => {
  const f = await setup(2400),
    normal = responder(),
    seen = [];
  try {
    await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (u, o) => {
        const b = JSON.parse(o.body);
        if (b.messages[0].content.includes("仅写当前场景"))
          seen.push(JSON.parse(b.messages[1].content));
        return normal(u, o);
      },
    );
    assert.equal(seen[1].previousScenes[0].content.length, 1200);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("对话请求多章时只交付首章候选，并明确后续章节尚待逐章完成", async () => {
  const f = await setup(1200),
    normal = responder();
  try {
    const req = { instruction: "起草前两章，每章1200字" };
    const state = await f.checkpoint.begin(f.p, req, config);
    const r = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      async (u, o) => {
        const b = JSON.parse(o.body);
        if (b.messages[0].content.includes("识别本次创作任务"))
          return response({
            mode: "draft",
            targetIds: f.p.chapters.slice(0, 2).map((c) => c.id),
            totalWords: null,
            chapterWords: 1200,
            scopeEvidence: "起草前两章",
            explanation: "请求两章",
          });
        return normal(u, o);
      },
    );
    assert.ok(r.proposal.chapters[0].content);
    assert.equal(r.proposal.chapters[1].content, "");
    assert.match(r.proposal.summary, /另外1章/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("新章节审稿按段落编号回填引文，修订收到真实原文而不是模型抄写", async () => {
  const f = await setup(1200),
    normal = responder();
  let reviews = 0,
    feedback;
  try {
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (u, o) => {
        const b = JSON.parse(o.body),
          sys = b.messages[0].content,
          data = JSON.parse(b.messages[1].content);
        if (sys.includes("小说连续性与文学审稿员") && ++reviews === 1) {
          assert.equal(data.document.sources[0].paragraphs[0][0], 1);
          return response(missingFinding(data));
        }
        if (sys.includes("小说段落修订编辑")) {
          feedback = data.issues;
          return patchResponse(data);
        }
        return normal(u, o);
      },
    );
    assert.deepEqual(feedback[0].target, { sourceId: "scene:1", paragraph: 1 });
    assert.equal(feedback[0].target.quote, undefined);
    assert.equal(result.proposal.chapters[0].content, "改".repeat(1200));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("场景篇幅可以浮动，但整章超长必须调整后才能交付", async () => {
  const f = await setup(2400),
    normal = responder();
  let repairs = 0;
  try {
    const r = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (u, o) => {
        const b = JSON.parse(o.body),
          sys = b.messages[0].content;
        if (sys.includes("仅写当前场景"))
          return response("长".repeat(1800) + "〈场景完成〉");
        if (sys.includes("当前场景已结束但字数")) {
          repairs++;
          const goal = Number(sys.match(/完整正文到(\d+)字/)[1]);
          return response("调".repeat(goal) + "〈场景完成〉");
        }
        return normal(u, o);
      },
    );
    const words = countWords(r.proposal.chapters[0].content);
    assert.ok(words >= 1900 && words <= 2900);
    assert.equal(repairs, 2);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("整章超长按占比分担，不把全部差额强压到单个场景", async () => {
  const f = await setup(4500),
    normal = responder(),
    lengths = [1148, 1593, 1763, 1428],
    goals = [];
  try {
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (url, opts) => {
        const b = JSON.parse(opts.body),
          sys = b.messages[0].content,
          data = JSON.parse(b.messages[1].content);
        if (sys.includes("仅写当前场景"))
          return response(
            "稿".repeat(lengths[data.sceneIndex - 1]) + "〈场景完成〉",
          );
        if (sys.includes("当前场景已结束但字数")) {
          goals.push(data.task.targetWords);
          assert.ok(
            data.task.targetWords >= 1000,
            "不能将1763字的场景强压到331字",
          );
          return response("调".repeat(data.task.targetWords) + "〈场景完成〉");
        }
        return normal(url, opts);
      },
    );
    const words = countWords(result.proposal.chapters[0].content);
    assert.ok(words >= 4000 && words <= 5000);
    assert.ok(goals.length >= 2);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("整章边界内允许不均匀场景，5001字仍须调整并按相同范围审稿", async () => {
  for (const lengths of [
    [2100, 600, 700, 600],
    [2200, 800, 1000, 1000],
    [1700, 1200, 1051, 1050],
  ]) {
    const f = await setup(4500),
      normal = responder();
    let repairs = 0;
    try {
      const result = await runChapterAgent(
        f.p,
        config,
        new AbortController().signal,
        () => {},
        f.checkpoint,
        f.state,
        async (url, opts) => {
          const b = JSON.parse(opts.body),
            sys = b.messages[0].content,
            data = JSON.parse(b.messages[1].content);
          if (sys.includes("仅写当前场景"))
            return response(
              "稿".repeat(lengths[data.sceneIndex - 1]) + "〈场景完成〉",
            );
          if (sys.includes("当前场景已结束但字数")) {
            repairs++;
            // 单场可低于参考范围，只要整章落在容差内就应接受。
            return response("调".repeat(1000));
          }
          return normal(url, opts);
        },
      );
      const total = lengths.reduce((a, b) => a + b, 0),
        actual = countWords(result.proposal.chapters[0].content);
      assert.equal(repairs, total === 5001 ? 1 : 0);
      assert.ok(actual >= 4000 && actual <= 5000);
      if (!repairs) assert.equal(actual, total);
      assert.equal(f.state.wordTarget.min, 4000);
      assert.equal(f.state.wordTarget.max, 5000);
      assert.match(result.proposal.summary, /允许4000—5000字/);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("新任务按作品配置校验，长章百分比容差和大于500字的固定容差均可交付", async () => {
  for (const fixture of [
    {
      target: 4500,
      tolerance: { mode: "absolute", value: 2000 },
      lengths: [1800, 1700, 1600, 1400],
      min: 2500,
      max: 6500,
    },
    {
      target: 10000,
      tolerance: { mode: "percent", value: 20 },
      lengths: [...Array(8).fill(1333), 1336],
      min: 8000,
      max: 12000,
    },
  ]) {
    const f = await setup(fixture.target),
      normal = responder();
    try {
      f.p.writingSettings = { wordTolerance: fixture.tolerance };
      const state = await f.checkpoint.begin(f.p, f.req, config);
      const result = await runChapterAgent(
        f.p,
        config,
        new AbortController().signal,
        () => {},
        f.checkpoint,
        state,
        async (url, opts) => {
          const b = JSON.parse(opts.body),
            sys = b.messages[0].content,
            data = JSON.parse(b.messages[1].content);
          if (sys.includes("仅写当前场景")) {
            assert.ok(sys.includes(`允许${fixture.min}—${fixture.max}字`));
            return response(
              "稿".repeat(fixture.lengths[data.sceneIndex - 1]) +
                "〈场景完成〉",
            );
          }
          assert.ok(
            !sys.includes("当前场景已结束但字数"),
            "已在配置范围内，不应再做篇幅调整",
          );
          return normal(url, opts);
        },
      );
      assert.equal(
        countWords(result.proposal.chapters[0].content),
        fixture.max,
      );
      assert.equal(state.wordTarget.min, fixture.min);
      assert.equal(state.wordTarget.max, fixture.max);
      assert.deepEqual(state.wordTarget.tolerance, fixture.tolerance);
      assert.equal(state.status, "ready");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("单场三次压缩仍高于参考范围时保留进展，继续调整其他场景直到整章达标", async () => {
  const f = await setup(4500),
    normal = responder(),
    lengths = [1148, 1593, 1763, 1428];
  let repairs = 0;
  try {
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (url, opts) => {
        const b = JSON.parse(opts.body),
          sys = b.messages[0].content,
          data = JSON.parse(b.messages[1].content);
        if (sys.includes("仅写当前场景"))
          return response(
            "稿".repeat(lengths[data.sceneIndex - 1]) + "〈场景完成〉",
          );
        if (sys.includes("当前场景已结束但字数")) {
          repairs++;
          return response(
            "调".repeat(
              repairs <= 3 ? data.task.actualWords - 70 : data.task.targetWords,
            ),
          );
        }
        return normal(url, opts);
      },
    );
    assert.ok(repairs > 3);
    assert.equal(Object.values(f.state.lengthRepairs)[0].attempts.length, 3);
    const actual = countWords(result.proposal.chapters[0].content);
    assert.ok(actual >= 4000 && actual <= 5000);
    assert.equal(f.state.status, "ready");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("完整章节链路暂停后提交作者选择，保留场景并继续到候选记忆", async () => {
  const f = await setup(1200),
    normal = responder();
  let reviews = 0,
    writes = 0;
  const fetcher = async (u, o) => {
    const b = JSON.parse(o.body),
      sys = b.messages[0].content,
      data = JSON.parse(b.messages[1].content);
    if (sys.includes("仅写当前场景")) writes++;
    if (sys.includes("小说连续性与文学审稿员") && ++reviews === 1) {
      const v = missingFinding(data);
      v.issues[0].resolution = "needs_confirmation";
      return response(v);
    }
    if (sys.includes("连续性裁决员"))
      return response({
        decisions: data.issues.map((i) => ({
          issueId: i.id,
          action: "needs_confirmation",
          evidenceIndexes: [],
          reason: "关键前情无法判断",
        })),
      });
    return normal(u, o);
  };
  try {
    await assert.rejects(
      () =>
        runChapterAgent(
          f.p,
          config,
          new AbortController().signal,
          () => {},
          f.checkpoint,
          f.state,
          fetcher,
        ),
      { name: "WaitingForAuthor" },
    );
    const paused = await f.checkpoint.read();
    assert.equal(paused.status, "awaiting_input");
    assert.equal(paused.error, "");
    assert.equal(f.p.chapters[0].content, "");
    const state = await f.checkpoint.begin(
      f.p,
      {
        resume: true,
        decision: {
          taskId: paused.id,
          pendingId: paused.pendingReview.id,
          choices: paused.pendingReview.issues.map((i) => ({
            issueId: i.id,
            optionId: "remove",
          })),
        },
      },
      config,
    );
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      state,
      fetcher,
    );
    assert.equal(writes, 1);
    assert.equal(result.proposal.chapters[0].content, "改".repeat(1200));
    assert.ok(result.proposal.memory.entries.length);
    assert.equal(state.pendingReview, undefined);
    assert.equal(state.authorReviewHistory.length, 1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("正常结束且达到场景篇幅时漏完成标记不再额外续写", async () => {
  const f = await setup(1200),
    normal = responder();
  let writes = 0;
  try {
    const result = await runChapterAgent(
      f.p,
      config,
      new AbortController().signal,
      () => {},
      f.checkpoint,
      f.state,
      async (u, o) => {
        const body = JSON.parse(o.body);
        if (body.messages[0].content.includes("仅写当前场景")) {
          writes++;
          return response("正文".repeat(600));
        }
        return normal(u, o);
      },
    );
    assert.equal(writes, 1);
    assert.equal(result.proposal.chapters[0].content, "正文".repeat(600));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("篇幅修订正常结束但漏标记仍保存结果并进入审稿，截断仍拒绝", async () => {
  for (const finish of ["stop", "length"]) {
    const f = await setup(1200),
      normal = responder();
    let repairs = 0;
    try {
      const run = () =>
        runChapterAgent(
          f.p,
          config,
          new AbortController().signal,
          () => {},
          f.checkpoint,
          f.state,
          async (u, o) => {
            const body = JSON.parse(o.body),
              sys = body.messages[0].content;
            if (sys.includes("仅写当前场景"))
              return response("短".repeat(500) + "〈场景完成〉");
            if (sys.includes("当前场景已结束但字数")) {
              repairs++;
              return response(
                "修".repeat(1200) + (finish === "length" ? "〈场景完成〉" : ""),
                finish,
              );
            }
            return normal(u, o);
          },
        );
      if (finish === "stop") {
        const result = await run();
        assert.equal(result.proposal.chapters[0].content, "修".repeat(1200));
        assert.equal(f.state.status, "ready");
      } else {
        await assert.rejects(run, /未完整结束/);
        assert.equal(f.state.values["final-scene:0"], "短".repeat(500));
        assert.equal(f.state.fragments["scene:0:round:0"], "短".repeat(500));
        assert.ok(
          Object.keys(f.state.fragments).some((k) =>
            k.startsWith("raw-repair:"),
          ),
        );
      }
      assert.equal(repairs, 1);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
