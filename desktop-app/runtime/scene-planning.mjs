import { z } from "zod";
import { workflowContract } from "./workflow-skill.mjs";
import { usesHighReasoning } from "./reasoning-budget.mjs";
import { appendCreationEvent } from "./creation-log.mjs";

export const SCENE_PLANNING_POLICY = "scene-low-outline-detail-1";
export function canMigrateScenePlanning(state, step) {
  return (
    usesHighReasoning(state) &&
    step?.contractId === "scene_plan" &&
    step.lastFailure?.kind === "output_limit" &&
    (step.reasoningPolicy !== SCENE_PLANNING_POLICY ||
      (step.logicalKey === `scene-plan:${SCENE_PLANNING_POLICY}` &&
        step.lastFailure.reasoningExhausted === true))
  );
}
const outlineContract = workflowContract(
  "scene_plan",
  z.object({
    scenes: z
      .array(
        z.object({
          goal: z.string().min(1).max(400),
          handoff: z.string().min(1).max(300),
        }),
      )
      .min(1)
      .max(16),
  }),
);

/** 只拆思考耗尽的场景规划。共享骨架和已完成细节按独立节点落盘。 */
export async function planScenes({
  state,
  ask,
  save,
  messages,
  validate,
  contract,
  count,
}) {
  // 正在写作的旧任务沿用已完成规划，不重规划或丢弃正文。
  if (state.values["scene-plan"]) return validate(state.values["scene-plan"]);
  if (!usesHighReasoning(state))
    return ask("scene-plan", messages, validate, 5000, "规划本章场景", {
      contract,
    });
  const options = {
    reasoningEffort: "low",
    reasoningPolicy: SCENE_PLANNING_POLICY,
  };
  try {
    const plan = await ask(
      `scene-plan:${SCENE_PLANNING_POLICY}`,
      messages,
      validate,
      5000,
      "规划本章场景",
      { ...options, contract },
    );
    state.values["scene-plan"] = plan;
    await save();
    return plan;
  } catch (error) {
    if (!error.reasoningExhausted) throw error;
  }
  appendCreationEvent(state, {
    category: "planning",
    status: "waiting",
    title: "场景规划思考耗尽，改为共享骨架后逐场细化",
    details: {
      场景数: count,
      策略: "保留成功节点，只恢复未完成部分；不增加相同请求的思考预算",
    },
  });
  await save();
  // 保留原有创作规则和完整事实材料，替换当前步骤要求，避免同时要求整章和单场输出。
  const taskMessages = (instruction, extra = {}) => [
    {
      role: "system",
      content:
        messages[0].content.split("\n为当前章设计")[0] + "\n" + instruction,
    },
    ...messages.slice(1).map((message) => {
      if (message.role !== "user") return message;
      const payload = JSON.parse(message.content);
      delete payload.timeRequirements;
      return { ...message, content: JSON.stringify(payload) };
    }),
    { role: "user", content: JSON.stringify(extra) },
  ];
  const outline = await ask(
    `scene-outline:${SCENE_PLANNING_POLICY}`,
    taskMessages(
      `只确定本章恰好${count}个场景的共同骨架，不写正文或完整细节。每场输出goal（行动、阻力、选择与后果）和handoff（与下一场的因果衔接、时间顺序和不可改变的事实约束）。遵守原有章纲、历史原文及人物知情边界；不补造过去事件或绝对日期。每项简洁表达。只输出{scenes:[{goal,handoff}]}。`,
    ),
    (value) => {
      if (value.scenes.length !== count)
        throw Error(`骨架必须包含${count}个场景`);
      return value;
    },
    3000,
    "规划本章共同骨架",
    { ...options, contract: outlineContract },
  );
  const scenes = [];
  for (let index = 0; index < count; index++) {
    const detail = await ask(
      `scene-detail:${SCENE_PLANNING_POLICY}:${index}`,
      taskMessages(
        `只细化第${index + 1}个场景，返回scenes数组且只含这一场，使用goal、knowledge及time字段。time包含start/gap/duration/end四个非空字符串。沿用整章共同骨架、已完成场景和事实材料，不改动其他场景的事件及衔接；交代行动、阻力、选择和后果。不得泄露人物未知秘密。未定日期使用相对时间，回忆区分事件时间和叙述时间。保持简洁，不写正文。`,
        {
          sharedOutline: outline.scenes,
          completedScenes: scenes,
          currentScene: index + 1,
        },
      ),
      (value) => {
        if (value.scenes.length !== 1 || !value.scenes[0].time)
          throw Error("本步骤只能细化一个场景，必须包含完整时间信息");
        return value;
      },
      2500,
      `细化场景 ${index + 1}/${count}`,
      { ...options, contract },
    );
    scenes.push(detail.scenes[0]);
  }
  const plan = validate({ scenes });
  state.values["scene-plan"] = plan;
  delete state.structuredFailure;
  await save();
  return plan;
}
