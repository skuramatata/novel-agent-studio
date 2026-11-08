import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject, demoProposal } from "../runtime/seed.mjs";
import { applyProposal, proposalSchema, projectSchema } from "../runtime/schema.mjs";
import { ProjectStore } from "../runtime/storage.mjs";
import {
  digest,
  emptyStoryEvents,
  mergeStoryEvents,
  impactOf,
  storyEventId,
  storyEventIssues,
} from "../runtime/story-events.mjs";
import {
  extractStoryEvents,
  applyStoryEventProposal,
  checkStoryEvents,
  reviewDisposition,
  storyEventsForProposal,
} from "../runtime/story-event-agent.mjs";
import { storyEventContext } from "../runtime/story-event-context.mjs";

const ch1 = {
  id: "ch1",
  number: 1,
  title: "顺济号出航",
  summary: "林砚登船",
  content: "林砚把铜扣交给父亲。汽笛响了三声，顺济号离岸。",
};
const ch2 = {
  id: "ch2",
  number: 2,
  title: "黑石岛",
  summary: "登岛",
  content: "雾里露出黑石岛的轮廓。顾言章举起信号枪，朝天上打了一发。",
};
const ch4 = {
  id: "ch4",
  number: 4,
  title: "慎终如始",
  summary: "守夜",
  content: "惠新说，他在船上听过它响。众人沉默。",
};
const ch5 = {
  id: "ch5",
  number: 5,
  title: "六听罐头",
  summary: "清点",
  content: "惠新数出十八听罐头。老周坚持是二十四听。",
};

const project = () =>
  applyProposal(
    blankProject(),
    {
      ...demoProposal(),
      chapters: [ch1, ch2, ch4, ch5].map((c) => ({ ...c, content: "" })),
    },
    0,
  );

const withContent = () => {
  const p = project();
  return {
    ...p,
    chapters: p.chapters.map((c) => {
      const found = [ch1, ch2, ch4, ch5].find((x) => x.id === c.id);
      return found ? { ...c, content: found.content } : c;
    }),
  };
};

const draftNode = (source, patch = {}) => ({
  chapterId: source.id,
  title: patch.title ?? "事件",
  summary: patch.summary ?? "",
  kind: patch.kind ?? "action",
  actors: patch.actors ?? [],
  objects: patch.objects ?? [],
  basis: patch.basis ?? "narration",
  status: patch.status ?? "confirmed",
  ...(patch.storyTime !== undefined ? { storyTime: patch.storyTime } : {}),
  evidence: {
    start: patch.start ?? 0,
    end: patch.end ?? source.content.length,
    quote: patch.quote ?? source.content.slice(patch.start ?? 0, patch.end ?? source.content.length),
  },
});

// 逐章、逐分片抽取：模型只给事件内容与区间，程序回填原文并建图。
const mockAsk = (records) => {
  const calls = [];
  const ask = async (key, messages, validate, tokens, label) => {
    calls.push({ key, label, messages });
    const chapter = JSON.parse(messages[1].content);
    const value = { summary: "本片摘要", events: records(chapter) };
    return validate(value);
  };
  ask.calls = calls;
  return ask;
};

test("逐章逐分片抽取事件，覆盖记录写 extracted 并落到正式图", async () => {
  const p = withContent();
  const ask = mockAsk(() => [
    {
      title: "林砚交出铜扣",
      summary: "林砚把铜扣交给父亲",
      kind: "handover",
      actors: ["林砚", "林父"],
      objects: ["铜扣"],
      basis: "narration",
      start: 0,
      end: 9,
      quote: "林砚把铜扣交给父亲",
    },
  ]);
  const result = await extractStoryEvents(p, ask, { chapterIds: ["ch1"] });
  assert.equal(result.storyEvents.nodes.length, 1);
  assert.equal(result.coverage[0].chapterId, "ch1");
  assert.equal(result.coverage[0].status, "extracted");
  assert.deepEqual(result.coverage[0].parts, [0]);
  assert.equal(ask.calls.length >= 1, true);
  assert.match(result.storyEvents.nodes[0].id, /^sev-/);
});

test("每章都要处理：未抽取的章节记为 pending 而不是假装已覆盖", async () => {
  const p = withContent();
  const ask = mockAsk(() => []);
  const result = await extractStoryEvents(p, ask, { chapterIds: ["ch1"] });
  const ids = result.coverage.map((c) => c.chapterId);
  assert.deepEqual(ids.sort(), ["ch1", "ch2", "ch4", "ch5"].sort());
  const pending = result.coverage.filter((c) => c.status === "pending");
  assert.equal(pending.length, 3);
});

test("抽取失败记 failed 并保留原因，不中断其他章节", async () => {
  const p = withContent();
  let call = 0;
  const ask = async (key, messages, validate) => {
    call += 1;
    if (JSON.parse(messages[1].content).chapterId === "ch2")
      throw Error("模型超时");
    return validate({ summary: "ok", events: [] });
  };
  const result = await extractStoryEvents(p, ask, { chapterIds: ["ch1", "ch2"] });
  const failed = result.coverage.find((c) => c.chapterId === "ch2");
  assert.equal(failed.status, "failed");
  assert.match(failed.failure, /超时/);
  assert.equal(result.coverage.find((c) => c.chapterId === "ch1").status, "extracted");
  assert.ok(call >= 2);
});

test("规划前上下文含事件节点与边 id，并区分沿用历史与本章新增", async () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch1, { title: "林砚交出铜扣", end: 9, quote: "林砚把铜扣交给父亲", actors: ["林砚"], objects: ["铜扣"] }),
      draftNode(ch2, { title: "顾言章放信号枪", start: 11, end: 19, quote: "顾言章举起信号枪", kind: "action", actors: ["顾言章"], objects: ["信号枪"] }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const [first, second] = built.nodes;
  const recalled = mergeStoryEvents(
    { ...built, nodes: built.nodes },
    [],
    {
      chapters: p.chapters,
      edges: [
        {
          source: first.id,
          target: second.id,
          type: "recall",
          basis: "explicit",
          explanation: "第四章回忆起第二章的信号枪",
          evidence: [{ chapterId: "ch1", start: 0, end: 9, quote: "林砚把铜扣交给父亲" }],
        },
      ],
    },
  ).storyEvents;

  const view = storyEventContext(
    { ...p, storyEvents: recalled },
    p.chapters.find((c) => c.id === "ch4"),
    { instruction: "惠新回忆船上的信号枪" },
  );
  assert.ok(view.eventNodes.length >= 1);
  assert.ok(view.eventEdges.length >= 1);
  const ids = new Set([...view.eventNodes.map((n) => n.id), ...view.eventEdges.map((e) => e.id)]);
  const text = JSON.stringify(view);
  for (const id of ids) assert.ok(text.includes(id), `上下文缺少 ${id}`);
  assert.equal(view.historicalEventIds.length + view.newEventIds.length, ids.size - view.eventEdges.length);
  assert.ok(Array.isArray(view.coverage));
  assert.ok(view.missNote);
});

test("检索未命中时写明覆盖范围，不宣称全书不存在", () => {
  const p = withContent();
  const view = storyEventContext(
    { ...p, storyEvents: emptyStoryEvents() },
    p.chapters.find((c) => c.id === "ch4"),
    { instruction: "找一个根本不存在的人物" },
  );
  assert.equal(view.eventNodes.length, 0);
  assert.match(view.missNote, /未命中/);
  assert.match(view.missNote, /不代表全书不存在|不代表.*不存在/);
  assert.ok(view.coverage.some((c) => c.status === "pending" || c.status === "extracted"));
});

