import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyStoryEvents,
  normalizeStoryEvents,
  storyEventId,
  storyEdgeId,
  mergeStoryEvents,
  validateStoryEdge,
  eventEvidence,
  chapterCoverage,
  impactOf,
  storySubgraph,
  storyEventIssues,
} from "../runtime/story-events.mjs";

const chapter = (id, number, title, content) => ({
  id,
  number,
  title,
  summary: "",
  content,
});

const content = "林砚把铜扣交给父亲。汽笛响了三声。";

// 出处区间一律由引文在正文中的真实位置算出；
// 手写数字很容易与引文长度不一致，而区间与引文不符正是 R4 要拒绝的错误。
const span = (text, fragment) => {
  const start = text.indexOf(fragment);
  assert.notEqual(start, -1, `夹具引文必须出现在正文中：${fragment}`);
  return { start, end: start + fragment.length, quote: fragment };
};

const draft = (patch = {}) => ({
  chapterId: "ch1",
  chapterNumber: 1,
  chapterTitle: "顺济号出航",
  storyTime: "六月十八",
  narrativeOffset: 0,
  title: "林砚把铜扣交给父亲",
  summary: "林砚在码头把铜扣交到父亲手上。",
  kind: "handover",
  actors: ["林砚", "林父"],
  objects: ["铜扣"],
  status: "confirmed",
  basis: "narration",
  evidence: span(content, "林砚把铜扣交给父亲。"),
  ...patch,
});

test("同一章重抽同一事件必须复用稳定 id，不新建重复节点", () => {
  const first = mergeStoryEvents(emptyStoryEvents(), [draft()], {
    chapter: chapter("ch1", 1, "顺济号出航", content),
  });
  const second = mergeStoryEvents(first.storyEvents, [draft({ summary: "稍有改写的摘要" })], {
    chapter: chapter("ch1", 1, "顺济号出航", content),
  });
  assert.equal(second.storyEvents.nodes.length, 1);
  assert.equal(second.storyEvents.nodes[0].id, first.storyEvents.nodes[0].id);
  assert.equal(second.counts.added, 0);
  assert.equal(second.counts.merged, 1);
});

test("章节改名与重排不改变节点 id，连线仍指向原事件", () => {
  const first = mergeStoryEvents(emptyStoryEvents(), [draft()], {
    chapter: chapter("ch1", 1, "顺济号出航", content),
  });
  const target = mergeStoryEvents(
    first.storyEvents,
    [draft({ chapterTitle: "改名后的第一章" })],
    { chapter: chapter("ch1", 9, "改名后的第一章", content) },
  );
  assert.equal(target.storyEvents.nodes[0].id, first.storyEvents.nodes[0].id);
});

test("节点 id 不含章节号、标题与正文哈希", () => {
  const id = storyEventId({ chapterId: "ch1", title: "铜扣", start: 0, end: 17 });
  assert.match(id, /^sev-[0-9a-f]{12}$/);
  assert.equal(id, storyEventId({ chapterId: "ch1", title: "铜扣", start: 0, end: 17 }));
  assert.notEqual(id, storyEventId({ chapterId: "ch1", title: "铜扣", start: 3, end: 20 }));
});

test("无 evidence 的关系边被拒绝，共享人物不构成因果", () => {
  const graph = normalizeStoryEvents({
    nodes: [draft(), draft({ title: "父亲把铜扣按进掌心", evidence: span(content, "铜扣交给父亲。"), chapterNumber: 1 })],
    edges: [
      {
        source: storyEventId({ chapterId: "ch1", title: "林砚把铜扣交给父亲", start: 0, end: 17 }),
        target: storyEventId({ chapterId: "ch1", title: "父亲把铜扣按进掌心", start: 4, end: 17 }),
        type: "causal",
        basis: "explicit",
        explanation: "同一枚铜扣先后出现",
        evidence: [],
      },
    ],
  });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.issues.length, 1);
  assert.equal(graph.issues[0].kind, "missing-source");
});

test("explicit 边必须有 explanation 与 evidence，inferred 边允许保留但标 basis", () => {
  const nodes = [draft(), draft({ title: "父亲收起铜扣", evidence: span(content, "铜扣交给父亲。") })];
  const a = storyEventId({ chapterId: "ch1", title: nodes[0].title, start: 0, end: 17 });
  const b = storyEventId({ chapterId: "ch1", title: nodes[1].title, start: 4, end: 17 });
  const withIds = [
    { ...nodes[0], id: a },
    { ...nodes[1], id: b },
  ];
  const explicit = validateStoryEdge(
    {
      source: a,
      target: b,
      type: "causal",
      basis: "explicit",
      explanation: "",
      evidence: [],
    },
    withIds,
    [chapter("ch1", 1, "顺济号出航", content)],
  );
  assert.equal(explicit.ok, false);
  const inferred = validateStoryEdge(
    {
      source: a,
      target: b,
      type: "causal",
      basis: "inferred",
      explanation: "时间相邻，可能相关",
      evidence: [],
    },
    withIds,
    [chapter("ch1", 1, "顺济号出航", content)],
  );
  assert.equal(inferred.ok, true);
  assert.equal(inferred.edge.basis, "inferred");
});

test("多前因多分支不被压成单链", () => {
  const graph = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draft({ title: "甲事件", evidence: span(content, "林砚把") }),
      draft({ title: "乙事件", evidence: span(content, "铜扣交给父亲") }),
      draft({ title: "丙事件", evidence: span(content, "。汽笛响了") }),
    ],
    { chapter: chapter("ch1", 1, "顺济号出航", content) },
  );
  const ids = graph.storyEvents.nodes.map((n) => n.id);
  const linked = mergeStoryEvents(
    graph.storyEvents,
    [],
    {
      chapter: chapter("ch1", 1, "顺济号出航", content),
      edges: [
        {
          source: ids[0],
          target: ids[2],
          type: "causal",
          basis: "explicit",
          explanation: "两种材料共同导致出航决定",
          evidence: [{ chapterId: "ch1", ...span(content, "林砚把铜扣交给父亲。") }],
        },
        {
          source: ids[1],
          target: ids[2],
          type: "causal",
          basis: "explicit",
          explanation: "交付行为使决定成立",
          evidence: [{ chapterId: "ch1", ...span(content, "铜扣交给父亲。") }],
        },
      ],
    },
  );
  assert.equal(linked.storyEvents.nodes.length, 3);
  const incoming = linked.storyEvents.edges.filter((e) => e.target === ids[2]);
  assert.equal(incoming.length, 2);
  const sub = storySubgraph(linked.storyEvents, { eventIds: [ids[2]], depth: 1, direction: "up" });
  assert.equal(sub.nodes.length, 3);
});

