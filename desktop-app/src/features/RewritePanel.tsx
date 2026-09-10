import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCcw } from "lucide-react";
import { useStudio } from "../state/StudioContext";
import { bridge, isDesktop } from "../lib/bridge";
import type { RewriteBackup } from "../lib/types";
import { readyForChapter } from "../../runtime/schema.mjs";
import { rewriteInstruction } from "../../runtime/rewrite-plan.mjs";
import "./rewrite.css";

// 备份列表与确认框只服务此入口；作品和生成副作用仍由 StudioContext 管理。
export function RewritePanel() {
  const s = useStudio();
  const p = s.project!;
  const [open, setOpen] = useState(false);
  const [backups, setBackups] = useState<RewriteBackup[]>([]);
  const [backupError, setBackupError] = useState("");
  const [instruction, setInstruction] = useState("");
  const [confirmation, setConfirmation] = useState<{
    revision: number;
    backup?: RewriteBackup;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const disabled = s.busy || s.switching || !isDesktop;
  const pending = p.messages.some((m) => m.status === "pending");
  const next = [...p.chapters]
    .sort((a, b) => a.number - b.number)
    .find((c) => !c.content.trim());
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBackupError("");
    void bridge.rewriteBackups(p.projectId).then(
      (items) => {
        if (alive) setBackups(items);
      },
      (e: Error) => {
        if (alive) setBackupError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [open, p.projectId, p.revision]);
  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, [confirmation]);
  function confirm() {
    if (!confirmation || disabled) return;
    const choice = confirmation;
    setConfirmation(null);
    if (choice.backup) void s.restoreRewrite(choice.backup.id, choice.revision);
    else void s.startRewrite(choice.revision, instruction);
  }
  return (
    <section className="rewrite-panel" aria-label="全书重写">
      <button
        className="secondary compact"
        disabled={disabled}
        onClick={() => setConfirmation({ revision: p.revision })}
      >
        <RotateCcw size={15} /> 全部重写
      </button>
      <button
        className="text-button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? "收起重写备份" : "重写备份"}
      </button>
      {p.rewrite && (
        <div className="rewrite-status">
          <p className="small muted">
            {pending
              ? "候选已生成，请在创作对话检查并采纳。"
              : !readyForChapter(p)
                ? "作品与人物设定已保留，等待新规划。中断的任务可在创作对话恢复。"
                : next
                  ? `新规划已就绪，已采纳 ${p.chapters.filter((c) => c.content.trim()).length}/${p.chapters.length} 章正文。`
                  : "本轮章节正文已全部采纳。"}
          </p>
          {!pending && !readyForChapter(p) && (
            <button
              className="secondary compact"
              disabled={disabled}
              onClick={() => void s.generate(rewriteInstruction(p))}
            >
              生成新规划
            </button>
          )}
          {!pending && readyForChapter(p) && next && (
            <button
              className="secondary compact"
              disabled={disabled}
              onClick={() =>
                void s.generate(
                  `按新规划生成第${next.number}章正文。${p.rewrite?.instruction || ""}`,
                  { chapterId: next.id, words: p.premise.chapterWords },
                )
              }
            >
              生成第{next.number}章正文
            </button>
          )}
          {s.busy && (
            <button className="text-button" onClick={() => void s.cancel()}>
              停止生成
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="rewrite-backups">
          {backupError && <p role="alert">备份读取失败：{backupError}</p>}
          {!backupError && !backups.length && (
            <p className="small muted">开始全部重写时，自动保存完整旧稿。</p>
          )}
          {backups.map((b) => (
            <div className="rewrite-backup" key={b.id}>
              <p>
                <b>{b.reason === "rewrite" ? "重写前旧稿" : "恢复前稿件"}</b>
                <br />
                {new Date(b.createdAt).toLocaleString("zh-CN")} · {b.chapters}{" "}
                章正文
              </p>
              <button
                className="secondary compact"
                disabled={disabled}
                onClick={() =>
                  setConfirmation({ revision: p.revision, backup: b })
                }
              >
                恢复此备份
              </button>
            </div>
          ))}
        </div>
      )}
      {confirmation &&
        createPortal(
          <div className="modal-backdrop">
            <div
              className="modal rewrite-dialog"
              ref={dialogRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby="rewrite-dialog-title"
              onKeyDown={(e) => {
                if (e.key === "Escape") setConfirmation(null);
                if (e.key === "Tab") {
                  const nodes = Array.from(
                    e.currentTarget.querySelectorAll<HTMLElement>(
                      "button:not(:disabled), textarea",
                    ),
                  );
                  const first = nodes[0],
                    last = nodes.at(-1);
                  if (
                    e.shiftKey &&
                    (document.activeElement === first ||
                      document.activeElement === e.currentTarget)
                  ) {
                    e.preventDefault();
                    last?.focus();
                  } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              <h2 id="rewrite-dialog-title">
                {confirmation.backup
                  ? "恢复重写备份"
                  : "重新规划并重写全部章节"}
              </h2>
              <p>当前作品：{p.premise.title}</p>
              {confirmation.backup ? (
                <>
                  <p>
                    恢复{" "}
                    {new Date(confirmation.backup.createdAt).toLocaleString(
                      "zh-CN",
                    )}{" "}
                    的作品、人物、规划、正文和记忆。
                  </p>
                  <p>
                    恢复前会另存当前稿件。旧候选保留为历史，旧生成任务不会继续执行。
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <b>保留：</b>
                    作者风格、作品前提、章节数量与字数设置、人物档案和人物关系。
                  </p>
                  <p>
                    <b>重新生成：</b>
                    总纲、作者真相、双时间线、伏笔、所有章纲和正文。
                  </p>
                  <p>
                    先自动备份完整旧稿，再开始新规划。旧对话、候选、故事记忆和生成任务退出本轮创作，可从重写备份恢复旧稿。
                  </p>
                  <label>
                    本轮重写要求（选填）
                    <textarea
                      rows={4}
                      maxLength={8000}
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="例如：减少重复描写，补齐关键事故，重做人物动机与结局。"
                    />
                  </label>
                  <p className="small muted">
                    规划先交付候选；采纳后从第1章逐章重写，每章可检查、采纳和恢复。
                  </p>
                </>
              )}
              <div className="modal-actions">
                <button
                  className="secondary"
                  onClick={() => setConfirmation(null)}
                >
                  取消
                </button>
                <button
                  className="primary"
                  disabled={disabled}
                  onClick={confirm}
                >
                  {confirmation.backup
                    ? "备份当前稿并恢复"
                    : "备份旧稿并开始重写"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
