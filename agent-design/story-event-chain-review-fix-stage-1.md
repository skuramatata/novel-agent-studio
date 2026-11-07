# 故事事件链第一阶段修复任务书

日期：2026-11-07，北京时间。

本阶段修复上一轮故事事件链实现中经 review 确认的 10 项问题，使隔离作品能够走通“历史建图 → 新章生成 → 跨章关联 → 候选预览 → 采纳 → 重启读取 → 作者处理”。完成本阶段不等于真实模型或正式小说质量验收通过。

本文件是修复任务的需求、接口约束和验收依据；具体任务拆分、文件负责人和派工由 dsh 内阁首辅决定，不依赖 Codex 聊天历史。

## 基线与授权

- 项目：`/Users/shenjiaolong/Documents/GitHub/novel-agent-studio`。
- 别名：`/Users/shenjiaolong/Documents/GitHub/小说写作`，与上述路径为同一项目。
- 分支：`v2`。
- Git HEAD：`70654875fc77e9b7064343e46d5c12732969b6ae`。
- 实际待修对象：上述 HEAD 加当前未提交的故事事件链实现，构建版本 `0.1.153+20261107.153404.805.1a12e5db7896`。仅检出 HEAD 会丢失本次要修的功能。
- 修改授权：允许在下述范围内修复代码、补回归测试、完善对应文档并打包。不自行 push 或部署。
- 开始时读取项目与上级 `AGENTS.md`，记录当前 Git 差异和相关源码指纹；保留现有已跟踪及未跟踪成果，不 reset、清理或覆盖他人工作。
- review 基线：352 项测试通过，`tsc --noEmit` 与 `git diff --check` 通过；这些通过结果没有覆盖本文件列出的缺陷。

现有说明：`desktop-app/docs/story-event-chain.md`。其中“稳定身份”“作者处理”“完整链路”等已完成表述有失实之处，需要根据修复后的实际行为更新，不能用文档自述代替验收。

相关约定：`desktop-app/docs/author-revision-workspace.md`、`desktop-app/VALIDATION.md`、`desktop-app/runtime/schema.mjs`。

## 已确认的需求和权限

事件图记录小说里的事情及其前因后果。界面与模型使用同一套事件、关系和证据数据；执行日志继续作为独立的调试功能。

关系应区分因果、获知、状态承接、回忆、伏笔等，并区分原文明示、模型推断、作者确认与待核对。时间先后、相同人物或共用引文不能自动证明因果或事件身份相同。

正常新事件可以是起点；悬念、未知原因、传闻、谎言、人物信念和倒叙不能一律算错。章纲与未采纳候选不得成为正式历史。

作者已经明确选择：系统展示原文、问题和修订建议，是否改稿由作者决定。建图、检查、标记保留或驳回均不得改正文；作者明确选择修订后才进入既有修订及采纳流程。

## 本阶段修复清单

下列位置来自 review 时的源码，修改后行号可能变化。须沿调用链定位，逐项保留修复证据。

