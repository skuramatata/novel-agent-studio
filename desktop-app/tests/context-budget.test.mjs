import test from "node:test";
import assert from "node:assert/strict";
import { fitWritingContext } from "../runtime/context-budget.mjs";
import {
  estimatedTokens,
  ensureBudget,
  CONTEXT_LIMIT,
} from "../runtime/model-budget.mjs";
import { modelWritingContext } from "../runtime/memory.mjs";
import { reviewDocument, documentInput } from "../runtime/paragraph-review.mjs";

function fixture() {
  const context = {
    instruction: "继续查铜钥匙",
    chapter: { number: 9, plan: "人物检查铜钥匙和储藏间" },
    evidence: Array.from({ length: 8 }, (_, i) => ({
      chapterId: `chapter-${i}`,
      part: 0,
      summary: `第${i}章摘要`,
      records: Array.from({ length: 16 }, (_, j) => ({
        kind: "event",
        text:
          `第${i}章记录${j}：` +
          "人物检查海面风浪，记下日常所见，仍不知道声音来历。".repeat(4),
        quote:
          `原文${i}-${j}：` +
          "他在塔上观察海面，海风经过门缝，船还没有到。".repeat(6),
        entities: ["人物", "海面"],
        storyTime: `第${i}日`,
        knownBy: ["人物"],
        epistemic: j % 2 ? "belief" : "observed",
      })),
    })),
    recallSources: [],
    recentText: "前章结尾保持原样。",
  };
  context.evidence[0].records[15].entities.push("铜钥匙");
  context.evidence[0].records[15].text =
    "铜钥匙藏在储藏间，人物尚不知道它能开什么。";
  const data = {
    ...modelWritingContext(context, { recentChapterId: "chapter-7" }),
    scene: { goal: "核对铜钥匙", knowledge: "只知道已发现的事实" },
    previousScenes: [{ content: "本章前文不得截断。".repeat(400) }],
    followingScenes: [{ content: "后文保持原样。".repeat(100) }],
    alreadyWritten: "续写前已有正文。".repeat(100),
  };
  return {
    context,
    data,
    messages: [
      { role: "system", content: "按真实原文写作。" },
      { role: "user", content: JSON.stringify(data) },
    ],
  };
}

test("历史增长导致原请求超限时，按场景检索后仍保留最近章节及完整正文", () => {
  const { data, messages } = fixture();
  // 原夹具在旧字符估算法下超限；扩展远章记录以覆盖真实 BPE 超限。
  for (const entry of data.evidence.slice(0, -1))
    entry.records = [...entry.records, ...entry.records, ...entry.records];
  messages[1].content = JSON.stringify(data);
  assert.ok(estimatedTokens(messages) + 6000 > CONTEXT_LIMIT);
  const result = fitWritingContext(messages, 6000),
    selected = JSON.parse(result.messages[1].content);
  assert.ok(estimatedTokens(result.messages) + 6000 <= CONTEXT_LIMIT);
  assert.ok(result.coverage.includedRecords < result.coverage.totalRecords);
  assert.equal(
    selected.evidence.find((e) => e.chapterId === "chapter-7").records.length,
    16,
  );
  assert.ok(
    result.coverage.sources
      .find((e) => e.chapterId === "chapter-0")
      .includedRecords.includes(15),
  );
  for (const field of [
    "previousScenes",
    "followingScenes",
    "alreadyWritten",
    "recentText",
    "scene",
  ])
    assert.deepEqual(selected[field], data[field]);
});

test("入选记录重排后，引文、知情人和陈述性质仍与原记录一一对应", () => {
  const { context, messages } = fixture();
  const before = JSON.stringify(context),
    result = fitWritingContext(messages, 6000);
  const selected = JSON.parse(result.messages[1].content);
  for (const entry of selected.evidence) {
    const original = context.evidence.find(
      (e) => e.chapterId === entry.chapterId,
    );
    const indexes = result.coverage.sources.find(
      (e) => e.chapterId === entry.chapterId,
    ).includedRecords;
    for (const [i, row] of entry.records.entries()) {
      const restored = Object.fromEntries(
        entry.recordColumns.map((key, n) => [key, row[n]]),
      );
      assert.equal(
        entry.quotes[restored.quoteIndex],
        original.records[indexes[i]].quote,
      );
      assert.equal(restored.text, original.records[indexes[i]].text);
      assert.deepEqual(restored.knownBy, original.records[indexes[i]].knownBy);
      assert.equal(restored.epistemic, original.records[indexes[i]].epistemic);
    }
  }
  assert.equal(JSON.stringify(context), before);
  const review = reviewDocument([{ scene: 1, content: "新章正文。" }], context);
  for (const original of context.evidence)
    for (const record of original.records)
      assert.ok(
        review.sources
          .find((s) => s.sourceId === `memory:${original.chapterId}:0`)
          .text.includes(record.quote),
      );
});