test("改稿后 evidence 失效标 stale，并递归列出下游，正文不变", () => {
  const p = {
    chapters: [
      chapter("ch1", 1, "顺济号出航", content),
      chapter("ch2", 2, "黑石岛", "黑石岛的雾很重。"),
    ],
  };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draft(),
      draft({
        chapterId: "ch2",
        chapterNumber: 2,
        chapterTitle: "黑石岛",
        title: "雾中看见旧船",
        actors: ["林砚"],
        objects: ["铜扣"],
        evidence: span("黑石岛的雾很重。", "黑石岛的雾"),
      }),
    ],
    { chapters: p.chapters },
  );
  assert.equal(built.storyEvents.nodes.length, 2);
  const [first, second] = built.storyEvents.nodes;
  const withEdge = mergeStoryEvents(built.storyEvents, [], {
    chapters: p.chapters,
    edges: [
      {
        source: first.id,
        target: second.id,
        type: "causal",
        basis: "explicit",
        explanation: "交出的铜扣让他在雾中认出旧船",
        evidence: [{ chapterId: "ch1", ...span(content, "林砚把铜扣交给父亲。") }],
      },
    ],
  }).storyEvents;

  const revised = { ...p, chapters: [chapter("ch1", 1, "顺济号出航", "林砚把钥匙交给父亲。汽笛响了三声。"), p.chapters[1]] };
  const impact = impactOf(withEdge, revised);
  assert.equal(impact.staleNodeIds.length, 1);
  assert.equal(impact.staleNodeIds[0], first.id);
  assert.ok(impact.staleEdgeIds.length >= 1);
  assert.ok(impact.downstreamNodeIds.includes(second.id));
  assert.equal(impact.issues[0].kind, "stale-evidence");
  assert.equal(revised.chapters[0].content, "林砚把钥匙交给父亲。汽笛响了三声。");
});

test("覆盖记录按章写明状态、分片与失败原因", () => {
  const coverage = chapterCoverage({
    chapterId: "ch2",
    status: "partial",
    parts: [0, 2, 5],
    model: "glm-5.3",
    failure: "第2片超时",
  });
  assert.deepEqual(coverage.parts, [0, 2, 5]);
  const graph = normalizeStoryEvents({ ...emptyStoryEvents(), coverage: [coverage] });
  assert.equal(graph.coverage[0].status, "partial");
  assert.equal(graph.coverage[0].failure, "第2片超时");
  assert.ok(graph.coverage[0].extractedAt);
});

test("无效覆盖状态被拒绝", () => {
  assert.throws(() => chapterCoverage({ chapterId: "ch1", status: "finished", parts: [] }));
});

test("旧作品没有 storyEvents 字段仍按空图处理", () => {
  const view = normalizeStoryEvents(undefined);
  assert.deepEqual(view.nodes, []);
  assert.deepEqual(view.edges, []);
  assert.equal(view.version, 1);
});

test("问题汇总可按 disposition 过滤", () => {
  const graph = normalizeStoryEvents({
    nodes: [draft()],
    issues: [
      { kind: "missing-source", nodeIds: [], edgeIds: [], explanation: "x", suggestion: "", disposition: "open" },
      { kind: "conflict", nodeIds: [], edgeIds: [], explanation: "y", suggestion: "", disposition: "dismissed" },
    ],
  });
  assert.equal(storyEventIssues(graph, { disposition: "open" }).length, 1);
  assert.equal(storyEventIssues(graph).length, 2);
});

test("evidence 由程序按区间回填原文", () => {
  const ev = eventEvidence("ch1", content, 0, 17, "ch1");
  assert.equal(ev.quote, content.slice(0, 17));
  assert.equal(ev.start, 0);
  assert.equal(ev.end, 17);
});

test("边 id 稳定，不随章节号变化", () => {
  const one = storyEdgeId({ source: "n1", target: "n2", type: "causal" });
  assert.equal(one, storyEdgeId({ source: "n1", target: "n2", type: "causal" }));
  assert.match(one, /^see-[0-9a-f]{12}$/);
});

test("项目保存 storyEvents 后往返仍在，不被 schema 剥掉", async () => {
  const { projectSchema } = await import("../runtime/schema.mjs");
  const { ProjectStore } = await import("../runtime/storage.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { blankProject } = await import("../runtime/seed.mjs");
  const dir = await mkdtemp(join(tmpdir(), "story-events-"));
  try {
    const store = new ProjectStore(dir);
    const base = await store.load();
    const graph = mergeStoryEvents(emptyStoryEvents(), [draft()], {
      chapters: [chapter("ch1", 1, "顺济号出航", content)],
    }).storyEvents;
    await store.save({ ...base, storyEvents: graph }, base.revision);
    const loaded = await new ProjectStore(dir).load();
    assert.ok(loaded.storyEvents, "storyEvents 字段被 schema 剥掉了");
    assert.equal(loaded.storyEvents.nodes.length, 1);
    assert.equal(loaded.storyEvents.nodes[0].id, graph.nodes[0].id);
    assert.equal(loaded.storyEvents.version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有 storyEvents 的老作品仍能 parse（向后兼容）", async () => {
  const { projectSchema } = await import("../runtime/schema.mjs");
  const { blankProject } = await import("../runtime/seed.mjs");
  const parsed = projectSchema.parse(blankProject());
  assert.equal(parsed.storyEvents, undefined);
});

// R4：区间与引文不符必须明确拒绝，不能拿同章另一段文字顶替并盖上当前哈希。
test("R4 区间与引文不符时拒绝事件，不替换引文也不刷新哈希", () => {
  const text = "汽笛响了。甲把钥匙交给乙。";
  const ch = chapter("ch1", 1, "交接", text);
  const badDraft = {
    chapterId: "ch1",
    chapterNumber: 1,
    chapterTitle: "交接",
    storyTime: "",
    narrativeOffset: 0,
    title: "甲把钥匙交给乙",
    summary: "",
    kind: "handover",
    actors: ["甲", "乙"],
    objects: ["钥匙"],
    status: "confirmed",
    basis: "narration",
    // 引文取自后句，区间却指向前句。旧实现会把引文替换成「汽笛响了。」后通过。
    evidence: { start: 0, end: 5, quote: "甲把钥匙交给乙。" },
  };
  const merged = mergeStoryEvents(emptyStoryEvents(), [badDraft], { chapter: ch });
  assert.equal(merged.storyEvents.nodes.length, 0, "错误区间不得生成事件");
  assert.equal(merged.counts.added, 0);
  assert.equal(
    merged.storyEvents.issues.filter((i) => i.kind === "missing-source").length,
    1,
  );
  assert.equal(
    merged.storyEvents.nodes.some((n) => n.evidence.quote === "汽笛响了。"),
    false,
    "不得把区间切片当成引文写入",
  );

  const direct = normalizeStoryEvents({
    nodes: [{ ...badDraft, id: "sev-bad" }],
    chapters: [ch],
  });
  assert.equal(direct.nodes.length, 0, "归一化也不得接受区间与引文不符的出处");
});

test("R4 区间与引文一致时照常通过并回填当前哈希", () => {
  const text = "汽笛响了。甲把钥匙交给乙。";
  const ch = chapter("ch1", 1, "交接", text);
  const merged = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: { start: 5, end: 13, quote: "甲把钥匙交给乙。" },
      },
    ],
    { chapter: ch },
  );
  assert.equal(merged.storyEvents.nodes.length, 1);
  assert.equal(merged.storyEvents.nodes[0].evidence.quote, "甲把钥匙交给乙。");
  assert.equal(merged.storyEvents.nodes[0].evidence.start, 5);
  assert.equal(merged.storyEvents.nodes[0].evidence.end, 13);
});

