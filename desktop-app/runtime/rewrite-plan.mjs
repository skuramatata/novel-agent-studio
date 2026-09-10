import { projectSchema } from "./schema.mjs";

export function rewriteInstruction(project) {
  return `请生成全新的故事规划和全部章纲，共${project.premise.chapterCount}章，每章目标${project.premise.chapterWords}字。本轮只生成规划候选，不写正文。保留当前作者档案、作品前提、全部既有人物档案与人物关系；总纲、作者真相、双时间线、伏笔与章节剧情重新构思，不继承任何旧正文事件。明确关键事件的因果、人物选择及后果，核对人数、时间、物件流转和伏笔回收。${project.rewrite?.instruction ? "\n本轮重写要求：\n" + project.rewrite.instruction : ""}`;
}
export function rewrittenProject(project, backupId, instruction = "") {
  if (typeof instruction !== "string" || instruction.length > 8000)
    throw Error("重写要求最多8000字。");
  const p = projectSchema.parse(project);
  return projectSchema.parse({
    ...p,
    rewrite: {
      epoch: crypto.randomUUID(),
      backupId,
      instruction: instruction.trim(),
    },
    plan: { outline: "", truth: "", timeline: "", reveals: "" },
    chapters: [],
    messages: [],
    memory: { version: 1, entries: [] },
    demo: false,
  });
}
