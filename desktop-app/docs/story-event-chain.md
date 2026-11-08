# 跨章节故事事件链

入口为左侧「故事事件链」。用 React Flow 展示小说正文中的事件关系：每个节点是正文里的一处事件，每条线是有类型、有依据、有判断性质的关系。它与「创作日志」不同——日志记录模型执行过程，本视图记录故事内容本身。

## 需求来源

用户要求：事件关系图必须来自同一套事件、关系和证据数据，同时供界面展示与模型使用；不能只把故事记忆卡片按章摆成图，也不能用规划→模型调用→审稿的执行日志替代。明确边界：系统标出原文、缺口和矛盾，提出修订建议，由作者决定是否改稿；本功能发现的问题不得自动触发正文修改，也不得为消除告警自动补写前情。

## 数据契约

`runtime/story-events-schema.mjs` 定义 `storyEvents`，随作品保存：

```js
{
  version: 1,
  nodes: [{ id, chapterId, chapterNumber, chapterTitle, storyTime, narrativeOffset,
            title, summary, kind, actors[], objects[], status, basis,
            evidence: { chapterId, sourceHash, start, end, quote },
            review: { state, note, at }, stale: null | { at, reason, expectedHash } }],
  edges: [{ id, source, target, type, basis, explanation, evidence[], review, stale }],
  coverage: [{ chapterId, status, parts[], extractedAt, model, failure }],
  issues: [{ id, kind, nodeIds[], edgeIds[], explanation, suggestion, disposition }]
}
```

- `kind`：action / decision / discovery / handover / state-change / recall / other。
- `status`：confirmed / candidate / provisional / conflict。
- `basis`（节点）：narration / testimony / document / belief / rumor / author；正文陈述、人物信念、传闻与文件记载不互相取代。
- `type`（关系）：causal / knowledge / state-transfer / recall / foreshadow / payoff / support / contradict / related。
- `basis`（关系）：explicit / inferred / author-confirmed / unverified。
- `review.state`：unreviewed / checked / flagged / author-confirmed。
- `issues.kind`：missing-source / state-break / unsourced-knowledge / conflict / stale-evidence；`disposition`：open / kept / dismissed / author-decided。

事件与关系拆成两张表，一篇故事可以多前因、多分支，不压成单链或树。故事发生顺序由 `storyTime` 与 `narrativeOffset` 分别记录，支持倒叙和后来揭示。

## 稳定身份

`storyEventId` 只由 `chapterId`（章节标识，不是章号）、事件标题与本章内字符区间计算（`runtime/story-events.mjs:23`）。章节改名、章号调整、正文改稿、重新抽取都不改变既有节点的 id，已有连线仍指向同一件事。`storyEdgeId` 由 source、target、type 计算。

同一事件再次抽取时按 `chapterId` 与区间重叠匹配复用原 id（`mergeStoryEvents`），不静默新建重复节点。旧作品没有 `storyEvents` 字段按空图处理，`projectSchema` 中该字段可选。

### 事件身份的最小匹配规则

身份判定不追求通用语义识别，只认下面四条：

- **区间是硬条件**：跨批次复用既有节点，必须先有区间重叠。仅引文相同、位置不同不算同一事件，正文「甲敲门。乙开窗。甲敲门。」里的两次敲门各自成节点。
- **集合比较，不看列举顺序**：`actors` 与 `objects` 用去重排序后的集合比较（`setKey`）。同一次「甲把钥匙交给乙」重抽为「乙接过甲递来的钥匙」、`actors` 从 `['甲','乙']` 变成 `['乙','甲']`，仍是同一 id。`actors` 只是参与者数组，**不承载施事/受事方向**，也不靠「还给/交还/归还」这类方向词表区分事件。
- **同批全等才算重复**：同一批次内只有标题、区间、`actors`、`objects` 全等才判为重复草稿并跳过；同句内两个有证据支持的不同事件（如「甲把钥匙交给乙，乙看过后把钥匙递给甲」）不会被实体或引文相同而覆盖。
- **端点靠 `draftIds`，不靠回查**：`mergeStoryEvents` 返回与输入草稿一一对应的 `draftIds`（被拒的为 `null`）。关系端点直接取 `draftIds[原始序号]`，不再按标题+区间反查——反查正是此前「同句往返只剩后一个节点、关系报端点无效」的来源。

## 出处定位与报因

模型给的 `sourceId` 是可信作用域：存在合法 `sourceId` 时，`locateUnique`（`runtime/story-event-agent.mjs`）只在该 source 对应的 offset 范围内定位与核验引文，不拿到整个分片里去找。显式 span 逐字核验通过就保留模型给的区间，不再被 `indexOf` 首处覆盖。