test("非法 storyEvents 在 parse 时被拒绝，而不是静默丢弃", async () => {
  const { projectSchema } = await import("../runtime/schema.mjs");
  const { blankProject } = await import("../runtime/seed.mjs");
  const graph = mergeStoryEvents(emptyStoryEvents(), [draft()], {
    chapters: [chapter("ch1", 1, "顺济号出航", content)],
  }).storyEvents;
  const broken = {
    ...graph,
    edges: [
      {
        id: "see-broken",
        source: "sev-missing",
        target: graph.nodes[0].id,
        type: "causal",
        basis: "explicit",
        explanation: "指向不存在的事件",
        evidence: [],
        review: { state: "unreviewed", note: "", at: null },
        stale: null,
      },
    ],
  };
  assert.throws(
    () => projectSchema.parse({ ...blankProject(), storyEvents: broken }),
    /关系必须连接两个存在的事件/,
  );
});

// ---------- R5：同段多事件 vs 同一事件重抽 ----------

const twoEventText = "甲把钥匙交给乙，乙随后打开门。";

test("R5 同一句原文抽出的两件事保留为两个不同节点与因果关系", () => {
  const ch = chapter("ch1", 1, "交接", twoEventText);
  const graph = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "甲交出钥匙。",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(twoEventText, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "乙用钥匙开门。",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(twoEventText, "乙随后打开门"),
      },
    ],
    { chapter: ch },
  );
  assert.equal(graph.storyEvents.nodes.length, 2, "同段两件事不得被合并覆盖");
  const [handover, opening] = graph.storyEvents.nodes;
  assert.notEqual(handover.id, opening.id, "两个事件必须有不同身份");
  assert.equal(handover.evidence.quote, "甲把钥匙交给乙");
  assert.equal(opening.evidence.quote, "乙随后打开门");

  const linked = mergeStoryEvents(graph.storyEvents, [], {
    chapter: ch,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "钥匙到手后乙才开门",
        evidence: [{ chapterId: "ch1", ...span(twoEventText, "甲把钥匙交给乙，乙随后打开门。") }],
      },
    ],
  });
  assert.equal(linked.storyEvents.edges.length, 1);
  assert.equal(linked.storyEvents.edges[0].source, handover.id);
  assert.equal(linked.storyEvents.edges[0].target, opening.id);
});

test("R5 重抽同一事件不新增重复节点，也不把另一件事的边改指过去", () => {
  const ch = chapter("ch1", 1, "交接", twoEventText);
  const first = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(twoEventText, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(twoEventText, "乙随后打开门"),
      },
    ],
    { chapter: ch },
  ).storyEvents;
  const [handover, opening] = first.nodes;
  const withEdge = mergeStoryEvents(first, [], {
    chapter: ch,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [{ chapterId: "ch1", ...span(twoEventText, "甲把钥匙交给乙，乙随后打开门。") }],
      },
    ],
  }).storyEvents;

  // 只重抽"交钥匙"这一件事：标题与摘要允许改写。
  const again = mergeStoryEvents(
    withEdge,
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "稍有改写的摘要。",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(twoEventText, "甲把钥匙交给乙"),
      },
    ],
    { chapter: ch },
  );
  assert.equal(again.storyEvents.nodes.length, 2, "重抽同一事件不得新增节点");
  assert.equal(again.counts.added, 0);
  assert.equal(again.counts.merged, 1);
  assert.equal(again.storyEvents.nodes[0].id, handover.id, "事件身份必须保持不变");
  assert.equal(again.storyEvents.nodes[0].summary, "稍有改写的摘要。");
  const edge = again.storyEvents.edges.find((e) => e.id === withEdge.edges[0].id);
  assert.ok(edge, "既有连线必须保留");
  assert.equal(edge.source, handover.id, "连线不得改指另一件事");
  assert.equal(edge.target, opening.id, "连线不得改指另一件事");
});

// ---------- R6：改稿保留原点 ----------

test("R6 改稿后保留旧原点与旧证据并标 stale，失效计数非零且不自动改后文", () => {
  const original = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [
    chapter("ch1", 1, "交接", original),
    chapter("ch2", 2, "开门之后", "乙走进院子。"),
  ];
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(original, "甲把钥匙交给乙。"),
      },
      {
        chapterId: "ch2",
        title: "乙走进院子",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["院子"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("乙走进院子。", "乙走进院子。"),
      },
    ],
    { chapters },
  ).storyEvents;
  const [handover, later] = built.nodes;
  const withEdge = mergeStoryEvents(built, [], {
    chapters,
    edges: [
      {
        source: handover.id,
        target: later.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才进得了院子",
        evidence: [{ chapterId: "ch1", ...span(original, "甲把钥匙交给乙。") }],
      },
    ],
  }).storyEvents;

  // 作者改掉第一章：原来那次交钥匙被改写。
  const revised = {
    chapters: [
      chapter("ch1", 1, "交接", "甲把钥匙收回口袋。乙随后打开门。"),
      chapters[1],
    ],
  };
  const merged = mergeStoryEvents(withEdge, [], revised);
  assert.equal(merged.storyEvents.nodes.length, 2, "不得删除失效节点");
  assert.ok(merged.counts.stale >= 1, "失效计数必须非零");
  const keptHandover = merged.storyEvents.nodes.find((n) => n.id === handover.id);
  assert.ok(keptHandover, "旧原点必须保留");
  assert.ok(keptHandover.stale, "旧原点必须标记失效");
  assert.equal(keptHandover.stale.reason, "quote-missing");
  assert.equal(keptHandover.evidence.quote, "甲把钥匙交给乙。", "旧证据原样保留");
  assert.equal(keptHandover.stale.expectedHash, handover.evidence.sourceHash);
  const keptEdge = merged.storyEvents.edges.find((e) => e.id === withEdge.edges[0].id);
  assert.ok(keptEdge, "受影响关系不得被删除");
  assert.ok(keptEdge.stale, "受影响关系必须标记失效");
  assert.equal(revised.chapters[1].content, "乙走进院子。", "不得自动改后文");

  // 再来一次空增量合并：stale 不能被抹掉，节点也不能消失。
  const again = mergeStoryEvents(merged.storyEvents, [], revised);
  assert.equal(again.storyEvents.nodes.length, 2);
  assert.ok(again.counts.stale >= 1, "空增量合并后失效计数仍须非零");
  assert.ok(again.storyEvents.nodes.find((n) => n.id === handover.id).stale);
});

// ---------- R3：合并不删合法关系 ----------

