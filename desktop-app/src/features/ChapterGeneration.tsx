import { useState } from "react";
import { useStudio } from "../state/StudioContext";
import { useMemoryData } from "./useMemoryData";
import type { Chapter } from "../lib/types";
import {
  chapterWordRange,
  projectWordTolerance,
  wordToleranceLabel,
} from "../../runtime/word-range.mjs";
export function ChapterGeneration({ chapter }: { chapter: Chapter }) {
  const s = useStudio();
  const { task, error } = useMemoryData();
  const [words, setWords] = useState(s.project!.premise.chapterWords);
  const tolerance = projectWordTolerance(s.project);
  const range = chapterWordRange(words, tolerance);
  const [instruction, setInstruction] = useState("");
  const pending = s.project!.messages.find((m) => m.status === "pending");
  const candidate = pending?.proposal?.chapters?.find(
    (c) => c.id === chapter.id && c.content !== chapter.content,
  );
  return (
    <div className="chapter-generation">
      <div className="memory-filters">
        <label>
          本章字数{" "}
          <input
            aria-label="本章目标字数"
            type="number"
            min={100}
            max={10000}
            step={100}
            value={words}
            onChange={(e) => setWords(Number(e.target.value))}
          />
        </label>
        <button
          className="primary"
          disabled={s.busy || !!pending || words < 100 || words > 10000}
          onClick={() =>
            void s.generate(
              `${chapter.content ? "修订" : "起草"}第${chapter.number}章，目标${words}字。${instruction}`,
              { chapterId: chapter.id, words },
            )
          }
        >
          {chapter.content ? "生成本章修订候选" : "逐场景生成本章"}
        </button>
      </div>
      <textarea
        aria-label="本章创作要求"
        placeholder="补充本章要求；回忆请注明来源，如“回忆第12章交钥匙事件”。"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
      />
      <p className="small muted">
        新任务字数容差：{wordToleranceLabel(tolerance)}，允许 {range.min}—
        {range.max} 字。 可在“作者与作品”调整。
        每章独立保存。长章按场景分段生成；采纳本章后，可选择下一章继续。
      </p>
      {s.busy && (
        <p role="status">
          {s.progress}{" "}
          <button className="text-button" onClick={() => void s.cancel()}>
            停止并保留草稿
          </button>
        </p>
      )}
      {pending && !candidate && <p>请先在创作对话处理上一份候选。</p>}
      {candidate && pending && (
        <div>
          <details>
            <summary>查看本章候选正文</summary>
            <div className="prose">{candidate.content}</div>
          </details>
          <button
            className="primary"
            disabled={s.busy || pending.baseRevision !== s.project!.revision}
            onClick={() => void s.accept(pending.id)}
          >
            采纳本章与记忆
          </button>
          <button
            className="text-button"
            disabled={s.busy}
            onClick={() =>
              void s.update((p) => ({
                ...p,
                messages: p.messages.map((m) =>
                  m.id === pending.id ? { ...m, status: "rejected" } : m,
                ),
              }))
            }
          >
            放弃候选
          </button>
          {pending.baseRevision !== s.project!.revision && (
            <p>候选已过期，请放弃后重新生成。</p>
          )}
        </div>
      )}
      {error && <p role="alert">检查点读取失败：{error}</p>}
      {task && (!task.chapterId || task.chapterId === chapter.id) && (
        <div className="chapter-checkpoint">
          <p>
            最近任务：{task.stage} ·{" "}
            {(
              {
                completed: "已交付",
                awaiting_input: "待作者处理，请在上方面板选择",
                failed: "失败，已保存",
                interrupted: "已中断",
                running: "运行中或待恢复",
                stale: "依赖已变化",
                ready: "待交付",
              } as Record<string, string>
            )[task.status] || task.status}
          </p>
          {task.error && <p>{task.error}</p>}
          {task.resumable && !s.busy && (
            <button
              className="text-button"
              disabled={!!pending}
              onClick={() => void s.generate("恢复章节任务", { resume: true })}
            >
              恢复上次任务
            </button>
          )}
          {!!task.draft && (
            <details>
              <summary>查看当前整章草稿（尚未通过采纳）</summary>
              <div className="prose">{task.draft}</div>
            </details>
          )}
          {!!task.fragments.length && (
            <details>
              <summary>查看已保存的场景草稿（未采纳）</summary>
              {task.fragments.map((f, i) => (
                <details key={f.key}>
                  <summary>场景片段 {i + 1}</summary>
                  <div className="prose">{f.text}</div>
                </details>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
