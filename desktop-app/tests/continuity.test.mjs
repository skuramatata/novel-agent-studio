import test from "node:test";
import assert from "node:assert/strict";
import {
  elapsedDays,
  timelineChecks,
  continuityLedger,
  retrieveContinuitySources,
  mergeContinuityReview,
} from "../runtime/continuity.mjs";
import {
  validateExtraction,
  digest,
  contextFor,
  modelWritingContext,
  isCurrent,
} from "../runtime/memory.mjs";
import { fitWritingContext } from "../runtime/context-budget.mjs";
import {
  reviewDocument,
  reviewAndPatch,
  validateFindings,
  auditContinuity,
} from "../runtime/paragraph-review.mjs";
import { repairPlanResponse } from "./fixtures/repair-plan.mjs";

const date = (month, day, year = null, calendar = "gregorian") => ({
  calendar,
  year,
  month,
  day,
  anchor: "",
  since: "",
  elapsedDays: null,
});
const meta = (patch = {}) => ({
  assertion: "narration",
  actor: "成诚",
  action: "到岛",
  object: "",
  before: "",
  after: "岛上",
  evidenceForm: "unknown",
  time: { ...date(3, 12), anchor: "成诚到岛" },
  ...patch,
});
const record = (quote, patch = {}) => ({
  kind: "event",
  text: quote,
  entities: ["成诚"],
  storyTime: "三月十二",
  knownBy: ["成诚"],
  epistemic: "observed",
  quote,
  continuity: meta(),
  ...patch,
});
const chapter = (number, content, summary = "调查遗物") => ({
  id: `ch${number}`,
  number,
  title: `第${number}章`,
  summary,
  content,
});

test("证据不足的肯定推断有独立类别，必须提供材料和结论两处依据", () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content:
          "他拿到的是普通誊抄件。\n\n他凭抄件断定原签名每个顿笔都与自己相同。",
      },
    ],
    {},
  );
  const a = { sourceId: "scene:1", paragraph: 1 },
    b = { sourceId: "scene:1", paragraph: 2 };
  const issue = {
    kind: "unsupported_inference",
    target: b,
    evidence: [a, b],
    searchedSources: ["scene:1"],
    explanation: "普通誊抄材料不能直接支持原笔迹判断。",
    resolution: "remove_unsupported",
    fix: "收回肯定判断，保留手持誊抄件事实",
  };
  const result = validateFindings({ issues: [issue] }, doc);
  assert.equal(result.issues[0].blocking, true);
  assert.equal(result.issues[0].resolution, "remove_unsupported");
  assert.throws(
    () => validateFindings({ issues: [{ ...issue, evidence: [b] }] }, doc),
    /两处/,
  );
  assert.throws(
    () =>
      validateFindings({ issues: [{ ...issue, searchedSources: [] }] }, doc),
    /全部已提供来源/,
  );
});

test("专项已要求裁定的实质疑点不能被普通疑点分类放行，未知信息仍可保留", async () => {
  const doc = reviewDocument(
    [
      {
        scene: 1,
        content: "他拿到一份誊样。\n\n他认定原签名的顿挫与自己完全相同。",
      },
    ],
    {},
  );
  const a = { sourceId: "scene:1", paragraph: 1 };
  const b = { sourceId: "scene:1", paragraph: 2 };
  const issue = {
    kind: "ambiguity",
    target: b,
    evidence: [a, b],
    explanation: "未交代誊样能否保留原笔势，当前肯定判断缺少依据。",
    resolution: "needs_confirmation",
    fix: "裁定材料形态或收回肯定判断。",
  };
  assert.equal(
    validateFindings({ issues: [issue] }, doc).issues[0].blocking,
    false,
  );
  const audit = (verdict, issues = [issue], evidence = [a, b]) =>
    auditContinuity({
      doc,
      context: {},
      ask: async (_k, _m, validate) =>
        validate({
          issues,
          continuityChecks: [
            ...["time", "state"].map((dimension) => ({
              dimension,
              verdict: "not_applicable",
              evidence: [],
              explanation: "未涉及。",
            })),
            {
              dimension: "evidence",
              verdict,
              evidence,
              explanation: "核对材料形态和结论。",
            },
          ],
        }),
    });
  const blocked = await audit("insufficient");
  assert.equal(blocked.issues[0].blocking, true);
  assert.equal(blocked.issues[0].resolution, "needs_confirmation");
  assert.equal((await audit("consistent")).issues[0].blocking, false);
  assert.equal(
    (await audit("insufficient", [issue], [a])).issues[0].blocking,
    false,
  );
  assert.equal(
    (await audit("insufficient", [{ ...issue, resolution: "suggestion" }]))
      .issues[0].blocking,
    false,
  );
  assert.deepEqual((await audit("insufficient", [])).issues, []);
});