test("R3 空增量合并、采纳新章、转换候选、处理问题都不删除合法 explicit 边", () => {
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [
    chapter("ch1", 1, "交接", text),
    chapter("ch2", 2, "新章", "门外下起了雨。"),
  ];
  const base = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "乙随后打开门"),
      },
    ],
    { chapters },
  ).storyEvents;
  const [handover, opening] = base.nodes;
  const withEdge = mergeStoryEvents(base, [], {
    chapters,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [{ chapterId: "ch1", ...span(text, "甲把钥匙交给乙。乙随后打开门。") }],
      },
    ],
  }).storyEvents;
  assert.equal(withEdge.edges.length, 1, "前置：应有一条合法 explicit 边");
  const edgeId = withEdge.edges[0].id;

  // ① 合并空增量
  const empty = mergeStoryEvents(withEdge, [], { chapters });
  assert.ok(empty.storyEvents.edges.find((e) => e.id === edgeId), "空增量不得删边");

  // ② 采纳新章（第二章新增事件）
  const newChapter = mergeStoryEvents(
    withEdge,
    [
      {
        chapterId: "ch2",
        title: "门外下起了雨",
        summary: "",
        kind: "state-change",
        actors: [],
        objects: ["雨"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("门外下起了雨。", "门外下起了雨。"),
      },
    ],
    { chapters },
  );
  assert.ok(
    newChapter.storyEvents.edges.find((e) => e.id === edgeId),
    "采纳新章不得删掉无关的既有关系",
  );
});

// ---------- 追加项 A：reviewDisposition 安全化 ----------

test("追加A 处理一个问题时，其他问题的 disposition 与合法 explicit 边都不受影响", async () => {
  const { reviewDisposition } = await import("../runtime/story-event-agent.mjs");
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [chapter("ch1", 1, "交接", text)];
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "乙随后打开门"),
      },
    ],
    { chapters },
  ).storyEvents;
  const [handover, opening] = built.nodes;
  const linked = mergeStoryEvents(built, [], {
    chapters,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [{ chapterId: "ch1", ...span(text, "甲把钥匙交给乙。乙随后打开门。") }],
      },
    ],
  }).storyEvents;
  const withIssues = {
    ...linked,
    issues: [
      {
        id: "sit-keep",
        kind: "conflict",
        nodeIds: [],
        edgeIds: [],
        explanation: "待核对甲",
        suggestion: "",
        disposition: "open",
      },
      {
        id: "sit-other",
        kind: "missing-source",
        nodeIds: [],
        edgeIds: [],
        explanation: "待核对乙",
        suggestion: "",
        disposition: "kept",
      },
    ],
  };
  assert.equal(withIssues.edges.length, 1, "前置：应有一条合法 explicit 边");
  const edgeId = withIssues.edges[0].id;

  const decided = reviewDisposition(withIssues, "sit-keep", "author-decided");
  assert.equal(
    decided.issues.find((i) => i.id === "sit-keep").disposition,
    "author-decided",
  );
  assert.equal(
    decided.issues.find((i) => i.id === "sit-other").disposition,
    "kept",
    "其他人的处理结果不得被顺带清掉",
  );
  assert.ok(
    decided.edges.find((e) => e.id === edgeId),
    "处理问题不得删除合法 explicit 边",
  );
  assert.equal(decided.nodes.length, withIssues.nodes.length, "不得删除节点");
});

test("追加A 未知 issueId 与非法 disposition 必须报错，不能静默返回原图", async () => {
  const { reviewDisposition } = await import("../runtime/story-event-agent.mjs");
  const graph = normalizeStoryEvents({
    issues: [
      {
        id: "sit-real",
        kind: "conflict",
        nodeIds: [],
        edgeIds: [],
        explanation: "存在的问题",
        suggestion: "",
        disposition: "open",
      },
    ],
  });
  assert.throws(
    () => reviewDisposition(graph, "sit-does-not-exist", "kept"),
    /sit-does-not-exist/,
    "未知 issueId 必须报错并带上该 id",
  );
  assert.throws(
    () => reviewDisposition(graph, "sit-real", "resolved"),
    /open|kept|dismissed|author-decided/,
    "非法 disposition 必须报错",
  );
});

// ---------- knownNodeIds：跨章关系端点契约 ----------

test("knownNodeIds 增量只含本章节点时，指向正式历史事件的边保留", () => {
  const ch = chapter("ch2", 2, "开门", "乙用钥匙打开门。");
  const local = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch2",
        title: "乙用钥匙打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("乙用钥匙打开门。", "乙用钥匙打开门"),
      },
    ],
    { chapter: ch },
  ).storyEvents;
  const localId = local.nodes[0].id;
  const historyId = "sev-formal-history-0001";
  const crossEdge = {
    id: "see-cross-known",
    source: historyId,
    target: localId,
    type: "recall",
    basis: "explicit",
    explanation: "第二章用到第一章交出的钥匙",
    evidence: [{ chapterId: "ch2", ...span("乙用钥匙打开门。", "乙用钥匙打开门") }],
    review: { state: "unreviewed", note: "", at: null },
    stale: null,
  };

  // 不声明已知端点：历史端点不在本次 nodes 中，边必须被拒绝并留痕。
  const withoutKnown = normalizeStoryEvents({
    version: 1,
    nodes: local.nodes,
    edges: [crossEdge],
    coverage: [],
    issues: [],
    chapters: [ch],
  });
  assert.equal(withoutKnown.edges.length, 0, "未声明已知端点时不得接受跨章边");
  assert.ok(
    withoutKnown.issues.some((i) => i.kind === "missing-source"),
    "被拒绝的跨章边必须留下 missing-source 记录",
  );

  // 声明已知端点：同一条边必须保留，且端点指向不变。
  const withKnown = normalizeStoryEvents(
    {
      version: 1,
      nodes: local.nodes,
      edges: [crossEdge],
      coverage: [],
      issues: [],
      chapters: [ch],
    },
    { knownNodeIds: new Set([historyId]) },
  );
  assert.equal(withKnown.edges.length, 1, "声明已知端点后跨章边必须保留");
  assert.equal(withKnown.edges[0].source, historyId);
  assert.equal(withKnown.edges[0].target, localId);
});

test("knownNodeIds 指向两边都不存在的 id 时仍丢弃并生成 missing-source", () => {
  const ch = chapter("ch2", 2, "开门", "乙用钥匙打开门。");
  const local = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch2",
        title: "乙用钥匙打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("乙用钥匙打开门。", "乙用钥匙打开门"),
      },
    ],
    { chapter: ch },
  ).storyEvents;
  const graph = normalizeStoryEvents(
    {
      version: 1,
      nodes: local.nodes,
      edges: [
        {
          id: "see-ghost",
          source: "sev-nowhere",
          target: local.nodes[0].id,
          type: "causal",
          basis: "inferred",
          explanation: "凭空指向不存在的事件",
          evidence: [],
          review: { state: "unreviewed", note: "", at: null },
          stale: null,
        },
      ],
      coverage: [],
      issues: [],
      chapters: [ch],
    },
    { knownNodeIds: new Set(["sev-formal-history-0001"]) },
  );
  assert.equal(graph.edges.length, 0, "两边都不存在的端点必须丢弃");
  assert.ok(
    graph.issues.some((i) => i.kind === "missing-source"),
    "必须保留 missing-source 记录，不能放宽成不校验",
  );
});

