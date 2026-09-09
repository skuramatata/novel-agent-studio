import test from "node:test";
import assert from "node:assert/strict";
import {
  indexChapter,
  isCurrent,
  digest,
  modelWritingContext,
  contextFor,
} from "../runtime/memory.mjs";
import { selectMemoryRecords } from "../runtime/memory-selection.mjs";
import {
  compactWritingMemory,
  expandWritingMemory,
  resolveWritingQuote,
} from "../runtime/memory-transport.mjs";
import { fitWritingContext } from "../runtime/context-budget.mjs";
import {
  createBudgetProfile,
  estimatedTokens,
} from "../runtime/model-budget.mjs";
import { capabilityKey } from "../runtime/model-capabilities.mjs";
import { reviewDocument } from "../runtime/paragraph-review.mjs";

const record = (quote, extra = {}) => ({
  kind: "event",
  text: quote,
  quote,
  entities: [],
  storyTime: "未知",
  knownBy: [],
  epistemic: "observed",
  ...extra,
});
const entry = (p, c, records = [record(c.content)]) => ({
  chapterId: c.id,
  part: 0,
  sourceHash: digest(c.content),
  sourceStart: 0,
  sourceEnd: c.content.length,
  sourceText: c.content,
  summary: "原文摘要",
  records,
});
const project = () => ({
  chapters: [
    { id: "c1", number: 1, content: "铜钥匙交给守塔人。" },
    { id: "c2", number: 2, content: "有人说钥匙遗失，尚未核实。" },
  ],
});

test("只读原文的记忆按章复用，前章变动不重抽后章；来源篡改仍失效", async () => {
  const p = project();
  p.memory = { version: 1, entries: p.chapters.map((c) => entry(p, c)) };
  const legacy = p.memory.entries[1];
  p.chapters[0].content = "铜钥匙交给了船长。";
  assert.equal(isCurrent(legacy, p), true);
  let calls = 0;
  const ask = async (_key, messages, validate) => {
    calls++;
    const source = JSON.parse(messages[1].content).sources[0].text;
    return validate({ summary: "摘要", records: [record(source)] });
  };
  const reused = await indexChapter(p, p.chapters[1], ask);
  assert.equal(calls, 0);
  assert.equal(isCurrent(reused[0], p), true);
  assert.deepEqual(reused[0].records, legacy.records);
  await indexChapter(p, p.chapters[0], ask);
  assert.equal(calls, 1);
  const bad = { ...reused[0], sourceText: "假的来源" };
  assert.equal(isCurrent(bad, p), false);
  p.memory.entries = [bad];
  await indexChapter(p, p.chapters[1], ask);
  assert.equal(calls, 2);
});

test("向量命中能跨过旧12片段筛选，并保留近期与明确引用记录", () => {
  const p = {
    characters: [],
    relations: [],
    chapters: Array.from({ length: 30 }, (_, i) => ({
      id: `c${i + 1}`,
      number: i + 1,
      content: i === 0 ? "信封背面藏着一张旧车票。" : "众人照常谈论海面。",
      summary: "整理旧物",
    })),
  };
  const entries = p.chapters
    .slice(0, -1)
    .map((c) =>
      entry(p, c, [
        record(c.content, { entities: c.number === 1 ? [] : ["众人"] }),
      ]),
    );
  const retrieved = {
    sources: [{ chapterId: "c1", text: p.chapters[0].content }],
    coverage: { selected: 1 },
  };
  const fresh = contextFor(
    p,
    p.chapters[29],
    "众人整理旧物，参照第5章",
    entries,
    { retrieved },
  ).context;
  for (const id of ["c1", "c5", "c29"])
    assert.ok(fresh.evidence.some((e) => e.chapterId === id));
  assert.equal(fresh.memorySelection.retrievedRecords, 1);
  assert.equal(fresh.memorySelection.requiredRecords, 2);
});

test("没有命中的空摘要不注入；互相冲突的信念与原文陈述不合并为真相", () => {
  const p = project();
  const records = [
    record("铜钥匙交给守塔人。"),
    record("铜钥匙交给守塔人。", {
      text: "有人相信钥匙从未交出",
      kind: "knowledge",
      epistemic: "belief",
      knownBy: ["甲"],
    }),
  ];
  const selected = selectMemoryRecords({
    entries: [entry(p, p.chapters[0], records), entry(p, p.chapters[1], [])],
    chapters: p.chapters,
    query: "铜钥匙",
    retrieved: { sources: [] },
  });
  assert.equal(selected.evidence.length, 1);
  assert.equal(selected.evidence[0].records.length, 2);
  assert.deepEqual(
    selected.evidence[0].records.map((r) => r.epistemic),
    ["observed", "belief"],
  );
});

