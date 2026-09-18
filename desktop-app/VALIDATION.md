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
