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

身份判定不追求通用语义识别。第五轮返修把「哪份草稿占用哪个历史节点」从按遍历顺序先到先得，改为**先取独立快照、再做全局一对一裁定**：

- **快照独立，不共享引用**：`prepareDraft` 先预筛合法草稿，`historyNodes` 取深拷贝快照后才开始匹配。此前 `historyNodes = [...nodes]` 只浅拷贝了数组，元素仍是同一批对象，前一草稿的 `Object.assign` 会改写后续草稿的匹配依据，数组顺序因此成了身份。
- **全局一对一裁定**：`assignHistoryNodes` 对「全部合法草稿 × 全部历史节点」计算 `matchScore`，按分数降序统一裁定归属，一个历史节点最多被一份草稿占用；未获归属的草稿一律新建，不会被就近塞进别人的节点。
- **同分用草稿签名破平局**：分数相同时按 `draftSignature` 决定，不依赖输入顺序。同一批候选换顺序提交，得到的身份仍然一致。
- **同批重复先归并，再分配身份（第六轮 J1）**：`assignHistoryNodes` 在裁定前先用 `duplicateDraft` 把本批等价草稿归为一组，**只有组内首条**进入「草稿 × 历史节点」的配对（`runtime/story-events.mjs:536-541`），:`542-560` 再做全局一对一裁定。此前去重发生在身份分配之后，两份相同的 A 草稿会分别占走历史 A、B 两个身份，随后 `best ?? twin` 让 `best` 优先，把 B 改写成第二份 A，输出成为「交出→交出」。归并顺序是修复要点，不是实现细节。
- **重复项仍落到同一节点**：未参与裁定的重复草稿在落点循环里按 `duplicateDraft` 在 `batchNodeIds` 中找到 twin 并复用同一 id，因此 `draftIds` 与输入草稿严格一一对应：重复项映射同一事件 id、被拒项为 `null`、其余为新建或复用的 id（`runtime/story-events.mjs:605` null、`:640` 复用、`:662` 新建）。去重不会压缩数组，后续关系按原始序号取值不会错位。

在此之上，匹配本身只认下面四条：

- **区间是硬条件**：跨批次复用既有节点，必须先有区间重叠。仅引文相同、位置不同不算同一事件，正文「甲敲门。乙开窗。甲敲门。」里的两次敲门各自成节点。
- **集合比较，不看列举顺序**：`actors` 与 `objects` 用去重排序后的集合比较（`setKey`）。同一次「甲把钥匙交给乙」重抽为「乙接过甲递来的钥匙」、`actors` 从 `['甲','乙']` 变成 `['乙','甲']`，仍是同一 id。`actors` 只是参与者数组，**不承载施事/受事方向**，也不靠「还给/交还/归还」这类方向词表区分事件。
- **同批全等才算重复**：同一批次内只有标题、区间、`actors`、`objects` 全等才判为重复草稿（`duplicateDraft`，`runtime/story-events.mjs:199`）；同句内两个有证据支持的不同事件（如「甲把钥匙交给乙，乙看过后把钥匙递给甲」）不会被实体或引文相同而覆盖。该判据在第六轮被提前到历史身份裁定之前使用，语义不变、顺序改变。
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

自动化测试 464 项通过，0 fail / 0 skip / 0 cancelled（第七轮实测 `npm test` → `# tests 464 / # pass 464 / # fail 0 / # skipped 0`，exit 0；第六轮为 451，本轮净增 13，全部落在 `tests/story-event-acceptance.test.mjs`：13 → 26）。分文件：`tests/story-events.test.mjs` 43、`tests/story-event-workflow.test.mjs` 55、`tests/story-build-channel.test.mjs` 24、`tests/story-event-acceptance.test.mjs` 26（定向四文件合计 135 → 148，exit 0）。定向 `tests/story-event-acceptance.test.mjs` 单独运行为 26 pass / 0 fail，exit 0。

