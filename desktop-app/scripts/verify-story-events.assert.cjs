// 断言工具：强制每个 case 只能以 pass / fail 收尾，杜绝静默跳过。
// 任务书规定不得用"条件不满足就跳过"掩盖问题，本文件是脚本自身的守卫。
const RESULT_PASS = "pass";
const RESULT_FAIL = "fail";
// 未验证：前置依赖缺失（如生成不出候选）导致该案例无法执行。
// 与 fail 区分开——既不能算通过，也不该记成"脚本或产品断言失败"。
const RESULT_UNVERIFIED = "unverified";

const REQUIRED_FIELDS = ["caseId", "title", "rNumbers", "blockedBy"];

function createRunner({ plan = [] } = {}) {
  const results = new Map();

  // 预注册全部计划案例：任何未执行完的 case 都会以 fail 收尾。
  for (const item of plan) {
    for (const field of REQUIRED_FIELDS) {
      // blockedBy 允许显式写 null（表示当前无阻塞方），但字段本身必须声明，
      // 防止漏写导致"不知道为什么红"。
      if (!(field in item)) {
        throw new Error(`案例计划缺少字段 ${field}：${JSON.stringify(item)}`);
      }
      if (field !== "blockedBy" && (item[field] === undefined || item[field] === null)) {
        throw new Error(`案例计划字段 ${field} 不能为空：${JSON.stringify(item)}`);
      }
    }
    results.set(item.caseId, {
      caseId: item.caseId,
      title: item.title,
      rNumbers: item.rNumbers,
      blockedBy: item.blockedBy,
      status: "not-run",
      assertions: [],
      detail: null,
      evidence: null,
    });
  }

  const entryOf = (caseId) => {
    const entry = results.get(caseId);
    if (!entry) throw new Error(`未注册的案例：${caseId}`);
    return entry;
  };

  // 记录一条断言。ok 必须是真正的布尔值，禁止 undefined/真值糊弄。
  const check = (caseId, description, ok, evidence = null) => {
    if (typeof ok !== "boolean") {
      throw new Error(
        `案例 ${caseId} 的断言「${description}」结果不是布尔值（收到 ${typeof ok}），拒绝记录`,
      );
    }
    const entry = entryOf(caseId);
    entry.assertions.push({ description, ok, evidence });
    if (!ok) {
      if (entry.status !== RESULT_FAIL) entry.status = RESULT_FAIL;
      if (entry.detail === null) entry.detail = description;
    } else if (entry.status === "not-run") {
      entry.status = "in-progress";
    }
    return ok;
  };

  const fail = (caseId, reason) => {
    const entry = entryOf(caseId);
    entry.status = RESULT_FAIL;
    entry.detail = entry.detail ?? reason;
    entry.assertions.push({ description: reason, ok: false, evidence: null });
  };

  // 正常收尾：只有全部断言为真才算 pass；没有断言也判 fail（空跑不算通过）。
  const finish = (caseId, evidence = null) => {
    const entry = entryOf(caseId);
    // 已显式判定为 unverified 的案例，finish 不得把它改写成 pass/fail。
    if (entry.status === RESULT_UNVERIFIED) {
      if (evidence !== null) entry.evidence = evidence;
      return entry;
    }
    if (entry.assertions.length === 0) {
      entry.status = RESULT_FAIL;
      entry.detail = "该案例未产生任何断言，空跑不算通过";
    } else if (entry.assertions.every((a) => a.ok)) {
      entry.status = RESULT_PASS;
      entry.detail = null;
    } else {
      entry.status = RESULT_FAIL;
    }
    entry.evidence = evidence;
    return entry;
  };

  const runCase = async (caseId, fn) => {
    // 未注册的 case 不得中断整个脚本：记录为 fail 并继续，
    // 保证后续案例仍会执行（否则"未执行"会被误当成环境问题）。
    if (!results.has(caseId)) {
      results.set(caseId, {
        caseId,
        title: caseId,
        rNumbers: [],
        blockedBy: null,
        status: RESULT_FAIL,
        assertions: [
          {
            description: `案例 ${caseId} 未在 CASE_PLAN 注册，无法执行`,
            ok: false,
            evidence: null,
          },
        ],
        detail: `案例 ${caseId} 未在 CASE_PLAN 注册`,
        evidence: null,
      });
      return results.get(caseId);
    }
    const entry = entryOf(caseId);
    try {
      await fn();
    } catch (error) {
      entry.status = RESULT_FAIL;
      entry.detail = `案例执行抛错：${error && error.message ? error.message : String(error)}`;
      entry.assertions.push({
        description: `执行异常：${error && error.message ? error.message : String(error)}`,
        ok: false,
        evidence: null,
      });
    } finally {
      // 无论成功失败都走一次收尾，保证状态不是 not-run / in-progress。
      // 但 unverified 是显式结论（前置缺失），不能被这里的兜底改写成 fail。
      if (entry.status === RESULT_UNVERIFIED) {
        // 保留原判定与原因。
      } else if (entry.status !== RESULT_PASS) {
        if (entry.assertions.length === 0 && entry.status !== RESULT_FAIL) {
          entry.status = RESULT_FAIL;
          entry.detail = "案例未产生断言即结束";
        }
        if (entry.status !== RESULT_FAIL) entry.status = RESULT_FAIL;
      }
    }
    return entry;
  };

  const list = () => [...results.values()].map((e) => ({ ...e, assertions: [...e.assertions] }));

  // 可控失败注入：直接改内部状态（list() 返回副本，改副本无效）。
  const injectFailure = (caseId, reason) => {
    const entry = results.get(caseId);
    if (!entry) return false;
    entry.status = RESULT_FAIL;
    entry.detail = reason;
    entry.assertions.push({ description: reason, ok: false, evidence: { injected: true } });
    return true;
  };

  // 前置缺失：明确标 unverified，并写明阻塞原因，附带已有证据进报告。
  const unverified = (caseId, reason, evidence = null) => {
    const entry = entryOf(caseId);
    entry.status = RESULT_UNVERIFIED;
    entry.detail = reason;
    entry.evidence = evidence;
    return entry;
  };

  // 自检 A：任何既不是 pass / fail / unverified 的案例都要在此暴露。
  const auditUnresolved = () => {
    const unresolved = list().filter(
      (e) =>
        e.status !== RESULT_PASS &&
        e.status !== RESULT_FAIL &&
        e.status !== RESULT_UNVERIFIED,
    );
    return {
      ok: unresolved.length === 0,
      unresolved: unresolved.map((e) => ({ caseId: e.caseId, status: e.status, title: e.title })),
    };
  };

  const summary = () => {
    const all = list();
    return {
      total: all.length,
      pass: all.filter((e) => e.status === RESULT_PASS).length,
      fail: all.filter((e) => e.status === RESULT_FAIL).length,
      unverified: all.filter((e) => e.status === RESULT_UNVERIFIED).length,
      unresolved: all.filter(
        (e) =>
          e.status !== RESULT_PASS &&
          e.status !== RESULT_FAIL &&
          e.status !== RESULT_UNVERIFIED,
      ).length,
    };
  };

  return {
    check,
    fail,
    unverified,
    finish,
    runCase,
    list,
    auditUnresolved,
    summary,
    injectFailure,
  };
}

