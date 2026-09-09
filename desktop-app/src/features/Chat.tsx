import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  Sparkles,
  Square,
  X,
  Feather,
} from "lucide-react";
import { useStudio } from "../state/StudioContext";
import { isDesktop } from "../lib/bridge";
import { readyForChapter } from "../../runtime/schema.mjs";
import type { Message } from "../lib/types";
import { ReviewResolution } from "./ReviewResolution";
import { useReviewChat } from "./useReviewChat";
import { ReviewProgress } from "./ReviewProgress";
import { DraftWorkspace } from "./DraftWorkspace";
import { useDraftActions } from "./useDraftActions";
function Candidate({ message }: { message: Message }) {
  const { accept, update, project, busy } = useStudio();
  const [expanded, setExpanded] = useState(false);
  const p = message.proposal!;
  const changed = Object.keys(p).filter((k) => k !== "summary");
  if (!changed.length) return null;
  const labels: Record<string, string> = {
    author: "作者档案",
    premise: "作品前提",
    plan: "故事大纲",
    characters: "人物",
    relations: "关系",
    chapters: "章节",
    revisionScope: "正文修订",
    memory: "章节记忆",
  };
  const stale =
    message.status === "pending" && message.baseRevision !== project?.revision;
  return (
    <div className="candidate">
      <div className="candidate-title">
        <FileText size={16} />
        <strong>待采纳的创作方案</strong>
        <span className="tag">{changed.length} 项更新</span>
      </div>
      {p.revisionScope?.length ? (
        <p className="warning-text">
          采纳后替换：
          {p.chapters
            ?.filter((c) => p.revisionScope!.includes(c.id))
            .map((c) => `第${c.number}章《${c.title}》`)
            .join("、")}
          。原稿将另存版本。
        </p>
      ) : null}
      <div className="candidate-tags">
        {changed.map((k) => (
          <span key={k}>{labels[k] || k}</span>
        ))}
      </div>
      <button className="text-button" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        查看完整候选
      </button>
      {expanded && (
        <div className="proposal-preview">
          {p.author && (
            <>
              <h4>作者档案</h4>
              {Object.values(p.author).map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </>
          )}
          {p.premise && (
            <>
              <h4>
                {p.premise.title} · {p.premise.chapterCount}章
              </h4>
              <p>
                {p.premise.genre} · {p.premise.narrator} · 每章约{" "}
                {p.premise.chapterWords} 字
              </p>
              <p>{p.premise.setting}</p>
              <p>{p.premise.theme}</p>
            </>
          )}
          {p.plan && (
            <>
              <h4>故事总纲</h4>
              <p>{p.plan.outline}</p>
              <h4>作者真相</h4>
              <p>{p.plan.truth}</p>
              <h4>双时间线</h4>
              <p>{p.plan.timeline}</p>
              <h4>伏笔与揭示</h4>
              <p>{p.plan.reveals}</p>
            </>
          )}
          {p.characters?.map((c) => (
            <p key={c.id}>
              <b>{c.name}</b> · {c.role}
              <br />
              {c.goal}
              <br />
              秘密：{c.secret}
              <br />
              声音：{c.voice}
            </p>
          ))}
          {p.relations?.map((r) => (
            <p key={r.id}>
              {
                (p.characters || project!.characters).find(
                  (c) => c.id === r.source,
                )?.name
              }{" "}
              →{" "}
              {
                (p.characters || project!.characters).find(
                  (c) => c.id === r.target,
                )?.name
              }
              ：{r.label}
              <br />
              {r.detail}
            </p>
          ))}
          {p.chapters?.map((c) => (
            <div key={c.id}>
              <h4>
                {c.number}. {c.title}
              </h4>
              <p>{c.summary}</p>
              {c.content && <p>{c.content}</p>}
            </div>
          ))}
        </div>
      )}
      <div className="candidate-actions">
        {message.status === "pending" ? (
          <>
            <button
              className="primary compact"
              disabled={busy || stale}
              onClick={() => void accept(message.id)}
            >
              <Check size={14} />
              采纳到作品
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void update((p) => ({
                  ...p,
                  messages: p.messages.map((m) =>
                    m.id === message.id ? { ...m, status: "rejected" } : m,
                  ),
                }))
              }
            >
              <X size={14} />
              放弃
            </button>
            {stale && (
              <span className="warning-text">设定已更新，请重新生成</span>
            )}
          </>
        ) : (
          <span className="muted small">
            {message.status === "accepted" ? "✓ 已采纳到作品" : "已放弃"}
          </span>
        )}
      </div>
    </div>
  );
}
export function Chat() {
  const reviewChat = useReviewChat();
  const draftActions = useDraftActions(reviewChat.task);
  const {
    project,
    provider,
    setProvider,
    settings,
    busy,
    progress,
    generate,
    cancel,
  } = useStudio();
  const [input, setInput] = useState("");
  const [inputTarget, setInputTarget] = useState<"draft" | "new">("draft");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [project?.messages.length, busy, reviewChat.questionId]);
  async function submit() {
    if (
      !input.trim() ||
      busy ||
      (project!.messages.some((m) => m.status === "pending") &&
        (!draftActions.available || inputTarget === "new"))
    )
      return;
    const text = input;
    setInput("");
    const ok = reviewChat.question
      ? await reviewChat.answer(text)
      : draftActions.available && inputTarget === "draft"
        ? await draftActions.submit(text)
        : await generate(
            text,
            /^继续[吧！!。\s]*$/.test(text) && reviewChat.task?.resumable
              ? { resume: true }
              : {},
          );
    if (!ok) setInput((current) => current || text);
  }
  const pending = project!.messages.some((m) => m.status === "pending");
  const suggestions = [
    "根据当前作者档案，生成一个恐怖故事的大纲、人物关系和章节计划。",
    "检查现有大纲的因果、人物动机和伏笔安排，提出改进方案。",
    "按已采纳的规划生成第一章正文，保留所有已存在正文。",
  ];
  return (
    <div className="chat-layout">
      <section className="conversation">
        <div className="conversation-heading">
          <div>
            <span className="eyebrow">创作工作台</span>
            <h2>从一个念头开始</h2>
          </div>
          <span className="status-pill">
            <i />
            {isDesktop ? "本地作品 · 对话协作" : "交互预览 · 固定演示"}
          </span>
        </div>
        <div className="messages">
          {!project!.messages.length ? (
            <div className="welcome">
              <div className="welcome-mark">
                <Feather size={32} />
              </div>
              <span className="eyebrow">让未知，慢慢显形</span>
              <h1>
                你想讲一个
                <br />
                <em>怎样的故事？</em>
              </h1>
              <p>
                从作者的声音、一个人物，或一个不寻常的细节开始。
                <br />
                我们先搭起故事，再让它成为文字。
              </p>
              <div className="suggestions">
                {suggestions.slice(0, 2).map((s, i) => (
                  <button key={s} onClick={() => setInput(s)}>
                    <span>
                      {i === 0 ? (
                        <Sparkles size={17} />
                      ) : (
                        <GitBranch size={17} />
                      )}
                    </span>
                    <div>
                      <b>
                        {i === 0 ? "搭建第一份故事规划" : "审视故事的内在联系"}
                      </b>
                      <small>
                        {i === 0
                          ? "大纲、人物与章节，一起构思"
                          : "检查动机、因果与伏笔"}
                      </small>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            project!.messages.map((m) => (
              <article key={m.id} className={"message " + m.role}>
                <div className="message-avatar">
                  {m.role === "user" ? "你" : <Feather size={16} />}
                </div>
                <div className="message-body">
                  <div className="message-label">
                    {m.role === "user" ? "作者" : "创作助手"}
                    {m.model && <span>{m.model}</span>}
                  </div>
                  <div className="message-text">{m.text}</div>
                  {m.id === reviewChat.questionId && reviewChat.question && (
                    <ReviewResolution
                      issue={reviewChat.question}
                      disabled={busy}
                      onChoose={(id) => void reviewChat.answer("", id)}
                    />
                  )}
                  {m.proposal && <Candidate message={m} />}
                </div>
              </article>
            ))
          )}
          {reviewChat.question &&
            !project!.messages.some((m) => m.id === reviewChat.questionId) && (
              <article className="message assistant">
                <div className="message-avatar">
                  <Feather size={16} />
                </div>
                <div className="message-body">
                  <div className="message-label">创作助手</div>
                  <p>有一处情节需要你确认，要如何处理？</p>
                  <ReviewResolution
                    issue={reviewChat.question}
                    disabled={busy}
                    onChoose={(id) => void reviewChat.answer("", id)}
                  />
                </div>
              </article>
            )}
          <ReviewProgress progress={reviewChat.task?.reviewProgress} />
          {reviewChat.task?.workspace && (
            <DraftWorkspace key={reviewChat.task.id} task={reviewChat.task} />
          )}
          {!busy &&
            !reviewChat.task?.workspace &&
            reviewChat.task?.resumable &&
            !pending && (
              <div className="composer-hint">
                {reviewChat.task.reviewProgress?.failure
                  ? `任务停在“${reviewChat.task.reviewProgress.label}”，草稿与作者裁定已保存。`
                  : "上次任务已保存。"}
                <button
                  className="text-button"
                  onClick={() =>
                    void generate("恢复上次任务", { resume: true })
                  }
                >
                  恢复上次任务
                </button>
              </div>
            )}
          {busy && (
            <div className="working">
              <span className="pulse" />
              <div>
                {progress || "正在生成…"}
                <small>先生成候选，采纳后才更新作品</small>
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="composer-area">
          {pending && (
            <div className="composer-hint">
              {draftActions.available
                ? "可以采纳当前候选，也可以直接提出修改要求，生成新候选。"
                : "先采纳或放弃上一份方案，再开始下一轮生成。"}
            </div>
          )}
          {draftActions.available && !reviewChat.question && (
            <label className="draft-scope">
              这条要求用于
              <select
                aria-label="创作请求作用对象"
                value={inputTarget}
                onChange={(e) =>
                  setInputTarget(e.target.value as "draft" | "new")
                }
              >
                <option value="draft">当前草稿</option>
                <option value="new">新创作任务</option>
              </select>
            </label>
          )}
          <div className="composer">
            <textarea
              aria-label="创作请求"
              placeholder={
                reviewChat.question
                  ? "回答上面的问题，例如：删除这次未交代的检查，不增加新事件。"
                  : draftActions.available && inputTarget === "draft"
                    ? "直接指导当前草稿，例如：把第2场第3段写得更克制；重新生成第2场；继续改。"
                    : isDesktop
                      ? "描述你的想法，或让 Agent 帮你生成作者档案与故事规划…"
                      : "演示模式：输入请求体验规划采纳；真实调用请使用桌面端。"
              }
              value={input}
              maxLength={reviewChat.question ? 2000 : 12000}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="composer-bottom">
              <select
                aria-label="选择生成模型"
                value={provider}
                onChange={(e) =>
                  setProvider(e.target.value as "glm" | "minimax")
                }
                disabled={busy}
              >
                <option value="glm">
                  GLM · {settings?.glm.model || "glm-5.2"}
                </option>
                <option value="minimax">
                  MiniMax · {settings?.minimax.model || "MiniMax-M3"}
                </option>
              </select>
              {busy ? (
                <button
                  className="send stop"
                  aria-label="停止生成"
                  onClick={() => void cancel()}
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  className="send"
                  aria-label="发送创作请求"
                  disabled={
                    !input.trim() ||
                    (pending &&
                      (!draftActions.available || inputTarget === "new"))
                  }
                  onClick={() => void submit()}
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </div>
          <div className="composer-foot">
            <span>
              {isDesktop
                ? "分章创作与审稿 · 可随时停止"
                : "固定示例仅用于体验交互，不代表生成质量"}
            </span>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
        </div>
      </section>
      <aside className="context-panel">
        <div className="panel-title">
          <FileText size={16} />
          <h3>本次创作上下文</h3>
        </div>
        <div className="context-block">
          <span className="eyebrow">作者声音</span>
          <h3>{project!.author.name}</h3>
          <p>{project!.author.personality}</p>
          <span className="mini-tag">作者档案已载入</span>
          <span className="mini-tag">{project!.premise.narrator}</span>
        </div>
        <div className="context-block">
          <span className="eyebrow">作品前提</span>
          <h3>{project!.premise.title}</h3>
          <p>
            {project!.premise.setting ||
              "还没有设定故事发生的地方。可以在对话中构思，也可以手动填写。"}
          </p>
          <div className="context-stats">
            <div>
              <b>{project!.premise.chapterCount}</b>
              <span>预计章节</span>
            </div>
            <div>
              <b>{project!.characters.length}</b>
              <span>已建人物</span>
            </div>
          </div>
        </div>
        <div className="context-block">
          <span className="eyebrow">开写准备</span>
          {[
            ["作者档案", !!project!.author.personality],
            ["故事总纲", !!project!.plan.outline],
            [
              "人物与关系",
              !!project!.characters.length &&
                (project!.characters.length < 2 || !!project!.relations.length),
            ],
            [
              "双时间线与伏笔",
              !!project!.plan.timeline && !!project!.plan.reveals,
            ],
            ["章节计划", !!project!.chapters.length],
          ].map(([label, done]) => (
            <div className="check-row" key={String(label)}>
              <span className={done ? "check done" : "check"}>
                {done ? <Check size={12} /> : ""}
              </span>
              {label}
            </div>
          ))}
          <p className="small muted">
            {readyForChapter(project)
              ? "规划已就绪，可以请求生成章节正文。"
              : "先完成规划，再开始章节正文。"}
          </p>
          {readyForChapter(project) && (
            <button
              className="secondary compact"
              onClick={() => {
                setInputTarget("new");
                setInput(suggestions[2]);
              }}
            >
              起草第一章
            </button>
          )}
        </div>
        <div className="margin-note">
          “恐惧来自发现，
          <br />
          也来自仍未发现的部分。”<span>创作提示 · 非作品引文</span>
        </div>
      </aside>
    </div>
  );
}
