// 只读取归档失败任务，在独立目录验证真实场景规划；不写正式作品或运行中任务。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { planScenes } from "../runtime/scene-planning.mjs";
import { sceneTimeSchema } from "../runtime/continuity-schema.mjs";
import { workflowContract } from "../runtime/workflow-skill.mjs";
import { createStructuredAsker } from "../runtime/structured-step.mjs";
import { createBudgetProfile, ensureBudget } from "../runtime/model-budget.mjs";
import { fitWritingContext } from "../runtime/context-budget.mjs";
import { complete, readAuthorizedEnv } from "../runtime/providers.mjs";
const source = process.argv[2];
assert.ok(source, "需要传入归档任务路径");
const out = resolve(process.argv[3] || "verification/scene-planning");
const before = JSON.parse(await readFile(source, "utf8"));
const old = Object.values(before.structuredSteps).find(
  (s) => s.contractId === "scene_plan",
);
assert.ok(old, "需要场景规划步骤");
const messages = structuredClone(old.input);
messages[0].content = messages[0].content.split("\n\n[必需工作流技能")[0];
const count = Number(messages[0].content.match(/恰好(\d+)个连续场景/)[1]);
const config = {
  provider: before.provider,
  model: before.model,
  baseUrl: before.baseUrl,
  apiKey: (await readAuthorizedEnv())[before.provider]?.apiKey,
};
assert.ok(config.apiKey, "需要既有授权密钥");
const schema = z.object({
  scenes: z
    .array(
      z.object({
        goal: z.string().max(1000),
        knowledge: z.string().max(1000),
        time: sceneTimeSchema.optional(),
      }),
    )
    .min(1)
    .max(16),
});
const contract = workflowContract("scene_plan", schema);
const state = structuredClone(before);
state.status = "running";
const budget = createBudgetProfile(config, state.tokenBudget),
  calls = [];
await mkdir(out, { recursive: true });
const save = () =>
  writeFile(join(out, "checkpoint.json"), JSON.stringify(state), {
    mode: 0o600,
  });
const signal = AbortSignal.timeout(300000);
const ask = createStructuredAsker({
  state,
  budget,
  save,
  signal,
  call: async (input, tokens, label, partial, options) => {
    const selected = fitWritingContext(input, tokens, budget).messages;
    ensureBudget(selected, tokens, budget);
    const started = Date.now();
    console.log(
      JSON.stringify({ label, tokens, effort: options.reasoningEffort }),
    );
    const result = await complete(config, selected, signal, fetch, tokens, {
      ...options,
      allowPartial: partial,
    });
    calls.push({
      label,
      tokens,
      effort: options.reasoningEffort,
      elapsedMs: Date.now() - started,
      finishReason: result.finishReason,
      usage: result.usage,
    });
    await writeFile(join(out, "calls.json"), JSON.stringify(calls, null, 2));
    return result;
  },
});
const result = await planScenes({
  state,
  ask,
  save,
  messages,
  count,
  contract,
  validate: (raw) => {
    const value = schema.parse(raw);
    assert.equal(value.scenes.length, count);
    assert.ok(value.scenes.every((s) => s.time));
    return value;
  },
});
await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    { success: true, scenes: result.scenes.length, calls },
    null,
    2,
  ),
);
