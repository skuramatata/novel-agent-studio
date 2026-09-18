import { useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Circle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { CreationLogView } from "../lib/types";
import { ExecutionNodeDetail, executionStatus } from "./ExecutionNodeDetail";
import "./execution-timeline.css";

export function ExecutionTimeline({ data }: { data: CreationLogView }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const nodes = data.flow.nodes;
  if (!nodes.length)
    return (
      <div className="memory-empty">
        <h3>没有匹配的执行步骤</h3>
        <p>请调整筛选条件。</p>
      </div>
    );
  return (
    <div className="execution-timeline">
      <div className="execution-timeline-caption">
        <strong>
          {nodes.length} / {data.flow.total} 个步骤
        </strong>
        <span>按节点开始时间排列，重试归在同一步。点击步骤展开输入输出。</span>
      </div>
      {nodes.some((node) => !node.startedAt) && (
        <p className="small muted">
          未采集时间的旧记录列于后方，保留存档顺序。
        </p>
      )}
      <ol aria-label="执行时间线">
        {nodes.map((node, index) => {
          const open = expanded.has(node.id);
          const failed = ["failed", "interrupted"].includes(node.status);
          const Icon = failed
            ? AlertCircle
            : node.status === "success"
              ? CheckCircle2
              : Circle;
          const at = node.startedAt ? new Date(node.startedAt) : null;
          return (
            <li
              key={node.id}
              className={`execution-timeline-item ${open ? "expanded" : ""}`}
            >
              <div className="execution-timeline-time">
                {at ? (
                  <time dateTime={node.startedAt!}>
                    <strong>
                      {at.toLocaleTimeString("zh-CN", { hour12: false })}
                    </strong>
                    <span>{at.toLocaleDateString("zh-CN")}</span>
                  </time>
                ) : (
                  <span>时间未采集</span>
                )}
              </div>
              <div className="execution-timeline-rail" aria-hidden="true">
                <Icon size={20} />
              </div>
              <article
                className={`execution-timeline-card ${failed ? "failed" : ""}`}
              >
                <button
                  className="execution-timeline-toggle"
                  aria-expanded={open}
                  aria-label={`${open ? "收起" : "展开"}步骤：${node.label}`}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(node.id)) next.delete(node.id);
                      else next.add(node.id);
                      return next;
                    })
                  }
                >
                  <span className="execution-timeline-title">
                    <span className="execution-timeline-kind">
                      步骤 {index + 1} ·{" "}
                      {node.kind === "model"
                        ? "模型"
                        : node.kind === "event"
                          ? "过程事件"
                          : "程序"}
                    </span>
                    <strong>{node.label}</strong>
                    <span className="execution-timeline-meta">
                      <span>{executionStatus[node.status] || node.status}</span>
                      {node.attemptCount > 0 && (
                        <span>{node.attemptCount} 次尝试</span>
                      )}
                      {node.hasProblems && !failed && <span>含失败尝试</span>}
                    </span>
                  </span>
                  <span className="execution-timeline-action">
                    {open ? "收起详情" : "查看输入输出"}
                    {open ? (
                      <ChevronDown size={18} />
                    ) : (
                      <ChevronRight size={18} />
                    )}
                  </span>
                </button>
                {open && (
                  <ExecutionNodeDetail
                    taskId={data.selected!.id}
                    nodeId={node.id}
                    updatedAt={data.selected!.updatedAt}
                  />
                )}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
