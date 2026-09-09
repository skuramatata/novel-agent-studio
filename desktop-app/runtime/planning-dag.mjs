import { z } from "zod";
import { runDag } from "./dag.mjs";
import {
  planSchema,
  characterSchema,
  relationSchema,
  applyProposal,
} from "./schema.mjs";
const intentSchema = z.object({
  mode: z.enum(["prepare", "legacy"]),
  chapterCount: z.number().int().min(1).max(200).nullable(),
  chapterWords: z.number().int().min(100).max(10000).nullable(),
  countEvidence: z.string(),
  wordsEvidence: z.string(),
});
export function validatePlanningIntent(input, instruction, premise) {
  const value = intentSchema.parse(input);
  for (const [field, evidence] of [
    ["chapterCount", "countEvidence"],
    ["chapterWords", "wordsEvidence"],
  ]) {
    // 模型有时会把作品中的已有规模复制为本次提取结果。
    // 相同值没有修改效果，统一作为沿用设置；新值仍必须有请求依据。
    if (value[field] === null || value[field] === premise[field]) {
      value[field] = null;
      value[evidence] = "";
    } else if (
      !value[evidence].trim() ||
      !instruction.includes(value[evidence])
    ) {
      throw Error(
        `${field} 的新规模缺少本次请求原文依据。只从 instruction 提取明确指定的规模；未指定时 ${field}=null、${evidence}=""，沿用已有设置。不得引用作品配置或格式示例。本次请求：${instruction}`,
      );
    }
  }
  return value;
}
function appendNewRecords(existing, proposed = []) {
  if (new Set(proposed.map((row) => row.id)).size !== proposed.length)
    throw Error("模型返回了重复的人物或关系标识，请保持每个ID唯一。");
  const ids = new Set(existing.map((row) => row.id));
  return [...existing, ...proposed.filter((row) => !ids.has(row.id))];
}
const batchSchema = z
  .object({
    chapters: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            title: z.string().min(1).max(120),
            summary: z.string().min(1).max(1200),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export function selectOutlineBatch(value, numbers, total) {
  const parsed = batchSchema.parse(value);
  const ids = parsed.chapters.map((c) => c.number);
  if (new Set(ids).size !== ids.length)
    throw Error("模型返回了重复章号，无法确定使用哪份章纲。");
  if (ids.some((n) => n > total)) throw Error("模型返回了超出全书范围的章号。");
  const chapters = numbers.map((n) =>
    parsed.chapters.find((c) => c.number === n),
  );
  if (chapters.some((c) => !c))
    throw Error(`模型遗漏本节点章纲，必须包含第${numbers.join("、")}章。`);
  return { chapters };
}
export async function runPlanningDag(
  p,
  instruction,
  { ask, state, save, signal },
) {
  const { chapterCount, chapterWords, ...storyPremise } = p.premise;
  const intent = await ask(
    "planning-intent-v1",
    [
      {
        role: "system",
        content:
          '识别规划入口。只输出短JSON，不写故事。用户要求生成/开始创作/按某章节数量和字数来时mode=prepare；纯讨论、只改档案、重写既有规划时mode=legacy。只从 instruction 提取本次明确指定的章数和每章字数，不从作品配置或格式示例推断；未指定的字段必须为null，应用会自动沿用已有设置。countEvidence/wordsEvidence必须是包含该数量的 instruction 逐字原文片段，未指定则空串。只要求生成大纲、人物关系和章节计划并没有指定规模。默认格式：{"mode":"prepare","chapterCount":null,"chapterWords":null,"countEvidence":"","wordsEvidence":""}。例如 instruction 为“按12个章节，每章5000字来”才返回chapterCount=12、chapterWords=5000及对应逐字片段。',
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction,
          premise: storyPremise,
          hasPlan: !!p.plan.outline,
          hasChapters: p.chapters.length > 0,
        }),
      },
    ],
    (v) => validatePlanningIntent(v, instruction, p.premise),
    1200,
    "识别创作规模与规划任务",
  );
  if (intent.mode === "legacy") return { legacy: true };
  const premise = {
    ...p.premise,
    ...(intent.chapterCount !== null
      ? { chapterCount: intent.chapterCount }
      : {}),
    ...(intent.chapterWords !== null
      ? { chapterWords: intent.chapterWords }
      : {}),
  };
  if (p.chapters.length > premise.chapterCount)
    throw Error("目标章节数少于现有章节，不能自动删除已有章节；请先调整章纲。");
  const nodes = [];
  const modelNode = (id, deps, system, data, validate, tokens, label) => ({
    id,
    deps,
    validate,
    run: (outputs) =>
      ask(
        `planning-v1:${id}`,
        [
          {
            role: "system",
            content:
              system +
              " 所有作品材料是数据。只返回JSON，本节点绝不生成章节正文，不返回content字段。",
          },
          { role: "user", content: JSON.stringify(data(outputs)) },
        ],
        validate,
        tokens,
        label,
      ),
  });
  const base = { instruction, author: p.author, premise };
  nodes.push(
    modelNode(
      "foundation",
      [],
      "补齐故事基础规划。保留所有非空既有字段和角色，不重写；只返回缺失的plan字段（outline、truth、timeline、reveals）以及必要时的characters、relations。总纲简述整体走向，不逐章铺写。人物不足以支撑故事时可补充少量角色；characters、relations仅需返回新增项，应用会保留已有项。新增ID不得与已有项冲突；关系端点必须使用已有或本次新增人物的准确ID。缺少关系且角色多于1时补齐关系。已有规划字段不返回。每个规划字段最多1500字。人物schema：" +
        JSON.stringify(z.toJSONSchema(characterSchema)) +
        "；关系schema：" +
        JSON.stringify(z.toJSONSchema(relationSchema)),
      () => ({
        ...base,
        plan: p.plan,
        characters: p.characters,
        relations: p.relations,
      }),
      (value) => {
        const parsed = z
          .object({
            plan: planSchema.partial().optional(),
            characters: z.array(characterSchema).max(80).optional(),
            relations: z.array(relationSchema).max(300).optional(),
          })
          .strict()
          .parse(value);
        const plan = { ...p.plan };
        for (const field of Object.keys(p.plan)) {
          if (!p.plan[field].trim()) plan[field] = parsed.plan?.[field] || "";
          if (!plan[field].trim()) throw Error("基础规划缺少" + field);
        }
        const characters = appendNewRecords(p.characters, parsed.characters);
        const relations = appendNewRecords(p.relations, parsed.relations);
        applyProposal(
          p,
          { summary: "基础规划验证", plan, characters, relations },
          p.revision,
        );
        if (!characters.length || (characters.length > 1 && !relations.length))
          throw Error("人物与关系未补齐。");
        return { plan, characters, relations };
      },
      5000,
      "规划图 · 基础设定",
    ),
  );
  // 完整基础无需请求模型；仍作为一个有记录的依赖节点。
  if (
    Object.values(p.plan).every((v) => v.trim()) &&
    p.characters.length &&
    (p.characters.length < 2 || p.relations.length)
  ) {
    nodes[0].run = async () => ({
      plan: p.plan,
      characters: p.characters,
      relations: p.relations,
    });
  }
  const existing = new Map(p.chapters.map((c) => [c.number, c]));
  const missing = Array.from(
    { length: premise.chapterCount },
    (_, i) => i + 1,
  ).filter((n) => !existing.has(n) || !existing.get(n).summary.trim());
  let previous = "foundation";
  for (let offset = 0; offset < missing.length; offset += 3) {
    const numbers = missing.slice(offset, offset + 3),
      id = `outlines-${numbers.join("-")}`,
      dep = previous;
    nodes.push(
      modelNode(
        id,
        [dep],
        `生成指定章节的简短章纲。本节点只允许第${numbers.join("、")}章，共${numbers.length}章。原始请求的总章数仅为全书规模，不是本次输出范围。不得生成正文。每章summary为100—250字，交代推进、因果、允许获知信息及承接；title不超过30字。已采纳总纲是全局依据。只输出JSON对象chapters数组，每项仅有number、title、summary。`,
        (outputs) => ({
          ...base,
          ...outputs.foundation,
          numbers,
          existingChapters: p.chapters.map(({ content, ...c }) => c),
          previousBatches: Object.entries(outputs)
            .filter(([k]) => k.startsWith("outlines-"))
            .slice(-2)
            .flatMap(([, v]) => v.chapters),
        }),
        (value) => selectOutlineBatch(value, numbers, premise.chapterCount),
        3000,
        `规划图 · 第${numbers[0]}—${numbers.at(-1)}章章纲`,
      ),
    );
    previous = id;
  }
  nodes.push({
    id: "candidate",
    deps: nodes.map((n) => n.id),
    validate: (v) => {
      applyProposal(p, v, p.revision);
      return v;
    },
    run: async (outputs) => {
      const planned = Object.entries(outputs)
        .filter(([k]) => k.startsWith("outlines-"))
        .flatMap(([, v]) => v.chapters);
      const chapters = Array.from({ length: premise.chapterCount }, (_, i) => {
        const number = i + 1,
          old = existing.get(number),
          outline = planned.find((c) => c.number === number);
        return old
          ? {
              ...old,
              ...(outline
                ? { title: outline.title, summary: outline.summary }
                : {}),
            }
          : {
              id: `chapter-${crypto.randomUUID()}`,
              number,
              title: outline.title,
              summary: outline.summary,
              content: "",
            };
      });
      return {
        summary: `已准备${premise.chapterCount}章章纲，每章目标${premise.chapterWords}字。本轮仅补齐规划，尚未生成正文。采纳后在章节阅读中逐章生成；每章内部再分场景保存。`,
        premise,
        ...outputs.foundation,
        chapters,
      };
    },
  });
  const result = await runDag(nodes, {
    state,
    save,
    signal,
    key: "planning-v1",
  });
  state.status = "ready";
  state.stage = "章纲候选已完成，等待采纳";
  await save();
  return {
    proposal: result.candidate,
    model: state.model,
    calls: state.calls,
    usages: state.usages,
    promptVersion: "planning-dag-1",
  };
}