test("候选增量在采纳前不进入正式 storyEvents，放弃后正式数据 hash 不变", async () => {
  const p = withContent();
  const before = digest(JSON.stringify(p.storyEvents ?? null));
  const ask = mockAsk(() => [
    {
      title: "惠新说听过信号枪",
      summary: "惠新回忆船上听到枪响",
      kind: "recall",
      actors: ["惠新"],
      objects: ["信号枪"],
      basis: "testimony",
      start: 0,
      end: 15,
      quote: "他在船上听过它响",
    },
  ]);
  const result = await extractStoryEvents(p, ask, { chapterIds: ["ch4"] });
  assert.equal(p.storyEvents, undefined, "抽取不得直接改正式作品");
  const candidate = { summary: "候选", storyEvents: result.storyEvents };
  assert.ok(proposalSchema.parse(candidate).storyEvents);
  const afterReject = digest(JSON.stringify(p.storyEvents ?? null));
  assert.equal(afterReject, before);
});

test("采纳后正式 storyEvents 才更新，且保存往返不丢", async () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch1, { title: "林砚交出铜扣", end: 9, quote: "林砚把铜扣交给父亲" })],
    { chapters: p.chapters },
  ).storyEvents;
  const accepted = applyStoryEventProposal(p, { storyEvents: built });
  assert.equal(accepted.storyEvents.nodes.length, 1);
  assert.notEqual(accepted, p);
  const dir = await mkdtemp(join(tmpdir(), "story-event-workflow-"));
  try {
    const store = new ProjectStore(dir);
    const base = await store.load();
    await store.save({ ...base, revision: p.revision, storyEvents: built }, base.revision);
    const loaded = await new ProjectStore(dir).load();
    assert.equal(loaded.storyEvents.nodes.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 首辅取证的语义样本：ch4 回顾 ch2 信号枪是合法 recall；ch5 罐头数量与 ch4 怀表是 state-break。
test("ch4 回顾 ch2 信号枪是合法 recall 边，不报 state-break", async () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch2, { title: "顾言章放信号枪", start: 11, end: 27, quote: "顾言章举起信号枪，朝天上打了一发" }),
      draftNode(ch4, { title: "惠新说听过枪响", start: 4, end: 12, quote: "他在船上听过它响", kind: "recall", basis: "testimony" }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  assert.equal(
    built.nodes.length,
    2,
    "前置：两个事件都应建立 | issues=" +
      JSON.stringify(built.issues.map((i) => i.explanation)),
  );
  const [gun, recall] = built.nodes;
  const linked = mergeStoryEvents(built, [], {
    chapters: p.chapters,
    edges: [
      {
        source: gun.id,
        target: recall.id,
        type: "recall",
        basis: "explicit",
        explanation: "惠新回忆的是第二章顾言章放的信号枪",
        evidence: [{ chapterId: "ch4", start: 4, end: 12, quote: "他在船上听过它响" }],
      },
    ],
  }).storyEvents;
  assert.equal(linked.edges.length, 1);
  const checked = checkStoryEvents(p, linked);
  assert.equal(checked.issues.filter((i) => i.kind === "state-break").length, 0);
});

test("ch5 罐头数量与 ch4 怀表状态应生成 state-break 候选，不自动改正文", async () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch5, { title: "惠新数出十八听", start: 0, end: 9, quote: "惠新数出十八听罐头", kind: "discovery", objects: ["罐头"] }),
      draftNode(ch5, { title: "老周坚持二十四听", start: 10, end: 19, quote: "老周坚持是二十四听", kind: "state-change", objects: ["罐头"] }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(p, built);
  const breaks = checked.issues.filter((i) => i.kind === "state-break");
  assert.ok(breaks.length >= 1);
  assert.equal(breaks[0].disposition, "open");
  assert.equal(p.chapters.find((c) => c.id === "ch5").content, ch5.content);
});

test("无来源知情生成 unsourced-knowledge 且 disposition 可被作者处理", async () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch5, {
        title: "惠新知道罐头是二十四听",
        start: 0,
        end: 9,
        quote: "惠新数出十八听罐头",
        actors: ["惠新"],
        objects: ["罐头"],
      }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(p, built, {
    knowledgeClaims: [
      {
        actor: "惠新",
        subject: "罐头数量",
        claimedAt: { chapterId: "ch5", start: 0, end: 9, quote: "惠新数出十八听罐头" },
        learnedIn: [],
      },
    ],
  });
  const unsourced = checked.issues.filter((i) => i.kind === "unsourced-knowledge");
  assert.equal(unsourced.length, 1);
  assert.equal(unsourced[0].disposition, "open");
  const decided = reviewDisposition(checked, unsourced[0].id, "author-decided");
  assert.equal(storyEventIssues(decided, { disposition: "author-decided" }).length, 1);
  assert.equal(storyEventIssues(decided, { disposition: "open" }).length, 0);
});

test("前文改稿后事件链标 stale 并给出待复核清单，不重写后文", async () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch1, { title: "林砚交出铜扣", end: 9, quote: "林砚把铜扣交给父亲" })],
    { chapters: p.chapters },
  ).storyEvents;
  const revised = {
    ...p,
    chapters: p.chapters.map((c) =>
      c.id === "ch1" ? { ...c, content: "林砚把钥匙交给父亲。汽笛响了三声，顺济号离岸。" } : c,
    ),
  };
  const impact = impactOf(built, revised);
  assert.equal(impact.staleNodeIds.length, 1);
  assert.ok(impact.issues.some((i) => i.kind === "stale-evidence"));
  assert.equal(revised.chapters.find((c) => c.id === "ch1").content.includes("钥匙"), true);
  assert.equal(revised.chapters.find((c) => c.id === "ch2").content, ch2.content);
});

test("共享人物或时间先后不得自动生成 causal 边", () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch1, { title: "A", end: 5, quote: "林砚把铜扣", actors: ["林砚"] }),
      draftNode(ch1, { title: "B", start: 6, end: 12, quote: "交给父亲。汽笛", actors: ["林砚"] }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(p, built);
  assert.equal(checked.edges.filter((e) => e.type === "causal").length, 0);
});

