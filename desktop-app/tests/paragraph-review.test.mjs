import { repairPlanResponse } from "./fixtures/repair-plan.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewDocument,
  validateFindings,
  applyParagraphPatch,
  reviewAndPatch,
} from "../runtime/paragraph-review.mjs";
import { Checkpoint, WORKFLOW_VERSION } from "../runtime/checkpoint.mjs";
import { blankProject } from "../runtime/seed.mjs";
const scenes = [
  {
    scene: 1,
    content: "开头不动。\n\n纸页一直干燥。两页同时湿透。\n \n结尾不动。",
  },
];
const ref = (paragraph, sentence) => ({
  sourceId: "scene:1",
  paragraph,
  ...(sentence ? { sentence } : {}),
});
const finding = {
  kind: "contradiction",
  target: ref(2),
  evidence: [ref(2, 1), ref(2, 2)],
  explanation: "同一时刻纸页干湿冲突",
  resolution: "preserve_evidence",
  preserve: [ref(2, 1)],
  fix: "保留干燥事实",
};
const doc = reviewDocument(scenes, {});
const issues = validateFindings({ issues: [finding] }, doc).issues;
const patch = (d = doc, ids = issues) => ({
  baseVersion: d.version,
  replacements: [
    {
      sourceId: "scene:1",
      paragraph: 2,
      issueIds: ids.map((i) => i.id),
      replacement: "纸页一直干燥。她继续观察。",
    },
  ],
});

