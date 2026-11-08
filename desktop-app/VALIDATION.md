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

**未验证原因（准确表述）**：`src/features/ChapterGeneration.tsx:39` 用 `!!pending` 禁用生成按钮；同文件 `:19-21` 只在该章正文存在差异时渲染「采纳/放弃」入口，导致「无改动候选」在章节页没有任何处理途径。两者叠加形成死锁，阻断上述 3 项链路验证。脚本按设计拒绝用 IPC 直接 save 或手写候选绕过，因此如实标注 `unverified` 而非判 pass。

### 历史诊断更正（重要）

本文件此前若干轮曾把「任务卡在记忆整理 / 检索索引」当作产品根因。**该归因未坐实，已降级**：部分「卡死快照」实际源于 Playwright `page.waitForFunction(async 谓词)` 把返回的 Promise 当作 truthy、**0 秒即判真**。首辅独立实测（脚本 `verification/story-event-chain/round4/lead/verify-wff.mjs`）：async 谓词返回 false 时 `settled=true, 39ms`；sync 谓词返回 false 时 `settled=false, 3007ms`。改用可靠轮询后，同一条 `chain1-generate` 链路在 2 秒内真实完成并产出候选。

因此：本轮的两处超时保护属**可证实的健壮性缺口**（`runtime/providers.mjs` 的 `fetcher` 与 `runtime/provider-stream.mjs` 的 `reader.read()` 均无上限等待，一旦不返回任务将永久停在 `requesting` 且无 error），加上是合理的；但**不得**据此声称「已修复卡死根因」。底层 embedding 偶发不返回的机制与供应商无响应的成因均未验证。

### 仍未验证

1. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身，证明的是「请求携带历史事件 id 与原文」「候选预览含跨章边/问题/证据」，**不**证明真实 GLM/MiniMax 理解并使用；本轮未调用任何真实供应商。
2. 上条所述 3 项端到端案例未验证，整体状态为 `incomplete`，第一阶段**未**通过验收。
3. 打包产物下的界面版本已实测与 `build-info.json` 一致（见下方交付版本），但「关于」窗口本轮未定位到可点击入口，`aboutPanelVerified: false`，仅侧栏与标题实测比对。
4. 底层 embedding / 供应商无响应成因未验证；30 分钟模型调用上限是工程判断值（24000 输出上限 ÷ 约 20 tok/s ≈ 20 分钟，留 50% 余量），非供应商 SLA 推导，真实长思考场景是否够用未验证。
5. 正式十章作品未建图（刻意只读保护），本轮前后哈希一致。

### 交付版本

`0.1.178+20261108.144107.762.9b9876ababae`（北京时间 2026-11-08 14:41:07）。`package.json`、`build-info.json`、`Info.plist` 的 `CFBundleShortVersionString`、`app.asar` 内 `build-info.json` 与 `package.json` 五处一致；打包产物界面左下方显示的完整版本串与之逐字一致。版本号由 `prebuild` 钩子自动递增生成，未手工写死。证据：`verification/story-event-chain/round4/delivery/`。