test("knownNodeIds 不会把候选节点当成正式历史", () => {
  const ch = chapter("ch2", 2, "待定", "乙把钥匙放进抽屉。");
  const draftCandidate = {
    chapterId: "ch2",
    title: "乙把钥匙放进抽屉",
    summary: "",
    kind: "action",
    actors: ["乙"],
    objects: ["钥匙"],
    status: "candidate",
    basis: "narration",
    storyTime: "",
    evidence: span("乙把钥匙放进抽屉。", "乙把钥匙放进抽屉"),
  };
  const built = mergeStoryEvents(emptyStoryEvents(), [draftCandidate], {
    chapter: ch,
  }).storyEvents;
  const candidateId = built.nodes[0].id;
  assert.equal(built.nodes[0].status, "candidate", "前置：该节点应为候选状态");

  // 即使调用方把候选节点 id 塞进 knownNodeIds，它也只能算"本次增量里的节点"，
  // 状态仍然是 candidate；不会因为出现在已知集合里就被改成正式事件。
  const graph = normalizeStoryEvents(
    {
      version: 1,
      nodes: built.nodes,
      edges: [],
      coverage: [],
      issues: [],
      chapters: [ch],
    },
    { knownNodeIds: new Set([candidateId]) },
  );
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].id, candidateId);
  assert.equal(
    graph.nodes[0].status,
    "candidate",
    "候选事件不得因列入已知端点而变成正式历史",
  );

  // 反向证明：候选 id 不作为已知端点时，指向它的边并不因此自动获得合法性以外的特权。
  const ghost = normalizeStoryEvents(
    {
      version: 1,
      nodes: [],
      edges: [
        {
          id: "see-candidate-only",
          source: candidateId,
          target: "sev-other",
          type: "causal",
          basis: "inferred",
          explanation: "两端都不在增量内",
          evidence: [],
          review: { state: "unreviewed", note: "", at: null },
          stale: null,
        },
      ],
      coverage: [],
      issues: [],
      chapters: [ch],
    },
    { knownNodeIds: new Set() },
  );
  assert.equal(ghost.edges.length, 0);
  assert.ok(ghost.issues.some((i) => i.kind === "missing-source"));
});

test("R3 转换候选与处理问题都不得删除无关的合法 explicit 边", async () => {
  const { applyStoryEventPatch, resolveProposalStoryEvents } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const { reviewDisposition } = await import("../runtime/story-event-agent.mjs");
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [chapter("ch1", 1, "交接", text)];
  const project = { chapters, storyEvents: emptyStoryEvents() };
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "乙随后打开门"),
      },
    ],
    { chapters },
  ).storyEvents;
  const [handover, opening] = built.nodes;
  const linked = mergeStoryEvents(built, [], {
    chapters,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [{ chapterId: "ch1", ...span(text, "甲把钥匙交给乙。乙随后打开门。") }],
      },
    ],
  }).storyEvents;
  const edgeId = linked.edges[0].id;
  const formal = { ...project, storyEvents: linked };

  // ③ 转换候选：候选增量（无 id）落地到正式图
  const converted = applyStoryEventPatch(formal, {
    nodes: [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "候选里的同一件事",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
    ],
  });
  assert.ok(
    converted.edges.find((e) => e.id === edgeId),
    "转换候选不得删除无关的既有关系",
  );
  assert.equal(converted.nodes.length, 2, "转换候选不得新建重复节点");

  // 完整图形态的候选同样不得删边
  const asFull = resolveProposalStoryEvents(formal, linked);
  assert.ok(
    asFull.edges.find((e) => e.id === edgeId),
    "完整图候选解析不得删除既有关系",
  );

  // ④ 处理问题（disposition）
  const withIssue = {
    ...formal.storyEvents,
    issues: [
      {
        id: "sit-r3",
        kind: "conflict",
        nodeIds: [],
        edgeIds: [],
        explanation: "待核对",
        suggestion: "",
        disposition: "open",
      },
    ],
  };
  const decided = reviewDisposition(withIssue, "sit-r3", "kept");
  assert.equal(decided.issues[0].disposition, "kept");
  assert.ok(
    decided.edges.find((e) => e.id === edgeId),
    "处理问题不得删除无关的既有关系",
  );
  assert.equal(decided.nodes.length, 2);
});

test("R3 采纳入口在无章节表时也不得因归一化丢弃合法 explicit 边", async () => {
  const { applyStoryEventPatch } = await import("../runtime/story-events-apply.mjs");
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [chapter("ch1", 1, "交接", text)];
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "乙随后打开门"),
      },
    ],
    { chapters },
  ).storyEvents;
  const [handover, opening] = built.nodes;
  const linked = mergeStoryEvents(built, [], {
    chapters,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [{ chapterId: "ch1", ...span(text, "甲把钥匙交给乙。乙随后打开门。") }],
      },
    ],
  }).storyEvents;
  const edgeId = linked.edges[0].id;

  // 采纳入口拿不到章节正文时（例如章节尚未同步），也不许把已有连线当成无效证据清掉。
  const withoutChapters = applyStoryEventPatch(
    { chapters: [], storyEvents: linked },
    { nodes: [] },
  );
  assert.ok(
    withoutChapters.edges.find((e) => e.id === edgeId),
    "无章节表时采纳不得删除已有合法关系",
  );
  assert.equal(withoutChapters.nodes.length, 2, "也不得删除既有节点");
});

