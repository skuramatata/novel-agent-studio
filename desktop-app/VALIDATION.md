# 桌面原型验证记录

## 2026-09-14 · 日志 JSON 结构化展示

- 需求来源：用户要求「把 json string 改为 json」。
- 修改文件：`src/features/ExecutionNodeDetail.tsx`、新增 `LogJson.tsx` 和 `log-json.css`；`scripts/verify-execution-logs.cjs`、`docs/creation-logs.md`、本记录，以及构建生成的版本元信息。
- 修改要点：时间线与流程图复用可折叠的 JSON 详情，对象、数组和其中嵌套的 JSON 字符串均按结构展示；普通文本保留实际换行，非法或未完成的 JSON 保留原文。复制保持已保存的原始内容，未改变模型请求、检查点或 IPC 契约，未新增依赖。
- 验证结果：TypeScript、Vite 与 `npm run pack` 通过。开发及最终打包客户端通过 JSON 对象/原文字符串展示、嵌套对象和数组展开/收起、实际换行及非法 JSON 保留、复制原始嵌套字符串、长原文滚动，以及既有时间线/流程图、尝试切换、筛选、作品隔离和重启检查；页面异常为 0，旧记录字节未变化。验证使用独立临时作品库与模拟模型。交互脚本等待原生 details 的展开事件完成后再断言内容。
- 交付版本：`0.1.111+20260914.175032.159.f73852a203f0`。包内 `build-info.json`、`package.json`、应用 plist 与界面版本一致，13 个运行时/入口/前端产物文件与本地构建逐一匹配。证据：`verification/execution-logs/report.json`、`package-report.json`、`timeline-expanded.png`、`nested-json.png`。构建保留既有 Zod 注释与主包体积提示。

## 2026-09-14 · 默认纵向执行时间线

- 需求来源：用户反馈流程图与预期不一致，明确选择「纵向时间线：按发生顺序排列步骤，点击展开输入输出」。
- 修改文件：`src/features/CreationLogs.tsx`、新增 `ExecutionTimeline.tsx` 和 `execution-timeline.css`；`scripts/verify-execution-logs.cjs`、`docs/creation-logs.md`、本记录，以及构建生成的版本元信息。
- 修改要点：默认按节点开始时间展示纵向步骤；点击原位展开，支持多步同时展开，重试归在同一步；复用既有按需读取与详情组件。React Flow 与事件列表保留为辅助视图，旧记录无时间时明确标注并保留存档顺序。
- 验证结果：TypeScript、Vite 构建与开发、最终打包客户端交互验证通过；包括默认时间线、步骤顺序、多步展开/收起、尝试切换、完整请求、25,206 字符原文滚动与复制参数、筛选、辅助视图、1080×760 窄窗口、作品隔离、页面返回及重启历史读取。独立临时作品库与模拟模型，旧文件未改写，页面异常为 0。本轮只改日志 UI，未重新调用真实模型。
- 交付版本：`0.1.110+20260914.174124.389.94d60f7d45ac`，`npm run pack` 完成。包内 `build-info.json`、`package.json`、应用 plist 与界面版本一致，13 个运行时/入口/前端产物文件与本地构建逐一匹配。证据：`verification/execution-logs/report.json`、`package-report.json`、`timeline-overview.png`、`timeline-expanded.png`、`legacy-full-output.png`。构建保留既有 Zod 注释与主包体积提示。

## 2026-09-14 · React Flow 节点日志

- 需求来源：用户希望将日志改成可反向梳理 Agent 流程的节点视图，默认使用 React Flow，并能查看详细输入输出。
- 修改文件：`runtime/execution-log.mjs`、`creation-log.mjs`、`providers.mjs`、`provider-stream.mjs`、`structured-step.mjs`、`chapter-agent.mjs`、`agent.mjs`、`dag.mjs`；`electron/main.mjs`、`preload.cjs`；`src/features/CreationLogs.tsx`、`useCreationLogs.ts`、`ExecutionFlow.tsx`、`ExecutionNodeDetail.tsx`、`execution-flow.css`；`src/lib/bridge.ts`、`types.ts`、`src/style.css`；`tests/execution-log.test.mjs`、`scripts/verify-execution-logs.cjs`、`docs/creation-logs.md`，以及构建生成的版本元信息。
- 修改要点：默认节点画布与按需详情；记录最终请求、可见原文、各次校验及接收结果；覆盖正文、结构化与讨论入口，保留失败和复用证据；区分数据依赖和开始先后，旧记录缺失如实展示；任务/作品切换隔离过期数据。
- 验证结果：最终 `npm test` 312 项通过，TypeScript 与 Vite 构建通过；`npm run pack` 完成。开发及打包客户端通过真实 IPC、默认流程图、节点点选、失败/成功尝试切换、完整请求、25,206 字符原文滚动、复制参数、筛选、事件视图、窄窗口、作品隔离、切走返回及重启历史读取，页面异常为 0。截图检查发现窗口缩小时选中节点可能被裁切，已监听画布尺寸并重新适配；最终打包客户端通过缩放后节点完整可见的断言。测试使用独立临时作品库和模拟模型；最终复制检查截获参数，不覆盖系统剪贴板。
- 交付版本：`0.1.109+20260914.172700.060.187a9fa9199a`。包内 `build-info.json`、`package.json`、应用 plist 与界面版本一致，13 个运行时/入口/前端产物文件与本地构建逐一匹配。证据：`verification/execution-logs/report.json`、`package-report.json`、`flow-request.png`、`legacy-full-output.png`。构建保留既有 Zod 注释与主包体积提示。
- 只读核对现有两份任务：分别展示 1 个与 26 个节点；历史最终请求缺失如实标注，未重跑模型、未修改正式作品。

日期：2026-09-08；环境：本机 macOS Apple Silicon。当前结论是桌面操作与真实模型链路可用，尚未证明长篇创作能力或去 AI 味效果。

## 自动验证

`npm test`：12项通过。覆盖规划前禁止正文、采纳版本冲突、已有正文不可修改/删除、关系引用和章节号合法性、重启恢复、损坏文件保护、官方接口限制、错误脱敏、输出截断、最多两次调用、取消、失败诊断及 MiniMax M3 参数。

`npm run build`：TypeScript 与 Vite 构建通过。构建仍有第三方 Zod 注释及约507KB主脚本体积提示，不影响本地运行。`npm run pack` 生成 macOS arm64 应用；未做发行签名、公证或其他系统验证。

## 浏览器交互预览

预览明确使用固定数据，没有真实模型调用。实际操作通过：作者预设保存、生成候选后采纳、人物拖动、手柄连线、关系标签编辑、刷新保持、示例章节采纳、章节切换。正文区域没有输入框或 contentEditable。

## 真实模型与桌面

- 按用户授权读取 my-pi-agent 的两组密钥；源文件和原项目代码未修改。
- GLM Coding Plan 连接成功。请求模型 glm-5.2，实际返回 glm-5.3；对话按返回标识记录。生成过规划候选，人工发现身份/生死描述矛盾后放弃，没有采纳到作品。
- MiniMax-M3 连接成功。完成精简规划：2个人物、1条有向关系、3章章纲，约8.65秒、1次调用、2554 tokens；候选在桌面采纳。
- MiniMax-M3 完成第一章正文：约8.53秒、1次调用、3023 tokens。正文去空白后571字符，经采纳进入只读阅读页。
- 包内分别执行 GLM、MiniMax“保存并测试连接”，均显示成功。
- 普通桌面启动、加密配置恢复、作品与历史恢复已实测。人物关系标签编辑后保存。“自动排列”在原生窗口实测成功，重叠人物分开且保存。浏览器拖动已通过坐标变化及刷新验证；原生窗口自动化拖动触发了保存，但坐标未变化，尚不能确认是原生事件注入还是应用交互差异，需人工复验。
- 运行记录保存在本机应用数据目录 `runs/`，生成失败和成功分开记录；不含密钥。

## 发现并处理的问题

1. Electron ESM 启动等待方式导致窗口启动异常，改为 ready 回调。
2. contextBridge 冻结对象与 Proxy 的限制导致白屏，使用独立代理对象包装。
3. MiniMax 开启思考时一次规划达到输出上限；M3 改为关闭思考，并对截断明确报错，不写作品。
4. 一次正文候选两轮均未通过结构检查；失败未改变作品。补充失败次数、用量及验证原因记录，后续真实请求成功。
5. 普通桌面启动读取跨项目 `.env` 时卡在系统文件打开，终端启动可读；系统层根因未确认。已通过主进程将授权密钥导入系统加密存储，后续优先读取密文，并给首次源配置读取设置3秒返回上限。本机普通重启已恢复模型配置。没有关闭系统安全保护或修改源文件权限。

