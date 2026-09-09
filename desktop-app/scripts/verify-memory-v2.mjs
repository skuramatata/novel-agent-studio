// 独立作品副本：真实本地Embedding、记忆召回与传输测量；--live只验证引用协议。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  StoryVectorIndex,
  localEmbedder,
} from "../runtime/story-retrieval.mjs";
import {
  contextFor,
  modelWritingContext,
  indexChapter,
  isCurrent,
} from "../runtime/memory.mjs";
import {
  expandWritingMemory,
  resolveWritingQuote,
} from "../runtime/memory-transport.mjs";
import { fitWritingContext } from "../runtime/context-budget.mjs";
import {
  estimatedTokens,
  createBudgetProfile,
} from "../runtime/model-budget.mjs";
import { complete, readAuthorizedEnv } from "../runtime/providers.mjs";
import {
  parseStructured,
  structuredRetryMessages,
} from "../runtime/structured.mjs";

const file = resolve(
  process.argv.slice(2).find((a) => !a.startsWith("--")) ||
    "verification/context-memory-v3/project.before.json",
);
const raw = await readFile(file, "utf8"),
  p = JSON.parse(raw);
const out = resolve("verification/memory-v2");
await mkdir(out, { recursive: true });
const config = {
  provider: "glm",
  model: "glm-5.2",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
};
const profile = createBudgetProfile(config);
const index = new StoryVectorIndex(
  join(out, "index"),
  localEmbedder(resolve("models")),
);
try {
  const stats = await index.sync(p, { progress: console.log });
  const target = p.chapters.filter((c) => c.content).at(-1);
  const instruction = `核对第${target.number}章钥匙保管、送鱼周期、到任时间和此前行动，参照第1章原文。`;
  const retrieved = await index.search(
    p,
    target.number,
    instruction + target.summary,
    { profile },
  );
  const { context, manifest } = contextFor(
    p,
    target,
    instruction,
    p.memory.entries,
    { continuity: true, profile, retrieved },
  );
  const data = modelWritingContext(context, {
    recentChapterId: p.chapters.filter((c) => c.number < target.number).at(-1)
      .id,
  });
  const messages = [
    {
      role: "system",
      content: "按已提供记忆规划场景，保留知情范围与原文陈述性质。",
    },
    { role: "user", content: JSON.stringify(data) },
  ];
  const fitted = fitWritingContext(messages, 6500, profile);
  const sent = JSON.parse(fitted.messages[1].content),
    expanded = expandWritingMemory(sent);
  assert.deepEqual(expanded.recallSources, data.recallSources);
  assert.deepEqual(expanded.retrievedSources, data.retrievedSources);
  assert.deepEqual(expanded.continuity, data.continuity);
  assert.equal(expanded.recentText, data.recentText);
  for (const e of expanded.evidence)
    for (const quote of e.quotes)
      assert.ok(
        p.chapters.find((c) => c.id === e.chapterId).content.includes(quote),
      );
  const changed = structuredClone(p);
  changed.chapters[0].content += "\n\n测试变更：海风拂过门口。";
  let calls = 0,
    reusedEntries = 0;
  for (const c of changed.chapters.slice(1)) {
    const original = p.memory.entries.filter((e) => e.chapterId === c.id);
    if (!original.length || original.some((e) => !isCurrent(e, p))) continue;
    const entries = await indexChapter(changed, c, async () => {
      calls++;
      throw Error("未改动章节不应重新抽取");
    });
    reusedEntries += entries.length;
  }
  assert.equal(calls, 0);
  assert.ok(reusedEntries > 0);
  let live = null;
  if (process.argv.includes("--live")) {
    assert.equal(sent.memoryTransport?.version, 2, "实测应覆盖共享原文协议");
    const entryIndex = expanded.evidence.findIndex((e) => e.records.length),
      recordIndex = 0;
    const entry = expanded.evidence[entryIndex],
      row = entry.records[recordIndex];
    const record = Object.fromEntries(
      entry.recordColumns.map((key, i) => [key, row[i]]),
    );
    const expected = {
      chapterId: entry.chapterId,
      quoteRef: sent.evidence[entryIndex].quoteRefs[record.quoteIndex],
      epistemic: record.epistemic,
      knownBy: record.knownBy,
    };
    const auth = (await readAuthorizedEnv()).glm;
    let probeMessages = [
      {
        role: "system",
        content:
          "只核对传输中的记忆引用，不写小说。按recordColumns解码指定记录，再按quoteIndex从该条目的quoteRefs取出引用对象。只输出一个合法JSON对象：{chapterId,quoteRef,epistemic,knownBy}，禁止Markdown和额外说明。quoteRef须保持source/index/start/end，不要抄写正文；原文由程序按引用回填。不把信念或传闻变为已证实事实。",
      },
      {
        role: "user",
        content: JSON.stringify({
          ...sent,
          targetRecord: { entryIndex, recordIndex },
        }),
      },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await complete(
        auth,
        probeMessages,
        AbortSignal.timeout(120000),
        fetch,
        6500,
      );
      await writeFile(
        join(out, `live-transport-${attempt}.json`),
        JSON.stringify(response, null, 2),
      );
      try {
        const returned = parseStructured(response.text);
        assert.deepEqual(returned, expected);
        assert.equal(
          resolveWritingQuote(sent, returned.quoteRef),
          entry.quotes[record.quoteIndex],
        );
        live = {
          status: "validated",
          attempts: attempt + 1,
          usage: response.usage,
          responseModel: response.model,
          scope:
            "一条记忆的引用对象、陈述性质与知情范围回取；程序逐字回填原文，非文学质量评估",
        };
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        probeMessages = structuredRetryMessages(
          probeMessages,
          response.text,
          error,
          6500,
          profile,
        );
      }
    }
  }
  assert.equal(await readFile(file, "utf8"), raw);
  const report = {
    status: "passed",
    index: stats,
    retrieval: retrieved.coverage,
    memorySelection: context.memorySelection,
    manifest,
    beforeSelectionEstimate: estimatedTokens(messages, profile),
    afterSelectionEstimate: fitted.inputEstimate,
    sameRecordsTransport: fitted.transport || null,
    finalCoverage: fitted.coverage,
    incremental: {
      changedChapter: 1,
      reusedEntries,
      extraExtractionCalls: calls,
    },
    live,
  };
  await writeFile(
    join(out, "memory-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      { ...report, manifest: undefined, finalCoverage: undefined },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  index.close();
}
