import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  useStore,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import {
  CheckCircle2,
  AlertCircle,
  Circle,
  Bot,
  FileCheck2,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { CreationLogView, ExecutionNodeSummary } from "../lib/types";
import { ExecutionNodeDetail, executionStatus } from "./ExecutionNodeDetail";
import "./execution-flow.css";

type TraceNode = Node<{ summary: ExecutionNodeSummary }, "trace">;
function TraceCard({ data, selected }: NodeProps<TraceNode>) {
  const node = data.summary;
  const failed = ["failed", "interrupted"].includes(node.status);
  const Icon = failed
    ? AlertCircle
    : node.status === "success"
      ? CheckCircle2
      : Circle;
  return (
    <div
      className={`trace-node ${selected ? "selected" : ""} ${failed ? "failed" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="trace-node-kind">
        {node.kind === "model" ? <Bot size={14} /> : <FileCheck2 size={14} />}
        {node.kind === "model"
          ? "模型节点"
          : node.kind === "event"
            ? "过程事件"
            : "程序节点"}
      </div>
      <strong title={node.label}>{node.label}</strong>
      <div className="trace-node-status">
        <Icon size={14} />
        {executionStatus[node.status] || node.status}
        <span>
          {node.attemptCount ? `${node.attemptCount} 次尝试` : "存档"}
        </span>
      </div>
      {node.hasProblems && !failed && <small>包含失败尝试，可查看原因</small>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { trace: TraceCard };
function FocusNode({ id, nodeIds }: { id: string; nodeIds: string[] }) {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const key = JSON.stringify(nodeIds);
  useEffect(() => {
    if (!id) return;
    const ids: string[] = JSON.parse(key);
    const index = ids.indexOf(id);
    const visible =
      ids.length <= 8 ? ids : ids.slice(Math.max(0, index - 2), index + 3);
    const timer = setTimeout(() => {
      void fitView({
        nodes: visible.map((id) => ({ id })),
        duration: 250,
        padding: 0.15,
        minZoom: 0.3,
        maxZoom: 1,
      });
    }, 80);
    return () => clearTimeout(timer);
  }, [id, key, fitView, width, height]);
  return null;
}

export function ExecutionFlow({ data }: { data: CreationLogView }) {
  const [selectedId, setSelectedId] = useState("");
  const selected =
    data.flow.nodes.find((node) => node.id === selectedId) ||
    data.flow.nodes.find((node) => node.status === "failed") ||
    data.flow.nodes[0];
  const nodes = useMemo<TraceNode[]>(
    () =>
      data.flow.nodes.map((summary, index) => ({
        id: summary.id,
        type: "trace",
        data: { summary },
        position: { x: (index % 2) * 290, y: Math.floor(index / 2) * 175 },
        selected: summary.id === selected?.id,
        ariaLabel: `${summary.label}，${executionStatus[summary.status] || summary.status}`,
      })),
    [data.flow.nodes, selected?.id],
  );
  const edges = useMemo(
    () =>
      data.flow.edges.map((edge) => ({
        ...edge,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted)" },
        style: {
          stroke: "var(--muted)",
          strokeDasharray: edge.kind === "sequence" ? "5 5" : undefined,
        },
        ariaLabel:
          edge.kind === "sequence"
            ? "开始时间先后，不表示数据依赖"
            : "已记录的数据依赖",
      })),
    [data.flow.edges],
  );
  if (!data.flow.nodes.length)
    return (
      <div className="memory-empty">
        <h3>没有匹配的执行节点</h3>
        <p>请调整筛选条件；过程事件仍可在“事件记录”中查看。</p>
      </div>
    );
  return (
    <>
      <div className="trace-flow-toolbar">
        <label>
          定位节点
          <select
            aria-label="定位执行节点"
            value={selected?.id || ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {data.flow.nodes.map((node, index) => (
              <option key={node.id} value={node.id}>
                {index + 1}. {node.label} ·{" "}
                {executionStatus[node.status] || node.status}
              </option>
            ))}
          </select>
        </label>
        <p>
          {data.flow.nodes.length} / {data.flow.total} 个节点
          <br />
          <span className="small muted">
            实线：已记录依赖 · 虚线：开始时间先后
            <br />
            缺少历史关系时不补画连线
          </span>
        </p>
      </div>
      <div className="execution-flow-layout">
        <div className="execution-flow-canvas" aria-label="执行流程画布">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            minZoom={0.15}
            maxZoom={1.5}
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            proOptions={{ hideAttribution: false }}
          >
            <Background color="var(--line)" gap={24} />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor="var(--accent)"
              maskColor="var(--overlay)"
              pannable
              zoomable
            />
            <FocusNode
              id={selected?.id || ""}
              nodeIds={data.flow.nodes.map((node) => node.id)}
            />
          </ReactFlow>
        </div>
        <ExecutionNodeDetail
          taskId={data.selected!.id}
          nodeId={selected?.id || ""}
          updatedAt={data.selected!.updatedAt}
        />
      </div>
    </>
  );
}
