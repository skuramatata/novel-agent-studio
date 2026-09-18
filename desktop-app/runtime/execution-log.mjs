import { stageCategory } from "./creation-log.mjs";

// 只保存请求体与可见回答，不接收供应商配置、认证头或思考内容。
export function beginModelRecord(state, { label, input, stepId, outputKey }) {
  const record = {
    id: `call-${state.calls}`,
    nodeId: stepId ? `step:${stepId}` : `prose:${outputKey || label}`,
    stepId,
    outputKey,
    label,
    category: stageCategory(label),
    startedAt: new Date().toISOString(),
    status: "running",
    input: structuredClone(input),
  };
  (state.modelCalls ??= []).push(record);
  return record;
}

export function recordModelAcceptance(
  state,
  callId,
  validation,
  acceptedOutput,
  outputKey,
) {
  const record = state.modelCalls?.find((item) => item.id === callId);
  if (!record) return;
  record.validation = structuredClone(validation);
  record.status = validation.passed ? "success" : "failed";
  if (acceptedOutput !== undefined)
    record.acceptedOutput = structuredClone(acceptedOutput);
  else delete record.acceptedOutput;
  if (outputKey) record.resultKey = outputKey;
}

export async function traceOperation(state, { key, label, input }, run, save) {
  const record = {
    id: `operation-${(state.logOperations?.length || 0) + 1}`,
    nodeId: `operation:${key}`,
    label,
    category: stageCategory(label),
    startedAt: new Date().toISOString(),
    status: "running",
    input: structuredClone(input),
  };
  (state.logOperations ??= []).push(record);
  await save();
  try {
    const output = await run();
    record.acceptedOutput = structuredClone(output);
    record.status = "success";
    record.endedAt = new Date().toISOString();
    await save();
    return output;
  } catch (error) {
    record.status = error.name === "AbortError" ? "interrupted" : "failed";
    record.error = error.message;
    record.endedAt = new Date().toISOString();
    await save();
    throw error;
  }
}

// 展示层脱敏不回写旧检查点；没有采集的数据绝不根据当前提示词补造。
function redact(value) {
  let changed = false;
  const walk = (item) => {
    if (typeof item === "string") {
      const clean = item
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "[思考内容未展示]")
        .replace(/Bearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
        .replace(
          /((?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
          "$1[已隐藏]",
        );
      changed ||= clean !== item;
      return clean;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, val]) => {
          if (
            /^(api_?key|authorization|access_?token|reasoning_content|reasoning_details)$/i.test(
              key,
            )
          ) {
            changed = true;
            return [key, "[已隐藏]"];
          }
          return [key, walk(val)];
        }),
      );
    return item;
  };
  const result = walk(value);
  return { result, changed };
}

function attempt(record, active) {
  return {
    ...record,
    status:
      record.status === "running" && !active ? "interrupted" : record.status,
    requestNote: record.request
      ? "实际发送的请求体；不包含认证头"
      : "最终模型请求未采集",
    rawNote:
      record.rawOutput !== undefined
        ? record.partial
          ? "中断前收到的部分回答，未接收为结果"
          : "模型可见回答；不包含隐藏思考"
        : "原始响应未采集或尚未收到",
  };
}

