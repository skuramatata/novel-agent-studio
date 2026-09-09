import { useState } from "react";
import { BookOpen, Plus, Archive, ArchiveRestore } from "lucide-react";
import { useStudio } from "../state/StudioContext";
import type { ProjectSummary } from "../lib/types";
function WorkCard({ work }: { work: ProjectSummary }) {
  const s = useStudio();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(work.title);
  const disabled = s.busy || s.switching;
  const selected = work.id === s.project?.projectId;
  return (
    <section className={`panel work-card ${selected ? "selected" : ""}`}>
      <div className="panel-title">
        <BookOpen size={20} />
        <h3>{work.title || "未命名作品"}</h3>
        {selected && <span className="tag">当前作品</span>}
        {work.archived && <span className="tag">已归档</span>}
      </div>
      <p className="muted">{work.genre || "尚未设置题材"}</p>
      <p className="small muted">
        {work.chapters} 章已采纳正文 · 版本 {work.revision}
      </p>
      {editing && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await s.renameProject(work.id, title)) setEditing(false);
          }}
        >
          <label>
            作品名称
            <input
              autoFocus
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="work-actions">
            <button className="primary" disabled={disabled || !title.trim()}>
              保存名称
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <div className="work-actions">
        {!work.archived && (
          <>
            <button
              className="primary"
              disabled={disabled || selected}
              onClick={() => void s.selectProject(work.id)}
            >
              {selected ? "正在创作" : "切换到此作品"}
            </button>
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => {
                setTitle(work.title);
                setEditing(true);
              }}
            >
              重命名
            </button>
          </>
        )}
        <button
          className="secondary"
          disabled={disabled}
          onClick={() => void s.archiveProject(work.id, !work.archived)}
        >
          {work.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          {work.archived ? "恢复作品" : "归档"}
        </button>
      </div>
    </section>
  );
}
export function Library() {
  const s = useStudio();
  const [title, setTitle] = useState("");
  const [archived, setArchived] = useState(false);
  const works = s.projects.filter((p) => p.archived === archived);
  return (
    <div className="scroll-page library-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">每部作品，独立的创作空间</span>
          <h1>作品管理</h1>
          <p>
            分别管理作者档案、设定、人物、章节和对话；归档后可随时恢复。切换前请保存当前页面草稿。
          </p>
        </div>
      </div>
      <form
        className="panel create-work"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await s.createProject(title)) setTitle("");
        }}
      >
        <label>
          新作品名称
          <input
            value={title}
            maxLength={200}
            placeholder="为下一个故事起个名字"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={s.busy || s.switching || !title.trim()}
        >
          <Plus size={16} />
          新建作品
        </button>
      </form>
      {s.busy && (
        <p className="tip">
          当前作品正在生成，请等待完成或在创作对话中停止任务后切换。
        </p>
      )}
      <div className="work-actions library-filters">
        <button
          className={!archived ? "primary" : "secondary"}
          onClick={() => setArchived(false)}
        >
          创作中（{s.projects.filter((p) => !p.archived).length}）
        </button>
        <button
          className={archived ? "primary" : "secondary"}
          onClick={() => setArchived(true)}
        >
          已归档（{s.projects.filter((p) => p.archived).length}）
        </button>
      </div>
      <div className="library-grid">
        {works.map((work) => (
          <WorkCard key={work.id} work={work} />
        ))}
      </div>
      {!works.length && <p className="muted">暂无已归档作品。</p>}
    </div>
  );
}
