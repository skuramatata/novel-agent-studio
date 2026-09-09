import { useState } from "react";
import { Brain, Search, BookOpen, RefreshCw } from "lucide-react";
import { useStudio } from "../state/StudioContext";
import { useMemoryData } from "./useMemoryData";
const kinds = {
  event: "事件",
  state: "人物与物件",
  knowledge: "知情",
  thread: "故事线",
  foreshadow: "伏笔",
};
const epistemics = {
  observed: "原文陈述",
  belief: "人物信念",
  rumor: "传闻",
  unknown: "待核实",
};
export function Memory() {
  const s = useStudio();
  const { memory, task, error, loading } = useMemoryData();
  const [chapter, setChapter] = useState("");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const p = s.project!;
  const entries = (memory?.entries || []).filter(
    (e) => !chapter || e.chapterId === chapter,
  );
  const pending = p.messages.some((m) => m.status === "pending");
  const chapters = memory?.chapters || [];
  const matched = entries
    .map((e) => ({
      ...e,
      records: e.records.filter(
        (r) =>
          (!kind || r.kind === kind) &&
          (!query || JSON.stringify(r).includes(query)),
      ),
    }))
    .filter(
      (e) =>
        e.records.length || (!kind && (!query || e.summary.includes(query))),
    );
  return (
    <section className="memory-page">
      <header className="memory-heading">
        <div>
          <span className="eyebrow">故事记忆</span>
          <h1>
            <Brain size={26} /> 每个细节，都有来处
          </h1>
          <p>
            已采纳正文的摘要、事件与知情记录。模型抽取供核对，原文是判断依据。
          </p>
        </div>
        <button
          className="primary"
          disabled={
            s.busy ||
            pending ||
            !chapters.some(
              (c) => c.hasContent && (!chapter || c.id === chapter),
            )
          }
          onClick={() =>
            void s.generate("整理已采纳正文的记忆", {
              mode: "memory",
              chapterId: chapter || undefined,
            })
          }
        >
          <RefreshCw size={15} /> 整理{chapter ? "本章" : "全部"}记忆
        </button>
      </header>
      <div className="memory-stats">
        <div>
          <b>
            {chapters.filter((c) => c.indexed).length}
            <small> / {chapters.filter((c) => c.hasContent).length}</small>
          </b>
          <span>已有正文已建立索引</span>
        </div>
        <div>
          <b>
            {memory?.entries.reduce((n, e) => n + e.records.length, 0) || 0}
          </b>
          <span>有原文出处的记录</span>
        </div>
        <div>
          <b>{memory?.entries.filter((e) => !e.current).length || 0}</b>
          <span>因改稿待复核的片段</span>
        </div>
      </div>
      {pending && (
        <p className="memory-tip">
          请先在创作对话或章节页处理候选，再整理正式记忆。候选记忆随正文采纳一起保存。
        </p>
      )}
      {s.busy && (
        <p className="memory-tip" role="status">
          {s.progress}{" "}
          <button className="text-button" onClick={() => void s.cancel()}>
            停止并保留进度
          </button>
        </p>
      )}
      {task?.resumable && !s.busy && (
        <p className="memory-tip">
          上次任务：{task.stage}。{task.error}
          <button
            className="text-button"
            disabled={pending}
            onClick={() => void s.generate("恢复上次任务", { resume: true })}
          >
            从检查点恢复
          </button>
        </p>
      )}
      <div className="memory-filters">
        <label>
          <Search size={16} />
          <input
            aria-label="搜索记忆"
            placeholder="搜索人物、事件、物件或引文"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="按章节筛选记忆"
          value={chapter}
          onChange={(e) => setChapter(e.target.value)}
        >
          <option value="">全部章节</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              第{c.number}章 · {c.title}
              {c.hasContent
                ? c.indexed
                  ? " · 已整理"
                  : " · 待整理"
                : " · 未写"}
            </option>
          ))}
        </select>
        <select
          aria-label="记忆类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">全部类型</option>
          {Object.entries(kinds).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p role="alert">记忆读取失败：{error}</p>
      ) : loading && !memory ? (
        <p>正在读取记忆…</p>
      ) : !matched.length ? (
        <div className="memory-empty">
          <BookOpen size={34} />
          <h3>
            {memory?.entries.length ? "没有匹配的记忆" : "还没有正文记忆"}
          </h3>
          <p>
            {memory?.entries.length
              ? "调整章节、类型或搜索词。"
              : "完成并采纳一章后会自动建立记忆；已有作品可点击“整理全部记忆”。章纲不会被当成已发生事实。"}
          </p>
        </div>
      ) : (
        matched.map((e) => (
          <article
            className={"memory-card " + (!e.current ? "stale" : "")}
            key={`${e.chapterId}:${e.part}`}
          >
            <header>
              <b>
                第{p.chapters.find((c) => c.id === e.chapterId)?.number}章 ·{" "}
                {p.chapters.find((c) => c.id === e.chapterId)?.title}
              </b>
              <span className="tag">
                片段 {e.part + 1} · {e.current ? "来源有效" : "已过期，需重整"}
              </span>
            </header>
            <p className="memory-summary">{e.summary}</p>
            <div className="memory-records">
              {e.records.map((r, i) => (
                <div className="memory-record" key={i}>
                  <div>
                    <span className="tag">{kinds[r.kind]}</span>{" "}
                    <small>{epistemics[r.epistemic]}</small>
                  </div>
                  <h4>{r.text}</h4>
                  <p className="small muted">
                    涉及：{r.entities.join("、") || "未标注"} · 故事时间：
                    {r.storyTime || "未知"} · 知情者：
                    {r.knownBy.join("、") || "未确定"}
                  </p>
                  <blockquote>{r.quote}</blockquote>
                </div>
              ))}
            </div>
            <details>
              <summary>查看原文出处与前后文</summary>
              <p className="small muted">
                正文位置 {e.sourceStart + 1}—{e.sourceEnd} · 版本指纹{" "}
                {e.sourceHash.slice(0, 12)}
                {!e.current ? " · 以下为旧版本证据" : ""}
              </p>
              <div className="prose memory-source">{e.sourceText}</div>
            </details>
          </article>
        ))
      )}
      {!!task?.manifest.length && (
        <details className="memory-card">
          <summary>最近一次生成使用了哪些记忆</summary>
          {task.manifest.map((m, i) => (
            <p key={i}>
              第{p.chapters.find((c) => c.id === m.chapterId)?.number}章 · 片段
              {m.part + 1}：{m.reason}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