| 编号 | 优先级 | 已确认问题与位置 | 必须达到的结果 |
| --- | --- | --- | --- |
| R1 | P1 | `electron/main.mjs:441` 在采纳新正文前用旧 `p.chapters` 合并事件；`:226` 的预览也用旧正文。空白章的新候选可采纳正文却丢掉全部事件。 | 预览与采纳均使用候选最终正文视图核验引文，正文与事件一起提交。覆盖新章和已有章改稿。 |
| R2 | P1 | `runtime/story-event-agent.mjs:113` 只发送当前分片，`:183` 的关系端点限于本片；`:533` 又过滤跨章端点。 | 模型请求可引用所需历史事件及证据，生成跨章关系；候选、预览和采纳保留指向正式历史事件的端点。 |
| R3 | P1 | `runtime/story-events-apply.mjs:9` 无章节信息地归一化旧图，删除已有 explicit 边；候选转换与 `reviewDisposition` 有同类调用。 | 合并空增量、采纳新章、转换候选或处理问题，都不能删除无关合法关系。 |
| R4 | P1 | `runtime/story-events.mjs:74–81` 接受错误区间，并把引文替换为该区间另一段文字，生成当前哈希。 | 严格拒绝区间与引文不匹配；不能通过替换引文或刷新哈希掩盖错误。本阶段不需要新增模糊重定位机制。 |
| R5 | P1 | `runtime/story-events.mjs:380–390` 将共用同一句引文的不同事件合并覆盖，并复用错误 ID。 | 同段多事件分别保留；真正同一事件重抽保持身份且不重复；既有连线不能悄悄改指其他事件。 |
| R6 | P1 | `runtime/story-events.mjs:350` 用新正文归一化时先删除旧节点及边，后续 `impactOf` 无法展示失效原点。 | 改稿后保留旧原点、旧证据和受影响关系，标为待复核；不能用删掉节点使失效计数归零。 |
| R7 | P2 | `src/features/StoryEvents.tsx:1116` 只有空态，`electron/main.mjs:314` 只有读取；抽取仅在新正文候选完成后运行。 | 已有正文但无图的作品有明确建图/补全入口，可查看进度、失败与覆盖；只更新派生事件数据，不改正文。 |
| R8 | P2 | `chapter-agent.mjs:1057` 得到问题，但 `storyEventsForProposal` 从 `story-event-agent.mjs:515` 起只返回 nodes/edges/coverage。 | 问题、证据、建议与处理状态随候选保存，可预览；采纳后进入正式图，重启后仍在。 |
| R9 | P2 | `StoryEvents.tsx:600–619` 只展示 disposition，没有保留、驳回、裁定或发起修订的产品入口；runtime 方法没有接入。 | 作者能查看原文并作出、保存处理决定；显式选择修订时交给既有草稿修订流程，最终仍由作者采纳。 |
| R10 | P2 | `story-event-agent.mjs:363` 只比较数量词，将正常消费导致的数量变化报成互斥状态。 | 正常数量变化不误报；缺少解释或明确冲突仍可形成待核对项，不能直接关闭检查通过测试。 |

## 共享接口约束

首辅应先核对以下契约的现状，固定本阶段实际字段和调用关系后再分派并行实现。字段名可沿用现有代码，不必为满足本任务另造通用框架。

1. **统一正文版本。** 候选的正文视图由当前作品与有效候选的章节变更组合而成。引文、事件增量与候选预览均依据这个版本；采纳仍校验作品 revision，未修改章节保持原样。
2. **稳定节点与端点。** 区分模型本次输出的临时标识与程序持久化的事件 ID。已有事件引用必须验证所属作品和身份；新事件由程序建立稳定身份。关系端点可以是本次新事件，也可以是已有正式事件；不能要求两端都位于当前分片或候选增量内。
3. **精确证据。** 每份证据关联章节、正文版本/哈希、范围和逐字引文。错误范围不能通过替换引文变成合法。前文变化后保留旧引用及失效原因，不在普通读取或归一化中重新盖章成为有效。
4. **完整增量。** `proposal.storyEvents` 需要承载本轮事件/关系变更、覆盖和问题，保持稳定引用。节点与问题的作者确认/处理状态不能在无关合并时丢失。接口变更须同步 runtime schema、TypeScript 类型、IPC、候选预览及采纳入口。
5. **正式与候选隔离。** 候选可引用正式历史事件，但不能提前修改正式图。预览不写作品；放弃候选不影响正式正文或图；采纳将最终正文和对应事件数据一起保存。重复点击和过期请求沿用项目既有版本保护。
6. **作者操作。** 保留、驳回和裁定仅保存问题处理状态，不自动改正文。显式发起修订时传递目标问题、证据和作者要求，复用已有修订/采纳机制；不得另建绕过采纳的正文写入口。
7. **历史建图。** 对已采纳正文建立或补全派生图，按实际处理范围记录覆盖和失败；重试不能清空已成功的结果或抹去作者决定。未来章纲与未采纳候选不能混入正式历史。模型输入按相关事件和原文控制范围，未装入的材料明确标示未覆盖。

## 允许修改范围