test("两轮审稿合并不会静默截掉第17项之后的问题", () => {
  const make = (start) =>
    Array.from({ length: 16 }, (_, i) => ({
      kind: "contradiction",
      target: { sourceId: "scene:1", paragraph: i + start },
      evidence: [{ quote: `证据${i + start}` }],
      blocking: true,
    }));
  const merged = mergeContinuityReview(
    { issues: make(1) },
    { issues: make(17) },
  );
  assert.equal(merged.issues.length, 32);
  assert.equal(new Set(merged.issues.map((i) => i.id)).size, 32);
});

test("专项三项检查不得漏项，查出问题却给空issues不能通过", async () => {
  const doc = reviewDocument([{ scene: 1, content: "三月十二到岗。" }], {});
  const ref = { sourceId: "scene:1", paragraph: 1 };
  const context = { continuity: continuityLedger([]) };
  await assert.rejects(() =>
    auditContinuity({
      doc,
      context,
      ask: async (_k, _m, validate) => validate({ issues: [] }),
    }),
  );
  await assert.rejects(
    () =>
      auditContinuity({
        doc,
        context,
        ask: async (_k, _m, validate) =>
          validate({
            issues: [],
            continuityChecks: [
              {
                dimension: "time",
                verdict: "problem",
                evidence: [ref],
                explanation: "时间冲突",
              },
              ...["state", "evidence"].map((dimension) => ({
                dimension,
                verdict: "not_applicable",
                evidence: [],
                explanation: "无此项",
              })),
            ],
          }),
      }),
    /issues/,
  );
});

test("日期算术支持明确间隔和闰年，不猜农历、跨年和模糊日期", () => {
  assert.equal(elapsedDays(date(3, 12), date(4, 15)), 34);
  assert.equal(elapsedDays(date(3, 12), date(5, 11)), 60);
  assert.equal(elapsedDays(date(2, 28, 2024), date(3, 1, 2024)), 2);
  assert.equal(elapsedDays(date(2, 28, 2025), date(3, 1, 2025)), 1);
  assert.equal(elapsedDays(date(12, 31, 2025), date(1, 1, 2026)), 1);
  assert.equal(elapsedDays(date(12, 31), date(1, 1)), null);
  assert.equal(elapsedDays(date(2, 28), date(3, 1)), null);
  assert.equal(elapsedDays(date(2, 30, 2026), date(3, 1, 2026)), null);
  assert.equal(elapsedDays(date(3, 12, null, "lunar"), date(4, 15)), null);
  assert.equal(elapsedDays(date(3, 12, null, "unknown"), date(4, 15)), null);
});

test("经过时间核对保留两处依据，不把文件记载当亲历或擅选冲突锚点", () => {
  const anchor = record("三月十二日，成诚到岛。");
  const current = record("五月十一日，他到岛已经九十天了。", {
    continuity: meta({
      time: {
        ...date(5, 11),
        anchor: "候船",
        since: "成诚到岛",
        elapsedDays: 90,
      },
    }),
  });
  const [check] = timelineChecks([anchor, current]);
  assert.equal(check.actualDays, 60);
  assert.equal(check.statedDays, 90);
  assert.equal(check.mismatch, true);
  assert.deepEqual(check.evidence, [anchor.quote, current.quote]);
  assert.deepEqual(
    timelineChecks([
      { ...anchor, continuity: meta({ assertion: "document" }) },
      current,
    ]),
    [],
  );
  assert.deepEqual(
    timelineChecks([
      anchor,
      {
        ...anchor,
        continuity: meta({ time: { ...date(3, 9), anchor: "成诚到岛" } }),
      },
      current,
    ]),
    [],
  );
});