// ── 采纳结果核对（J2）────────────────────────────────────────────────
// 判据来源：采纳前材料（候选最终正文、候选事件/关系/问题草稿、历史图、作者决定）
// 加契约推导，不调用被测合并函数生成“正确答案”。
// 同一入口服务链路A（空白新章候选）与链路B（显式修订候选），
// 由 tests/story-event-acceptance.test.mjs 做正负例，实际桌面链路也调用它。
const { createHash } = require("node:crypto");

const digestText = (text) => createHash("sha256").update(String(text ?? "")).digest("hex");
const nodeKeyOf = (node) =>
  [
    node.chapterId,
    node.title,
    node.evidence ? node.evidence.start : null,
    node.evidence ? node.evidence.end : null,
  ].join("|");
const edgeKeyOf = (edge) => `${edge.source}|${edge.target}|${edge.type}`;
const sortedKey = (values) => [...new Set(values || [])].sort().join("|");
const evidenceListKey = (list) =>
  (list || [])
    .map((e) => `${e.chapterId}|${e.start}|${e.end}|${e.quote}`)
    .join(";");

// 历史关系的证据必须逐份保留采纳前的 sourceHash（含顺序与数量）。
// 候选材料本就不带 sourceHash，故不能复用 evidenceListKey，只供 originEdge 判据使用。
const historicalEvidenceListKey = (list) =>
  JSON.stringify(
    (list || []).map((e) => ({
      chapterId: e.chapterId,
      start: e.start,
      end: e.end,
      quote: e.quote,
      sourceHash: e.sourceHash,
    })),
  );

const normalizeChapters = (list) =>
  (list || []).filter(Boolean).map((c) => ({
    id: c.id,
    content: typeof c.content === "string" ? c.content : "",
  }));