- `desktop-app/runtime/story-events*.mjs`、`story-event-agent.mjs`、`story-event-context.mjs`。
- `desktop-app/runtime/chapter-agent.mjs`、`schema.mjs`。
- `desktop-app/electron/main.mjs`、`preload.cjs`。
- `desktop-app/src/features/StoryEvents.tsx`、`useStoryEvents.ts`、`story-events.css`。
- `desktop-app/src/lib/bridge.ts`、`types.ts`，以及确有必要的 `src/App.tsx` 入口接线。
- 对接作者显式修订确有必要时，可对既有草稿工作区、其 hook、`StudioContext.tsx`、`runtime/draft-agent.mjs` 做最小接线；任务书必须列出具体文件和原因，不重写原有修订引擎。
- 与上述行为直接相关的 `desktop-app/tests/` 测试、新增隔离集成脚本及 `scripts/verify-story-events.cjs`。
- `desktop-app/docs/story-event-chain.md`、既有 `VALIDATION.md`、本任务书的执行结果附录，以及版本构建自动更新的 package/build-info 文件。
- 为这些职责拆出小型专用文件允许，但不能扩成需求外架构重构。优先复用既有依赖。

## 本阶段不包含

- 新题材功能、全书自动连写、多人协作、云同步、全局图数据库、无关 UI 重做。
- 修复 dsh、内阁、auto-workflow 或供应商插件自身问题。
- 自动修改正式小说，或直接给正式作品写入测试事件图。
- 真实供应商付费生成和正式十章作品的模型重建。本阶段以模拟模型响应驱动真实应用入口；真实模型稳定性和正式作品验收由 Codex 与用户在阶段结束后决定。
- 安全审计、依赖全面升级、提交外部消息、push、部署或修改内阁全局配置。

正式作品仅可只读核对：

`/Users/shenjiaolong/Library/Application Support/novel-agent-studio/projects/de35f11a-11ec-4925-a8a2-8939f07b9883/project.json`

