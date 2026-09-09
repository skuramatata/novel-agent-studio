export function projectExport(project, format = "json") {
  if (!["json", "md"].includes(format)) throw Error("不支持的导出格式");
  const title = project.premise.title.trim() || "未命名作品";
  const name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100);
  if (format === "json") {
    const { projectId, ...backup } = project;
    return {
      filename: `${name}-作品备份.json`,
      content: JSON.stringify(backup, null, 2),
      mime: "application/json",
    };
  }
  const chapters = [...project.chapters]
    .filter((c) => c.content.trim())
    .sort((a, b) => a.number - b.number);
  if (!chapters.length)
    throw Error("当前作品还没有已采纳正文，请先生成并采纳章节。");
  return {
    filename: `${name}-正文.md`,
    mime: "text/markdown;charset=utf-8",
    content:
      `# ${title.replace(/\s+/g, " ")}\n\n` +
      chapters
        .map(
          (c) =>
            `## 第${c.number}章 ${c.title.replace(/\s+/g, " ")}\n\n${c.content.trim()}`,
        )
        .join("\n\n") +
      "\n",
  };
}
