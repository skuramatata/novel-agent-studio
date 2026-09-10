import { ReviewNotice } from "./features/ReviewResolution";
import { useState } from "react";
import {
  Feather,
  MessagesSquare,
  SlidersHorizontal,
  GitBranch,
  BookOpen,
  Settings2,
  Download,
  X,
  Check,
  Brain,
  ScrollText,
} from "lucide-react";
import { useStudio } from "./state/StudioContext";
import { Library } from "./features/Library";
import { Chat } from "./features/Chat";
import { Foundation } from "./features/Foundation";
import { Relationships } from "./features/Relationships";
import { Reader } from "./features/Reader";
import { Settings } from "./features/Settings";
import { Memory } from "./features/Memory";
import { CreationLogs } from "./features/CreationLogs";
import { isDesktop } from "./lib/bridge";
import { BuildVersion } from "./components/BuildVersion";
import { ThemeSwitch } from "./components/ThemeSwitch";
const tabs = [
  { id: "library", label: "作品管理", icon: BookOpen },
  { id: "chat", label: "创作对话", icon: MessagesSquare },
  { id: "foundation", label: "作者与作品", icon: SlidersHorizontal },
  { id: "relations", label: "人物关系", icon: GitBranch },
  { id: "reader", label: "章节阅读", icon: BookOpen },
  { id: "memory", label: "故事记忆", icon: Brain },
  { id: "logs", label: "创作日志", icon: ScrollText },
] as const;
export default function App() {
  const s = useStudio();
  const [tab, setTab] = useState<string>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!s.project)
    return (
      <div className="boot">
        <Feather size={36} />
        <h2>小说工作室</h2>
        <p>{s.error || "正在打开你的写作空间…"}</p>
        <BuildVersion />
        <ThemeSwitch />
        {s.error && (
          <button className="primary" onClick={() => void s.refresh()}>
            重新载入
          </button>
        )}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="traffic-space" />
        <div className="brand">
          <span className="brand-mark">
            <Feather size={23} />
          </span>
          <div>
            <strong>小说工作室</strong>
            <small>让故事拥有自己的声音</small>
          </div>
        </div>
        <div className="project-switch">
          <span className="project-icon">
            <BookOpen size={18} />
          </span>
          <label>
            当前作品
            <select
              aria-label="切换作品"
              value={s.project.projectId}
              disabled={s.busy || s.switching}
              onChange={(e) => void s.selectProject(e.target.value)}
            >
              {s.projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || "未命名作品"}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="nav-label">创作空间</div>
        <nav>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={18} />
              {t.label}
              {t.id === "reader" && s.project!.chapters.length > 0 && (
                <span className="nav-count">{s.project!.chapters.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">创作原则</span>
          <p>
            先规划，再落笔。
            <br />
            让每个细节，都有来处。
          </p>
          <div className="small muted">
            {s.project.demo ? "包含演示内容" : "作品保存在这台电脑"}
          </div>
        </div>
        <div className="sidebar-bottom">
          <button
            disabled={s.switching}
            onClick={() => void s.exportProject("json")}
          >
            <Download size={16} />
            下载作品备份
          </button>
          <button
            disabled={
              s.switching || !s.project.chapters.some((c) => c.content.trim())
            }
            onClick={() => void s.exportProject("md")}
            title="按章节顺序导出已采纳正文"
          >
            <Download size={16} />
            下载作品正文 (.md)
          </button>
          <button onClick={() => setSettingsOpen(true)}>
            <Settings2 size={16} />
            模型连接
            <span
              className={
                s.settings?.[s.provider].hasKey
                  ? "connection-dot on"
                  : "connection-dot"
              }
            />
          </button>
          <BuildVersion />
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            创作空间 <span>/</span>{" "}
            <b>{tabs.find((t) => t.id === tab)?.label}</b>
          </div>
          <div>
            <ThemeSwitch />
            <span className="saved">
              <Check size={13} />
              已保存 · v{s.project.revision}
            </span>
            <button
              className="model-badge"
              onClick={() => setSettingsOpen(true)}
            >
              <span className="connection-dot on" />
              {isDesktop
                ? s.settings?.[s.provider].model || "连接模型"
                : "浏览器演示"}
            </button>
          </div>
        </header>
        {tab !== "chat" && (
          <ReviewNotice
            key={`review-notice:${s.project.projectId}`}
            onOpen={() => setTab("chat")}
          />
        )}
        <div
          className="workspace"
          key={`workspace:${s.project.projectId}:${s.project.rewrite?.epoch || "original"}`}
        >
          {tab === "library" ? (
            <Library />
          ) : tab === "chat" ? (
            <Chat />
          ) : tab === "foundation" ? (
            <Foundation />
          ) : tab === "relations" ? (
            <Relationships />
          ) : tab === "memory" ? (
            <Memory />
          ) : tab === "logs" ? (
            <CreationLogs />
          ) : (
            <Reader />
          )}
        </div>
      </main>
      {s.error && (
        <div className="error-banner" role="alert">
          <span>{s.error}</span>
          <button aria-label="关闭提示" onClick={() => s.setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {s.notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {s.notice}
        </div>
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