`tests/story-events.test.mjs` 覆盖稳定 id、改名重排、多前因多分支、无效边拒绝、失效传播、覆盖记录、项目往返、R4 精确证据、R5 同段多事件、R6 改稿保留原点、R3 四操作不删边、knownNodeIds 三条与 disposition 安全化，并含第五轮 H1-A/H1-B/H1-C 与第六轮 H1-D（同批重复草稿先去重再分配历史身份：递回不被改写、`draftIds=[A,A,null]`、旧边端点不变）。`tests/story-event-workflow.test.mjs` 覆盖逐章抽取、上下文装配与预算截断、候选隔离、增量与完整图两种采纳形态、真实入口的无来源知情、R2 跨章端点与请求携带历史事件、R10 数量语义正负例、H3 sourceId 作用域定位与报因区分、H4/H5 同时点与结果态判据、renderer 依赖链不含 `node:crypto`，以及第五轮 I1-1/I1-2/I1-3 与第六轮 I1-4（重抽只返回重复稿时递回保留原 ID、旧边不换指）、I1-5（含重复草稿时关系按原始序号指向真实事件）的事件身份回归。`tests/story-build-channel.test.mjs` 24 项覆盖建图通道契约与 H6 空目标不写版本。`tests/story-event-acceptance.test.mjs` 13 项对**同一个** `evaluateAcceptance` 入口做正负例：正常结果通过，只更新正文/`accepted` 丢候选图、单丢本次跨章边、单丢本次问题、链路 B 作者决定被重置、应失效原点未失效、`sourceHash` 单钉不一致分别必须失败。

`scripts/verify-story-events.cjs` 通过真实 Electron IPC 驱动隔离作品，覆盖任务书十个回归案例、两个附加案例与两条真实产品链路的 28 个案例步骤。任一必需案例失败或未执行时进程退出码非零；启动失败与其他未捕获异常同样非零退出并保留原因（`finally` 只设 `process.exitCode`，不再抢先 `process.exit`）。脚本拆为主入口、`verify-story-events.fixtures.cjs`（隔离夹具、请求记录器、偏移自检）与 `verify-story-events.assert.cjs`（断言运行器，拒绝空跑与恒真）三部分。每次运行有唯一 `RUN_ID`，报告写进 `runs/<runId>/`，不会误读上一次的成功报告。故障注入有两个入口：`NOVEL_E2E_INJECT_LAUNCH_FAILURE=1` 让首次 Electron launch 故意失败，`NOVEL_E2E_INJECT_FAILURE=<caseId>` 让指定案例强制断言失败，两者都必须得到非零退出。

第六轮把采纳结果的核对收敛为单一断言入口 `evaluateAcceptance`（`scripts/verify-story-events.assert.cjs:259-706`，导出 `:709-716`），由 `verify-story-events.cjs:20` require、在 `:3504`（链路 A 采纳）、`:3634`（链路 A 重启）、`:4791`（链路 B 采纳）、`:4907`（链路 B 重启）四处调用，`:600-612` 的 `applyAcceptance` 把入口结论并入 runner，失败时保留每条判据明细。预期来自**采纳前**固定的候选最终正文/事件/关系/问题、历史图与作者决定快照，不用采纳后图倒推，也不调用被测生产合并函数生成「正确答案」。本 run 实测判据数：`chain1-accept` 45、`chain1-restart` 90、`chain2-accept` 75、`chain2-restart` 150，失败均为 0。

两条链路的验收方式：建图点**真实按钮**而非直调 `window.studio.storyBuild`，并在**同一会话**校验当前画布与共享 revision；候选断言**绑定本次生成的候选 ID**，核对具体节点、边、问题与证据内容，而不是只看字段存在或正式图有边；等待用 `pollUntil` / `waitOrchestrationIdle` 直到明确终态，不用固定延时、也不以「等失败提示超时」猜成功；**禁止**手写 pending 或 helper 替代真实失败入口。前置条件缺失致使某案例无法真实执行时，`verify-story-events.assert.cjs` 显式标 `unverified` 并写入阻塞原因，该结论不会被兜底逻辑改写成 pass 或 fail，整体状态为 `incomplete`——`incomplete` 不是通过。请求记录器实测捕获到 case-02 的抽取请求携带第一章事件 id 与原文（`hasHistoricalEventIds: true`）。重启验证在同一数据目录关窗重开，比对节点、边与 disposition 全量一致。第六轮起截图与聚合报告写入 `verification/story-event-chain/round6/e2e/`；该目录根级文件现已与通过口径同源（runId `2026-11-09T06-43-21-893Z-29633-a000b5`，`status: passed`，28/28，`versionMismatch: null`，`pageErrors: []`），判据仍以各 runId 目录内的 `report.json` 与 judgement 文件为准。