test("结构化记忆保留行动主体和证据形态，缺失元数据不能冒充新版索引", () => {
  const text = "成诚把老葛的棉袄搬到底层储物间，放在架子底层。";
  const r = {
    ...record(text),
    sourceId: 1,
    continuity: meta({
      action: "搬放",
      object: "棉袄",
      before: "二层",
      after: "储物间架子底层",
      time: null,
    }),
  };
  const value = validateExtraction(
    { summary: "搬放遗物", records: [r] },
    text,
    { continuity: true },
  );
  assert.equal(value.records[0].continuity.actor, "成诚");
  assert.equal(value.records[0].quote, text);
  assert.throws(
    () =>
      validateExtraction(
        { summary: "旧摘要", records: [{ ...r, continuity: undefined }] },
        text,
        { continuity: true },
      ),
    /continuity/,
  );
  const copy = {
    ...r,
    continuity: meta({
      assertion: "document",
      evidenceForm: "transcript",
      action: "记载",
      object: "签收单",
    }),
  };
  assert.equal(
    validateExtraction({ summary: "抄件", records: [copy] }, text).records[0]
      .continuity.assertion,
    "document",
  );
});

test("跨章回查不依赖记忆命中，找回搬放者、首次日期及邻段并排除未来章节", () => {
  const old = chapter(
    1,
    "三月十二日，到岗。\n\n成诚把老葛的棉袄搬到底层储物间。\n\n他把鞋和老花镜也放到架子底层。",
  );
  const middle = Array.from({ length: 20 }, (_, i) =>
    chapter(i + 2, `成诚去海边看风景${i}。\n\n海水一片灰。`),
  );
  const future = chapter(23, "未来秘密不允许检索。");
  const result = retrieveContinuitySources(
    [old, ...middle, future],
    22,
    "老葛把棉袄和鞋码在架子底层，正好遮住墙洞。到岗半年，他终于发现。",
  );
  const found = result.sources.map((s) => s.text).join("\n");
  assert.match(found, /三月十二日，到岗/);
  assert.match(found, /成诚把老葛的棉袄搬/);
  assert.match(found, /鞋和老花镜/);
  assert.doesNotMatch(found, /未来秘密/);
  assert.equal(result.coverage.scannedChapters.length, 21);
  assert.ok(result.coverage.suppliedChars <= 20000);
  assert.ok(result.coverage.suppliedParagraphs <= 100);
  const changed = retrieveContinuitySources(
    [{ ...old, content: old.content.replace("十二", "十一") }, ...middle],
    22,
    "棉袄",
  );
  assert.notEqual(
    changed.coverage.sourceFingerprint,
    result.coverage.sourceFingerprint,
  );
});

test("时间锚点不随普通记忆裁剪丢失，修订前章后派生记录失效且不泄漏真相", () => {
  const c1 = chapter(1, "三月十二日，到岗。"),
    c2 = chapter(2, "海上无事。"),
    c3 = chapter(3, "");
  const p = {
    chapters: [c1, c2, c3],
    characters: [],
    relations: [],
    premise: {},
    author: {},
    plan: { truth: "隐藏谜底", timeline: "未公开的真相日期" },
  };
  const entry = {
    chapterId: c1.id,
    part: 0,
    summary: "到岗",
    sourceHash: digest(c1.content),
    sourceStart: 0,
    sourceEnd: c1.content.length,
    sourceText: c1.content,
    records: [record(c1.content)],
  };
  const { context } = contextFor(p, c3, "观察天气", [entry], {
    continuity: true,
  });
  assert.equal(context.evidence.length, 0);
  assert.equal(context.continuity.timeAnchors[0].quote, c1.content);
  const messages = [
    { role: "user", content: JSON.stringify(modelWritingContext(context)) },
  ];
  const selected = JSON.parse(
    fitWritingContext(messages, 4000).messages[0].content,
  );
  assert.deepEqual(selected.continuity, context.continuity);
  assert.doesNotMatch(JSON.stringify(selected), /隐藏谜底|未公开的真相日期/);
  p.chapters[0] = { ...c1, content: "三月十一日，到岗。" };
  assert.equal(isCurrent(entry, p), false);
  assert.equal(
    contextFor(p, c3, "观察天气", [entry], { continuity: true }).context
      .continuity.timeAnchors.length,
    0,
  );
});