test("明确引用的历史全文与记录都保留，真正超限时报告可核查的预算", () => {
  const { data, messages } = fixture();
  data.recallSources = [
    { chapterId: "chapter-0", content: "明确引用的原文。".repeat(30) },
  ];
  messages[1].content = JSON.stringify(data);
  const result = fitWritingContext(messages, 6000),
    selected = JSON.parse(result.messages[1].content);
  assert.deepEqual(selected.recallSources, data.recallSources);
  assert.equal(
    selected.evidence.find((e) => e.chapterId === "chapter-0").records.length,
    16,
  );
  data.recallSources[0].content = "不能丢弃的历史原文。".repeat(4000);
  messages[1].content = JSON.stringify(data);
  assert.throws(
    () => fitWritingContext(messages, 6000),
    (error) =>
      error.code === "CONTEXT_BUDGET" &&
      error.inputEstimate + error.outputBudget > error.limit,
  );
});

test("结构化纠错附带的响应也计入预算，选择结果确定且不修改原消息", () => {
  const { messages } = fixture(),
    before = JSON.stringify(messages);
  const retried = [
    ...messages,
    { role: "assistant", content: "错误响应。".repeat(1500) },
    { role: "user", content: "修正结构化格式" },
  ];
  const result = fitWritingContext(retried, 6000);
  assert.doesNotThrow(() => ensureBudget(result.messages, 6000));
  assert.equal(result.messages[2].content, retried[2].content);
  assert.deepEqual(fitWritingContext(retried, 6000), result);
  assert.equal(JSON.stringify(messages), before);
});

test("审稿和记忆抽取消息不经过写作检索筛选", () => {
  const messages = [
    {
      role: "user",
      content: JSON.stringify({
        document: { sources: [{ text: "全部审稿证据" }] },
      }),
    },
  ];
  assert.equal(fitWritingContext(messages, 6000).messages, messages);
});

test("上下文预算按消息内容估算，不重复计算 HTTP JSON 转义", () => {
  const content = '"\\\n汉';
  assert.equal(estimatedTokens([{ role: "user", content }]), 724);
  assert.equal(
    estimatedTokens([
      { role: "system", content: "a" },
      { role: "user", content: "中" },
    ]),
    803,
  );
  assert.throws(
    () =>
      ensureBudget([{ role: "user", content: "汉字。\n".repeat(20000) }], 6000),
    /预算/,
  );
});

test("记忆传输压缩可无损还原每条记录，保留知情性质和原文空格", () => {
  const record = {
    kind: "knowledge",
    text: "人物只听说物资已到",
    entities: ["the-lighthouse-keeper"],
    storyTime: "未知",
    knownBy: [],
    epistemic: "rumor",
    quote: "码得实实 的。",
  };
  const context = {
    instruction: "继续",
    evidence: [
      {
        chapterId: "c1",
        part: 0,
        summary: "摘要",
        records: [
          record,
          { ...record, text: "仍未亲见", epistemic: "unknown" },
        ],
      },
    ],
  };
  const before = structuredClone(context);
  const packed = modelWritingContext(context).evidence[0];
  assert.equal(packed.quotes.length, 1);
  const restored = packed.records.map((row) => {
    const result = Object.fromEntries(
      packed.recordColumns.map((key, i) => [key, row[i]]),
    );
    result.quote = packed.quotes[result.quoteIndex];
    delete result.quoteIndex;
    return result;
  });
  assert.deepEqual(restored, context.evidence[0].records);
  assert.deepEqual(context, before);
});

test("两章密集记忆加五个场景的写作与整章审稿保留全部材料仍在预算内", () => {
  const evidence = Array.from({ length: 4 }, (_, part) => ({
    chapterId: `c${Math.floor(part / 2) + 1}`,
    part: part % 2,
    summary: "前情摘要".repeat(25),
    records: Array.from({ length: 16 }, (_, index) => ({
      kind: "event",
      text: "守塔人检查库房物资".repeat(4),
      entities: ["the-lighthouse-keeper", "库房"],
      storyTime: "第一天夜间",
      knownBy: ["the-lighthouse-keeper"],
      epistemic: "observed",
      quote: `${index}：` + "他逐一核对物资，关好库房门。".repeat(6),
    })),
  }));
  const context = { evidence, recentText: "风吹过塔门。".repeat(340) };
  const scenes = Array.from({ length: 5 }, (_, i) => ({
    scene: i + 1,
    content: "海风吹过，他再次检查库房。".repeat(85),
  }));
  const writing = {
    ...modelWritingContext(context),
    previousScenes: scenes.slice(0, 4),
    alreadyWritten: scenes[4].content,
  };
  const review = { document: documentInput(reviewDocument(scenes, context)) };
  for (const payload of [writing, review]) {
    assert.doesNotThrow(() =>
      ensureBudget(
        [
          { role: "system", content: "写作与证据规则".repeat(180) },
          { role: "user", content: JSON.stringify(payload) },
        ],
        6500,
      ),
    );
  }
});