const normalizeFacts = (facts = {}) => ({
  chapters: normalizeChapters(facts.chapters),
  nodes: Array.isArray(facts.nodes) ? facts.nodes : [],
  edges: Array.isArray(facts.edges) ? facts.edges : [],
  issues: Array.isArray(facts.issues) ? facts.issues : [],
  acceptedIds: Array.isArray(facts.acceptedIds) ? facts.acceptedIds : [],
});

// 候选最终正文视图：proposal.chapters 覆盖的章用候选内容，其余保持采纳前正文。
// 这是契约里的投影规则，不是生产合并实现。
const overlayChapters = (beforeChapters, candidateChapters) => {
  const incoming = new Map((candidateChapters || []).map((c) => [c.id, c]));
  return (beforeChapters || []).map((c) => {
    const next = incoming.get(c.id);
    return next && typeof next.content === "string"
      ? { ...c, content: next.content }
      : { ...c };
  });
};

// 失效是派生状态：按采纳后正文复算，不删除旧事件、不改原引文与原 sourceHash。
const expectedStaleReason = (node, chapters) => {
  const chapter = (chapters || []).find((c) => c.id === node.evidence.chapterId);
  if (!chapter) return "chapter-missing";
  if (node.evidence.sourceHash === digestText(chapter.content)) return null;
  return chapter.content.includes(node.evidence.quote) ? "source-changed" : "quote-missing";
};

// 关系失效契约（impactOf）：
//   1) 自身任一证据实际失效 → 取第一份实际失效证据的 reason 与原 sourceHash；
//   2) 仅端点失效、证据本身有效 → source-changed，expectedHash 取 edge.evidence[0]?.sourceHash ?? ""；
//   3) 关系证据与两端都有效 → stale 必须为 null。
const expectedEdgeStale = (edge, staleNodeIds, chapters) => {
  const evidence = Array.isArray(edge.evidence) ? edge.evidence : [];
  const failed = evidence.find((item) => expectedStaleReason({ evidence: item }, chapters) !== null);
  if (failed) {
    return {
      reason: expectedStaleReason({ evidence: failed }, chapters),
      expectedHash: failed.sourceHash ?? "",
    };
  }
  if (staleNodeIds.has(edge.source) || staleNodeIds.has(edge.target)) {
    return {
      reason: "source-changed",
      expectedHash: (evidence[0] && evidence[0].sourceHash) || "",
    };
  }
  return null;
};