/** 将真实检查点投影为节点；返回的 detail 只在选中节点时通过 IPC 传输。 */
export function executionNodes(state, events, active = false) {
  const nodes = [];
  const calls = state.modelCalls || [];
  const add = (node) => {
    const { result, changed } = redact(node);
    result.redacted = changed;
    nodes.push(result);
  };
  for (const step of Object.values(state.structuredSteps || {})) {
    const recorded = calls.filter((call) => call.stepId === step.id);
    const recordedRawKeys = new Set(
      recorded.map((call) => call.rawKey).filter(Boolean),
    );
    const legacy = Object.entries(state.responseMeta || {})
      .filter(
        ([key, meta]) => meta.stepId === step.id && !recordedRawKeys.has(key),
      )
      .map(([key, meta]) => {
        const validation =
          step.validations?.[key] ||
          (step.lastFailure?.rawKey === key
            ? {
                passed: false,
                stage: step.lastFailure.kind,
                detail: step.lastFailure.detail,
              }
            : step.status === "succeeded" && step.rawKey === key
              ? { passed: true, detail: "已保存的节点结果通过校验" }
              : undefined);
        return attempt(
          {
            id: key,
            rawKey: key,
            rawOutput: state.fragments?.[key],
            responseMeta: meta,
            validation,
            status: validation
              ? validation.passed
                ? "success"
                : "failed"
              : "unknown",
            ...(validation?.passed &&
            step.resultKey &&
            (!state.structuredResults?.[step.resultKey] ||
              state.structuredResults[step.resultKey] === step.id) &&
            Object.hasOwn(state.values || {}, step.resultKey)
              ? {
                  acceptedOutput: state.values[step.resultKey],
                  outputKey: step.resultKey,
                }
              : {}),
          },
          active,
        );
      });
    const attempts = [
      ...legacy,
      ...recorded.map((record) => attempt(record, active)),
    ];
    const resultKey =
      step.resultKey ||
      Object.keys(state.structuredResults || {}).find(
        (key) => state.structuredResults[key] === step.id,
      );
    const latest = attempts.at(-1);
    add({
      id: `step:${step.id}`,
      label: step.label,
      kind: "model",
      category: stageCategory(step.label),
      status:
        step.status === "succeeded"
          ? "success"
          : ["exhausted", "correcting"].includes(step.status)
            ? "failed"
            : latest?.status || (active ? "running" : "interrupted"),
      startedAt: recorded[0]?.startedAt || null,
      input: step.input,
      inputNote: "节点基础消息；最终裁剪及纠错后的内容见每次尝试的模型请求",
      contract: step.contractId,
      outputKey: resultKey || step.logicalKey,
      acceptedOutput:
        step.status === "succeeded" &&
        resultKey &&
        (!state.structuredResults?.[resultKey] ||
          state.structuredResults[resultKey] === step.id)
          ? state.values?.[resultKey]
          : undefined,
      attempts,
      reuses: step.reuses || [],
      error: step.lastFailure?.detail,
      source: "结构化节点检查点",
    });
  }
  for (const record of calls.filter((call) => !call.stepId)) {
    let node = nodes.find((item) => item.id === record.nodeId);
    if (!node) {
      add({
        id: record.nodeId,
        label: record.label,
        kind: "model",
        category: record.category,
        startedAt: record.startedAt,
        input: record.input,
        inputNote: "调用前的节点消息，实际发送内容见模型请求",
        outputKey: record.outputKey,
        attempts: [],
        source: "模型调用记录",
      });
      node = nodes.at(-1);
    }
    const { result, changed } = redact(attempt(record, active));
    node.redacted ||= changed;
    node.attempts.push(result);
    node.status = result.status;
    if (Object.hasOwn(result, "acceptedOutput"))
      node.acceptedOutput = result.acceptedOutput;
  }
  for (const record of state.logOperations || []) {
    let node = nodes.find((item) => item.id === record.nodeId);
    if (!node) {
      add({
        id: record.nodeId,
        label: record.label,
        kind: "program",
        category: record.category,
        startedAt: record.startedAt,
        input: record.input,
        attempts: [],
        source: "程序节点记录",
      });
      node = nodes.at(-1);
    }
    const { result, changed } = redact(attempt(record, active));
    node.redacted ||= changed;
    node.attempts.push(result);
    node.status = result.status;
    node.acceptedOutput = result.acceptedOutput;
  }
  for (const [graphKey, graph] of Object.entries(state.graphs || {})) {
    const shape = graph.shape
      ? JSON.parse(graph.shape)
      : Object.keys(graph.nodes || {}).map((id) => ({ id, deps: [] }));
    for (const item of shape) {
      const record = graph.nodes[item.id];
      if (!record) continue;
      const modelNode = nodes.find(
        (node) =>
          state.structuredSteps?.[node.id.slice(5)]?.logicalKey ===
          `${graphKey}:${item.id}`,
      );
      const nodeId = modelNode?.id || `dag:${graphKey}:${item.id}`;
      if (!modelNode)
        add({
          id: nodeId,
          label:
            item.id === "foundation"
              ? "规划图 · 复用基础设定"
              : item.id === "candidate"
                ? "规划图 · 汇总候选"
                : item.id,
          kind: "program",
          category: "planning",
          status:
            record.status === "completed"
              ? "success"
              : record.status === "running" && !active
                ? "interrupted"
                : record.status,
          input: record.input,
          acceptedOutput: record.output,
          error: record.error,
          startedAt: record.startedAt || null,
          attempts: [],
          reuses: record.reuses || [],
          source: "规划 DAG 检查点",
        });
      const target = nodes.find((node) => node.id === nodeId);
      target.dependencies = item.deps.map(
        (dep) =>
          nodes.find(
            (node) =>
              state.structuredSteps?.[node.id.slice(5)]?.logicalKey ===
              `${graphKey}:${dep}`,
          )?.id || `dag:${graphKey}:${dep}`,
      );
    }
  }
  // 历史正文片段没有模型调用记录，仍展示实际原文，缺失项保持缺失。
  const tracedProse = new Set(
    calls.filter((call) => !call.stepId).map((call) => call.outputKey),
  );
  for (const [key, value] of Object.entries(state.fragments || {})) {
    if (!/^raw-(scene|repair):/.test(key)) continue;
    if (
      [...tracedProse].some(
        (outputKey) =>
          key.startsWith(`raw-scene:${outputKey}:`) ||
          key.startsWith(`raw-repair:${outputKey}:`),
      )
    )
      continue;
    add({
      id: `fragment:${key}`,
      label: `历史正文输出 · ${key.replace(/^raw-/, "")}`,
      kind: "model",
      category: "writing",
      status: "unknown",
      startedAt: null,
      source: "历史正文片段",
      attempts: [
        attempt(
          {
            id: key,
            rawOutput: value,
            responseMeta: state.responseMeta?.[key],
            status: "unknown",
          },
          active,
        ),
      ],
    });
  }
  if (
    state.retrievedContext &&
    !nodes.some((node) => node.id === "operation:retrieval")
  )
    add({
      id: "legacy:retrieval",
      label: "本地混合检索结果",
      kind: "program",
      category: "memory",
      status: "success",
      acceptedOutput: state.retrievedContext,
      startedAt: null,
      attempts: [],
      source: "历史检索存档，输入未采集",
    });
  for (const [key, value] of Object.entries(state.values || {})) {
    if (!/^final-scene:\d+$/.test(key)) continue;
    add({
      id: `saved:${key}`,
      label: `场景 ${Number(key.split(":")[1]) + 1} · 已保存正文`,
      kind: "program",
      category: "writing",
      status: "success",
      acceptedOutput: value,
      outputKey: key,
      startedAt: null,
      attempts: [],
      source: "当前检查点中已保存的正文",
    });
  }
  if (!nodes.length)
    for (const event of events)
      add({
        id: `event:${event.id}`,
        label: event.title,
        kind: "event",
        category: event.category,
        status: event.status,
        startedAt: event.at,
        details: event.details,
        attempts: [],
        source: "历史事件摘要，详细输入输出未采集",
      });
  return nodes.sort((a, b) =>
    a.startedAt && b.startedAt
      ? a.startedAt.localeCompare(b.startedAt)
      : a.startedAt
        ? -1
        : b.startedAt
          ? 1
          : 0,
  );
}

