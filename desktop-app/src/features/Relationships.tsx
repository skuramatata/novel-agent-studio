import { useEffect, useState, useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  type NodeProps,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Plus,
  GitBranch,
  UserRound,
  Trash2,
  Save,
  Move,
  X,
} from "lucide-react";
import { useStudio } from "../state/StudioContext";
import type { Character, Relation } from "../lib/types";
function PersonNode({ data, selected }: NodeProps) {
  return (
    <div className={"person-node " + (selected ? "selected" : "")}>
      <Handle type="target" position={Position.Left} />
      <div className="person-avatar">{String(data.name).slice(0, 1)}</div>
      <span className="person-info">
        <b>{String(data.name)}</b>
        <small>{String(data.role || "人物")}</small>
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { person: PersonNode };
function PersonEditor({
  person,
  onClose,
}: {
  person: Character;
  onClose: () => void;
}) {
  const { update, setNotice } = useStudio();
  const [draft, setDraft] = useState(person);
  return (
    <>
      <div className="inspector-title">
        <h3>人物档案</h3>
        <button
          className="icon-button"
          aria-label="关闭人物详情"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {(["name", "role", "goal", "secret", "voice"] as const).map((k, i) => (
        <label key={k}>
          {
            [
              "姓名",
              "身份与角色",
              "想得到什么",
              "隐瞒的事 / 知识边界",
              "人物声音",
            ][i]
          }
          <textarea
            rows={k === "name" ? 1 : 3}
            value={draft[k]}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          />
        </label>
      ))}
      <button
        className="primary full"
        disabled={!draft.name.trim()}
        onClick={async () => {
          if (
            await update((p) => ({
              ...p,
              characters: p.characters.map((c) =>
                c.id === draft.id ? { ...draft, position: c.position } : c,
              ),
            }))
          )
            setNotice("人物档案已保存");
        }}
      >
        <Save size={15} />
        保存人物
      </button>
      <button
        className="danger text-button"
        onClick={async () => {
          if (
            await update((p) => ({
              ...p,
              characters: p.characters.filter((c) => c.id !== person.id),
              relations: p.relations.filter(
                (r) => r.source !== person.id && r.target !== person.id,
              ),
            }))
          )
            onClose();
        }}
      >
        <Trash2 size={14} />
        删除人物及关联连线
      </button>
    </>
  );
}
function RelationEditor({
  relation,
  onClose,
}: {
  relation: Relation;
  onClose: () => void;
}) {
  const { project, update, setNotice } = useStudio();
  const [draft, setDraft] = useState(relation);
  return (
    <>
      <div className="inspector-title">
        <h3>关系详情</h3>
        <button
          className="icon-button"
          aria-label="关闭关系详情"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {(["source", "target"] as const).map((k, i) => (
        <label key={k}>
          {i ? "指向谁" : "谁的立场"}
          <select
            value={draft[k]}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          >
            {project!.characters.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label>
        关系名称
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </label>
      <label>
        关系与变化
        <textarea
          rows={7}
          value={draft.detail}
          onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
        />
      </label>
      <p className="muted small">关系有方向。A 信任 B，不等于 B 也信任 A。</p>
      <button
        className="primary full"
        disabled={!draft.label.trim() || draft.source === draft.target}
        onClick={async () => {
          if (
            await update((p) => ({
              ...p,
              relations: p.relations.map((r) =>
                r.id === draft.id ? draft : r,
              ),
            }))
          )
            setNotice("关系已更新");
        }}
      >
        <Save size={15} />
        保存关系
      </button>
      <button
        className="danger text-button"
        onClick={async () => {
          if (
            await update((p) => ({
              ...p,
              relations: p.relations.filter((r) => r.id !== relation.id),
            }))
          )
            onClose();
        }}
      >
        <Trash2 size={14} />
        删除这条关系
      </button>
    </>
  );
}
export function Relationships() {
  const fitGraph = useRef<(() => void) | null>(null);
  const { project, update, setNotice } = useStudio();
  const [selected, setSelected] = useState<{
    type: "person" | "relation";
    id: string;
  } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(
    project!.characters.map((c) => ({
      id: c.id,
      type: "person",
      position: c.position,
      data: { name: c.name, role: c.role },
    })),
  );
  useEffect(() => {
    setNodes(
      project!.characters.map((c) => ({
        id: c.id,
        type: "person",
        position: c.position,
        data: { name: c.name, role: c.role },
      })),
    );
  }, [project!.characters, setNodes]);
  const edges = project!.relations.map((r) => ({
    id: r.id,
    source: r.source,
    target: r.target,
    label: r.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--muted)" },
    style: { stroke: "var(--muted)", strokeWidth: 2 },
    labelStyle: { fill: "var(--text)", fontSize: 11 },
    labelBgStyle: { fill: "var(--surface)" },
    labelBgPadding: [9, 5] as [number, number],
    labelBgBorderRadius: 5,
  }));
  const connect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const id = crypto.randomUUID();
      if (
        await update((p) => ({
          ...p,
          relations: [
            ...p.relations,
            {
              id,
              source: c.source!,
              target: c.target!,
              label: "新关系",
              detail: "",
            },
          ],
        }))
      )
        setSelected({ type: "relation", id });
    },
    [update],
  );
  async function addPerson() {
    const id = crypto.randomUUID();
    if (
      await update((p) => ({
        ...p,
        characters: [
          ...p.characters,
          {
            id,
            name: "新人物",
            role: "待补充身份",
            goal: "",
            secret: "",
            voice: "",
            position: {
              x: 80 + (p.characters.length % 3) * 270,
              y: 80 + Math.floor(p.characters.length / 3) * 160,
            },
          },
        ],
      }))
    )
      setSelected({ type: "person", id });
  }
  const person =
    selected?.type === "person"
      ? project!.characters.find((c) => c.id === selected.id)
      : null;
  const relation =
    selected?.type === "relation"
      ? project!.relations.find((r) => r.id === selected.id)
      : null;
  return (
    <div className="graph-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">秘密，总在人与人之间</span>
          <h1>人物关系</h1>
          <p>拖动人物安排布局，连接右侧圆点与另一个人物的左侧圆点。</p>
        </div>
        <div className="modal-actions">
          <button
            className="secondary"
            disabled={!nodes.length}
            onClick={async () => {
              const columns = Math.max(2, Math.ceil(Math.sqrt(nodes.length)));
              if (
                await update((p) => ({
                  ...p,
                  characters: p.characters.map((c, i) => ({
                    ...c,
                    position: {
                      x: 60 + (i % columns) * 340,
                      y: 60 + Math.floor(i / columns) * 200,
                    },
                  })),
                }))
              ) {
                setNotice("人物已自动排列，可继续拖动微调");
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    fitGraph.current?.();
                  }),
                );
              }
            }}
          >
            <GitBranch size={16} />
            自动排列
          </button>
          <button className="primary" onClick={() => void addPerson()}>
            <Plus size={17} />
            添加人物
          </button>
        </div>
      </div>
      <div className="graph-layout">
        <div className="graph-canvas">
          <div className="canvas-label">
            <span className="status-pill">
              <i />
              {project!.characters.length} 位人物 · {project!.relations.length}{" "}
              条关系
            </span>
            <span>
              <Move size={13} />
              拖动即保存
            </span>
          </div>
          <ReactFlow
            onInit={(instance) => {
              fitGraph.current = () => { void instance.fitView({ padding: 0.25, maxZoom: 1 }); };
            }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={(c) => void connect(c)}
            onNodeClick={(_, n) => setSelected({ type: "person", id: n.id })}
            onEdgeClick={(_, e) => setSelected({ type: "relation", id: e.id })}
            onPaneClick={() => setSelected(null)}
            onNodeDragStop={(_, n) => {
              const movedId = n.id;
              const position = { ...n.position };
              void update((p) => ({
                ...p,
                characters: p.characters.map((c) =>
                  c.id === movedId ? { ...c, position } : c,
                ),
              })).then((ok) => {
                if (ok) setNotice("人物位置已保存");
              });
            }}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.8}
          >
            <Background color="var(--line)" gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap nodeColor="var(--accent)" maskColor="var(--overlay)" />
          </ReactFlow>
          {!nodes.length && (
            <div className="canvas-empty">
              <GitBranch size={36} />
              <h3>从第一个人物开始</h3>
              <p>手动添加，或通过创作对话生成整个人物网络。</p>
              <button className="secondary" onClick={() => void addPerson()}>
                <Plus size={15} />
                添加人物
              </button>
            </div>
          )}
        </div>
        <aside className="graph-inspector">
          {person ? (
            <PersonEditor
              key={person.id}
              person={person}
              onClose={() => setSelected(null)}
            />
          ) : relation ? (
            <RelationEditor
              key={relation.id}
              relation={relation}
              onClose={() => setSelected(null)}
            />
          ) : (
            <>
              <div className="inspector-empty">
                <UserRound size={26} />
                <h3>每条线，都有一个故事</h3>
                <p>选择人物查看档案，选择连线调整关系。</p>
              </div>
              <div className="relation-list">
                <span className="eyebrow">全部关系</span>
                {project!.relations.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelected({ type: "relation", id: r.id })}
                  >
                    <b>
                      {project!.characters.find((c) => c.id === r.source)?.name}{" "}
                      →{" "}
                      {project!.characters.find((c) => c.id === r.target)?.name}
                    </b>
                    <span>{r.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