第五轮把两条链路进一步改为**只走真实界面**，并修正了链路 A 的案例顺序：

- **链路 A（I2）**：执行顺序由「生成→预览→再生成/采纳→放弃」改为「生成 A→预览 A→放弃 A→读盘确认→生成 B→预览 B→采纳 B→重启」，`chain1-abandon` 前移到 `chain1-accept` 之前，`CASE_PLAN` 同步改写。新增 `focusChapterCandidate` / `clickCandidateAction`（按 `#candidate-<id>` 绑定具体候选）与 `waitFreshCandidate`（三态终态）、`ensureFormalHistory`。实测：候选 A 经「章节阅读」→「放弃候选」放弃，`revision` 3→4；随后生成候选 B 并经「采纳本章与记忆」采纳；A≠B 断言通过。
- **链路 B（I3）**：删除全部绕行——`chain2-revision` 不再用 `window.studio.load` 取 revision 后直调 `generate`、也不再在脚本里把 pending 标成 `rejected`；`F10` 的 IPC save 清理同样删除。链路 A/B 内已无 `generate` / `accept` / `save` 直调（读盘核对仍用 `load`）。新增 `blockedContext`（现场取证）、`ensureNoPendingViaUi`（按 ID 走界面放弃）、`decideIssueByUi`（按界面序号 + 完整文本逐字校验定位，不唯一则拒点）。链路 B 另用独立隔离库，章节 ID 与复用 `storyEvents` 对齐为 ch1–ch4，避免前序案例耗尽空白章与 open 问题导致的假 `unverified`。

第四轮最终报告为 `status: incomplete`、`pass=25 fail=0 unverified=3`（`chain1-accept`、`chain2-revise`、`chain2-accept-restart`），当时归因为「章节页候选死锁、缺陷在产品侧」。**该归因是误诊，本轮已更正**：真实根因是**验收脚本自身的执行顺序**——`chain1-accept` 排在 `chain1-abandon` 之前，脚本注释所称「上一轮候选已放弃」在执行时其实尚未发生，且 `chain1-accept` 内用 `keepId` 保护旧候选不清除，旧 pending 因此合理阻止了再生成。这属验收脚本缺陷（I2），已修。

界面侧的真实情况是**分流，不是死锁**：章节页对「无差异候选」不渲染处理入口（`src/features/ChapterGeneration.tsx:19-21` 的 `candidate` 要求候选含本章且正文有差异），无差异时只给文字指引「请先在创作对话处理上一份候选」（`:70`）；但**任意 pending 候选在创作对话都有真实入口**——`src/features/Chat.tsx:145` 仅以 `message.status === "pending"` 为条件，`:147-154` 渲染「采纳到作品」、`:155-169` 渲染「放弃」，且 `:42` 的 `stale` 只禁用采纳，放弃按钮只受 `busy` 约束，**始终可放弃**。因此「章节页无入口」不能推出「产品死锁」。

第五轮修正执行顺序后，同一套脚本实测 `status: passed`、`pass=28 fail=0 unverified=0`。产品侧是否仍存在其他缺陷：**未验证**——既未确认仍有缺陷，也未证明无缺陷。

第七轮（K1、K2）把采纳核对的判据收紧到三处契约上，均为验收判据变化，不改产品行为：