test("chapter-agent 写作上下文带入事件链，提案携带增量，采纳前正式作品不变", async () => {
  const { runChapterAgent } = await import("../runtime/chapter-agent.mjs");
  const { Checkpoint } = await import("../runtime/checkpoint.mjs");

  const config = {
    provider: "glm",
    model: "glm-5.2",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKey: "test-only",
  };
  const seen = [];
  let storyCalls = 0;
  const reply = (value, finish = "stop") =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: typeof value === "string" ? value : JSON.stringify(value),
            },
            finish_reason: finish,
          },
        ],
        usage: { total_tokens: 10 },
      }),
    );
  const base = withContent();
  const p = {
    ...base,
    storyEvents: mergeStoryEvents(
      emptyStoryEvents(),
      [draftNode(ch1, { title: "林砚交出铜扣", end: 9, quote: "林砚把铜扣交给父亲" })],
      { chapters: base.chapters },
    ).storyEvents,
  };
  const before = structuredClone(p.storyEvents);
  const dir = await mkdtemp(join(tmpdir(), "story-event-agent-"));
  try {
    const checkpoint = new Checkpoint(dir);
    const req = {
      instruction: "起草第一章1200字",
      chapterId: p.chapters[0].id,
      words: 1200,
    };
    const state = await checkpoint.begin(p, req, config);
    const result = await runChapterAgent(
      p,
      config,
      new AbortController().signal,
      () => {},
      checkpoint,
      state,
      async (url, init) => {
        const body = JSON.parse(init.body);
        const sys = body.messages[0].content;
        const data = JSON.parse(body.messages[1].content);
        seen.push({ sys, data });
        if (sys.includes("抽取故事事件"))
          return reply({
            summary: "本章新增事件",
            events: [
              {
                title: "林砚离岸",
                summary: "顺济号离岸",
                kind: "action",
                actors: ["林砚"],
                objects: ["顺济号"],
                basis: "narration",
                start: 0,
                end: 6,
                quote: "稿稿稿稿稿稿",
              },
            ],
          });
        if (sys.includes("设计恰好"))
          return reply({
            scenes: Array.from({ length: Math.ceil(data.targetWords / 1200) }, () => ({
              goal: "离岸",
              knowledge: "仅知眼前事实",
              time: {
                start: "当日上午",
                gap: "承接上一场景",
                duration: "约一小时",
                end: "当日上午稍后",
              },
            })),
          });
        if (sys.includes("仅写当前场景")) {
          const words = Number(sys.match(/目标约(\d+)字/)[1]);
          return reply("稿".repeat(words) + "\n〈场景完成〉");
        }
        // 高推理模式按 time/state/evidence 分维度调用，每次只允许返回本维度一项。
        if (sys.includes("本轮仅执行")) {
          const dimension = ["time", "state", "evidence"].find((d) =>
            sys.includes(`本轮仅执行${d}`) || new RegExp(`仅执行${d}`).test(sys),
          );
          const hit = sys.match(/本轮仅执行([^。\n]+)/);
          return reply({
            dimensions: [
              {
                dimension:
                  dimension ??
                  (hit && hit[1].includes("时间")
                    ? "time"
                    : hit && hit[1].includes("状态")
                      ? "state"
                      : "evidence"),
                verdict: "not_applicable",
                evidence: [],
                explanation: "模拟样本没有本项待检查的事实",
              },
            ],
            authorChecks: [],
          });
        }
        // 专项审稿（提示要求 continuityChecks）：按旧格式返回恰好三个维度。
        if (sys.includes("continuityChecks"))
          return reply({
            issues: [],
            authorChecks: [],
            continuityChecks: ["time", "state", "evidence"].map((dimension) => ({
              dimension,
              verdict: "not_applicable",
              evidence: [],
              explanation: "模拟样本没有本项待核对的事实",
            })),
          });
        // 普通审稿：只接受 issues 与 authorChecks，不许多带字段。
        if (sys.includes("小说连续性与文学审稿员"))
          return reply({ issues: [], authorChecks: [] });
        if (sys.includes("从提供的小说原文抽取"))
          return reply({ summary: "旧记忆", records: [] });
        throw Error("意外调用：" + sys.slice(0, 60));
      },
    );
    const planning = seen.find((s) => s.sys.includes("设计恰好"));
    assert.ok(planning, "未进入场景规划，无法验证上下文");
    assert.ok(planning.data.storyEvents, "写作上下文缺少事件链");
    assert.ok(planning.data.storyEvents.nodes.some((n) => n.id.startsWith("sev-")));
    assert.ok(planning.data.storyEvents.missNote);
    assert.ok(result.proposal, "未返回 proposal：" + (state.error || state.stage));
    assert.ok(result.proposal.storyEvents, "提案应携带事件链增量");
    // 增量形态：不带 version 全图字段，只含本章节点。
    assert.equal(result.proposal.storyEvents.version, undefined);
    assert.ok(Array.isArray(result.proposal.storyEvents.nodes));
    assert.ok(
      result.proposal.storyEvents.nodes.every((n) => n.chapterId === "ch1"),
      "增量只应包含本章节点",
    );
    // 出处由程序回填：节点 evidence.sourceHash 必须等于对应章节当前正文的 sha256。
    const rebuilt = mergeStoryEvents(
      emptyStoryEvents(),
      result.proposal.storyEvents.nodes,
      {
        chapters: result.proposal.chapters,
        edges: result.proposal.storyEvents.edges,
      },
    ).storyEvents;
    const added = rebuilt.nodes.filter((n) => n.chapterId === "ch1");
    assert.ok(added.length >= 1, "提案应含本章节点");
    for (const node of added) {
      const source = result.proposal.chapters.find(
        (c) => c.id === node.chapterId,
      );
      assert.equal(
        node.evidence.sourceHash,
        digest(source.content),
        `节点 ${node.id} 的 sourceHash 不是程序按当前正文回填的`,
      );
      assert.equal(
        node.evidence.quote,
        source.content.slice(node.evidence.start, node.evidence.end),
      );
    }
    assert.deepEqual(p.storyEvents, before, "采纳前正式事件链不得被改写");
    assert.equal(p.chapters[0].content, base.chapters[0].content, "原作品正文不得被改写");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("序数表述不得触发 state-break（第三章 / 三十年前）", () => {
  const p = withContent();
  const ch6 = {
    id: "ch6",
    number: 6,
    title: "序数样本",
    summary: "",
    content: "他在第三章里记过这件事，三十年前也曾来过这里。",
  };
  const project6 = { ...p, chapters: [...p.chapters, ch6] };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch6, { title: "记在第三章", start: 1, end: 5, quote: "在第三章里", objects: ["旧船"] }),
      draftNode(ch6, { title: "三十年前来过", start: 14, end: 22, quote: "三十年前也曾来过", objects: ["旧船"] }),
    ],
    { chapters: project6.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(project6, built);
  assert.equal(checked.issues.filter((i) => i.kind === "state-break").length, 0);
});

test("超预算截断时 missNote 必须如实说明部分事件未装入", () => {
  const p = withContent();
  // 用不同区间构造大量互不同源的事件，确保确实超过装入上限。
  // 每 3 字一段且内容唯一，避免"引文相同即同一事件"的复用规则把它们并成一条。
  const segments = Array.from({ length: 40 }, (_, i) => `甲${String.fromCharCode(0x4e00 + i)}·`);
  const long = segments.join("");
  const ch7 = { id: "ch7", number: 7, title: "批量", summary: "", content: long };
  const many = [];
  // 每个事件用互不重叠的区间与不同人物，避免被同章匹配合并。
  for (let i = 0; i < 40; i += 1)
    many.push({
      chapterId: "ch7",
      title: `事件${i}`,
      summary: "",
      kind: "action",
      actors: [`人物${i}`],
      objects: ["铜扣"],
      basis: "narration",
      storyTime: "",
      evidence: {
        start: i * 3,
        end: i * 3 + 3,
        quote: segments[i],
      },
    });
  const project7 = { ...p, chapters: [...p.chapters, ch7] };
  const graph = mergeStoryEvents(emptyStoryEvents(), many, {
    chapters: project7.chapters,
  }).storyEvents;
  assert.ok(graph.nodes.length > 24, "构造的事件数应超过装入上限");
  const view = storyEventContext(
    { ...project7, storyEvents: graph },
    project7.chapters.find((c) => c.id === "ch4"),
    { instruction: "铜扣" },
  );
  assert.equal(view.truncated, true);
  assert.match(view.missNote, /预算|截断/);
  assert.ok(view.missNote.includes(String(view.totalMatched)));
});