test("R3 四种操作串在同一条 explicit 边上，每一步之后边都必须仍在", async () => {
  const { applyStoryEventPatch } = await import("../runtime/story-events-apply.mjs");
  const { reviewDisposition } = await import("../runtime/story-event-agent.mjs");
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [
    chapter("ch1", 1, "交接", text),
    chapter("ch2", 2, "新章", "院墙外传来脚步声。"),
  ];
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
      {
        chapterId: "ch1",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "乙随后打开门"),
      },
    ],
    { chapters },
  ).storyEvents;
  const [handover, opening] = built.nodes;
  const linked = mergeStoryEvents(built, [], {
    chapters,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [{ chapterId: "ch1", ...span(text, "甲把钥匙交给乙。乙随后打开门。") }],
      },
    ],
  }).storyEvents;
  const edgeId = linked.edges[0].id;
  const assertEdgeAlive = (graph, step) => {
    const found = graph.edges.find((e) => e.id === edgeId);
    assert.ok(found, `${step} 之后那条 explicit 边必须仍在`);
    assert.equal(found.source, handover.id, `${step} 之后边起点不得被改指`);
    assert.equal(found.target, opening.id, `${step} 之后边终点不得被改指`);
  };
  assertEdgeAlive(linked, "前置");

  // ① 合并空增量
  let graph = mergeStoryEvents(linked, [], { chapters }).storyEvents;
  assertEdgeAlive(graph, "①合并空增量");

  // ② 采纳新章（第二章新增一个事件）
  graph = mergeStoryEvents(
    graph,
    [
      {
        chapterId: "ch2",
        title: "院墙外传来脚步声",
        summary: "",
        kind: "discovery",
        actors: [],
        objects: [],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("院墙外传来脚步声。", "院墙外传来脚步声"),
      },
    ],
    { chapters },
  ).storyEvents;
  assertEdgeAlive(graph, "②采纳新章");
  assert.equal(graph.nodes.length, 3, "采纳新章后应有三个事件");

  // ③ 转换候选（增量补丁形态 → 正式图）
  graph = applyStoryEventPatch({ chapters, storyEvents: graph }, {
    nodes: [
      {
        chapterId: "ch1",
        title: "甲把钥匙交给乙",
        summary: "候选改写摘要",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙"),
      },
    ],
  });
  assertEdgeAlive(graph, "③转换候选");
  assert.equal(graph.nodes.length, 3, "转换候选不得重复建节点");

  // ④ 处理问题（disposition）
  graph = reviewDisposition(
    {
      ...graph,
      issues: [
        {
          id: "sit-chain",
          kind: "conflict",
          nodeIds: [],
          edgeIds: [],
          explanation: "串行验证用问题",
          suggestion: "",
          disposition: "open",
        },
      ],
    },
    "sit-chain",
    "dismissed",
  );
  assertEdgeAlive(graph, "④处理问题");
  assert.equal(graph.issues[0].disposition, "dismissed");
});

test("F5 同一句内两次不同交接保留两个事件身份与连线", () => {
  const content = "甲把钥匙交给乙，乙又把钥匙交给丙。";
  const chapter = {
    id: "ch-f5",
    number: 1,
    title: "钥匙转手",
    summary: "",
    content,
  };
  // 两次交接共用整句引文（不得改成两段不重叠引文来规避）。
  const wholeQuote = content;
  const make = (title, actors, objects) => ({
    chapterId: "ch-f5",
    title,
    summary: "",
    kind: "handover",
    actors,
    objects,
    basis: "narration",
    storyTime: "",
    evidence: { start: 0, end: content.length, quote: wholeQuote },
  });
  const merged = mergeStoryEvents(
    emptyStoryEvents(),
    [
      make("甲把钥匙交给乙", ["甲", "乙"], ["钥匙"]),
      make("乙把钥匙交给丙", ["乙", "丙"], ["钥匙"]),
    ],
    { chapters: [chapter] },
  );
  assert.equal(
    merged.storyEvents.nodes.length,
    2,
    "同一句里的两次不同交接必须保留两个身份，实际：" +
      JSON.stringify(merged.storyEvents.nodes.map((n) => n.title)),
  );
  const ids = merged.storyEvents.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, 2, "两个事件不得复用同一个 ID");

  // 两次交接之间应能建立关系，且端点指向各自事件而非同一个。
  const linked = mergeStoryEvents(merged.storyEvents, [], {
    chapters: [chapter],
    edges: [
      {
        source: ids[0],
        target: ids[1],
        type: "state-transfer",
        basis: "explicit",
        explanation: "乙先接过钥匙，随后转交丙",
        evidence: [
          { chapterId: "ch-f5", start: 0, end: content.length, quote: wholeQuote },
        ],
      },
    ],
  }).storyEvents;
  const cross = linked.edges.find(
    (e) => e.source === ids[0] && e.target === ids[1],
  );
  assert.ok(cross, "第二次交接的关系必须建立");
});

test("F5 真正同一事件重抽仍不重复", () => {
  const content = "甲把钥匙交给乙。";
  const chapter = {
    id: "ch-f5b",
    number: 1,
    title: "钥匙",
    summary: "",
    content,
  };
  const draft = {
    chapterId: "ch-f5b",
    title: "甲把钥匙交给乙",
    summary: "",
    kind: "handover",
    actors: ["甲", "乙"],
    objects: ["钥匙"],
    basis: "narration",
    storyTime: "",
    evidence: { start: 0, end: content.length, quote: content },
  };
  const first = mergeStoryEvents(emptyStoryEvents(), [draft], {
    chapters: [chapter],
  }).storyEvents;
  const second = mergeStoryEvents(first, [draft], { chapters: [chapter] });
  assert.equal(second.storyEvents.nodes.length, 1, "同一事件重抽不得新增节点");
  assert.equal(second.storyEvents.nodes[0].id, first.nodes[0].id);
});

// ---------------------------------------------------------------
// G3（F6/F7/F2）：旧证据哈希必须保留、多证据失效原因取自实际失效那份、
// 候选 issues 与作者处理状态必须随采纳落地。归属：翰林院编修 hanlin-bianxiu-2。
// ---------------------------------------------------------------

test("F6 空补丁采纳不得重盖旧哈希，改稿后的失效不得被抹成 0", async () => {
  const { applyStoryEventPatch } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const before = [chapter("chF6", 1, "交接", text)];
  const graph = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "chF6",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙。"),
      },
    ],
    { chapters: before },
  ).storyEvents;
  const establishedHash = graph.nodes[0].evidence.sourceHash;
  assert.equal(graph.nodes[0].stale, null, "建立证据时不应 stale");

  // 正文后追加一句：引文区间与引文本身都不变，只有整章哈希改变。
  const changed = [
    chapter("chF6", 1, "交接", text + "这是乙的幻想，实际并未发生。"),
  ];
  const project = { chapters: changed, storyEvents: graph };

  const impact = impactOf(graph, project);
  assert.equal(impact.staleNodeIds.length, 1, "改稿后应检出 1 个失效事件");

  // 空补丁采纳：本轮没有任何新事件，绝不能把旧证据重新盖上当前哈希。
  const applied = applyStoryEventPatch(project, { nodes: [], edges: [] });
  assert.equal(
    applied.nodes[0].evidence.sourceHash,
    establishedHash,
    "空补丁采纳不得把旧证据的 sourceHash 换成当前正文哈希",
  );
  assert.equal(
    applied.nodes[0].evidence.quote,
    "甲把钥匙交给乙。",
    "旧证据引文不得被改写",
  );
  const after = impactOf(applied, project);
  assert.equal(
    after.staleNodeIds.length,
    1,
    "空补丁采纳后失效数不得变成 0（原缺陷正是重盖哈希消除失效）",
  );
  assert.ok(applied.nodes[0].stale, "旧节点必须保留 stale 标记");
  assert.equal(
    applied.nodes[0].stale.reason,
    "source-changed",
    "失效原因必须为正文已变更",
  );
});