失败原因分开报，不互相矛盾：「未找到」与「有多个匹配、缺少 span 无法唯一定位」是两种结论，不会同时输出「引文不在原文中」和「歧义」。只有可靠信息仍不能唯一确定时才报歧义；错误引文与错误 span 一律拒绝。

## 证据与失效传播

出处一律由程序按区间从当前正文回填 `sourceHash` 与 `quote`（`eventEvidence`），模型只给区间与引文，不能自造哈希。模型若提交伪造的 `sourceHash` 会被覆盖；引文不在正文中则拒绝入库。

正文改动后，`impactOf` 逐条校验哈希与引文：失效节点标 `stale`（reason 为 source-changed / quote-missing / chapter-missing），并递归列出受影响的下游边与后文引用，同时生成 `stale-evidence` 问题。它只报告，不删除节点、不改正文、不自动补写前情。界面用点状橙线标出失效关系，并在检查器说明失效原因。

引文存在只证明引用位置有效，不证明模型对含义的理解正确，因此关系另记 `basis` 与 `explanation`。

## 关系校验

`validateStoryEdge` 拒绝没有依据的关系：`explicit` 边必须有 explanation 与至少一条当前正文可核的 evidence；推断关系必须显式标 `inferred` 或 `unverified`。仅共享人物、物件或时间先后不构成因果，不自动生成 causal 边。

## 覆盖与缺口

按章记录 `coverage`：extracted / partial / failed / pending，以及实际处理的分片编号。每章都要处理，不允许只挑关键词或用有限条目摘要冒充完整事件链。视图按章显示已抽取、未抽取与失败状态。

上下文受预算限制时会返回 `truncated` 与命中总数，`missNote` 明确写"按预算截断，其余未装入，不能视为已覆盖或不存在"。检索未命中不等于全书不存在。

## 模型工作流接入

- **写作前**：`storyEventContextBlock` 按当前章、人物、物件取相关事件及前后若干层关系，附节点与边 id、覆盖范围和未命中说明，装入场景规划请求（`runtime/chapter-agent.mjs:515`）。模型因此能引用具体事件 id，并区分沿用历史与本章新增。
- **候选完成后**：`extractStoryEvents` 逐章逐分片抽取本章事件与关系，程序回填原文；`checkStoryEvents` 检查缺依据、状态断裂、无来源知情与重复关系。结果以增量补丁写入消息候选，正式作品只在采纳后更新。
- **无来源知情**：`knowledgeClaimsFrom` 从本章正文产生候选 claim（某人物使用或断定某物件，而事件链此前没有该人物获得该物件的记录），交给 `checkStoryEvents` 生成 `unsourced-knowledge`，由作者决定处理方式。
- **改稿后**：`impactOf` 标出受影响的节点、关系与后文引用待复核，不自动重写后文。

界面与模型读的是同一份 `storyEvents`。主进程 `storyEventsView` 只做只读投影（`electron/main.mjs:177`），前端 `useStoryEvents` 只做筛选、分组与选中，不自行判断关系是否有效、节点是否失效。

## 候选与正式作品分离

候选事件保存在消息的 `proposal.storyEvents` 中，采用增量补丁形态（`storyEventsPatchSchema`），复用同一套字段但由程序补齐 id、章号与出处。视图把候选节点用虚线框与横幅标出，并注明来源消息。

采纳时由 Node 侧 `resolveProposalStoryEvents` 合并进正式图（`runtime/story-events-apply.mjs`），`applyProposal` 只校验与写入，不承担合并。放弃候选不写作品，正式图哈希不变。合并逻辑单独成文件是为让 `runtime/schema.mjs` 的依赖树不含 `node:crypto`——该文件会被 renderer 引用，直接依赖会导致 Vite 构建失败。

浏览器预览路径不合并增量补丁，仅透传完整图；预览本身不执行真实生成，正式使用在打包桌面端。

## 作者处理

问题列表显示 kind、关联事件与关系、disposition 与来源，并附关联节点的原文引文。作者可对单个问题选择**保留 / 驳回 / 裁定**，通过 `studio:decide-story-issue` 持久化：只改 `issues[i].disposition`，写入前后比对章节正文，一旦有变化立即报错。未知问题 id、非法决定、作品版本过期都明确报错，不静默写入。作者选择修订后，才进入既有修订与采纳流程（`docs/author-revision-workspace.md`）。

## 历史建图

对已采纳正文建立或补全派生事件图，入口是 `studio:story-build`。建图只写 `storyEvents`，写前比对章节正文，变化即拒绝；`mode=complete` 只补未抽取或未完成的章，不重做已抽取章；重试不会清空已成功结果，作者已作出的 disposition 按 issueId 原样回写。执行入口要求显式 `mode`（`build`/`complete`），否则报错提示改用只读接口。未来章纲与未采纳候选不进入正式历史。