## 尚未通过的质量判断

样本仅用于验证产品流程。规划中的时间表述仍有需要编辑判断之处；结构校验无法识别所有语义矛盾。作者人格、文学背景、口癖与避免项已进入提示，但没有进行消融实验、盲评或长篇连续性评测。不能据此宣称已去除 AI 味。

目前不支持多作品管理、正文编辑、长任务跨重启续传、严格角色知情裁剪或完整事实图谱。会员接口连通不证明供应商具体扣减额度或独立应用的套餐适用性，详见 README 的官方资料。

## 环境操作说明

开始安装依赖时一次命令误在上级无 package.json 目录执行，npm 向上找到用户目录的已有项目并开始安装；已中止。用户目录的 package.json 与 package-lock.json 时间戳未变化，但 node_modules 可能受到该次安装影响，因缺少原始快照没有盲目删除或回滚。此后所有安装均限定在 desktop-app。

## 故事事件链第一阶段第二轮返修（2026-11-07）

### 需求来源

`agent-design/story-event-chain-review-fix-stage-1-round2.md` 列出 F1–F11 十一项经独立 review 确认的缺陷。上一轮 R1–R10 虽已交付并通过 376 项测试与旧桌面脚本，但那些结果没有覆盖本轮缺陷：建图入口在真实桌面不可用、候选问题在采纳时丢失、抽取按区间重截原文、原文 sourceId 被当作事件编号、同句两事件被合并、旧证据哈希被重新盖章、多证据失效原因取错、预览丢跨章边、作者决定后 revision 不同步、问题面板无修订入口、数量解释只读标题。

### 本轮修改文件

运行时：`runtime/story-events.mjs`、`runtime/story-events-apply.mjs`、`runtime/story-event-agent.mjs`。
主进程新增：`electron/story-build-channel.mjs`（建图通道与只读状态、预览合并）、`electron/model-transport.mjs`（模型传输接缝与 E2E 替身入口）。
主进程修改：`electron/main.mjs`、`electron/preload.cjs`。
前端：`src/features/StoryEvents.tsx`、`src/features/useStoryEvents.ts`、`src/lib/bridge.ts`、`src/lib/types.ts`。
测试：`tests/story-build-channel.test.mjs`（新增）、`tests/model-transport.test.mjs`（新增）、`tests/story-events.test.mjs`、`tests/story-event-workflow.test.mjs`。
验收脚本：`scripts/verify-story-events.cjs`、`.fixtures.cjs`、`.assert.cjs`、`.model-stub.mjs`（新增替身）。

### 实现要点

- **F1**：`studio:story-build-status` 是纯只读投影（我核对 handler 体内 `save`/`extractStoryEvents`/`complete` 计数为 0）；`studio:story-build` 由主进程按当前 provider 配置自建 ask，未配置时报可读错误而非"需要注入 ask"。执行入口要求显式 `mode`，防止误触发模型。
- **F2**：`mergeIssues()` 让候选 issues 随采纳落地；同 id 且既有 `disposition !== "open"` 时保留作者决定。
- **F3/F4**：区间只用于核验模型引文，不符即拒绝并报因；原文 sourceId、事件临时编号（本片 1..n）、持久化 id 三套彻底分开。
- **F5**：`sameEvent` 改为"标题强相似 或 kind + 对象集合 + 参与者集合 + 引文逐字全同"，不再按分数放行。
- **F6/F7**：旧证据带 `sourceHash` 时保留原哈希，只有模型新草稿才建新哈希；边失效原因与 `expectedHash` 取自实际失效的那份证据。
- **F8**：预览传 `knownNodeIds` + `attachNodes`，跨章边可见；附挂副本只在校验期存在，输出剔除，另返回 `referencedFormalNodes` 供界面查对端。
- **F9**：作者决定后走既有 `StudioContext.refresh` 同步整份作品；未绕过版本校验。
- **F10**：修订入口调既有 `generate(chapterId, words)`；`generate` 返回 false 时按分支写入 `decisionError`，不再静默无反应；提交前先 `refresh` 避免旧 revision。
- **F11**：`countText` 与检测范围一致，改为读 `title + summary + evidence.quote`。
- 模型传输接缝：`resolveModelTransport()` 统一出口，`NOVEL_E2E_MODEL_STUB` 仅在 `app.isPackaged === false` 生效，加载失败抛错不回落真实 fetch。

### 实际验证

- `node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs` → 75 tests / 75 pass / exit 0
- `npm test` → 405 tests / 405 pass / 0 fail / exit 0
- `./node_modules/.bin/tsc --noEmit` → exit 0
- `git diff --check` → exit 0
- `node scripts/verify-story-events.cjs` → exit 0，`status: passed`，26 案例 0 失败，`pageErrors: []`，`fixtureEvidenceAudit.ok: true`，`restartVerified: true`，11 张截图
- 失败信号传导：注入一条必失败断言后 `EXIT=1` 并打印失败案例名；移除后 `grep` 计数为 0
- `workflow_verify`（auto-workflow 1.0.7）实跑 `npm test` → `passed: true`、`exitCode: 0`

### 两条真实产品链路（脚本内以开发模式 + 模型替身驱动）

链路 1：两章已采纳无图 → 只读状态（fetch 计数前后为 0）→ 真实 `story-build` 未传 ask 建图 → 真实 `generate` 生成空白新章候选 → 请求携带 `sev-` id 与正式图原文 → 预览含跨章边/候选问题 → 放弃候选后重读盘正式图字节一致 → 再生成预览采纳 → 同库重启后节点/边/问题 id 全一致。

链路 2：问题面板查看证据 → 保留/驳回/裁定三次持久化且正文不变 → 保存设定后下一次生成无 revision 冲突 → 显式修订进入既有生成流程 → 未采纳前正文不变 → 采纳后重启检查正文、事件与失效原点。

### 仍未验证

1. 全部模型响应来自注入替身，不证明真实 GLM/MiniMax 理解并使用了事件材料；本阶段未调用真实供应商。
2. 打包产物下替身被忽略仅有代码层 `isPackaged` 短路证据，链路按设计在开发模式运行。
3. 正式十章作品未建图（刻意只读保护）。
4. 「放弃候选」无独立 IPC，走的是 UI 改 status 后 save 的既有路径——这是现状，不是本轮新增设计。
5. 深色主题与色弱对比度未做正式测量。

## 故事事件链第一阶段第三轮返修（2026-11-08）

> **本节为当轮自述，已被第四轮推翻部分结论，不可作为当前证据。**
> 本节记载的 `status: passed` / 28 案例全通过，其等待判据依赖 Playwright `page.waitForFunction(async 谓词)`，该写法会把返回的 Promise 当作 truthy、0 秒即判真（第四轮实测：async 谓词返回 false 时 `settled=true, 39ms`；sync 谓词返回 false 时 `settled=false, 3007ms`）。因此当时的「通过」不可采信，需以第四轮改用可靠轮询后的复核结果为准（见文末「历史诊断更正」与「端到端验收：incomplete，不是 passed」）。

### 需求来源

`agent-design/story-event-chain-review-fix-stage-1-round3.md` 列出 G1–G7 七项经独立 review 确认的缺陷。第二轮虽已交付 F1–F11 并通过 412 项测试与 28 个端到端案例，但那些结果没有覆盖本轮缺陷：过滤无效事件后关系编号错移、同句往返交接被合并、重复引文丢弃正确区间、建图后画布与共享 revision 未刷新、「重新建立」空跑、把「剩」当变化过程漏报同时点矛盾、验收脚本允许失败通过。

### 本轮修改文件

运行时：`runtime/story-event-agent.mjs`、`runtime/story-events.mjs`。
前端：`src/features/StoryEvents.tsx`、`src/features/useStoryEvents.ts`。
验收脚本：`scripts/verify-story-events.cjs`、`.assert.cjs`、`.model-stub.mjs`。
测试：`tests/story-event-workflow.test.mjs`、`tests/story-events.test.mjs`。

### 实现要点