test("候选可接受增量补丁形态，也向后兼容完整图形态", () => {
  const patch = {
    nodes: [
      {
        chapterId: "ch1",
        title: "林砚交出铜扣",
        summary: "",
        kind: "handover",
        actors: ["林砚"],
        objects: ["铜扣"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: { start: 0, end: 9, quote: "林砚把铜扣交给父亲" },
      },
    ],
    edges: [],
    coverage: [],
  };
  assert.equal(proposalSchema.safeParse({ summary: "s", storyEvents: patch }).success, true);
  const p = withContent();
  const full = mergeStoryEvents(emptyStoryEvents(), [draftNode(ch1)], {
    chapters: p.chapters,
  }).storyEvents;
  assert.equal(proposalSchema.safeParse({ summary: "s", storyEvents: full }).success, true);
});

test("增量不重复提交已存在且未变的节点", () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch1, { title: "旧事件", end: 9, quote: "林砚把铜扣交给父亲" }),
      draftNode(ch2, { title: "第二章事件", end: 6, quote: "雾里露出黑石" }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const patch = storyEventsForProposal(built, { chapterIds: ["ch2"] });
  assert.ok(patch.nodes.every((n) => n.chapterId === "ch2"));
  assert.equal(patch.version, undefined);
  assert.equal(patch.nodes.length, 1);
});

test("真实 chapter-agent 路径自动产出 unsourced-knowledge，且不改正文", async () => {
  const { knowledgeClaimsFrom } = await import("../runtime/story-event-agent.mjs");
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch5, {
        title: "惠新数出十八听罐头",
        start: 0,
        end: 9,
        quote: "惠新数出十八听罐头",
        actors: ["惠新"],
        objects: ["罐头"],
        kind: "discovery",
      }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const claims = knowledgeClaimsFrom(p, built, "ch5");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].actor, "惠新");
  assert.equal(claims[0].subject, "罐头");
  assert.equal(claims[0].claimedAt.chapterId, "ch5");
  assert.equal(claims[0].claimedAt.quote, "惠新数出十八听罐头");
  const checked = checkStoryEvents(p, built, { knowledgeClaims: claims });
  assert.equal(
    checked.issues.filter((i) => i.kind === "unsourced-knowledge").length,
    1,
  );
  assert.equal(p.chapters.find((c) => c.id === "ch5").content, ch5.content);
});

test("采纳增量补丁后，正式图含本章节点（applyStoryEventPatch）", async () => {
  const { applyStoryEventPatch, resolveProposalStoryEvents } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const p = withContent();
  const patch = {
    nodes: [
      {
        chapterId: "ch1",
        title: "林砚交出铜扣",
        summary: "",
        kind: "handover",
        actors: ["林砚"],
        objects: ["铜扣"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: { start: 0, end: 9, quote: "林砚把铜扣交给父亲" },
      },
    ],
  };
  const merged = applyStoryEventPatch(p, patch);
  assert.equal(merged.nodes.length, 1);
  assert.equal(merged.version, 1);
  assert.equal(merged.nodes[0].evidence.sourceHash, digest(ch1.content));
  // resolve 对两种形态都要能落地
  assert.equal(resolveProposalStoryEvents(p, patch).nodes.length, 1);
  const full = applyStoryEventPatch(p, patch);
  assert.equal(resolveProposalStoryEvents(p, full).nodes.length, 1);
});

test("采纳完整图形态后正式图保持不变（不重复合并）", async () => {
  const { resolveProposalStoryEvents } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const p = withContent();
  const built = mergeStoryEvents(emptyStoryEvents(), [draftNode(ch1)], {
    chapters: p.chapters,
  }).storyEvents;
  const resolved = resolveProposalStoryEvents(p, built);
  assert.equal(resolved.nodes.length, built.nodes.length);
  assert.equal(resolved.nodes[0].id, built.nodes[0].id);
});

test("renderer 依赖链不含 node:crypto（schema.mjs 不引 story-events.mjs）", async () => {
  const { readFile } = await import("node:fs/promises");
  const schema = await readFile(new URL("../runtime/schema.mjs", import.meta.url), "utf8");
  assert.equal(
    /from\s+["']\.\/story-events\.mjs["']/.test(schema),
    false,
    "schema.mjs 不得依赖 story-events.mjs（其依赖 node:crypto）",
  );
  // 只检查真实 import 语句，注释里提到该模块名不算依赖。
  assert.equal(
    /import[^;]*from\s+["']node:crypto["']/.test(schema),
    false,
    "schema.mjs 不得直接引入 node:crypto",
  );
});

test("正文相同、物件相同、数量相同、仅标题不同的两个 state-change 不得报 state-break", () => {
  const p = withContent();
  // 两句正文不同但都没有数量词、都是 state-change、物件相同：
  // 旧实现会因为标题不同就判冲突，这里必须为 0。
  const content = "清点罐头。又清点了一遍。";
  const ch8 = { id: "ch8", number: 8, title: "清点", summary: "", content };
  const project8 = { ...p, chapters: [...p.chapters, ch8] };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch8, {
        title: "清点甲",
        start: 0,
        end: 5,
        quote: "清点罐头。",
        objects: ["罐头"],
        kind: "state-change",
      }),
      draftNode(ch8, {
        title: "清点乙",
        start: 5,
        end: 12,
        quote: "又清点了一遍。",
        objects: ["罐头"],
        kind: "state-change",
      }),
    ],
    { chapters: project8.chapters },
  ).storyEvents;
  assert.equal(built.nodes.length, 2, "前置：应有两个独立节点");
  const checked = checkStoryEvents(project8, built);
  assert.equal(
    checked.issues.filter((i) => i.kind === "state-break").length,
    0,
    "仅标题不同不构成状态互斥",
  );
});

test("没有数量词的两个 state-change 不得报 state-break", () => {
  const p = withContent();
  const content = "他把门推开又关上。";
  const ch9 = { id: "ch9", number: 9, title: "门", summary: "", content };
  const project9 = { ...p, chapters: [...p.chapters, ch9] };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch9, { title: "推开门", start: 0, end: 4, quote: "他把门推", objects: ["门"], kind: "state-change" }),
      draftNode(ch9, { title: "关上门", start: 5, end: 9, quote: "开又关上", objects: ["门"], kind: "state-change" }),
    ],
    { chapters: project9.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(project9, built);
  assert.equal(checked.issues.filter((i) => i.kind === "state-break").length, 0);
});

test("真冲突（十八听 vs 二十四听）仍必须报 state-break，且 recall 不参与", () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch5, { title: "惠新数出十八听", start: 0, end: 9, quote: "惠新数出十八听罐头", objects: ["罐头"], kind: "discovery" }),
      draftNode(ch5, { title: "老周坚持二十四听", start: 10, end: 19, quote: "老周坚持是二十四听", objects: ["罐头"], kind: "state-change" }),
      draftNode(ch4, { title: "惠新回忆罐头", start: 0, end: 11, quote: "他在船上听过它响", objects: ["罐头"], kind: "recall" }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(p, built);
  assert.equal(checked.issues.filter((i) => i.kind === "state-break").length, 1);
});