- **必需增量四处一致**：A/B 链路的采纳后与重启后四处 `evaluateAcceptance` 调用都启用 `requireIncrements`，标志写入 `chain1AcceptInput` / `chain2AcceptInput` 并随展开继承，重启用同一套要求复核。采纳前材料必须含本次实际被采纳候选（链路 A 用候选 B，不用已放弃的 A）的事件、至少一条跨章关系与至少一条本次问题；候选边或问题为空数组时直接判失败，不再静默通过。该要求只针对刻意包含跨章关系与问题的验收夹具，产品中合法的零问题结果不受影响。
- **跨章必须按解析后 `chapterId` 判定**：关系端点按既有候选→正式 ID 映射解析后，两端都要能在正式图找到，且**两端 `chapterId` 不同**；「一端历史事件、一端本次候选事件」作为附加条件保留。仅 ID 不同、标题不同或历史/新增身份不同都不构成跨章。判据 detail 同时给出 `sourceChapterId` / `targetChapterId` 与未通过的同章边，供独立核验直接读取。
- **旧证据失效只认「本次产生」，历史关系须保留并核对**：只有「按采纳前正文校验有效、按候选最终正文校验失效」才计入本次产生；原来已 stale 的节点可保留核对，但不得充作本次变化。历史关系不由本次候选重新定义，须核对 ID、source/target/type/basis/explanation 与原证据 chapterId/start/end/quote/sourceHash 全部保留、端点仍在；其失效严格按 `impactOf` 契约判定——自身证据失效时取**第一份实际失效**证据的 reason 与原 `sourceHash`，仅端点失效时 reason 为 `source-changed` 且 `expectedHash` 取 `edge.evidence[0]?.sourceHash ?? ""`，证据与两端都有效时必须为 `null`。`stale.at` 时间戳不参与比对，也不把所有可达下游一律判失效。同库重启后复核同一组原点、关系与对照项。

state-break 只保留客观判据：同一物件的两条事件都给出数量词且数量不同才报告。早期实现用"标题不同 + 都是 state-change"判定互斥，会把正常叙事里的两次状态变化误报成矛盾，已删除该判据并补负向用例。代价是没有数量词的状态矛盾（如门开与门关）不再被规则层捕捉，交由专项审稿与作者判断，遵循宁可少报不可乱报。

### 同一时点的判据

数量矛盾是否成立，取决于两条事件是否真的发生在同一时点。判据分三层：

- **任意非空相同字符串不等于同时点**。两条事件 `storyTime` 都是「未知」「不详」「待定」这类未知值（`UNKNOWN_TIME`），不构成同时点——「桌上有十个苹果。他吃了一个，剩下九个。」不会因为两边都写「未知」就报矛盾。
- **宽泛时段不构成同时点**。「午饭时」这类时段内可以发生连续动作，同样不报。
- **只有原文明确写明并存线索才算同时点**（`SIMULTANEOUS_TIME`：同一时刻 / 同时 / 与此同时 / 同一瞬间 / 此刻同时），此时同刻互斥数量必须形成待核对项。

### 结果态不等于过程动作

「剩」「只剩」是结果态，不能单独用来豁免数量矛盾。豁免必须由真实过程动作提供（`PROCESS_ACTION`）：「舱里有十个苹果。舱里剩九个苹果。」会报 pending 问题；「舱里有十个苹果。他吃了一个，舱里剩九个苹果。」才豁免。此前 `statesResult(own)` 单独成立即可豁免，导致「同一时刻还剩十个 / 同一时刻只剩九个」这种原文已明确同刻、却没有消费或转移过程的场景被静默放过。

真实作品《那个不曾存在的岛》10 章仅作只读观察，取证记录在 `verification/story-event-chain/研究记录.md`，含第四章回忆指向第二章放信号枪、罐头数量链条、怀表状态冲突等原文与偏移。

