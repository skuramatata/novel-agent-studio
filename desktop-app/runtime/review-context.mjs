import { createHash } from "node:crypto";
import { estimatedTokens, ensureBudget } from "./model-budget.mjs";
import { stageInputLimit, requestOutput } from "./model-capabilities.mjs";
import { modelDocument } from "./review-payload.mjs";
import { validationReason } from "./structured.mjs";
import { REVIEW_RESULT_VERSION, remapReviewChecks } from "./review-result.mjs";
import { workflowMessages } from "./workflow-skill.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const id = (s, p) => `${s}:${p}`;
const rowsOf = (doc) =>
  doc.sources.flatMap((s) =>
    s.paragraphs.map((p) => ({
      source: s,
      row: p,
      id: id(s.sourceId, p.paragraph),
    })),
  );
function addresses(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (typeof value.sourceId === "string" && Number.isInteger(value.paragraph))
    result.push(value);
  for (const child of Object.values(value))
    if (typeof child === "object") addresses(child, result);
  return result;
}
function project(doc, selected) {
  const sources = doc.sources.flatMap((source) => {
    const paragraphs = source.paragraphs.filter((p) =>
      selected.has(id(source.sourceId, p.paragraph)),
    );
    return paragraphs.length
      ? [
          {
            ...source,
            paragraphs,
            text: paragraphs.map((p) => p.text).join("\n\n"),
          },
        ]
      : [];
  });
  return {
    ...doc,
    sources,
    coverage: {
      documentVersion: doc.version,
      supplied: [...selected].sort(),
      totalParagraphs: rowsOf(doc).length,
      policy:
        "仅检查本批提供的原文；段号和句号沿用原文。未提供的内容不能判断为不存在。",
    },
  };
}
export function assertVisibleReferences(value, view) {
  for (const ref of addresses(value)) {
    const row = view.sources
      .find((s) => s.sourceId === ref.sourceId)
      ?.paragraphs.find((p) => p.paragraph === ref.paragraph);
    if (
      !row ||
      (ref.sentence !== undefined &&
        !row.sentences.some((s) => s.sentence === ref.sentence))
    ) {
      const source = view.sources.find((s) => s.sourceId === ref.sourceId);
      const available = source
        ? row
          ? `该段提供的句号为：${row.sentences.map((s) => s.sentence).join("、")}`
          : `该来源本批提供的段号为：${source.paragraphs.map((p) => p.paragraph).join("、")}`
        : `本批sourceId只能是：${view.sources.map((s) => s.sourceId).join("、")}`;
      throw Error(
        `引用不在本次提供的原文范围：${ref.sourceId} 第${ref.paragraph}段。${available.slice(0, 700)}。只复制document中的实际编号，不能按分批位置重新编号。timeAnchors、relatedFacts及sceneTimes不是正文来源；请回查其references与本批document，无法定位时不能编造引用。`,
      );
    }
  }
  return value;
}
function pinnedRows(doc, values) {
  const available = new Set(rowsOf(doc).map((r) => r.id));
  return new Set(
    addresses(values)
      .map((r) => id(r.sourceId, r.paragraph))
      .filter((k) => available.has(k)),
  );
}
export function batchReviewDocuments(
  doc,
  messagesFor,
  { profile, output = 6500, stage = "review", pins = [] } = {},
) {
  output = requestOutput(output, profile);
  const limit = stageInputLimit(profile, output, stage);
  if (estimatedTokens(messagesFor(doc), profile) <= limit) return [doc];
  const rows = rowsOf(doc),
    mandatory = pinnedRows(doc, pins);
  const size = (selected) =>
    estimatedTokens(messagesFor(project(doc, selected)), profile);
  const baseline = size(mandatory);
  if (baseline >= limit)
    throw Object.assign(
      Error("作者裁定与必需证据已超出单批审稿预算，原文和任务均已保留。"),
      { code: "CONTEXT_BUDGET" },
    );
  // 当前章能完整装入时，在每批共享整章，只轮换历史原文；避免无谓的场景笛卡尔积。
  const shared = new Set([
    ...mandatory,
    ...rows.filter((r) => r.source.editable).map((r) => r.id),
  ]);
  if (size(shared) < limit - 1000) {
    const views = [];
    let selected = new Set(shared),
      possible = true;
    for (const row of rows.filter((r) => !shared.has(r.id))) {
      selected.add(row.id);
      if (size(selected) <= limit) continue;
      selected.delete(row.id);
      if (selected.size > shared.size) views.push(project(doc, selected));
      selected = new Set([...shared, row.id]);
      if (size(selected) > limit) {
        possible = false;
        break;
      }
    }
    if (possible) {
      if (selected.size > shared.size) views.push(project(doc, selected));
      return views.length ? views : [project(doc, shared)];
    }
  }
  // 分块后两两组合：覆盖每个当前章段落与其余已提供段落，保留跨场景检查。
  // 与截断历史不同，所有原始审稿来源都会在至少一批出现。
  let quota = Math.max(128, Math.floor((limit - baseline) / 3));
  for (
    let attempt = 0;
    attempt < 12;
    attempt++, quota = Math.floor(quota / 2)
  ) {
    const groups = [];
    let current = [],
      cost = 0;
    for (const row of rows.filter((r) => !mandatory.has(r.id))) {
      const n =
        estimatedTokens([{ role: "user", content: row.row.text }], profile) -
        estimatedTokens([{ role: "user", content: "" }], profile) +
        32;
      if (current.length && cost + n > quota) {
        groups.push(current);
        current = [];
        cost = 0;
      }
      current.push(row);
      cost += n;
    }
    if (current.length) groups.push(current);
    if (!groups.length) return [project(doc, mandatory)];
    const targets = groups.filter((g) => g.some((r) => r.source.editable));
    const pairs = targets.length
      ? targets.flatMap((a) => groups.map((b) => [...a, ...b]))
      : groups;
    // 当前章全部被裁定引用覆盖时，仍逐批检查全部历史。
    const unique = new Map();
    for (const pair of pairs) {
      const selected = new Set([...mandatory, ...pair.map((r) => r.id)]);
      const view = project(doc, selected);
      unique.set(hash(view.coverage.supplied), view);
    }
    const views = [...unique.values()];
    if (
      views.every(
        (view) => estimatedTokens(messagesFor(view), profile) <= limit,
      )
    )
      return views;
    if (groups.every((g) => g.length <= 1)) break;
  }
  throw Object.assign(
    Error(
      "单个原文段落及必要证据无法装入审稿预算，请拆分该长段或调整模型预算。",
    ),
    { code: "CONTEXT_BUDGET" },
  );
}
export async function runReviewBatches({
  doc,
  messagesFor: inputMessagesFor,
  validate,
  ask,
  key,
  label,
  profile,
  pins = [],
  output = 6500,
  stage = "review",
  state,
  save,
  contract,
}) {
  const messagesFor = contract
    ? (view) => workflowMessages(inputMessagesFor(view), contract)
    : inputMessagesFor;
  output = requestOutput(output, profile);
  const views = batchReviewDocuments(doc, messagesFor, {
    profile,
    output,
    stage,
    pins,
  });
  const results = [];
  const coverageKey = hash([
    key.replace(/:workflow-1:retry-\d+/g, ""),
    doc.version,
  ]);
  if (views.length > 1 && state) {
    state.reviewCoverage ??= {};
    state.reviewCoverage[coverageKey] = {
      documentVersion: doc.version,
      total: views.length,
      completed: 0,
      paragraphs: rowsOf(doc).length,
    };
  }
  for (const [index, view] of views.entries()) {
    const messages = messagesFor(view);
    ensureBudget(messages, output, profile);
    const validateResult = (value) => {
      const failures = [];
      let result;
      try {
        assertVisibleReferences(value, view);
      } catch (error) {
        failures.push(validationReason(error));
      }
      try {
        result = validate(value, view);
      } catch (error) {
        failures.push(validationReason(error));
      }
      if (failures.length) throw Error([...new Set(failures)].join("\n"));
      return result;
    };
    const result = await ask(
      views.length === 1 ? key : `bounded-review-1:${hash(messages)}`,
      messages,
      (value) => {
        validateResult(value);
        return value;
      },
      output,
      views.length === 1
        ? label
        : `${label} · 分批 ${index + 1}/${views.length}`,
      { maxCorrections: 2, contract },
    );
    results.push(validateResult(result));
    if (views.length > 1 && state) {
      state.reviewCoverage[coverageKey].completed = index + 1;
      await save?.();
    }
  }
  if (results.length === 1) return results[0];
  const issues = new Map(),
    priors = new Map(),
    authors = new Map();
  for (const result of results) {
    for (const issue of result.issues) {
      const k = hash([issue.kind, issue.target, issue.evidence]);
      // 分批未见前情不能自动删除事实；独立核对/作者裁定继续处理。
      issues.set(k, {
        ...issue,
        ...(issue.kind === "missing_history" && issue.blocking
          ? { resolution: "needs_confirmation" }
          : {}),
      });
    }
    for (const p of result.priorFindings || [])
      if (!priors.has(p.id) || p.decision !== "dismissed") priors.set(p.id, p);
    for (const a of result.authorChecks || [])
      if (!authors.has(a.id) || !a.respected) authors.set(a.id, a);
  }
  const mergedIssues = [...issues.values()].map((issue, i) => ({
    ...issue,
    id: `batch-${doc.version.slice(0, 12)}-${i + 1}`,
  }));
  const mergedIds = new Map(
    [...issues.keys()].map((key, i) => [key, mergedIssues[i].id]),
  );
  return {
    reviewResultVersion: REVIEW_RESULT_VERSION,
    issues: mergedIssues,
    priorFindings: [...priors.values()],
    authorChecks: [...authors.values()],
    continuityChecks: results.flatMap(
      (r) =>
        remapReviewChecks(
          r.continuityChecks,
          new Map(
            r.issues.map((i) => [
              i.id,
              mergedIds.get(hash([i.kind, i.target, i.evidence])),
            ]),
          ),
        ) || [],
    ),
    suppliedScopes: results.flatMap((r) =>
      r.suppliedScope ? [r.suppliedScope] : [],
    ),
    batchCoverage: { total: views.length, completed: results.length },
  };
}