function transportFixture() {
  const quote = "铜钥匙🔑码得实实 的。".repeat(35),
    other = "同章另一条线索。".repeat(20);
  const context = {
    instruction: "核对铜钥匙",
    memorySelection: { version: 2 },
    recentText: quote,
    recallSources: [{ chapterId: "c1", content: quote + "\n\n" + other }],
    retrievedSources: [{ chapterId: "c1", text: quote, number: 1 }],
    evidence: [
      {
        chapterId: "c1",
        part: 0,
        summary: "保留知情边界",
        records: [
          record(quote, { text: "钥匙码放在此" }),
          record(other, {
            text: "尚未核实的线索",
            kind: "knowledge",
            knownBy: ["甲"],
            epistemic: "rumor",
          }),
        ],
      },
      {
        chapterId: "c2",
        part: 0,
        summary: "相同字面不同来源",
        records: [record(quote, { text: "另一章的陈述" })],
      },
    ],
    continuity: {
      timeAnchors: [
        {
          chapterId: "c1",
          quote,
          text: "锚点",
          epistemic: "unknown",
          knownBy: [],
        },
      ],
      relatedFacts: [
        {
          chapterId: "c1",
          quote: other,
          text: "事实",
          epistemic: "belief",
          knownBy: ["乙"],
        },
      ],
    },
  };
  return {
    context,
    data: modelWritingContext(context, { recentChapterId: "c1" }),
  };
}

test("共享原文可以逐字还原，保留Unicode、空格、知情边界和章节归属", () => {
  const { data } = transportFixture(),
    before = structuredClone(data);
  const compact = compactWritingMemory(data);
  assert.ok(compact.memoryTransport.sharedQuotes >= 4);
  assert.deepEqual(expandWritingMemory(compact), data);
  assert.deepEqual(data, before);
  const c2 = compact.evidence[1].quoteRefs[0];
  assert.equal(c2.source, "memorySources");
  assert.equal(compact.memorySources[c2.index].chapterId, "c2");
  assert.equal(resolveWritingQuote(compact, c2), data.evidence[1].quotes[0]);
  assert.throws(
    () => resolveWritingQuote(compact, { ...c2, end: 999999 }),
    /越界/,
  );
});

test("完整必需引文复用后能装入预算，审稿原始证据与重试消息保持完整", () => {
  const { context, data } = transportFixture();
  data.evidence = Array.from({ length: 30 }, (_, i) => ({
    ...data.evidence[0],
    part: i,
  }));
  const cfg = {
    provider: "glm",
    model: "glm-5.2",
    limits: { appContextCap: 16000 },
  };
  cfg.limitKey = capabilityKey(cfg);
  const profile = createBudgetProfile(cfg);
  const messages = [
    { role: "system", content: "仅根据提供的原文写作。" },
    { role: "user", content: JSON.stringify(data) },
  ];
  assert.ok(estimatedTokens(messages, profile) > 16000);
  const result = fitWritingContext(messages, 4000, profile);
  assert.ok(result.transport);
  assert.ok(result.inputEstimate + 4000 <= 16000);
  assert.equal(result.coverage.includedRecords, 60);
  const restored = expandWritingMemory(JSON.parse(result.messages[1].content));
  assert.deepEqual(restored.evidence, data.evidence);
  assert.deepEqual(restored.continuity, data.continuity);
  const again = fitWritingContext(
    [
      ...result.messages,
      { role: "assistant", content: "格式有误" },
      { role: "user", content: "重新生成" },
    ],
    4000,
    profile,
  );
  assert.deepEqual(
    expandWritingMemory(JSON.parse(again.messages[1].content)).evidence,
    data.evidence,
  );
  assert.equal(again.messages[2].content, "格式有误");
  const doc = reviewDocument([{ scene: 1, content: "新章正文。" }], context);
  assert.ok(
    doc.sources.some((s) =>
      s.text.includes(context.evidence[0].records[0].quote),
    ),
  );
});

test("引用很短时按实际Token选择内联形式，不为复用增加输入", () => {
  const data = modelWritingContext(
    {
      memorySelection: { version: 2 },
      recentText: "钥匙。",
      evidence: [
        {
          chapterId: "c1",
          part: 0,
          summary: "摘要",
          records: [record("钥匙。")],
        },
      ],
    },
    { recentChapterId: "c1" },
  );
  const result = fitWritingContext(
    [{ role: "user", content: JSON.stringify(data) }],
    4000,
  );
  assert.equal(result.transport, undefined);
  assert.ok(JSON.parse(result.messages[0].content).evidence[0].quotes);
});

test("必需记忆超过通用软额度时，仍为相关历史保留独立空间", () => {
  const context = {
    instruction: "铜钥匙的旧票据",
    memorySelection: { version: 2, optionalBudget: 6000 },
    evidence: [
      ...Array.from({ length: 2 }, (_, part) => ({
        chapterId: "recent",
        part,
        summary: "近期记忆",
        records: Array.from({ length: 16 }, (_, i) =>
          record(
            `记录${part}-${i}。` + "甲逐句记录风向和海面变化。".repeat(40),
            { text: "甲核查灯塔的巡检记录。".repeat(20) },
          ),
        ),
      })),
      {
        chapterId: "old",
        part: 0,
        summary: "旧票据",
        recordReasons: [["retrieved"]],
        records: [
          record("旧票据列明铜钥匙的去向。", { text: "铜钥匙的旧票据" }),
        ],
      },
    ],
  };
  const data = modelWritingContext(context, { recentChapterId: "recent" });
  const messages = [{ role: "user", content: JSON.stringify(data) }];
  assert.ok(estimatedTokens(messages) > 10000);
  const result = fitWritingContext(
    messages,
    4000,
    createBudgetProfile({ provider: "glm", model: "glm-5.2" }),
  );
  const sent = expandWritingMemory(JSON.parse(result.messages[0].content));
  assert.ok(sent.evidence.some((e) => e.chapterId === "old"));
  assert.equal(result.coverage.includedRecords, 33);
});
