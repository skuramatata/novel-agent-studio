// 简短继续指令只推进已采纳章纲中的下一空白章，不授权重写已有正文。
export function continuationTask(project, instruction) {
  if (!/^(?:继续(?:吧|写|生成)?|接着写)[。！!\s]*$/.test(instruction.trim()))
    return null;
  const chapter = [...project.chapters]
    .sort((a, b) => a.number - b.number)
    .find((c) => !c.content.trim());
  if (!chapter) return { complete: true };
  return {
    mode: "draft",
    targetIds: [chapter.id],
    totalWords: null,
    chapterWords: project.premise.chapterWords,
    scopeEvidence: instruction,
    explanation: `按已采纳规划继续第${chapter.number}章，不修改已有正文。`,
  };
}