function terms(text) {
  return new Set(
    (text.match(/[\p{L}\p{N}]+/gu) || []).flatMap((t) =>
      [...t].slice(1).map((_, i) => t.slice(i, i + 2)),
    ),
  );
}
export function localReviewDocument(
  doc,
  issues,
  constraints = [],
  { profile, output = 5500, stage = "grounding", messagesFor } = {},
) {
  const rows = rowsOf(doc),
    required = pinnedRows(doc, [issues, constraints]);
  // 预算以最终发送的字段和工作流指令为准，不重复扣除本地问题快照里的引文。
  const limit = stageInputLimit(profile, requestOutput(output, profile), stage);
  const request =
    messagesFor ||
    ((view) => [
      {
        role: "user",
        content: JSON.stringify({
          document: modelDocument(view),
          issues,
          constraints,
        }),
      },
    ]);
  const selected = new Set(required);
  const size = () => estimatedTokens(request(project(doc, selected)), profile);
  if (size() > limit)
    throw Object.assign(
      Error(
        `本组问题的必需原文与指令超过局部${stage === "patch" ? "修订" : "核对"}预算：输入估算${size()}，本阶段上限${limit}。草稿、证据与作者裁定已保留。`,
      ),
      {
        code: "CONTEXT_BUDGET",
        inputEstimate: size(),
        limit,
        issueIds: issues.map((i) => i.id),
      },
    );
  const include = (rowId) => {
    if (selected.has(rowId)) return;
    selected.add(rowId);
    if (size() > limit) selected.delete(rowId);
  };
  // 邻段优先回查，但不能挤占明确引用与作者事实；没提供的段落不算已检查。
  for (const row of rows)
    if (required.has(row.id)) {
      for (const p of row.source.paragraphs)
        if (Math.abs(p.paragraph - row.row.paragraph) <= 1)
          include(id(row.source.sourceId, p.paragraph));
    }
  const query = terms(JSON.stringify(issues));
  const ranked = rows
    .filter((r) => !selected.has(r.id))
    .map((r) => ({
      ...r,
      score: [...terms(r.row.text)].filter((t) => query.has(t)).length,
    }))
    .sort((a, b) => b.score - a.score);
  for (const row of ranked) {
    if (!row.score) continue;
    include(row.id);
  }
  return project(doc, selected);
}

