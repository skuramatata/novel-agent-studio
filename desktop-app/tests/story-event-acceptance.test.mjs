// 采纳验收判据的正负例：直接调用 scripts/verify-story-events.assert.cjs 的
// evaluateAcceptance —— 与桌面链路 verify-story-events.cjs 用的是同一个入口。
// 负例必须被“成功捕获”：断言入口返回 ok=false 并点名具体判据；
// 测试命令本身正常退出（负例不抛错）。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { evaluateAcceptance } = require("../scripts/verify-story-events.assert.cjs");

const digest = (text) => createHash("sha256").update(String(text ?? "")).digest("hex");

// ── 明确夹具：三章正文、历史图（一章将被修订、一章作对照）────────────────
const baseChapters = [
  { id: "c1", number: 1, title: "码头", content: "林砚把钥匙交给父亲。汽笛响了。" },
  { id: "c2", number: 2, title: "甲板", content: "林砚在甲板上看见旧船影子。" },
  { id: "c3", number: 3, title: "舱底", content: "" },
];

const evidenceOf = (chapters, chapterId, quote) => {
  const chapter = chapters.find((c) => c.id === chapterId);
  const start = chapter.content.indexOf(quote);
  assert.ok(start >= 0, `夹具引文不在第 ${chapterId} 章正文中：${quote}`);
  return {
    chapterId,
    start,
    end: start + quote.length,
    quote,
    sourceHash: digest(chapter.content),
  };
};

const baseNode = (chapters, chapterId, title, quote, extra = {}) => ({
  id: `sev-${chapterId}-${title}`,
  chapterId,
  chapterNumber: chapters.find((c) => c.id === chapterId).number,
  chapterTitle: chapters.find((c) => c.id === chapterId).title,
  title,
  summary: `${title}的摘要`,
  kind: "handover",
  actors: ["林砚", "父亲"],
  objects: ["钥匙"],
  status: "confirmed",
  basis: "narration",
  evidence: evidenceOf(chapters, chapterId, quote),
  review: { state: "unreviewed", note: "", at: null },
  stale: null,
  ...extra,
});

const historyNode = baseNode(baseChapters, "c1", "林砚把钥匙交给父亲", "林砚把钥匙交给父亲");
const controlNode = baseNode(baseChapters, "c2", "看见旧船影子", "林砚在甲板上看见旧船影子", {
  kind: "discovery",
  actors: ["林砚"],
  objects: ["旧船"],
});
const historyEdge = {
  id: "see-c1-c2-related",
  source: historyNode.id,
  target: controlNode.id,
  type: "related",
  basis: "inferred",
  explanation: "铜钥匙与旧船影子在同一作品里出现。",
  evidence: [],
  review: { state: "unreviewed", note: "", at: null },
  stale: null,
};
const decidedIssue = {
  id: "sit-kept-author",
  kind: "stale-evidence",
  nodeIds: [controlNode.id],
  edgeIds: [],
  explanation: "历史问题：旧船影子出处需要作者确认。",
  suggestion: "由作者决定是否保留。",
  disposition: "author-decided",
};
const openIssue = {
  id: "sit-open-formal",
  kind: "unsourced-knowledge",
  nodeIds: [historyNode.id],
  edgeIds: [],
  explanation: "历史问题：林砚为何知道钥匙在父亲手里。",
  suggestion: "由作者决定补交代或保留悬念。",
  disposition: "open",
};

const before = {
  chapters: baseChapters.map((c) => ({ ...c })),
  nodes: [historyNode, controlNode],
  edges: [historyEdge],
  issues: [decidedIssue, openIssue],
  acceptedIds: [],
};

// 链路 B 的修订章：第 1 章正文被候选改写（旧证据失效），第 2 章未被覆盖。
const revisedChapter1 =
  "林砚把铜扣交给父亲。汽笛响了。甲板上风很大，父亲什么也没说。";
const revisedChapters = baseChapters.map((c) =>
  c.id === "c1" ? { ...c, content: revisedChapter1 } : { ...c },
);

