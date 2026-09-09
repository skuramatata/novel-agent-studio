import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewDocument,
  documentInput,
  evidenceAt,
} from "../runtime/paragraph-review.mjs";
import {
  modelFindings,
  modelAuthorHistory,
  modelDocument,
} from "../runtime/review-payload.mjs";
import { ensureBudget } from "../runtime/memory.mjs";
test("作者处理后只传引用地址，不重复发送原文、选项及历史快照", () => {
  const content = "海风吹过，人物仍在核查旧账。".repeat(400),
    doc = reviewDocument([{ scene: 1, content }], {});
  const ref = {
    sourceId: "scene:1",
    paragraph: 1,
    quote: content,
    sourceHash: "hash",
  };
  const issue = {
    id: "i",
    kind: "missing_history",
    target: ref,
    evidence: [ref],
    preserve: [ref],
    allowedTargets: [ref],
    resolution: "preserve_evidence",
    explanation: "需处理",
    fix: "遵循选择",
    authorInstruction: "保留原文",
    options: [{ preserve: [ref] }],
  };
  const issues = modelFindings([issue]);
  assert.equal(issues[0].target.quote, undefined);
  assert.equal(issues[0].options, undefined);
  const history = modelAuthorHistory([{ issues: [issue], choices: [] }]);
  assert.equal(history[0].instruction, "保留原文");
  assert.equal(history[0].preserve[0].quote, undefined);
  const document = documentInput(doc);
  assert.equal(document.sources[0].paragraphs[0].slice(1).join(""), content);
  assert.doesNotThrow(() =>
    ensureBudget(
      [
        {
          role: "user",
          content: JSON.stringify({
            document,
            issues,
            authorDecisions: history,
          }),
        },
      ],
      5000,
    ),
  );
});

test("审稿显式编号可逐句回填原文，越界错误包含实际句数且不改变原文版本", () => {
  const doc = reviewDocument(
    [{ scene: 1, content: "他说：“你来了？”她点头。\n\n灯灭了。门仍关着。" }],
    {},
  );
  const before = structuredClone(doc);
  const encoded = modelDocument(doc, { explicitSentences: true });
  assert.equal(encoded.version, doc.version);
  for (const source of encoded.sources)
    for (const [paragraph, ...sentences] of source.paragraphs)
      for (const [sentence, quote] of sentences)
        assert.equal(
          evidenceAt(doc, { sourceId: source.sourceId, paragraph, sentence })
            .quote,
          quote,
        );
  assert.throws(
    () => evidenceAt(doc, { sourceId: "scene:1", paragraph: 2, sentence: 8 }),
    /该段只有2句.*不能直接删除sentence/,
  );
  assert.deepEqual(doc, before);
});

test("紧凑审稿文档逐句保留原文和编号，不改变证据地址或版本", () => {
  const text = Array.from(
    { length: 40 },
    (_, i) => `第${i}项记录。他说“并不知道”。下一句有英文 abc 和数字 123。`,
  ).join("\n\n");
  const source = reviewDocument([{ scene: 1, content: text }], {
    recentText: "前章句一。前章句二。",
  });
  const encoded = documentInput(source);
  assert.deepEqual(encoded, modelDocument(source));
  assert.equal(encoded.version, source.version);
  for (const original of source.sources) {
    const next = encoded.sources.find((s) => s.sourceId === original.sourceId);
    assert.equal(next.paragraphs.length, original.paragraphs.length);
    for (const paragraph of original.paragraphs) {
      const row = next.paragraphs.find((p) => p[0] === paragraph.paragraph);
      for (const sentence of paragraph.sentences)
        assert.equal(row[sentence.sentence], sentence.text);
    }
  }
});