- **G1**：事件临时编号改用**模型原始输出序号**（第 i 个即 i），被拒事件显式占位 `null`；关系引用被拒序号时报「对应事件已被拒绝，无法作为端点」，不移接到其他事件。
- **G2**：`sameEvent` 新增方向判据——`handover`/`state-transfer` 类事件的参与者顺序承载方向，集合相同但顺序不同即为两个事件；另比对标题中的方向词（还给/交还/归还/取回/收回/交回）。同句往返交接因此保留两个身份。
- **G3**：有区间时直接采用模型已核验的 span，不再被 `indexOf` 首处覆盖；无区间时 `locateUnique` 要求引文在本片唯一，重复出现即报歧义并拒绝，不静默选第一处。区间与引文不符仍拒绝（F3 行为保留）。
- **G4**：`startBuild` 成功后 `await refresh()`，经既有 `StudioContext` 同步完整作品与 revision，与 F9 的 `decideIssue` 同源，未关闭 revision 校验。
- **G5**：新增 `primaryBuildMode`/`primaryBuildLabel`/`canRebuild` 三个纯函数，让「建立/补全」的 mode 与文案同源；「重新建立」拆为独立按钮，仅在已有覆盖记录时出现且固定传 `build`。后端 `mode` 语义未改。
- **G6**：`PROCESS` 拆为动作词与结果态（「剩」不再单独构成过程）；新增 `explicitSameTime`——两条 `storyTime` 相同且非空时禁止用过程动词豁免，同刻并存的两个数量必须进待核对项。检查未关闭。
- **G7**：删除 `|| result.ok === false` 这类失败即通过的断言；生成成功路径改为「`result.ok === true` 且按候选 ID 证明本次新候选」；`chain1-accept` 用真实 `generatedCandidateId`（为 null 判 fail）；`chain2-accept-restart` 真实执行 accept 后重新读盘再重启。新增可控失败注入入口 `NOVEL_E2E_INJECT_FAILURE`，并修复脚本跑完不退出的问题（`finally` 中 `process.exit`）与 `runner.list()` 浅拷贝导致注入失效。

### 实际验证

- `node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs` → 96 tests / 96 pass / exit 0
- `npm test` → 412 tests / 412 pass / 0 fail / exit 0
- `./node_modules/.bin/tsc --noEmit` → exit 0
- `git diff --check` → exit 0
- `node scripts/verify-story-events.cjs` → **exit 0**，`status: passed`，28 案例全通过，`pageErrors: []`，`fixtureEvidenceAudit.ok: true`，`restartVerified: true`，11 张截图
- **可控失败**：`NOVEL_E2E_INJECT_FAILURE=case-04 node scripts/verify-story-events.cjs` → **EXIT CODE 1**，失败案例含 `case-04(R4)`，报告内 `evidence: { injected: true }`
- `workflow_verify`（auto-workflow 1.0.7）实跑 `npm test` → `passed: true`、`exitCode: 0`

### 端到端两条链路（隔离库 + 模型替身）

链路 1（建图与跨章候选）：两章已采纳无图 → 只读状态 → 真实按钮建图（不传 ask）→ **同一会话**读盘确认 `diskNodes: 4` 且 `viewNodes: 4`（G4 同步）→ 保存设定成功 → `g5-build-modes` 验证 complete 不重做、build 真重建 → 生成空白新章候选（12 次真实模型请求，记录候选 ID）→ 请求携带 `sev-` id 与正式图原文 → 预览 `edges: 2` 与原文引文（候选区独立）→ 放弃本次候选并重读盘确认未污染 → 再生成并采纳本次新候选 → 同库重启核对节点/边/问题 ID 全一致。

链路 2（作者决定与显式修订）：问题面板查看证据 → 保留/驳回/裁定持久化且正文不变 → F9 决定后 revision 同步、紧接着保存不冲突 → 保存设定及下次生成无 revision 冲突 → 作者输入要求显式发起修订 → 真实生成草稿候选并预览 → 未采纳前正文不变 → 实际采纳 → 重启核对。

### 仍未验证

1. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身，证明的是"请求携带历史事件 id 与原文"，不证明真实 GLM/MiniMax 理解并使用；本阶段未调用真实供应商。
2. 打包产物下替身被忽略仅有代码层 `isPackaged` 短路证据，链路按设计在开发模式运行。
3. 正式十章作品未建图（刻意只读保护）。
4. 「放弃候选」无独立 IPC，走 UI 改 status 后 save 的既有路径——这是现状，不是本轮新增设计。
5. G2 的方向判据依赖 `actors` 顺序；真实模型若对 actors 排序不稳定，往返交接可能仍被合并，未做真实模型抽样。
6. G6 向前扩两句取动作词，若正文分段极碎可能取不到，未做长文本抽样。

## 故事事件链第一阶段第四轮返修（2026-11-08）

> 本节为此前各节之后的追加记录。以上历史章节是当轮自述，**不等于本轮证据**；本轮结论以下面列出的实测命令输出与报告路径为准。

### 需求来源

`agent-design/story-event-chain-review-fix-stage-1-round4.md` 列出 H1–H7 七项经独立 review 确认的必修问题。第三轮虽已交付 G1–G7 并通过 412 项测试与 28 个端到端案例，但那些结果没有覆盖本轮缺陷：同句往返交接仍丢失身份、验收脚本顶层异常被吞掉反而返回成功、合法 `sourceId` 指向的重复引文被误拒、相同「未知」或宽泛时段被判为同一瞬间、「剩」可单独豁免数量矛盾、无待补章节时仍写入新 revision、两条产品链路仍用替代操作通过。

### 本轮修改文件

运行时：`runtime/story-events.mjs`、`runtime/story-event-agent.mjs`、`runtime/chapter-agent.mjs`、`runtime/structured-step.mjs`。
主进程：`electron/story-build-channel.mjs`、`electron/main.mjs`。
前端：`src/features/StoryEvents.tsx`、`src/features/useStoryEvents.ts`、`src/lib/types.ts`。
验收脚本：`scripts/verify-story-events.cjs`、`scripts/verify-story-events.assert.cjs`、`scripts/verify-story-events.model-stub.mjs`。
测试：`tests/story-events.test.mjs`、`tests/story-event-workflow.test.mjs`、`tests/story-build-channel.test.mjs`，新增 `tests/chapter-retrieval-stall.test.mjs`、`tests/structured-call-stall.test.mjs`。

### 实现要点

- **H1｜事件身份最小匹配**：`runtime/story-events.mjs` 的 `matchScore`/`sameEvent`/`setKey`/`duplicateDraft` 重写；合并时先把历史节点快照进 `historyNodes`，并返回与输入草稿一一对应的 `draftIds`（被拒为 `null`），`runtime/story-event-agent.mjs` 的关系端点改用 `draftIds` 映射，不再按 title+区间回查。区间重叠是跨批次匹配的硬条件；`actors`/`objects` 按集合（`setKey` 去重排序）比较，**取消**原先依赖 `actors` 顺序承载方向、以及依赖「还给/交还/归还」等方向词表的判据；同一批次内只有标题、区间、actors、objects **全等**才算重复草稿；同文本不同区间（如「甲敲门」两次）各自成节点。
- **H2｜顶层异常不再被吞**：`scripts/verify-story-events.cjs` 的 `finally` 由 `process.exit(process.exitCode ?? 0)` 改为 `process.exitCode = code`，让外层 `catch` 先跑完并把原因写盘；新增每次运行唯一的 `RUN_ID`；新增 `NOVEL_E2E_INJECT_LAUNCH_FAILURE=1`（首次 Electron launch 抛出）与 `NOVEL_E2E_INJECT_FAILURE=<caseId>`（指定案例强制断言失败）两个注入入口；失败报告写入 `runs/<runId>/`，不会误读上一次成功报告。
- **H3｜`sourceId` 作用域定位**：`runtime/story-event-agent.mjs` 的 `locateUnique` 改为返回 `{ located, reason }`；`splitSources` 为每个分片带上 `offset`；存在合法 `sourceId` 时只在该 source 对应的 offset 范围内定位与核验；显式 span 逐字核验通过则保留 span；「未找到」与「多处匹配」分开报因，不再互相矛盾地同时输出「引文不在原文中」与「歧义」。
- **H4｜同一时点判据**：新增 `UNKNOWN_TIME`（未知/不详/不明/不确定/待定/未提及）与 `SIMULTANEOUS_TIME`（同一时刻/同时/与此同时/同一瞬间/此刻同时）两个判据；任意非空相同时间字符串**不再**等于同时点，未知类与宽泛时段（如「午饭时」）不构成同时点；只有原文明确写明并存线索才按同时点处理并形成待核对项。
- **H5｜结果态不豁免**：移除 `statesResult(own)` 的单独豁免，豁免必须由 `PROCESS_ACTION`（真实过程动作）提供。仅「剩九个」的结果态不再能掩盖同刻数量矛盾。
- **H6｜空补全不写版本**：`electron/story-build-channel.mjs` 新增 `planStoryBuild`（纯函数，算出待补目标章）与 `runStoryBuild`（空目标直接返回 `skipped: true, skippedReason: "no-targets"`，不调模型、不写作品、不动 revision）；`src/features/useStoryEvents.ts` 的 `primaryBuildMode` 增加 `"none"`；`src/features/StoryEvents.tsx` 无待补时不渲染可执行按钮；`electron/main.mjs` 改走 `runStoryBuild`；`src/lib/types.ts` 补上可选字段。
- **H7｜两条链路改真实操作**：`scripts/verify-story-events.cjs` 大幅改造——用真实按钮而非直调 `window.studio.storyBuild`、同一会话校验当前画布与共享 revision、候选绑定本次生成的候选 ID、预览断言具体端点/问题/证据内容、**移除**手写 `pending-abandon-e2e` 与手写 `pending-chain2-revise`、新增 `pollUntil` 与 `waitOrchestrationIdle` 替代固定延时；`scripts/verify-story-events.assert.cjs` 新增 `unverified` 语义（前置缺失时显式标未验证，不被兜底改写成 pass 或 fail）；`scripts/verify-story-events.model-stub.mjs` 增加跨章边与问题产出。
- **附带健壮性修复（非 H 项，独立标注）**：`runtime/chapter-agent.mjs` 新增 `RETRIEVAL_WAIT_MS = 120000` 包住 `retrieval.sync`/`.search`，到限抛 `RETRIEVAL_TIMEOUT`；`runtime/structured-step.mjs` 新增 `MODEL_CALL_DEADLINE_MS = 30 * 60 * 1000` 由 `callWithDeadline()` 包住整个模型调用。两者只能由测试缩短、不能关闭。这两项是为了消除「无上限等待、失败后无 error」的可证实缺口，**不是**对现场卡死根因的修复（见下）。