// ===== R10：数量变化不误报 =====

test("R10 十个苹果吃一个剩九个（有明确过程）不得报 state-break", () => {
  const p = withContent();
  const content = "桌上有十个苹果。他吃了一个，剩下九个。";
  const ch10 = { id: "ch10", number: 10, title: "苹果", summary: "", content };
  const project10 = { ...p, chapters: [...p.chapters, ch10] };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch10, {
        title: "桌上有十个苹果",
        start: 0,
        end: 7,
        quote: "桌上有十个苹果",
        objects: ["苹果"],
        kind: "state-change",
      }),
      draftNode(ch10, {
        title: "吃一个剩九个",
        start: 8,
        end: 18,
        quote: "他吃了一个，剩下九个",
        objects: ["苹果"],
        kind: "state-change",
      }),
    ],
    { chapters: project10.chapters },
  ).storyEvents;
  assert.equal(built.nodes.length, 2, "前置：两个独立事件");
  const checked = checkStoryEvents(project10, built);
  assert.equal(
    checked.issues.filter((i) => i.kind === "state-break").length,
    0,
    "有明确消费过程的数量变化不是互斥",
  );
});

test("R10 同一时点两条冲突数量陈述仍必须报 state-break", () => {
  const p = withContent();
  const content = "清点时惠新说十八听，老周说二十四听。";
  const ch11 = { id: "ch11", number: 11, title: "清点", summary: "", content };
  const project11 = { ...p, chapters: [...p.chapters, ch11] };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch11, {
        title: "惠新说十八听",
        start: content.indexOf("惠新说十八听"),
        end: content.indexOf("惠新说十八听") + "惠新说十八听".length,
        quote: "惠新说十八听",
        objects: ["罐头"],
        kind: "discovery",
      }),
      draftNode(ch11, {
        title: "老周说二十四听",
        start: content.indexOf("老周说二十四听"),
        end: content.indexOf("老周说二十四听") + "老周说二十四听".length,
        quote: "老周说二十四听",
        objects: ["罐头"],
        kind: "discovery",
      }),
    ],
    { chapters: project11.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(project11, built);
  assert.equal(
    checked.issues.filter((i) => i.kind === "state-break").length,
    1,
    "应为 1 | nodes=" +
      JSON.stringify(built.nodes.map((n) => [n.title, n.evidence.start, n.evidence.end])) +
      " allIssues=" +
      JSON.stringify(checked.issues.map((i) => i.kind)),
  );
});

// ===== R8：问题随候选保存 =====

test("R8 storyEventsForProposal 必须携带 issues（含证据、建议、处理状态）", () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch5, { title: "惠新数出十八听", start: 0, end: 9, quote: "惠新数出十八听罐头", objects: ["罐头"], kind: "discovery" }),
      draftNode(ch5, { title: "老周坚持二十四听", start: 10, end: 19, quote: "老周坚持是二十四听", objects: ["罐头"], kind: "state-change" }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(p, built);
  assert.ok(checked.issues.length >= 1, "前置：应有待核对问题");
  const patch = storyEventsForProposal(checked, { chapterIds: ["ch5"] });
  assert.ok(Array.isArray(patch.issues), "增量必须携带 issues 字段");
  assert.ok(patch.issues.length >= 1, "增量不应丢掉本轮问题");
  const issue = patch.issues[0];
  assert.ok(issue.kind, "问题须带类型");
  assert.ok(issue.explanation, "问题须带说明");
  assert.ok("suggestion" in issue, "问题须带建议");
  assert.ok(issue.disposition, "问题须带处理状态");
  assert.ok(Array.isArray(issue.nodeIds), "问题须带关联节点");
});

test("R8 作者已处理的问题在无关合并不丢失 disposition", () => {
  const p = withContent();
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch5, { title: "惠新数出十八听", start: 0, end: 9, quote: "惠新数出十八听罐头", objects: ["罐头"], kind: "discovery" }),
      draftNode(ch5, { title: "老周坚持二十四听", start: 10, end: 19, quote: "老周坚持是二十四听", objects: ["罐头"], kind: "state-change" }),
    ],
    { chapters: p.chapters },
  ).storyEvents;
  const checked = checkStoryEvents(p, built);
  const target = checked.issues[0];
  const decided = reviewDisposition(checked, target.id, "author-decided");
  const patch = storyEventsForProposal(decided, { chapterIds: ["ch5"] });
  const kept = patch.issues.find((i) => i.id === target.id);
  assert.ok(kept, "已处理问题应仍在增量中");
  assert.equal(kept.disposition, "author-decided", "作者决定不得被丢弃");
});

// ===== R2：跨章关联 =====

test("R2 抽取请求必须带可引用的历史事件 ID 与原文", async () => {
  const p = withContent();
  const existing = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch1, { title: "林砚交出铜扣", start: 0, end: 9, quote: "林砚把铜扣交给父亲", objects: ["铜扣"] })],
    { chapters: p.chapters },
  ).storyEvents;
  const seen = [];
  const ask = async (key, messages, validate) => {
    seen.push(JSON.parse(messages[1].content));
    return validate({ summary: "本片摘要", events: [] });
  };
  await extractStoryEvents(
    { ...p, storyEvents: existing },
    ask,
    { chapterIds: ["ch2"] },
  );
  assert.ok(seen.length >= 1, "前置：应有抽取请求");
  const payload = seen[0];
  assert.ok(Array.isArray(payload.historyEvents), "请求须含 historyEvents");
  assert.ok(payload.historyEvents.length >= 1, "第一章事件应作为历史候选");
  const history = payload.historyEvents[0];
  assert.match(history.id, /^sev-/, "历史事件须带持久化 ID");
  assert.equal(history.quote, "林砚把铜扣交给父亲", "历史事件须带原文证据");
  assert.ok(history.id === existing.nodes[0].id, "历史 ID 必须是正式图里的稳定 ID");
});

test("R2 关系端点可引用历史正式事件，跨章边在候选增量中保留", async () => {
  const p = withContent();
  const existing = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch1, { title: "林砚交出铜扣", start: 0, end: 9, quote: "林砚把铜扣交给父亲", objects: ["铜扣"] })],
    { chapters: p.chapters },
  ).storyEvents;
  const historyId = existing.nodes[0].id;
  let requestedHistoryId = "";
  const ask = async (key, messages, validate) => {
    const payload = JSON.parse(messages[1].content);
    requestedHistoryId = payload.historyEvents[0]?.id ?? "";
    const history = payload.historyEvents.find((h) => h.id === historyId);
    assert.ok(history, "请求里必须能取到历史事件");
    return validate({
      summary: "第二章",
      events: [
        {
          title: "用铜扣开门",
          summary: "林砚用铜扣打开门",
          kind: "action",
          actors: ["林砚"],
          objects: ["铜扣"],
          basis: "narration",
          start: 0,
          end: 5,
          quote: "雾里露出黑",
        },
      ],
      relations: [
        {
          sourceRef: historyId,
          targetId: 1,
          type: "recall",
          basis: "explicit",
          explanation: "第二章用到第一章交出的铜扣",
          evidenceSourceId: 1,
        },
      ],
    });
  };
  const result = await extractStoryEvents(
    { ...p, storyEvents: existing },
    ask,
    { chapterIds: ["ch2"] },
  );
  // 端点指向的必须是请求里给出的那个正式历史 ID（程序持久化身份）。
  assert.equal(requestedHistoryId, historyId, "请求与正式图的历史 ID 必须一致");
  const cross = result.storyEvents.edges.filter(
    (e) => e.source === requestedHistoryId || e.target === requestedHistoryId,
  );
  assert.equal(cross.length, 1, "跨章边应建立并指向历史事件");
  const patch = storyEventsForProposal(result.storyEvents, { chapterIds: ["ch2"] });
  const kept = patch.edges.filter(
    (e) => e.source === requestedHistoryId || e.target === requestedHistoryId,
  );
  assert.equal(
    kept.length,
    1,
    "候选增量必须保留指向正式历史的端点 | all=" +
      JSON.stringify(result.storyEvents.edges.map((e) => [e.source, e.target])) +
      " patchNodes=" +
      JSON.stringify(patch.nodes.map((n) => n.chapterId)) +
      " patchEdges=" +
      JSON.stringify(patch.edges.map((e) => [e.source, e.target])) +
      " historyId=" +
      requestedHistoryId,
  );
});

