import { z } from "zod";
import { memorySchema } from "./memory-schema.mjs";
const text = z.string().max(100000);
const short = z.string().max(4000);
const id = z.string().min(1).max(100);
export const writingSettingsSchema = z
  .object({
    wordTolerance: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("absolute"),
          value: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          mode: z.literal("percent"),
          value: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    ]),
  })
  .strict();
export const authorSchema = z.object({
  name: short,
  personality: short,
  chinese: short,
  western: short,
  habits: short,
  references: short,
  avoid: short,
});
export const premiseSchema = z.object({
  title: short,
  genre: short,
  setting: short,
  theme: short,
  narrator: short,
  chapterCount: z.number().int().min(1).max(200),
  chapterWords: z.number().int().min(100).max(10000),
});
export const characterSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  role: short,
  goal: short,
  secret: short,
  voice: short,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
});
export const relationSchema = z.object({
  id,
  source: id,
  target: id,
  label: z.string().min(1).max(120),
  detail: short,
});
export const chapterSchema = z.object({
  id,
  number: z.number().int().positive(),
  title: short,
  summary: short,
  content: text,
});
export const planSchema = z.object({
  outline: text,
  truth: short,
  timeline: text,
  reveals: text,
});
export const proposalSchema = z
  .object({
    summary: short,
    memory: memorySchema.optional(),
    revisionScope: z.array(id).max(200).optional(),
    author: authorSchema.optional(),
    premise: premiseSchema.optional(),
    plan: planSchema.optional(),
    characters: z.array(characterSchema).max(80).optional(),
    relations: z.array(relationSchema).max(300).optional(),
    chapters: z.array(chapterSchema).max(200).optional(),
  })
  .strict();
export const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text,
  proposal: proposalSchema.optional(),
  baseRevision: z.number().int().optional(),
  status: z.enum(["pending", "accepted", "rejected"]).optional(),
  model: short.optional(),
  taskId: id.optional(),
  createdAt: z.string().datetime().optional(),
  handledAt: z.string().datetime().optional(),
});
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    author: authorSchema,
    premise: premiseSchema,
    writingSettings: writingSettingsSchema.optional(),
    rewrite: z
      .object({
        epoch: z.string().uuid(),
        backupId: z.string().uuid(),
        instruction: z.string().max(8000),
      })
      .strict()
      .optional(),
    plan: planSchema,
    characters: z.array(characterSchema).max(80),
    relations: z.array(relationSchema).max(300),
    chapters: z.array(chapterSchema).max(200),
    messages: z.array(messageSchema).max(500),
    demo: z.boolean(),
    memory: memorySchema.optional(),
  })
  .superRefine((p, ctx) => {
    const ids = new Set(p.characters.map((c) => c.id));
    if (
      ids.size !== p.characters.length ||
      new Set(p.relations.map((r) => r.id)).size !== p.relations.length ||
      new Set(p.chapters.map((c) => c.id)).size !== p.chapters.length ||
      new Set(p.chapters.map((c) => c.number)).size !== p.chapters.length
    )
      ctx.addIssue({ code: "custom", message: "人物、关系或章节标识重复" });
    if (
      p.relations.some(
        (r) =>
          !ids.has(r.source) || !ids.has(r.target) || r.source === r.target,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "关系必须连接两个存在且不同的人物",
      });
  });
export function readyForChapter(p) {
  return Boolean(
    p.plan.outline.trim() &&
    p.plan.truth.trim() &&
    p.plan.timeline.trim() &&
    p.plan.reveals.trim() &&
    p.characters.length &&
    p.chapters.length &&
    (p.characters.length < 2 || p.relations.length),
  );
}
export function applyProposal(project, proposal, baseRevision) {
  if (project.revision !== baseRevision)
    throw new Error("作品已发生变化，这份候选已过期。请基于最新设定重新生成。");
  const parsed = proposalSchema.parse(proposal);
  const { summary, revisionScope = [], ...patch } = parsed;
  const revisions = new Set(revisionScope);
  if (
    revisions.size !== revisionScope.length ||
    revisionScope.some(
      (id) => !project.chapters.some((c) => c.id === id && c.content),
    )
  )
    throw new Error("修订范围必须是已有正文的唯一章节ID。");
  const result = projectSchema.parse({
    ...project,
    ...patch,
    revision: project.revision + 1,
  });
  for (const old of project.chapters) {
    if (
      old.content &&
      !result.chapters.some(
        (c) =>
          c.id === old.id &&
          (c.content === old.content ||
            (revisions.has(old.id) && c.content.trim())),
      )
    )
      throw new Error(
        "章节正文不支持修改或删除，除非候选明确列出修订范围并保留非空正文。",
      );
  }
  if (
    result.chapters.some(
      (c) =>
        c.content && !project.chapters.find((old) => old.id === c.id)?.content,
    ) &&
    !readyForChapter(project)
  )
    throw new Error("请先采纳完整大纲、双时间线、伏笔和人物关系，再生成正文。");
  return result;
}
