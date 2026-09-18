import { useState } from "react";
import { Copy, Check } from "lucide-react";
import type { ExecutionNodeDetail as Detail } from "../lib/types";
import { useCreationLogNode } from "./useCreationLogs";
import { LogJson, parseLogJson } from "./LogJson";

export const executionStatus: Record<string, string> = {
  success: "已完成",
  succeeded: "已完成",
  completed: "已完成",
  running: "进行中",
  received: "已返回 · 待校验",
  failed: "失败",
  interrupted: "已中断",
  waiting: "等待处理",
  unknown: "结果未记录",
  info: "过程记录",
  pending: "待执行",
};
const tabs = {
  input: "节点输入",
  request: "模型请求",
  raw: "原始输出",
  parsed: "解析结果",
  accepted: "接收结果",
  validation: "校验与错误",
};
type Tab = keyof typeof tabs;

function Content({ value, empty }: { value: unknown; empty: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  if (value === undefined) return <p className="trace-missing">{empty}</p>;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const decoded = parseLogJson(value);
  const structured = decoded !== null && typeof decoded === "object";
  return (
    <div className="trace-content">
      <div className="trace-content-toolbar">
        <span>
          {text.length.toLocaleString()} 字符 ·{" "}
          {structured ? "JSON 结构 · 复制保留原始内容" : "完整已保存内容"}
        </span>
        <button
          className="text-button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                setError("");
              },
              () => setError("复制失败，请选中文本复制"),
            );
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制全文"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {structured ? (
        <LogJson value={value} />
      ) : (
        <pre tabIndex={0}>{text || "（空字符串）"}</pre>
      )}
    </div>
  );
}

function DetailBody({ node }: { node: Detail }) {
  const [tab, setTab] = useState<Tab>("input");
  const [attemptId, setAttemptId] = useState("");
  const attempt =
    node.attempts.find((item) => item.id === attemptId) || node.attempts.at(-1);
  const model = node.kind === "model";
  let content: unknown,
    note = "",
    empty = "此项未采集，无法从历史存档还原。";
  if (tab === "input") {
    content = attempt?.input ?? node.input;
    note = node.inputNote || "该节点实际保存的输入与来源引用";
  }
  if (tab === "request") {
    content = attempt?.request;
    note =
      attempt?.requestNote ||
      (model ? "最终模型请求未采集" : "程序节点没有模型请求");
  }
  if (tab === "raw") {
    content = attempt?.rawOutput;
    note = attempt?.rawNote || "此节点没有单独保存模型原文";
  }
  if (tab === "parsed") {
    content = attempt?.parsedOutput;
    note = "解析结果可能尚未通过业务校验，不能视为最终接收结果";
  }
  if (tab === "accepted") {
    content = attempt ? attempt.acceptedOutput : node.acceptedOutput;
    note = `结果去向：${attempt?.resultKey || node.outputKey || "未单独记录"}`;
    empty =
      attempt?.validation?.passed === false
        ? "本次结果未被接收。请查看原始输出与校验原因。"
        : "未采集接收结果或尚未完成校验。";
  }
  if (tab === "validation") {
    content =
      attempt?.validation || attempt?.error || node.error || node.details;
    note = "程序契约的校验结果；通过校验不等于文学效果已经验证";
    empty = "未单独采集校验结果。";
  }
  return (
    <>
      <header className="trace-detail-heading">
        <span className="eyebrow">
          节点详情 · {model ? "模型" : node.kind === "event" ? "事件" : "程序"}
        </span>
        <h2>{node.label}</h2>
        <p>
          {executionStatus[node.status] || node.status}
          {node.contract ? ` · 契约 ${node.contract}` : ""}
        </p>
        <p className="small muted">{node.source}</p>
      </header>
      {node.redacted && (
        <p className="memory-tip">
          展示内容已隐藏凭据或思考文本；其余已保存内容可完整查看。
        </p>
      )}
      {node.attempts.length > 0 && (
        <label className="trace-attempt-picker">
          查看尝试
          <select
            aria-label="选择节点尝试"
            value={attempt?.id || ""}
            onChange={(event) => setAttemptId(event.target.value)}
          >
            {node.attempts.map((item, index) => (
              <option key={item.id} value={item.id}>
                第 {index + 1} 次 ·{" "}
                {executionStatus[item.status] || item.status}
                {item.partial ? " · 部分响应" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {attempt && (
        <div className="trace-attempt-meta">
          <span>
            {attempt.startedAt
              ? new Date(attempt.startedAt).toLocaleString("zh-CN", {
                  hour12: false,
                })
              : "历史记录 · 时间未采集"}
          </span>
          {attempt.responseMeta?.model && (
            <span>{attempt.responseMeta.model}</span>
          )}
          {attempt.responseMeta?.finishReason && (
            <span>结束原因：{attempt.responseMeta.finishReason}</span>
          )}
        </div>
      )}
      {!!node.reuses?.length && (
        <details className="trace-reuses">
          <summary>
            复用已有结果 {node.reuses.length} 次 · 未重新调用模型
          </summary>
          <Content value={node.reuses} empty="" />
        </details>
      )}
      <div className="trace-tabs" role="tablist" aria-label="节点数据">
        {Object.entries(tabs)
          .filter(([id]) => model || !["request", "raw", "parsed"].includes(id))
          .map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id as Tab)}
            >
              {label}
            </button>
          ))}
      </div>
      <div role="tabpanel" aria-label={tabs[tab]} className="trace-tab-panel">
        <p className="small muted">{note}</p>
        <Content
          key={`${tab}:${attempt?.id || "node"}`}
          value={content}
          empty={empty}
        />
        {tab === "validation" && attempt?.responseMeta?.usage !== undefined && (
          <details>
            <summary>供应商返回的用量</summary>
            <Content value={attempt.responseMeta.usage} empty="供应商未提供" />
          </details>
        )}
      </div>
    </>
  );
}

export function ExecutionNodeDetail({
  taskId,
  nodeId,
  updatedAt,
}: {
  taskId: string;
  nodeId: string;
  updatedAt: string | null;
}) {
  const snapshot = useCreationLogNode(taskId, nodeId, updatedAt);
  return (
    <aside className="trace-detail" aria-label="节点详情">
      {!nodeId ? (
        <p className="trace-missing">选择一个节点，查看这一步的输入和输出。</p>
      ) : snapshot?.error ? (
        <p role="alert">节点读取失败：{snapshot.error}</p>
      ) : !snapshot?.data ? (
        <p role="status">正在读取节点详情…</p>
      ) : (
        <DetailBody key={`${taskId}:${nodeId}`} node={snapshot.data} />
      )}
    </aside>
  );
}