**验证边界**：模型响应全部来自注入的桩（`NOVEL_E2E_MODEL_STUB`），脚本强制 `NOVEL_E2E_NO_NETWORK=1` 并在隔离库中清除真实密钥，`requests` 记录证明的是"请求确实携带了历史事件 id 与原文"，不等于真实 GLM/MiniMax 理解并使用了这些材料；本阶段未调用任何真实供应商。回归案例在 `mkdtemp` 隔离作品库中运行，正式十章作品未建图（刻意只读保护），`project.json` 前后 SHA-256 均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。第四轮端到端为 `incomplete`，其归因（章节页候选死锁）已按上文更正为验收脚本执行顺序问题；第五轮修正后为 `passed`、`pass=28 fail=0`（报告 `verification/story-event-chain/round5/e2e/runs/2026-11-09T02-55-14-367Z-93369-6689eb/report.json`）；**第六轮最终整体验收为 `status: "passed"`、`caseSummary { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`、`versionMismatch: null`、`pageErrors: []`**，`round6/e2e/` 根级聚合报告与 11 张截图现已与通过口径同源，runId `2026-11-09T06-43-21-893Z-29633-a000b5`（报告 `verification/story-event-chain/round6/e2e/runs/2026-11-09T06-43-21-893Z-29633-a000b5/report.json`，`buildInfoVersion` `0.1.181+20261109.142212.073.8ec118fa8a38`；四份 judgement 判据 45/90/75/150，失败均为 0）。此前整体通过 run `2026-11-09T06-27-45-158Z-21171-430071` 亦为 28/28、`versionMismatch: null`，两次通过互为对照。

第六轮证据目录有一处历史事故与一处不可还原需如实说明。**（a）最终状态**：`round6/e2e/` 根级聚合报告与 11 张截图现已与通过口径同源，runId `2026-11-09T06-43-21-893Z-29633-a000b5`，`status: passed`，28/28，`versionMismatch: null`，`pageErrors: []`。**（b）历史事故（保留，不删）**：中间曾有一次误触发运行 `2026-11-09T06-33-53-040Z-24965-c7d31e`（`status: failed`、`pass=23 fail=4 unverified=1`，唯一直接原因为链路 B 阶段 `page.evaluate: Target page, context or browser has been closed`，并连带 `chain2-revise` 未产出候选而 `unverified`）覆盖过根级文件；该失败 run 目录已原样保留，可作为过程证据查阅。**（c）认读规则**：通过与否以各 `runs/<runId>/report.json` 与 judgement 文件为准——`06-27-45-158Z-21171-430071` 与 `06-43-21-893Z-29633-a000b5` 两次为通过，`06-33-53-040Z-24965-c7d31e` 为过程失败，不得计入通过。另一处不可还原：第五轮 `round5/e2e/` 根级 11 张截图与聚合报告已在第六轮被覆盖、无 git 记录亦无副本、不可还原，覆盖物已移入 `round6/e2e/overwritten-round5-root/`，第五轮原始 8 个 runId 目录未受影响。`round6/e2e/runs/2026-11-09T06-10-50-052Z-9189-cba041` 是过程失败（误删 `const root` 导致 `ReferenceError`），原样保留，不计为通过。

`knowledgeClaimsFrom` 为动词白名单启发式，存在漏报可能；state-break 只认"同一物件 + 双方都有数量词 + 数量不同"，无数量词的状态矛盾交专项审稿。`runtime/providers.mjs` 的 `fetcher` 与 `runtime/provider-stream.mjs` 的 `reader.read()` 仍是无上限等待；第四轮曾加的两处保护——`runtime/structured-step.mjs` 的 30 分钟模型调用上限与 `runtime/chapter-agent.mjs` 的 120 秒检索等待——**已于第五轮全部撤出**（连同 `tests/chapter-retrieval-stall.test.mjs`、`tests/structured-call-stall.test.mjs` 共 6 项测试删除），撤出后两文件内容与第三轮 `01ac52e` 逐字节相同。因此当前没有任何超时兜底，底层 embedding 偶发不返回的机制与供应商无响应的成因均未验证，**不**声称已修复现场卡死根因。深色主题与色弱对比度未做正式测量，仅以形状、线型与文字保证不只靠颜色表意。测试通过不等于事件抽取完整或全书没有逻辑漏洞。

第六轮的其余未验证项：「关于」窗口未单独定位点击实测（报告 `aboutPanelVerified` 为空），界面版本证据来自主窗口与打包产物空态窗口的实测文本；用户当前已运行的桌面进程是否已升级到本轮版本未验证，未强制结束任何用户进程；J1「修复前失败」的原始日志未归档进仓库，仅由工部以隔离副本自证、大理寺卿另以隔离副本复核，成员自报部分标未验证。