test("专项审稿发现的问题不能被综合审稿空结果覆盖，补丁后重新抽取并核对", async () => {
  const original = "日志首页写着：三月初九，接塔。\n\n这一段保持不变。";
  const history = "三月十二日，到岗。";
  const context = {
    instruction: "审稿",
    continuity: continuityLedger([]),
    continuitySources: [
      { sourceId: "continuity:ch1", label: "第一章", text: history },
    ],
  };
  const state = {
    id: "continuity-flow",
    values: { "final-scene:0": original },
    status: "running",
  };
  const extracted = [],
    stages = [];
  const ref = { sourceId: "scene:1", paragraph: 1 };
  const preserve = { sourceId: "continuity:ch1", paragraph: 1 };
  const ask = async (_key, messages, validate, _tokens, label) => {
    stages.push(label);
    const sys = messages[0].content,
      data = JSON.parse(messages[1].content);
    const docText = JSON.stringify(data.document);
    if (sys.includes("本轮只执行时间"))
      return validate({
        continuityChecks: [
          {
            dimension: "time",
            verdict: docText.includes("初九") ? "problem" : "consistent",
            evidence: [ref],
            explanation: "核对日志首页日期",
          },
          ...["state", "evidence"].map((dimension) => ({
            dimension,
            verdict: "not_applicable",
            evidence: [],
            explanation: "本样本只涉及日期",
          })),
        ],
        issues: docText.includes("初九")
          ? [
              {
                kind: "contradiction",
                target: ref,
                evidence: [ref, preserve],
                preserve: [preserve],
                explanation: "同一本日志首页日期前后不同，无人物察觉。",
                resolution: "preserve_evidence",
                fix: "保留三月十二到岗日期",
              },
            ]
          : [],
      });
    if (sys.includes("小说连续性与文学审稿员")) return validate({ issues: [] });
    if (sys.includes("独立修订依据核对员"))
      return validate(repairPlanResponse(data));
    if (sys.includes("小说段落修订编辑"))
      return validate({
        baseVersion: data.document.version,
        replacements: [
          {
            ...ref,
            issueIds: data.issues.map((i) => i.id),
            replacement: "日志首页写着：三月十二日，到岗。",
          },
        ],
      });
    if (sys.includes("独立补丁复核员"))
      return validate({
        checks: data.issues.map((i) => ({
          issueId: i.id,
          resolved: true,
          preservedFacts: true,
          noUnsupportedAdditions: true,
          downstreamConsistent: true,
          evidence: [ref],
          explanation: "已统一且第二段保持原状",
        })),
      });
    throw Error(`意外阶段：${label}`);
  };
  const result = await reviewAndPatch({
    scenes: [{ scene: 1, content: original }],
    context,
    state,
    ask,
    save: async () => {},
    signal: new AbortController().signal,
    prepareContinuity: async (scenes) => {
      extracted.push(scenes[0].content);
      return continuityLedger([]);
    },
  });
  assert.equal(
    result.scenes[0].content,
    "日志首页写着：三月十二日，到岗。\n\n这一段保持不变。",
  );
  assert.equal(result.commits.length, 1);
  assert.equal(extracted.length, 2);
  assert.match(extracted[0], /初九/);
  assert.doesNotMatch(extracted[1], /初九/);
  assert.equal(stages.filter((s) => s === "时间与事实专项审稿").length, 2);
  assert.equal(
    reviewDocument(result.scenes, context).sources.find(
      (s) => s.sourceId === preserve.sourceId,
    ).editable,
    false,
  );
});
