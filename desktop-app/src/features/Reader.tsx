import { useState } from "react";
import {
  BookOpen,
  LockKeyhole,
  ChevronLeft,
  ChevronRight,
  AlignLeft,
} from "lucide-react";
import { useStudio } from "../state/StudioContext";
import { ChapterGeneration } from "./ChapterGeneration";
import { RewritePanel } from "./RewritePanel";
export function Reader() {
  const { project } = useStudio();
  const chapters = [...project!.chapters].sort((a, b) => a.number - b.number);
  const [selected, setSelected] = useState(chapters[0]?.id || "");
  const [fontSize, setFontSize] = useState(18);
  const [outline, setOutline] = useState(false);
  const ch = chapters.find((c) => c.id === selected) || chapters[0];
  const index = chapters.findIndex((c) => c.id === ch?.id);
  return (
    <div className="reader-page">
      <aside className="chapter-sidebar">
        <div className="chapter-heading">
          <span className="eyebrow">章节目录</span>
          <h3>{project!.premise.title}</h3>
          <p>
            {chapters.length} 章规划 ·{" "}
            {chapters.filter((c) => c.content).length} 章正文
          </p>
        </div>
        <RewritePanel />
        <button
          className={"outline-button " + (outline ? "active" : "")}
          onClick={() => setOutline(true)}
        >
          <AlignLeft size={16} />
          故事总纲
        </button>
        <div className="chapter-list">
          {chapters.map((c) => (
            <button
              className={!outline && ch?.id === c.id ? "active" : ""}
              key={c.id}
              onClick={() => {
                setSelected(c.id);
                setOutline(false);
              }}
            >
              <span className="chapter-number">
                {String(c.number).padStart(2, "0")}
              </span>
              <div>
                <b>{c.title}</b>
                <small>{c.content ? "已有正文" : "仅章纲"}</small>
              </div>
              {c.content && <i />}
            </button>
          ))}
        </div>
        <div className="reader-lock">
          <LockKeyhole size={14} />
          正文只读 · 修改通过候选采纳
        </div>
      </aside>
      <section className="reading-area">
        <div className="reader-toolbar">
          <span>
            <BookOpen size={15} />
            {outline ? "故事总纲" : ch ? `第 ${ch.number} 章` : "章节阅读"}
          </span>
          <div>
            <button
              className="icon-button"
              aria-label="缩小字号"
              onClick={() => setFontSize(Math.max(14, fontSize - 1))}
            >
              A−
            </button>
            <button
              className="icon-button"
              aria-label="增大字号"
              onClick={() => setFontSize(Math.min(26, fontSize + 1))}
            >
              A+
            </button>
            <span className="tag">
              <LockKeyhole size={11} />
              只读
            </span>
          </div>
        </div>
        <div className="reading-scroll" key={outline ? "outline" : ch?.id}>
          <article className="manuscript" style={{ fontSize }}>
            {outline ? (
              <>
                <span className="eyebrow">故事蓝图</span>
                <h1>故事总纲</h1>
                {project!.plan.outline ? (
                  <>
                    <div className="prose">{project!.plan.outline}</div>
                    <h3>作者真相底稿</h3>
                    <div className="prose">{project!.plan.truth}</div>
                    <h3>事件与叙述顺序</h3>
                    <div className="prose">{project!.plan.timeline}</div>
                    <h3>伏笔与揭示</h3>
                    <div className="prose">{project!.plan.reveals}</div>
                  </>
                ) : (
                  <div className="reading-empty">
                    <p>还没有故事总纲。</p>
                    <small>在创作对话中生成并采纳规划后，会显示在这里。</small>
                  </div>
                )}
              </>
            ) : ch ? (
              <>
                <span className="eyebrow">
                  第 {String(ch.number).padStart(2, "0")} 章
                </span>
                <h1>{ch.title}</h1>
                <div className="chapter-meta">
                  {ch.content
                    ? `${ch.content.replace(/\s/g, "").length} 字 · 正文只读`
                    : "章节规划 · 等待正文"}
                </div>
                <div className="ornament">◆</div>
                <ChapterGeneration key={ch.id} chapter={ch} />
                {ch.content ? (
                  <div className="prose">{ch.content}</div>
                ) : (
                  <div className="reading-empty">
                    <span className="eyebrow">本章计划</span>
                    <p>{ch.summary}</p>
                    <small>
                      本章尚未生成正文。可以返回创作对话，按已采纳的规划请求起草。
                    </small>
                  </div>
                )}
                <div className="chapter-navigation">
                  <button
                    disabled={index <= 0}
                    onClick={() => setSelected(chapters[index - 1].id)}
                  >
                    <ChevronLeft size={15} />
                    上一章
                  </button>
                  <button
                    disabled={index >= chapters.length - 1}
                    onClick={() => setSelected(chapters[index + 1].id)}
                  >
                    下一章
                    <ChevronRight size={15} />
                  </button>
                </div>
              </>
            ) : (
              <div className="reading-empty">
                <BookOpen size={40} />
                <h2>这里将收录你的故事</h2>
                <p>先在创作对话中生成并采纳章节计划。</p>
                <small>
                  这里显示已采纳的正文；草稿可在上方工作区修改、对比后采纳。
                </small>
              </div>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}