function evaluateAcceptance(input = {}) {
  const checks = [];
  const record = (id, label, ok, detail = null) => {
    checks.push({ id, label, ok: ok === true, detail });
    return ok === true;
  };
  const finish = () => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checks });

  const chain = input.chain === "B" ? "B" : "A";
  const candidateId = typeof input.candidateId === "string" ? input.candidateId : null;
  const before = input.before || null;
  const after = input.after || null;
  const restart = input.restart || null;
  const requireIncrements = input.requireIncrements === true;
  const requireStaleChange = input.requireStaleChange === true;
  const candidateChapters = normalizeChapters(input.candidateChapters);
  const candidateEvents = Array.isArray(input.candidateEvents) ? input.candidateEvents : [];
  const candidateEdges = Array.isArray(input.candidateEdges) ? input.candidateEdges : [];
  const candidateIssues = Array.isArray(input.candidateIssues) ? input.candidateIssues : [];
  const candidateNodeIndex = Array.isArray(input.candidateNodeIndex)
    ? input.candidateNodeIndex
    : [];
  const candidateEdgeIndex = Array.isArray(input.candidateEdgeIndex)
    ? input.candidateEdgeIndex
    : [];
  // 问题可能引用采纳前就存在的正式边（跨批次问题），其 id 不在候选边集合里。
  const formalEdgeIndex = Array.isArray(input.formalEdgeIndex) ? input.formalEdgeIndex : [];

  if (!before || !after || !candidateId) {
    record(`${chain}.input`, `采纳核对输入完整（候选 ID／采纳前快照／采纳后快照）`, false, {
      candidateId,
      hasBefore: !!before,
      hasAfter: !!after,
    });
    return finish();
  }

  const beforeFacts = normalizeFacts(before);
  const finalChapters = overlayChapters(beforeFacts.chapters, candidateChapters);
  const finalById = new Map(finalChapters.map((c) => [c.id, c]));
  const beforeIds = new Set(beforeFacts.nodes.map((n) => n.id));
  const beforeByKey = new Map(beforeFacts.nodes.map((n) => [nodeKeyOf(n), n]));
  const beforeEdgeIds = new Set(beforeFacts.edges.map((e) => e.id));
  const nodeKeyById = new Map(
    candidateNodeIndex
      .filter((item) => item && typeof item.id === "string")
      .map((item) => [item.id, nodeKeyOf(item)]),
  );
  const edgeShapeById = new Map(
    [...candidateEdgeIndex, ...formalEdgeIndex]
      .filter((item) => item && typeof item.id === "string")
      .map((item) => [item.id, { source: item.source, target: item.target, type: item.type }]),
  );
  const decided = new Map(
    beforeFacts.issues
      .filter((issue) => issue && issue.disposition && issue.disposition !== "open")
      .map((issue) => [issue.id, issue.disposition]),
  );

  if (!candidateEvents.length)
    record(`${chain}.candidate.events`, "采纳前材料包含候选事件（否则无增量可核）", false, {
      candidateId,
    });
  if (requireIncrements) {
    record(
      `${chain}.candidate.crossEdge`,
      "采纳前材料包含指向历史事件的跨章边",
      candidateEdges.length > 0,
      { candidateEdgeCount: candidateEdges.length },
    );
    record(
      `${chain}.candidate.issues`,
      "采纳前材料包含本次候选问题",
      candidateIssues.length > 0,
      { candidateIssueCount: candidateIssues.length },
    );
  }
  if (requireStaleChange && decided.size === 0)
    record(
      `${chain}.candidate.decisions`,
      "采纳前快照包含作者决定（链路B 必须核对决定不被重置）",
      false,
    );

  // 候选草稿 ID（预览/抽取图）→ 正式事件 ID：按事件语义对位，不要求 ID 无条件相等。
  const resolveNodeId = (id, nodes) => {
    if (beforeIds.has(id)) return id;
    const key = nodeKeyById.get(id);
    if (!key) return null;
    const hit = nodes.find((n) => nodeKeyOf(n) === key);
    return hit ? hit.id : null;
  };
  const resolveEdgeId = (id, facts) => {
    if (beforeEdgeIds.has(id)) return id;
    const shape = edgeShapeById.get(id);
    if (!shape) return null;
    const source = resolveNodeId(shape.source, facts.nodes);
    const target = resolveNodeId(shape.target, facts.nodes);
    if (!source || !target) return null;
    const hit = facts.edges.find(
      (edge) => edge.source === source && edge.target === target && edge.type === shape.type,
    );
    return hit ? hit.id : null;
  };

  const phaseChecks = (rawFacts, phase) => {
    const facts = normalizeFacts(rawFacts);
    const tag = `${phase}.${chain}`;
    const chapters = facts.chapters;
    const nodes = facts.nodes;
    const edges = facts.edges;
    const issues = facts.issues;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeIds = new Set(edges.map((e) => e.id));

    record(
      `${tag}.accepted`,
      `${phase}：该候选状态为 accepted`,
      facts.acceptedIds.includes(candidateId),
      { candidateId, acceptedIds: facts.acceptedIds },
    );

    for (const chapter of candidateChapters) {
      const hit = chapters.find((c) => c.id === chapter.id);
      record(
        `${tag}.chapter.${chapter.id}`,
        `${phase}：第 ${chapter.id} 章正文等于候选最终正文`,
        !!hit && hit.content === chapter.content,
        {
          expectedLen: chapter.content.length,
          actualLen: hit ? hit.content.length : null,
        },
      );
    }
    for (const chapter of beforeFacts.chapters) {
      if (candidateChapters.some((c) => c.id === chapter.id)) continue;
      const hit = chapters.find((c) => c.id === chapter.id);
      record(
        `${tag}.chapter.keep.${chapter.id}`,
        `${phase}：未被候选覆盖的第 ${chapter.id} 章正文保持原样`,
        !!hit && hit.content === chapter.content,
        { expectedLen: chapter.content.length, actualLen: hit ? hit.content.length : null },
      );
    }

    candidateEvents.forEach((draft, index) => {
      const key = nodeKeyOf(draft);
      // 先按事件语义身份定位（章节+标题+kind），再优先取区间完全一致者：
      // 这样“节点在但证据区间被改”会落到下面的证据判据，而不是被当成“事件不存在”。
      const semantic = nodes.filter(
        (n) => n.chapterId === draft.chapterId && n.title === draft.title && n.kind === draft.kind,
      );
      const hit = semantic.find((n) => nodeKeyOf(n) === key) ?? semantic[0] ?? null;
      record(
        `${tag}.event.${index}.present`,
        `${phase}：新增事件「${draft.title}」已写入正式图`,
        !!hit,
        { key, candidateId },
      );
      if (!hit) return;
      record(
        `${tag}.event.${index}.fields`,
        `${phase}：事件「${draft.title}」的章节/语义/kind/actors/objects 与候选一致`,
        hit.chapterId === draft.chapterId &&
          hit.title === draft.title &&
          hit.kind === draft.kind &&
          sortedKey(hit.actors) === sortedKey(draft.actors) &&
          sortedKey(hit.objects) === sortedKey(draft.objects) &&
          (hit.summary ?? "") === (draft.summary ?? ""),
        {
          expected: {
            chapterId: draft.chapterId,
            title: draft.title,
            kind: draft.kind,
            actors: draft.actors,
            objects: draft.objects,
            summary: draft.summary,
          },
          actual: {
            chapterId: hit.chapterId,
            title: hit.title,
            kind: hit.kind,
            actors: hit.actors,
            objects: hit.objects,
            summary: hit.summary,
          },
        },
      );
      const finalContent = finalById.get(draft.chapterId);
      const evidence = hit.evidence || {};
      record(
        `${tag}.event.${index}.evidence`,
        `${phase}：事件「${draft.title}」证据的章节/区间/引文对应候选最终正文`,
        !!finalContent &&
          evidence.chapterId === draft.chapterId &&
          evidence.start === draft.evidence.start &&
          evidence.end === draft.evidence.end &&
          evidence.quote === draft.evidence.quote &&
          finalContent.content.slice(evidence.start, evidence.end) === evidence.quote,
        { expected: draft.evidence, actual: evidence },
      );
      record(
        `${tag}.event.${index}.sourceHash`,
        `${phase}：事件「${draft.title}」sourceHash 按候选最终正文复算一致`,
        !!finalContent && evidence.sourceHash === digestText(finalContent.content),
        {
          expected: finalContent ? digestText(finalContent.content) : null,
          actual: evidence.sourceHash ?? null,
        },
      );
      const landed = chapters.find((c) => c.id === evidence.chapterId);
      record(
        `${tag}.event.${index}.landing`,
        `${phase}：事件「${draft.title}」引文在正式作品同章同区间逐字成立`,
        !!landed &&
          Number.isInteger(evidence.start) &&
          landed.content.slice(evidence.start, evidence.end) === evidence.quote,
        { chapterId: evidence.chapterId, quote: evidence.quote },
      );
      const reused = beforeIds.has(hit.id);
      record(
        `${tag}.event.${index}.identity`,
        `${phase}：事件「${draft.title}」只复用同一事件的历史 ID，未占用其他事件身份`,
        !reused || (beforeByKey.get(key) && beforeByKey.get(key).id === hit.id),
        { nodeId: hit.id, reused },
      );
    });

    candidateEdges.forEach((edge, index) => {
      const source = resolveNodeId(edge.source, nodes);
      const target = resolveNodeId(edge.target, nodes);
      record(
        `${tag}.edge.${index}.endpoints`,
        `${phase}：本次关系端点对应指定历史事件与候选事件`,
        !!source && !!target,
        { edgeKey: edgeKeyOf(edge), source, target },
      );
      const hit =
        source && target
          ? edges.find(
              (item) =>
                item.source === source && item.target === target && item.type === edge.type,
            )
          : null;
      record(
        `${tag}.edge.${index}.present`,
        `${phase}：本次关系 ${edge.type}（${edge.source} → ${edge.target}）已写入正式图`,
        !!hit,
        { source, target, type: edge.type },
      );
      if (!hit) return;
      record(
        `${tag}.edge.${index}.contract`,
        `${phase}：关系 ${edge.type} 的 basis/explanation/evidence 按契约保留`,
        hit.basis === edge.basis &&
          (hit.explanation ?? "") === (edge.explanation ?? "") &&
          evidenceListKey(hit.evidence) === evidenceListKey(edge.evidence),
        {
          expected: {
            basis: edge.basis,
            explanation: edge.explanation,
            evidence: edge.evidence,
          },
          actual: {
            basis: hit.basis,
            explanation: hit.explanation,
            evidence: hit.evidence,
          },
        },
      );
    });

    // 按端点 ID 取正式图节点：跨章与否必须看解析后的节点 chapterId，
    // 不能只看 ID 不同、标题不同或历史/新增身份不同。
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const crossEdges = candidateEdges
      .map((edge) => {
        const source = resolveNodeId(edge.source, nodes);
        const target = resolveNodeId(edge.target, nodes);
        const hit =
          source && target
            ? edges.find(
                (item) =>
                  item.source === source && item.target === target && item.type === edge.type,
              )
            : null;
        if (!hit) return null;
        const sourceNode = nodeById.get(hit.source) || null;
        const targetNode = nodeById.get(hit.target) || null;
        return {
          edgeKey: edgeKeyOf(hit),
          sourceChapterId: sourceNode ? sourceNode.chapterId : null,
          targetChapterId: targetNode ? targetNode.chapterId : null,
          // 一端为历史事件、另一端为本次新增事件（保留原判据）。
          historicalMixed:
            beforeIds.has(hit.source) !== beforeIds.has(hit.target),
        };
      })
      .filter(Boolean);
    const crossEdgesReal = crossEdges.filter(
      (item) =>
        item.historicalMixed &&
        !!item.sourceChapterId &&
        !!item.targetChapterId &&
        item.sourceChapterId !== item.targetChapterId,
    );
    if (requireIncrements) {
      record(
        `${tag}.edge.cross`,
        `${phase}：存在本次跨章边，且两端解析后章节不同（一端历史、一端本次候选）`,
        crossEdgesReal.length > 0,
        {
          crossEdges: crossEdgesReal.map((item) => ({
            edge: item.edgeKey,
            sourceChapterId: item.sourceChapterId,
            targetChapterId: item.targetChapterId,
          })),
          sameChapterEdges: crossEdges
            .filter((item) => !crossEdgesReal.includes(item))
            .map((item) => ({
              edge: item.edgeKey,
              sourceChapterId: item.sourceChapterId,
              targetChapterId: item.targetChapterId,
              historicalMixed: item.historicalMixed,
            })),
        },
      );
    }

    candidateIssues.forEach((issue) => {
      const issueId = issue.id;
      const hit = issues.find((item) => item.id === issueId);
      record(`${tag}.issue.${issueId}.present`, `${phase}：本次问题 ${issueId} 已落地正式图`, !!hit, {
        issueId,
      });
      if (!hit) return;
      const historical = beforeFacts.issues.find((item) => item.id === issueId) || null;
      const decidedDisposition = decided.get(issueId) ?? null;
      // 作者已决定：候选不得覆盖既有记录（mergeIssues 契约），期望值取历史原件。
      const expected = decidedDisposition ? historical : issue;
      const expectedNodeIds = (expected.nodeIds || []).map((id) => resolveNodeId(id, nodes));
      const expectedEdgeIds = (expected.edgeIds || []).map((id) => resolveEdgeId(id, facts));
      const nodeLinksOk =
        !expectedNodeIds.some((id) => !id) &&
        sortedKey(hit.nodeIds) === sortedKey(expectedNodeIds) &&
        hit.nodeIds.every((id) => nodeIds.has(id));
      const edgeLinksOk =
        !expectedEdgeIds.some((id) => !id) &&
        sortedKey(hit.edgeIds) === sortedKey(expectedEdgeIds) &&
        hit.edgeIds.every((id) => edgeIds.has(id));
      record(
        `${tag}.issue.${issueId}.links`,
        `${phase}：问题 ${issueId} 关联节点/边与${
          decidedDisposition ? "历史原件（作者已决定）" : "候选"
        }一致且可从正式图回查`,
        nodeLinksOk && edgeLinksOk,
        {
          expected: { nodeIds: expectedNodeIds, edgeIds: expectedEdgeIds },
          actual: { nodeIds: hit.nodeIds, edgeIds: hit.edgeIds },
        },
      );
      record(
        `${tag}.issue.${issueId}.fields`,
        decidedDisposition
          ? `${phase}：同 ID 历史问题 ${issueId} 的 kind/explanation/suggestion 保持原件，未被候选改写`
          : `${phase}：问题 ${issueId} 的 kind/explanation/suggestion 与候选一致`,
        hit.kind === expected.kind &&
          (hit.explanation ?? "") === (expected.explanation ?? "") &&
          (hit.suggestion ?? "") === (expected.suggestion ?? ""),
        {
          expected: {
            kind: expected.kind,
            explanation: expected.explanation,
            suggestion: expected.suggestion,
          },
          actual: { kind: hit.kind, explanation: hit.explanation, suggestion: hit.suggestion },
        },
      );
      const expectedDisposition = decidedDisposition ?? issue.disposition ?? "open";
      record(
        `${tag}.issue.${issueId}.disposition`,
        decidedDisposition
          ? `${phase}：同 ID 历史问题 ${issueId} 保持作者决定 ${expectedDisposition}，未被候选 open 覆盖`
          : `${phase}：问题 ${issueId} 以 open 状态落地`,
        hit.disposition === expectedDisposition,
        { expected: expectedDisposition, actual: hit.disposition },
      );
      // 问题证据从正式关联节点回查：不得依赖候选展示层 evidence，也不得指向空壳。
      // 已失效节点按契约保留原引文（本就与改后正文不一致），因此：
      //   - 未失效：引文必须与当前正文同区间逐字成立；
      //   - 已失效：必须仍带原引文与原 sourceHash（不改写、不掏空）。
      const issueNodes = hit.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
      record(
        `${tag}.issue.${issueId}.evidence`,
        `${phase}：问题 ${issueId} 的关联节点带可核出处（正式图回查）`,
        issueNodes.length === hit.nodeIds.length &&
          issueNodes.every((node) => {
            const evidence = node.evidence || {};
            const chapter = chapters.find((c) => c.id === evidence.chapterId);
            if (!chapter) return false;
            if (typeof evidence.quote !== "string" || !evidence.quote.length) return false;
            if (node.stale)
              return (
                typeof evidence.sourceHash === "string" &&
                evidence.sourceHash.length > 0 &&
                node.stale.expectedHash === evidence.sourceHash
              );
            return chapter.content.slice(evidence.start, evidence.end) === evidence.quote;
          }),
        {
          nodeIds: hit.nodeIds,
          evidence: issueNodes.map((n) => ({
            quote: n.evidence ? n.evidence.quote : null,
            stale: n.stale ? n.stale.reason : null,
          })),
        },
      );
    });

    for (const [issueId, disposition] of decided) {
      const hit = issues.find((item) => item.id === issueId);
      record(
        `${tag}.decision.${issueId}`,
        `${phase}：历史问题 ${issueId} 的作者决定 ${disposition} 未被重置`,
        !!hit && hit.disposition === disposition,
        { expected: disposition, actual: hit ? hit.disposition : null },
      );
    }

    // 采纳前该原点证据是否有效：只有“采纳前有效 → 本次失效”才算本次产生。
    // 采纳前就已 stale 的节点可以保留并核对，但不得满足新增失效前置。
    const validBefore = (node) => expectedStaleReason(node, beforeFacts.chapters) === null;
    // 采纳前本来就已失效的节点/关系可以保留核对，但不计入“本次产生”。
    const beforeStaleNodeIds = new Set(
      beforeFacts.nodes.filter((n) => !validBefore(n)).map((n) => n.id),
    );
    const beforeEdgeValid = (edge) =>
      expectedEdgeStale(edge, beforeStaleNodeIds, beforeFacts.chapters) === null;

    let changedCount = 0;
    let newlyStaleCount = 0;
    const preStaleCount = beforeFacts.nodes.filter((n) => !validBefore(n)).length;
    for (const node of beforeFacts.nodes) {
      const hit = nodes.find((item) => item.id === node.id);
      record(
        `${tag}.origin.${node.id}.present`,
        `${phase}：旧事件 ${node.id} 仍保留（不删除、不换 ID）`,
        !!hit,
        { nodeId: node.id },
      );
      if (!hit) continue;
      const evidence = hit.evidence || {};
      record(
        `${tag}.origin.${node.id}.evidence`,
        `${phase}：旧事件 ${node.id} 的原引文、原 sourceHash、原区间保留`,
        evidence.quote === node.evidence.quote &&
          evidence.sourceHash === node.evidence.sourceHash &&
          evidence.start === node.evidence.start &&
          evidence.end === node.evidence.end,
        { expected: node.evidence, actual: evidence },
      );
      const expected = expectedStaleReason(node, chapters);
      if (expected !== null) changedCount += 1;
      if (expected !== null && validBefore(node)) newlyStaleCount += 1;
      const stale = hit.stale || null;
      record(
        `${tag}.origin.${node.id}.stale`,
        expected === null
          ? `${phase}：旧事件 ${node.id} 未被误标失效`
          : `${phase}：旧事件 ${node.id} 失效原因=${expected}，expectedHash 为原 sourceHash`,
        expected === null
          ? stale === null
          : !!stale &&
            stale.reason === expected &&
            stale.expectedHash === node.evidence.sourceHash,
        { expected, actual: stale },
      );
    }
    // 历史关系保留：选定的旧关系不得由本次候选重新定义，也不能被删掉或换端点。
    const staleNodeSet = new Set(
      nodes.filter((item) => item.stale).map((item) => item.id),
    );
    for (const edge of beforeFacts.edges) {
      const hitEdge = edges.find((item) => item.id === edge.id);
      record(
        `${tag}.originEdge.${edge.id}.present`,
        `${phase}：历史关系 ${edge.id} 仍保留（不删除、不换 ID）`,
        !!hitEdge,
        { edgeId: edge.id },
      );
      if (!hitEdge) continue;
      record(
        `${tag}.originEdge.${edge.id}.preserved`,
        `${phase}：历史关系 ${edge.id} 的端点/类型/basis/说明与原证据按契约保留`,
        hitEdge.source === edge.source &&
          hitEdge.target === edge.target &&
          hitEdge.type === edge.type &&
          hitEdge.basis === edge.basis &&
          (hitEdge.explanation ?? "") === (edge.explanation ?? "") &&
          evidenceListKey(hitEdge.evidence) === evidenceListKey(edge.evidence) &&
          historicalEvidenceListKey(hitEdge.evidence) === historicalEvidenceListKey(edge.evidence) &&
          (hitEdge.evidence || []).every((item) => typeof item.sourceHash === "string") &&
          nodeIds.has(hitEdge.source) &&
          nodeIds.has(hitEdge.target),
        {
          expected: {
            source: edge.source,
            target: edge.target,
            type: edge.type,
            basis: edge.basis,
            evidence: edge.evidence,
          },
          actual: {
            source: hitEdge.source,
            target: hitEdge.target,
            type: hitEdge.type,
            basis: hitEdge.basis,
            evidence: hitEdge.evidence,
          },
        },
      );
      const edgeExpected = expectedEdgeStale(edge, staleNodeSet, chapters);
      const edgeStale = hitEdge.stale || null;
      record(
        `${tag}.originEdge.${edge.id}.stale`,
        edgeExpected === null
          ? `${phase}：历史关系 ${edge.id} 未被误标失效`
          : `${phase}：历史关系 ${edge.id} 按 impactOf 契约失效 reason=${edgeExpected.reason}`,
        edgeExpected === null
          ? edgeStale === null
          : !!edgeStale &&
            edgeStale.reason === edgeExpected.reason &&
            edgeStale.expectedHash === edgeExpected.expectedHash,
        { expected: edgeExpected, actual: edgeStale },
      );
      if (edgeExpected !== null && beforeEdgeValid(edge)) newlyStaleCount += 1;
    }

    // 本次候选关系：采纳后不得被误标失效（参考值同样来自 impactOf 契约）。
    candidateEdges.forEach((edge, index) => {
      const source = resolveNodeId(edge.source, nodes);
      const target = resolveNodeId(edge.target, nodes);
      const hitEdge = source && target
        ? edges.find(
            (item) =>
              item.source === source && item.target === target && item.type === edge.type,
          )
        : null;
      if (!hitEdge) return;
      const expected = expectedEdgeStale(hitEdge, staleNodeSet, chapters);
      const actual = hitEdge.stale || null;
      record(
        `${tag}.edge.${index}.stale`,
        expected === null
          ? `${phase}：本次关系 ${edge.type} 未被误标失效`
          : `${phase}：本次关系 ${edge.type} 按契约失效 reason=${expected.reason}`,
        expected === null
          ? actual === null
          : !!actual &&
            actual.reason === expected.reason &&
            actual.expectedHash === expected.expectedHash,
        { expected, actual },
      );
    });

    if (requireStaleChange) {
      record(
        `${tag}.stale.changed`,
        `${phase}：本次修订确实改变至少一条旧证据（失效判据非空）`,
        changedCount > 0,
        { changedCount },
      );
      // K2：必须是“采纳前有效 → 采纳后失效”的本次产生，不能用采纳前就已失效的旧节点充数。
      record(
        `${tag}.stale.newly`,
        `${phase}：本次产生“采纳前有效→采纳后失效”的证据变化（已有 stale 不计入）`,
        newlyStaleCount > 0,
        { newlyStaleCount, preStaleCount, changedCount },
      );
    }
  };

  phaseChecks(after, "after");
  if (restart) phaseChecks(restart, "restart");

  return finish();
}

module.exports = {
  createRunner,
  evaluateAcceptance,
  RESULT_PASS,
  RESULT_FAIL,
  RESULT_UNVERIFIED,
  REQUIRED_FIELDS,
};