### 实际命令与结果

- `node --test tests/*.test.mjs` → `tests 438 / pass 438 / fail 0 / cancelled 0 / skipped 0`，基线 412 → 438（新增两个超时保护测试文件）。
- `./node_modules/.bin/tsc --noEmit` → exit 0。
- `git diff --check` → exit 0。
- 正式作品 `project.json` SHA-256 → `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`，与 review 基线一致，未被触碰。
- `npm run pack` → exit 0，产物 `release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。

### 端到端验收：**incomplete，不是 passed**

`node scripts/verify-story-events.cjs` 最终报告（`verification/story-event-chain/round4/e2e/runs/2026-11-08T06-29-16-636Z-42321-6b2592/report.json`）：

- `status: "incomplete"`，`caseSummary: { total: 28, pass: 25, fail: 0, unverified: 3, unresolved: 0 }`。
- `pageErrors: []`，`fixtureEvidenceAudit: { ok: true, checked: 5, failures: [] }`，`restartVerified: true`，`versionMismatch: null`，11 张截图。
- 3 项未验证：`chain1-accept`、`chain2-revise`、`chain2-accept-restart`。

**未验证原因（准确表述，第四轮原文，归因已于第五轮推翻——见下方「更正」）**：`src/features/ChapterGeneration.tsx:39` 用 `!!pending` 禁用生成按钮；同文件 `:19-21` 只在该章正文存在差异时渲染「采纳/放弃」入口，导致「无改动候选」在章节页没有任何处理途径。两者叠加形成死锁，阻断上述 3 项链路验证。脚本按设计拒绝用 IPC 直接 save 或手写候选绕过，因此如实标注 `unverified` 而非判 pass。

> **更正（第五轮，2026-11-09）**：上述「两者叠加形成死锁、缺陷在产品侧」的归因**是误诊，已推翻**。真实根因是**验收脚本自身的执行顺序**：`chain1-accept` 原先排在 `chain1-abandon` 之前，脚本注释所称「上一轮候选已放弃」在执行时其实尚未发生；且 `chain1-accept` 内用 `keepId` 保护旧候选不清除，旧 pending 因此合理阻止了再生成。该问题属验收脚本缺陷（I2），已在第五轮修复。
>
> 界面侧是**分流而非死锁**：章节页确实对「无差异候选」不渲染处理入口（`:19-21` 要求候选含本章且正文有差异；`:70` 无差异时只给文字指引「请先在创作对话处理上一份候选」），但**任意 pending 候选在创作对话都有真实处理入口**——`src/features/Chat.tsx:145` 的条件仅为 `message.status === "pending"`，`:147-154` 渲染「采纳到作品」、`:155-169` 渲染「放弃」；`:42` 的 `stale` 只禁用采纳，`:155-169` 的放弃按钮仅受 `busy` 约束，**始终可放弃**。因此「章节页无入口」不能推出「产品死锁」。产品是否仍存在其他缺陷：**未验证**，既未确认仍有缺陷，也未证明无缺陷。第五轮修正顺序后同一套脚本实测 `status: passed`、`28/28`，详见下节。

### 历史诊断更正（重要）

本文件此前若干轮曾把「任务卡在记忆整理 / 检索索引」当作产品根因。**该归因未坐实，已降级**：部分「卡死快照」实际源于 Playwright `page.waitForFunction(async 谓词)` 把返回的 Promise 当作 truthy、**0 秒即判真**。首辅独立实测（脚本 `verification/story-event-chain/round4/lead/verify-wff.mjs`）：async 谓词返回 false 时 `settled=true, 39ms`；sync 谓词返回 false 时 `settled=false, 3007ms`。改用可靠轮询后，同一条 `chain1-generate` 链路在 2 秒内真实完成并产出候选。

因此：本轮的两处超时保护属**可证实的健壮性缺口**（`runtime/providers.mjs` 的 `fetcher` 与 `runtime/provider-stream.mjs` 的 `reader.read()` 均无上限等待，一旦不返回任务将永久停在 `requesting` 且无 error），加上是合理的；但**不得**据此声称「已修复卡死根因」。底层 embedding 偶发不返回的机制与供应商无响应的成因均未验证。

### 仍未验证

1. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身，证明的是「请求携带历史事件 id 与原文」「候选预览含跨章边/问题/证据」，**不**证明真实 GLM/MiniMax 理解并使用；本轮未调用任何真实供应商。
2. 上条所述 3 项端到端案例未验证，整体状态为 `incomplete`，第一阶段**未**通过验收。
3. 打包产物下的界面版本已实测与 `build-info.json` 一致（见下方交付版本），但「关于」窗口本轮未定位到可点击入口，`aboutPanelVerified: false`，仅侧栏与标题实测比对。
4. 底层 embedding / 供应商无响应成因未验证；30 分钟模型调用上限是工程判断值（24000 输出上限 ÷ 约 20 tok/s ≈ 20 分钟，留 50% 余量），非供应商 SLA 推导，真实长思考场景是否够用未验证。**（第五轮更正：该 30 分钟上限与 120 秒检索等待已于第五轮全部撤出，当前无任何超时兜底；本条保留为第四轮历史描述。）**
5. 正式十章作品未建图（刻意只读保护），本轮前后哈希一致。

### 交付版本

`0.1.178+20261108.144107.762.9b9876ababae`（北京时间 2026-11-08 14:41:07）。`package.json`、`build-info.json`、`Info.plist` 的 `CFBundleShortVersionString`、`app.asar` 内 `build-info.json` 与 `package.json` 五处一致；打包产物界面左下方显示的完整版本串与之逐字一致。版本号由 `prebuild` 钩子自动递增生成，未手工写死。证据：`verification/story-event-chain/round4/delivery/`。

## 故事事件链第一阶段第五轮返修（2026-11-08）

> 本节为追加记录。以上各节是当轮自述，**不等于本轮证据**；第四轮的「章节页候选死锁／缺陷在产品侧」结论已在上节附更正说明，历史原文保留。本轮结论以下列实测命令输出与报告路径为准。

### 需求来源

`agent-design/story-event-chain-review-fix-stage-1-round5.md` 列出 I1–I4 四项。第四轮虽已交付 H1–H7 并通过 438 项测试，但端到端仍为 `incomplete`（3 项 `unverified`），其归因被本轮推翻为误诊：真实阻塞来自验收脚本自身的案例执行顺序，而非产品侧死锁。

### 本轮修改文件

运行时：`runtime/story-events.mjs`（+80/−35，相对 `dbda1a5`）、`runtime/chapter-agent.mjs`、`runtime/structured-step.mjs`（后两者为撤出改动）。
验收脚本：`scripts/verify-story-events.cjs`。
测试：`tests/story-event-workflow.test.mjs`（新增 I1 三项）；删除 `tests/chapter-retrieval-stall.test.mjs`、`tests/structured-call-stall.test.mjs`（各 3 项，共 6 项）。
文档：`docs/story-event-chain.md`、`VALIDATION.md`（本节）。

`runtime/story-event-agent.mjs` 本轮未改。

### 实现要点

- **I1｜事件身份**：原实现 `historyNodes = [...nodes]` 只浅拷贝数组、元素仍是同一批对象，且按遍历顺序「先到先得」，导致前一草稿的 `Object.assign` 污染后续草稿的匹配依据、数组顺序成了身份。改为 `prepareDraft` 预筛合法草稿 → `historyNodes` 深拷贝快照 → `assignHistoryNodes` 对「全部合法草稿 × 全部历史节点」按 `matchScore` 降序做**全局一对一裁定**，同分用 `draftSignature` 破平局（不依赖输入顺序），未获归属者一律新建。未新增 import，未引入方向词表、词库、NLP 或 embedding，未新增模型调用，`package.json` 依赖未变。
- **I2｜链路 A 真实顺序**：执行顺序由「生成→预览→再生成/采纳→放弃」改为「生成 A→预览 A→放弃 A→读盘确认→生成 B→预览 B→采纳 B→重启」，`chain1-abandon` 前移到 `chain1-accept` 之前，`CASE_PLAN` 同步。新增 `focusChapterCandidate` / `clickCandidateAction`（按 `#candidate-<id>` 绑定）、`waitFreshCandidate`（三态）、`ensureFormalHistory`。
- **I3｜链路 B 真实界面**：删除全部绕行——`chain2-revision` 不再用 `window.studio.load` 取 revision 后直调 `generate`、不再用 `save` 把 pending 标为 `rejected`；`F10` 的 IPC save 清理同样删除。链路 A/B 内已无 `generate`/`accept`/`save` 直调（读盘核对仍用 `load`）。新增 `blockedContext`、`ensureNoPendingViaUi`、`decideIssueByUi`（按界面序号 + 完整文本逐字校验，不唯一则拒点）。链路 B 改用独立隔离库，章节 ID 与复用 `storyEvents` 对齐为 ch1–ch4。
- **I4｜撤出两项超时**：撤出 `runtime/chapter-agent.mjs` 的 `RETRIEVAL_WAIT_MS`(120s)/`waitLimited`/`retrievalWaitMs` 与 `runtime/structured-step.mjs` 的 `MODEL_CALL_DEADLINE_MS`(30min)/`callWithDeadline`/`options.callDeadlineMs`，并删除两个对应测试文件。撤出后两文件 blob 与第三轮 `01ac52e` **逐字节相同**（`chapter-agent.mjs` = `5f1bbaa11881b8f8038332aa22213d9b7832f468`，`structured-step.mjs` = `ba4acd856fa3ac458952f20722a4bc745815d368`），即本轮未夹带非 timeout 改动、无误伤。七个符号全仓检索（排除文档与 `node_modules`）零残留。