test("同段矛盾必须有两处证据，引用原文由程序回填", () => {
  assert.equal(issues[0].evidence[0].quote, "纸页一直干燥。");
  assert.throws(
    () =>
      validateFindings(
        { issues: [{ ...finding, evidence: [ref(2), ref(2, 1)] }] },
        doc,
      ),
    /两处不同/,
  );
  assert.throws(
    () =>
      validateFindings(
        { issues: [{ ...finding, evidence: [ref(2, 1), ref(2, 1)] }] },
        doc,
      ),
    /两处不同/,
  );
  assert.throws(
    () =>
      validateFindings(
        { issues: [{ ...finding, evidence: [ref(2, 1), ref(2, 99)] }] },
        doc,
      ),
    /无法定位/,
  );
  assert.equal(
    validateFindings({ issues: [{ ...finding, preserve: [] }] }, doc).issues[0]
      .resolution,
    "needs_confirmation",
  );
});
test("矛盾删除标签有保留依据时规范为据实修订，无依据时进入裁定", () => {
  const value = { ...finding, resolution: "remove_unsupported" };
  const resolved = validateFindings({ issues: [value] }, doc).issues[0];
  assert.equal(resolved.resolution, "preserve_evidence");
  assert.equal(resolved.preserve[0].quote, "纸页一直干燥。");
  assert.equal(resolved.blocking, true);
  const uncertain = validateFindings(
    { issues: [{ ...value, preserve: [] }] },
    doc,
  ).issues[0];
  assert.equal(uncertain.resolution, "needs_confirmation");
  assert.equal(uncertain.blocking, true);
  assert.throws(
    () =>
      validateFindings({ issues: [{ ...value, preserve: [ref(99)] }] }, doc),
    /无法定位/,
  );
});
test("检索范围有限时不得断言全书缺少前情，指代疑点不阻塞", () => {
  const value = {
    ...finding,
    kind: "missing_history",
    resolution: "remove_unsupported",
    preserve: [],
  };
  assert.deepEqual(
    validateFindings({ issues: [value] }, doc).suppliedScope.sources.map(
      (s) => s.sourceId,
    ),
    doc.sources.map((s) => s.sourceId),
  );
  assert.equal(
    validateFindings(
      { issues: [{ ...value, searchedSources: ["scene:1"] }] },
      doc,
    ).issues[0].blocking,
    true,
  );
  assert.equal(
    validateFindings({ issues: [{ ...finding, kind: "ambiguity" }] }, doc)
      .issues[0].blocking,
    false,
  );
});
test("段落补丁保留其他正文和分隔符，不允许跨版本、跨段或整场替换", () => {
  const result = applyParagraphPatch(scenes, doc, issues, patch());
  assert.equal(
    result.scenes[0].content,
    "开头不动。\n\n纸页一直干燥。她继续观察。\n \n结尾不动。",
  );
  assert.throws(
    () =>
      applyParagraphPatch(scenes, doc, issues, {
        ...patch(),
        baseVersion: "old",
      }),
    /版本/,
  );
  const p = patch();
  p.replacements[0].paragraph = 1;
  assert.throws(() => applyParagraphPatch(scenes, doc, issues, p), /超出/);
  p.replacements[0].paragraph = 2;
  p.replacements[0].replacement = "整场\n\n新段";
  assert.throws(() => applyParagraphPatch(scenes, doc, issues, p), /扩大/);
  assert.throws(
    () =>
      applyParagraphPatch(
        [{ scene: 1, content: "已编辑" }],
        doc,
        issues,
        patch(),
      ),
    /原文已改变/,
  );
});
function harness({
  bad = false,
  uncertain = false,
  failAfter = false,
  cancel = false,
  reviewFinding = finding,
  unsafeDecision = false,
} = {}) {
  const state = { values: { "final-scene:0": scenes[0].content } };
  const controller = new AbortController();
  let patches = 0,
    reviews = 0,
    saved;
  const ask = async (key, messages, validate) => {
    const data = JSON.parse(messages[1].content);
    if (key.includes(":grounding:")) return validate(repairPlanResponse(data));
    if (key.startsWith("arbitrate-v1:"))
      return validate({
        decisions: data.issues.map((i) => ({
          issueId: i.id,
          action: unsafeDecision ? "remove_unsupported" : "needs_confirmation",
          evidenceIndexes: [],
          reason: "两种说法仍无法判断",
        })),
      });
    if (key.includes(":review:")) {
      reviews++;
      if (failAfter && reviews === 2) throw Error("断网");
      return validate({
        issues:
          reviews === 1
            ? [
                {
                  ...reviewFinding,
                  ...(uncertain ? { resolution: "needs_confirmation" } : {}),
                },
              ]
            : [],
      });
    }
    if (key.includes(":verify:")) {
      if (cancel) controller.abort();
      return validate({
        checks: data.issues.map((i) => ({
          issueId: i.id,
          resolved: true,
          preservedFacts: true,
          noUnsupportedAdditions: !bad,
          downstreamConsistent: true,
          evidence: [ref(2)],
          explanation: bad ? "补造行动" : "已核对",
        })),
      });
    }
    patches++;
    assert.equal(data.document.sources[0].paragraphs[1][2], "两页同时湿透。");
    return validate(patch(data.document, data.issues));
  };
  const run = () =>
    reviewAndPatch({
      scenes: [{ scene: 1, content: state.values["final-scene:0"] }],
      context: {},
      state,
      ask,
      signal: controller.signal,
      save: async () => {
        saved = structuredClone(state);
      },
    });
  return {
    state,
    run,
    get patches() {
      return patches;
    },
    get saved() {
      return saved;
    },
  };
}
test("错误删除标签经过规范、补丁和独立复核后完成，不丢弃保留事实", async () => {
  const h = harness({
    reviewFinding: { ...finding, resolution: "remove_unsupported" },
  });
  const result = await h.run();
  assert.equal(h.patches, 1);
  assert.equal(result.commits.length, 1);
  assert.match(result.scenes[0].content, /纸页一直干燥/);
  assert.doesNotMatch(result.scenes[0].content, /两页同时湿透/);
});
test("错误删除标签没有保留依据且无法裁定时生成可回答问题，不直接删除", async () => {
  const h = harness({
    reviewFinding: {
      ...finding,
      resolution: "remove_unsupported",
      preserve: [],
    },
  });
  await assert.rejects(h.run, /创作选择/);
  assert.equal(h.patches, 0);
  assert.equal(h.saved.status, "awaiting_input");
  assert.equal(h.saved.error, "");
  assert.ok(h.saved.pendingReview.issues[0].options.length);
  assert.ok(h.saved.reviewConversation[0].text.includes("需要你确认"));
});
test("两次补丁均被复核否决时保留原稿，重试基于原文", async () => {
  const h = harness({ bad: true });
  await assert.rejects(h.run, { name: "ReviewRetryableError" });
  assert.equal(h.state.pendingReview, undefined);
  assert.equal(h.state.reviewWorkflow.failure.kind, "repair_limit");
  assert.equal(h.patches, 2);
  assert.equal(h.state.values["final-scene:0"], scenes[0].content);
  assert.equal(h.saved.paragraphReview.commits.length, 0);
});
test("事实无法裁决时保留待确认项，不调用修订", async () => {
  const h = harness({ uncertain: true });
  await assert.rejects(h.run, /创作选择/);
  assert.equal(h.patches, 0);
  assert.equal(h.state.values["final-scene:0"], scenes[0].content);
});
test("补丁提交后审稿断网，恢复不重复修订", async () => {
  const h = harness({ failAfter: true });
  await assert.rejects(h.run, /断网/);
  assert.equal(h.saved.paragraphReview.commits.length, 1);
  const result = await h.run();
  assert.equal(h.patches, 1);
  assert.equal(result.commits.length, 1);
  assert.match(result.scenes[0].content, /她继续观察/);
});
test("复核阶段取消不会提交补丁", async () => {
  const h = harness({ cancel: true });
  await assert.rejects(h.run);
  assert.equal(h.state.paragraphReview.commits.length, 0);
  assert.equal(h.state.values["final-scene:0"], scenes[0].content);
});
test("旧流程恢复保留场景并归档，旧审稿缓存不进入新流程", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novel-patch-migrate-"));
  try {
    const cp = new Checkpoint(directory),
      p = blankProject(),
      config = { provider: "glm", model: "test", baseUrl: "test" };
    const old = await cp.begin(p, { instruction: "测试" }, config);
    old.version = "chapter-memory-1";
    old.values = {
      "review:0": {
        issues: [
          { scene: 1, paragraph: 1, quote: "保留正文", fix: "需要重审的说法" },
        ],
      },
      "final-scene:0": "保留正文",
    };
    await cp.write(old);
    const next = await cp.begin(p, { resume: true }, config);
    assert.equal(next.version, WORKFLOW_VERSION);
    assert.equal(next.values["final-scene:0"], "保留正文");
    assert.equal(next.values["review:0"], undefined);
    assert.equal(next.priorReviewHints[0].quote, "保留正文");
    const archive = JSON.parse(
      await readFile(
        join(directory, "task-history", old.id + "-before-evidence-patch.json"),
        "utf8",
      ),
    );
    assert.equal(archive.version, "chapter-memory-1");
    assert.ok(archive.values["review:0"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("旧问题必须逐项复核，不能用空问题列表掩盖遗漏", () => {
  const hints = [
    {
      id: "old-1",
      sourceId: "scene:1",
      paragraph: 2,
      quote: scenes[0].content,
      claim: "旧意见可能错误",
    },
  ];
  assert.throws(() => validateFindings({ issues: [] }, doc, hints), /逐项复核/);
  const disposition = {
    id: "old-1",
    decision: "confirmed",
    evidence: [ref(2, 1), ref(2, 2)],
    explanation: "原文中仍然存在干湿冲突",
  };
  assert.throws(
    () =>
      validateFindings(
        { issues: [], priorFindings: [disposition] },
        doc,
        hints,
      ),
    /新证据结论/,
  );
  const result = validateFindings(
    { issues: [finding], priorFindings: [disposition] },
    doc,
    hints,
  );
  assert.equal(result.priorFindings[0].evidence[0].quote, "纸页一直干燥。");
  const dismissed = validateFindings(
    {
      issues: [],
      priorFindings: [
        {
          ...disposition,
          decision: "dismissed",
          explanation: "原意见依据不成立",
        },
      ],
    },
    doc,
    hints,
  );
  assert.equal(dismissed.issues.length, 0);
});

test("后文复核失败后按证据扩展最小范围，修订与复核能收敛", async () => {
  const initial = [
    { scene: 1, content: "上回十五日，隔六天。" },
    { scene: 2, content: "它隔六天来一次。" },
  ];
  const state = {
    values: Object.fromEntries(
      initial.map((s, i) => [`final-scene:${i}`, s.content]),
    ),
  };
  let reviews = 0,
    patches = 0,
    verifications = 0;
  const result = await reviewAndPatch({
    scenes: initial,
    context: { recentText: "上回十五日，今日廿二日。" },
    state,
    signal: new AbortController().signal,
    save: async () => {},
    ask: async (key, messages, validate) => {
      const data = JSON.parse(messages[1].content);
      if (key.includes(":grounding:")) {
        if (data.previousFailure?.checks)
          data.issues[0].allowedTargets = [
            { sourceId: "scene:2", paragraph: 1 },
          ];
        return validate(repairPlanResponse(data));
      }
      if (key.includes(":review:"))
        return validate({
          issues:
            ++reviews === 1
              ? [
                  {
                    kind: "contradiction",
                    target: { sourceId: "scene:1", paragraph: 1 },
                    evidence: [
                      { sourceId: "scene:1", paragraph: 1 },
                      { sourceId: "recent", paragraph: 1 },
                    ],
                    preserve: [{ sourceId: "recent", paragraph: 1 }],
                    resolution: "preserve_evidence",
                    explanation: "十五至廿二应为七天",
                    fix: "改为七天并同步后文",
                  },
                ]
              : [],
        });
      if (key.includes(":verify:")) {
        verifications++;
        return validate({
          checks: data.issues.map((i) => ({
            issueId: i.id,
            resolved: true,
            preservedFacts: true,
            noUnsupportedAdditions: true,
            downstreamConsistent: verifications > 1,
            evidence: [{ sourceId: "scene:2", paragraph: 1 }],
            explanation: verifications === 1 ? "后文仍为六天" : "前后均七天",
          })),
        });
      }
      patches++;
      const issue = data.issues[0];
      if (patches === 2)
        assert.deepEqual(issue.allowedTargets, [
          { sourceId: "scene:2", paragraph: 1 },
        ]);
      return validate({
        baseVersion: data.document.version,
        replacements: [
          {
            sourceId: "scene:1",
            paragraph: 1,
            issueIds: [issue.id],
            replacement: "上回十五日，隔七天。",
          },
          ...(patches > 1
            ? [
                {
                  sourceId: "scene:2",
                  paragraph: 1,
                  issueIds: [issue.id],
                  replacement: "它隔七天来一次。",
                },
              ]
            : []),
        ],
      });
    },
  });
  assert.equal(patches, 2);
  assert.equal(verifications, 2);
  assert.equal(result.scenes[1].content, "它隔七天来一次。");
  assert.equal(result.commits.length, 1);
});

test("没有作者裁定时不把模型误填的问题编号当成作者裁定，有裁定时仍严格核对", () => {
  const value = {
    issues: [],
    authorChecks: [{ id: "finding-1", respected: true, evidence: [ref(2)] }],
  };
  assert.deepEqual(validateFindings(value, doc).authorChecks, []);
  assert.throws(
    () => validateFindings(value, doc, [], [{ id: "author-1" }]),
    /author-1/,
  );
  assert.throws(
    () => validateFindings({ issues: [] }, doc, [], [{ id: "author-1" }]),
    /author-1/,
  );
  assert.equal(
    validateFindings(
      {
        ...value,
        authorChecks: [{ id: "author-1", respected: true, evidence: [ref(2)] }],
      },
      doc,
      [],
      [{ id: "author-1" }],
    ).authorChecks.length,
    1,
  );
});

test("自动裁决试图删除已有矛盾事实时转作者确认，不再陷入校验恢复循环", async () => {
  const h = harness({ uncertain: true, unsafeDecision: true });
  await assert.rejects(h.run, { name: "WaitingForAuthor" });
  assert.equal(h.state.status, "awaiting_input");
  assert.equal(h.patches, 0);
  assert.ok(h.state.pendingReview.issues.length);
  assert.equal(h.state.values["final-scene:0"], scenes[0].content);
});
