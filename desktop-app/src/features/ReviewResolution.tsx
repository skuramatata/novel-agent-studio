import type { PendingReview } from "../lib/types";
import { useChapterTask } from "./useChapterTask";
const readable = (s: string) =>
  s
    .replace(/scene:(\d+)/g, "场景$1")
    .replace(/paragraph\s*(\d+)/gi, "第$1段")
    .replace(/sentence\s*(\d+)/gi, "第$1句");
export function ReviewNotice({ onOpen }: { onOpen: () => void }) {
  const task = useChapterTask();
  if (task?.status !== "awaiting_input") return null;
  return (
    <div className="composer-hint">
      草稿已保存，有情节需要你确认。
      <button className="text-button" onClick={onOpen}>
        到创作对话回答
      </button>
    </div>
  );
}
export function ReviewResolution({
  issue,
  onChoose,
  disabled,
}: {
  issue: PendingReview["issues"][number];
  onChoose: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="review-chat-question">
      <details>
        <summary>查看问题与原文出处</summary>
        <p>{readable(issue.explanation)}</p>
        {[issue.target, ...issue.evidence]
          .filter(
            (r, i, a) =>
              a.findIndex(
                (x) =>
                  x.sourceId === r.sourceId &&
                  x.paragraph === r.paragraph &&
                  x.quote === r.quote,
              ) === i,
          )
          .map((r, i) => (
            <blockquote key={i}>
              <small>
                {readable(r.sourceId)} · 第{r.paragraph}段
              </small>
              <p>{r.quote}</p>
            </blockquote>
          ))}
      </details>
      <div className="review-chat-options">
        {issue.options
          .filter((o) => o.action !== "author_direction")
          .map((o, i) => (
            <button
              className="secondary"
              disabled={disabled}
              key={o.id}
              onClick={() => onChoose(o.id)}
              title={o.label}
            >
              {o.action === "remove_unsupported"
                ? "删除无出处的前情"
                : `按依据 ${i + 1} 处理`}
              {o.action !== "remove_unsupported" && (
                <small>{o.label.replace("以这处原文为准：", "")}</small>
              )}
            </button>
          ))}
      </div>
      <p className="small muted">
        也可以直接在下方输入你的处理意见。回答后再问下一项。
      </p>
    </div>
  );
}