export function executionGraph(nodes, { category, query, onlyProblems } = {}) {
  const matched = nodes.filter(
    (node) =>
      (!category || node.category === category) &&
      (!onlyProblems ||
        ["failed", "interrupted", "waiting"].includes(node.status) ||
        node.attempts.some((item) =>
          ["failed", "interrupted"].includes(item.status),
        )) &&
      (!query ||
        JSON.stringify(node)
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  const ids = new Set(matched.map((node) => node.id));
  const edges = matched.flatMap((node) =>
    (node.dependencies || [])
      .filter((id) => ids.has(id))
      .map((id) => ({
        id: `${id}->${node.id}`,
        source: id,
        target: node.id,
        kind: "dependency",
      })),
  );
  // 只有已记录时间的调用才展示先后关系；未采集历史关系时不编造连线。
  const timed = matched.filter((node) => node.startedAt);
  for (let i = 1; i < timed.length; i++) {
    const previous = timed[i - 1],
      next = timed[i];
    if (previous.startedAt === next.startedAt) continue;
    if (
      !edges.some(
        (edge) => edge.source === previous.id && edge.target === next.id,
      )
    )
      edges.push({
        id: `order:${previous.id}->${next.id}`,
        source: previous.id,
        target: next.id,
        kind: "sequence",
      });
  }
  return {
    nodes: matched.map(
      ({ id, label, kind, category, status, startedAt, attempts, source }) => ({
        id,
        label,
        kind,
        category,
        status,
        startedAt,
        source,
        attemptCount: attempts.length,
        hasProblems: attempts.some((item) =>
          ["failed", "interrupted"].includes(item.status),
        ),
      }),
    ),
    edges,
    total: nodes.length,
  };
}