export function issueGroups(issues, size = 4) {
  const components = [];
  for (const issue of issues) {
    const keys = new Set(
      [
        issue.target,
        ...(issue.allowedTargets || []),
        ...(issue.repairTargets || []),
      ]
        .filter(Boolean)
        .map((r) => id(r.sourceId, r.paragraph)),
    );
    const connected = components.filter((c) =>
      [...keys].some((k) => c.keys.has(k)),
    );
    const merged = { issues: [issue], keys };
    for (const c of connected) {
      merged.issues.push(...c.issues);
      for (const k of c.keys) merged.keys.add(k);
      components.splice(components.indexOf(c), 1);
    }
    components.push(merged);
  }
  const groups = [];
  for (const c of components) {
    const last = groups.at(-1);
    if (last && last.length + c.issues.length <= size) last.push(...c.issues);
    else groups.push(c.issues);
  }
  return groups;
}
export async function runLocalTasks({
  doc,
  issues,
  constraints,
  profile,
  output,
  stage,
  key,
  label,
  ask,
  messagesFor,
  validate,
  merge,
  maxCorrections = 1,
  contract,
}) {
  const groups = profile ? issueGroups(issues) : [issues];
  const results = [];
  const tasks = [];
  const prepare = (group) => {
    let view, messages;
    const request = (view) => {
      const messages = messagesFor(view, group);
      return contract ? workflowMessages(messages, contract) : messages;
    };
    try {
      view = profile
        ? localReviewDocument(doc, group, constraints, {
            profile,
            output,
            stage,
            messagesFor: request,
          })
        : doc;
      messages = request(view);
      ensureBudget(messages, requestOutput(output, profile), profile);
    } catch (error) {
      if (error.code !== "CONTEXT_BUDGET") throw error;
      let smaller = issueGroups(group, 1);
      // 核对与复核逐项产出决定，可以拆开共用段落的问题；补丁仍按关联段落原子生成。
      if (
        smaller.length === 1 &&
        group.length > 1 &&
        ["grounding", "verify", "arbitrate"].includes(stage)
      ) {
        const middle = Math.ceil(group.length / 2);
        smaller = [group.slice(0, middle), group.slice(middle)];
      }
      if (smaller.length > 1) {
        for (const part of smaller) prepare(part);
        return;
      }
      error.message +=
        stage === "patch" && group.length > 1
          ? `关联问题（${group.map((i) => i.id).join("、")}）共用修改段落，不能生成互相覆盖的独立补丁；需缩小本次修订范围。`
          : `问题（${group.map((i) => i.id).join("、")}）已无法继续拆批，需缩小该问题的处理范围。`;
      throw error;
    }
    tasks.push({ group, view, messages });
  };
  // 先确认所有批次可执行，避免前几组已请求后才发现后组确定超限。
  for (const group of groups) prepare(group);
  for (const { group, view, messages } of tasks) {
    const validateResult = (value) => {
      const failures = [];
      let result;
      try {
        assertVisibleReferences(value, view);
      } catch (error) {
        failures.push(validationReason(error));
      }
      try {
        result = validate(value, group, view);
      } catch (error) {
        failures.push(validationReason(error));
      }
      if (failures.length) throw Error([...new Set(failures)].join("\n"));
      return result;
    };
    const raw = await ask(
      profile ? `local-context-1:${hash(messages)}` : key,
      messages,
      (value) => {
        validateResult(value);
        return value;
      },
      requestOutput(output, profile),
      tasks.length > 1
        ? `${label} · 问题组 ${results.length + 1}/${tasks.length}`
        : label,
      { maxCorrections, contract },
    );
    results.push(validateResult(raw));
  }
  return merge(results);
}