### 实际命令与结果

- `node --test tests/*.test.mjs`（在 `desktop-app`）→ `# tests 435 / # pass 435 / # fail 0 / # cancelled 0 / # skipped 0`，exit 0。
- 测试数变化：第四轮 438 → 删除 6（两个超时保护测试文件各 3 项）→ 新增 3（`story-event-workflow.test.mjs` 的 I1-1/I1-2/I1-3）→ **435**。分文件：`tests/story-events.test.mjs` 42、`tests/story-event-workflow.test.mjs` 53（原 50）、`tests/story-build-channel.test.mjs` 24。
- `git diff --check` → exit 0。
- 正式作品 `project.json` SHA-256 前后均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`，未被触碰。

### 端到端验收：passed

`node scripts/verify-story-events.cjs` 报告 `verification/story-event-chain/round5/e2e/runs/2026-11-09T02-55-14-367Z-93369-6689eb/report.json`（runId `2026-11-09T02-55-14-367Z-93369-6689eb`）：

- `status: "passed"`，`caseSummary: { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`。
- `pageErrors: []`，`restartVerified: true`，`fixtureEvidenceAudit: { ok: true, checked: 5, failures: [] }`，11 张截图。
- 报告根目录已从 `round4` 改为 `verification/story-event-chain/round5/e2e/runs`；误写进 `round4` 的本轮目录已清理，`round4` 历史证据未动。
- **版本口径注意**：该报告 `versionMismatch` 非空（`{ bundledVersion: "0.1.178", buildVersion: "0.1.179" }`），实测运行的是已打包的 `0.1.178` 应用，而 `build-info.json` 已递增到 `0.1.179`；`kind: "electron"`、`version: "0.1.178"`、`emptyStateWindowVersion: "0.1.178+20261108.144107.762.9b9876ababae"`。即**本轮界面证据来自 0.1.178 产物，不是 0.1.179 产物**，该差异未被消除。

两条链路候选 ID（实测）：

- 链路 A 放弃：`0c559205-386a-4c6e-b839-2da8a9bff12f`，入口「章节阅读」→「放弃候选」，`revision` 3→4；随后生成候选 B `b857a0c8-ca4b-4a35-ace6-a0d2a698c18b` 并经「采纳本章与记忆」采纳；A≠B 断言通过。
- 链路 B 保存设定后：`3b327315-6f51-4e81-8579-4b80d023281a`（先改作者人格名称再点真实「保存设定」按钮，`revision` 9→10）；修订候选 `f4f381e9-e135-4bcd-bdd9-21e17471cd77`，`revisionScope=["ch3"]`，跨章边 1 条，未采纳时正文不变。
- `chain2-decide` 经真实界面点「保留／驳回／裁定」，三种 disposition 齐备；`chain2-accept-restart` 按同一 ID 采纳，重启后正文、图、问题、作者决定（open / kept / dismissed / author-decided 四种）与失效标记（`staleIds` 3 个）全部持久化。

### 仍未验证

1. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身，证明的是「请求携带历史事件 id 与原文」「候选预览含跨章边/问题/证据」，**不**证明真实 GLM/MiniMax 理解并使用；本轮未调用任何真实供应商。
2. 界面证据来自已打包的 `0.1.178` 应用，而工作区 `build-info.json` 已为 `0.1.179+20261109.102840.352.2fec51cd9b85`；报告 `versionMismatch` 未消除，`0.1.179` 产物未单独做端到端回归。
3. 产品侧是否仍存在其他缺陷：**未验证**。第四轮的「死锁」结论已推翻，但本轮只证明「在修正后的脚本顺序下 28 项全部通过」，不构成「产品无缺陷」的证明。
4. 四个超时符号撤出后，`runtime/providers.mjs` 的 `fetcher` 与 `runtime/provider-stream.mjs` 的 `reader.read()` 仍是**无上限等待**，当前无任何超时兜底；底层 embedding 偶发不返回与供应商无响应的成因均未验证。
5. 正式十章作品仍未建图（刻意只读保护），仅核对前后哈希一致。
6. 深色主题与色弱对比度未做正式测量。

### 交付版本

以 `build-info.json` 的 `displayVersion` 为准，`npm run pack` 后回填。撰写本节时工作区值为 `0.1.179+20261109.102840.352.2fec51cd9b85`，这是某次 `npm run build` 的自动递增中间产物；最终 `npm run pack` 会再次自增并重算源指纹，届时以 pack 后的 `displayVersion` 为准。版本号由构建钩子生成，未手工写死。

## 故事事件链第一阶段第六轮返修（2026-11-09）

> 本节为追加记录。以上各节是当轮自述，**不等于本轮证据**；第五轮「验证边界」里仍引用 `0.1.179` 工作区中间版本与待 pack 回填的内容，已在本轮以 pack 后实测值收口。本轮结论以下列实测命令输出与报告路径为准。

### 需求来源

`agent-design/story-event-chain-review-fix-stage-1-round6.md` 的 J1、J2 两项，来自最新独立 review：

- **J1（P1，已复现回归）**：`runtime/story-events.mjs` 的 `assignHistoryNodes` 在 merge 的同批 `duplicateDraft` 去重之前就按历史快照分配身份，`best ?? twin` 又让 `best` 优先；两份相同的 A 草稿分别占走历史 A、B 身份，把 B 改写成第二份 A，输出成为「交出→交出」，旧边保留且 `failures=[]`、`issues=[]`。相同输入在 `dbda1a5` 旧实现中保留 A、B，属第五轮引入的回归。
- **J2（P2，判据缺口，非已复现产品丢图）**：采纳后的图未对照候选，丢掉全部增量仍可验收通过；链路 A 只核正文与现存引文，链路 B 把 `postAccept` 当重启期望。

### 本轮修改文件

源码与测试：`runtime/story-events.mjs`、`tests/story-events.test.mjs`、`tests/story-event-workflow.test.mjs`（J1）；`scripts/verify-story-events.cjs`、`scripts/verify-story-events.assert.cjs`、新增 `tests/story-event-acceptance.test.mjs`（J2）。
文档：`docs/story-event-chain.md`、`VALIDATION.md`（本节）、`agent-design/story-event-chain-review-fix-stage-1-round6.md` 执行附录。

`runtime/story-event-agent.mjs`、`runtime/chapter-agent.mjs`、`runtime/structured-step.mjs`、`runtime/story-events-apply.mjs`、`electron/main.mjs` 与全部界面文件本轮未改；后两者仅只读核对。第五轮未提交改动全部保留，未执行 `reset` / `clean` / `checkout` 整文件恢复。

### 实现要点

- **J1｜重复先归并、再分配身份**：`assignHistoryNodes`（`runtime/story-events.mjs:532-562`）先用既有 `duplicateDraft`（`:199`）把本批等价草稿归并，`:536-541` 只让组内首条进入配对，`:542-560` 再做「全部合法草稿 × 全部历史节点」的全局一对一裁定（同分用 `draftSignature` 破平局）。落点循环未改：未参与裁定的重复稿在 `batchNodeIds` 中按 `duplicateDraft` 找到 twin 复用同一 id。`draftIds` 与输入草稿严格一一对应——`:605` 被拒为 `null`、`:640` 复用、`:662` 新建；去重不压缩数组，后续关系按原始序号取端点不会错位。未新增 import、方向词表、NLP、embedding 或模型调用，未改 schema，`package.json` 依赖未变。
- **J2｜采纳结果对照候选**：新增断言入口 `evaluateAcceptance`（`scripts/verify-story-events.assert.cjs:259-706`，导出 `:709-716`），由 `verify-story-events.cjs:20` require、`:3504`（链路 A 采纳）、`:3634`（链路 A 重启）、`:4791`（链路 B 采纳）、`:4907`（链路 B 重启）四处调用，`:600-612` 的 `applyAcceptance` 并入 runner 并保留每条判据明细。预期从**采纳前**固定的候选最终正文/事件/关系/问题、历史图与作者决定快照推导，不用采纳后图倒推，也不调用被测生产合并函数生成「正确答案」。逐项核对新增事件的章节/语义/kind/actors/objects/证据（chapterId、start、end、quote、sourceHash）、本次跨章边的 source/target/type/basis/explanation/evidence、本次问题的 ID/kind/关联节点或边/explanation/suggestion 落地，以及作者决定不被候选 `open` 覆盖。

### 实际命令与结果

- **定向四文件**：`node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs tests/story-event-acceptance.test.mjs` → `# tests 135 / # pass 135 / # fail 0 / # skipped 0`，exit 0。分文件：`story-events` 43、`story-event-workflow` 55、`story-build-channel` 24、`story-event-acceptance` 13。
- **全量**：`npm test` → `# tests 451 / # pass 451 / # fail 0 / # skipped 0`，exit 0。较第五轮 435 净增 16（J1 新增 H1-D/I1-4/I1-5 共 3 项，J2 新增 `story-event-acceptance.test.mjs` 13 项）。未删除或跳过任何存量测试。
- **J1 修复前失败证据**：在当前第五轮工作区先加用例再跑，`tests/story-events.test.mjs` → not ok H1-D（`重复的 A 草稿不得占用递回事件的身份`，actual `['甲把钥匙交给乙','甲把钥匙交给乙']`，tests 43 / pass 42 / fail 1）；`tests/story-event-workflow.test.mjs` → not ok I1-4（`递回事件不得被重复的 A 草稿改写`，actual `甲把钥匙交给乙` / expected `乙把钥匙递给甲`，tests 54 / pass 53 / fail 1）。I1-5 另以隔离副本临时移除 `owners` 归并取红（tests 98 / pass 96 / fail 2），随后恢复修复版。
- **静态与格式**：`./node_modules/.bin/tsc --noEmit` → 输出 0 行，exit 0；`git diff --check` → 输出 0 行，exit 0。
- **打包**：`npm run pack` exit 0，自动递增至 `0.1.181`，`displayVersion` `0.1.181+20261109.142212.073.8ec118fa8a38`，`sourceHash` `8ec118fa8a38`，`builtAtLabel` 2026-11-09 14:22:12 北京时间。
- **正式作品只读**：`project.json` SHA-256 前后均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。

### 端到端验收：passed（正式证据只认一个 run）

- **完整桌面验收**：`node scripts/verify-story-events.cjs`，exit 0，未使用 `NOVEL_E2E_ONLY_CASES` 子集。首次整体通过 runId `2026-11-09T06-27-45-158Z-21171-430071`，报告 `verification/story-event-chain/round6/e2e/runs/2026-11-09T06-27-45-158Z-21171-430071/report.json`：`status: "passed"`、`caseSummary { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`、`versionMismatch: null`、`pageErrors: []`、`restartVerified: true`、`fixtureEvidenceAudit { ok: true, checked: 5, failures: [] }`、`version: 0.1.181`。
- **根级证据对齐重跑**：`env -u NOVEL_E2E_ONLY_CASES -u NOVEL_E2E_INJECT_LAUNCH_FAILURE -u NOVEL_E2E_INJECT_FAILURE node scripts/verify-story-events.cjs`，**exit 0**。新 runId `2026-11-09T06-43-21-893Z-29633-a000b5`，`status: "passed"`、`caseSummary { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`、`versionMismatch: null`、`pageErrors: []`、`buildInfoVersion 0.1.181+20261109.142212.073.8ec118fa8a38`；四份 judgement 判据 `chain1-accept` 45 / `chain1-restart` 90 / `chain2-accept` 75 / `chain2-restart` 150，失败均为 0。本次重跑使 `round6/e2e/` 根级聚合报告与 11 张截图与通过口径同源（`story-event-chain-report.json` 的 `runId` 即上值）。
- **J2 同一入口判据数（本 run，失败均为 0）**：`chain1-accept` 45、`chain1-restart` 90、`chain2-accept` 75、`chain2-restart` 150。
- **启动失败注入**：`NOVEL_E2E_INJECT_LAUNCH_FAILURE=1` → exit **1**（预期），runId `2026-11-09T06-22-48-734Z-19171-a46e5c`，`failure.json` 在同 run 目录。
- **case-04 断言失败注入**：`NOVEL_E2E_INJECT_FAILURE=case-04` → exit **1**（预期），runId `2026-11-09T06-22-52-707Z-19220-11ce08`，`pass=27 fail=1`，仅 `case-04(R4)` 失败，其余 27 项通过；该 run 只证明注入准确命中单一案例，不能当作整体通过证据。
- **三处版本一致**：工作区 `build-info.json`、包内 `app.asar` 的 `build-info.json`（逐字节相同，SHA-256 `a343b72171f2…f278`）、打包产物界面实测文本（主窗口 + 空态窗口；包内 `Info.plist` `CFBundleShortVersionString=0.1.181`）。

### 证据覆盖事故（如实记录，不可还原）

1. **round6 根级证据：最终同源，历史事故保留**。**（a）最终状态**：`round6/e2e/story-event-chain-report.json` 与根级 11 张截图现已与通过口径同源，runId `2026-11-09T06-43-21-893Z-29633-a000b5`，`status: passed`，28/28，`versionMismatch: null`，`pageErrors: []`。**（b）历史事故（保留，不删）**：中间曾有一次误触发运行 `2026-11-09T06-33-53-040Z-24965-c7d31e`（`status: failed`、`pass=23 fail=4 unverified=1`；唯一直接原因是链路 B 阶段 `page.evaluate: Target page, context or browser has been closed`，并连带 `chain2-revise` 未产出候选而 `unverified`）覆盖过根级文件；该失败 run 目录原样保留，可作为过程证据查阅。**（c）认读规则**：通过与否以 `runs/<runId>/report.json` 与 judgement 文件为准——`06-27-45-158Z-21171-430071` 与 `06-43-21-893Z-29633-a000b5` 两次通过，`06-33-53-040Z-24965-c7d31e` 为过程失败，不得计入通过。
2. **第五轮 round5 根级证据已被覆盖**：`round5/e2e/` 根级 11 张截图与聚合报告在第六轮被覆盖、无 git 记录亦无副本、不可还原；覆盖物已移入 `round6/e2e/overwritten-round5-root/`，第五轮原始 8 个 runId 目录未受影响。
3. **保留的过程失败**：`round6/e2e/runs/2026-11-09T06-10-50-052Z-9189-cba041` 为误删 `const root` 导致的 `ReferenceError`，原样保留，不计为通过。
4. **终验过程事故**：误用 `npx asar extract-file` 把内容写到 `desktop-app` 目录（已核实工作区 `build-info.json` 未被污染，改用 `@electron/asar` 只读提取复核）；误跑一次 `verify-story-events.cjs --help` 触发非预期运行（60s 转后台后 kill，`git status` 无新增）。

### 仍未验证

1. 「关于」窗口未单独定位并点击实测（报告 `aboutPanelVerified` 为空）；界面版本证据来自主窗口与打包产物空态窗口的实测文本。以 Playwright 直接启动打包产物补测两次均 `Process failed to launch!`，按重试上限停止。
2. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身，脚本强制 `NOVEL_E2E_NO_NETWORK=1` 并使用隔离库假密钥；**不**证明真实 GLM/MiniMax 的理解与产出，本轮未调用任何真实供应商。
3. 用户当前已运行的桌面进程是否已升级到 `0.1.181`：未验证；未强制结束任何用户进程。
4. J1「修复前失败」的原始日志未归档进仓库，仅由工部尚书以隔离副本自证、大理寺卿另以隔离副本复核；成员自报部分标未验证。
5. 产品侧是否仍存在其他缺陷：**未验证**。本轮只证明「修正后脚本下 28 项全部通过」，不构成「产品无缺陷」的证明。
6. `runtime/providers.mjs` 的 `fetcher` 与 `runtime/provider-stream.mjs` 的 `reader.read()` 仍为无上限等待，当前无超时兜底；成因未验证。

### 交付版本

`0.1.181+20261109.142212.073.8ec118fa8a38`（`sourceHash` `8ec118fa8a38`，`builtAtLabel` 2026-11-09 14:22:12 北京时间，`package.json` version `0.1.181`）。包路径 `desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。版本号由构建钩子生成，未手工写死。

## 故事事件链第一阶段第七轮返修（2026-11-09）

> 本节为追加记录。本轮仅完成 K1、K2 两类验收缺口，来源见 `agent-design/story-event-chain-review-fix-stage-1-round7.md`。两项均属**验收判据/接线缺口**，不是已复现的产品采纳损坏。本轮未修改任何 runtime、electron、src 业务文件，未改 J1 事件合并实现，未恢复已撤出的全局超时。

### 本轮修改文件

- `scripts/verify-story-events.assert.cjs`：新增 `expectedEdgeStale`（:263）按 impactOf 契约推导关系失效；跨章判据改为比对解析后 `chapterId`（:553-608）；新增 `originEdge.<id>.present/.preserved/.stale`（:766-816）与候选边 `edge.<i>.stale`（:818-843）；新增 `stale.newly`（:845-859）。该文件相对 HEAD 为纯新增，无删除既有判据。
- `scripts/verify-story-events.cjs`：四处 `evaluateAcceptance` 调用与两处保存输入均启用 `requireIncrements: true`（:3517、:3550、:4827、:4860）；链路 B 失效前置收紧为 `newlyInvalidOrigins`（:4714-4730，按采纳前正文验有效、按候选最终正文验失效）；证据路径由 round6 改为 round7（:31-32、:615-616）。
- `tests/story-event-acceptance.test.mjs`：由 13 项增至 26 项，新增 K1/K2 正负例并显式点名判据 id。
- 证据目录：`verification/story-event-chain/round7/{baseline,dalisi,e2e}/`。

### 实现要点

- **K1**：A/B 两链路的采纳后与重启后四处启用同一必需增量要求，标志写入保存输入并随展开继承；候选材料必须含本次实际采纳候选（链路 A 用候选 B）的事件、真跨章关系与问题；跨章判定改为「一端历史一端新增 **且** 两端解析后 `chapterId` 不同」，ID/标题/历史身份差异不再算跨章；候选无边、无问题均在空数组下失败。
- **K2**：只统计「采纳前有效 → 候选最终正文后失效」为本次产生，原已 stale 不计入；历史关系逐条核对 ID、source/target/type/basis/explanation 与原证据 chapterId/start/end/quote/sourceHash 保留、端点仍在；关系失效严格按 `impactOf` 契约（自身证据优先取第一份实际失效证据，仅端点失效时 reason=`source-changed` 且 expectedHash 取 `evidence[0]?.sourceHash ?? ""`，全有效时必须为 null）；同库重启复核同一组事实。

### 实际命令与结果（均在 `desktop-app`，首辅亲跑）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node --test tests/story-event-acceptance.test.mjs` | 26 pass / 0 fail | 0 |
| `node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs` | 122 pass / 0 fail | 0 |
| `npm test` | 464 pass / 0 fail | 0 |
| `./node_modules/.bin/tsc --noEmit` | 无输出 | 0 |
| `git diff --check`（项目根） | 无输出 | 0 |
| `npm run pack` | 打包成功 | 0 |

`workflow_verify` 记录（与原生结果分开）：`node --test tests/story-event-acceptance.test.mjs`、定向三文件、`npm test` 三条 passed=true、exitCode=0；`tsc --noEmit` 与 `git diff --check` 被该工具以「不是可识别的标准验证入口」拒绝执行，这两条只有原生 bash 结果（exit 0）。

### 端到端验收（开发模式 Electron 业务链路）

`env -u NOVEL_E2E_ONLY_CASES -u NOVEL_E2E_INJECT_LAUNCH_FAILURE -u NOVEL_E2E_INJECT_FAILURE node scripts/verify-story-events.cjs` → **exit 0**，runId `2026-11-09T07-45-22-923Z-65871-b89d66`，`status: "passed"`，`caseSummary { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`，`versionMismatch: null`，`pageErrors: []`，`restartVerified: true`，11 张截图。四份 judgement 判据数：`chain1-accept` 53、`chain1-restart` 104、`chain2-accept` 93、`chain2-restart` 184，失败均为 0。报告 `verification/story-event-chain/round7/e2e/story-event-chain-report.json`。

真实跨章端点实测：链路 A `sourceChapterId: "c1" → targetChapterId: "c3"`；链路 B `"ch1" → "ch3"`；重启阶段同值，且均正确排除同章边。K2 实测 `after.B.stale.newly` 为 `{ newlyStaleCount: 1, preStaleCount: 2, changedCount: 3 }`，即真实链路中确有 2 个采纳前已 stale 的旧节点未被计入本次产生；链路 B `originEdge` 判据覆盖 4 条历史关系（`see-2352f1ead57e`、`see-1ad7070f1acd`、`see-eb5f04c2d80c`、`see-4195f6542f13`），采纳后与重启后全部通过。

两条注入（预期非零，不计通过）：`NOVEL_E2E_INJECT_LAUNCH_FAILURE=1` → exit 1，runId `2026-11-09T07-42-57-542Z-64170-82915e`；`NOVEL_E2E_INJECT_FAILURE=case-04` → exit 1，runId `2026-11-09T07-43-00-976Z-64214-c8b7f3`，`pass=22 fail=5 unverified=1`。两个 run 目录原样保留。

**打包产物展示验证（与业务链路分开）**：28 个案例全部在**开发模式 Electron**（`isPackaged=false`）执行，脚本 `:1120-1125` 在 `isPackaged !== false` 时中止，避免替身被忽略而打到真实供应商。打包产物只承担空态窗口展示验证（`:1358` 用 `executablePath` 独立启动，仅断言文案与版本文本），实测 `emptyStateWindowVersion` 为 `0.1.182+20261109.153019.453.c9e0b2602ea7`。**`versionMismatch: null` 只表示包内 `Info.plist` 版本等于工作区 `build.version`，不是「打包产物内跑通业务链路」的证据。**

### 证据覆盖事故（如实记录）

修复前首辅直接执行过一次完整验收，当时脚本证据路径仍硬编码 `round6/e2e`，导致 `round6/e2e/` 根级 11 张截图（15:30）与 `story-event-chain-report.json`（15:35）被该次运行覆盖。第六轮的历史 run 目录未受影响，仍在。随后将脚本 `:31-32`、`:615-616` 改为 round7 并重跑，本轮全部证据改落 `round7/`。被覆盖的 round6 根级文件未做任何回填、恢复或删除，事故现场原样保留。通过与否以 `round7/e2e/runs/<runId>/report.json` 与四份 judgement 为准。

### 仍未验证

1. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身，不证明真实 GLM/MiniMax 的理解与产出；本轮未调用任何真实供应商。
2. 「关于」窗口未单独定位点击实测。
3. 用户已运行的桌面进程是否升级到本轮版本：未验证；未强制结束用户进程。
4. 真机未验收。
5. 产品侧是否仍存在其他缺陷：**未验证**。本轮只证明「修正后判据下 28 项全部通过」，不构成「产品无缺陷」的证明。
6. 断言入口无法自防「调用方漏传 `requireIncrements`」；当前靠四处接线核对与 `tests/story-event-acceptance.test.mjs` 第 15 项静态核验兜住。

### 交付版本

`0.1.182+20261109.153019.453.c9e0b2602ea7`（`sourceHash` `c9e0b2602ea7`，`builtAtLabel` 2026-11-09 15:30:19 北京时间，`package.json` version `0.1.182`）。`build-info.json`、`package.json`、包内 `Info.plist` 三处一致。包路径 `desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。

## 故事事件链第一阶段第八轮返修（2026-11-09）

> 本节为追加记录。本轮修两处**验收/交付链路**缺陷，来源见 `agent-design/story-event-chain-review-fix-stage-1-round8.md`。两项均不是已复现的产品采纳损坏：L1 是判据假绿，L2 是交付追溯问题。本轮未修改任何 `runtime`、`electron`、`src` 业务文件，未改 `evaluateAcceptance` 签名，未放宽任何既有断言。

### 问题来源

- **L1｜历史关系证据的 `sourceHash` 未被逐份比对。** 第七轮的 `originEdge.<id>.preserved` 只比 `chapterId|start|end|quote`（共用 `evidenceListKey`），随后仅校验 `sourceHash` 是字符串，从未证明它等于采纳前原值。单独替换该字段仍返回 `ok=true`、`failures=[]`，属假绿。同文件历史节点 `origin.<id>.evidence` 已正确比 `sourceHash`，关系侧属同款遗漏。
- **L2｜最终源码指纹与交付版本不一致。** 上轮 `pack` 之后又改了验收脚本输出路径与注释，包内指纹早于工作区最终源码；64 个包内业务文件与工作区内容一致，属交付追溯问题。

### 本轮修改文件

- `scripts/verify-story-events.assert.cjs`：共用 `evidenceListKey`（`:220-223`）**语义未改**；新增局部专用 `historicalEvidenceListKey`（`:225-236`），逐份映射 `chapterId/start/end/quote/sourceHash`，数量与顺序天然一致；`:793/:794/:795` 组成历史边 `preserved` 的三层比较，保留原 `typeof sourceHash === "string"` 校验。
- `scripts/verify-story-events.cjs`：仅 `:31-32`（runs 目录）与 `:615-616`（截图与汇总目录）由 round7 改为 round8，附注释同步；业务流程、失败处理与断言未动。
- `tests/story-event-acceptance.test.mjs`：26 项增至 30 项，新增 4 条 L1 用例（`:738-767` 夹具、`:769` 正例、`:785` after 负例、`:809` restart 负例、`:835` 候选材料正例）。

### 实现要点

- **`sourceHash` 的期望值取采纳前原值**，不是新正文哈希；候选证据本就不带该字段，因此绝不能把它并入共用 `evidenceListKey`，否则合法候选材料会误报。这也是本轮新增专用函数而非扩写共用函数的原因。
- **正负例必须精确点名判据。** after 负例要求失败项含 `after.B.originEdge.see-c1-c2-key.preserved` 且不得由 `stale` 代为拦截；restart 负例要求含 `restart.B.originEdge.see-c1-c2-key.preserved`，并断言 `after.*` 无失败，确保失败只来自重启阶段。候选材料正例断言 `after.B.edge.0.contract` 仍为通过，证明未因缺 `sourceHash` 误判。

### 实际命令与结果（均在 `desktop-app` 执行）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node --test tests/story-event-acceptance.test.mjs`（修改前，含新用例） | 30 tests / 28 pass / 2 fail | 1 |
| `node --test tests/story-event-acceptance.test.mjs`（修改后） | 30 tests / 30 pass / 0 fail | 0 |
| `npm test` | 468 pass / 0 fail（468 = 438 存量 + 30 本文件） | 0 |
| `./node_modules/.bin/tsc --noEmit` | 无输出 | 0 |
| `git diff --check`（项目根） | 无输出 | 0 |
| `grep -n "round[567]" scripts/verify-story-events.cjs` | 仅 `:615` 一行历史说明文字，无 round6/round7 写入目标 | 0 |
| 只读复算源码指纹（同 `stamp-version.mjs` 范围/排序/算法） | 149 文件，`ae4a146c6c8c`，与 `build-info.json` 一致 | 0 |

RED 早于修复落盘：`l1-fix/red.log` mtime 16:25:53，`assert.cjs` 落盘 16:27:00，`l1-fix/green.log` 16:27:12。失败断言为 `true !== false`，即修复前反例仍被放行，非夹具自身报错。

### 端到端验收（开发模式 Electron 业务链路）

通过 run：`2026-11-09T08-41-26-407Z-99069-5efe2f` → `status: "passed"`，`caseSummary { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`，`versionMismatch: null`，`pageErrors: []`，`restartVerified: true`，`injection: null`，`buildInfoVersion` 与 `uiVersion` 同为 `0.1.185+20261109.164106.316.ae4a146c6c8c`。四份 judgement 判据数：`chain1-accept` 53、`chain1-restart` 104、`chain2-accept` 93、`chain2-restart` 184，失败均为 0。报告 `verification/story-event-chain/round8/e2e/story-event-chain-report.json`，11 张截图与 `runs/` 同落 `round8/e2e/`。

**污染 run：`2026-11-09T08-35-09-924Z-95644-93aa40` 亦为 `status: "passed"`，但不计入通过。** 三条独立理由：

1. `package.json` 为 `0.1.184`，该 run `buildInfoVersion` 为 `0.1.183+20261109.163437.974.01e9e8af4119`，版本文件本身错配；
2. `dist` 为 `index-CcCiUIrc.js`，pack 产物为 `index-DTKU4frZ.js`，非同一份前端构建；
3. `versionMismatch: null` 是假阴性——脚本 `:1043-1046` 只比 `Info.plist` 与 `build-info.version`，两者同为 `0.1.183` 时即判一致，看不到 `dist` 与包体不同源。

两个 run 目录原样保留、互不覆盖；通过与否只认 `08-41-26-407Z-99069-5efe2f`。

### 事故与越权写入（如实记录）

- **16:36:03** 大理寺卿为核验误跑 `npm run build`，`prebuild`（`stamp-version.mjs`）改写了 `package.json`、`package-lock.json`、`build-info.json` 三份版本文件。属**越权写入**，已披露，未回退；当时写入值后续被正常 `pack` 覆盖。
- **16:36:51** `build-info.json` 的另一次回写，经首辅核定属左都御史 16:34 `pack` 的 `prebuild` 落盘时序，非第三方改写。

两项共同构成污染 run 的成因。**不能表述为「仅注入项失败」**，也无伪造恢复。

### 仍未验证

1. 未真机人工目视核对界面版本——仅由脚本断言 `uiVersion` 与 `build-info` 相等。
2. 未验证已打开的旧进程自动升级——磁盘重新打包不影响运行中进程，需重开应用；本轮未强制结束任何用户进程。
3. 污染 run 未重放复现——三条理由来自现场文件比对与脚本源码，未在隔离环境重新复刻。
4. round8 的 11 张截图未逐张人工目视。
5. 真实 GLM/MiniMax 未调用：模型响应全部来自 `NOVEL_E2E_MODEL_STUB` 替身，脚本强制 `NOVEL_E2E_NO_NETWORK=1`。
6. 未 push、未部署、未进入下一阶段。
7. 产品侧是否仍存在其他缺陷：**未验证**。本轮只证明「修正后判据下 28 项全部通过」，不构成「产品无缺陷」的证明。

### P3 遗留

`scripts/verify-story-events.cjs:1043-1046` 的 `versionMismatch` 只比较 `Info.plist` 与 `build-info.version`；两者同版但 `dist` 与包体不同源时假阴性，本轮污染 run 即为实例。本轮按纪律未改——它属验收脚本判定逻辑，改动会牵动验收口径，应单独立项。

### 正式作品保护

正式作品 `project.json`（`de35f11a-11ec-4925-a8a2-8939f07b9883`）SHA-256 本轮前后均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`，未被本轮任何操作改写。

### 交付版本

`0.1.185+20261109.164106.316.ae4a146c6c8c`（`sourceHash` `ae4a146c6c8c`，`builtAtLabel` 2026-11-09 16:41:06 北京时间，`package.json` version `0.1.185`）。按 `stamp-version.mjs` 相同范围与排序对 149 个文件只读重算，`sourceHash` 与工作区 `build-info.json` 一致。版本五方一致：工作区 `build-info.json`、工作区 `package.json`、包内 `app.asar` 的 `build-info.json`、包内 `Info.plist`（`CFBundleShortVersionString=0.1.185`）、release version。包路径 `desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。版本号由构建钩子生成，未手工写死。
