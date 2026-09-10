import { useRef, useState } from "react";
import type { ChapterTask, DraftScope } from "../lib/types";
import { useDraftActions } from "./useDraftActions";

export function DraftWorkspace({ task }: { task: ChapterTask }) {
  const actions = useDraftActions(task);
  const workspace = task.workspace;
  const [instruction, setInstruction] = useState("");
  const instructionInput = useRef<HTMLTextAreaElement>(null);
  const [scopeKey, setScopeKey] = useState("chapter");
  const [selected, setSelected] = useState<string[]>([]);
  const [edit, setEdit] = useState<{
    text: string;
    version: string;
    scope: DraftScope;
  } | null>(null);
  const [versionId, setVersionId] = useState("");
  if (!workspace) return null;
  const choices = [
    {
      key: "chapter",
      label: "整章",
      scope: { kind: "chapter" } as DraftScope,
      text: task.draft,
    },
    ...workspace.scenes.flatMap((s) => [
      {
        key: s.sourceId,
        label: `场景 ${s.scene}`,
        scope: { kind: "scene", sourceId: s.sourceId } as DraftScope,
        text: s.content,
      },
      ...s.paragraphs.map((p) => ({
        key: `${s.sourceId}|${p.paragraph}`,
        label: `场景 ${s.scene} · 第 ${p.paragraph} 段`,
        scope: {
          kind: "paragraph",
          sourceId: s.sourceId,
          paragraph: p.paragraph,
        } as DraftScope,
        text: p.text,
      })),
    ]),
  ];
  const choice = choices.find((c) => c.key === scopeKey) || choices[0];
  const issues = (task.reviewProgress?.issues || []).filter(
    (i) => !["closed", "verified", "stale"].includes(i.status),
  );
  const issueIds = selected.filter((id) => issues.some((i) => i.id === id));
  const needsInstruction = issues.filter(
    (i) => issueIds.includes(i.id) && i.requiresInstruction,
  );
  const version =
    workspace.versions.find((v) => v.id === versionId) || workspace.versions[0];
  const unavailable = !actions.available;
  const sameVersion = version?.text === task.draft;
  const run = async (type: "revise" | "regenerate") => {
    if (type === "revise" && needsInstruction.length && !instruction.trim()) {
      instructionInput.current?.focus();
      return;
    }
    const ok = await actions.act(type, instruction, {
      scope: choice.scope,
      issueIds,
    });
    if (ok) {
      setInstruction("");
      setSelected([]);
    }
  };
  return (
    <section className="draft-workspace" aria-label="草稿工作区">
      <div className="draft-workspace-heading">
        <strong>草稿工作区</strong>
        <span className="tag">
          本回合自动修订 {workspace.budget.used}/{workspace.budget.limit}
        </span>
      </div>
      <p className="small">
        {task.status === "awaiting_instruction"
          ? "本次自动处理已结束，草稿和问题已保存。"
          : "可以查看草稿、继续指导或生成另一个版本。"}
        作者介入后重置额度，已有事实和裁定继续保留。
      </p>
      {task.error && (
        <details>
          <summary>查看本次停止原因</summary>
          <p className="small">{task.error}</p>
        </details>
      )}
      {!workspace.canGuide && (
        <p className="small muted">
          运行期间可以查看草稿；作品正文变化后，请基于最新章节重新创建任务。
        </p>
      )}
      <details className="draft-text">
        <summary>
          查看当前草稿 · {task.draft.replace(/\s/g, "").length} 字符
        </summary>
        {workspace.scenes.map((s) => (
          <div key={s.sourceId}>
            <h4>场景 {s.scene}</h4>
            {s.paragraphs.map((p) => (
              <p key={p.paragraph}>
                <small className="muted">第 {p.paragraph} 段</small>
                <br />
                {p.text}
              </p>
            ))}
          </div>
        ))}
      </details>
      {!!issues.length && (
        <details open className="draft-issues">
          <summary>待处理问题与建议 · {issues.length} 项</summary>
          <p className="small muted">
            勾选问题后，点击“自动修改所选问题”。需补充要求的条目，请先在下方说明怎么改，也可以选择保留原文。
          </p>
          <div className="draft-issue-list">
            {issues.map((i) => (
              <label key={i.id}>
                <input
                  type="checkbox"
                  checked={issueIds.includes(i.id)}
                  disabled={unavailable}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, i.id]
                        : ids.filter((id) => id !== i.id),
                    )
                  }
                />
                <span>
                  <b>{i.id.replace("issue-", "问题 ")}</b>
                  <span className="tag draft-issue-status">
                    {i.requiresInstruction
                      ? "需补充要求"
                      : i.status === "awaiting_author"
                        ? "待确认取舍"
                        : i.status === "advisory"
                          ? "参考建议"
                          : "待修改"}
                  </span>
                  <br />
                  {i.explanation}
                </span>
              </label>
            ))}
          </div>
          <button
            className="secondary compact"
            disabled={unavailable || !issueIds.length}
            onClick={() =>
              void actions
                .act("keep", "保留所选问题的当前原文", { issueIds })
                .then((ok) => {
                  if (ok) setSelected([]);
                })
            }
          >
            保留所选原文
          </button>
        </details>
      )}
      <label className="draft-scope">
        修改或重新生成的范围
        <select
          aria-label="草稿修改范围"
          value={choice.key}
          disabled={unavailable || !!edit}
          onChange={(e) => setScopeKey(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <textarea
        ref={instructionInput}
        aria-label="草稿修改要求"
        placeholder="直接交代怎么改，例如：毛毯已交出，统一后续持物动作，保留对话。重写时可说明必须保留的事件和写法。"
        value={instruction}
        maxLength={12000}
        rows={3}
        disabled={unavailable}
        onChange={(e) => setInstruction(e.target.value)}
      />
      {!!issueIds.length && (
        <p className="small" role="status">
          已选 {issueIds.length} 项。
          {needsInstruction.length && !instruction.trim()
            ? `其中 ${needsInstruction.length} 项尚未说明怎么改，请在上方补充具体要求，或保留所选原文。`
            : "将按所选问题核对原文、修改并复核；也可在上方补充要求。"}
        </p>
      )}
      <div className="draft-actions">
        <button
          className="primary compact"
          disabled={unavailable || (!instruction.trim() && !issueIds.length)}
          onClick={() => void run("revise")}
        >
          {needsInstruction.length && !instruction.trim()
            ? `补充要求后修改 ${issueIds.length} 项`
            : issueIds.length && !instruction.trim()
              ? `自动修改所选 ${issueIds.length} 项问题`
              : `按要求修改${issueIds.length ? ` ${issueIds.length} 项问题` : ""}`}
        </button>
        <button
          className="secondary compact"
          disabled={unavailable}
          onClick={() => void run("regenerate")}
        >
          重新生成{choice.label}
        </button>
        {!issueIds.length && !instruction.trim() && (
          <button
            className="secondary compact"
            disabled={unavailable}
            onClick={() =>
              void actions.act(
                "continue",
                "继续自动修改，选择更符合文章的版本并统一前后文",
              )
            }
          >
            继续审查并自动修改
          </button>
        )}
        <button
          className="secondary compact"
          disabled={unavailable}
          onClick={() =>
            setEdit({
              text: choice.text,
              scope: choice.scope,
              version: workspace.version,
            })
          }
        >
          手动编辑{choice.label}
        </button>
      </div>
      {edit && (
        <div className="draft-editor">
          <textarea
            aria-label="手动编辑草稿"
            value={edit.text}
            maxLength={100000}
            rows={12}
            disabled={unavailable}
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          />
          <button
            className="primary compact"
            disabled={unavailable || !edit.text.trim()}
            onClick={() =>
              void actions
                .act("edit", "保存作者手动修改", {
                  scope: edit.scope,
                  text: edit.text,
                  draftVersion: edit.version,
                })
                .then((ok) => {
                  if (ok) setEdit(null);
                })
            }
          >
            保存修改并重置额度
          </button>
          <button className="text-button" onClick={() => setEdit(null)}>
            取消编辑
          </button>
        </div>
      )}
      {!!workspace.versions.length && (
        <details className="draft-history">
          <summary>版本对比与恢复 · {workspace.versions.length} 个版本</summary>
          <select
            aria-label="选择草稿历史版本"
            value={version?.id || ""}
            onChange={(e) => setVersionId(e.target.value)}
          >
            {workspace.versions.map((v, i) => (
              <option key={v.id} value={v.id}>
                版本 {i + 1} · {v.label}
                {v.text === task.draft
                  ? "（当前草稿）"
                  : v.status === "rejected"
                    ? "（未通过复核）"
                    : ""}
              </option>
            ))}
          </select>
          {version?.reason && <p>{version.reason}</p>}
          <div className="draft-comparison">
            <div>
              <b>所选版本</b>
              <pre>{version?.text}</pre>
            </div>
            <div>
              <b>当前草稿</b>
              <pre>{task.draft}</pre>
            </div>
          </div>
          <button
            className="secondary compact"
            disabled={unavailable || version?.status !== "saved" || sameVersion}
            onClick={() =>
              void actions.act("restore", "恢复所选草稿版本", {
                versionId: version?.id,
              })
            }
          >
            {sameVersion ? "已是当前草稿" : "恢复这个版本"}
          </button>
          <p className="small muted">
            {sameVersion
              ? "所选版本与当前草稿相同，无需恢复。"
              : version?.status !== "saved"
                ? "此版本尚未通过复核，仅供比较，不能恢复。"
                : "恢复后会替换当前草稿，恢复前的版本仍会保留。"}
          </p>
        </details>
      )}
      <div className="draft-actions">
        <button
          className="secondary compact"
          disabled={unavailable || !!actions.candidate}
          onClick={() =>
            void actions.act("deliver", "交付当前草稿，保留尚未解决的问题说明")
          }
        >
          {actions.candidate ? "当前稿已生成候选" : "交付当前稿"}
        </button>
        <small className="muted">生成待采纳候选；采纳后才更新正式作品。</small>
        {actions.candidate && (
          <button
            className="secondary compact"
            onClick={() =>
              document
                .getElementById(`candidate-${actions.candidate!.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          >
            查看待采纳候选
          </button>
        )}
      </div>
      {actions.feedback && (
        <div
          className={`draft-feedback ${actions.feedback.kind}`}
          role={actions.feedback.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <strong>
            {actions.feedback.kind === "running"
              ? "正在处理"
              : actions.feedback.kind === "error"
                ? "操作未完成"
                : actions.feedback.kind === "attention"
                  ? "处理结果 · 仍需处理"
                  : "操作结果"}
          </strong>
          <span>{actions.feedback.text}</span>
          {actions.running && (
            <button
              className="secondary compact"
              onClick={() => void actions.cancel()}
            >
              停止本次处理
            </button>
          )}
        </div>
      )}
    </section>
  );
}