空补全不写版本。`electron/story-build-channel.mjs` 把「算目标」与「跑建图」拆成两个函数：`planStoryBuild` 是纯函数，只根据覆盖记录算待补章；`runStoryBuild` 在待补目标为空时直接返回 `skipped: true, skippedReason: "no-targets"`，**不调模型、不写作品、不动 revision**。前端 `primaryBuildMode` 相应增加 `"none"`，`StoryEvents.tsx` 在没有待补章节时不渲染可执行按钮，避免点出一个必然空跑的动作。`electron/main.mjs` 改走 `runStoryBuild`，空目标不再是「跑一遍再写一版」。

查询进度与"能否建图"走 `studio:story-build-status`：它只读作品、不调用模型、不写盘，与执行入口返回同一套进度结构，界面可复用同一套渲染。

建图的模型通道由主进程按当前供应商配置自行构造，**不要求调用方经 IPC 注入函数**——Electron IPC 本身无法传函数，若把它当作产品前提，真实桌面的按钮将永远不可用。未配置供应商或 API Key 时报可读错误。验收需要在主进程模型接缝注入替身时，用 `NOVEL_E2E_MODEL_STUB` 指向替身文件；该变量**仅在非打包环境生效**，打包产物完全忽略它，加载失败直接抛错而不回落真实网络。

## 验证

自动化测试 438 项通过，0 fail / 0 skip / 0 cancelled（第三轮 412，存量未降）。其中 `tests/story-events.test.mjs` 42 项覆盖稳定 id、改名重排、多前因多分支、无效边拒绝、失效传播、覆盖记录、项目往返、R4 精确证据、R5 同段多事件、R6 改稿保留原点、R3 四操作不删边、knownNodeIds 三条与 disposition 安全化，并含本轮 H1 三反例（同句往返保留两节点与关系、重抽 actors 顺序变化复用 id、同文本两处各自成节点）；`tests/story-event-workflow.test.mjs` 50 项覆盖逐章抽取、上下文装配与预算截断、候选隔离、增量与完整图两种采纳形态、真实入口的无来源知情、R2 跨章端点与请求携带历史事件、R10 数量语义正负例、H3 sourceId 作用域定位与报因区分、H4/H5 同时点与结果态判据，以及 renderer 依赖链不含 `node:crypto`；`tests/story-build-channel.test.mjs` 24 项覆盖建图通道契约与 H6 空目标不写版本。

`scripts/verify-story-events.cjs` 通过真实 Electron IPC 驱动隔离作品，覆盖任务书十个回归案例、两个附加案例与两条真实产品链路的 28 个案例步骤。任一必需案例失败或未执行时进程退出码非零；启动失败与其他未捕获异常同样非零退出并保留原因（`finally` 只设 `process.exitCode`，不再抢先 `process.exit`）。脚本拆为主入口、`verify-story-events.fixtures.cjs`（隔离夹具、请求记录器、偏移自检）与 `verify-story-events.assert.cjs`（断言运行器，拒绝空跑与恒真）三部分。每次运行有唯一 `RUN_ID`，报告写进 `runs/<runId>/`，不会误读上一次的成功报告。故障注入有两个入口：`NOVEL_E2E_INJECT_LAUNCH_FAILURE=1` 让首次 Electron launch 故意失败，`NOVEL_E2E_INJECT_FAILURE=<caseId>` 让指定案例强制断言失败，两者都必须得到非零退出。

两条链路的验收方式：建图点**真实按钮**而非直调 `window.studio.storyBuild`，并在**同一会话**校验当前画布与共享 revision；候选断言**绑定本次生成的候选 ID**，核对具体节点、边、问题与证据内容，而不是只看字段存在或正式图有边；等待用 `pollUntil` / `waitOrchestrationIdle` 直到明确终态，不用固定延时、也不以「等失败提示超时」猜成功；**禁止**手写 pending 或 helper 替代真实失败入口。前置条件缺失致使某案例无法真实执行时，`verify-story-events.assert.cjs` 显式标 `unverified` 并写入阻塞原因，该结论不会被兜底逻辑改写成 pass 或 fail，整体状态为 `incomplete`——`incomplete` 不是通过。请求记录器实测捕获到 case-02 的抽取请求携带第一章事件 id 与原文（`hasHistoricalEventIds: true`）。重启验证在同一数据目录关窗重开，比对节点、边与 disposition 全量一致。报告与 11 张截图在 `verification/story-event-chain/`。