// 链路 B 候选：正文只含被修订的第 1 章 + 一条新增事件 + 跨章边 + 一条新问题。
const candidateChapters = revisedChapters.filter((c) => c.id === "c1");
const candidateEventQuote = "父亲什么也没说";
const candidateEvent = {
  chapterId: "c1",
  title: "父亲沉默收下铜扣",
  summary: "父亲接过铜扣但没有解释。",
  kind: "state-change",
  actors: ["父亲"],
  objects: ["铜扣"],
  status: "candidate",
  basis: "narration",
  storyTime: "",
  evidence: (() => {
    const start = revisedChapter1.indexOf(candidateEventQuote);
    return { start, end: start + candidateEventQuote.length, quote: candidateEventQuote };
  })(),
};
const candidateNodeId = "sev-candidate-father-silent";
const candidateNode = {
  ...candidateEvent,
  id: candidateNodeId,
  chapterNumber: 1,
  chapterTitle: "码头",
  evidence: {
    ...candidateEvent.evidence,
    chapterId: "c1",
    sourceHash: digest(revisedChapter1),
  },
  review: { state: "unreviewed", note: "", at: null },
  stale: null,
};
// 真正的跨章关系：c2 的历史事件（对照节点）→ c1 的本次新增事件。
// 仅“一端历史、一端新增”不足以证明跨章；两端解析后的 chapterId 必须不同。
const candidateEdge = {
  source: controlNode.id,
  target: candidateNodeId,
  type: "causal",
  basis: "explicit",
  explanation: "交接动作直接导致父亲沉默收下铜扣。",
  evidence: [
    {
      chapterId: "c1",
      start: candidateEvent.evidence.start,
      end: candidateEvent.evidence.end,
      quote: candidateEventQuote,
    },
  ],
};
// 复用已被作者裁定的历史问题 ID：候选若把它写回 open 就是重置作者决定。
const collidingIssue = {
  id: decidedIssue.id,
  kind: decidedIssue.kind,
  nodeIds: [candidateNodeId],
  edgeIds: [],
  explanation: "候选重复报告同一处出处冲突。",
  suggestion: "复核该事件的原文依据。",
  disposition: "open",
};
const freshIssue = {
  id: "sit-candidate-new",
  kind: "state-break",
  nodeIds: [candidateNodeId],
  edgeIds: [],
  explanation: "父亲收下铜扣但未说明来源，需作者核对。",
  suggestion: "核对是否需要补充说明。",
  disposition: "open",
};

// 采纳后的正式图：由“采纳前材料 + 契约”推导，不调用被测合并函数。
// 第 1 章正文已改且旧引文不再逐字出现 → 该章旧事件按 impactOf 契约标记 quote-missing
// （原引文、原 sourceHash、原区间一律保留）；第 2 章未受影响 → 对照事件保持有效。
const staleHistoryNode = {
  ...historyNode,
  stale: {
    at: "2026-11-09T00:00:00.000Z",
    reason: "quote-missing",
    expectedHash: historyNode.evidence.sourceHash,
  },
};
const after = {
  chapters: revisedChapters.map((c) => ({ ...c })),
  nodes: [staleHistoryNode, controlNode, candidateNode],
  edges: [
    {
      ...historyEdge,
      stale: {
        at: "2026-11-09T00:00:00.000Z",
        reason: "source-changed",
        expectedHash: historyEdge.evidence[0]?.sourceHash ?? "",
      },
    },
    {
      ...candidateEdge,
      id: "see-candidate-edge",
      evidence: candidateEdge.evidence.map((e) => ({ ...e, sourceHash: digest(revisedChapter1) })),
      review: { state: "unreviewed", note: "", at: null },
      stale: null,
    },
  ],
  // 同 ID 历史问题保持作者决定与原字段；候选不得覆盖（mergeIssues 契约）。
  issues: [decidedIssue, openIssue, freshIssue],
  acceptedIds: ["candidate-B"],
};

