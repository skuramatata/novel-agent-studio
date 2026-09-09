import { ScrollText, RefreshCw } from "lucide-react";
import { useCreationLogs } from "./useCreationLogs";
import type { CreationLogEvent } from "../lib/types";
const categories: Record<string, string> = {
  task: "任务",
  planning: "规划",
  writing: "正文生成",
  review: "审稿与修订",
  memory: "故事记忆",
  adoption: "候选与采纳",
};
const statusText: Record<string, string> = {
  running: "进行中",
  success: "已完成",
  failed: "异常",
  waiting: "等待处理",
  info: "记录",
  retryable: "待重试",
  interrupted: "已中断",
  awaiting_input: "待回答",
  ready: "候选就绪",
  completed: "已完成",
};
function time(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "旧记录 · 时间未记录";
}
function LogEntry({ event }: { event: CreationLogEvent }) {
  return (
    <article className={`creation-event ${event.status}`}>
      <header>
        <span className="tag">
          {categories[event.category] || event.category}
        </span>
        <strong>{event.title}</strong>
        <span className="small muted">
          {statusText[event.status] || event.status}
        </span>
      </header>
      <time>{time(event.at)}</time>
      {Object.keys(event.details).length > 0 && (
        <details>
          <summary>查看详情</summary>
          <dl>
            {Object.entries(event.details).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}
export function CreationLogs() {
  const { data, options, change, error, loading, refresh } = useCreationLogs();
  const tasks = data?.tasks || [];
  const selected = data?.selected;
  const available =
    selected && !tasks.some((t) => t.id === selected.id)
      ? [selected, ...tasks]
      : tasks;
  return (
    <section className="creation-logs">
      <header className="memory-heading">
        <div>
          <span className="eyebrow">创作日志</span>
          <h1>
            <ScrollText size={26} /> 从想法到成稿的每一步
          </h1>
          <p>
            按任务查看规划、生成、审稿、作者取舍和采纳记录。生成期间自动更新。
          </p>
        </div>
        <button className="secondary" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} />
          刷新日志
        </button>
      </header>
      {error && <p role="alert">日志读取失败：{error}</p>}
      {data?.warnings.map((w) => (
        <p className="memory-tip" key={w}>
          {w}
        </p>
      ))}
      <div className="log-task-picker">
        <label>
          创作任务
          <select
            aria-label="选择日志任务"
            value={options.taskId || selected?.id || ""}
            onChange={(e) => change({ taskId: e.target.value })}
          >
            {!available.length && <option value="">暂无任务</option>}
            {available.map((t) => (
              <option value={t.id} key={t.id}>
                {t.chapter} · {t.instruction.slice(0, 45) || t.stage} ·{" "}
                {statusText[t.status] || t.status}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button
            className="text-button"
            disabled={!(options.offset || 0)}
            onClick={() =>
              change({ offset: Math.max(0, (options.offset || 0) - 30) })
            }
          >
            较新任务
          </button>
          <button
            className="text-button"
            disabled={!data?.hasOlderTasks}
            onClick={() => change({ offset: (options.offset || 0) + 30 })}
          >
            更早任务
          </button>
        </div>
      </div>
      {selected && (
        <div className="log-task-summary">
          <p>{selected.instruction || "未记录创作请求"}</p>
          <div className="memory-stats">
            <div>
              <b>{statusText[selected.status] || selected.status}</b>
              <span>{selected.stage}</span>
            </div>
            <div>
              <b>{selected.calls}</b>
              <span>模型调用 · {selected.model}</span>
            </div>
            <div>
              <b>{data?.total || 0}</b>
              <span>过程记录</span>
            </div>
          </div>
        </div>
      )}
      {selected?.legacy && (
        <p className="memory-tip">
          此任务来自旧版本，只展示已有存档能还原的记录。缺失的时间、请求耗时和中间步骤未补写。
        </p>
      )}
      <div className="log-filters">
        <input
          aria-label="搜索创作日志"
          placeholder="搜索步骤、问题或失败原因"
          maxLength={200}
          value={options.query || ""}
          onChange={(e) => change({ query: e.target.value })}
        />
        <select
          aria-label="按创作阶段筛选"
          value={options.category || ""}
          onChange={(e) => change({ category: e.target.value })}
        >
          <option value="">全部阶段</option>
          {Object.entries(categories).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={options.onlyProblems || false}
            onChange={(e) => change({ onlyProblems: e.target.checked })}
          />
          仅异常与等待
        </label>
      </div>
      {loading && !data ? (
        <p role="status">正在读取创作日志…</p>
      ) : !selected ? (
        <div className="memory-empty">
          <ScrollText size={32} />
          <h3>还没有创作任务</h3>
          <p>开始规划或生成章节后，过程会自动记录在这里。</p>
        </div>
      ) : (
        <>
          <p className="small muted">
            显示 {data?.events.length} / {data?.matched}{" "}
            条匹配记录，按时间从早到晚排列。
          </p>
          {data?.hasMoreEvents && (
            <button
              className="secondary"
              onClick={() => change({ limit: (options.limit || 200) + 200 })}
            >
              加载更早记录
            </button>
          )}
          {!data?.events.length && <p>没有匹配记录，请调整筛选条件。</p>}
          <div className="creation-timeline">
            {data?.events.map((e) => (
              <LogEntry key={e.id} event={e} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