## 交付

在 `desktop-app` 执行 `npm run pack` 生成，构建钩子自动递增 patch 并写入 `build-info.json`；完整版本号以 `build-info.json` 的 `displayVersion` 为准，同时显示在界面左下方、关于窗口与包内 `Info.plist`。构建含 5 个新增运行时模块、1 个验收脚本与本文档，未打包 `.env`。

第六轮交付版本为 `0.1.181+20261109.142212.073.8ec118fa8a38`（`sourceHash` `8ec118fa8a38`，`builtAtLabel` 2026-11-09 14:22:12 北京时间，`package.json` version `0.1.181`），包路径 `desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。三处版本一致已核对：工作区 `build-info.json`、包内 `app.asar` 的 `build-info.json`（逐字节相同，SHA-256 `a343b72171f2…f278`）、打包产物界面实测文本（主窗口与空态窗口；包内 `Info.plist` `CFBundleShortVersionString=0.1.181`）。版本号由构建钩子生成，未手工写死。

操作方式：左侧「故事事件链」→ 顶部按章节/类型/状态筛选，或用「只看待核对」「只看依据失效」；点节点看事件与原文，点线看关系依据；选中事件后按「前因 / 后果 / 双向」与展开层数追溯，再点「全图定位」取消聚焦。右侧「详情 / 问题 / 覆盖」切换查看事件详情、待作者决定的问题与逐章抽取覆盖。

写作链路：先在「创作对话」生成章节候选并采纳，再对已采纳正文整理事件链；候选阶段本章事件增量只在图上以候选样式预览，采纳后才进入正式图。

## 第八轮记录（2026-11-09）

> 本节只追加，不改上文第四至第七轮陈述。本轮修两处**验收/交付链路**缺陷：L1 历史关系证据 `sourceHash` 漏检，L2 最终源码指纹与交付版本不一致。未改 `runtime`、`electron`、`src` 业务文件，未改 `evaluateAcceptance` 签名，未放宽任何既有断言。

**L1：历史关系的 `sourceHash` 必须逐份比对。** 第七轮 `originEdge.<id>.preserved` 只做了 `evidenceListKey`（`chapterId|start|end|quote`）比对，另加一句 `typeof sourceHash === "string"`，两条合起来从未证明 `sourceHash` 等于采纳前原值，单独替换该字段仍判通过，属**假绿**。本轮在 `scripts/verify-story-events.assert.cjs:225-236` 新增局部专用 `historicalEvidenceListKey`（`chapterId/start/end/quote/sourceHash` 全量映射，数量与顺序天然一致），并在 `:793/:794/:795` 组成三层比较。共用 `evidenceListKey`（`:220-223`）**语义未动**——候选材料本就不带 `sourceHash`，纳入共用函数会让合法候选材料误报。期望值取采纳前 `beforeFacts.edges` 的原值，不重算新正文哈希；该写法与同文件 `:733-741` 历史节点 `origin.<id>.evidence` 同款。

**L2：证据输出路径隔离到 round8。** `scripts/verify-story-events.cjs:31-32`（runs 目录）与 `:615-616`（截图与汇总目录）由 round7 改为 round8，仅路径与注释，业务流程、失败处理与断言未动。

**正负例与 TDD 时序。** `tests/story-event-acceptance.test.mjs` 由 26 项增至 30 项：`:738-767` 夹具（历史边 `see-c1-c2-key` 带真实 `sourceHash`，`staleEvidencedEdge` 按 `impactOf` 契约标 `source-changed` 且 `expectedHash` 取原值）、`:769` 采纳 + 同库重启正例、`:785` after 负例、`:809` restart 负例（并断言 `after.*` 无失败）、`:835` 候选证据无 `sourceHash` 正例。先跑用例得 RED：16:25:53 `tests 30 / pass 28 / fail 2`、exit 1，失败断言为 `true !== false`，即修复前仍判通过；`assert.cjs` 于 16:27:00 落盘后，16:27:12 重跑得 GREEN `tests 30 / pass 30 / fail 0`、exit 0。RED 早于修复落盘的 mtime 可核。反例前后对照：`/tmp/review-round8-k2-sourcehash.mjs` 修改前 `mutatedOk=true`、`failures=[]`、exit 0；修改后 `mutatedOk=false`、exit 1，由末行断言主动抛出。大理寺卿独立脚本四条对照精确命中——仅 `after.B.originEdge.see-c1-c2-related.preserved` 与 `restart.B.originEdge.see-c1-c2-related.preserved` 转红，`stale` 仍绿，说明失败来自目标判据而非他项兜底。

**测试与版本。** `npm test` 468 pass / 0 fail（468 = 438 存量 + 30 本文件，本轮新增 4 条 L1），`tsc --noEmit` 与 `git diff --check` 均 exit 0。最终 `displayVersion` 为 `0.1.185+20261109.164106.316.ae4a146c6c8c`，`sourceHash` `ae4a146c6c8c` 按 `stamp-version.mjs` 相同范围与排序对 149 个文件只读重算一致；工作区 `build-info.json`、工作区 `package.json`、包内 `app.asar` 的 `build-info.json`、包内 `Info.plist`、release version 五方均为 `0.1.185`。包路径 `desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。