// 同一段含过程词的正文，分别构造"有承接解释"与"同一时点冲突"，证明判据不是关键词命中。
test("R10 同一段含过程词正文：有承接解释 → 0 条", () => {
  const p = withContent();
  const content = "席间他吃了苹果。开席时十个苹果，散席时剩九个。";
  const ch12 = { id: "ch12", number: 12, title: "席面", summary: "", content };
  const project12 = { ...p, chapters: [...p.chapters, ch12] };
  const before = "十个苹果";
  const after = "剩九个";
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch12, {
        title: "开席十个苹果",
        start: content.indexOf(before),
        end: content.indexOf(before) + before.length,
        quote: before,
        objects: ["苹果"],
        kind: "state-change",
      }),
      draftNode(ch12, {
        title: "散席剩九个",
        start: content.indexOf(after),
        end: content.indexOf(after) + after.length,
        quote: after,
        objects: ["苹果"],
        kind: "state-change",
      }),
    ],
    { chapters: project12.chapters },
  ).storyEvents;
  assert.equal(built.nodes.length, 2);
  const checked = checkStoryEvents(project12, built);
  assert.equal(checked.issues.filter((i) => i.kind === "state-break").length, 0);
});

test("R10 同一段含过程词正文：无承接解释 → 必须 1 条", () => {
  const p = withContent();
  // 与上一条完全相同的正文（含「吃」），但两条引文是并存的两个数量断言，
  // 后者没有写出从前者到自身的变化过程。
  const content = "席间他吃了苹果。惠新说十个苹果，老周说九个。";
  const ch13 = { id: "ch13", number: 13, title: "席面", summary: "", content };
  const project13 = { ...p, chapters: [...p.chapters, ch13] };
  const a = "十个苹果";
  const b = "九个";
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch13, {
        title: "惠新说十个",
        start: content.indexOf(a),
        end: content.indexOf(a) + a.length,
        quote: a,
        objects: ["苹果"],
        kind: "discovery",
      }),
      draftNode(ch13, {
        title: "老周说九个",
        start: content.indexOf(b),
        end: content.indexOf(b) + b.length,
        quote: b,
        objects: ["苹果"],
        kind: "discovery",
      }),
    ],
    { chapters: project13.chapters },
  ).storyEvents;
  assert.equal(built.nodes.length, 2);
  const checked = checkStoryEvents(project13, built);
  assert.equal(
    checked.issues.filter((i) => i.kind === "state-break").length,
    1,
    "同一时点无承接解释的两个数量陈述必须报冲突",
  );
});

// ===== R2 持久化：跨章边经候选 → 采纳 → 重启仍在 =====

test("R2 跨章边经候选增量→采纳→重启读取后仍在", async () => {
  const { ProjectStore } = await import("../runtime/storage.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { applyStoryEventPatch } = await import("../runtime/story-events-apply.mjs");

  const p = withContent();
  // 先建立第一章的正式事件（模拟此前已采纳的历史）。
  const formal = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch1, { title: "林砚交出铜扣", start: 0, end: 9, quote: "林砚把铜扣交给父亲", objects: ["铜扣"] })],
    { chapters: p.chapters },
  ).storyEvents;
  const historyId = formal.nodes[0].id;

  // 第二章抽取：模型用历史端点建立跨章边。
  const ask = async (key, messages, validate) => {
    const payload = JSON.parse(messages[1].content);
    assert.ok(
      payload.historyEvents.some((h) => h.id === historyId),
      "请求必须提供可引用的历史事件",
    );
    return validate({
      summary: "第二章",
      events: [
        {
          title: "用铜扣开门",
          summary: "林砚用铜扣开门",
          kind: "action",
          actors: ["林砚"],
          objects: ["铜扣"],
          basis: "narration",
          start: 0,
          end: 5,
          quote: "雾里露出黑",
        },
      ],
      relations: [
        {
          sourceRef: historyId,
          targetId: 1,
          type: "recall",
          basis: "explicit",
          explanation: "第二章用到第一章交出的铜扣",
          evidenceSourceId: 1,
        },
      ],
    });
  };
  const extracted = await extractStoryEvents(
    { ...p, storyEvents: formal },
    ask,
    { chapterIds: ["ch2"] },
  );

  // 候选增量只带本章变更，且保留指向正式历史的端点。
  const patch = storyEventsForProposal(extracted.storyEvents, {
    chapterIds: ["ch2"],
  });
  assert.ok(
    patch.edges.some((e) => e.source === historyId || e.target === historyId),
    "增量必须保留跨章端点",
  );

  // 采纳：把补丁并入正式图（走真实合并入口）。
  const merged = applyStoryEventPatch(
    { ...p, storyEvents: formal },
    patch,
  );
  assert.ok(
    merged.edges.some((e) => e.source === historyId || e.target === historyId),
    "采纳后正式图必须保留跨章边",
  );

  // 重启：落盘再读回。
  const dir = await mkdtemp(join(tmpdir(), "story-event-cross-"));
  try {
    const store = new ProjectStore(dir);
    const base = await store.load();
    await store.save(
      { ...base, revision: p.revision, storyEvents: merged },
      base.revision,
    );
    const reloaded = await new ProjectStore(dir).load();
    assert.ok(reloaded.storyEvents, "重启后 storyEvents 必须存在");
    const survivors = reloaded.storyEvents.edges.filter(
      (e) => e.source === historyId || e.target === historyId,
    );
    assert.equal(survivors.length, 1, "重启后跨章边必须仍然存在");
    assert.equal(
      reloaded.storyEvents.nodes.filter((n) => n.id === historyId).length,
      1,
      "历史端点节点必须仍在图中",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 锁死契约本身：跨章边经 normalizeStoryEvents（带 knownNodeIds）后仍在。
// 这条不验证任何绕行写法，只验证 "端点合法性 = nodes ∪ knownNodeIds" 这一契约。
test("R2 契约：normalizeStoryEvents 带 knownNodeIds 时保留跨章边", async () => {
  const { normalizeStoryEvents } = await import("../runtime/story-events.mjs");
  const p = withContent();
  const formal = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch1, { title: "林砚交出铜扣", start: 0, end: 9, quote: "林砚把铜扣交给父亲" })],
    { chapters: p.chapters },
  ).storyEvents;
  const historyId = formal.nodes[0].id;

  const local = mergeStoryEvents(
    emptyStoryEvents(),
    [draftNode(ch2, { title: "用铜扣开门", start: 11, end: 19, quote: "顾言章举起信号枪", kind: "action" })],
    { chapters: p.chapters },
  ).storyEvents;
  const localId = local.nodes[0].id;

  const crossEdge = {
    id: "see-cross-chapter",
    source: historyId,
    target: localId,
    type: "recall",
    basis: "explicit",
    explanation: "第二章回忆第一章的交出动作",
    evidence: [
      { chapterId: "ch2", start: 11, end: 19, quote: "顾言章举起信号枪" },
    ],
    review: { state: "unreviewed", note: "", at: null },
    stale: null,
  };

  // 不传 knownNodeIds：历史端点不在本次 nodes 中，边应被拒绝并记 issue。
  const withoutKnown = normalizeStoryEvents(
    { version: 1, nodes: local.nodes, edges: [crossEdge], coverage: [], issues: [] },
    { knownNodeIds: new Set() },
  );
  assert.equal(withoutKnown.edges.length, 0, "未声明已知端点时不得凭空接受跨章边");
  assert.ok(
    withoutKnown.issues.some((i) => i.kind === "missing-source"),
    "被拒绝的跨章边必须留下 missing-source 记录",
  );

  // 传 knownNodeIds：契约允许端点来自正式历史。
  const withKnown = normalizeStoryEvents(
    { version: 1, nodes: local.nodes, edges: [crossEdge], coverage: [], issues: [] },
    { knownNodeIds: new Set([historyId]) },
  );
  assert.equal(withKnown.edges.length, 1, "声明已知端点后跨章边必须保留");
  assert.equal(withKnown.edges[0].source, historyId);
  assert.equal(withKnown.edges[0].target, localId);
});

