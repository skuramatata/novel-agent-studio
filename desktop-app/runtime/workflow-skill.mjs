import { readFileSync } from "node:fs";
import { z } from "zod";
import { createHash } from "node:crypto";

// 运行时必需资源：缺失即拒绝启动工作流，不降级为无约束提示。
const source = readFileSync(
  new URL("./skills/novel-workflow/SKILL.md", import.meta.url),
  "utf8",
);
if (!source.startsWith("---\nname: novel-workflow\n"))
  throw Error("小说 workflow skill 无效或缺失。");
const instructions = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
export const WORKFLOW_SKILL = Object.freeze({
  id: "novel-workflow",
  version: "workflow-contract-1",
  hash: createHash("sha256").update(source).digest("hex"),
});

const phases = Object.freeze({
  planning_intent: null,
  foundation: null,
  outlines: null,
  task_intent: null,
  scene_plan: null,
  memory_extract: null,
  proposal: null,
  prose: null,
  review: "review",
  continuity_review: "review",
  arbitration: "arbitration",
  grounding: "grounding",
  patch: "patch",
  verification: "verify",
  legacy_task: null,
  legacy_blueprint: null,
  legacy_review: null,
  legacy_draft: null,
});
const registered = new WeakSet();
const preparedMessages = new WeakMap();

function rejectUnknown(raw, parsed, path = "$") {
  if (!raw || typeof raw !== "object") return;
  if (Array.isArray(raw)) {
    raw.forEach((value, i) =>
      rejectUnknown(value, parsed?.[i], `${path}[${i}]`),
    );
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!parsed || !Object.hasOwn(parsed, key))
      throw Object.assign(
        Error(
          `模型输出含未声明字段 ${path}.${key}；只能填写当前阶段字段表，不能自行新增字段。`,
        ),
        { code: "MODEL_CONTRACT" },
      );
    rejectUnknown(raw[key], parsed[key], `${path}.${key}`);
  }
}
function shape(schema) {
  if (schema.anyOf || schema.oneOf)
    return (schema.anyOf || schema.oneOf).map(shape).join(" 或 ");
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join("|");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.type === "object")
    return `{${Object.entries(schema.properties || {})
      .map(
        ([key, value]) =>
          `${key}${schema.required?.includes(key) ? "" : "?"}:${shape(value)}`,
      )
      .join(",")}}`;
  if (schema.type === "array")
    return `数组<${shape(schema.items)}>${schema.maxItems ? `(最多${schema.maxItems}项)` : ""}`;
  return `${schema.type || "值"}${schema.maxLength ? `(最多${schema.maxLength}字)` : ""}`;
}
/** schema 同时生成模型字段表和接收校验，不再手工维护第二份字段清单。 */
export function workflowContract(id, schema, { displaySchema = schema } = {}) {
  if (!Object.hasOwn(phases, id) || id === "prose" || !schema?.parse)
    throw Error(`未注册的模型步骤：${id}`);
  const contract = Object.freeze({
    id,
    phase: phases[id],
    fields: shape(z.toJSONSchema(displaySchema)),
    parse(raw) {
      const parsed = schema.parse(raw);
      rejectUnknown(raw, parsed);
      return parsed;
    },
  });
  registered.add(contract);
  return contract;
}
export function requireWorkflowContract(contract) {
  if (!registered.has(contract))
    throw Object.assign(
      Error("模型调用未声明 workflow 阶段及输出契约，已阻止请求。"),
      { code: "WORKFLOW_CONTRACT" },
    );
  return contract;
}
export function workflowMessages(messages, contract) {
  requireWorkflowContract(contract);
  if (preparedMessages.has(messages)) {
    if (preparedMessages.get(messages) !== contract)
      throw Error("同一请求不能混用两个工作流阶段。");
    return messages;
  }
  const first = messages[0];
  if (first?.role !== "system") throw Error("工作流必须提供系统指令。");
  const prepared = [
    {
      ...first,
      content: `${first.content}\n\n[必需工作流技能 ${WORKFLOW_SKILL.version}]\n${instructions}\n当前步骤：${contract.id}。本步骤字段表（?表示可省略；这是类型说明，不是输出内容）：\n${contract.fields}\n严格只输出一个本步骤JSON对象，不另加字段。`,
    },
    ...messages.slice(1),
  ];
  preparedMessages.set(prepared, contract);
  return prepared;
}
export function proseWorkflowMessages(messages) {
  return [
    {
      ...messages[0],
      content: `${messages[0].content}\n\n[必需工作流技能 ${WORKFLOW_SKILL.version}]\n${instructions}\n当前步骤：prose。仅输出当前场景正文及约定完成标记，不输出JSON或工作流状态。`,
    },
    ...messages.slice(1),
  ];
}
export function assertWorkflowStage(state, contract) {
  requireWorkflowContract(contract);
  if (contract.phase && state.reviewWorkflow?.phase !== contract.phase)
    throw Object.assign(
      Error(`工作流阶段不匹配：${contract.id} 只能在 ${contract.phase} 执行。`),
      { code: "WORKFLOW_CONTRACT" },
    );
  const cycle = state.paragraphReview?.cycle;
  if (contract.id === "patch" && !cycle?.repairPlan)
    throw Error("工作流禁止跳过修订依据核对直接生成补丁。");
  if (contract.id === "verification" && !cycle?.patch)
    throw Error("工作流禁止在没有已保存补丁时进入复核。");
  state.workflowSkill = { ...WORKFLOW_SKILL };
}