**桌面验收：两个 runId 并存，只认一个通过。** 通过 run 为 `2026-11-09T08-41-26-407Z-99069-5efe2f`：`status: "passed"`、`caseSummary { total: 28, pass: 28, fail: 0 }`、`versionMismatch: null`、`pageErrors: []`、`restartVerified: true`、`injection: null`，`buildInfoVersion` 与 `uiVersion` 同为 `0.1.185+…ae4a146c6c8c`；四份 judgement 判据 53/104/93/184，失败均为 0。报告 `verification/story-event-chain/round8/e2e/story-event-chain-report.json`。

污染 run `2026-11-09T08-35-09-924Z-95644-93aa40` 同样 `status: "passed"`，但**不计入通过**，三条独立理由：① `package.json` 为 `0.1.184` 而该 run `buildInfoVersion` 为 `0.1.183+20261109.163437.974.01e9e8af4119`，版本文件本身错配；② `dist` 为 `index-CcCiUIrc.js`，pack 产物为 `index-DTKU4frZ.js`，非同一份前端构建；③ 该 run 的 `versionMismatch: null` 是假阴性——脚本 `:1043-1046` 只比较 `Info.plist` 与 `build-info.version`，两者同为 `0.1.183` 时即判一致，无法发现 `dist` 与包体不同源。两个 run 目录原样保留，读证据时以上述理由区分，不得只凭 `status: passed` 认通过。

**事故留痕（不美化、不删）。** 16:36:03 大理寺卿为核验误跑 `npm run build`，其 `prebuild` 钩子改写了 `package.json`、`package-lock.json`、`build-info.json` 三份版本文件，属越权写入，已披露未回退，当时写入值后续被正常 `pack` 覆盖；16:36:51 `build-info.json` 的另一次回写，经首辅核定属左都御史 16:34 `pack` 的 `prebuild` 落盘时序，非第三方改写。两项共同构成污染 run 成因，不能表述为「仅注入项失败」。正式作品 `project.json` SHA-256 本轮前后均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。

**本轮仍未验证：** 未真机人工目视界面版本（仅脚本断言 `uiVersion` 与 `build-info` 相等）；未验证已打开旧进程自动升级（需重开应用，未强制结束用户进程）；污染 run 未重放复现；round8 的 11 张截图未逐张人工目视；真实 GLM/MiniMax 未调用（桩 + `NOVEL_E2E_NO_NETWORK=1`）；未 push、未部署、未进入下一阶段。

**P3 遗留：** `scripts/verify-story-events.cjs:1043-1046` 的 `versionMismatch` 在 `Info.plist` 与 `build-info.version` 同版但 `dist`/包体不同源时假阴性。本轮按纪律未改，应单独立项。
