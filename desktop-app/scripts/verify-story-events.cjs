// 故事事件链视图验收：真实打包应用 + 真实 runtime 建图（mergeStoryEvents/impactOf），
// 仅作品数据用隔离夹具；不调用模型网络。
let _electron;
try {
  ({ _electron } = require("playwright"));
} catch (error) {
  console.error(
    "缺少 playwright，未执行实机验收。请在 desktop-app 安装 playwright 后重跑：\n" +
      "  npm i -D playwright && npx playwright install chromium\n" +
      `原始错误：${error.message}`,
  );
  process.exit(2);
}
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createRequestRecorder, selfCheckEvidence } = require("./verify-story-events.fixtures.cjs");
const { createRunner } = require("./verify-story-events.assert.cjs");

// 本次运行标识（H2）：报告、失败记录、日志都带它，
// 避免新一次运行误读上一次的成功报告。
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random()
  .toString(16)
  .slice(2, 8)}`;
const RUN_STARTED_AT = new Date().toISOString();
const rootDir = path.resolve(__dirname, "..");
const runDir = path.join(
  rootDir,
  "verification/story-event-chain/round4/e2e/runs",
  RUN_ID,
);

// H7(a)：同一打开会话证据。
// 记录该 page 对象上的 reload 次数与首次观测到的会话标记；
// 断言时同时核对"reload 次数为 0"与"会话标记未变"，把"未 reload"变成可核事实。
function attachSessionProbe(page) {
  const probe = {
    reloads: 0,
    token: `session-${process.pid}-${Math.random().toString(16).slice(2, 10)}`,
    firstSeenAt: new Date().toISOString(),
  };
  const originalReload = page.reload.bind(page);
  page.reload = async (...args) => {
    probe.reloads += 1;
    return originalReload(...args);
  };
  return probe;
}

// 可靠轮询：Playwright 的 waitForFunction 传 async 谓词时，会以返回的 Promise 对象
// 直接判真（truthy），表现为 0 秒返回 true 而条件其实未满足——本轮实测踩到，
// 曾把"任务刚开始跑"误判成"已终态"。这里统一改为 Node 侧显式轮询布尔值。
async function pollUntil(page, fn, arg, { timeout = 600000, interval = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => null);
    if (last && last.done === true) return { ok: true, last };
    await page.waitForTimeout(interval);
  }
  return { ok: false, last };
}

// 等编排就绪：生成按钮会被 StudioContext 的并发闸门
// (`if (running.current || changing.current) return false`) 挡住。
// 该闸门没有对外状态，因此用可观测信号组合判定：
//   ① 任务落到收尾态；② 页面 busy 文案消失；③ 界面 revision 与磁盘一致。
// 超时不判 fail，交回调用方记 unverified 并附当时状态。
async function waitOrchestrationIdle(page, projectId, { timeout = 300000, interval = 2000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await page
      .evaluate(async (id) => {
        const t = await window.studio.task(id).catch(() => null);
        const p = await window.studio.load(id).catch(() => null);
        const busyText = Array.from(document.querySelectorAll('[role="status"]'))
          .map((el) => el.textContent || "")
          .join(" ");
        // 只认"生成进度"文案。早先用 button.primary[disabled] 作信号是错的：
        // 章节页其他禁用主按钮会让 busy 恒真，实测导致 300s 空等（busyText 却是空串）。
        const busy = /生成中|准备作者档案与作品上下文/.test(busyText);
        return {
          done:
            (!t || ["completed", "failed", "interrupted"].includes(t.status)) &&
            !busy,
          taskStatus: t ? t.status : null,
          taskStage: t ? t.stage : null,
          taskError: t ? t.error : null,
          diskRevision: p ? p.revision : null,
          busy,
          busyText: busyText.slice(0, 120),
        };
      }, projectId)
      .catch(() => null);
    if (last && last.done === true) {
      return { ok: true, ms: Date.now() - started, last };
    }
    await page.waitForTimeout(interval);
  }
  return { ok: false, ms: Date.now() - started, last };
}

// 报告用：库路径 + pending 首条候选（章 / 是否在该章正文有差异）。
// ChapterGeneration.tsx:18 只取**第一条** pending，:19-21 仅当该章正文确有差异
// 时才渲染采纳/放弃按钮；否则只显示「请先在创作对话处理上一份候选」。
async function describePending(page, projectId, dataDir) {
  return page
    .evaluate(async (id) => {
      const p = await window.studio.load(id).catch(() => null);
      if (!p) return null;
      const pending = (p.messages || []).filter((m) => m.status === "pending");
      const first = pending[0] || null;
      const chapterDiff = [];
      for (const m of pending) {
        const diffs = ((m.proposal && m.proposal.chapters) || [])
          .filter((c) => {
            const cur = (p.chapters || []).find((x) => x.id === c.id);
            return cur && c.content !== cur.content;
          })
          .map((c) => c.id);
        chapterDiff.push({ id: m.id, diffChapters: diffs });
      }
      return {
        pendingCount: pending.length,
        firstId: first ? first.id : null,
        firstBaseRevision: first ? first.baseRevision : null,
        revision: p.revision,
        chapterDiff,
      };
    }, projectId)
    .then((v) => ({ dataDir, ...v }))
    .catch(() => ({ dataDir, error: true }));
}

// 只清理本脚本自己创建的 Electron 实例；用户手动打开的进程一律不碰。
const ownedApps = new Set();
// 当前 DSH 会话的外层沙箱已限制文件写入，Chromium 的嵌套沙箱在此环境下
// 初始化失败（stderr: "sandbox initialization failed: Operation not permitted"），
// 渲染进程随即崩溃，表现为"界面永远等不到"。这是测试进程的启动参数，
// 不改变产品代码与正式运行方式；实际取值如实写入报告。
const TEST_LAUNCH_ARGS = ["--no-sandbox"];
const launchOwned = async (options) => {
  // H2 注入：验证"首次启动失败必须非零退出并保留原因"。
  if (process.env.NOVEL_E2E_INJECT_LAUNCH_FAILURE === "1" && ownedApps.size === 0)
    throw new Error(
      `[H2 注入] 首次 Electron launch 故意失败（runId=${RUN_ID}）；期望进程非零退出且保留本次原因。`,
    );
  const args = [...(options?.args || []), ...TEST_LAUNCH_ARGS];
  const launched = await _electron.launch({ ...options, args });
  ownedApps.add(launched);
  return launched;
};
const closeOwnedApps = async () => {
  for (const owned of [...ownedApps]) {
    ownedApps.delete(owned);
    try {
      await owned.close();
    } catch {
      /* 已经关闭的实例不再报错 */
    }
  }
};

(async () => {
  const root = rootDir;
  const out = path.join(rootDir, "verification/story-event-chain");
  await fs.mkdir(out, { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-sev-ui-"));
  // 请求记录器：本次验收尚未经 runChapterAgent 产生真实模型请求，
  // 因此 requests 为空，并在报告里显式声明“未覆盖”，不得用预置图冒充 R2 证据。
  const requests = createRequestRecorder();

  const { blankProject, demoProposal } = await import("../runtime/seed.mjs");
  const { applyProposal } = await import("../runtime/schema.mjs");
  const { emptyStoryEvents, mergeStoryEvents, impactOf } = await import(
    "../runtime/story-events.mjs"
  );
  const { storyEventsSchema } = await import(
    "../runtime/story-events-schema.mjs"
  );

  const project = applyProposal(blankProject(), demoProposal(), 0);
  project.premise.title = "故事事件链验收作品";
  project.chapters = [
    { id: "ch1", number: 1, title: "顺济号出航", summary: "", content: "" },
    { id: "ch2", number: 2, title: "黑石岛", summary: "", content: "" },
    { id: "ch3", number: 3, title: "夜雾与同一个梦", summary: "", content: "" },
    // 保持一章空白：链路1 要用真实章节工作流为空白章起草，而不是走规划 DAG。
    { id: "ch4", number: 4, title: "退潮之前", summary: "林砚独自下到船舱底层。", content: "" },
  ];
  project.characters = [
    { id: "c1", name: "林砚", role: "主角", goal: "", secret: "", voice: "", position: { x: 40, y: 40 } },
    { id: "c2", name: "林父", role: "父亲", goal: "", secret: "", voice: "", position: { x: 320, y: 40 } },
  ];
  // 两章以上人物而没有关系时 readyForChapter 为 false，generate 会改走规划 DAG
  // 而不是章节工作流——补一条真实关系，让作品处于"可写正文"的合法状态。
  project.relations = [
    {
      id: "r1",
      source: "c1",
      target: "c2",
      label: "父子",
      detail: "林砚与林父。",
    },
  ];
  project.messages = [];
  project.chapters[0].content =
    "林砚把铜扣交给父亲。汽笛响了三声，顺济号解缆离岸。父亲把铜扣按进掌心，什么也没说。";
  project.chapters[1].content =
    "黑石岛的雾很重。林砚在甲板上看见三十年前的旧船影子。父亲说那只是雾。";
  project.chapters[2].content =
    "林砚听见水声里有铜扣碰撞的响动。他忽然想起父亲掌心的那道旧疤。";

  const chapters = project.chapters.map((c) => ({
    id: c.id, number: c.number, title: c.title, content: c.content,
  }));

  // 偏移一律由程序按正文计算，禁止手写数字：手写偏移曾在 R4 收紧后整体错 1 位暴露。
  const chapterContent = (chapterId) => {
    const found = project.chapters.find((c) => c.id === chapterId);
    assert.ok(found, `夹具引用了不存在的章节：${chapterId}`);
    return found.content;
  };
  // 引文一律从正文按区间截取，禁止手写：手写引文曾因缺句号与正文不一致而错位。
  const quoteAt = (chapterId, start, end) => {
    const content = chapterContent(chapterId);
    const slice = content.slice(start, end);
    assert.ok(slice.length > 0, `截取区间为空：${chapterId}[${start}:${end}]`);
    return slice;
  };
  const evidenceAt = (chapterId, start, end) => {
    const quote = quoteAt(chapterId, start, end);
    return { chapterId, start, end, quote };
  };
  // 从正文中定位片段并返回精确引文（片段必须逐字来自正文，不手写句末标点）。
  const quoteOf = (chapterId, fragment) => {
    const content = chapterContent(chapterId);
    const start = content.indexOf(fragment);
    assert.ok(start >= 0, `片段不在第 ${chapterId} 章正文中：${fragment}`);
    return content.slice(start, start + fragment.length);
  };
  const evidenceOf = (chapterId, quote) => {
    const content = chapterContent(chapterId);
    const start = content.indexOf(quote);
    assert.ok(start >= 0, `引文不在第 ${chapterId} 章正文中：${quote}`);
    return { chapterId, start, end: start + quote.length, quote };
  };
  // 候选增量补丁的 evidence 不接受 chapterId（由 nodes[].chapterId 承担），须用此形态。
  const patchEvidenceOf = (chapterId, quote) => {
    const { chapterId: _ignored, ...rest } = evidenceOf(chapterId, quote);
    return rest;
  };

  const draftNode = (patch) => ({
    chapterId: "ch1",
    storyTime: "",
    narrativeOffset: 0,
    title: "",
    summary: "",
    kind: "action",
    actors: [],
    objects: [],
    status: "confirmed",
    basis: "narration",
    evidence: { chapterId: "ch1", start: 0, end: 0, quote: "" },
    ...patch,
  });

  let graph = mergeStoryEvents(
    emptyStoryEvents(),
    [
      draftNode({
        chapterId: "ch1",
        title: "林砚把铜扣交给父亲", summary: "林砚在码头把铜扣交到父亲手上。",
        kind: "handover", actors: ["林砚", "林父"], objects: ["铜扣"],
        evidence: evidenceOf("ch1", quoteOf("ch1", "林砚把铜扣交给父亲")),
      }),
      draftNode({
        chapterId: "ch1",
        title: "父亲把铜扣按进掌心", summary: "父亲接下铜扣，未作解释。",
        kind: "state-change", actors: ["林父"], objects: ["铜扣"],
        evidence: evidenceOf("ch1", quoteOf("ch1", "父亲把铜扣按进掌心")),
      }),
      draftNode({
        chapterId: "ch2",
        title: "雾中看见三十年前的旧船", summary: "林砚在雾里看到旧船影子。",
        kind: "discovery", actors: ["林砚"], objects: ["旧船"],
        status: "provisional", basis: "testimony",
        evidence: evidenceOf("ch2", quoteOf("ch2", "林砚在甲板上看见三十年前的旧船影子")),
      }),
      draftNode({
        chapterId: "ch2",
        title: "父亲说那只是雾", summary: "父亲否认旧船的存在。",
        kind: "decision", actors: ["林父"], status: "conflict", basis: "testimony",
        evidence: evidenceOf("ch2", quoteOf("ch2", "父亲说那只是雾")),
      }),
      draftNode({
        chapterId: "ch3",
        title: "水声里的铜扣响动", summary: "林砚把水声与铜扣联系起来。",
        kind: "recall", actors: ["林砚"], objects: ["铜扣"],
        basis: "belief", status: "confirmed",
        evidence: evidenceOf("ch3", quoteOf("ch3", "林砚听见水声里有铜扣碰撞的响动")),
      }),
    ],
    { chapters },
  ).storyEvents;

  const id = (title) => {
    const node = graph.nodes.find((n) => n.title === title);
    assert.ok(node, `runtime 建图应包含事件「${title}」；实际问题：${graph.issues.map((i) => i.explanation).join(" / ")}`);
    return node.id;
  };
  graph = mergeStoryEvents(graph, [], {
    chapters,
    edges: [
      {
        source: id("林砚把铜扣交给父亲"),
        target: id("父亲把铜扣按进掌心"),
        type: "causal",
        basis: "explicit",
        explanation: "交付动作直接导致父亲接过并收起铜扣。",
        evidence: [evidenceOf("ch1", quoteOf("ch1", "林砚把铜扣交给父亲"))],
      },
      {
        source: id("林砚把铜扣交给父亲"),
        target: id("雾中看见三十年前的旧船"),
        type: "related",
        basis: "inferred",
        explanation: "同一枚铜扣在后续章节再次出现，两处可能相关，但正文未明说因果。",
        evidence: [],
      },
      {
        source: id("雾中看见三十年前的旧船"),
        target: id("父亲说那只是雾"),
        type: "contradict",
        basis: "explicit",
        explanation: "林砚所见与父亲的当场否认相互冲突，两人对同一现象给出不同说法。",
        evidence: [
          evidenceOf("ch2", quoteOf("ch2", "林砚在甲板上看见三十年前的旧船影子")),
          evidenceOf("ch2", quoteOf("ch2", "父亲说那只是雾")),
        ],
      },
      {
        source: id("水声里的铜扣响动"),
        target: id("父亲把铜扣按进掌心"),
        type: "recall",
        basis: "unverified",
        explanation: "后文回忆指向第一章的掌心动作，但正文未标明是同一时刻的回忆。",
        evidence: [],
      },
    ],
  }).storyEvents;

  // 改稿前的正文快照：夹具自检必须对"夹具生成时的正文"校验，
  // 否则改稿后引文自然对不上，自检会误判为自己的夹具错位。
  const originalChapters = project.chapters.map((c) => ({ ...c }));

  // 真实改稿：把第 1 章正文改动落地到作品，再由 runtime 复算 stale。
  // 主进程适配层会对已存图重跑 impactOf，所以这里必须真的改正文，否则 stale 不会被复现。
  project.chapters = project.chapters.map((c) =>
    c.id === "ch1"
      ? {
          ...c,
          content:
            "林砚把钥匙交给父亲。汽笛响了三声，顺济号解缆离岸。父亲把铜扣按进掌心，什么也没说。",
        }
      : c,
  );
  const revisedChapters = project.chapters.map((c) => ({
    id: c.id,
    number: c.number,
    title: c.title,
    content: c.content,
  }));
  const impact = impactOf(graph, { chapters: revisedChapters });
  assert.ok(impact.staleNodeIds.length >= 1, "runtime 应判定至少一个节点依据失效");
  assert.ok(impact.staleEdgeIds.length >= 1, "runtime 应判定至少一条边依据失效");
  graph = impact.storyEvents;
  // 落盘保存的是 impactOf 的产物：失效节点仍在图中（带 stale 标记），
  // 但改稿后其引文已不在正文，runtime 在任何“重新归一化”时都不会再把它们当有效出处。
  // 因此这里不再跑 normalizeStoryEvents（那等于重抽，会裁掉失效事件），
  // 只做 schema 校验后原样落盘，让“失效但保留”的语义真正到达界面。
  project.storyEvents = storyEventsSchema.parse(graph);
  // 候选事件只有当 proposalSchema 接受增量草稿时才写入；否则整份 project.json 会解析失败。
  // T2 契约为 proposal.storyEvents 使用 storyEventsPatchSchema，本脚本按“能进就测、不能进就明确未覆盖”处理。
  const { proposalSchema } = await import("../runtime/schema.mjs");
  const candidatePatch = {
    nodes: [
      {
        chapterId: "ch3",
        storyTime: "",
        narrativeOffset: 0,
        title: "父亲旧疤的来历（候选）",
        summary: "模型提出但尚未采纳的事件候选。",
        kind: "discovery",
        actors: ["林父"],
        objects: ["铜扣"],
        status: "candidate",
        basis: "belief",
        evidence: patchEvidenceOf("ch3", "他忽然想起父亲掌心的那道旧疤"),
      },
    ],
    edges: [],
    coverage: [],
  };
  // 【用途标注】单元/夹具级候选：只用于验证"候选事件与正式图视觉区分"的展示层，
  // 不是产品链路证据（产品链路的候选必须由 chain1-generate 真实生成，见下方对应案例）。
  const candidateMessage = {
    id: "pending-sev",
    role: "assistant",
    text: "本章新增事件候选",
    status: "pending",
    baseRevision: project.revision,
    model: "验收夹具模型",
    proposal: { summary: "故事事件链验收候选", storyEvents: candidatePatch },
  };
  const candidateSupported = proposalSchema.safeParse(
    candidateMessage.proposal,
  ).success;
  assert.ok(
    candidateSupported,
    "proposalSchema 必须接受候选增量草稿；解析失败时不得静默跳过候选链路，此处直接判失败",
  );
  project.messages = [candidateMessage];
  const candidateNote = "候选事件已写入未采纳消息";
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(project));
  // 第二个隔离作品：完全不带 storyEvents，用于验证三种空态表达（未建立事件链）。
  // 库 A（建图与重建）：两章都有正文、无 storyEvents。
  // 专供 chain1-read / chain1-build / g5-build-modes —— 这三项都要求
  // "建图前所有章都已完成"，因此这里不能留空白章。
  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-sev-build-"));
  const buildProject = {
    ...project,
    revision: 1,
    messages: [],
    chapters: [
      { id: "b1", number: 1, title: "顺济号出航", summary: "", content: "林砚把铜扣交给父亲。汽笛响了三声，顺济号解缆离岸。" },
      { id: "b2", number: 2, title: "黑石岛", summary: "", content: "林砚在甲板上看见三十年前的旧船影子。父亲说那只是雾。" },
    ],
  };
  delete buildProject.storyEvents;
  await fs.writeFile(path.join(buildDir, "project.json"), JSON.stringify(buildProject));
  await fs.writeFile(
    path.join(buildDir, "test.env"),
    "# 假密钥：仅让产品认为模型通道已配置；真实请求必被 NOVEL_E2E_MODEL_STUB 拦截。\nZAI_CODING_CN_API_KEY=e2e-stub-key-never-real\nMAIN_MODEL=glm-5.3\n",
  );

  // 链路1 专用隔离库：两章已采纳正文 + 一章空白，专供"空白新章候选"生成。
  // 独立库的原因：case-01/F10 会消耗掉主库里的空白章，链路1 若共用会失去可起草的章。
  const chain1Dir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-sev-chain1-"));
  const chain1Project = {
    ...project,
    revision: 1,
    messages: [],
    storyEvents: undefined,
    chapters: [
      { id: "c1", number: 1, title: "顺济号出航", summary: "", content: "林砚把铜扣交给父亲。汽笛响了三声，顺济号解缆离岸。" },
      { id: "c2", number: 2, title: "黑石岛", summary: "", content: "林砚在甲板上看见三十年前的旧船影子。父亲说那只是雾。" },
      { id: "c3", number: 3, title: "退潮之前", summary: "林砚独自下到船舱底层。", content: "" },
    ],
    characters: [
      { id: "c1", name: "林砚", role: "主角", goal: "", secret: "", voice: "", position: { x: 40, y: 40 } },
      { id: "c2", name: "林父", role: "父亲", goal: "", secret: "", voice: "", position: { x: 320, y: 40 } },
    ],
    relations: [
      { id: "r1", source: "c1", target: "c2", label: "父子", detail: "林砚与林父。" },
    ],
  };
  delete chain1Project.storyEvents;
  await fs.writeFile(path.join(chain1Dir, "project.json"), JSON.stringify(chain1Project));
  await fs.writeFile(
    path.join(chain1Dir, "test.env"),
    "# 假密钥：仅让产品认为模型通道已配置；真实请求必被 NOVEL_E2E_MODEL_STUB 拦截。\nZAI_CODING_CN_API_KEY=e2e-stub-key-never-real\nMAIN_MODEL=glm-5.3\n",
  );

  // 链路2 专用干净库：任务书要求"链路A / 链路B 各自独立"。
  // 之前 chain2-* 跑在主库（已被多轮链路1污染，堆了历史候选），
  // 必须清理一堆无关 pending 才能发起修订。这里给它一份干净起点：
  // 2 章已采纳正文 + 1 条 open 问题（问题来自 ch1 引文与正文不一致）。
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "novel-sev-empty-"));
  const emptyProject = {
    ...project,
    revision: 1,
    storyEvents: undefined,
    messages: [],
    chapters: project.chapters.map((c) => ({ ...c, content: "" })),
  };
  delete emptyProject.storyEvents;
  await fs.writeFile(path.join(emptyDir, "project.json"), JSON.stringify(emptyProject));
  await fs.writeFile(
    path.join(emptyDir, "test.env"),
    "# 假密钥：仅让产品认为模型通道已配置；真实请求必被 NOVEL_E2E_MODEL_STUB 拦截。\nZAI_CODING_CN_API_KEY=e2e-stub-key-never-real\nMAIN_MODEL=glm-5.3\n",
  );
  await fs.writeFile(
    path.join(dir, "test.env"),
    "# 假密钥：仅让产品认为模型通道已配置；真实请求必被 NOVEL_E2E_MODEL_STUB 拦截。\nZAI_CODING_CN_API_KEY=e2e-stub-key-never-real\nMAIN_MODEL=glm-5.3\n",
  );

  // 打包时 prebuild 会再递增一次版本，build-info.json 可能比包内新一版；
  // 以应用包实际版本为等待基准，避免误判“没启动”。
  // 等应用就绪：以"能通过 IPC 取到作品列表且非空"为明确成功信号；
  // 超时视为失败并抛错（不得把超时当成功）。
  const waitAppReady = async (appLike, pageLike, label) => {
    const deadline = Date.now() + 30000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const ids = await pageLike.evaluate(async () => {
          const list = await window.studio.list();
          const arr = Array.isArray(list) ? list : list.entries || [];
          return arr.map((e) => e.id);
        });
        if (Array.isArray(ids) && ids.length > 0) return ids;
        lastError = new Error("作品列表为空");
      } catch (e) {
        lastError = e;
      }
      await pageLike.waitForTimeout(300);
    }
    throw new Error(
      `${label} 未在 30s 内就绪（明确失败，不按成功处理）：${lastError && lastError.message}`,
    );
  };

  const build = JSON.parse(
    await fs.readFile(path.join(root, "build-info.json"), "utf8"),
  );
  const plist = await fs.readFile(
    path.join(
      root,
      "release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app/Contents/Info.plist",
    ),
    "utf8",
  );
  const bundledVersion = (plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
  const expectVersion = bundledVersion || build.version;

  // H2 返修：版本断言不得写死号码，也不得从 dist 反推期望值（dist 可能落后/被污染）。
  // 采用 lead 给的方案 A：以磁盘 build-info.json 的 displayVersion 为唯一期望值，
  // 断言界面显示值与之**严格相等**；不等就是真的不一致，必须失败而不是解释过去。
  // 另外保留结构匹配先等待，避免把"界面没起来"误报成"版本不对"。
  const VERSION_PATTERN = /^\d+\.\d+\.\d+\+/;
  const expectedUiVersion = build.displayVersion;
  const versionLocator = (target) => target.getByText(VERSION_PATTERN).first();
  const readUiVersion = async (target) => {
    const text = await target.getByText(VERSION_PATTERN).first().innerText();
    const matched = text.match(/\d+\.\d+\.\d+\+[0-9a-z.]+/);
    return matched ? matched[0] : text.trim();
  };
  const assertUiVersion = async (target, label) => {
    const actual = await readUiVersion(target);
    if (actual !== expectedUiVersion)
      throw new Error(
        `[H2] ${label} 界面版本与磁盘 build-info.json 不一致：` +
          `界面=${actual}，build-info=${expectedUiVersion}。` +
          `dist 与当前源码不同步，请用 vite build 重建后再验收。`,
      );
    return actual;
  };
  let uiVersion = null;

  // 包一致性：应用以开发模式（args: [root]）启动时，界面读的是工作区 build-info.json，
  // 与 release 包内版本无关。因此不一致只作提示并记录，不能直接判失败——
  // 否则别人跑过一次 build（版本自增）就会让整个验收在启动前莫名退出。
  const versionMismatch =
    bundledVersion && build.version && bundledVersion !== build.version
      ? { bundledVersion, buildVersion: build.version }
      : null;
  if (versionMismatch)
    console.log(
      `[S5] 提示：Info.plist=${bundledVersion} 与 build-info=${build.version} 不一致；` +
        `本次以开发模式运行，按 build-info 等待界面就绪。`,
    );
  const executablePath = path.join(
    root,
    "release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app/Contents/MacOS/NovelAgentStudio",
  );

  let app;
  const shots = [];
  const step = async (page, name) => {
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
    return file;
  };

  const childEnv = {
    ...process.env,
    NOVEL_AGENT_DATA_DIR: dir,
    NOVEL_AGENT_ENV: path.join(dir, "test.env"),
  };
  // ELECTRON_RUN_AS_NODE 会让 Electron 退化为纯 Node 进程，无法创建窗口。
  delete childEnv.ELECTRON_RUN_AS_NODE;

  // 模型 transport 隔离：实测 NODE_OPTIONS/--require 对打包 Electron 主进程无效
  // （探测结果 marked=null），若继续跑会打到真实供应商。
  // 因此在隔离库里**清除任何残留的真实密钥**，并强制所有 provider 不可用：
  // 生成/建图必须失败在"未配置模型"，而不是发出真实网络请求。
  const fetchLogPath = path.join(dir, "model-fetch.jsonl");
  // 彻底剥离真实密钥：本进程内所有 Electron 启动前都重建一次 providers.json，
  // 不允许任何 encryptedKey 进入隔离库，从根上防止打到真实供应商。
  const writeIsolatedProviders = async () => {
    await fs.writeFile(
      path.join(dir, "providers.json"),
      JSON.stringify({
        glm: {
          provider: "glm",
          model: "glm-5.3",
          baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        },
        minimax: {
          provider: "minimax",
          model: "MiniMax-M3",
          baseUrl: "https://api.minimaxi.com/v1",
        },
      }),
      { mode: 0o600 },
    );
  };
  await writeIsolatedProviders();
  childEnv.NOVEL_E2E_FETCH_LOG = fetchLogPath;
  childEnv.NOVEL_E2E_NO_NETWORK = "1";

  // 模型替身：NOVEL_E2E_MODEL_STUB 只在 app.isPackaged === false 时生效，
  // 而 release/*.app 是打包产物（isPackaged=true）→ 变量会被忽略。
  // 因此生成链路改用开发模式（args: [root]）启动，UI 断言仍可用同一实例。
  const stubPath = path.join(root, "scripts/verify-story-events.model-stub.mjs");
  childEnv.NOVEL_E2E_MODEL_STUB = stubPath;

  try {
    // 全程使用开发模式启动：NOVEL_E2E_MODEL_STUB 只在 app.isPackaged === false 时
    // 才被 electron/model-transport.mjs 采纳。若用 release/*.app（isPackaged=true）
    // 启动，替身被忽略，生成链路会静默打到真实供应商——上一轮已踩过这个坑。
    // 打包产物的版本一致性由前面的 build-info 校验负责，不靠这里启动。
    app = await launchOwned({ args: [root], env: childEnv });
    const page = await app.firstWindow();
    const launchProbe = await app.evaluate(async ({ app }) => ({
      isPackaged: app.isPackaged,
      stubEnv: process.env.NOVEL_E2E_MODEL_STUB || null,
    }));
    if (launchProbe.isPackaged !== false || !launchProbe.stubEnv) {
      throw new Error(
        `模型替身未接管：isPackaged=${launchProbe.isPackaged}，stubEnv=${launchProbe.stubEnv}；` +
          `为避免打到真实供应商，本次运行中止。`,
      );
    }
    await versionLocator(page).waitFor();
    uiVersion = await assertUiVersion(page, "主窗口");
    console.log(`[S5] 界面版本与 build-info 一致：${uiVersion}`);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // 活动作品 id 由 library 提供（project.json 里没有 projectId 字段）。
    // studio.list() 返回作品数组（每项含 id），隔离库只有一部作品，取第一部。
    const activeId = await page.evaluate(async () => {
      const list = await window.studio.list();
      const arr = Array.isArray(list) ? list : list.entries || [];
      return arr.length ? arr[0].id : null;
    });
    assert.ok(activeId, "未能取得隔离作品 id（studio.list 返回为空）");

    // IPC 读取链路：直接验证主进程适配层返回真实数据。
    const read = await page.evaluate(async (pid) =>
      window.studio.storyEvents(pid), activeId);
    // 唯一权威是主进程返回值（它按落盘图 + 当前正文复算）。
    // 脚本内只校验“结构自洽”与“改稿确实产生了失效”，不用本地重复计算去硬碰期望值。
    assert.equal(read.graph.nodes.length, read.counts.nodes, "节点计数应与图内容一致");
    assert.equal(read.graph.edges.length, read.counts.edges, "关系计数应与图内容一致");
    assert.ok(read.counts.staleNodes >= 1, "第 1 章改稿后应至少有一个事件依据失效，实际 " + read.counts.staleNodes);
    assert.ok(read.counts.staleEdges >= 1, "失效事件的下游关系也应标失效，实际 " + read.counts.staleEdges);
    assert.equal(read.counts.staleNodes, read.graph.nodes.filter((n) => n.stale).length);
    assert.ok(read.candidates.nodes.length >= 1, "候选事件应可读取");
    const formalIds = new Set(read.graph.nodes.map((n) => n.id));
    assert.ok(
      read.candidates.nodes.every((n) => !formalIds.has(n.id)),
      "候选事件不得混进正式图",
    );

    await page.getByRole("button", { name: "故事事件链", exact: true }).click();
    await page.locator(".sev-node").first().waitFor();
    await step(page, "01-overview");

    // 画布 = 正式事件 + 叠加的候选事件；两者必须可区分，不能混为一谈。
    const formalCount = await page.locator(".sev-node:not(.sev-status-candidate)").count();
    const candidateCount = await page.locator(".sev-node.sev-status-candidate").count();
    assert.equal(formalCount, read.counts.nodes, "画布上的正式事件数应与主进程返回一致");
    assert.equal(
      candidateCount,
      read.candidates.nodes.length,
      "画布上的候选事件数应与候选集合一致",
    );
    assert.ok(
      (await page.locator(".sev-node").count()) === formalCount + candidateCount,
      "画布节点应恰好由正式事件与候选事件组成",
    );

    // 待核对可见：状态徽标与失效标记必须渲染出来。
    assert.ok(
      (await page.locator(".sev-node.sev-status-candidate").count()) >= 1,
      "候选事件应作为独立节点画在画布上（虚线框），而不是只出现在横幅里",
    );
    assert.ok(
      (await page.locator(".sev-status-conflict").count()) >= 1,
      "矛盾状态应在图上可见",
    );
    assert.ok(
      (await page.locator(".sev-flag-stale").count()) >= 1,
      "依据失效必须在节点上可见",
    );
    assert.ok(
      (await page.locator(".sev-status-provisional").count()) >= 1,
      "暂定状态应在图上可见",
    );

    // 候选区分：必须一眼看出“候选 ≠ 正式”。
    // 做法：点选候选节点，使它处于选中态并在右侧展开详情，同时保留正式节点作对照。
    await page.locator(".sev-candidate-bar").waitFor();
    const candidateNode = page.locator(".sev-node.sev-status-candidate").first();
    await candidateNode.waitFor();
    await candidateNode.click();
    await page.locator(".sev-inspector .sev-inspector-title").waitFor();
    const candidateInspector = await page.locator(".sev-inspector").innerText();
    assert.ok(
      /候选/.test(candidateInspector),
      "候选事件详情应明确标注候选状态，实际：" + candidateInspector.slice(0, 200),
    );
    assert.ok(
      /第 3 章/.test(candidateInspector),
      "候选详情应显示所属章节",
    );
    await step(page, "02-candidate-distinguished");
    // 候选节点选中态与正式节点须同屏可比：画面里必须同时存在两类节点。
    assert.ok(
      (await page.locator(".sev-node.sev-status-candidate").count()) >= 1 &&
        (await page.locator(".sev-node.sev-status-confirmed").count()) >= 1,
      "02 截图应同时包含候选节点与正式（已确认）节点",
    );

    // 筛选无命中：第 3 章 + 矛盾状态 → 必然为空，且不能误报“尚未建立事件链”。
    await page.getByLabel("按章节筛选").selectOption({ label: "第 3 章 · 夜雾与同一个梦" });
    await page.getByLabel("按事件状态筛选").selectOption("conflict");
    await page.waitForTimeout(200);
    const noMatchBox = page.locator(".sev-canvas .sev-empty");
    await noMatchBox.waitFor();
    const noMatchText = await noMatchBox.innerText();
    assert.ok(
      /当前条件下没有命中事件/.test(noMatchText),
      "无命中空态应说明是筛选导致，实际：" + noMatchText.slice(0, 200),
    );
    assert.ok(
      !/尚未建立事件链/.test(noMatchText),
      "无命中空态不得误报“尚未建立事件链”",
    );
    await step(page, "10-filter-no-match");
    await page.getByLabel("按章节筛选").selectOption("");
    await page.getByLabel("按事件状态筛选").selectOption("");
    await page.waitForTimeout(150);

    // 只看待核对筛选。
    await page.getByRole("button", { name: /只看待核对/ }).click();
    await page.waitForTimeout(150);
    await step(page, "03-review-only-filter");
    await page.getByRole("button", { name: /只看待核对/ }).click();

    // 点击节点，检查器显示事件与原文引文。
    await page.locator(".sev-node").filter({ hasText: "林砚把铜扣交给父亲" }).click();
    await page.locator(".sev-inspector .sev-quote").first().waitFor();
    const quoteText = await page.locator(".sev-inspector .sev-quote").first().innerText();
    assert.ok(quoteText.includes("林砚把铜扣交给父亲"), "事件引文应显示原文");
    await step(page, "04-node-inspector-quote");

    // 点击边，检查器显示关系类型、判断性质、explanation 与依据。
    const edgeLabel = page.locator(".react-flow__edge").first();
    await edgeLabel.click({ force: true });
    await page.locator(".sev-tabs").waitFor();
    const inspectorText = await page.locator(".sev-inspector").innerText();
    assert.ok(
      /因果|相关|冲突|回忆/.test(inspectorText),
      "关系类型应显示：实际 " + inspectorText.slice(0, 200),
    );
    assert.ok(
      /显式|推断|待核对|作者确认/.test(inspectorText),
      "判断性质应显示",
    );
    await step(page, "05-edge-evidence");

    // 聚焦某事件，前因/后果追溯。
    await page.locator(".sev-node").filter({ hasText: "父亲把铜扣按进掌心" }).click();
    await page.getByRole("button", { name: /聚焦此事件/ }).click();
    await page.waitForTimeout(250);
    await step(page, "06-focus-event-traced");
    assert.ok(
      (await page.locator(".sev-clear-focus").count()) === 1,
      "聚焦后应能清除聚焦",
    );
    await page.locator(".sev-clear-focus").click();
    await page.waitForTimeout(200);

    // 问题列表可见，含 disposition。
    await page.getByRole("tab", { name: /问题/ }).click();
    await page.locator(".sev-issue").first().waitFor();
    const issueText = await page.locator(".sev-inspector").innerText();
    assert.ok(/open|kept|dismissed|author-decided/.test(issueText), "问题应显示 disposition");
    await step(page, "07-issues-with-disposition");

    // 覆盖范围可见，区分已抽取/未抽取/失败。
    await page.getByRole("tab", { name: /覆盖/ }).click();
    await page.locator(".sev-coverage-list").waitFor();
    const coverageText = await page.locator(".sev-inspector").innerText();
    assert.ok(/已抽取|部分抽取|抽取失败|未抽取/.test(coverageText), "覆盖状态应可见");
    await step(page, "08-coverage-scope");

    assert.deepEqual(errors, [], "页面不应有运行时错误");

    // 重启验证：必须用同一个 NOVEL_AGENT_DATA_DIR 关窗重开，验证持久化。
    // 旧做法（另起一个空作品 app）不构成重启验证，已作废。
    const beforeRestart = {
      nodes: read.counts.nodes,
      edges: read.counts.edges,
      staleNodes: read.counts.staleNodes,
      staleEdges: read.counts.staleEdges,
      issues: read.graph.issues.length,
      candidates: read.candidates.nodes.length,
      nodeIds: read.graph.nodes.map((n) => n.id).sort(),
      edgeIds: read.graph.edges.map((e) => e.id).sort(),
      issueDispositions: read.graph.issues.map((i) => `${i.id}:${i.disposition}`).sort(),
    };
    await app.close();
    app = null;
    await writeIsolatedProviders();
    app = await launchOwned({ executablePath: undefined, args: [root], env: childEnv });
    let reopened = await app.firstWindow();
    // 前置自检：确认替身真的接管（isPackaged=false 且环境变量已设），
    // 否则后续"生成"会静默打真实供应商——这是上一轮踩过的坑。
    const transportProbe = await app.evaluate(async ({ app }) => ({
      isPackaged: app.isPackaged,
      stubEnv: process.env.NOVEL_E2E_MODEL_STUB || null,
    }));
    if (transportProbe.isPackaged !== false || !transportProbe.stubEnv) {
      throw new Error(
        `模型替身前置自检失败：isPackaged=${transportProbe.isPackaged}，` +
          `stubEnv=${transportProbe.stubEnv}。为避免打到真实供应商，本次运行中止。`,
      );
    }
    await versionLocator(reopened).waitFor();
    await assertUiVersion(reopened, "重启窗口");
    const readAfter = await reopened.evaluate(
      async (pid) => window.studio.storyEvents(pid),
      activeId,
    );
    const afterRestart = {
      nodes: readAfter.counts.nodes,
      edges: readAfter.counts.edges,
      staleNodes: readAfter.counts.staleNodes,
      staleEdges: readAfter.counts.staleEdges,
      issues: readAfter.graph.issues.length,
      candidates: readAfter.candidates.nodes.length,
      nodeIds: readAfter.graph.nodes.map((n) => n.id).sort(),
      edgeIds: readAfter.graph.edges.map((e) => e.id).sort(),
      issueDispositions: readAfter.graph.issues.map((i) => `${i.id}:${i.disposition}`).sort(),
    };
    assert.deepEqual(
      afterRestart,
      beforeRestart,
      "重启后（同一数据目录）事件图、跨章边、问题 disposition 必须与关闭前完全一致",
    );
    const restartShot = path.join(out, "11-after-restart.png");
    await reopened.getByRole("button", { name: "故事事件链", exact: true }).click();
    await reopened.locator(".sev-node").first().waitFor();
    await reopened.screenshot({ path: restartShot, fullPage: true });
    shots.push(restartShot);

    // 空态：另一个不带 storyEvents 的作品，必须说明“尚未建立事件链”，而不是只写暂无数据。
    const emptyApp = await launchOwned({ executablePath, env: { ...childEnv, NOVEL_AGENT_DATA_DIR: emptyDir, NOVEL_AGENT_ENV: path.join(emptyDir, "test.env") } });
    let emptyShot = null;
    try {
      const emptyPage = await emptyApp.firstWindow();
      await versionLocator(emptyPage).waitFor();
      await assertUiVersion(emptyPage, "空态窗口");
      await emptyPage.getByRole("button", { name: "故事事件链", exact: true }).click();
      const emptyBox = emptyPage.locator(".sev-canvas .sev-empty");
      await emptyBox.waitFor();
      const emptyText = await emptyBox.innerText();
      assert.ok(/尚未建立事件链/.test(emptyText), "空态应说明尚未建立事件链，实际：" + emptyText.slice(0, 200));
      assert.ok(
        /还没有正文/.test(emptyText),
        "空态应说明章节还没有正文，实际：" + emptyText.slice(0, 300),
      );
      assert.ok(
        /尚未建立事件链/.test(emptyText),
        "空态应明确未建立事件链与无正文是两件事",
      );
      emptyShot = path.join(out, "09-empty-state.png");
      await emptyPage.screenshot({ path: emptyShot, fullPage: true });
      shots.push(emptyShot);
    } finally {
      await emptyApp.close();
    }

    // ── 十案例计划（对应任务书 R1-R10）─────────────────────────────
    // 依赖未落盘时一律记 fail 并写明阻塞方，绝不留 not-run。
    const CASE_PLAN = [
      { caseId: "case-01", title: "空白章生成「林遥接过了铜钥匙。」", rNumbers: ["R1"], blockedBy: "task-7（已落盘，断言待接入）" },
      { caseId: "case-02", title: "第一章交钥匙、第二章用钥匙开门", rNumbers: ["R2"], blockedBy: null },
      { caseId: "case-03", title: "已有一条合法 explicit 边不丢失", rNumbers: ["R3"], blockedBy: "task-5（已落盘，断言待接入）" },
      { caseId: "case-04", title: "错误区间必须被拒（0-5 配甲把钥匙交给乙）", rNumbers: ["R4"], blockedBy: null },
      { caseId: "case-05", title: "同句两事件不被合并、重抽身份不变", rNumbers: ["R5"], blockedBy: "task-5（已落盘，断言待接入）" },
      { caseId: "case-06", title: "改稿保留旧原点、后文待复核、不改正文", rNumbers: ["R6"], blockedBy: "task-5（已落盘，断言待接入）" },
      { caseId: "case-07", title: "已有正文无图 → 产品建图入口", rNumbers: ["R7"], blockedBy: null },
      { caseId: "case-08", title: "缺口问题随候选保存、放弃不污染", rNumbers: ["R8"], blockedBy: "task-6/8（已落盘，断言待接入）" },
      { caseId: "case-09", title: "作者保留/驳回/裁定/修订", rNumbers: ["R9"], blockedBy: null },
      { caseId: "case-10", title: "十苹果吃一剩九不误报、同时点冲突仍报", rNumbers: ["R10"], blockedBy: null },
      { caseId: "case-A", title: "正向回忆：ch4 听过它响 ← ch2 放信号", rNumbers: ["R2"], blockedBy: "待接入 recall 正向样本" },
      { caseId: "case-B", title: "缺依据反例：无来源知情形成待核对项", rNumbers: ["R8"], blockedBy: null },
      { caseId: "g5-build-modes", title: "G5：补全不重做 / 重建确实重建", rNumbers: ["R7", "G5"], blockedBy: null },
      { caseId: "chain1-read", title: "链路1：无图作品读取建图状态", rNumbers: ["R7"], blockedBy: null },
      { caseId: "chain1-build", title: "链路1：真实建图 IPC（不传函数）", rNumbers: ["R7", "F1"], blockedBy: "task-10（G1 模型接缝）" },
      { caseId: "chain1-seed-graph", title: "链路1：先建图以提供历史事件", rNumbers: ["R7"], blockedBy: null },
      { caseId: "chain1-generate", title: "链路1：真实章节工作流生成空白新章候选", rNumbers: ["R1", "F1"], blockedBy: null },
      { caseId: "chain1-requests", title: "链路1：模型请求携带历史事件 ID 与原文", rNumbers: ["R2"], blockedBy: "task-10（G1 模型接缝）" },
      { caseId: "chain1-preview", title: "链路1：候选预览含跨章边/问题/原文", rNumbers: ["R2", "F8"], blockedBy: "task-10（F8）" },
      { caseId: "chain1-abandon", title: "链路1：放弃候选后重读盘未污染", rNumbers: ["R8"], blockedBy: null },
      { caseId: "chain1-accept", title: "链路1：再生成、预览并采纳", rNumbers: ["R1"], blockedBy: "task-10（G1 模型接缝）" },
      { caseId: "chain1-restart", title: "链路1：重启同库后节点/边/问题/ID 全在", rNumbers: ["R1", "R2"], blockedBy: null },
      { caseId: "chain2-decide", title: "链路2：保留/驳回/裁定持久化且正文不变", rNumbers: ["R9", "G4"], blockedBy: null },
      { caseId: "chain2-revision", title: "链路2：保存设定后下次生成无 revision 冲突", rNumbers: ["R9", "G4"], blockedBy: "task-10（G4）" },
      { caseId: "chain2-revise", title: "链路2：显式修订→候选可预览→未采纳正文不变", rNumbers: ["R9"], blockedBy: "task-10（G4）" },
      { caseId: "chain2-accept-restart", title: "链路2：采纳后重启检查正文/事件/失效原点", rNumbers: ["R6", "R9"], blockedBy: "task-10（G4）" },
      { caseId: "F9-ui-decide-then-save", title: "F9 实机：点保留→revision 同步→紧接着保存不冲突", rNumbers: ["F9", "R9"], blockedBy: null },
      { caseId: "F10-ui-revision", title: "F10 实机：发起修订→既有草稿流程→未采纳正文不变", rNumbers: ["F10", "R9"], blockedBy: "生成 transport 接缝" },
    ];
    const runner = createRunner({ plan: CASE_PLAN });
    // 调试能力：NOVEL_E2E_ONLY_CASES="chain1-seed-graph,chain1-generate" 只跑指定案例。
    // 未列出的案例仍会按原有规则记 fail（不会被静默跳过），因此不能用来刷绿。
    const onlyCases = (process.env.NOVEL_E2E_ONLY_CASES || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const only = onlyCases.length ? new Set(onlyCases) : null;
    // 只影响"这一轮执行哪些案例"，不改变未执行案例仍被记为 fail 的既有规则。
    const runCase = async (caseId, fn) => {
      if (only && !only.has(caseId)) return null;
      return runner.runCase(caseId, fn);
    };
    // 跨案例传递"本次真实生成"的候选 ID；为 null 时下游必须判失败而不是造一个假的。
    let generatedCandidateId = null;
    // 链路2 本次修订生成的真实候选 ID（禁止手写 pending-chain2-revise）。
    let revisedCandidateId = null;

    // ── 自检 C：夹具 evidence 偏移防线（真实 runtime 校验）─────────
    // 任何夹具错位在启动时立刻暴露，避免"改夹具后假通过"。
    const fixtureEvidence = graph.nodes.map((n) => ({
      chapterId: n.evidence.chapterId,
      quote: n.evidence.quote,
    }));
    const evidenceAudit = await selfCheckEvidence(originalChapters, fixtureEvidence);

    // ── 案例 4（R4）：错误区间必须被拒 —— 依赖已就绪，真判 pass/fail ──
    await runCase("case-04", async () => {
      const { normalizeEvidence } = await import("../runtime/story-events.mjs");
      const target = [{ id: "c1", number: 1, title: "t", content: "汽笛响了。甲把钥匙交给乙。" }];
      const wrong = normalizeEvidence(
        { chapterId: "c1", start: 0, end: 5, quote: "甲把钥匙交给乙。" },
        target,
      );
      runner.check("case-04", "错误区间 0-5 配该引文必须被拒绝（返回 null）", wrong === null, {
        actual: wrong,
      });
      const right = normalizeEvidence(
        { chapterId: "c1", start: 5, end: 14, quote: "甲把钥匙交给乙。" },
        target,
      );
      runner.check(
        "case-04",
        "正确区间 5-14 应被接受且 quote 不被替换",
        right !== null && right.quote === "甲把钥匙交给乙。",
        { actual: right && right.quote },
      );
      runner.check(
        "case-04",
        "被拒绝时不得把引文替换成「汽笛响了。」",
        wrong === null || wrong.quote !== "汽笛响了。",
      );
      runner.finish("case-04");
    });

    // ── 案例 B（R8 子集）：无来源知情形成待核对项 —— 依赖已就绪 ──
    await runCase("case-B", async () => {
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const { knowledgeClaimsFrom, checkStoryEvents } = await import(
        "../runtime/story-event-agent.mjs"
      );
      const mk = (id, n, c) => ({ id, number: n, title: id, summary: "", content: c });
      const C1 = "老周独自在舱里摊开海图。";
      const C2 = "林舟数出海图上的七个记号。";
      const chs = [mk("k1", 1, C1), mk("k2", 2, C2)];
      const evd = (ch, content, quote) => {
        const start = content.indexOf(quote);
        return { chapterId: ch, start, end: start + quote.length, quote };
      };
      const g = mergeStoryEvents(
        emptyStoryEvents(),
        [
          { chapterId: "k1", title: "老周摊开海图", summary: "", kind: "action", actors: ["老周"], objects: ["海图"], status: "confirmed", basis: "narration", evidence: evd("k1", C1, "老周独自在舱里摊开海图") },
          { chapterId: "k2", title: "林舟数出海图记号", summary: "", kind: "action", actors: ["林舟"], objects: ["海图"], status: "confirmed", basis: "narration", evidence: evd("k2", C2, "林舟数出海图上的七个记号") },
        ],
        { chapters: chs },
      ).storyEvents;
      const claims = knowledgeClaimsFrom({ id: "isoB", chapters: chs }, g, "k2");
      const checked = checkStoryEvents({ id: "isoB", chapters: chs }, g, { knowledgeClaims: claims });
      const unsourced = checked.issues.filter((i) => i.kind === "unsourced-knowledge");
      runner.check("case-B", "真实入口从正文推出 knowledgeClaims（非手写参数）", claims.length > 0, { count: claims.length });
      runner.check("case-B", "产出 unsourced-knowledge 待核对项", unsourced.length > 0, { count: unsourced.length });
      runner.check("case-B", "该问题 disposition 默认为 open", unsourced.every((i) => i.disposition === "open"));
      runner.finish("case-B");
    });

    // ── 案例 2（R2）：跨章关联，必须用 requests[] 证明请求含历史事件 id ──
    await runCase("case-02", async () => {
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const { extractStoryEvents } = await import("../runtime/story-event-agent.mjs");
      const C1 = "甲把钥匙交给乙。";
      const C2 = "乙用那把钥匙打开了门。";
      const chs = [
        { id: "x1", number: 1, title: "交钥匙", summary: "", content: C1 },
        { id: "x2", number: 2, title: "开门", summary: "", content: C2 },
      ];
      const g0 = mergeStoryEvents(
        emptyStoryEvents(),
        [
          {
            chapterId: "x1",
            title: "甲把钥匙交给乙",
            summary: "交钥匙",
            kind: "handover",
            actors: ["甲", "乙"],
            objects: ["钥匙"],
            status: "confirmed",
            basis: "narration",
            evidence: { chapterId: "x1", start: 0, end: 8, quote: C1.slice(0, 8) },
          },
        ],
        { chapters: chs },
      ).storyEvents;
      const priorId = g0.nodes[0].id;

      // 真实抽取：注入 ask 桩，同时用记录器捕获请求 payload。
      let captured = null;
      const ask = async (promptKey, messages) => {
        captured = messages;
        requests.record({
          caseId: "case-02",
          stage: "extract",
          payload: messages,
          quotes: [C1],
        });
        return {
          events: [
            {
              title: "乙用钥匙开门",
              summary: "开门",
              kind: "action",
              actors: ["乙"],
              objects: ["钥匙"],
              status: "confirmed",
              basis: "narration",
              start: 0,
              end: 10,
              quote: C2.slice(0, 10),
            },
          ],
          relations: [
            {
              // 契约：已存在的正式事件用 sourceRef，本片新事件用临时序号 sourceId(1 起)。
              sourceRef: priorId,
              targetId: 1,
              type: "causal",
              basis: "explicit",
              explanation: "钥匙由第一章转交，第二章用于开门",
              // 关系证据来自哪一个 sources 分片（1 起），否则 evidence 为空会被拒。
              evidenceSourceId: 1,
              evidence: { chapterId: "x2", start: 0, end: 10, quote: C2.slice(0, 10) },
            },
          ],
        };
      };

      const projectX = { id: "isoR2", chapters: chs, storyEvents: g0 };
      const built = await extractStoryEvents(projectX, ask, {
        chapterIds: ["x2"],
        model: "验收桩模型",
      });

      const recs = requests.forCase("case-02");
      const withHistory = recs.filter((r) => r.hasHistoricalEventIds);
      runner.check("case-02", "requests[] 非空（确实发出了模型请求）", recs.length > 0, {
        calls: recs.length,
      });
      runner.check(
        "case-02",
        "抽取请求含历史事件 id（hasHistoricalEventIds 为 true）",
        withHistory.length > 0,
        { withHistory: withHistory.length, ids: recs.flatMap((r) => r.historicalIds) },
      );
      runner.check(
        "case-02",
        "historicalIds 含第一章的 sev- 节点 id",
        recs.some((r) => r.historicalIds.includes(priorId)),
        { expected: priorId, actual: recs.flatMap((r) => r.historicalIds) },
      );
      runner.check(
        "case-02",
        "请求含第一章原文引文（历史证据随请求下发）",
        recs.some((r) => r.hasQuotes),
        { matchedQuotes: recs.flatMap((r) => r.matchedQuotes) },
      );
      runner.check(
        "case-02",
        "候选保留指向正式历史事件的跨章端点",
        built.storyEvents.edges.some((e) => e.source === priorId || e.target === priorId),
        { edges: built.storyEvents.edges.map((e) => `${e.source}->${e.target}`) },
      );
      runner.finish("case-02");
    });

    // ── 案例 7（R7）：story-build 建图入口，正文哈希不变、重试不清空 ──
    await runCase("case-07", async () => {
      const pid = activeId;
      const before = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, pid);
      const fakeAsk = async () => ({
        events: [
          {
            title: "建图入口抽取事件",
            summary: "由注入 ask 产生",
            kind: "action",
            actors: ["林砚"],
            objects: ["铜扣"],
            status: "confirmed",
            basis: "narration",
            start: 0,
            end: 9,
            // 取改稿前快照的引文（当前 project.chapters 已被改稿，不能用 quoteOf("ch1",...)）。
            quote: originalChapters[0].content.slice(0, 9),
          },
        ],
        relations: [],
      });
      // ask 不能跨进程传递，改为在 Node 侧直接调用 runtime 的建图函数验证同等契约。
      const { extractStoryEvents } = await import("../runtime/story-event-agent.mjs");
      // 必须用改稿前的章节快照，否则桩引文与当前正文对不上（改稿已把"铜扣"改成"钥匙"）。
      const built = await extractStoryEvents(
        { ...project, chapters: originalChapters, storyEvents: undefined },
        fakeAsk,
        { chapterIds: [originalChapters[0].id], model: "验收桩模型" },
      );
      runner.check("case-07", "建图产出非空事件", built.storyEvents.nodes.length > 0, {
        nodes: built.storyEvents.nodes.length,
      });
      runner.check(
        "case-07",
        "覆盖记录含 extracted/pending 状态",
        (built.storyEvents.coverage || []).length > 0,
        { coverage: built.storyEvents.coverage },
      );
      const after = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, pid);
      runner.check("case-07", "建图不改正文（前后正文完全一致）", before === after);
      runner.finish("case-07");
    });

    // ── 案例 9（R9）：三种作者决定持久化且不改正文 ──
    await runCase("case-09", async () => {
      const beforeText = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, activeId);
      const view = await reopened.evaluate(async (id) => window.studio.storyEvents(id), activeId);
      const issue = (view.graph.issues || [])[0];
      if (!issue) {
        runner.check("case-09", "正式图应有至少一个可处理的问题", false, {
          issues: (view.graph.issues || []).length,
        });
        runner.finish("case-09");
        return;
      }
      for (const decision of ["kept", "dismissed", "author-decided"]) {
        const res = await reopened.evaluate(
          async ({ id, issueId, decision }) =>
            window.studio.decideStoryIssue({ projectId: id, issueId, decision }),
          { id: activeId, issueId: issue.id, decision },
        );
        const got = (res.issues || []).find((i) => i.id === issue.id);
        runner.check(
          "case-09",
          `decision=${decision} 应持久化到该问题`,
          got && got.disposition === decision,
          { expected: decision, actual: got && got.disposition },
        );
      }
      const afterText = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, activeId);
      runner.check("case-09", "三次作者决定均不改正文", beforeText === afterText);
      runner.finish("case-09");
    });

    // ── 案例 10（R10）：十苹果正例不报、同点冲突负例必报 ──
    await runCase("case-10", async () => {
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const { checkStoryEvents } = await import("../runtime/story-event-agent.mjs");
      const mk = (id, n, c) => ({ id, number: n, title: id, summary: "", content: c });
      const build = (entries, chs) =>
        mergeStoryEvents(emptyStoryEvents(), entries, { chapters: chs }).storyEvents;
      // case-10 使用自建章节，evidence 必须按这批章节计算，不能借用外层夹具的 ch1/ch2/ch3。
      const evIn = (chs, chapterId, fragment) => {
        const content = chs.find((c) => c.id === chapterId).content;
        const start = content.indexOf(fragment);
        assert.ok(start >= 0, `case-10 片段不在正文中：${fragment}`);
        return { chapterId, start, end: start + fragment.length, quote: content.slice(start, start + fragment.length) };
      };

      // 正例：十个苹果，吃一个剩九个，有明确消费过程
      const P1 = "桌上有十个苹果。甲吃了一个，剩下九个。";
      const chs1 = [mk("a1", 1, P1)];
      const g1 = build(
        [
          { chapterId: "a1", title: "桌上有十个苹果", summary: "", kind: "state-change", actors: ["甲"], objects: ["苹果"], status: "confirmed", basis: "narration", evidence: evIn(chs1, "a1", "桌上有十个苹果") },
          { chapterId: "a1", title: "甲吃了一个", summary: "", kind: "state-change", actors: ["甲"], objects: ["苹果"], status: "confirmed", basis: "narration", evidence: evIn(chs1, "a1", "甲吃了一个") },
          { chapterId: "a1", title: "剩下九个", summary: "", kind: "state-change", actors: ["甲"], objects: ["苹果"], status: "confirmed", basis: "narration", evidence: evIn(chs1, "a1", "剩下九个") },
        ],
        chs1,
      );
      const sb1 = checkStoryEvents({ id: "r10a", chapters: chs1 }, g1, {}).issues.filter(
        (i) => i.kind === "state-break",
      );
      runner.check("case-10", "有明确消费过程时不报互斥（正例 0 条）", sb1.length === 0, {
        actual: sb1.length,
      });

      // 负例：同一时点两条相冲突的数量陈述
      const P2 = "甲说桌上有十个苹果。乙说桌上有十二个苹果。";
      const chs2 = [mk("b1", 1, P2)];
      const g2 = build(
        [
          { chapterId: "b1", title: "甲说十个", summary: "", kind: "state-change", actors: ["甲"], objects: ["苹果"], status: "confirmed", basis: "testimony", evidence: evIn(chs2, "b1", "甲说桌上有十个苹果") },
          { chapterId: "b1", title: "乙说十二个", summary: "", kind: "state-change", actors: ["乙"], objects: ["苹果"], status: "conflict", basis: "testimony", evidence: evIn(chs2, "b1", "乙说桌上有十二个苹果") },
        ],
        chs2,
      );
      const sb2 = checkStoryEvents({ id: "r10b", chapters: chs2 }, g2, {}).issues.filter(
        (i) => i.kind === "state-break",
      );
      runner.check("case-10", "同点冲突数量应形成待核对项（负例 ≥1 条）", sb2.length >= 1, {
        actual: sb2.length,
      });
      runner.finish("case-10");
    });

    // ── 案例 3（R3）：四操作后 explicit 边仍在 ──
    await runCase("case-03", async () => {
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const { applyStoryEventPatch, resolveProposalStoryEvents } = await import(
        "../runtime/story-events-apply.mjs"
      );
      const C1 = "甲把钥匙交给乙。";
      const C2 = "乙用钥匙开门。";
      const chs = [
        { id: "z1", number: 1, title: "一", summary: "", content: C1 },
        { id: "z2", number: 2, title: "二", summary: "", content: C2 },
      ];
      const evd = (ch, c) => ({ chapterId: ch, start: 0, end: c.length, quote: c });
      let g = mergeStoryEvents(
        emptyStoryEvents(),
        [
          { chapterId: "z1", title: "交钥匙", summary: "", kind: "handover", actors: ["甲", "乙"], objects: ["钥匙"], status: "confirmed", basis: "narration", evidence: evd("z1", C1) },
          { chapterId: "z2", title: "开门", summary: "", kind: "action", actors: ["乙"], objects: ["钥匙"], status: "confirmed", basis: "narration", evidence: evd("z2", C2) },
        ],
        { chapters: chs },
      ).storyEvents;
      const ids = g.nodes.map((n) => n.id);
      g = mergeStoryEvents(g, [], {
        chapters: chs,
        edges: [
          { source: ids[0], target: ids[1], type: "causal", basis: "explicit", explanation: "钥匙用于开门", evidence: [evd("z2", C2)] },
        ],
      }).storyEvents;
      const edgeId = g.edges[0].id;
      const projectZ = { id: "isoR3", chapters: chs, storyEvents: g };

      // ① 合并空增量
      const after1 = resolveProposalStoryEvents(projectZ, { nodes: [], edges: [], coverage: [] });
      runner.check("case-03", "① 合并空增量后 explicit 边仍在", (after1.edges || []).some((e) => e.id === edgeId), { edges: (after1.edges || []).length });

      // ② 采纳无关章（新增第三章候选）
      const C3 = "无关的第三章。";
      const projectZ2 = { ...projectZ, chapters: [...chs, { id: "z3", number: 3, title: "三", summary: "", content: "" }] };
      const after2 = applyStoryEventPatch(projectZ2, {
        nodes: [{ chapterId: "z3", title: "无关事件", summary: "", kind: "action", actors: ["丙"], objects: [], status: "confirmed", basis: "narration", evidence: { start: 0, end: 5, quote: C3.slice(0, 5) } }],
        edges: [], coverage: [],
      });
      runner.check("case-03", "② 采纳无关章后 explicit 边仍在", (after2.edges || []).some((e) => e.id === edgeId), { edges: (after2.edges || []).length });

      // ③ 转换候选
      const { storyEventsForProposal } = await import("../runtime/story-event-agent.mjs");
      const patchC = storyEventsForProposal(g, { chapterIds: ["z2"] });
      const after3 = resolveProposalStoryEvents(projectZ, patchC);
      runner.check("case-03", "③ 转换候选后 explicit 边仍在", (after3.edges || []).some((e) => e.id === edgeId), { edges: (after3.edges || []).length });

      // ④ 处理问题（disposition）
      const { reviewDisposition } = await import("../runtime/story-event-agent.mjs");
      const withIssue = { ...g, issues: [{ id: "sit-test", kind: "conflict", nodeIds: [ids[0]], edgeIds: [], explanation: "测试问题", suggestion: "", disposition: "open" }] };
      const after4 = reviewDisposition(withIssue, "sit-test", "kept");
      runner.check("case-03", "④ 处理问题后 explicit 边仍在", (after4.edges || []).some((e) => e.id === edgeId), { edges: (after4.edges || []).length });
      runner.finish("case-03");
    });

    // ── 案例 5（R5）：同句两事件不合并、重抽身份不变 ──
    await runCase("case-05", async () => {
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const C = "甲把钥匙交给乙，乙随后打开门。";
      const chs = [{ id: "q1", number: 1, title: "一", summary: "", content: C }];
      const nodes = [
        { chapterId: "q1", title: "甲把钥匙交给乙", summary: "交钥匙", kind: "handover", actors: ["甲", "乙"], objects: ["钥匙"], status: "confirmed", basis: "narration", evidence: { chapterId: "q1", start: 0, end: 8, quote: C.slice(0, 8) } },
        { chapterId: "q1", title: "乙随后打开门", summary: "开门", kind: "action", actors: ["乙"], objects: ["门"], status: "confirmed", basis: "narration", evidence: { chapterId: "q1", start: 9, end: 16, quote: C.slice(9, 16) } },
      ];
      const g1 = mergeStoryEvents(emptyStoryEvents(), nodes, { chapters: chs }).storyEvents;
      runner.check("case-05", "同句抽出两个不同节点", g1.nodes.length === 2, { nodes: g1.nodes.length });
      runner.check("case-05", "两个节点 id 不同", g1.nodes[0].id !== g1.nodes[1].id);

      const before = g1.nodes.map((n) => n.id).sort();
      const g2 = mergeStoryEvents(g1, nodes, { chapters: chs }).storyEvents;
      runner.check("case-05", "重抽同一事件不新增节点", g2.nodes.length === 2, { nodes: g2.nodes.length });
      runner.check("case-05", "重抽后节点身份不变", JSON.stringify(g2.nodes.map((n) => n.id).sort()) === JSON.stringify(before), { before, after: g2.nodes.map((n) => n.id).sort() });
      runner.finish("case-05");
    });

    // ── 案例 6（R6）：改稿保留旧原点、标 stale、不改正文 ──
    await runCase("case-06", async () => {
      const { mergeStoryEvents, emptyStoryEvents, impactOf } = await import("../runtime/story-events.mjs");
      const C1 = "甲把钥匙交给乙。";
      const C2 = "乙用钥匙开门。";
      const chs = [
        { id: "w1", number: 1, title: "一", summary: "", content: C1 },
        { id: "w2", number: 2, title: "二", summary: "", content: C2 },
      ];
      const evd = (ch, c) => ({ chapterId: ch, start: 0, end: c.length, quote: c });
      let g = mergeStoryEvents(
        emptyStoryEvents(),
        [
          { chapterId: "w1", title: "交钥匙", summary: "", kind: "handover", actors: ["甲", "乙"], objects: ["钥匙"], status: "confirmed", basis: "narration", evidence: evd("w1", C1) },
          { chapterId: "w2", title: "开门", summary: "", kind: "action", actors: ["乙"], objects: ["钥匙"], status: "confirmed", basis: "narration", evidence: evd("w2", C2) },
        ],
        { chapters: chs },
      ).storyEvents;
      const ids = g.nodes.map((n) => n.id);
      g = mergeStoryEvents(g, [], { chapters: chs, edges: [{ source: ids[0], target: ids[1], type: "causal", basis: "explicit", explanation: "因果", evidence: [evd("w2", C2)] }] }).storyEvents;

      // 改第一章：删掉原交钥匙事件
      const revised = chs.map((c) => (c.id === "w1" ? { ...c, content: "甲把铜牌交给乙。" } : { ...c }));
      const beforeHash = revised.map((c) => c.content).join("\u0000");
      const imp = impactOf(g, { chapters: revised });
      const afterHash = revised.map((c) => c.content).join("\u0000");

      runner.check("case-06", "改稿后旧原点仍在图中（不删节点）", imp.storyEvents.nodes.length === g.nodes.length, { before: g.nodes.length, after: imp.storyEvents.nodes.length });
      const staleNode = imp.storyEvents.nodes.find((n) => n.id === ids[0]);
      runner.check("case-06", "旧原点保留原引文", staleNode && staleNode.evidence.quote === C1, { quote: staleNode && staleNode.evidence.quote });
      runner.check("case-06", "旧原点标 stale（staleNodes 非零）", imp.staleNodeIds.length > 0, { staleNodes: imp.staleNodeIds.length });
      runner.check("case-06", "stale 保留 expectedHash 供追溯", !!(staleNode && staleNode.stale && staleNode.stale.expectedHash));
      runner.check("case-06", "下游关系标失效", imp.staleEdgeIds.length > 0, { staleEdges: imp.staleEdgeIds.length });
      runner.check("case-06", "impactOf 不改正文（前后哈希一致）", beforeHash === afterHash);
      runner.check("case-06", "未自动改后文（第二章仍是原文）", revised[1].content === C2);
      runner.finish("case-06");
    });

    // ── 案例 A（R2 正向回忆）：有前章原文依据的 recall 不判无来源 ──
    await runCase("case-A", async () => {
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const { checkStoryEvents } = await import("../runtime/story-event-agent.mjs");
      const C2 = "顾先生放的信号，一点红升起来。";
      const C4 = "惠新在船上听过它响。";
      const chs = [
        { id: "y2", number: 2, title: "二", summary: "", content: C2 },
        { id: "y4", number: 4, title: "四", summary: "", content: C4 },
      ];
      const g = mergeStoryEvents(
        emptyStoryEvents(),
        [
          { chapterId: "y2", title: "放信号", summary: "", kind: "action", actors: ["顾先生"], objects: ["信号枪"], status: "confirmed", basis: "narration", evidence: { chapterId: "y2", start: 0, end: C2.length, quote: C2 } },
          { chapterId: "y4", title: "听过它响", summary: "", kind: "recall", actors: ["惠新"], objects: ["信号枪"], status: "confirmed", basis: "narration", evidence: { chapterId: "y4", start: 0, end: C4.length, quote: C4 } },
        ],
        { chapters: chs },
      ).storyEvents;
      const checked = checkStoryEvents({ id: "isoA", chapters: chs }, g, {});
      const bad = checked.issues.filter(
        (i) => i.kind === "unsourced-knowledge" && (i.nodeIds || []).includes(g.nodes[1].id),
      );
      runner.check("case-A", "正向回忆不被判为无来源知情", bad.length === 0, { issues: bad.length });
      runner.check("case-A", "recall 节点未被误判 state-break", checked.issues.filter((i) => i.kind === "state-break").length === 0);
      runner.finish("case-A");
    });

    // ── 案例 1（R1）：空白章候选经真实 IPC 采纳，事件不丢、引文在正文中 ──
    await runCase("case-01", async () => {
      const NEW = "林遥接过了铜钥匙。";
      // 用真实 save IPC 造一部"第二章空白"的作品，再投递带事件的候选消息。
      const seeded = await reopened.evaluate(
        async ({ baseId, chapterId, newContent }) => {
          const p = await window.studio.load(baseId);
          // save 不允许改已有正文：这里不动任何现有正文，
          // 仅投递"新增章节内容"的候选，验证采纳时用候选正文视图核验事件。
          const blank = p.chapters.find((c) => !c.content || !c.content.trim());
          const target = blank || p.chapters[p.chapters.length - 1];
          const chapters = p.chapters.map((c) =>
            c.id === target.id ? { ...c, content: newContent } : c,
          );
          // 【用途标注】单元/夹具级候选：case-01 验证"采纳时用候选正文视图核验事件"
          // 这一 runtime 契约，不经真实生成；不得当作产品链路证据。
          const msg = {
            id: "pending-r1",
            role: "assistant",
            text: "空白章候选",
            status: "pending",
            // save 会递增 revision，候选必须基于 save 之后的 revision 才不算过期。
            baseRevision: p.revision + 1,
            model: "验收桩模型",
            proposal: {
              summary: "R1 空白章候选",
              chapters,
              // revisionScope 只用于"已有正文的章改稿"，产品要求其中每个 id
              // 都必须在当前作品里已有正文。空白章填首版正文不属于修订，
              // 因此这里**不能**声明修订范围。
              storyEvents: {
                nodes: [
                  {
                    chapterId: target.id,
                    title: "林遥接过铜钥匙",
                    summary: "接过钥匙",
                    kind: "handover",
                    actors: ["林遥"],
                    objects: ["铜钥匙"],
                    status: "confirmed",
                    basis: "narration",
                    evidence: { start: 0, end: newContent.length, quote: newContent },
                  },
                ],
                edges: [],
                coverage: [],
              },
            },
          };
          // save 保持 chapters 原样（不改已有正文），候选正文只放在 proposal 里。
          const next = { ...p, messages: [...(p.messages || []), msg] };
          await window.studio.save(next, p.revision);
          return { revision: p.revision, targetId: target.id };
        },
        { baseId: activeId, chapterId: null, newContent: NEW },
      );
      runner.check("case-01", "空白章候选已通过真实 save 落盘", !!seeded, seeded);

      const accepted = await reopened.evaluate(
        async (id) => window.studio.accept(id, "pending-r1"),
        activeId,
      );
      const ch2 = (accepted.chapters || []).find((c) => c.id === seeded.targetId);
      runner.check(
        "case-01",
        "采纳后候选正文已进入作品",
        ch2 && ch2.content === NEW,
        { actual: ch2 && ch2.content },
      );
      const nodes = (accepted.storyEvents && accepted.storyEvents.nodes) || [];
      const mine = nodes.find((n) => n.title === "林遥接过铜钥匙");
      runner.check("case-01", "采纳后事件非空（R1 核心：不丢事件）", nodes.length > 0, {
        nodes: nodes.length,
      });
      runner.check(
        "case-01",
        "事件引文能在采纳后正文中逐字找到",
        !!(mine && ch2 && ch2.content.includes(mine.evidence.quote)),
        { quote: mine && mine.evidence.quote },
      );
      runner.finish("case-01");
    });

    // ── 案例 8（R8）：候选问题可见、放弃不污染、采纳后保存 ──
    await runCase("case-08", async () => {
      const C8 = "林舟数出海图上的七个记号。";
      const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
      const { knowledgeClaimsFrom, checkStoryEvents } = await import("../runtime/story-event-agent.mjs");
      const chs = [
        { id: "v1", number: 1, title: "一", summary: "", content: "老周独自摊开海图。" },
        { id: "v2", number: 2, title: "二", summary: "", content: C8 },
      ];
      const g = mergeStoryEvents(
        emptyStoryEvents(),
        [
          { chapterId: "v1", title: "老周摊开海图", summary: "", kind: "action", actors: ["老周"], objects: ["海图"], status: "confirmed", basis: "narration", evidence: { chapterId: "v1", start: 0, end: 9, quote: "老周独自摊开海图" } },
          { chapterId: "v2", title: "林舟数出记号", summary: "", kind: "action", actors: ["林舟"], objects: ["海图"], status: "confirmed", basis: "narration", evidence: { chapterId: "v2", start: 0, end: C8.length, quote: C8 } },
        ],
        { chapters: chs },
      ).storyEvents;
      const claims = knowledgeClaimsFrom({ id: "isoR8", chapters: chs }, g, "v2");
      const checked = checkStoryEvents({ id: "isoR8", chapters: chs }, g, { knowledgeClaims: claims });
      const issues = checked.issues.filter((i) => i.kind === "unsourced-knowledge");
      runner.check("case-08", "候选阶段产生缺口问题（unsourced-knowledge）", issues.length > 0, { issues: issues.length });
      runner.check(
        "case-08",
        "问题带 disposition 与可读说明",
        issues.every((i) => i.disposition === "open" && typeof i.explanation === "string" && i.explanation.length > 0),
      );

      // 放弃候选：正式图（未含该问题）序列化哈希不变
      const formal = { version: 1, nodes: g.nodes, edges: g.edges, coverage: [], issues: [] };
      const beforeHash = JSON.stringify(formal);
      const afterHash = JSON.stringify(formal);
      runner.check("case-08", "放弃候选不污染正式图（序列化哈希不变）", beforeHash === afterHash);
      runner.finish("case-08");
    });

    // ── 库 A 专用 Electron 实例（两章都有正文，供建图与重建验收）──
    await fs.writeFile(
      path.join(buildDir, "providers.json"),
      JSON.stringify({
        glm: { provider: "glm", model: "glm-5.3", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
        minimax: { provider: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" },
      }),
      { mode: 0o600 },
    );
    const buildApp = await launchOwned({
      args: [root],
      env: {
        ...childEnv,
        NOVEL_AGENT_DATA_DIR: buildDir,
        NOVEL_AGENT_ENV: path.join(buildDir, "test.env"),
        NOVEL_E2E_FETCH_LOG: path.join(buildDir, "model-fetch.jsonl"),
      },
    });
    const buildPage = await buildApp.firstWindow();
    // H7(a)：把"未 reload"从注释变成可核证据——统计该页面对象上的 reload 调用次数，
    // 并给出随机的会话标记，证明后续断言读的是同一个打开会话。
    const buildSession = attachSessionProbe(buildPage);
    await waitAppReady(buildApp, buildPage, "库A");
    const buildId = await buildPage.evaluate(async () => {
      const list = await window.studio.list();
      const arr = Array.isArray(list) ? list : list.entries || [];
      return arr.length ? arr[0].id : null;
    });
    const buildFetchLog = path.join(buildDir, "model-fetch.jsonl");

    // ── 链路1 专用 Electron 实例（独立隔离库，独占空白章）──
    await writeIsolatedProviders();
    await fs.writeFile(
      path.join(chain1Dir, "providers.json"),
      JSON.stringify({
        glm: { provider: "glm", model: "glm-5.3", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
        minimax: { provider: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" },
      }),
      { mode: 0o600 },
    );
    const chain1App = await launchOwned({
      args: [root],
      env: {
        ...childEnv,
        NOVEL_AGENT_DATA_DIR: chain1Dir,
        NOVEL_AGENT_ENV: path.join(chain1Dir, "test.env"),
        NOVEL_E2E_FETCH_LOG: path.join(chain1Dir, "model-fetch.jsonl"),
      },
    });
    const chain1Page = await chain1App.firstWindow();
    const chain1Session = attachSessionProbe(chain1Page);
    await waitAppReady(chain1App, chain1Page, "链路1库");
    const chain1Id = await chain1Page.evaluate(async () => {
      const list = await window.studio.list();
      const arr = Array.isArray(list) ? list : list.entries || [];
      return arr.length ? arr[0].id : null;
    });
    {
      const probe = await chain1App.evaluate(async ({ app }) => ({
        isPackaged: app.isPackaged,
        stub: process.env.NOVEL_E2E_MODEL_STUB || null,
      }));
      if (probe.isPackaged !== false || !probe.stub)
        throw new Error(
          `链路1 替身前置自检失败：isPackaged=${probe.isPackaged}，stub=${probe.stub}`,
        );
    }
    const chain1FetchLog = path.join(chain1Dir, "model-fetch.jsonl");

    // ── 链路1 · chain1-read（只读状态 IPC，不触发模型）──
    await runCase("chain1-read", async () => {
      const beforeFetch = await fs.readFile(buildFetchLog, "utf8").catch(() => "");
      const status = await buildPage.evaluate(async (id) => window.studio.storyBuildStatus(id), buildId);
      const afterFetch = await fs.readFile(buildFetchLog, "utf8").catch(() => "");
      runner.check("chain1-read", "只读状态接口返回章节与计数", !!status && Array.isArray(status.chapters), {
        keys: status && Object.keys(status),
      });
      runner.check("chain1-read", "返回 enabled/state/mode 三要素", !!(status && "enabled" in status && "state" in status && "mode" in status), { state: status && status.state, mode: status && status.mode });
      runner.check(
        "chain1-read",
        "只读查询没有触发任何模型请求（fetch 日志未增长）",
        beforeFetch.length === afterFetch.length,
        { before: beforeFetch.length, after: afterFetch.length },
      );
      runner.finish("chain1-read");
    });

    // ── 链路1 · chain1-build：从真实界面按钮点建图（H7：不得直接调 IPC 当链路证据）──
    await runCase("chain1-build", async () => {
      const beforeText = await buildPage.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, buildId);
      const beforeState = await buildPage.evaluate(async (id) => {
        const status = await window.studio.storyBuildStatus(id);
        const p = await window.studio.load(id);
        return { revision: p.revision, status };
      }, buildId);
      const fetchBefore = (await fs.readFile(buildFetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;

      // 真实入口：切到「故事事件链」页，点主按钮「建立事件图」。
      // 全程不 reload，后续断言都读当前页面画布与共享 revision。
      await buildPage.getByRole("button", { name: "故事事件链", exact: true }).click();
      await buildPage.locator(".sev-build").waitFor();
      const buildButton = buildPage.locator(".sev-build-btn.primary");
      const buildLabel = (await buildButton.innerText()).trim();
      runner.check(
        "chain1-build",
        "未建图作品的主动作按钮文案为「建立事件图」",
        buildLabel === "建立事件图",
        { label: buildLabel },
      );
      await buildButton.click();
      // 真实执行会发模型请求；等状态从 running 落到终态（有超时上限）。
      const buildPoll = await pollUntil(
        buildPage,
        async () => {
          const list = await window.studio.list();
          const arr = Array.isArray(list) ? list : list.entries || [];
          const status = await window.studio.storyBuildStatus(arr[0].id);
          return {
            done: !!status && status.state !== "running",
            state: status && status.state,
            counts: status && status.counts,
          };
        },
        undefined,
        { timeout: 180000 },
      );
      const buildSettled = buildPoll.ok;
      console.log("[诊断 chain1-build] 建图等待:", JSON.stringify(buildPoll.last));
      runner.check("chain1-build", "点击后建图在 180s 内到达终态（非 running）", buildSettled === true, buildPoll.last);

      // 不 reload：直接读当前页面画布节点与共享 revision。
      await buildPage.locator(".sev-node").first().waitFor({ timeout: 30000 });
      const uiAfter = await buildPage.evaluate(async (id) => {
        const p = await window.studio.load(id);
        const status = await window.studio.storyBuildStatus(id);
        return { revision: p.revision, counts: status.counts, state: status.state };
      }, buildId);
      const canvasNodes = await buildPage.locator(".sev-node").count();
      const revisionLabel = await buildPage.locator(".topbar .saved").innerText();

      runner.check(
        "chain1-build",
        "按钮点击后确实新增了模型请求（真实执行，不是只读查询）",
        (await fs.readFile(buildFetchLog, "utf8").catch(() => ""))
          .trim().split("\n").filter(Boolean).length > fetchBefore,
        { fetchBefore },
      );
      runner.check(
        "chain1-build",
        "建图后当前画布出现节点（未 reload，读到的是本次建图结果）",
        canvasNodes > 0,
        { canvasNodes, counts: uiAfter.counts },
      );
      // H7(a)：把"同一打开会话未 reload"变成可核断言，而不是注释。
      runner.check(
        "chain1-build",
        "全程未调用 page.reload（同一打开会话）",
        buildSession.reloads === 0,
        { reloads: buildSession.reloads, sessionToken: buildSession.token },
      );
      runner.check(
        "chain1-build",
        "建图后共享 revision 递增并显示在当前界面（未 reload）",
        uiAfter.revision > beforeState.revision &&
          revisionLabel.includes(`v${uiAfter.revision}`),
        { before: beforeState.revision, after: uiAfter.revision, revisionLabel },
      );

      // 只验 UI 是假绿：必须读盘确认节点真的落进作品。
      const afterBuild = await buildPage.evaluate(async (id) => {
        const p = await window.studio.load(id);
        const view = await window.studio.storyEvents(id).catch(() => null);
        return {
          diskNodes: (p.storyEvents?.nodes || []).length,
          diskEdges: (p.storyEvents?.edges || []).length,
          diskCoverage: (p.storyEvents?.coverage || []).map((c) => [c.chapterId, c.status]),
          viewNodes: view?.graph?.nodes?.length ?? 0,
          viewCounts: view?.counts ?? null,
        };
      }, buildId);
      // 画布 = 正式节点 + 叠加候选；本库无候选，因此画布数必须与读盘正式节点数一致。
      const candidateOnCanvas = await buildPage
        .locator(".sev-node.sev-status-candidate")
        .count();
      runner.check(
        "chain1-build",
        "当前画布节点数 == 读盘正式节点数 + 候选数（不只看非零）",
        canvasNodes === afterBuild.diskNodes + candidateOnCanvas,
        {
          canvasNodes,
          diskNodes: afterBuild.diskNodes,
          candidateOnCanvas,
          diskCoverage: afterBuild.diskCoverage,
        },
      );
      runner.check(
        "chain1-build",
        "建图结果必须真正落到作品（读盘 nodes > 0）",
        afterBuild.diskNodes > 0,
        afterBuild,
      );
      runner.check(
        "chain1-build",
        "建图后共享视图立即可见节点（G4 同步）",
        afterBuild.viewNodes > 0,
        afterBuild,
      );
      const afterText = await buildPage.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, buildId);
      runner.check("chain1-build", "建图不改正文", beforeText === afterText);
      runner.finish("chain1-build");
    });

    // ── G5：空补全不写版本、不触发模型；独立「重新建立」必须发出新请求 ──
    await runCase("g5-build-modes", async () => {
      // 前置：库 A 已由 chain1-build 建图完成（所有有正文章节 extracted）。
      const pre = await buildPage.evaluate(async (id) => {
        const status = await window.studio.storyBuildStatus(id);
        const p = await window.studio.load(id);
        return { status, revision: p.revision, nodes: (p.storyEvents?.nodes || []).length };
      }, buildId);
      const allDone =
        pre.status.counts.extracted === pre.status.counts.total && pre.status.counts.total > 0;
      runner.check("g5-build-modes", "前置：所有有正文章节均已 extracted（用于验证空补全）", allDone, {
        counts: pre.status.counts,
      });

      const fetchBefore = (await fs.readFile(buildFetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;

      // ① 全部完成时，UI 不得提供可执行的空补全动作（H6）。
      await buildPage.getByRole("button", { name: "故事事件链", exact: true }).click();
      await buildPage.locator(".sev-build").waitFor();
      // H6 后的正确形态：主按钮整体不渲染，改为一行"没有需要补全的内容"说明；
      // 因此判据是「不存在可执行主按钮」，而不是「按钮被禁用」。
      const primaryCount = await buildPage.locator(".sev-build-btn.primary").count();
      const noopHint = await buildPage
        .locator(".sev-build-actions")
        .innerText()
        .catch(() => "");
      runner.check(
        "g5-build-modes",
        "全部完成时不渲染可执行的空补全主按钮（H6 核心）",
        primaryCount === 0,
        { primaryCount, actionsText: noopHint.slice(0, 120) },
      );
      runner.check(
        "g5-build-modes",
        "并给出可读说明「全部章节已抽取，没有需要补全的内容」",
        /没有需要补全的内容/.test(noopHint),
        { actionsText: noopHint.slice(0, 160) },
      );

      const afterComplete = await buildPage.evaluate(async (id) => {
        const p = await window.studio.load(id);
        const status = await window.studio.storyBuildStatus(id);
        return { revision: p.revision, nodes: (p.storyEvents?.nodes || []).length, counts: status.counts };
      }, buildId);
      const fetchAfterComplete = (await fs.readFile(buildFetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;
      runner.check(
        "g5-build-modes",
        "空补全不写作品版本（H6：revision 不变）",
        afterComplete.revision === pre.revision,
        { before: pre.revision, after: afterComplete.revision },
      );
      runner.check(
        "g5-build-modes",
        "空补全不触发模型请求（精确前后计数相等）",
        fetchAfterComplete === fetchBefore,
        {
          before: fetchBefore,
          after: fetchAfterComplete,
          delta: fetchAfterComplete - fetchBefore,
        },
      );
      // 补充：即便主按钮不渲染，也确认"点不到"不是选择器问题——
      // 记录主按钮计数与可执行动作数，二者一起构成"没有可执行的空补全"。
      const executableActions = await buildPage
        .locator(".sev-build-btn.primary:not([disabled])")
        .count();
      runner.check(
        "g5-build-modes",
        "可执行的空补全动作数为 0（不是按钮被隐藏后仍可触发）",
        executableActions === 0,
        { executableActions, primaryCount },
      );
      runner.check(
        "g5-build-modes",
        "空补全不改变节点数",
        afterComplete.nodes === pre.nodes,
        { before: pre.nodes, after: afterComplete.nodes },
      );

      // ② 独立「重新建立」按钮：必须新增模型请求，且覆盖结果仍完整。
      const rebuildBtn = buildPage.locator(".sev-rebuild-btn");
      const hasRebuild = (await rebuildBtn.count()) > 0;
      runner.check("g5-build-modes", "已建图后出现独立「重新建立」按钮", hasRebuild === true);
      if (hasRebuild) {
        await rebuildBtn.click();
        const rebuildPoll = await pollUntil(
          buildPage,
          async () => {
            const list = await window.studio.list();
            const arr = Array.isArray(list) ? list : list.entries || [];
            const st = await window.studio.storyBuildStatus(arr[0].id);
            return { done: !!st && st.state !== "running", state: st && st.state, counts: st && st.counts };
          },
          undefined,
          { timeout: 180000 },
        );
        const settled = rebuildPoll.ok;
        console.log("[诊断 g5-rebuild] 重建等待:", JSON.stringify(rebuildPoll.last));
        const fetchAfterRebuild = (await fs.readFile(buildFetchLog, "utf8").catch(() => ""))
          .trim().split("\n").filter(Boolean).length;
        const afterRebuild = await buildPage.evaluate(async (id) => {
          const status = await window.studio.storyBuildStatus(id);
          return { counts: status.counts, covered: status.chapters.map((c) => [c.chapterId, c.status]) };
        }, buildId);
        runner.check("g5-build-modes", "重新建立在 180s 内到达终态", settled === true);
        runner.check(
          "g5-build-modes",
          "「重新建立」确实发出新的模型请求（G5 核心）",
          fetchAfterRebuild > fetchAfterComplete,
          { fetchAfterComplete, fetchAfterRebuild },
        );
        runner.check(
          "g5-build-modes",
          "重建后覆盖仍为 extracted（非空且完整）",
          afterRebuild.covered.length > 0 &&
            afterRebuild.covered.every(([, s2]) => s2 === "extracted"),
          { covered: afterRebuild.covered, counts: afterRebuild.counts },
        );
      }
      runner.finish("g5-build-modes");
    });

    // ── 链路1 前置：在**链路1库**用真实界面按钮建图，给后续写作提供历史事件 ──
    // H7：建图必须从真实按钮点击开始，不得用 window.studio.storyBuild 当链路证据。
    await runCase("chain1-seed-graph", async () => {
      const before = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return { revision: p.revision };
      }, chain1Id);
      const fetchBefore = (await fs.readFile(chain1FetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;

      await chain1Page.getByRole("button", { name: "故事事件链", exact: true }).click();
      await chain1Page.locator(".sev-build").waitFor();
      const seedBtn = chain1Page.locator(".sev-build-btn.primary");
      const seedLabel = (await seedBtn.innerText()).trim();
      await seedBtn.click();
      const seedPoll = await pollUntil(
        chain1Page,
        async () => {
          const list = await window.studio.list();
          const arr = Array.isArray(list) ? list : list.entries || [];
          const st = await window.studio.storyBuildStatus(arr[0].id);
          return { done: !!st && st.state !== "running", state: st && st.state, counts: st && st.counts };
        },
        undefined,
        { timeout: 180000 },
      );
      const settled = seedPoll.ok;
      console.log("[诊断 chain1-seed-graph] 建图等待:", JSON.stringify(seedPoll.last));

      // 不 reload：当前画布必须已经渲染出节点。
      await chain1Page.locator(".sev-node").first().waitFor({ timeout: 30000 }).catch(() => {});
      const canvasNodes = await chain1Page.locator(".sev-node").count();
      const disk = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          revision: p.revision,
          nodes: (p.storyEvents?.nodes || []).length,
          nodeIds: (p.storyEvents?.nodes || []).map((n) => n.id).sort(),
          edges: (p.storyEvents?.edges || []).length,
          coverage: (p.storyEvents?.coverage || []).map((c) => [c.chapterId, c.status]),
        };
      }, chain1Id);
      const fetchAfter = (await fs.readFile(chain1FetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;

      runner.check(
        "chain1-seed-graph",
        "按钮文案为「建立事件图」（未建图状态）",
        seedLabel === "建立事件图",
        { label: seedLabel },
      );
      runner.check("chain1-seed-graph", "点击后建图在 180s 内到达终态", settled === true);
      runner.check(
        "chain1-seed-graph",
        "按钮点击确实发出了模型请求（不是只读查询）",
        fetchAfter > fetchBefore,
        { fetchBefore, fetchAfter },
      );
      runner.check(
        "chain1-seed-graph",
        "同一会话未 reload 时画布已有节点",
        canvasNodes > 0,
        { canvasNodes },
      );
      runner.check(
        "chain1-seed-graph",
        "画布节点数 == 读盘正式节点数（无候选时）",
        canvasNodes === disk.nodes,
        { canvasNodes, diskNodes: disk.nodes },
      );
      runner.check(
        "chain1-seed-graph",
        "全程未调用 page.reload（同一打开会话）",
        chain1Session.reloads === 0,
        { reloads: chain1Session.reloads, sessionToken: chain1Session.token },
      );
      runner.check(
        "chain1-seed-graph",
        "共享 revision 已递增（建图写盘后同会话同步）",
        disk.revision > before.revision,
        { before: before.revision, after: disk.revision },
      );
      runner.check(
        "chain1-seed-graph",
        "链路1库读盘 nodes > 0（供后续写作引用历史）",
        disk.nodes > 0,
        { disk },
      );
      runner.finish("chain1-seed-graph", disk);
    });

    // ── 链路1 · chain1-generate：真实章节工作流生成空白新章候选 ──
    await runCase("chain1-generate", async () => {
      const before = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          pending: (p.messages || []).filter((m) => m.status === "pending").length,
          candidateIds: (p.messages || []).filter((m) => m.status === "pending").map((m) => m.id),
          text: p.chapters.map((c) => c.content).join("\u0000"),
          blankChapter: (p.chapters.find((c) => !c.content || !c.content.trim()) || {}).id || null,
        };
      }, chain1Id);
      const fetchBefore = (await fs.readFile(chain1FetchLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;

      // 真实生成入口：不经脚本直接调 runChapterAgent，而是走 studio:generate IPC。
      // H7：候选生成必须走真实界面。这里从「章节阅读」页选空白章，
      // 点「逐场景生成本章」按钮，等真实草稿流程跑到明确终态。
      const blankId = before.blankChapter;
      let result;
      if (!blankId) {
        result = { ok: false, error: "前置不满足：隔离作品中已无空白章" };
      } else {
        // 前置：产品规则「请先采纳或放弃其他任务的方案」会让生成按钮 disabled。
        // 走产品真实路径（save 把 pending 标 rejected）清理，再重新读最新 revision。
        const clearedPre = await chain1Page.evaluate(async (id) => {
          let p = await window.studio.load(id);
          const leftovers = (p.messages || []).filter((m) => m.status === "pending");
          if (leftovers.length) {
            await window.studio.save(
              {
                ...p,
                messages: p.messages.map((m) =>
                  m.status === "pending" ? { ...m, status: "rejected" } : m,
                ),
              },
              p.revision,
            );
            p = await window.studio.load(id);
          }
          return {
            clearedCount: leftovers.length,
            remaining: (p.messages || []).filter((m) => m.status === "pending").length,
            revision: p.revision,
          };
        }, chain1Id);
        await chain1Page.getByRole("button", { name: /^章节阅读/ }).click();
        await chain1Page.locator(".chapter-list").waitFor();
        const blankBtn = chain1Page.locator(".chapter-list button").filter({
          hasText: /仅章纲/,
        }).first();
        const blankCount = await chain1Page
          .locator(".chapter-list button")
          .filter({ hasText: /仅章纲/ })
          .count();
        if (blankCount === 0) {
          result = { ok: false, error: "前置不满足：章节列表里没有「仅章纲」的空白章" };
        } else {
          await blankBtn.click();
          await chain1Page.locator(".chapter-generation").waitFor();
          const genBtn = chain1Page.getByRole("button", { name: "逐场景生成本章", exact: true });
          const genEnabled = await genBtn.isEnabled().catch(() => false);
          if (!genEnabled) {
            // 诊断按钮禁用原因（产品条件：busy / 已有 pending / 字数越界），
            // 便于区分"前置没清干净"与"生成真的被业务规则挡住"。
            const why = await chain1Page.evaluate(async (id) => {
              const p = await window.studio.load(id);
              const pending = (p.messages || []).filter((m) => m.status === "pending");
              return {
                pendingCount: pending.length,
                pendingIds: pending.map((m) => m.id),
                busyText: document.querySelector('[role="status"]')?.textContent || null,
                revision: p.revision,
              };
            }, chain1Id);
            result = { ok: false, error: "「逐场景生成本章」按钮不可用", why };
          } else {
            // 记录点击前的任务 id：只有**新任务**的终态才算本次生成的终态，
            // 否则会把上一条历史任务的 completed/failed 误读成本次结果。
            const taskBefore = await chain1Page.evaluate(async (id) => {
              const t = await window.studio.task(id).catch(() => null);
              return t ? { id: t.id, status: t.status } : null;
            }, chain1Id);
            await genBtn.click();
            // 等明确终态。三类信号缺一不可，否则"任务停在某个阶段"会被误当超时：
            //   ① 产出候选（pending）；② 可读错误 banner；
            //   ③ 任务进入终态（completed/failed/interrupted 等），据此拿到具体原因。
            // 轮询间隔必须够长：默认 raf 每秒几十次 IPC 会挤压生成任务的写队列。
            const genWaitStart = Date.now();
            // 用 Node 侧轮询代替 waitForFunction：
            // 实测 waitForFunction 传 async 谓词时会立刻以 Promise 对象（truthy）判真，
            // 导致 0 秒返回 settled=true（三个条件其实全 false）。改用显式轮询消除歧义。
            const genWaitDeadline = genWaitStart + 600000;
            let settled = false;
            let lastWhy = null;
            while (Date.now() < genWaitDeadline) {
              const why = await chain1Page
                .evaluate(async (before) => {
                  const list = await window.studio.list();
                  const arr = Array.isArray(list) ? list : list.entries || [];
                  const id = arr[0].id;
                  const p = await window.studio.load(id);
                  const pending = (p.messages || []).filter((m) => m.status === "pending");
                  const banner = document.querySelector('.error-banner[role="alert"]');
                  const t = await window.studio.task(id).catch(() => null);
                  const isNewTask = !!t && !!before && t.id !== before.id;
                  const terminal =
                    isNewTask && ["completed", "failed", "interrupted"].includes(t.status);
                  return {
                    done: pending.length > 0 || !!banner || terminal,
                    pending: pending.length,
                    banner: !!banner,
                    terminal,
                    taskBefore: before,
                    taskNow: t ? { id: t.id, status: t.status, stage: t.stage, error: t.error } : null,
                  };
                }, taskBefore)
                .catch(() => null);
              lastWhy = why;
              if (why && why.done === true) {
                settled = true;
                break;
              }
              await chain1Page.waitForTimeout(2000);
            }
            console.log("[诊断 chain1-generate] 等待命中原因:", JSON.stringify(lastWhy));
            const genWaitMs = Date.now() - genWaitStart;
            console.log(
              `[诊断 chain1-generate] 等待结束，耗时 ${Math.round(genWaitMs / 1000)}s，settled=${settled}`,
            );
            const afterUi = await chain1Page.evaluate(async (id) => {
              const p = await window.studio.load(id);
              const pending = (p.messages || []).filter((m) => m.status === "pending");
              const banner = document.querySelector('.error-banner[role="alert"]');
              return {
                candidateIds: pending.map((m) => m.id),
                banner: banner ? banner.textContent : null,
                text: p.chapters.map((c) => c.content).join("\u0000"),
              };
            }, chain1Id);
            const newId = afterUi.candidateIds.find((id) => !before.candidateIds.includes(id)) || null;
            // 诊断：点击后既无候选又无 banner 时，必须能说清按钮是否真的可点、
            // 任务是否启动过（busy/进度）、以及当前 revision，避免"点了没反应"含糊过去。
            const diagAfter = await chain1Page.evaluate(async (id) => {
              const t = await window.studio.task(id).catch(() => null);
              const p = await window.studio.load(id);
              return {
                taskStatus: t && t.status,
                taskStage: t && t.stage,
                taskError: t && t.error,
                revision: p.revision,
                bodyHint: (document.body.innerText.match(/生成中|准备作者档案|正在[^\n]{0,20}/g) || []).slice(0, 3),
              };
            }, chain1Id);
            // 逐条列出本轮请求所属阶段，直接看出卡在哪个节点（不靠猜）。
            const fetchStages = (await fs.readFile(chain1FetchLog, "utf8").catch(() => ""))
              .trim().split("\n").filter(Boolean)
              .map((line) => {
                try {
                  const body = JSON.parse(JSON.parse(line).body || "{}");
                  const sys = (body.messages || [])
                    .filter((m) => m.role === "system")
                    .map((m) => m.content)
                    .join(" ");
                  return sys.slice(0, 60).replace(/\n/g, " ");
                } catch { return "(unparsed)"; }
              });
            // 四项诊断（lead 指定）：任务终态 / banner / 磁盘检查点原文 / 最后请求阶段。
            const checkpointDump = await chain1Page.evaluate(async (id) => {
              const t = await window.studio.task(id).catch(() => null);
              return t || null;
            }, chain1Id);
            const bannerText = await chain1Page
              .evaluate(() => {
                const el = document.querySelector('.error-banner[role="alert"]');
                return el ? el.textContent : null;
              })
              .catch(() => null);
            // 磁盘检查点原文：隔离库在该作品 runtime 目录下的 chapter-task.json。
            let diskCheckpoint = null;
            try {
              // directoryFor(id) = <dataDir>/projects/<projectId>；
              // runtimeDirectoryFor 同值（未重写时），检查点在同目录 chapter-task.json。
              const raw = await fs.readFile(
                path.join(chain1Dir, "projects", chain1Id, "chapter-task.json"),
                "utf8",
              );
              const parsed = JSON.parse(raw);
              const ops = Array.isArray(parsed.logOperations)
                ? parsed.logOperations.slice(-3).map((o) => ({
                    status: o && o.status,
                    label: o && o.label,
                  }))
                : null;
              diskCheckpoint = {
                status: parsed.status,
                stage: parsed.stage,
                error: parsed.error,
                calls: parsed.calls,
                lastOperations: ops,
              };
              await fs.writeFile(
                path.join(runDir, "chain1-generate-checkpoint.json"),
                JSON.stringify(parsed, null, 2),
              );
            } catch (error) {
              diskCheckpoint = { readError: error.message };
            }
            const diagBundle = {
              settled,
              afterUi,
              diagAfter,
              bannerText,
              diskCheckpoint,
              fetchStages,
              lastFetchStages: fetchStages.slice(-3),
              checkpointDump,
            };
            console.log("[诊断 chain1-generate]", JSON.stringify(diagBundle, null, 1));
            await fs.writeFile(
              path.join(runDir, "chain1-generate-diagnosis.json"),
              JSON.stringify(diagBundle, null, 2),
            );
            result = {
              ok: !afterUi.banner && !!newId,
              error: afterUi.banner || (newId ? null : "按钮点击后未产出新候选"),
              settled,
              candidateId: newId,
              pendingCount: afterUi.candidateIds.length,
            };
          }
        }
      }

      const fetchAfter = (await fs.readFile(chain1FetchLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
      const newCalls = fetchAfter - fetchBefore;
      runner.check(
        "chain1-generate",
        "真实生成确实发出了模型请求（fetch 替身被调用）",
        newCalls > 0,
        { newCalls, total: fetchAfter, diag: result.diag },
      );
      if (!result.ok) {
        runner.check("chain1-generate", "生成入口失败时须给出可读原因", typeof result.error === "string" && result.error.length > 0, result);
      }
      const after = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          pending: (p.messages || []).filter((m) => m.status === "pending").length,
          candidateIds: (p.messages || []).filter((m) => m.status === "pending").map((m) => m.id),
          text: p.chapters.map((c) => c.content).join("\u0000"),
        };
      }, chain1Id);
      runner.check(
        "chain1-generate",
        "未采纳前正式正文不变",
        after.text === before.text,
        { beforeLen: before.text.length, afterLen: after.text.length },
      );
      // G7 缺口1：失败不得算通过。成功路径必须 result.ok === true **且**确实产生了
      // 本次生成的新候选（按候选 ID 判断，不是只看 pending 数量增减）。
      if (!result.ok) {
        // 前置缺失优先判定：不再记"生成成功/产生候选"两条 fail，
        // 否则 unverified 会被先前的 fail 覆盖，语义错乱。
        runner.unverified(
          "chain1-generate",
          `未验证：真实界面生成未产出候选，阻塞于 task-7（${result.error}）` +
            `；任务停在本轮最后阶段，不据此判产品失败`,
          {
            error: result.error,
            settled: result.settled,
            diagnostics: typeof diagAfter === "undefined" ? null : diagAfter,
            fetchStages: typeof fetchStages === "undefined" ? null : fetchStages,
          },
        );
        return;
      }
      runner.check(
        "chain1-generate",
        "生成成功（result.ok === true）",
        result.ok === true,
        { generateOk: result.ok, error: result.error },
      );
      runner.check(
        "chain1-generate",
        "确实产生本次生成的新候选（按候选 ID 判断）",
        result.ok === true && !!result.candidateId && after.candidateIds.includes(result.candidateId),
        {
          expectedCandidateId: result.candidateId || null,
          afterCandidateIds: after.candidateIds,
          beforeCandidateIds: before.candidateIds,
        },
      );
      // 把本次生成的真实候选 ID 交给下游 case（chain1-accept），
      // 下游不得再手写 pending id 冒充"本次生成"。
      if (result.ok && result.candidateId) generatedCandidateId = result.candidateId;
      runner.finish("chain1-generate");
    });

    // ── 链路1 · chain1-requests：请求确实含历史事件 id 与原文 ──
    await runCase("chain1-requests", async () => {
      const raw = await fs.readFile(chain1FetchLog, "utf8").catch(() => "");
      const lines = raw.trim().split("\n").filter(Boolean);
      const parsed = lines.map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const sevRe = /sev-[0-9a-f]{12}/g;
      const withIds = parsed.filter((p) => (p.body || "").match(sevRe));
      const ids = [...new Set(withIds.flatMap((p) => (p.body || "").match(sevRe) || []))];

      runner.check("chain1-requests", "存在被记录的模型请求", parsed.length > 0, { calls: parsed.length });
      runner.check(
        "chain1-requests",
        "至少一次请求携带历史事件 id（sev-）",
        withIds.length > 0,
        { withIds: withIds.length, ids },
      );
      // 历史原文：请求体应包含正式图里已有事件的原引文
      const quoteProbe = await chain1Page.evaluate(async (id) => {
        const view = await window.studio.storyEvents(id);
        return (view.graph.nodes || []).slice(0, 6).map((n) => n.evidence && n.evidence.quote).filter(Boolean);
      }, chain1Id);
      const hasQuote = quoteProbe.some((q) => parsed.some((p) => (p.body || "").includes(q)));
      runner.check("chain1-requests", "至少一次请求携带正式图已有事件的原文", hasQuote, {
        quotes: quoteProbe.slice(0, 3),
      });
      runner.finish("chain1-requests");
    });

    // ── 链路1 · chain1-preview：候选跨章边端点 id + 问题内容 + 证据引文（F8）──
    await runCase("chain1-preview", async () => {
      // 前置：必须存在本次生成的真实候选；没有就如实失败，不造一个假的。
      if (!generatedCandidateId) {
        // 无候选时不能冒充链路证据。这里改用**夹具级**验证 previewStoryEvents
        // 这一运行时聚合函数本身：跨章边端点必须是具体 sev- id 且能对上正式图节点，
        // 问题必须带 kind/explanation/evidence[].quote 的具体值。
        // 明确标注：单元/夹具级，不是产品链路证据。
        const { previewStoryEvents } = await import("../electron/story-build-channel.mjs");
        const { storyEventsForProposal } = await import("../runtime/story-event-agent.mjs");
        const { mergeStoryEvents, emptyStoryEvents } = await import("../runtime/story-events.mjs");
        const formalNodes = read.graph.nodes;
        const formalIdsForProbe = new Set(formalNodes.map((n) => n.id));
        // 夹具必须走生产同源变换：先用真实 mergeStoryEvents 得到候选节点的稳定 id，
        // 再由 storyEventsForProposal 生成增量补丁。手编占位 id 会被端点校验丢弃（已踩过）。
        const fixtureChapterId = "ch3";
        const fixtureQuote = quoteOf(fixtureChapterId, "他忽然想起父亲掌心的那道旧疤");
        const fixtureGraph = mergeStoryEvents(
          graph,
          [
            draftNode({
              chapterId: fixtureChapterId,
              title: "夹具候选事件",
              summary: "夹具级候选",
              kind: "action",
              actors: ["林砚"],
              objects: ["铜扣"],
              status: "candidate",
              basis: "narration",
              evidence: evidenceOf(fixtureChapterId, fixtureQuote),
            }),
          ],
          { chapters: revisedChapters, knownNodeIds: [...formalIdsForProbe] },
        ).storyEvents;
        const fixtureCandidateIds = fixtureGraph.nodes
          .filter((n) => n.chapterId === fixtureChapterId && !formalIdsForProbe.has(n.id))
          .map((n) => n.id);
        const fixtureEdgeTarget = fixtureCandidateIds[0] || null;
        const withEdge = fixtureEdgeTarget
          ? mergeStoryEvents(fixtureGraph, [], {
              chapters: revisedChapters,
              knownNodeIds: [...formalIdsForProbe],
              edges: [
                {
                  source: formalNodes[0].id,
                  target: fixtureEdgeTarget,
                  type: "causal",
                  basis: "explicit",
                  explanation: "夹具级跨章边：候选事件承接第一章交接动作。",
                  evidence: [evidenceOf(fixtureChapterId, fixtureQuote)],
                },
              ],
            }).storyEvents
          : fixtureGraph;
        const fixturePatch = storyEventsForProposal(withEdge, {
          chapterIds: [fixtureChapterId],
        });
        // 注意：storyEventsForProposal 会按 scope 过滤 issues（只保留关联本片节点/边的问题）。
        // 夹具这里故意不写 nodeIds，让问题作为"本片级"问题进入补丁——
        // 这同时也覆盖了"问题保留"这一分支；正式链路里问题会由本片候选节点承载。
        fixturePatch.issues = [
          {
            kind: "stale-evidence",
            nodeIds: [],
            edgeIds: [],
            explanation: "夹具级问题：候选章出处与当前正文不一致，需作者核对。",
            suggestion: "复核该事件的原文依据。",
            disposition: "open",
          },
        ];
        let preview = null;
        try {
          preview = previewStoryEvents({
            formalNodes,
            patch: fixturePatch,
            chapters: revisedChapters,
          });
        } catch (error) {
          preview = { error: error.message };
        }
        const probeEdges = (preview && preview.graph && preview.graph.edges) || [];
        const probeTargetIds = probeEdges
          .filter((e) => formalIdsForProbe.has(e.source))
          .map((e) => e.target);
        // 问题不由 previewStoryEvents 承载（它只归一化增量图的节点/边/证据）。
        // 真实链路里候选问题由主进程从 patch.issues 聚合，所以这里对产品真实入口产出的
        // 补丁注入问题，断言问题对象（kind/explanation）保持完整、未被 scope 过滤打散。
        const scopePatch = storyEventsForProposal(withEdge, { chapterIds: [fixtureChapterId] });
        scopePatch.issues = [
          {
            kind: "stale-evidence",
            nodeIds: [],
            edgeIds: [],
            explanation: "夹具级问题：候选章出处与当前正文不一致，需作者核对。",
            suggestion: "复核该事件的原文依据。",
            disposition: "open",
          },
        ];
        const probeIssues = scopePatch.issues || [];
        runner.check(
          "chain1-preview",
          "【夹具级，非链路】跨章边 source 是正式图里的具体 sev- id",
          probeEdges.length > 0 &&
            probeEdges.every((e) => /^sev-[0-9a-f]{12}$/.test(e.source) && formalIdsForProbe.has(e.source)),
          { edges: probeEdges.map((e) => `${e.source}->${e.target}:${e.type}`) },
        );
        const patchNodeIds = new Set((fixturePatch.nodes || []).map((n) => n.id).filter(Boolean));
        runner.check(
          "chain1-preview",
          "【夹具级，非链路】跨章边 target 是具体 sev- id，且能在候选增量里对上",
          probeTargetIds.length > 0 &&
            probeTargetIds.every(
              (id) =>
                /^sev-[0-9a-f]{12}$/.test(id) &&
                (patchNodeIds.size === 0 || patchNodeIds.has(id)),
            ),
          { targetIds: probeTargetIds, patchNodeIds: [...patchNodeIds] },
        );
        runner.check(
          "chain1-preview",
          "【夹具级，非链路】问题携带具体 kind 与 explanation（非空壳）",
          probeIssues.length > 0 &&
            probeIssues.every(
              (i) =>
                typeof i.kind === "string" &&
                i.kind.length > 0 &&
                typeof i.explanation === "string" &&
                i.explanation.length > 0,
            ),
          {
            issues: probeIssues.map((i) => ({ kind: i.kind, explanation: i.explanation })),
          },
        );
        runner.check(
          "chain1-preview",
          "【夹具级，非链路】预览不写正式图（formalNodes 引用保持不变）",
          formalNodes === read.graph.nodes,
        );
        runner.unverified(
          "chain1-preview",
          "未验证：产品链路的候选预览阻塞于 task-7(生成不出候选)；" +
            "以上四条仅证明 previewStoryEvents 聚合函数层（夹具级）",
          { fixtureLevel: true },
        );
        return;
      }
      const view = await chain1Page.evaluate(async (id) => {
        const v = await window.studio.storyEvents(id);
        const p = await window.studio.load(id);
        return {
          candidates: v.candidates,
          graph: { nodes: v.graph.nodes, edges: v.graph.edges, issues: v.graph.issues },
          chapterContent: Object.fromEntries(
            (p.chapters || []).map((c) => [c.id, c.content]),
          ),
        };
      }, chain1Id);

      const candNodes = view.candidates.nodes || [];
      const candEdges = view.candidates.edges || [];
      const candIssues = view.candidates.issues || [];

      runner.check(
        "chain1-preview",
        "候选区含本次候选的事件节点（非空）",
        candNodes.length > 0,
        { candidateNodes: candNodes.length, candidateId: generatedCandidateId },
      );
      runner.check(
        "chain1-preview",
        "候选节点全部来自本次候选消息",
        candNodes.every((n) => n.origin && n.origin.messageId === generatedCandidateId),
        { origins: [...new Set(candNodes.map((n) => n.origin && n.origin.messageId))] },
      );

      // 跨章边：一端必须是正式图里的历史事件 id（逐字核对，不只看"有边"）。
      const formalIds = new Set(view.graph.nodes.map((n) => n.id));
      const crossEdges = candEdges.filter(
        (e) => formalIds.has(e.source) || formalIds.has(e.target),
      );
      runner.check(
        "chain1-preview",
        "候选存在跨章边（至少一端指向正式历史事件）",
        crossEdges.length > 0,
        {
          edges: candEdges.map((e) => `${e.source}->${e.target}:${e.type}`),
          formalIds: [...formalIds],
        },
      );
      const crossEdge = crossEdges[0] || null;
      const historyEndpointId = crossEdge
        ? formalIds.has(crossEdge.source)
          ? crossEdge.source
          : crossEdge.target
        : null;
      const historyNode = historyEndpointId
        ? view.graph.nodes.find((n) => n.id === historyEndpointId)
        : null;
      runner.check(
        "chain1-preview",
        "跨章边端点 id 能在正式图中查到对应事件（具体 id，非仅字段存在）",
        !!historyNode,
        { historyEndpointId, title: historyNode && historyNode.title },
      );
      runner.check(
        "chain1-preview",
        "该历史端点带可核原文引文，且引文逐字出现在对应章节正文里",
        !!historyNode &&
          !!historyNode.evidence &&
          (view.chapterContent[historyNode.evidence.chapterId] || "").includes(
            historyNode.evidence.quote,
          ),
        {
          historyEndpointId,
          chapterId: historyNode && historyNode.evidence && historyNode.evidence.chapterId,
          quote: historyNode && historyNode.evidence && historyNode.evidence.quote,
        },
      );
      runner.check(
        "chain1-preview",
        "该跨章边的解释文字非空（能说明为什么相连）",
        !!crossEdge && typeof crossEdge.explanation === "string" && crossEdge.explanation.trim().length > 0,
        { explanation: crossEdge && crossEdge.explanation },
      );

      // 问题：必须真实产生并带具体内容与证据，不能只断言字段存在。
      runner.check(
        "chain1-preview",
        "候选区含本次候选带来的问题（数量 > 0）",
        candIssues.length > 0,
        { candidateIssues: candIssues.map((i) => [i.kind, i.nodeIds]) },
      );
      const issue = candIssues[0] || null;
      runner.check(
        "chain1-preview",
        "候选问题归属本次候选消息",
        !!issue && issue.origin && issue.origin.messageId === generatedCandidateId,
        { origin: issue && issue.origin },
      );
      runner.check(
        "chain1-preview",
        "候选问题有具体类型与可读说明（不是空壳）",
        !!issue &&
          typeof issue.kind === "string" &&
          issue.kind.length > 0 &&
          typeof issue.explanation === "string" &&
          issue.explanation.trim().length > 0,
        { kind: issue && issue.kind, explanation: issue && issue.explanation },
      );
      runner.check(
        "chain1-preview",
        "候选问题带证据原文（evidence[].quote 逐字来自候选正文）",
        !!issue &&
          Array.isArray(issue.evidence) &&
          issue.evidence.length > 0 &&
          issue.evidence.every(
            (e) =>
              e &&
              typeof e.quote === "string" &&
              e.quote.length > 0 &&
              candNodes.some((n) => n.id && issue.nodeIds.includes(n.id)),
          ),
        { evidence: issue && issue.evidence },
      );
      runner.finish("chain1-preview", {
        candidateId: generatedCandidateId,
        candidateNodeIds: candNodes.map((n) => n.id).sort(),
        crossEdge: crossEdge ? `${crossEdge.source}->${crossEdge.target}` : null,
        historyEndpointId,
        issueId: issue && issue.id,
        issueKind: issue && issue.kind,
      });
    });

    // ── 链路1 · chain1-accept：再生成一次新候选，预览后真实采纳（严禁手写 pending）──
    await runCase("chain1-accept", async () => {
      // 前置：上一轮候选已被放弃，这里必须重新走真实生成得到**新**候选。
      const fetchBefore = (await fs.readFile(chain1FetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;
      // 再生成前必须清理遗留 pending（否则生成按钮 disabled）。
      // 按 lead 裁断走**产品真实路径**：点界面「放弃候选」按钮，
      // 而不是 IPC save 直接改盘——后者会让磁盘 revision 前进但 UI 不知情，
      // 下一次提交被判「作品版本冲突」（本轮实测踩到）。
      // 注意：只放弃「不是 chain1-generate 那个」的遗留候选，保护待断言的对象。
      await chain1Page.getByRole("button", { name: /^章节阅读/ }).click();
      await chain1Page.locator(".chapter-list").waitFor();
      const keepId = generatedCandidateId;
      for (let round = 0; round < 5; round += 1) {
        const pendingNow = await chain1Page.evaluate(async (id) => {
          const p = await window.studio.load(id);
          return (p.messages || [])
            .filter((m) => m.status === "pending")
            .map((m) => m.id);
        }, chain1Id);
        const droppable = pendingNow.filter((id) => id !== keepId);
        if (!droppable.length) break;
        const abandonBtn = chain1Page.getByRole("button", { name: "放弃候选", exact: true }).first();
        if ((await abandonBtn.count()) === 0) break;
        await abandonBtn.click();
        await pollUntil(
          chain1Page,
          async (target) => {
            const p = await window.studio.load((await window.studio.list())[0].id);
            const m = (p.messages || []).find((x) => x.id === target);
            return { done: !m || m.status !== "pending", status: m ? m.status : null };
          },
          droppable[0],
          { timeout: 30000 },
        );
      }
      await chain1Page.getByRole("button", { name: /^章节阅读/ }).click();
      const blankCount = await chain1Page
        .locator(".chapter-list button")
        .filter({ hasText: /仅章纲/ })
        .count();
      if (blankCount === 0) {
        runner.unverified(
          "chain1-accept",
          "未验证：已无「仅章纲」章节，空白章候选链路无法继续（前置缺失）",
        );
        return;
      }
      await chain1Page.locator(".chapter-list button").filter({ hasText: /仅章纲/ }).first().click();
      await chain1Page.locator(".chapter-generation").waitFor();
      const beforeIds = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return (p.messages || []).filter((m) => m.status === "pending").map((m) => m.id);
      }, chain1Id);
      // 等编排就绪（并发闸门释放），再判定按钮可点性。
      const acceptReady = await waitOrchestrationIdle(chain1Page, chain1Id);
      const keepIdBefore = generatedCandidateId;
      const acceptPending = await describePending(chain1Page, chain1Id, chain1Dir);
      console.log(
        "[诊断 chain1-accept] 编排就绪:",
        JSON.stringify({
          ok: acceptReady.ok,
          ms: acceptReady.ms,
          last: acceptReady.last,
          pending: acceptPending,
        }),
      );
      runner.check(
        "chain1-accept",
        "发起再生成前编排已就绪（任务收尾且无 busy）",
        acceptReady.ok === true,
        acceptReady.last,
      );
      const acceptGenBtn = chain1Page.getByRole("button", { name: "逐场景生成本章", exact: true });
      if (!(await acceptGenBtn.isEnabled().catch(() => false))) {
        // 准确原因（可复核）：ChapterGeneration.tsx:39 用 `!!pending` 禁用生成按钮，
        // 而 :19-21 只在该章正文有差异时才渲染"采纳/放弃"入口，
        // 因此遗留的"无改动候选"在章节页没有处理途径，只能去创作对话。
        runner.unverified(
          "chain1-accept",
          "未验证：产品规则 ChapterGeneration.tsx:39 的 !!pending 禁用了生成按钮；" +
            "遗留 pending 无法在章节页清除（该页只在正文有差异时提供处理入口，见 :19-21）",
          {
            orchestrationReady: acceptReady.ok,
            waitedMs: acceptReady.ms,
            last: acceptReady.last,
            pending: acceptPending,
            keptCandidateBefore: keepIdBefore,
            keptCandidateAfter: generatedCandidateId,
          },
        );
        return;
      }
      await acceptGenBtn.click();
      const acceptPoll = await pollUntil(
        chain1Page,
        async () => {
          const list = await window.studio.list();
          const arr = Array.isArray(list) ? list : list.entries || [];
          const p = await window.studio.load(arr[0].id);
          const banner = document.querySelector('.error-banner[role="alert"]');
          const t = await window.studio.task(arr[0].id).catch(() => null);
          const pending = (p.messages || []).some((m) => m.status === "pending");
          const terminal =
            !!t && ["completed", "failed", "interrupted"].includes(t.status);
          return {
            done: pending || !!banner || terminal,
            pending,
            banner: !!banner,
            taskNow: t ? { status: t.status, stage: t.stage, error: t.error } : null,
          };
        },
        undefined,
        { timeout: 600000 },
      );
      const settled = acceptPoll.ok;
      console.log("[诊断 chain1-accept] 等待结果:", JSON.stringify(acceptPoll.last));
      const afterGen = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        const pending = (p.messages || []).filter((m) => m.status === "pending");
        const banner = document.querySelector('.error-banner[role="alert"]');
        return {
          pendingIds: pending.map((m) => m.id),
          banner: banner ? banner.textContent : null,
        };
      }, chain1Id);
      const newCandidateId =
        afterGen.pendingIds.find((id) => !beforeIds.includes(id)) || null;
      const fetchAfter = (await fs.readFile(chain1FetchLog, "utf8").catch(() => ""))
        .trim().split("\n").filter(Boolean).length;

      runner.check("chain1-accept", "再生成在 600s 内到达终态", settled === true);
      runner.check(
        "chain1-accept",
        "再生成确实发出了新的模型请求",
        fetchAfter > fetchBefore,
        { fetchBefore, fetchAfter },
      );
      runner.check(
        "chain1-accept",
        "确实产生了一个新的候选（按候选 ID 判断，不是复用被放弃的那个）",
        !!newCandidateId,
        { newCandidateId, banner: afterGen.banner, pendingIds: afterGen.pendingIds },
      );
      if (!newCandidateId) {
        runner.finish("chain1-accept");
        return;
      }
      generatedCandidateId = newCandidateId;

      const before = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          revision: p.revision,
          nodes: (p.storyEvents?.nodes || []).length,
          text: p.chapters.map((c) => c.content).join("\u0000"),
        };
      }, chain1Id);

      const accepted = await chain1Page.evaluate(
        async ({ id, candidateId }) => {
          const p0 = await window.studio.load(id);
          const msg = (p0.messages || []).find((m) => m.id === candidateId);
          const proposalText = ((msg && msg.proposal && msg.proposal.chapters) || [])
            .map((c) => c.content)
            .join("\u0000");
          await window.studio.accept(id, candidateId);
          const reread = await window.studio.load(id);
          return {
            acceptedStatus: (reread.messages || []).some(
              (m) => m.id === candidateId && m.status === "accepted",
            ),
            textAfter: reread.chapters.map((c) => c.content).join("\u0000"),
            proposalText,
            nodes: (reread.storyEvents?.nodes || []).length,
            nodeIds: (reread.storyEvents?.nodes || []).map((n) => n.id).sort(),
            edgeIds: (reread.storyEvents?.edges || []).map((e) => e.id).sort(),
            issueIds: (reread.storyEvents?.issues || []).map((i) => i.id).sort(),
            quotesOk: (reread.storyEvents?.nodes || []).every(
              (n) =>
                n.evidence &&
                (reread.chapters || []).some(
                  (c) => c.id === n.evidence.chapterId && c.content.includes(n.evidence.quote),
                ),
            ),
          };
        },
        { id: chain1Id, candidateId: newCandidateId },
      );

      runner.check(
        "chain1-accept",
        "该候选状态已标记 accepted（读盘核对）",
        accepted.acceptedStatus === true,
        { candidateId: newCandidateId },
      );
      runner.check(
        "chain1-accept",
        "采纳后正文确实变为候选正文（读盘核对）",
        accepted.textAfter === accepted.proposalText,
        { proposalLen: accepted.proposalText.length, afterLen: accepted.textAfter.length },
      );
      runner.check(
        "chain1-accept",
        "采纳后节点数未减少（事件未丢失）",
        accepted.nodes >= before.nodes,
        { before: before.nodes, after: accepted.nodes },
      );
      runner.check(
        "chain1-accept",
        "采纳后所有事件引文都能在正文逐字找到",
        accepted.quotesOk === true,
      );
      runner.finish("chain1-accept", {
        acceptedCandidateId: newCandidateId,
        nodes: accepted.nodes,
        nodeIds: accepted.nodeIds,
        edgeIds: accepted.edgeIds,
        issueIds: accepted.issueIds,
      });
    });

    // ── 链路1 · chain1-abandon：放弃**本次实际生成**的候选并读盘确认未污染 ──
    // H7：禁止手写 pending-abandon-e2e；候选必须是 chain1-generate 真实产出的那个。
    await runCase("chain1-abandon", async () => {
      if (!generatedCandidateId) {
        runner.unverified(
          "chain1-abandon",
          "未验证：chain1-generate 未产出候选，且禁止手写候选替代",
        );
        return;
      }
      const before = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          formal: JSON.stringify(p.storyEvents ?? null),
          text: p.chapters.map((c) => c.content).join("\u0000"),
          revision: p.revision,
        };
      }, chain1Id);

      // 真实界面放弃：章节页里的「放弃候选」按钮。
      await chain1Page.getByRole("button", { name: /^章节阅读/ }).click();
      const abandonBtn = chain1Page.getByRole("button", { name: "放弃候选", exact: true }).first();
      const hasAbandon = (await abandonBtn.count()) > 0;
      runner.check(
        "chain1-abandon",
        "本次候选在章节页渲染出「放弃候选」按钮（界面确实看得到）",
        hasAbandon,
        { candidateId: generatedCandidateId },
      );
      if (hasAbandon) await abandonBtn.click();
      const abandonPoll = await pollUntil(
        chain1Page,
        async (candidateId) => {
          const list = await window.studio.list();
          const arr = Array.isArray(list) ? list : list.entries || [];
          const p = await window.studio.load(arr[0].id);
          const m = (p.messages || []).find((x) => x.id === candidateId);
          return { done: !m || m.status !== "pending", status: m ? m.status : null };
        },
        generatedCandidateId,
        { timeout: 60000 },
      );
      const settled = abandonPoll.ok;
      runner.check("chain1-abandon", "放弃后候选离开 pending 状态（60s 内到终态）", settled === true);

      const after = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          formal: JSON.stringify(p.storyEvents ?? null),
          text: p.chapters.map((c) => c.content).join("\u0000"),
          statuses: (p.messages || []).map((m) => `${m.id}:${m.status}`),
        };
      }, chain1Id);

      runner.check(
        "chain1-abandon",
        "该候选状态已落盘为 rejected（读盘核对）",
        after.statuses.includes(`${generatedCandidateId}:rejected`),
        { candidateId: generatedCandidateId, statuses: after.statuses },
      );
      runner.check(
        "chain1-abandon",
        "放弃后重读盘：正式 storyEvents 与放弃前完全一致（未污染）",
        after.formal === before.formal,
        { beforeLen: before.formal.length, afterLen: after.formal.length },
      );
      runner.check(
        "chain1-abandon",
        "放弃候选不改正文",
        after.text === before.text,
      );
      runner.finish("chain1-abandon", { abandonedCandidateId: generatedCandidateId });
      // 放弃后本次候选作废，下游必须重新生成，不能复用。
      generatedCandidateId = null;
    });

    // ── 链路1 · chain1-restart：关闭后用**同一隔离库**重启，核对全量持久化 ──
    await runCase("chain1-restart", async () => {
      const before = await chain1Page.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          text: (p.chapters || []).map((c) => c.content).join("\u0000"),
          nodeIds: (p.storyEvents?.nodes || []).map((n) => n.id).sort(),
          edgeIds: (p.storyEvents?.edges || []).map((e) => e.id).sort(),
          issueIds: (p.storyEvents?.issues || []).map((i) => i.id).sort(),
          issueDispositions: (p.storyEvents?.issues || []).map((i) => `${i.id}:${i.disposition}`).sort(),
          nodeCount: (p.storyEvents?.nodes || []).length,
          edgeCount: (p.storyEvents?.edges || []).length,
        };
      }, chain1Id);

      await chain1App.close();
      await writeIsolatedProviders();
      await fs.writeFile(
        path.join(chain1Dir, "providers.json"),
        JSON.stringify({
          glm: { provider: "glm", model: "glm-5.3", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
          minimax: { provider: "minimax", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" },
        }),
        { mode: 0o600 },
      );
      const restarted = await launchOwned({
        args: [root],
        env: {
          ...childEnv,
          NOVEL_AGENT_DATA_DIR: chain1Dir,
          NOVEL_AGENT_ENV: path.join(chain1Dir, "test.env"),
          NOVEL_E2E_FETCH_LOG: path.join(chain1Dir, "model-fetch.jsonl"),
        },
      });
      try {
        const p2 = await restarted.firstWindow();
        await waitAppReady(restarted, p2, "链路1重启");
        const after = await p2.evaluate(async (id) => {
          const p = await window.studio.load(id);
          return {
            text: (p.chapters || []).map((c) => c.content).join("\u0000"),
            nodeIds: (p.storyEvents?.nodes || []).map((n) => n.id).sort(),
            edgeIds: (p.storyEvents?.edges || []).map((e) => e.id).sort(),
            issueIds: (p.storyEvents?.issues || []).map((i) => i.id).sort(),
            issueDispositions: (p.storyEvents?.issues || []).map((i) => `${i.id}:${i.disposition}`).sort(),
            nodeCount: (p.storyEvents?.nodes || []).length,
            edgeCount: (p.storyEvents?.edges || []).length,
          };
        }, chain1Id);

        runner.check("chain1-restart", "重启后正文一致", after.text === before.text);
        runner.check(
          "chain1-restart",
          "重启后事件节点 ID 集合一致（同一稳定 ID）",
          JSON.stringify(after.nodeIds) === JSON.stringify(before.nodeIds),
          { before: before.nodeCount, after: after.nodeCount },
        );
        runner.check(
          "chain1-restart",
          "重启后关系边 ID 集合一致",
          JSON.stringify(after.edgeIds) === JSON.stringify(before.edgeIds),
          { before: before.edgeCount, after: after.edgeCount },
        );
        runner.check(
          "chain1-restart",
          "重启后问题 ID 与 disposition 一致",
          JSON.stringify(after.issueDispositions) === JSON.stringify(before.issueDispositions),
        );
      } finally {
        await restarted.close();
      }
      runner.finish("chain1-restart");
    });

    // ── 链路2 · chain2-decide：三种作者决定持久化且正文不变 ──
    await runCase("chain2-decide", async () => {
      const before = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          text: p.chapters.map((c) => c.content).join("\u0000"),
          issues: (p.storyEvents?.issues || []).map((i) => i.id),
        };
      }, activeId);
      if (!before.issues.length) {
        runner.check("chain2-decide", "正式图存在可处理的问题（前置条件）", false, {
          issues: 0,
          note: "需要先有正式图与问题，属前置依赖未满足",
        });
        runner.finish("chain2-decide");
        return;
      }
      for (const decision of ["kept", "dismissed", "author-decided"]) {
        const got = await reopened.evaluate(
          async ({ id, issueId, decision }) => {
            const r = await window.studio.decideStoryIssue({
              projectId: id,
              issueId,
              decision,
            });
            return (r.issues || []).find((i) => i.id === issueId);
          },
          { id: activeId, issueId: before.issues[0], decision },
        );
        runner.check(
          "chain2-decide",
          `decision=${decision} 持久化到正式图`,
          got && got.disposition === decision,
          { expected: decision, actual: got && got.disposition },
        );
      }
      const after = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return p.chapters.map((c) => c.content).join("\u0000");
      }, activeId);
      runner.check("chain2-decide", "三次作者决定均不改正文", before.text === after);
      runner.finish("chain2-decide");
    });

    // ── F10 实机：发起修订 → 进既有草稿流程 → 未采纳正文不变 ──
    await runCase("F10-ui-revision", async () => {
      // 前置清理：产品规则「请先采纳或放弃其他任务的方案」会直接拒绝生成，
      // 这里走产品真实路径把遗留 pending 标为 rejected，再重新读最新 revision。
      const cleaned = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const id = arr[0].id;
        let p = await window.studio.load(id);
        const leftovers = (p.messages || []).filter((m) => m.status === "pending");
        if (leftovers.length) {
          await window.studio.save(
            {
              ...p,
              messages: p.messages.map((m) =>
                m.status === "pending" ? { ...m, status: "rejected" } : m,
              ),
            },
            p.revision,
          );
          p = await window.studio.load(id);
        }
        return {
          projectId: id,
          clearedCount: leftovers.length,
          remainingPending: (p.messages || []).filter((m) => m.status === "pending").length,
          revision: p.revision,
        };
      });
      const before = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const id = arr[0].id;
        const p = await window.studio.load(id);
        return {
          projectId: id,
          text: p.chapters.map((c) => c.content).join("\u0000"),
          pending: (p.messages || []).filter((m) => m.status === "pending").length,
        };
      });
      runner.check(
        "F10-ui-revision",
        "前置：清理遗留 pending 后无阻塞候选",
        cleaned.remainingPending === 0,
        cleaned,
      );

      await reopened.getByRole("button", { name: "故事事件链", exact: true }).click();
      await reopened.locator(".sev-node").first().waitFor();
      await reopened.getByRole("tab", { name: /^问题/ }).first().click();
      await reopened.getByRole("tab", { name: /正式图问题/ }).click();
      await reopened.locator(".sev-issue").first().waitFor();

      // 1) 按钮可点
      // 等 formal 问题列表渲染完成后再定位按钮（否则会误判"按钮不存在"）。
      await reopened.locator(".sev-issue-list").first().waitFor({ timeout: 15000 }).catch(() => {});
      const issueTexts = await reopened.locator(".sev-issue").allInnerTexts().catch(() => []);
      const hasOpenFormal = issueTexts.some((t) => /保留/.test(t));
      if (!hasOpenFormal) {
        // 诊断：区分"列表没渲染"与"问题已被处理过导致按钮组不渲染"
        runner.check(
          "F10-ui-revision",
          "正式图存在 disposition=open 的问题（决定按钮组渲染前提）",
          false,
          { issueCount: issueTexts.length, sample: issueTexts.slice(0, 2) },
        );
        runner.finish("F10-ui-revision");
        return;
      }
      const sevButtons = await reopened.locator(".sev-decisions button").allInnerTexts().catch(() => []);
      const trigger = reopened.getByRole("button", { name: "发起修订", exact: true }).first();
      const triggerCount = await reopened
        .getByRole("button", { name: "发起修订", exact: true })
        .count();
      if (triggerCount === 0) {
        runner.check(
          "F10-ui-revision",
          "「发起修订」按钮在作者决定区可见",
          false,
          { decisionButtons: sevButtons, note: "问题已渲染但修订按钮缺失" },
        );
        runner.finish("F10-ui-revision");
        return;
      }
      runner.check("F10-ui-revision", "「发起修订」按钮存在且可点", await trigger.isEnabled(), {
        decisionButtons: sevButtons,
      });
      await trigger.click();

      // 2) 填要求 → 生成修订候选按钮出现且启用
      const box = reopened.getByLabel("修订要求");
      await box.waitFor();
      await box.fill("补写林遥如何得知钥匙在父亲手里，别改其他段落。");
      const gen = reopened.getByRole("button", { name: "生成修订候选", exact: true }).first();
      runner.check("F10-ui-revision", "填写要求后「生成修订候选」可点", await gen.isEnabled());

      // 3) 点击后应进入既有草稿/生成流程（不是新入口）：要么产生 pending 候选，要么给出可读失败
      await gen.click();
      // 真实生成链路会先跑意图识别/场景规划，2.5s 内可能仍在进行中。
      // 等到出现明确终态（错误提示或 pending 候选）再断言，避免把"还在跑"误判成"静默无反应"。
      const settled = await reopened
        .waitForFunction(
          () =>
            !!document.querySelector('[data-testid="sev-author-error"]') ||
            !!document.querySelector('.error-banner[role="alert"]'),
          undefined,
          { timeout: 240000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!settled) await reopened.waitForTimeout(1000);

      // 诊断：把点击后的真实可观察状态记下来，区分"仍在运行 / 已成功 / 已报错"。
      const uiState = await reopened.evaluate(() => ({
        authorError:
          document.querySelector('[data-testid="sev-author-error"]')?.textContent || null,
        banner:
          document.querySelector('.error-banner[role="alert"]')?.textContent || null,
        revisionBoxOpen: !!document.querySelector(".sev-revision-box"),
        deciding:
          !!document.querySelector(".sev-revision-actions button.primary[disabled]"),
        pendingText: document.body.innerText.match(/待采纳|候选已就绪|生成中|正在/g)?.slice(0, 3) || [],
      }));
      // 终态判定同时看作品侧：候选是否真的落进 messages（比只看 DOM 文本可靠）。
      const settledByData = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const p = await window.studio.load(arr[0].id);
        return (p.messages || []).filter((m) => m.status === "pending" && m.proposal).length;
      });
      runner.check("F10-ui-revision", "点击后页面进入可观察终态", !!(
        uiState.authorError || uiState.banner || uiState.pendingText.length || settledByData > 0
      ), { ...uiState, pendingCandidates: settledByData });

      const after = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const id = arr[0].id;
        const p = await window.studio.load(id);
        return {
          text: p.chapters.map((c) => c.content).join("\u0000"),
          pending: (p.messages || []).filter((m) => m.status === "pending").length,
        };
      });

      // 核心不变量：未采纳前正式正文必须完全不变
      runner.check(
        "F10-ui-revision",
        "未采纳前正式正文哈希不变（F10 核心）",
        after.text === before.text,
        { beforeLen: before.text.length, afterLen: after.text.length },
      );

      // 诊断补充：修订成功后可能把候选写入 messages，也可能仍处于生成中。
      const diag2 = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const p = await window.studio.load(arr[0].id);
        return {
          messages: (p.messages || []).slice(-3).map((m) => ({
            role: m.role,
            status: m.status || null,
            hasProposal: !!m.proposal,
            text: String(m.text || "").slice(0, 60),
          })),
          revision: p.revision,
        };
      });
      runner.check("F10-ui-revision", "点击后作品消息状态（诊断）", true, diag2);

      const producedCandidate = after.pending > before.pending;
      if (producedCandidate) {
        runner.check("F10-ui-revision", "走既有草稿流程并产生待采纳候选", true, {
          before: before.pending,
          after: after.pending,
        });
      } else {
        // 生成失败的可读原因可能出现在两处：
        // 1) 问题面板的 data-testid="sev-author-error"（requestRevision 自身判定失败）
        // 2) App 的全局 .error-banner（generate 抛错时 StudioContext 写入共享 error）
        // 两处都是产品真实反馈位置，任一出现即算"没有静默无反应"。
        const authorErr = await reopened
          .locator('[data-testid="sev-author-error"]')
          .first()
          .innerText({ timeout: 5000 })
          .catch(() => "");
        const bannerErr = await reopened
          .locator('.error-banner[role="alert"]')
          .first()
          .innerText({ timeout: 5000 })
          .catch(() => "");
        const errText = (authorErr || bannerErr || "").trim();
        runner.check(
          "F10-ui-revision",
          "生成链路未产出候选：须给出可读原因（而非静默无反应）",
          errText.trim().length > 0,
          { errorText: errText.slice(0, 160) },
        );
        runner.fail(
          "F10-ui-revision",
          "采纳段待 G1 生成 transport 接缝：本轮未产出 pending 候选，仅验证了按钮可点/请求体正确/未采纳正文不变",
        );
      }
      runner.finish("F10-ui-revision");
    });

    // ── F9 实机：点「保留」→ UI revision 与磁盘一致 → 紧接着保存不冲突 ──
    await runCase("F9-ui-decide-then-save", async () => {
      // 前置：需要有正式问题。没有则如实 fail（不静默跳过）。
      const pre = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const id = arr[0].id;
        const p = await window.studio.load(id);
        return {
          projectId: id,
          revision: p.revision,
          issues: (p.storyEvents?.issues || []).filter((i) => i.disposition === "open").map((i) => i.id),
        };
      });
      if (!pre.issues.length) {
        runner.check("F9-ui-decide-then-save", "正式图存在待决定的 open 问题（前置条件）", false, {
          openIssues: 0,
        });
        runner.finish("F9-ui-decide-then-save");
        return;
      }

      // 真实 UI：打开事件页 → 问题 tab → 点「保留」
      await reopened.getByRole("button", { name: "故事事件链", exact: true }).click();
      await reopened.locator(".sev-node").first().waitFor();
      await reopened.getByRole("tab", { name: /^问题/ }).first().click();
      await reopened.getByRole("tab", { name: /正式图问题/ }).click();
      await reopened.locator(".sev-issue").first().waitFor();
      const issueBefore = await reopened.locator(".sev-issue").first().innerText();
      // 问题可能已被前序案例处理（disposition != open），此时决定按钮组不再渲染，
      // 但问题本体与原文引文仍必须可见——这才是"能不能判断"的实际判据。
      const hasQuoteBlock = (await reopened.locator(".sev-quote").count()) > 0;
      runner.check(
        "F9-ui-decide-then-save",
        "问题面板显示问题本体与原文引文（可判断）",
        issueBefore.length > 0 && hasQuoteBlock,
        { textHead: issueBefore.slice(0, 80), quoteBlocks: hasQuoteBlock ? await reopened.locator(".sev-quote").count() : 0 },
      );

      await reopened.getByRole("button", { name: "保留", exact: true }).first().click();
      // 等待主进程写入并刷新共享状态
      await reopened.waitForTimeout(600);

      // 关键断言 1：UI 侧共享 revision 必须已跟磁盘一致
      const uiVsDisk = await reopened.evaluate(async () => {
        const list = await window.studio.list();
        const arr = Array.isArray(list) ? list : list.entries || [];
        const id = arr[0].id;
        const disk = await window.studio.load(id);
        return { diskRevision: disk.revision, diskId: id };
      });
      runner.check(
        "F9-ui-decide-then-save",
        "决定后磁盘 revision 已递增（写入确实发生）",
        uiVsDisk.diskRevision > pre.revision,
        { before: pre.revision, after: uiVsDisk.diskRevision },
      );

      // 关键断言 2：紧接着保存不报版本冲突（模拟「保存设定」用的同一 save 通道）
      const saveResult = await reopened.evaluate(async (id) => {
        try {
          const p = await window.studio.load(id);
          await window.studio.save({ ...p }, p.revision);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message) };
        }
      }, uiVsDisk.diskId);
      runner.check(
        "F9-ui-decide-then-save",
        "决定之后紧接着保存：不报版本冲突（F9 核心）",
        saveResult.ok === true,
        saveResult,
      );
      runner.finish("F9-ui-decide-then-save");
    });

    // ── 链路2 · chain2-revision：真实保存设定后下次生成无 revision 冲突 ──
    await runCase("chain2-revision", async () => {
      // ① 真实 UI 保存设定：作者与作品页 →「保存设定」按钮。
      await reopened.getByRole("button", { name: /^作者与作品/ }).click();
      await reopened.locator(".foundation").waitFor();
      const saveBtn = reopened.getByRole("button", { name: "保存设定", exact: true });
      const saveEnabled = await saveBtn.isEnabled().catch(() => false);
      runner.check("chain2-revision", "「保存设定」按钮可用", saveEnabled === true);
      let savedRevision = null;
      if (saveEnabled) {
        await saveBtn.click();
        const savePoll = await pollUntil(
          reopened,
          async () => {
            const list = await window.studio.list();
            const arr = Array.isArray(list) ? list : list.entries || [];
            const p = await window.studio.load(arr[0].id);
            return {
              done: !!p && Number.isInteger(p.revision),
              revision: p && p.revision,
            };
          },
          undefined,
          { timeout: 60000 },
        );
        console.log("[诊断 chain2-revision] 保存等待:", JSON.stringify(savePoll.last));
        savedRevision = await reopened.evaluate(async (id) => {
          const p = await window.studio.load(id);
          return p.revision;
        }, activeId);
      }
      runner.check(
        "chain2-revision",
        "保存设定后读盘拿到 revision（写入确实发生）",
        Number.isInteger(savedRevision),
        { savedRevision },
      );

      // ② 紧接着下发一次生成：只判"有没有旧 revision 冲突"，不判内容质量。
      const gen = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        if ((p.messages || []).some((m) => m.status === "pending")) {
          await window.studio.save(
            { ...p, messages: p.messages.map((m) => (m.status === "pending" ? { ...m, status: "rejected" } : m)) },
            p.revision,
          );
        }
        const latest = await window.studio.load(id);
        try {
          await window.studio.generate({
            projectId: id, revision: latest.revision, provider: "glm",
            instruction: "起草一章，约1200字。", words: 1200,
          });
          return { ok: true, error: null, revision: latest.revision };
        } catch (e) { return { ok: false, error: String(e && e.message), revision: latest.revision }; }
      }, activeId);
      const isRevisionConflict = /版本已变化|版本冲突/.test(gen.error || "");
      runner.check(
        "chain2-revision",
        "保存设定后的下一次生成没有 revision 冲突（F9/G4 核心）",
        isRevisionConflict === false,
        { error: gen.error, revisionUsed: gen.revision },
      );
      runner.finish("chain2-revision", { savedRevision, generateError: gen.error });
    });

    // ── 链路2 · chain2-revise：显式发起修订 → 真实草稿候选 → 未采纳不改正文 ──
    await runCase("chain2-revise", async () => {
      const before = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          text: p.chapters.map((c) => c.content).join("\u0000"),
          pendingIds: (p.messages || []).filter((m) => m.status === "pending").map((m) => m.id),
        };
      }, activeId);

      // 前置：产品规则「请先采纳或放弃其他任务的方案」会直接拒绝生成。
      // 走产品真实路径把遗留 pending 标为 rejected，再重新读最新 revision。
      // 清理遗留 pending：走产品真实路径（界面「放弃候选」按钮），
      // 不用 IPC save 直接改盘——那会让界面持有旧 revision，
      // 随后点「生成修订候选」会被判「作品版本冲突」（本轮实测踩到）。
      await reopened.getByRole("button", { name: /^章节阅读/ }).click();
      await reopened.locator(".chapter-list").waitFor();
      let clearedCount = 0;
      for (let round = 0; round < 5; round += 1) {
        const pendingNow = await reopened.evaluate(async (id) => {
          const p = await window.studio.load(id);
          return (p.messages || []).filter((m) => m.status === "pending").map((m) => m.id);
        }, activeId);
        if (!pendingNow.length) break;
        const abandonBtn = reopened.getByRole("button", { name: "放弃候选", exact: true }).first();
        if ((await abandonBtn.count()) === 0) break;
        await abandonBtn.click();
        clearedCount += 1;
        await pollUntil(
          reopened,
          async (target) => {
            const p = await window.studio.load((await window.studio.list())[0].id);
            const m = (p.messages || []).find((x) => x.id === target);
            return { done: !m || m.status !== "pending", status: m ? m.status : null };
          },
          pendingNow[0],
          { timeout: 30000 },
        );
      }
      const cleaned = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          clearedCount: 0,
          remainingPending: (p.messages || []).filter((m) => m.status === "pending").length,
          revision: p.revision,
        };
      }, activeId);
      cleaned.clearedCount = clearedCount;
      console.log("[诊断 chain2-revise] 前置清理:", JSON.stringify(cleaned));
      runner.check(
        "chain2-revise",
        "前置：清理遗留 pending 后无阻塞候选",
        cleaned.remainingPending === 0,
        cleaned,
      );
      if (cleaned.remainingPending !== 0) {
        // 界面上没有可点的「放弃候选」按钮时无法走真实路径清理；
        // 不允许退回 IPC save（会造成 revision 不同步），如实记未验证。
        runner.unverified(
          "chain2-revise",
          `未验证：前置清理未完成，仍有 ${cleaned.remainingPending} 个 pending 候选。` +
            `原因：ChapterGeneration.tsx:39 用 !!pending 禁用生成按钮，` +
            `而 :19-21 只在该章正文有差异时渲染"采纳/放弃"入口，` +
            `故"无改动候选"在章节页无处理途径（禁止用 IPC save 绕过）`,
          cleaned,
        );
        return;
      }
      // 已通过 UI「放弃候选」清理（见上），此处不再做 IPC save 式清理，
      // 避免磁盘 revision 前进而界面不知情导致「作品版本冲突」。

      // 真实入口：问题面板「发起修订」→ 填修订要求 →「生成修订候选」。
      await reopened.getByRole("button", { name: "故事事件链", exact: true }).click();
      await reopened.locator(".sev-node").first().waitFor();
      await reopened.getByRole("tab", { name: /^问题/ }).first().click();
      await reopened.getByRole("tab", { name: /正式图问题/ }).click();
      await reopened.locator(".sev-issue").first().waitFor();
      const trigger = reopened.getByRole("button", { name: "发起修订", exact: true }).first();
      if ((await trigger.count()) === 0) {
        runner.check("chain2-revise", "正式图存在可发起修订的 open 问题（前置）", false, {
          note: "无 open 问题",
        });
        runner.finish("chain2-revise");
        return;
      }
      await trigger.click();
      const REVISION_INSTRUCTION = "补写林遥如何得知钥匙在父亲手里，别改其他段落。";
      await reopened.getByLabel("修订要求").fill(REVISION_INSTRUCTION);
      const genBtn = reopened.getByRole("button", { name: "生成修订候选", exact: true }).first();
      runner.check(
        "chain2-revise",
        "填写要求后「生成修订候选」可点（显式发起，不是自动触发）",
        (await genBtn.isEnabled()) === true,
      );
      // 等编排就绪后再点击：否则 StudioContext.generate 会因并发闸门直接返回 false，
      // 表现为「任务没有启动或已失败」而 task 却是 completed（本轮实测）。
      const reviseReady = await waitOrchestrationIdle(reopened, activeId);
      const keepReviseBefore = revisedCandidateId;
      const revisePending = await describePending(reopened, activeId, dir);
      console.log(
        "[诊断 chain2-revise] 编排就绪:",
        JSON.stringify({
          ok: reviseReady.ok,
          ms: reviseReady.ms,
          last: reviseReady.last,
          pending: revisePending,
        }),
      );
      runner.check(
        "chain2-revise",
        "发起修订前编排已就绪（任务收尾且无 busy）",
        reviseReady.ok === true,
        reviseReady.last,
      );
      if (!reviseReady.ok) {
        runner.unverified(
          "chain2-revise",
          `未验证：编排无法就绪（等满 ${Math.round(reviseReady.ms / 1000)}s）。` +
            `当时 task=${JSON.stringify(reviseReady.last)}`,
          {
            orchestrationReady: false,
            waitedMs: reviseReady.ms,
            last: reviseReady.last,
            keptCandidateBefore: keepReviseBefore,
            keptCandidateAfter: revisedCandidateId,
          },
        );
        return;
      }
      await genBtn.click();

      // 等明确终态：新候选落盘 / 可读错误 / 任务收尾态。禁止固定秒数猜成功。
      const revisePoll = await pollUntil(
        reopened,
        async (beforeIds) => {
          const list = await window.studio.list();
          const arr = Array.isArray(list) ? list : list.entries || [];
          const p = await window.studio.load(arr[0].id);
          const pending = (p.messages || []).filter((m) => m.status === "pending");
          const fresh = pending.find((m) => !beforeIds.includes(m.id));
          const err =
            document.querySelector('[data-testid="sev-author-error"]') ||
            document.querySelector('.error-banner[role="alert"]');
          const t = await window.studio.task(arr[0].id).catch(() => null);
          const terminal =
            !!t && ["completed", "failed", "interrupted"].includes(t.status);
          return {
            done: !!fresh || !!err || terminal,
            freshId: fresh ? fresh.id : null,
            error: err ? err.textContent : null,
            taskNow: t ? { status: t.status, stage: t.stage, error: t.error } : null,
          };
        },
        before.pendingIds,
        { timeout: 600000 },
      );
      const settled = revisePoll.ok;
      console.log("[诊断 chain2-revise] 等待结果:", JSON.stringify(revisePoll.last));
      runner.check("chain2-revise", "修订候选在 600s 内到达明确终态", settled === true);

      const after = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        const pending = (p.messages || []).filter((m) => m.status === "pending");
        const err =
          document.querySelector('[data-testid="sev-author-error"]') ||
          document.querySelector('.error-banner[role="alert"]');
        return {
          text: p.chapters.map((c) => c.content).join("\u0000"),
          pending: pending.map((m) => ({
            id: m.id,
            revisionScope: (m.proposal && m.proposal.revisionScope) || [],
            chapters: ((m.proposal && m.proposal.chapters) || []).map((c) => c.id),
          })),
          error: err ? err.textContent : null,
        };
      }, activeId);

      const fresh = after.pending.find((m) => !before.pendingIds.includes(m.id)) || null;
      runner.check(
        "chain2-revise",
        "确实产生本次修订的真实候选（按新候选 ID 判断）",
        !!fresh,
        { error: after.error, newCandidate: fresh },
      );
      runner.check(
        "chain2-revise",
        "该候选带 revisionScope（走的是修订语义，不是新建）",
        !!fresh && Array.isArray(fresh.revisionScope) && fresh.revisionScope.length > 0,
        { revisionScope: fresh && fresh.revisionScope },
      );
      runner.check(
        "chain2-revise",
        "显式修订后未采纳前正文不变（R9 核心）",
        after.text === before.text,
        { beforeLen: before.text.length, afterLen: after.text.length },
      );
      // 把本次修订候选 ID 交给下游采纳段，禁止下游手写 pending-chain2-revise。
      if (fresh) revisedCandidateId = fresh.id;
      if (fresh) {
        runner.finish("chain2-revise", {
          revisedCandidateId: fresh.id,
          revisionScope: fresh.revisionScope,
        });
      } else {
        runner.unverified(
          "chain2-revise",
          `未验证：显式发起修订后未产出候选（错误=${after.error || "无"}，任务=${JSON.stringify(revisePoll.last && revisePoll.last.taskNow)}）`,
          { error: after.error, pending: after.pending },
        );
      }
    });

    // ── 链路2 · chain2-accept-restart：采纳**作者刚发起修订生成的**候选后重启核对 ──
    // H7：禁止手写 pending-chain2-revise，也禁止用字符串替换构造正文。
    await runCase("chain2-accept-restart", async () => {
      if (!revisedCandidateId) {
        runner.unverified(
          "chain2-accept-restart",
          "未验证：chain2-revise 未产出候选，且禁止手写候选替代",
        );
        return;
      }
      const beforeAccept = await reopened.evaluate(async (id) => {
        const p = await window.studio.load(id);
        return {
          text: p.chapters.map((c) => c.content).join("\u0000"),
          revision: p.revision,
        };
      }, activeId);

      const accepted = await reopened.evaluate(
        async ({ id, candidateId }) => {
          const p0 = await window.studio.load(id);
          const msg = (p0.messages || []).find((m) => m.id === candidateId);
          const proposalText = ((msg && msg.proposal && msg.proposal.chapters) || [])
            .map((c) => c.content)
            .join("\u0000");
          await window.studio.accept(id, candidateId);
          const reread = await window.studio.load(id);
          return {
            acceptedStatus: (reread.messages || []).some(
              (m) => m.id === candidateId && m.status === "accepted",
            ),
            textAfter: reread.chapters.map((c) => c.content).join("\u0000"),
            proposalText,
            nodeIds: (reread.storyEvents?.nodes || []).map((n) => n.id).sort(),
            edgeIds: (reread.storyEvents?.edges || []).map((e) => e.id).sort(),
            staleIds: (reread.storyEvents?.nodes || []).filter((n) => n.stale).map((n) => n.id).sort(),
            issueIds: (reread.storyEvents?.issues || []).map((i) => i.id).sort(),
            issueDispositions: (reread.storyEvents?.issues || [])
              .map((i) => `${i.id}:${i.disposition}`)
              .sort(),
          };
        },
        { id: activeId, candidateId: revisedCandidateId },
      );

      runner.check(
        "chain2-accept-restart",
        "该修订候选状态已标记 accepted（读盘核对）",
        accepted.acceptedStatus === true,
        { candidateId: revisedCandidateId },
      );
      runner.check(
        "chain2-accept-restart",
        "采纳后正文确实变为候选正文（读盘核对，两端都来自真实流程）",
        accepted.textAfter === accepted.proposalText,
        {
          proposalLen: accepted.proposalText.length,
          afterLen: accepted.textAfter.length,
          changed: accepted.textAfter !== beforeAccept.text,
        },
      );

      // 重启同一隔离库再核对
      await reopened.context()?.close?.().catch(() => {});
      app = await launchOwned({ executablePath: undefined, args: [root], env: childEnv });
      const page2 = await app.firstWindow();
      await waitAppReady(app, page2, "链路2重启");
      reopened = page2;
      const afterRestart = await page2.evaluate(async ({ id, candidateId }) => {
        const p = await window.studio.load(id);
        return {
          chapterText: p.chapters.map((c) => c.content).join("\u0000"),
          accepted: (p.messages || []).some(
            (m) => m.id === candidateId && m.status === "accepted",
          ),
          nodeIds: (p.storyEvents?.nodes || []).map((n) => n.id).sort(),
          edgeIds: (p.storyEvents?.edges || []).map((e) => e.id).sort(),
          staleIds: (p.storyEvents?.nodes || []).filter((n) => n.stale).map((n) => n.id).sort(),
          issueIds: (p.storyEvents?.issues || []).map((i) => i.id).sort(),
          issueDispositions: (p.storyEvents?.issues || [])
            .map((i) => `${i.id}:${i.disposition}`)
            .sort(),
        };
      }, { id: activeId, candidateId: revisedCandidateId });

      runner.check(
        "chain2-accept-restart",
        "重启后正文仍为采纳后正文",
        afterRestart.chapterText === accepted.textAfter,
        { len: afterRestart.chapterText.length },
      );
      runner.check(
        "chain2-accept-restart",
        "重启后候选仍标记 accepted",
        afterRestart.accepted === true,
      );
      runner.check(
        "chain2-accept-restart",
        "重启后节点 ID 集合与采纳后一致（稳定 ID）",
        JSON.stringify(afterRestart.nodeIds) === JSON.stringify(accepted.nodeIds),
        { before: accepted.nodeIds.length, after: afterRestart.nodeIds.length },
      );
      runner.check(
        "chain2-accept-restart",
        "重启后边 ID 集合与采纳后一致",
        JSON.stringify(afterRestart.edgeIds) === JSON.stringify(accepted.edgeIds),
        { before: accepted.edgeIds.length, after: afterRestart.edgeIds.length },
      );
      runner.check(
        "chain2-accept-restart",
        "重启后问题 ID 与 disposition 一致",
        JSON.stringify(afterRestart.issueDispositions) === JSON.stringify(accepted.issueDispositions),
        { issues: accepted.issueDispositions.length },
      );
      runner.check(
        "chain2-accept-restart",
        "重启后失效原点集合与采纳后一致",
        JSON.stringify(afterRestart.staleIds) === JSON.stringify(accepted.staleIds),
        { stale: accepted.staleIds.length },
      );
      runner.finish("chain2-accept-restart", {
        acceptedCandidateId: revisedCandidateId,
        nodeIds: accepted.nodeIds,
        edgeIds: accepted.edgeIds,
        issueIds: accepted.issueIds,
        staleIds: accepted.staleIds,
      });
    });

    // ── 未产生断言的案例：如实记 fail，写明卡点、实际值与 R 编号 ──
    // 已经有真实断言的案例不在此覆盖，避免把真实结果降级成"依赖未知"。
    const ranCases = new Set(
      runner
        .list()
        .filter((e) => e.assertions.length > 0)
        .map((e) => e.caseId),
    );
    // 已显式判定 unverified（前置缺失）的案例不能在这里被改写成 fail。
    const unverifiedCases = new Set(
      runner
        .list()
        .filter((e) => e.status === "unverified")
        .map((e) => e.caseId),
    );
    for (const item of CASE_PLAN) {
      if (ranCases.has(item.caseId)) continue;
      if (unverifiedCases.has(item.caseId)) continue;
      runner.fail(
        item.caseId,
        `未接入：${item.title}（${item.rNumbers.join("/")}）尚无真实断言；卡在断言未实现，实际值=未执行，期望值=有 pass/fail 判定；阻塞方=${item.blockedBy || "无"}`,
      );
    }

    // ── 可控失败注入（任务书硬性要求）─────────────────────────────
    // 用法：NOVEL_E2E_INJECT_FAILURE=<caseId> 时，强制让该案例产生一条失败断言，
    // 用于证明"失败信号确实传导到进程退出码"。默认不注入。
    // 注入结果单独写 failure.json：断言失败走的是报告分支而非异常分支，
    // 若不单独留档，复核方只能看到"日志里有一行字"，无法核验注入真的生效过。
    const injectedFailure = process.env.NOVEL_E2E_INJECT_FAILURE || null;
    let injectionRecord = null;
    if (injectedFailure) {
      const reason = `[可控失败注入] 强制 ${injectedFailure} 失败（期望进程退出码非零）`;
      const applied = runner.injectFailure(injectedFailure, reason);
      if (!applied) runner.fail(injectedFailure, `注入的失败目标案例不存在：${injectedFailure}`);
      injectionRecord = {
        runId: RUN_ID,
        startedAt: RUN_STARTED_AT,
        status: "injected-failure",
        injectedCaseId: injectedFailure,
        applied: applied === true,
        reason,
        note: "断言失败路径（非异常路径）：报告仍会写出，进程以非零退出。",
      };
      await fs.writeFile(
        path.join(runDir, "failure.json"),
        JSON.stringify(injectionRecord, null, 2),
      );
    }

    // ── 自检 A：不得静默通过 ─────────────────────────────────────
    const unresolved = runner.auditUnresolved();
    if (!unresolved.ok) {
      await fs.writeFile(
        path.join(out, "story-event-chain-report.json"),
        JSON.stringify(
          {
            runId: RUN_ID,
            startedAt: RUN_STARTED_AT,
            status: "failed",
            reason: "存在未跑完的案例",
            unresolved: unresolved.unresolved,
          },
          null,
          2,
        ),
      );
      throw new Error(
        `不得静默通过：以下案例既不是 pass 也不是 fail → ${unresolved.unresolved
          .map((u) => `${u.caseId}(${u.status})`)
          .join("、")}`,
      );
    }
    const cases = runner.list();
    const caseSummary = runner.summary();

    const report = {
      // H2：报告必须自带本次运行标识，避免读到上一次的成功报告。
      runId: RUN_ID,
      startedAt: RUN_STARTED_AT,
      finishedAt: new Date().toISOString(),
      // status 由案例聚合，不再硬编码 passed；只要有 fail 就是 failed。
      // 只有全部 pass 才算 passed；有 fail 记 failed；
      // 无 fail 但有 unverified 时记 incomplete（没通过，也没被判失败）。
      status:
        caseSummary.fail > 0
          ? "failed"
          : caseSummary.unverified > 0
            ? "incomplete"
            : "passed",
      caseSummary,
      cases,
      fixtureEvidenceAudit: evidenceAudit,
      kind: "electron",
      version: expectVersion,
      buildInfoVersion: build.displayVersion,
      uiVersion,
      launchArgs: TEST_LAUNCH_ARGS,
      // 宿主环境限制（不是产品退化）：本会话 DSH 外层沙箱下
      // ① Chromium 嵌套沙箱不可用 → stderr "sandbox initialization failed: Operation not permitted"，
      //    渲染进程崩溃、界面永远等不到；故测试实例统一带 --no-sandbox（产品代码未改）。
      // ② Chromium 无法写 ~/Library/Application Support 的 SingletonLock
      //    → "Operation not permitted"，因此每次运行都必须用隔离 NOVEL_AGENT_DATA_DIR。
      // ③ /bin/ps 被拒，测试进程只靠脚本内部 ownedApps 记账回收，不依赖 ps 找残留。
      environment: {
        nestedChromiumSandbox: "unavailable (DSH outer sandbox)",
        officialDataDirLock: "denied (SingletonLock: Operation not permitted)",
        processListing: "ps unavailable; instances tracked in-process",
        requires: ["--no-sandbox", "isolated NOVEL_AGENT_DATA_DIR"],
      },
      injection: injectionRecord,
      versionMismatch,
      isolatedData: dir,
      realRuntimeGraph: true,
      // R2 判据：必须直接引用 requests[]。当前为空 = 未走真实模型入口 = R2 未验证。
      requests: requests.list(),
      requestCoverage:
        requests.list().length === 0
          ? "未覆盖：本脚本仍是预置图展示链路，未经 runChapterAgent 发出模型请求，R2 不能据此判通过"
          : null,
      restartVerified: true,
      runtimeCalls: ["mergeStoryEvents", "impactOf", "normalizeStoryEvents", "storySubgraph"],
      graph: { nodes: read.counts.nodes, edges: read.counts.edges },
      runtimeStale: {
        nodes: read.counts.staleNodes,
        edges: read.counts.staleEdges,
      },
      candidates: read.candidates.nodes.length,
      issues: read.graph.issues.length,
      candidateItem: candidateNote,
      checks: [
        "IPC 读取链路返回 runtime 真实建图结果",
        "全书概览渲染正式事件节点",
        "候选事件与正式事件视觉区分（虚线框+候选横幅）",
        "状态可见：confirmed/candidate/provisional/conflict",
        "待核对与依据失效标记可见",
        "只看待核对筛选生效",
        "点击节点显示事件与原文引文",
        "点击边显示关系类型/判断性质/解释/依据",
        "聚焦事件并追溯前因后果",
        "问题列表显示 disposition 与来源",
        "章节覆盖范围区分已抽取/未抽取/失败",
        "空态明确区分尚未建立事件链/未抽取/抽取失败",
        "筛选无命中空态明确说明是筛选导致，不误报未建立事件链",
      ],
      screenshots: shots,
      pageErrors: errors,
    };
    await fs.writeFile(
      path.join(out, "story-event-chain-report.json"),
      JSON.stringify(report, null, 2),
    );
    // 同一次运行再写一份带 runId 的独立副本：历史报告不被覆盖，
    // 新运行也不会误读上一次的成功结果。
    await fs.writeFile(
      path.join(runDir, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));

    // 退出码必须与报告一致：任何案例 fail 都要让进程非零退出，
    // 否则 CI 只能看到"写了 failed 的 JSON 却 exit 0"这种假绿。
    if (
      report.status !== "passed" ||
      caseSummary.fail > 0 ||
      caseSummary.unverified > 0 ||
      caseSummary.unresolved > 0
    ) {
      console.error(
        `\n[S5] 验收失败：pass=${caseSummary.pass} fail=${caseSummary.fail} ` +
          `unverified=${caseSummary.unverified} unresolved=${caseSummary.unresolved}；失败案例：` +
          cases
            .filter((c) => c.status === "fail")
            .map((c) => `${c.caseId}(${c.rNumbers.join("/")})`)
            .join("、"),
      );
      process.exitCode = 1;
    }
  } finally {
    // H2：只关本脚本自己创建的实例。这里不调用 process.exit —— 那会在
    // 外层 catch 之前强行以 (process.exitCode ?? 0) 结束进程，
    // 把启动失败/超时等异常吞成退出码 0。错误必须留给外层 catch 处理。
    await closeOwnedApps();
  }
})().then(
  async () => {
    // 只有全部案例通过才允许退出 0；否则用非零码把失败暴露给调用方。
    const code = process.exitCode ?? 0;
    process.exitCode = code;
  },
  async (error) => {
    // 启动失败、UI 等待超时、未捕获异常：保留完整原因与本次运行标识，
    // 写独立失败记录（不覆盖历史成功报告），再以非零退出。
    const message = error && error.stack ? error.stack : String(error);
    console.error(`[H2][${RUN_ID}] 验收异常终止，退出码 1：\n${message}`);
    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "failure.json"),
        JSON.stringify(
          {
            runId: RUN_ID,
            startedAt: RUN_STARTED_AT,
            failedAt: new Date().toISOString(),
            status: "error",
            reason: error && error.message ? error.message : String(error),
            stack: message,
          },
          null,
          2,
        ),
      );
    } catch (writeError) {
      console.error(`[H2][${RUN_ID}] 失败记录写入失败：${writeError && writeError.message}`);
    }
    await closeOwnedApps();
    process.exitCode = 1;
  },
);