const baseInput = {
  chain: "B",
  candidateId: "candidate-B",
  before,
  after,
  candidateChapters,
  candidateEvents: [candidateEvent],
  candidateEdges: [candidateEdge],
  candidateIssues: [freshIssue, collidingIssue],
  candidateNodeIndex: [candidateNode],
  candidateEdgeIndex: [{ id: candidateNodeId, ...candidateNode }],
  requireIncrements: true,
  requireStaleChange: true,
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const failingIds = (result) => result.checks.filter((c) => !c.ok).map((c) => c.id);

test("正例：正确采纳结果通过同一断言入口", () => {
  const result = evaluateAcceptance(clone(baseInput));
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  assert.ok(result.checks.length > 10, "正例必须产生足够判据，不能空跑通过");
  // 关键判据确实被覆盖，而不是靠少量断言凑通过。
  const ids = result.checks.map((c) => c.id);
  for (const expected of [
    "after.B.accepted",
    "after.B.event.0.evidence",
    "after.B.event.0.sourceHash",
    "after.B.edge.0.contract",
    "after.B.edge.cross",
    "after.B.issue.sit-candidate-new.present",
    "after.B.decision.sit-kept-author",
    "after.B.origin.sev-c1-林砚把钥匙交给父亲.stale",
    "after.B.stale.changed",
  ])
    assert.ok(ids.includes(expected), `正例缺少判据 ${expected}`);
});

test("负例：只更新正文与 accepted、丢掉候选图必须失败", () => {
  const input = clone(baseInput);
  input.after = {
    ...input.after,
    nodes: [historyNode, controlNode],
    edges: [historyEdge],
  };
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(ids.includes("after.B.event.0.present"), `实际失败项：${JSON.stringify(ids)}`);
  assert.ok(ids.includes("after.B.edge.0.present"));
  assert.ok(ids.includes("after.B.issue.sit-candidate-new.links"));
});

test("负例：单独丢掉本次跨章边必须失败", () => {
  const input = clone(baseInput);
  input.after.edges = [historyEdge];
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(ids.includes("after.B.edge.0.present"), `实际失败项：${JSON.stringify(ids)}`);
  assert.ok(ids.includes("after.B.edge.cross"));
});

test("负例：单独丢掉本次问题必须失败", () => {
  const input = clone(baseInput);
  input.after.issues = input.after.issues.filter((i) => i.id !== freshIssue.id);
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(ids.includes("after.B.issue.sit-candidate-new.present"), `实际失败项：${JSON.stringify(ids)}`);
});

test("负例：链路B 作者决定被候选 open 重置必须失败", () => {
  const input = clone(baseInput);
  input.after.issues = input.after.issues.map((issue) =>
    issue.id === decidedIssue.id ? { ...issue, disposition: "open" } : issue,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(
    ids.some((id) => id.includes(decidedIssue.id)) &&
      ids.includes("after.B.decision.sit-kept-author"),
    `实际失败项：${JSON.stringify(ids)}`,
  );
});

test("负例：应失效原点未失效必须失败", () => {
  const input = clone(baseInput);
  input.after.nodes = input.after.nodes.map((node) =>
    node.id === historyNode.id ? { ...node, stale: null } : node,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(
    ids.includes("after.B.origin.sev-c1-林砚把钥匙交给父亲.stale"),
    `实际失败项：${JSON.stringify(ids)}`,
  );
});

test("负例：把所有旧节点一律判失效必须失败（对照事件被误标）", () => {
  const input = clone(baseInput);
  input.after.nodes = input.after.nodes.map((node) =>
    node.id === controlNode.id
      ? {
          ...node,
          stale: { at: "2026-11-09T00:00:00.000Z", reason: "source-changed", expectedHash: node.evidence.sourceHash },
        }
      : node,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  assert.ok(failingIds(result).includes("after.B.origin.sev-c2-看见旧船影子.stale"));
});

test("负例：证据区间/引文与候选最终正文不符必须失败", () => {
  const input = clone(baseInput);
  input.after.nodes = input.after.nodes.map((node) =>
    node.id === candidateNodeId
      ? { ...node, evidence: { ...node.evidence, start: node.evidence.start + 1 } }
      : node,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(ids.includes("after.B.event.0.evidence"), `实际失败项：${JSON.stringify(ids)}`);
  assert.ok(ids.includes("after.B.event.0.landing"));
});

// 单钉 sourceHash：只改哈希，区间、引文、落点仍完全正确。
// 若该判据被改写成恒真（或被他项顺带兜住），本用例会因 result.ok 变成 true 而失败。
test("负例：仅 sourceHash 与候选最终正文不一致必须失败（单钉该判据）", () => {
  const input = clone(baseInput);
  input.after.nodes = input.after.nodes.map((node) =>
    node.id === candidateNodeId
      ? { ...node, evidence: { ...node.evidence, sourceHash: digest("另一份被改写过的正文") } }
      : node,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false, "sourceHash 不一致必须导致整体不通过");
  const ids = failingIds(result);
  assert.ok(ids.includes("after.B.event.0.sourceHash"), `实际失败项：${JSON.stringify(ids)}`);
  // 区间/引文/章节字段/落点都未改动：必须由 sourceHash 判据单独拦住。
  for (const id of [
    "after.B.event.0.fields",
    "after.B.event.0.evidence",
    "after.B.event.0.landing",
  ])
    assert.ok(!ids.includes(id), `不应由 ${id} 判据代为拦截：${JSON.stringify(ids)}`);
});

test("负例：跨章边端点被换成别的事件必须失败", () => {
  const input = clone(baseInput);
  input.after.edges = input.after.edges.map((edge) =>
    edge.id === "see-candidate-edge" ? { ...edge, target: historyNode.id } : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  assert.ok(failingIds(result).includes("after.B.edge.0.present"));
});

// 正例的跨章边必须真的跨章：两端解析后的 chapterId 不同，且 detail 能直接读出。
test("正例：跨章边两端解析后 chapterId 不同", () => {
  const result = evaluateAcceptance(clone(baseInput));
  const cross = result.checks.find((c) => c.id === "after.B.edge.cross");
  assert.ok(cross, "必须产出跨章判据");
  assert.equal(cross.ok, true, `跨章判据未通过：${JSON.stringify(cross.detail)}`);
  const pairs = (cross.detail && cross.detail.crossEdges) || [];
  assert.ok(pairs.length > 0, `跨章边明细为空：${JSON.stringify(cross.detail)}`);
  for (const pair of pairs) {
    assert.ok(pair.sourceChapterId, `缺少 sourceChapterId：${JSON.stringify(pair)}`);
    assert.ok(pair.targetChapterId, `缺少 targetChapterId：${JSON.stringify(pair)}`);
    assert.notEqual(
      pair.sourceChapterId,
      pair.targetChapterId,
      `跨章边两端同章，不能算跨章：${JSON.stringify(pair)}`,
    );
  }
});

// 同章“历史→新增”关系：身份差异成立，但两端同属 c1，不能充当跨章关系。
test("负例：同章历史→新增关系不能充当跨章关系", () => {
  const input = clone(baseInput);
  input.candidateEdges = [{ ...candidateEdge, source: historyNode.id }];
  input.after.edges = input.after.edges.map((edge) =>
    edge.id === "see-candidate-edge" ? { ...edge, source: historyNode.id } : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(ids.includes("after.B.edge.cross"), `实际失败项：${JSON.stringify(ids)}`);
  // 端点与契约都还成立：必须由跨章语义本身拦住，而不是被别的判据顺带兜住。
  assert.ok(!ids.includes("after.B.edge.0.endpoints"), JSON.stringify(ids));
  assert.ok(!ids.includes("after.B.edge.0.present"), JSON.stringify(ids));
  const cross = result.checks.find((c) => c.id === "after.B.edge.cross");
  assert.equal(cross.ok, false);
  const sameChapter = (cross.detail && cross.detail.sameChapterEdges) || [];
  assert.ok(
    sameChapter.some((e) => e.sourceChapterId === "c1" && e.targetChapterId === "c1"),
    `detail 必须暴露同章端点：${JSON.stringify(cross.detail)}`,
  );
});

// 候选材料没有边/没有问题：即便采纳后图完全正确，也不得静默通过。
test("负例：候选材料无边时必需增量检查必须失败", () => {
  const input = clone(baseInput);
  input.candidateEdges = [];
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(ids.includes("B.candidate.crossEdge"), `实际失败项：${JSON.stringify(ids)}`);
  assert.ok(ids.includes("after.B.edge.cross"), `实际失败项：${JSON.stringify(ids)}`);
});

test("负例：候选材料无问题时必需增量检查必须失败", () => {
  const input = clone(baseInput);
  input.candidateIssues = [];
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  assert.ok(failingIds(result).includes("B.candidate.issues"));
});

// 四处接线：桌面真实调用与重启复用输入都不能漏掉必需增量要求。
test("接线：四处采纳/重启调用与两处保存输入都启用必需增量检查", async () => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../scripts/verify-story-events.cjs", import.meta.url);
  const source = await readFile(url, "utf8");
  const callBlocks = [...source.matchAll(/evaluateAcceptance\(\{([\s\S]*?)\n\s*\}\)/g)].map(
    (m) => m[1],
  );
  assert.equal(callBlocks.length, 4, `应恰有四处 evaluateAcceptance 调用，实际 ${callBlocks.length}`);
  callBlocks.forEach((block, index) => {
    // 要么本处直接开启，要么展开已保存标志的输入（重启阶段复用）。
    const direct = /requireIncrements:\s*true/.test(block);
    const viaSaved = /\.\.\.chain[12]AcceptInput/.test(block);
    assert.ok(
      direct || viaSaved,
      `第 ${index + 1} 处调用既未启用 requireIncrements，也未展开已保存标志的输入`,
    );
  });
  const savedInputs = [...source.matchAll(/chain[12]AcceptInput = \{([\s\S]*?)\n\s*\};/g)].map(
    (m) => m[1],
  );
  assert.equal(savedInputs.length, 2, `应恰有两处保存输入，实际 ${savedInputs.length}`);
  savedInputs.forEach((block, index) => {
    assert.match(
      block,
      /requireIncrements:\s*true/,
      `第 ${index + 1} 处保存输入未保存 requireIncrements`,
    );
  });
});

// ── K2：本次产生失效、历史关系保留与按 impactOf 契约失效 ──────────────────

test("K2 正例：历史关系保留且按契约失效，本次产生失效可核", () => {
  const result = evaluateAcceptance(clone(baseInput));
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  const ids = result.checks.map((c) => c.id);
  for (const expected of [
    "after.B.stale.newly",
    "after.B.originEdge.see-c1-c2-related.present",
    "after.B.originEdge.see-c1-c2-related.preserved",
    "after.B.originEdge.see-c1-c2-related.stale",
    "after.B.edge.0.stale",
  ])
    assert.ok(ids.includes(expected), `K2 正例缺少判据 ${expected}`);
  const newly = result.checks.find((c) => c.id === "after.B.stale.newly");
  assert.ok(newly.detail.newlyStaleCount > 0, `本次产生失效计数必须为正：${JSON.stringify(newly.detail)}`);
});

// 变体 F：采纳前原点已 stale、本次候选不改变任何正文。
// 该例必须由 K2 语义判据拦住，不能靠 requireIncrements 的跨章判据顺带兜住。
test("K2 负例F：采纳前已失效、本次无新失效必须由 stale.newly 拦住", () => {
  const input = clone(baseInput);
  // 采纳前正文已经是“改后”的样子，旧原点按采纳前正文就已失效。
  const alreadyRevised = baseChapters.map((c) =>
    c.id === "c1" ? { ...c, content: revisedChapter1 } : { ...c },
  );
  input.before = {
    ...clone(before),
    chapters: alreadyRevised,
    nodes: [
      {
        ...historyNode,
        stale: { at: "2026-11-08T00:00:00.000Z", reason: "quote-missing", expectedHash: historyNode.evidence.sourceHash },
      },
      controlNode,
    ],
  };
  // 本次候选不改变正文：candidateChapters 为空，采纳后正文与采纳前一致。
  input.candidateChapters = [];
  input.after = {
    ...input.after,
    chapters: alreadyRevised.map((c) => ({ ...c })),
    nodes: [
      {
        ...historyNode,
        stale: { at: "2026-11-08T00:00:00.000Z", reason: "quote-missing", expectedHash: historyNode.evidence.sourceHash },
      },
      controlNode,
      candidateNode,
    ],
  };
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  // 关键：必须由 K2 新增判据点名，而不是别的判据顺带拦住。
  assert.ok(ids.includes("after.B.stale.newly"), `必须由 stale.newly 拦住，实际：${JSON.stringify(ids)}`);
});

test("K2 负例：删除选定历史关系必须由 originEdge.present 拦住", () => {
  const input = clone(baseInput);
  input.after.edges = input.after.edges.filter((edge) => edge.id !== historyEdge.id);
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(
    ids.includes("after.B.originEdge.see-c1-c2-related.present"),
    `必须由 originEdge.present 拦住，实际：${JSON.stringify(ids)}`,
  );
});

test("K2 负例：历史关系旧证据被替换必须由 originEdge.preserved 拦住", () => {
  const input = clone(baseInput);
  input.after.edges = input.after.edges.map((edge) =>
    edge.id === historyEdge.id
      ? { ...edge, evidence: [], explanation: "被候选改写过的说明" }
      : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(
    ids.includes("after.B.originEdge.see-c1-c2-related.preserved"),
    `必须由 originEdge.preserved 拦住，实际：${JSON.stringify(ids)}`,
  );
});

test("K2 负例：清空应失效旧关系的 stale 必须由 originEdge.stale 拦住", () => {
  const input = clone(baseInput);
  input.after.edges = input.after.edges.map((edge) =>
    edge.id === historyEdge.id ? { ...edge, stale: null } : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(
    ids.includes("after.B.originEdge.see-c1-c2-related.stale"),
    `必须由 originEdge.stale 拦住，实际：${JSON.stringify(ids)}`,
  );
});

test("K2 负例：对照关系被误标失效必须由 originEdge.stale 拦住", () => {
  const input = clone(baseInput);
  const controlEdge = {
    id: "see-c2-control",
    source: controlNode.id,
    target: candidateNodeId,
    type: "related",
    basis: "explicit",
    explanation: "对照关系：本章末尾与新事件同章出现。",
    evidence: [],
    review: { state: "unreviewed", note: "", at: null },
    stale: null,
  };
  input.before.edges = [...input.before.edges, clone(controlEdge)];
  input.after.edges = [
    ...input.after.edges,
    {
      ...clone(controlEdge),
      stale: { at: "2026-11-09T00:00:00.000Z", reason: "source-changed", expectedHash: "deadbeef" },
    },
  ];
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  const ids = failingIds(result);
  assert.ok(
    ids.includes("after.B.originEdge.see-c2-control.stale"),
    `必须由 originEdge.stale 拦住对照关系，实际：${JSON.stringify(ids)}`,
  );
});

test("K2 负例：本次候选关系统被误标失效必须由 edge.N.stale 拦住", () => {
  const input = clone(baseInput);
  input.after.edges = input.after.edges.map((edge) =>
    edge.id === "see-candidate-edge"
      ? { ...edge, stale: { at: "2026-11-09T00:00:00.000Z", reason: "source-changed", expectedHash: "deadbeef" } }
      : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  assert.ok(
    failingIds(result).includes("after.B.edge.0.stale"),
    `必须由 edge.0.stale 拦住，实际：${JSON.stringify(failingIds(result))}`,
  );
});

test("K2 正例：同库重启后历史关系与本次失效仍按契约成立", () => {
  const input = clone(baseInput);
  input.restart = clone(after);
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  const ids = result.checks.map((c) => c.id);
  for (const expected of [
    "restart.B.stale.newly",
    "restart.B.originEdge.see-c1-c2-related.present",
    "restart.B.originEdge.see-c1-c2-related.stale",
  ])
    assert.ok(ids.includes(expected), `重启阶段缺少判据 ${expected}`);
});

test("正例：同一库重启复核同一组业务事实与作者决定", () => {
  const input = clone(baseInput);
  input.restart = clone(after);
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  assert.ok(result.checks.some((c) => c.id.startsWith("restart.B.")), "重启阶段必须真的被核对");
});

test("负例：重启后作者决定被重置必须失败", () => {
  const input = clone(baseInput);
  input.restart = clone(after);
  input.restart.issues = input.restart.issues.map((issue) =>
    issue.id === decidedIssue.id ? { ...issue, disposition: "kept" } : issue,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false);
  assert.ok(failingIds(result).includes("restart.B.decision.sit-kept-author"));
});

test("链路A：空白新章候选只核 B 的增量，不假设全书正文", () => {
  const chainAChapters = [
    { id: "a1", number: 1, title: "出航", content: "林砚把铜扣交给父亲。" },
    { id: "a2", number: 2, title: "新章", content: "" },
  ];
  const chainANode = baseNode(chainAChapters, "a1", "林砚把铜扣交给父亲", "林砚把铜扣交给父亲");
  const blankChapterText = "新章正文：林砚在舱底找到一封信。";
  const chainAEventQuote = "林砚在舱底找到一封信";
  const chainAStart = blankChapterText.indexOf(chainAEventQuote);
  const chainAEvent = {
    chapterId: "a2",
    title: "舱底发现信件",
    summary: "林砚在舱底找到一封信。",
    kind: "discovery",
    actors: ["林砚"],
    objects: ["信"],
    status: "candidate",
    basis: "narration",
    storyTime: "",
    evidence: { start: chainAStart, end: chainAStart + chainAEventQuote.length, quote: chainAEventQuote },
  };
  const chainANodeBuilt = {
    ...chainAEvent,
    id: "sev-a2-letter",
    chapterNumber: 2,
    chapterTitle: "新章",
    evidence: { ...chainAEvent.evidence, chapterId: "a2", sourceHash: digest(blankChapterText) },
    review: { state: "unreviewed", note: "", at: null },
    stale: null,
  };
  const chainAEdge = {
    source: chainANode.id,
    target: chainANodeBuilt.id,
    type: "related",
    basis: "explicit",
    explanation: "第一章的铜扣与新章的信件同属一条线索。",
    evidence: [
      {
        chapterId: "a2",
        start: chainAEvent.evidence.start,
        end: chainAEvent.evidence.end,
        quote: chainAEventQuote,
      },
    ],
  };
  const chainAIssue = {
    id: "sit-a2-new",
    kind: "missing-source",
    nodeIds: [chainANodeBuilt.id],
    edgeIds: [],
    explanation: "信件来源未在正文说明。",
    suggestion: "由作者决定是否补交代。",
    disposition: "open",
  };
  const chainAInput = {
    chain: "A",
    candidateId: "candidate-A2",
    before: {
      chapters: chainAChapters,
      nodes: [chainANode],
      edges: [],
      issues: [],
      acceptedIds: [],
    },
    after: {
      chapters: chainAChapters.map((c) =>
        c.id === "a2" ? { ...c, content: blankChapterText } : { ...c },
      ),
      nodes: [chainANode, chainANodeBuilt],
      edges: [
        {
          ...chainAEdge,
          id: "see-a2-edge",
          evidence: [{ ...chainAEdge.evidence[0], sourceHash: digest(blankChapterText) }],
          review: { state: "unreviewed", note: "", at: null },
          stale: null,
        },
      ],
      issues: [chainAIssue],
      acceptedIds: ["candidate-A2"],
    },
    candidateChapters: [{ id: "a2", content: blankChapterText }],
    candidateEvents: [chainAEvent],
    candidateEdges: [chainAEdge],
    candidateIssues: [chainAIssue],
    candidateNodeIndex: [chainANodeBuilt],
    candidateEdgeIndex: [{ id: chainANodeBuilt.id, ...chainANodeBuilt }],
    requireIncrements: true,
  };
  const result = evaluateAcceptance(chainAInput);
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  // 链路A 不得要求未涉及章节出现在候选里：a1 作为未覆盖章必须被保留核对。
  assert.ok(result.checks.some((c) => c.id === "after.A.chapter.keep.a1"));
});

// ── L1（round8）：历史关系证据必须逐份保留原 sourceHash ────────────────────
// 历史关系证据与候选材料不同：它带采纳前的 sourceHash，采纳后不得被重算成新正文哈希。
const evidencedHistoryEdgeId = "see-c1-c2-key";
const evidencedHistoryEdge = {
  id: evidencedHistoryEdgeId,
  source: historyNode.id,
  target: controlNode.id,
  type: "related",
  basis: "explicit",
  explanation: "钥匙交接与旧船影子同属一条线索。",
  evidence: [evidenceOf(baseChapters, "c2", "林砚在甲板上看见旧船影子")],
  review: { state: "unreviewed", note: "", at: null },
  stale: null,
};

// 该边端点含本次失效的历史事件，按 impactOf 契约应标 source-changed，
// expectedHash 仍是采纳前的原 sourceHash（不是新正文哈希）。
const staleEvidencedEdge = {
  ...clone(evidencedHistoryEdge),
  stale: {
    at: "2026-11-09T00:00:00.000Z",
    reason: "source-changed",
    expectedHash: evidencedHistoryEdge.evidence[0].sourceHash,
  },
};

const evidencedInput = () => {
  const input = clone(baseInput);
  input.before.edges = [...input.before.edges, clone(evidencedHistoryEdge)];
  input.after.edges = [...input.after.edges, clone(staleEvidencedEdge)];
  return input;
};

test("L1 正例：历史关系证据含 sourceHash 时采纳与同库重启均通过", () => {
  const input = evidencedInput();
  input.restart = clone(input.after);
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  const ids = result.checks.map((c) => c.id);
  assert.ok(
    ids.includes(`after.B.originEdge.${evidencedHistoryEdgeId}.preserved`),
    `缺少采纳阶段历史关系保留判据：${JSON.stringify(ids)}`,
  );
  assert.ok(
    ids.includes(`restart.B.originEdge.${evidencedHistoryEdgeId}.preserved`),
    `缺少重启阶段历史关系保留判据：${JSON.stringify(ids)}`,
  );
});

test("L1 负例：只改采纳后历史关系的 sourceHash 必须由 preserved 拦住", () => {
  const input = evidencedInput();
  input.after.edges = input.after.edges.map((edge) =>
    edge.id === evidencedHistoryEdgeId
      ? {
          ...edge,
          evidence: [{ ...edge.evidence[0], sourceHash: digest("另一份被改写过的正文") }],
        }
      : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false, "历史关系 sourceHash 被换掉必须导致整体不通过");
  const ids = failingIds(result);
  assert.ok(
    ids.includes(`after.B.originEdge.${evidencedHistoryEdgeId}.preserved`),
    `必须由 originEdge.preserved 拦住，实际：${JSON.stringify(ids)}`,
  );
  // 引文与区间都未动、失效状态仍按原证据成立：不能让别的判据代为拦截。
  assert.ok(
    !ids.includes(`after.B.originEdge.${evidencedHistoryEdgeId}.stale`),
    `不应由 stale 判据代为拦截：${JSON.stringify(ids)}`,
  );
});

test("L1 负例：只改重启后历史关系的 sourceHash 必须由 preserved 拦住", () => {
  const input = evidencedInput();
  input.restart = clone(input.after);
  input.restart.edges = input.restart.edges.map((edge) =>
    edge.id === evidencedHistoryEdgeId
      ? {
          ...edge,
          evidence: [{ ...edge.evidence[0], sourceHash: digest("重启后被重算的正文") }],
        }
      : edge,
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, false, "重启阶段历史关系 sourceHash 被换掉必须导致整体不通过");
  const ids = failingIds(result);
  assert.ok(
    ids.includes(`restart.B.originEdge.${evidencedHistoryEdgeId}.preserved`),
    `必须由 restart.originEdge.preserved 拦住，实际：${JSON.stringify(ids)}`,
  );
  // 采纳阶段完全正确：失败只能来自重启阶段。
  assert.equal(
    ids.some((id) => id.startsWith("after.")),
    false,
    `采纳阶段不应失败：${JSON.stringify(ids)}`,
  );
});

test("L1 正例：候选证据本就没有 sourceHash 的合法材料仍通过", () => {
  const input = clone(baseInput);
  assert.equal(
    input.candidateEdges[0].evidence.every((item) => !("sourceHash" in item)),
    true,
    "夹具前置：候选关系证据不带 sourceHash",
  );
  const result = evaluateAcceptance(input);
  assert.equal(result.ok, true, `未通过：${JSON.stringify(failingIds(result))}`);
  const contract = result.checks.find((c) => c.id === "after.B.edge.0.contract");
  assert.ok(contract, "必须产出候选关系契约判据");
  assert.equal(
    contract.ok,
    true,
    `候选材料因缺 sourceHash 被误判：${JSON.stringify(contract.detail)}`,
  );
});