review 时 SHA-256：`5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。若与开始时不同，记录外部变化，不以旧哈希覆盖文件。所有写入验证使用独立临时作品库。

## 任务板与预算

由首辅建立任务板并细分任务。每份任务书写明：目标、关联 R 编号、文件归属、共享接口、前置依赖、交付物、验收命令、预算、停止条件及核验负责人。

共享接口文件必须明确唯一协调负责人；依赖未满足的任务不能用自造字段替代。成员知道彼此共享工作区，不覆盖或回滚他人修改。

预算沿用当前内阁已有配置，首辅在任务书填写读到的实际额度、单位与来源；未配置或无法读取的项如实标明，不编造用户授权的 token、金额或时间。不得为绕过额度无声新建成员或无限重试。对相同失败先核对证据与输入，重复失败不能用相同操作持续刷新预算。

下列情况停止受影响任务并由首辅汇总：超出当前预算；需要修改范围外模块；共享契约出现影响实现的冲突；发现需要作者决定的业务规则；无法保持正式数据隔离。可独立推进的其他任务继续。基础设施验证失败须记录原始输出与替代验证通道，不伪称失败入口通过。

只在影响实现的需求矛盾或关键业务决策缺失时提问。常规实现、文件拆分、已授权范围内的测试与打包直接执行。

## 回归案例与验收

先把已复现缺陷写成能失败的行为回归，再修改实现。不要只测试辅助函数，不要改变预期值或减少断言掩盖问题。

| 案例 | 必须验证的行为 |
| --- | --- |
| 空白章生成“林遥接过了铜钥匙。” | 通过真实候选链路得到非空事件；预览、采纳、重新加载一致；改稿的新引文同样成立。 |
| 第一章交钥匙，第二章用钥匙开门 | 实际模型请求含相关历史事件 ID 和原文；模拟响应可引用历史端点；跨章边经过候选转换、采纳及重启仍在。 |
| 已有一条合法 explicit 边 | 合并空补丁、采纳无关章、转换候选、处理问题后不丢失。 |
| 正文“汽笛响了。甲把钥匙交给乙。”，错误范围 0–5 配“甲把钥匙交给乙。” | 明确拒绝错误引用，不能替换成“汽笛响了。”后通过。 |
| 同一句“甲把钥匙交给乙，乙随后打开门。”抽出两件事 | 保留两个不同节点与因果关系；随后重抽同一事件不重复、不改变身份。 |
| 修改第一章，删改原交钥匙事件 | 保留旧原点与关联证据，标记受影响后文待复核，不删除图掩盖失效，不自动改后文。 |
| 已有两章正文、无 storyEvents | 从产品建图入口开始，完成抽取、关联、持久化及展示；正文哈希不变。 |
| 本章产生一个缺口问题 | 候选页/图能查看问题、证据与建议；放弃不污染正式图，采纳后保存，重启后可读。 |
| 作者保留、驳回、裁定及显式修订 | 前三项能持久化且正文哈希不变；选择修订才进入既有候选修改流程，未采纳不得覆盖正式正文。 |
| 十个苹果，吃一个剩九个 | 有明确过程时不报互斥；同一时点两条相冲突的数量陈述仍能成为有依据的待核对项。 |

真实小说中的第四章“惠新在船上听过它响”已有第二章放信号枪原文作依据，不能把它当成预设失败样本；正向回忆与确实缺少依据的隔离反例都应验证。

### 验证命令

在 `/Users/shenjiaolong/Documents/GitHub/novel-agent-studio/desktop-app` 执行：

```sh
node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs
npm test
./node_modules/.bin/tsc --noEmit
git diff --check
npm run pack
node scripts/verify-story-events.cjs
```

- 前两条必须包含上述新增回归，存量 352 项不得无理由减少或跳过。
- 扩展 `verify-story-events.cjs`，通过真实 Electron IPC 驱动隔离作品的完整生成/候选/采纳/重启/作者处理，不只预置一张图后检查展示。模拟响应必须经过实际模型适配接缝和业务入口，记录请求中是否包含历史事件与证据；不得调用真实供应商。
- 若另建集成脚本，首辅必须在任务书及交付记录写明准确命令，并实际执行；不能只在总结中说“集成验证通过”。
- 删除或改正恒真断言（例如 `条件 || true`）；核心候选或关系测试不允许条件不满足时静默跳过。
- 图形检查覆盖跨章连线、选中原文、关系依据、候选状态、失效原点及作者操作。重启后重新读取验证持久化。
- `npm run pack` 按项目规则生成新版本，核对界面、关于窗口、包内构建信息与本轮源码一致；不强制结束用户正在生成内容的应用进程。
- 函数测试、模拟模型集成、真实桌面操作与真实模型调用分开报告；本阶段未运行最后一项，不能声明真实模型稳定性已通过。

## 阶段结束与交付

首辅完成独立核验后，按 R1–R10 逐项报告修复位置、复现/回归命令、实际结果及残余问题；不能用成员任务板全部完成代替验收。

提交最终汇总：

1. 修改摘要和实际文件清单。
2. R1–R10 的逐项证据，仍未完成的项明确保留。
3. 测试及桌面命令的真实输出、失败记录和证据文件路径。
4. 正式作品未被写入的核对结果。
5. 完整应用版本、打包位置及包内一致性结果。
6. 未完成/未验证项，尤其真实模型与正式作品验收边界。

完成本阶段后停止，不自动进入真实模型验收、不自行 push 或部署。由 Codex 与用户 review 本轮差异和证据后决定下一阶段。

## 执行结果附录（2026-11-07，dsh 内阁）

本附录由首辅在完成独立核验后填写。以下为实际执行结果，不代表真实模型或正式作品验收。

### 交付版本

- 完整版本：`0.1.159+20261107.220901.381.69ebaf79a758`
- 打包位置：`desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`
- 一致性：`build-info.json`、`Info.plist`、`app.asar` 内构建信息三处相同；包内含 6 个 story-event 运行时模块；未打包 `.env`。

### 基线核对

- Git HEAD `70654875fc77e9b7064343e46d5c12732969b6ae`，分支 `v2`，未 reset，未提交，未 push。
- 工作区保留原有已跟踪与未跟踪成果；本轮在 `desktop-app` 范围内新增与修改，未见他人改动被回滚。

### 修改文件

运行时：`runtime/story-events.mjs`、`runtime/story-events-apply.mjs`、`runtime/story-events-schema.mjs`、`runtime/story-event-agent.mjs`、`runtime/story-event-context.mjs`。
主进程：`electron/main.mjs`、`electron/preload.cjs`。
界面：`src/features/StoryEvents.tsx`、`src/features/story-events.css`、`src/features/useStoryEvents.ts`、`src/lib/bridge.ts`、`src/lib/types.ts`。
测试与脚本：`tests/story-events.test.mjs`、`tests/story-event-workflow.test.mjs`、`scripts/verify-story-events.cjs`、`scripts/verify-story-events.fixtures.cjs`、`scripts/verify-story-events.assert.cjs`。
文档：`docs/story-event-chain.md`。
版本构建自动更新：`package.json`、`package-lock.json`、`build-info.json`。

### R1–R10 修复位置与验收

| 编号 | 修复位置 | 回归证据 |
| --- | --- | --- |
| R1 | `electron/main.mjs` 的 `proposedChapters` 与 accept/预览路径 | case-01：真实 save+accept 后事件非空、引文在采纳后正文逐字命中；对照旧正文为 0 事件 |
| R2 | `runtime/story-event-agent.mjs` 的 `historyPayloadFor`、端点 `sourceRef/targetRef`、跨章边保留；`runtime/story-events.mjs` 的 `knownNodeIds` | case-02 `requests` 含第一章 `sev-` 与原文；case-A 正向回忆不误判；单元 ok 29/30/33/34 |
| R3 | `runtime/story-events.mjs` 章节守卫、`runtime/story-events-apply.mjs` 带 chapters 归一化 | case-03 四操作串行后 explicit 边仍在；四条用例含跨文件串联 |
| R4 | `runtime/story-events.mjs:82` `if (slice !== quote) return null;` | case-04：错区间返回 null、正确区间接受且不替换引文 |
| R5 | `runtime/story-events.mjs` 的 `sameEvent` 判据 | case-05：同句两节点、id 不同、重抽不新增且身份不变 |
| R6 | `runtime/story-events.mjs` 的 `keptStaleEvidence` 与边保留 | case-06：旧原点保留、标 stale、expectedHash 保留、正文不变 |
| R7 | `electron/main.mjs` 的 `studio:story-build`、`storyBuildProgress`；界面建图面板 | case-07：注入 ask 建图非空、覆盖含 extracted、正文前后一致 |
| R8 | `runtime/story-event-agent.mjs` 的 `storyEventsForProposal` 带 issues；`electron/main.mjs` 的 `candidates.issues` | case-08：产出待核对项、带 disposition、放弃不污染；case-B 真实入口产出 |
| R9 | `runtime/story-events.mjs` 的 `setIssueDisposition`；`electron/main.mjs` 的 `studio:decide-story-issue`；界面决定按钮 | case-09：kept/dismissed/author-decided 三次均持久化且正文不变 |
| R10 | `runtime/story-event-agent.mjs` 的 `explainsTransition` | case-10：十苹果正例 0 条、同点冲突负例 ≥1 条 |

### 验证命令与实际结果

在 `desktop-app` 执行：

- `node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs` → 64 tests / 64 pass / 0 fail
- `npm test` → 376 tests / 376 pass / 0 fail
- `./node_modules/.bin/tsc --noEmit` → exit 0
- `git diff --check` → exit 0
- `npm run pack` → 成功，产物见上
- `node scripts/verify-story-events.cjs` → exit 0，`status: passed`，`caseSummary {total:12, pass:12, fail:0, unresolved:0}`，`pageErrors: []`，`fixtureEvidenceAudit.ok: true`，`restartVerified: true`

报告：`desktop-app/verification/story-event-chain/story-event-chain-report.json`；截图 11 张，含重启后状态。

### 正式作品只读核对

`projects/de35f11a-11ec-4925-a8a2-8939f07b9883/project.json`：size 5083546、mtime 2026-09-11 17:09、sha256 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`，与任务书基线一致，全程未写入。全部回归在 `mkdtemp` 临时作品库运行。

### 未完成与未验证

1. 模型响应全部来自注入的 `ask` 桩。`requests` 记录证明请求携带历史事件 id 与原文，不证明真实 GLM/MiniMax 理解并使用这些材料；本阶段未调用真实供应商。
2. 正式十章作品未建图，属刻意的只读保护；真实作品上的图规模与性能未验证。
3. 改稿（revise）路径未单独做端到端案例，`chapter-agent` 的 revise 分支未覆盖。
4. `knowledgeClaimsFrom` 为动词白名单启发式，存在漏报与误报空间。
5. `storyBuild` 未实现 `running` 中间态，当前同步执行后返回；前端已兼容该分支。
6. 深色主题与色弱对比度未做正式测量，仅以形状、线型与文字保证不只靠颜色表意。
7. `workflow_verify` 在本会话执行层持续故障（插件 `v1.0.6.mjs:187` 的嵌套 `ctx.tools.execute` 在受限子代理中被拦截），多轮多入口复现，已登记 blocker。上述验证均来自原生 bash 与 Electron 实机，**不声称经该工具验证通过**。
