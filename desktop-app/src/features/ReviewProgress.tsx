import type { ChapterTask } from "../lib/types";
const statusNames: Record<string, string> = {
  open: "待处理",
  advisory: "参考建议",
  awaiting_author: "待回答",
  decided: "已裁定",
  repairing: "修订中",
  verifying: "待复核",
  verified: "已复核",
  closed: "已关闭",
};
export function ReviewProgress({
  progress,
}: {
  progress: ChapterTask["reviewProgress"];
}) {
  if (!progress) return null;
  return (
    <details className="review-progress">
      <summary>
        审稿记录 · {progress.label} · 已保存 {progress.decisions} 项作者裁定
      </summary>
      {progress.failure && (
        <>
          <p role="status">{progress.failure.summary}</p>
          <details>
            <summary>查看诊断详情</summary>
            <p>{progress.failure.detail}</p>
          </details>
        </>
      )}
      {progress.issues.map((i) => (
        <p key={i.id}>
          <strong>
            {i.id.replace("issue-", "问题 ")} ·{" "}
            {statusNames[i.status] || i.status}
          </strong>
          <br />
          {i.explanation}
        </p>
      ))}
      {!progress.issues.length && <p>正在核对原文，尚未登记情节问题。</p>}
    </details>
  );
}