test("F6 无关章采纳同样不得刷新旧证据哈希", async () => {
  const { applyStoryEventPatch } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const first = [chapter("chF6b", 1, "交接", text)];
  const graph = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "chF6b",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙。"),
      },
    ],
    { chapters: first },
  ).storyEvents;
  const establishedHash = graph.nodes[0].evidence.sourceHash;
  const changed = [
    chapter("chF6b", 1, "交接", text + "这是乙的幻想，实际并未发生。"),
    chapter("chF6c", 2, "第二章", "无关章节的正文。"),
  ];
  const project = { chapters: changed, storyEvents: graph };

  // 采纳一个只在无关章节新增事件的补丁。
  const applied = applyStoryEventPatch(project, {
    nodes: [
      {
        chapterId: "chF6c",
        title: "无关章节的另一件事",
        summary: "",
        kind: "action",
        actors: ["丙"],
        objects: [],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span("无关章节的正文。", "无关章节的正文。"),
      },
    ],
    edges: [],
  });
  const target = applied.nodes.find((n) => n.chapterId === "chF6b");
  assert.ok(target, "旧节点必须保留");
  assert.equal(
    target.evidence.sourceHash,
    establishedHash,
    "无关章采纳不得刷新旧证据哈希",
  );
  assert.equal(target.stale?.reason, "source-changed", "旧节点必须仍标 stale");
});

test("F7 后一份证据失效时 stale 原因与哈希必须取自实际失效那份", async () => {
  const { applyStoryEventPatch } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const { storyEventsSchema } = await import(
    "../runtime/story-events-schema.mjs"
  );
  const text1 = "甲把钥匙交给乙。乙随后打开门。";
  const text2 = "门外下着雨。";
  const before = [
    chapter("chF7a", 1, "交接", text1),
    chapter("chF7b", 2, "门外", text2),
  ];
  const base = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "chF7a",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text1, "甲把钥匙交给乙"),
      },
      {
        chapterId: "chF7a",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text1, "乙随后打开门"),
      },
    ],
    { chapters: before },
  ).storyEvents;
  const [handover, opening] = base.nodes;
  const ev1 = { chapterId: "chF7a", ...span(text1, "甲把钥匙交给乙。乙随后打开门。") };
  const ev2 = { chapterId: "chF7b", ...span(text2, "门外下着雨。") };
  const withEdge = mergeStoryEvents(base, [], {
    chapters: before,
    edges: [
      {
        source: handover.id,
        target: opening.id,
        type: "causal",
        basis: "explicit",
        explanation: "拿到钥匙才开门",
        evidence: [ev1, ev2],
      },
    ],
  }).storyEvents;
  assert.equal(withEdge.edges.length, 1, "双证据的边应建立成功");
  assert.equal(withEdge.edges[0].evidence.length, 2, "边必须保留两份证据");
  assert.equal(withEdge.edges[0].stale, null, "正文未变时边不应 stale");
  const secondHash = withEdge.edges[0].evidence[1].sourceHash;

  // 只改第二章：第一份证据仍有效，第二份失效（原缺陷只取第一份 → reason=null）。
  const changed = [
    chapter("chF7a", 1, "交接", text1),
    chapter("chF7b", 2, "门外", "门外下着雪，刮着风。"),
  ];
  const project = { chapters: changed, storyEvents: withEdge };
  const impact = impactOf(withEdge, project);
  const staleEdge = impact.storyEvents.edges[0];
  assert.ok(staleEdge.stale, "第二份证据失效时边必须标 stale");
  assert.equal(
    staleEdge.stale.reason,
    "quote-missing",
    "reason 必须取自实际失效的第二份证据，而不是第一份或 null",
  );
  assert.equal(
    staleEdge.stale.expectedHash,
    secondHash,
    "expectedHash 必须是失效那份证据的原哈希",
  );
  assert.ok(
    storyEventsSchema.safeParse(impact.storyEvents).success,
    "多证据失效的结果必须能通过 schema（旧实现 reason=null 被拒）",
  );

  // 采纳（空补丁）必须可保存，且旧节点与旧边继续保留。
  const applied = applyStoryEventPatch(project, { nodes: [], edges: [] });
  assert.ok(
    storyEventsSchema.safeParse(applied).success,
    "多证据关系变更必须可保存",
  );
  assert.equal(applied.edges.length, 1, "旧边不得被删除");
  assert.equal(applied.edges[0].evidence.length, 2, "旧边证据不得被删除");
  assert.equal(
    applied.edges[0].stale?.reason,
    "quote-missing",
    "保存后失效原因仍须可解释",
  );
  // 按 id 断言旧节点仍在，而不是数总数：
  // 合并实现可能为校验附挂历史节点副本，总数会随该语义变化，
  // 但"两个旧节点都还在"这一点必须恒成立。
  assert.deepEqual(
    applied.nodes.map((n) => n.id).sort(),
    [handover.id, opening.id].sort(),
    "旧节点不得被删除",
  );
});

test("F2 候选 issues 必须随采纳落地，且不得清除作者已处理状态", async () => {
  const { applyStoryEventPatch } = await import(
    "../runtime/story-events-apply.mjs"
  );
  const text = "甲把钥匙交给乙。乙随后打开门。";
  const chapters = [chapter("chF2", 1, "交接", text)];
  const built = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "chF2",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "甲把钥匙交给乙。"),
      },
    ],
    { chapters },
  ).storyEvents;
  // 正式图已有一条作者处理过的 issue（disposition=kept）。
  const formal = {
    chapters,
    storyEvents: {
      ...built,
      issues: [
        {
          id: "sit-formal-kept",
          kind: "conflict",
          nodeIds: [built.nodes[0].id],
          edgeIds: [],
          explanation: "正式图里作者已决定保留的问题",
          suggestion: "保留，暂不修订",
          disposition: "kept",
        },
      ],
    },
  };

  const applied = applyStoryEventPatch(formal, {
    nodes: [
      {
        chapterId: "chF2",
        title: "乙随后打开门",
        summary: "",
        kind: "action",
        actors: ["乙"],
        objects: ["门"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(text, "乙随后打开门。"),
      },
    ],
    edges: [],
    issues: [
      {
        id: "sit-candidate-open",
        kind: "unsourced-knowledge",
        nodeIds: [],
        edgeIds: [],
        explanation: "候选本轮发现的问题",
        suggestion: "请作者核对获知过程",
        disposition: "open",
      },
    ],
  });

  assert.ok(
    applied.issues.some((i) => i.id === "sit-formal-kept"),
    "正式图已有 issue 不得因采纳而消失",
  );
  assert.equal(
    applied.issues.find((i) => i.id === "sit-formal-kept").disposition,
    "kept",
    "作者已处理的决定不得被清除",
  );
  assert.ok(
    applied.issues.some((i) => i.id === "sit-candidate-open"),
    "候选本轮 issues 必须随采纳落地（原缺陷只合并 nodes/edges/coverage）",
  );
  assert.equal(
    applied.issues.find((i) => i.id === "sit-candidate-open").disposition,
    "open",
    "候选问题保留其原始处理状态",
  );
});

// ===== 合并收尾校验必须感知 knownNodeIds（跨章边）=====

