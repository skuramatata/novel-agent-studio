import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewDocument,
  auditContinuity,
  evidenceAt,
} from "../runtime/paragraph-review.mjs";
import { modelContinuity } from "../runtime/review-payload.mjs";
import { assertVisibleReferences } from "../runtime/review-context.mjs";
import {
  parseStructured,
  structuredRetryMessages,
} from "../runtime/structured.mjs";

const doc = reviewDocument(
  [{ scene: 1, content: "风停了。次日他离开。\n\n他仍握着钥匙。" }],
  {},
);
const ref = { sourceId: "scene:1", paragraph: 1, sentence: 2 };

test("时间索引逐字定位本批正文，保留未命中线索且不把摘要或下标转成证据", () => {
  const ledger = {
    timeAnchors: [
      { quote: "次日他离开。\n", text: "他出发了" },
      { quote: "不存在的历史" },
    ],
    relatedFacts: [{ quote: "他仍握着钥匙。" }, { text: "钥匙属于他" }],
  };
  const before = structuredClone(ledger);
  const mapped = modelContinuity(ledger, doc);
  assert.deepEqual(mapped.timeAnchors[0].references, [ref]);
  assert.equal(evidenceAt(doc, ref).quote, ledger.timeAnchors[0].quote.trim());
  assert.equal(mapped.timeAnchors[0].quote, undefined);
  assert.equal(mapped.timeAnchors[1].quote, ledger.timeAnchors[1].quote);
  assert.deepEqual(mapped.timeAnchors[1].references, []);
  assert.deepEqual(mapped.relatedFacts[1].references, []);
  assert.deepEqual(ledger, before);
  const view = {
    ...doc,
    sources: [
      { ...doc.sources[0], paragraphs: doc.sources[0].paragraphs.slice(1) },
    ],
  };
  const bounded = modelContinuity(ledger, view);
  assert.deepEqual(bounded.timeAnchors[0].references, []);
  assert.equal(bounded.relatedFacts[0].references[0].paragraph, 2);
});

test("索引伪地址、被分批排除的段落和无效句号均拒绝并返回可执行的纠错提示", () => {
  assert.throws(
    () =>
      assertVisibleReferences(
        { evidence: [{ sourceId: "timeAnchors", paragraph: 0, sentence: 0 }] },
        doc,
      ),
    /sourceId只能是：scene:1.*不是正文来源/,
  );
  const view = {
    ...doc,
    sources: [
      { ...doc.sources[0], paragraphs: doc.sources[0].paragraphs.slice(1) },
    ],
  };
  assert.throws(
    () => assertVisibleReferences({ evidence: [ref] }, view),
    /本批提供的段号为：2/,
  );
  assert.throws(
    () => assertVisibleReferences({ evidence: [{ ...ref, sentence: 0 }] }, doc),
    /提供的句号为：1、2/,
  );
});

test("闭合JSON外追加字段不能被拼接采纳，纠错保留任务但不把坏响应作为格式范本", () => {
  const raw = '{"issues":[]},"target":{"sourceId":"scene:1","paragraph":1}}';
  let error;
  try {
    parseStructured(raw);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof SyntaxError);
  const messages = [
    { role: "system", content: "审稿" },
    { role: "user", content: "原文与作者裁定" },
  ];
  const retry = structuredRetryMessages(messages, raw, error, 6500);
  assert.deepEqual(retry.slice(0, 2), messages);
  assert.ok(!retry.some((m) => m.content === raw));
  assert.match(
    retry.at(-1).content,
    /不在闭合对象后追加字段.*不要删除问题或证据/,
  );
});

test("专项缺证据指出具体维度，未知日期不能自动变成无依据通过", async () => {
  const value = {
    issues: [],
    continuityChecks: ["time", "state", "evidence"].map((dimension) => ({
      dimension,
      verdict: dimension === "time" ? "insufficient" : "not_applicable",
      evidence: [],
      explanation: "无绝对日期。",
    })),
  };
  await assert.rejects(
    auditContinuity({
      doc,
      context: {},
      ask: async (_k, _m, validate) => validate(value),
    }),
    /continuityChecks.time.*相对时序也可核对/,
  );
  value.continuityChecks[0] = {
    ...value.continuityChecks[0],
    verdict: "consistent",
    evidence: [ref],
    explanation: "原文明确在风停后次日离开。",
  };
  const result = await auditContinuity({
    doc,
    context: { continuity: { timeAnchors: [{ quote: "次日他离开。" }] } },
    ask: async (_k, messages, validate, _output, _label, options) => {
      assert.equal(options.maxCorrections, 2);
      assert.deepEqual(
        JSON.parse(messages[1].content).continuity.timeAnchors[0].references,
        [ref],
      );
      return validate(value);
    },
  });
  assert.equal(result.continuityChecks[0].evidence[0].quote, "次日他离开。");
});

test("同份专项响应的越界引用、证据过量和漏列问题一次性反馈且不放行", async () => {
  await assert.rejects(
    auditContinuity({
      doc,
      context: {},
      ask: async (_key, _messages, validate) =>
        validate({
          issues: [],
          continuityChecks: [
            {
              dimension: "state",
              verdict: "problem",
              evidence: Array.from({ length: 9 }, () => ({
                sourceId: "scene:1",
                paragraph: 99,
              })),
              explanation: "声称存在问题却没有问题条目。",
            },
            ...["time", "evidence"].map((dimension) => ({
              dimension,
              verdict: "not_applicable",
              evidence: [],
              explanation: "样本未涉及。",
            })),
          ],
        }),
    }),
    (error) => {
      assert.match(error.message, /引用不在本次提供的原文范围/);
      assert.match(error.message, /evidence最多8条/);
      assert.match(error.message, /issues 未定位对应段落/);
      return true;
    },
  );
});
