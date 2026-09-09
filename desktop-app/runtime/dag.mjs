// 小型持久化DAG执行器：依赖先行、逐节点提交、失败保留、恢复跳过已完成节点。
// 当前串行调度就绪节点，避免共享检查点并发写入；图不等于必须并行。
export async function runDag(nodes, { state, save, signal, key }) {
  const ids = new Set(nodes.map((n) => n.id));
  if (
    ids.size !== nodes.length ||
    nodes.some((n) => n.deps.some((d) => !ids.has(d)))
  )
    throw Error("任务图节点重复或依赖不存在。");
  const ordered = [],
    remaining = [...nodes];
  while (remaining.length) {
    const i = remaining.findIndex((n) =>
      n.deps.every((d) => ordered.some((x) => x.id === d)),
    );
    if (i < 0) throw Error("任务图存在循环依赖。");
    ordered.push(...remaining.splice(i, 1));
  }
  state.graphs ??= {};
  const shape = JSON.stringify(nodes.map(({ id, deps }) => ({ id, deps })));
  const graph = (state.graphs[key] ??= { shape, nodes: {} });
  if (graph.shape !== shape)
    throw Error("任务图已变化，请基于当前设定重新开始。");
  const outputs = {};
  for (const node of ordered) {
    signal.throwIfAborted();
    const record = graph.nodes[node.id];
    if (record?.status === "completed") {
      outputs[node.id] = node.validate(structuredClone(record.output));
      continue;
    }
    graph.nodes[node.id] = {
      status: "running",
      startedAt: new Date().toISOString(),
    };
    await save();
    try {
      const output = node.validate(await node.run(outputs));
      signal.throwIfAborted();
      graph.nodes[node.id] = {
        status: "completed",
        output,
        completedAt: new Date().toISOString(),
      };
      await save();
      outputs[node.id] = output;
    } catch (e) {
      graph.nodes[node.id] = {
        status: signal.aborted ? "interrupted" : "failed",
        error: e.message,
      };
      await save();
      throw e;
    }
  }
  return outputs;
}