test("mergeStoryEvents 带 knownNodeIds 时指向外部节点的边通过收尾校验，不带时被拒绝", () => {
  const ch1 = { id: "ch-k1", number: 1, title: "顺流", summary: "", content: "甲把钥匙交给乙。" };
  const ch2 = { id: "ch-k2", number: 2, title: "开门", summary: "", content: "乙用钥匙打开门。" };
  const span = (chapter, quote) => {
    const start = chapter.content.indexOf(quote);
    return { start, end: start + quote.length, quote };
  };
  const formal = mergeStoryEvents(
    emptyStoryEvents(),
    [
      {
        chapterId: "ch-k1",
        title: "甲把钥匙交给乙",
        summary: "",
        kind: "handover",
        actors: ["甲", "乙"],
        objects: ["钥匙"],
        status: "confirmed",
        basis: "narration",
        storyTime: "",
        evidence: span(ch1, "甲把钥匙交给乙"),
      },
    ],
    { chapters: [ch1, ch2] },
  ).storyEvents;
  const historyId = formal.nodes[0].id;

  const localDraft = {
    chapterId: "ch-k2",
    title: "乙用钥匙打开门",
    summary: "",
    kind: "action",
    actors: ["乙"],
    objects: ["钥匙"],
    status: "confirmed",
    basis: "narration",
    storyTime: "",
    evidence: span(ch2, "乙用钥匙打开门"),
  };
  const crossEdge = {
    source: historyId,
    target: storyEventId({
      chapterId: "ch-k2",
      title: "乙用钥匙打开门",
      start: 0,
      end: 7,
    }),
    type: "recall",
    basis: "explicit",
    explanation: "第二章用到第一章交出的钥匙",
    evidence: [{ chapterId: "ch-k2", ...span(ch2, "乙用钥匙打开门") }],
  };

  // 带 knownNodeIds：跨章边应通过合并收尾的 schema 校验。
  const withKnown = mergeStoryEvents(emptyStoryEvents(), [localDraft], {
    chapters: [ch1, ch2],
    edges: [crossEdge],
    knownNodeIds: [historyId],
    attachNodes: formal.nodes,
  });
  // 方案 B：附挂只服务校验，不进入输出——预览/采纳只见本轮节点。
  assert.equal(
    withKnown.storyEvents.nodes.length,
    1,
    "附挂的正式节点不得进入合并结果",
  );
  assert.equal(
    withKnown.storyEvents.nodes[0].chapterId,
    "ch-k2",
    "输出节点必须是本轮章节的节点",
  );
  assert.equal(
    withKnown.storyEvents.edges.length,
    1,
    "带 knownNodeIds 时指向正式历史的跨章边必须保留",
  );
  assert.equal(withKnown.storyEvents.edges[0].source, historyId);
  // 附带语义：added 只统计本轮真正新增的节点与边（既有语义），
  // 附挂的正式节点既不计入 added，也不会出现在输出里。
  // 本轮产生 1 个新节点 + 1 条新边 = 2。
  assert.equal(
    withKnown.counts.added,
    2,
    "added 应只含本轮 1 个新节点与 1 条新边，不含附挂节点",
  );
  // 原 formal 图对象不得被改写。
  assert.deepEqual(
    formal.nodes.map((n) => n.id),
    [historyId],
    "附挂不得修改原正式图节点集合",
  );
  assert.equal(
    formal.nodes.some((n) => n.external === true),
    false,
    "原正式图不得被打上 external 标记",
  );

  // 不带 knownNodeIds：同一输入必须被拒绝（边被丢弃并留下 missing-source），
  // 不能放过真正悬空的边，也不能静默吞掉而不记录。
  let rejected = false;
  try {
    const withoutKnown = mergeStoryEvents(emptyStoryEvents(), [localDraft], {
      chapters: [ch1, ch2],
      edges: [crossEdge],
    });
    assert.equal(
      withoutKnown.storyEvents.edges.length,
      0,
      "缺少 knownNodeIds 时不得保留指向外部节点的边",
    );
    assert.ok(
      withoutKnown.storyEvents.issues.some((i) => i.kind === "missing-source"),
      "被拒绝的跨章边必须留下 missing-source 记录，不能静默丢弃",
    );
    rejected = true;
  } catch (error) {
    rejected = true;
    assert.match(String(error.message), /两个存在的事件|关系|不存在/);
  }
  assert.ok(rejected, "缺少 knownNodeIds 时必须明确拒绝，而不是静默放行");
});

// ===== G2：同句往返交接必须保留两个身份 =====

test("G2 同一句内往返交接保留两个事件身份与关系", () => {
  const content = "甲把钥匙交给乙，乙检查后又把钥匙还给甲。";
  const chapter = {
    id: "ch-g2",
    number: 1,
    title: "往返",
    summary: "",
    content,
  };
  // 两次交接共用整句引文（不得改成两段不重叠引文来规避）。
  const wholeQuote = content;
  const make = (title) => ({
    chapterId: "ch-g2",
    title,
    summary: "",
    kind: "handover",
    actors: ["甲", "乙"],
    objects: ["钥匙"],
    basis: "narration",
    storyTime: "",
    evidence: { start: 0, end: content.length, quote: wholeQuote },
  });
  const merged = mergeStoryEvents(
    emptyStoryEvents(),
    [make("甲把钥匙交给乙"), make("乙把钥匙还给甲")],
    { chapters: [chapter] },
  );
  assert.equal(
    merged.storyEvents.nodes.length,
    2,
    "往返交接必须保留两个身份，实际：" +
      JSON.stringify(merged.storyEvents.nodes.map((n) => n.title)),
  );
  const ids = merged.storyEvents.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, 2, "两个事件不得复用同一 ID");

  const linked = mergeStoryEvents(merged.storyEvents, [], {
    chapters: [chapter],
    edges: [
      {
        source: ids[0],
        target: ids[1],
        type: "state-transfer",
        basis: "explicit",
        explanation: "先交出，检查后归还",
        evidence: [
          { chapterId: "ch-g2", start: 0, end: content.length, quote: wholeQuote },
        ],
      },
    ],
  }).storyEvents;
  assert.ok(
    linked.edges.find((e) => e.source === ids[0] && e.target === ids[1]),
    "往返关系必须建立且端点各自独立",
  );
});

test("G2 真正同一事件重抽仍不重复，已有边不改指", () => {
  const content = "甲把钥匙交给乙。";
  const chapter = {
    id: "ch-g2b",
    number: 1,
    title: "单次",
    summary: "",
    content,
  };
  const draft = {
    chapterId: "ch-g2b",
    title: "甲把钥匙交给乙",
    summary: "",
    kind: "handover",
    actors: ["甲", "乙"],
    objects: ["钥匙"],
    basis: "narration",
    storyTime: "",
    evidence: { start: 0, end: content.length, quote: content },
  };
  const first = mergeStoryEvents(emptyStoryEvents(), [draft], {
    chapters: [chapter],
  }).storyEvents;
  const second = mergeStoryEvents(first, [draft], { chapters: [chapter] });
  assert.equal(second.storyEvents.nodes.length, 1, "同一事件重抽不得新增节点");
  assert.equal(second.storyEvents.nodes[0].id, first.nodes[0].id);
});
