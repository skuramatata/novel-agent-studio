import type { DraftAction, DraftWorkspaceState } from "./types";
const number = (value: string) => {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = "零一二三四五六七八九";
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [a, b] = value.split("十");
    return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0);
  }
  return digits.indexOf(value);
};
export function draftCommand(
  text: string,
  workspace: DraftWorkspaceState,
): Pick<DraftAction, "type" | "scope"> {
  if (
    /^(继续|恢复)(自动)?(改稿|修订|修改|任务|改)?[吧！!。\s]*$/.test(
      text.trim(),
    )
  )
    return { type: "continue" };
  const regenerate = /重写|重新生成|重新写/.test(text);
  const scene = /第([一二三四五六七八九十\d]+)(?:个)?场(?:景)?/.exec(text);
  const paragraph = /第([一二三四五六七八九十\d]+)段/.exec(text);
  let scope: DraftAction["scope"];
  if (scene) {
    const s = workspace.scenes.find((s) => s.scene === number(scene[1]));
    if (!s) throw Error("这份草稿中没有该场景，请在草稿工作区选择范围。");
    scope = { kind: "scene", sourceId: s.sourceId };
    if (paragraph) {
      if (!s.paragraphs.some((p) => p.paragraph === number(paragraph[1])))
        throw Error("所选场景没有该段落。");
      scope = {
        kind: "paragraph",
        sourceId: s.sourceId,
        paragraph: number(paragraph[1]),
      };
    }
  } else if (paragraph) {
    const row = workspace.scenes.flatMap((s) =>
      s.paragraphs.map((p) => ({ ...p, sourceId: s.sourceId })),
    )[number(paragraph[1]) - 1];
    if (!row) throw Error("草稿中没有该段落，请在草稿工作区选择范围。");
    scope = {
      kind: "paragraph",
      sourceId: row.sourceId,
      paragraph: row.paragraph,
    };
  } else if (/整章|本章|这一章|当前章/.test(text)) scope = { kind: "chapter" };
  if (regenerate && !scope)
    throw Error("请说明重写哪一段、哪一场或整章，也可以在草稿工作区选择范围。");
  return {
    type: regenerate ? "regenerate" : "revise",
    scope: scope || { kind: "chapter" },
  };
}