// ===== F3：区间与模型引文不符必须拒绝，不得按区间重截 =====

test("F3 区间与模型引文不符时拒绝并报因，不把另一段文字当证据", async () => {
  const p = withContent();
  const content = "汽笛响了。甲把钥匙交给乙。";
  const ch20 = { id: "ch20", number: 20, title: "钥匙", summary: "", content };
  const project20 = { ...p, chapters: [...p.chapters, ch20] };
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          title: "转交钥匙",
          summary: "甲把钥匙交给乙",
          kind: "handover",
          actors: ["甲", "乙"],
          objects: ["钥匙"],
          basis: "narration",
          // 故意错位：区间指向「汽笛响了。」，引文却是下一句
          start: 0,
          end: 5,
          quote: "甲把钥匙交给乙。",
        },
      ],
    });
  const result = await extractStoryEvents(project20, ask, {
    chapterIds: ["ch20"],
  });
  assert.equal(result.storyEvents.nodes.length, 0, "区间与引文不符的事件不得进入候选");
  assert.ok(
    result.failures.some((f) => f.includes("quote") || f.includes("引文")),
    "必须报告引文不匹配的原因，实际：" + JSON.stringify(result.failures),
  );
  // 不得把「汽笛响了。」当成该事件的证据
  assert.equal(
    result.storyEvents.nodes.some(
      (n) => n.evidence.quote === "汽笛响了。",
    ),
    false,
    "不得按区间重截另一段文字冒充证据",
  );
});

test("F3 正确引用的区间仍能进入候选", async () => {
  const p = withContent();
  const content = "汽笛响了。甲把钥匙交给乙。";
  const ch21 = { id: "ch21", number: 21, title: "钥匙2", summary: "", content };
  const project21 = { ...p, chapters: [...p.chapters, ch21] };
  const start = content.indexOf("甲把钥匙交给乙。");
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          title: "转交钥匙",
          summary: "",
          kind: "handover",
          actors: ["甲", "乙"],
          objects: ["钥匙"],
          basis: "narration",
          start,
          end: start + "甲把钥匙交给乙。".length,
          quote: "甲把钥匙交给乙。",
        },
      ],
    });
  const result = await extractStoryEvents(project21, ask, {
    chapterIds: ["ch21"],
  });
  assert.equal(result.storyEvents.nodes.length, 1);
  assert.equal(result.storyEvents.nodes[0].evidence.quote, "甲把钥匙交给乙。");
  assert.equal(result.storyEvents.nodes[0].evidence.start, start);
});

// ===== F4：三个编号必须分开 =====

test("F4 两个事件引用同一原文 sourceId 时关系仍能正确解析", async () => {
  const p = withContent();
  const content = "甲把钥匙交给乙。乙打开门。";
  const ch22 = { id: "ch22", number: 22, title: "交钥匙", summary: "", content };
  const project22 = { ...p, chapters: [...p.chapters, ch22] };
  const s2 = content.indexOf("乙打开门。");
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          title: "甲把钥匙交给乙",
          summary: "",
          kind: "handover",
          actors: ["甲", "乙"],
          objects: ["钥匙"],
          basis: "narration",
          sourceId: 1,
          start: 0,
          end: "甲把钥匙交给乙".length,
          quote: "甲把钥匙交给乙",
        },
        {
          title: "乙打开门",
          summary: "",
          kind: "action",
          actors: ["乙"],
          objects: ["门"],
          basis: "narration",
          sourceId: 1,
          start: s2,
          end: s2 + "乙打开门。".length,
          quote: "乙打开门。",
        },
      ],
      relations: [
        {
          sourceId: 1,
          targetId: 2,
          type: "causal",
          basis: "explicit",
          explanation: "拿到钥匙后才能开门",
          evidenceSourceId: 1,
        },
      ],
    });
  const result = await extractStoryEvents(project22, ask, {
    chapterIds: ["ch22"],
  });
  assert.equal(result.storyEvents.nodes.length, 2, "两个事件都必须保留");
  assert.equal(
    result.storyEvents.edges.length,
    1,
    "关系必须解析成功，实际 failures=" + JSON.stringify(result.failures),
  );
  assert.equal(result.storyEvents.edges[0].type, "causal");
});

// ===== F11：数量只写在逐字证据里也不误报 =====

test("F11 数量只写在原文证据里、标题无数字时正常变化不误报", () => {
  const p = withContent();
  const content = "桌上有十个苹果。他吃了一个，剩下九个。";
  const ch23 = { id: "ch23", number: 23, title: "存货", summary: "", content };
  const project23 = { ...p, chapters: [...p.chapters, ch23] };
  const a = content.indexOf("桌上有十个苹果");
  const b = content.indexOf("剩下九个");
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch23, {
        title: "清点存货",
        summary: "桌上有一批苹果",
        start: a,
        end: a + "桌上有十个苹果".length,
        quote: "桌上有十个苹果",
        objects: ["苹果"],
        kind: "state-change",
      }),
      draftNode(ch23, {
        title: "取食后存量减少",
        summary: "吃过之后剩下的不多",
        start: b,
        end: b + "剩下九个".length,
        quote: "剩下九个",
        objects: ["苹果"],
        kind: "state-change",
      }),
    ],
    { chapters: project23.chapters },
  ).storyEvents;
  assert.equal(built.nodes.length, 2, "前置：两个节点都应建立");
  const checked = checkStoryEvents(project23, built);
  assert.equal(
    checked.issues.filter((i) => i.kind === "state-break").length,
    0,
    "数量只写在逐字证据里的正常变化不得误报",
  );
});