本轮最终报告为 `status: incomplete`、`pass=25 fail=0 unverified=3`（`chain1-accept`、`chain2-revise`、`chain2-accept-restart`），阻塞原因是章节页的候选死锁：`src/features/ChapterGeneration.tsx:39` 用 `!!pending` 禁用生成按钮，而 `:19-21` 只在该章正文有差异时渲染「采纳/放弃」入口，于是「无改动候选」在章节页没有处理途径。该缺陷在产品侧，不在验收脚本；脚本按设计拒绝绕过。

state-break 只保留客观判据：同一物件的两条事件都给出数量词且数量不同才报告。早期实现用"标题不同 + 都是 state-change"判定互斥，会把正常叙事里的两次状态变化误报成矛盾，已删除该判据并补负向用例。代价是没有数量词的状态矛盾（如门开与门关）不再被规则层捕捉，交由专项审稿与作者判断，遵循宁可少报不可乱报。

### 同一时点的判据

数量矛盾是否成立，取决于两条事件是否真的发生在同一时点。判据分三层：

- **任意非空相同字符串不等于同时点**。两条事件 `storyTime` 都是「未知」「不详」「待定」这类未知值（`UNKNOWN_TIME`），不构成同时点——「桌上有十个苹果。他吃了一个，剩下九个。」不会因为两边都写「未知」就报矛盾。
- **宽泛时段不构成同时点**。「午饭时」这类时段内可以发生连续动作，同样不报。
- **只有原文明确写明并存线索才算同时点**（`SIMULTANEOUS_TIME`：同一时刻 / 同时 / 与此同时 / 同一瞬间 / 此刻同时），此时同刻互斥数量必须形成待核对项。

### 结果态不等于过程动作

「剩」「只剩」是结果态，不能单独用来豁免数量矛盾。豁免必须由真实过程动作提供（`PROCESS_ACTION`）：「舱里有十个苹果。舱里剩九个苹果。」会报 pending 问题；「舱里有十个苹果。他吃了一个，舱里剩九个苹果。」才豁免。此前 `statesResult(own)` 单独成立即可豁免，导致「同一时刻还剩十个 / 同一时刻只剩九个」这种原文已明确同刻、却没有消费或转移过程的场景被静默放过。

真实作品《那个不曾存在的岛》10 章仅作只读观察，取证记录在 `verification/story-event-chain/研究记录.md`，含第四章回忆指向第二章放信号枪、罐头数量链条、怀表状态冲突等原文与偏移。

**验证边界**：模型响应全部来自注入的桩（`NOVEL_E2E_MODEL_STUB`），`requests` 记录证明的是"请求确实携带了历史事件 id 与原文"，不等于真实 GLM/MiniMax 理解并使用了这些材料；本阶段未调用任何真实供应商。回归案例在 `mkdtemp` 隔离作品库中运行，正式十章作品未建图（刻意只读保护）。本轮端到端状态为 `incomplete`（`chain1-accept`、`chain2-revise`、`chain2-accept-restart` 三项阻塞于章节页候选死锁，见「验证」节），第一阶段未通过验收。`knowledgeClaimsFrom` 为动词白名单启发式，存在漏报可能；state-break 只认"同一物件 + 双方都有数量词 + 数量不同"，无数量词的状态矛盾交专项审稿。`runtime/providers.mjs` 的 `fetcher` 与 `runtime/provider-stream.mjs` 的 `reader.read()` 仍是无上限等待，本轮在 `runtime/structured-step.mjs`（30 分钟）与 `runtime/chapter-agent.mjs`（检索 120 秒）加了保护，但底层 embedding 偶发不返回的机制与供应商无响应的成因均未验证，**不**声称已修复现场卡死根因。深色主题与色弱对比度未做正式测量，仅以形状、线型与文字保证不只靠颜色表意。测试通过不等于事件抽取完整或全书没有逻辑漏洞。

## 交付

在 `desktop-app` 执行 `npm run pack` 生成，构建钩子自动递增 patch 并写入 `build-info.json`；完整版本号以 `build-info.json` 的 `displayVersion` 为准，同时显示在界面左下方、关于窗口与包内 `Info.plist`。构建含 5 个新增运行时模块、1 个验收脚本与本文档，未打包 `.env`。

操作方式：左侧「故事事件链」→ 顶部按章节/类型/状态筛选，或用「只看待核对」「只看依据失效」；点节点看事件与原文，点线看关系依据；选中事件后按「前因 / 后果 / 双向」与展开层数追溯，再点「全图定位」取消聚焦。右侧「详情 / 问题 / 覆盖」切换查看事件详情、待作者决定的问题与逐章抽取覆盖。

写作链路：先在「创作对话」生成章节候选并采纳，再对已采纳正文整理事件链；候选阶段本章事件增量只在图上以候选样式预览，采纳后才进入正式图。