// ===== G1：过滤无效事件后关系编号不得错移 =====

test("G1 首个事件被拒后，关系仍按模型原始序号连接正确事件", async () => {
  const p = withContent();
  const content = "乙拾起钥匙。丙打开门。丁离开屋子。";
  const ch30 = { id: "ch30", number: 30, title: "原始序号", summary: "", content };
  const project30 = { ...p, chapters: [...p.chapters, ch30] };
  const sp = (quote) => {
    const start = content.indexOf(quote);
    return { start, end: start + quote.length, quote };
  };
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          // 第 1 个事件引文不存在 → 会被拒绝
          title: "被拒事件",
          summary: "",
          kind: "action",
          actors: ["甲"],
          objects: ["无"],
          basis: "narration",
          quote: "这句原文根本不存在于正文里",
        },
        {
          title: "乙拾起钥匙",
          summary: "",
          kind: "action",
          actors: ["乙"],
          objects: ["钥匙"],
          basis: "narration",
          ...sp("乙拾起钥匙。"),
        },
        {
          title: "丙打开门",
          summary: "",
          kind: "action",
          actors: ["丙"],
          objects: ["门"],
          basis: "narration",
          ...sp("丙打开门。"),
        },
        {
          title: "丁离开屋子",
          summary: "",
          kind: "action",
          actors: ["丁"],
          objects: ["屋子"],
          basis: "narration",
          ...sp("丁离开屋子。"),
        },
      ],
      relations: [
        {
          sourceId: 2,
          targetId: 3,
          type: "causal",
          basis: "explicit",
          explanation: "乙拾到钥匙后丙才开门",
          evidenceSourceId: 1,
        },
      ],
    });
  const result = await extractStoryEvents(project30, ask, {
    chapterIds: ["ch30"],
  });
  assert.equal(result.storyEvents.nodes.length, 3, "第 1 个被拒，应保留 3 个事件");
  assert.equal(result.storyEvents.edges.length, 1, "原始序号 2→3 的关系必须建立");
  const byTitle = new Map(result.storyEvents.nodes.map((n) => [n.title, n.id]));
  const edge = result.storyEvents.edges[0];
  assert.equal(edge.source, byTitle.get("乙拾起钥匙"), "source 必须是乙拾钥匙");
  assert.equal(edge.target, byTitle.get("丙打开门"), "target 必须是丙开门");
});

test("G1 关系引用被拒事件时报无效端点，不得移接到其他事件", async () => {
  const p = withContent();
  const content = "乙拾起钥匙。丙打开门。";
  const ch31 = { id: "ch31", number: 31, title: "无效端点", summary: "", content };
  const project31 = { ...p, chapters: [...p.chapters, ch31] };
  const sp = (quote) => {
    const start = content.indexOf(quote);
    return { start, end: start + quote.length, quote };
  };
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          title: "被拒事件",
          summary: "",
          kind: "action",
          actors: ["甲"],
          objects: ["无"],
          basis: "narration",
          quote: "不存在的原文",
        },
        {
          title: "乙拾起钥匙",
          summary: "",
          kind: "action",
          actors: ["乙"],
          objects: ["钥匙"],
          basis: "narration",
          ...sp("乙拾起钥匙。"),
        },
      ],
      relations: [
        {
          sourceId: 1,
          targetId: 2,
          type: "causal",
          basis: "explicit",
          explanation: "引用被拒事件",
          evidenceSourceId: 2,
        },
      ],
    });
  const result = await extractStoryEvents(project31, ask, {
    chapterIds: ["ch31"],
  });
  assert.equal(result.storyEvents.edges.length, 0, "引用被拒事件的关系不得建立");
  assert.ok(
    result.failures.some((f) => f.includes("relations[0]")),
    "必须报告无效端点，实际：" + JSON.stringify(result.failures),
  );
});

// ===== G3：重复引文必须保留模型已核验的区间 =====

test("G3 重复引文时保留模型给出的第二处区间", async () => {
  const p = withContent();
  const content = "甲敲门。乙开窗。甲敲门。";
  const ch32 = { id: "ch32", number: 32, title: "重复引文", summary: "", content };
  const project32 = { ...p, chapters: [...p.chapters, ch32] };
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          title: "甲第二次敲门",
          summary: "",
          kind: "action",
          actors: ["甲"],
          objects: ["门"],
          basis: "narration",
          start: 8,
          end: 12,
          quote: "甲敲门。",
        },
      ],
    });
  const result = await extractStoryEvents(project32, ask, {
    chapterIds: ["ch32"],
  });
  assert.equal(result.storyEvents.nodes.length, 1);
  assert.equal(
    result.storyEvents.nodes[0].evidence.start,
    8,
    "必须保留模型核验过的第二处区间，而不是 indexOf 的首处",
  );
});

test("G3 无区间且引文重复时报告歧义，不静默选第一处", async () => {
  const p = withContent();
  const content = "甲敲门。乙开窗。甲敲门。";
  const ch33 = { id: "ch33", number: 33, title: "歧义", summary: "", content };
  const project33 = { ...p, chapters: [...p.chapters, ch33] };
  const ask = async (key, messages, validate) =>
    validate({
      summary: "本片摘要",
      events: [
        {
          title: "甲敲门",
          summary: "",
          kind: "action",
          actors: ["甲"],
          objects: ["门"],
          basis: "narration",
          quote: "甲敲门。",
        },
      ],
    });
  const result = await extractStoryEvents(project33, ask, {
    chapterIds: ["ch33"],
  });
  assert.equal(result.storyEvents.nodes.length, 0, "歧义引文不得静默取第一处");
  assert.ok(
    result.failures.some((f) => f.includes("歧义") || f.includes("多处")),
    "必须报告歧义，实际：" + JSON.stringify(result.failures),
  );
});

// ===== G6：同 storyTime 的互斥数量必须报 =====

test("G6 同一 storyTime 的互斥数量必须形成待核对项", () => {
  const p = withContent();
  const content = "此时桌上还剩十个苹果。此时桌上只剩九个苹果。";
  const ch34 = { id: "ch34", number: 34, title: "同时点", summary: "", content };
  const project34 = { ...p, chapters: [...p.chapters, ch34] };
  const a = content.indexOf("此时桌上还剩十个苹果");
  const b = content.indexOf("此时桌上只剩九个苹果");
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode(ch34, {
        title: "此时还剩十个",
        start: a,
        end: a + "此时桌上还剩十个苹果".length,
        quote: "此时桌上还剩十个苹果",
        objects: ["苹果"],
        kind: "state-change",
        storyTime: "同一时刻",
      }),
      draftNode(ch34, {
        title: "此时只剩九个",
        start: b,
        end: b + "此时桌上只剩九个苹果".length,
        quote: "此时桌上只剩九个苹果",
        objects: ["苹果"],
        kind: "state-change",
        storyTime: "同一时刻",
      }),
    ],
    { chapters: project34.chapters },
  ).storyEvents;
  assert.equal(built.nodes.length, 2, "前置：两个节点都应建立");
  const checked = checkStoryEvents(project34, built);
  assert.equal(
    checked.issues.filter((i) => i.kind === "state-break").length,
    1,
    "同一 storyTime 的互斥数量必须报冲突",
  );
});
