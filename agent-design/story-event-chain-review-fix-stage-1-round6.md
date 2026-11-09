# 故事事件链第一阶段第六轮返修任务书

日期：2026-11-09，北京时间。

本轮继续第一阶段，仅修复最新独立 review 的 J1、J2，并同步收尾交付记录。用户将配套话术交给内阁后，授权在本文件范围内修改、补回归、更新文档并打包。本文件可独立交接，不依赖聊天历史或 `/tmp` 文件；准备任务书不代表已经启动 dsh。

## 起点与资料

- 项目：`/Users/shenjiaolong/Documents/GitHub/novel-agent-studio`；别名 `/Users/shenjiaolong/Documents/GitHub/小说写作` 指向同一目录。
- 分支：`v2`。
- 当前 HEAD：`dbda1a5aacca9443c9a183c252c4097afbe8d1ca`（第四轮提交）。
- **实际实施基线是该 HEAD 加当前尚未提交的第五轮改动**，不是单独的 HEAD。编写本任务书前，194 个已审查文件的内容与上一轮 review 时一致。
- 当前完整版本：`0.1.180+20261109.111500.124.3cd1a1d1aa0a`，源码指纹 `3cd1a1d1aa0a`。

既存未提交修改包括 `desktop-app/runtime/story-events.mjs`、`runtime/chapter-agent.mjs`、`runtime/structured-step.mjs`、`scripts/verify-story-events.cjs`、`tests/story-event-workflow.test.mjs`、两份功能/验证文档和 package/build-info 文件；两个超时专用测试已删除；第五轮任务书尚未纳入版本管理。这些是需保留的工作起点，不得 reset、clean、整文件恢复到 HEAD 或覆盖他人成果。执行前记录当前状态与 diff；若期间形成了提交，核对内容对应关系后记录实际提交即可，不因提交号变化重做已完成修复。

先读适用的 `/Users/shenjiaolong/.agents/AGENTS.md` 和项目 `AGENTS.md`，再读以下文件（均相对项目根目录）：

1. `agent-design/story-event-chain-review-fix-stage-1-round5.md`：原阶段边界、两条产品链路和已修行为。
2. `desktop-app/docs/story-event-chain.md`：事件、证据、关系、候选与正式图契约。
3. `desktop-app/docs/author-revision-workspace.md`：显式修订、草稿与采纳流程。
4. `desktop-app/VALIDATION.md`：既有改动记录；其旧版本/报告引用需要本轮收尾。
5. `desktop-app/runtime/story-events-apply.mjs`、`desktop-app/electron/main.mjs` 的采纳接线：**只读核对**既有候选转换及作者决定保留契约，不由此获得修改授权。

本任务书的 J1/J2、范围与验收优先，不继承旧任务书全部修改授权。作者与模型共享同一套故事事件和证据；发现问题先展示原文、问题及修订建议，由作者决定是否发起修订，正式正文仅在采纳时更新。保留第五轮已完成的操作顺序、真实 UI 路径、超时撤出，以及此前 H2–H6 等正确行为。

## 独立 review 已确认的事实

- 435/435 测试通过，类型检查与 diff 检查通过；完整桌面脚本独立运行 28/28、退出 0、`versionMismatch: null`、`pageErrors: []`。但下述反例仍成立，不能只凭这两个通过数字宣布第一阶段完成。
- 启动异常注入独立运行退出 1 并留证；dsh 的本次断言失败注入及 `workflow_verify` 通过记录已核实。
- I4 撤出准确，两个运行时文件与第三轮对应内容一致；源码、工作区、包内文件及界面版本一致。不要重新加回已撤出的全局超时。
- 全部写入验证使用隔离库及模型替身，正式作品哈希未变；真实模型与关于窗口未独立验收。
- 第五轮最终 dsh 报告为 `desktop-app/verification/story-event-chain/round5/e2e/runs/2026-11-09T03-20-16-018Z-18424-8cace8/report.json`。文档仍引用较早报告和待回填版本属于记录收尾，当前并无已确认的包版本错配。

## J1｜P1｜重复草稿占用另一历史身份，覆盖原事件

位置：当前工作区 `desktop-app/runtime/story-events.mjs:534–550` 的 `assignHistoryNodes`，及 `:610–615` 的 `best ?? twin` 优先级。

可独立复现的输入与顺序：

1. 单章 `{ id: 'h1', number: 1, title: '往返交接', content: '甲把钥匙交给乙，乙看过后把钥匙递给甲。' }`。
2. 事件 A 标题“甲把钥匙交给乙”，事件 B 标题“乙把钥匙递给甲”。两者均为 `kind: 'handover'`、`actors: ['甲','乙']`、`objects: ['钥匙']`、`basis: 'narration'`、`sourceId: 1`，quote 为整句正文，start=0、end=content.length。
3. 首次通过真实 `extractStoryEvents` 抽取 A、B 和 `{ sourceId: 1, targetId: 2, type: 'state-transfer', basis: 'explicit', explanation: '交出后递回', evidenceSourceId: 1 }`，记录两个 ID 及边。
4. 再次把第一次的图传入真实抽取入口，只返回两份完全相同的 A 草稿，不新增关系。

当前结果：历史身份分配发生在本批去重之前，两份 A 分别占据历史 A、B；后续 `best` 优先于已识别的 `twin`，将 B 改写为另一份 A。输出成为“交出→交出”，旧边仍保留，`failures=[]`、`issues=[]`。相同输入在 `dbda1a5` 的旧合并实现中保留 A、B，说明这是第五轮引入的回归；不能直接回滚第五轮，因为会重新暴露上一轮已修缺陷。

要求：

- 按既有重复判据先识别同一批的等价草稿，再为不同事件分配历史身份；重复项不得占用其他事件的身份。实现可自行选择最小方案，不新增 NLP、方向词库、schema 或模型调用。
- 上述重抽必须保留 A、B 的原 ID、各自语义/证据及 A→B 的原端点，不能让 B 改名、清空或被错误标为失效；重复执行不增生节点。
- 保留每个原始草稿序号的落点：重复项映射至同一事件 ID，被拒项仍为 null，不因去重压缩数组而使后续关系错位。增加包含重复项且关系引用其原始序号的用例，验证端点真实对应，而非只看节点数。
- 保留第五轮“历史只有 A，重建补入 A/B”“历史已有 A/B，重抽及逆序仍稳定”的回归；保留同一事件改标题/actors 顺序变化、同文本不同发生位置、无效草稿过滤后关系序号不串位等行为。
- 将反例放进仓库现有事件测试，先确认**当前第五轮工作区**失败、修复后通过。不要以旧 HEAD 的通过结果代替修复前失败证据。

## J2｜P2｜采纳后的图未对照候选，丢掉全部增量仍可验收通过

位置：`desktop-app/scripts/verify-story-events.cjs:3329–3338`、`:3404–3421`（链路 A），以及 `:4498–4563`（链路 B）。

已确认的问题是**验收判据缺口**，不是已复现的产品采纳丢图。链路 A 采纳后只核正文和现存引文；链路 B 直接把 `postAccept` 当成重启期望。若采纳只更新正文及 accepted 状态，图仍保留原样，重启比较自然相等。

独立反例执行了当前 `chain2-accept-restart` 的原始函数体：采纳前存在带新节点、新边、新问题的候选，故意模拟采纳后仅正文/消息状态/revision 变化、旧图及旧失效标记原样保留；9 条原断言全部通过。正式回归应把必要输入与判据纳入仓库，不依赖临时脚本，不把这个模拟当成生产故障证据。

### 正常链路必须核对的事实

1. 采纳前固定本次真实候选 ID、候选最终正文/事件/关系/问题，以及历史图和作者决定快照。预期从这些采纳前材料及明确夹具推导；不得再直接以未经核验的采纳后图作为唯一预期，也不能仅调用被测生产合并函数生成同一份“正确答案”。
2. 链路 A 中被放弃候选 A 不污染正式图，后来生成并采纳的是不同的候选 B。核对 **B** 的新增事件、跨章边和问题；不能用此前被放弃 A 的预览结果代替 B 的验收。
3. 链路 B 采纳的是作者本次显式修订产生的同一候选。按章节 ID 核对正文更新与未覆盖章节保留，不假设 proposal 必然包含全书正文。
4. 采纳后逐项核对明确的新增事件：所属章节、事件语义、kind、actors/objects、证据的 chapterId/start/end/quote/sourceHash；证据必须对应候选最终正文及其在正式作品中的落点。
5. 核对本次跨章边的 source/target 确实对应指定历史事件和候选事件，type/basis/explanation/evidence 按契约保留；不能只检查“有边”、总数未减少或 ID 集合非空。
6. 核对本次问题的 ID/kind、关联节点或边、explanation/suggestion 已落地；同 ID 历史问题已有 kept/dismissed/author-decided 时，作者决定不得被候选 open 覆盖。问题证据从正式关联节点回查。
7. 链路 B 的夹具必须包含本次修订确实改变的旧证据，以及未受影响的对照事件。采纳后指定旧原点及关系仍可追溯，旧 ID/原引文/原 sourceHash 保留，失效对象、reason/expectedHash 符合正文变化；对照事件保持有效。不能仅证明旧夹具原来就有 stale，或把所有旧节点一律判失效。
8. 核验采纳结果正确后，再同库重启，复核上述同一组业务事实和作者决定，不能只比重启前后数量或快照自洽。

遵循既有 ID 与投影契约：原始草稿可能无 ID，新节点 ID 由 runtime 分配，同一事件可能复用历史 ID；根据明确事件/证据建立对应关系，不要求 raw draft ID、预览 ID 与正式 ID 无条件相等。历史原点身份必须稳定。预览 `origin.messageId`、展示层问题 evidence 不要求原样落盘；`stale.at` 时间戳可能重算，不作逐字相等判据。正式图允许保留历史数据、作者决定及新增派生问题，不要求与候选图全量相等。

### 验收本身的负向回归

在现有断言文件中复用一个直接服务于 A/B 的小型断言入口，新增 `desktop-app/tests/story-event-acceptance.test.mjs` 对**同一入口**做正负例；实际桌面链路必须调用它，不能写一套孤立测试却不接入真实验收。无需新依赖、通用框架或产品故障开关。

使用符合既有契约的明确夹具，至少验证：正常结果通过；只更新正文/accepted 而完全丢掉候选图必须失败；单独丢掉本次跨章边或本次问题也必须失败；链路 B 的作者决定被重置、应失效原点未失效分别触发失败。可用一个参数化用例实现。负向测试应成功捕获预期失败，测试命令本身正常退出；另保留既有进程失败注入，验证失败报告与非零退出链路。

正常端到端仍使用真实 UI、IPC、转换与持久化，模型响应可用已有替身；不能直接改 pending、revision、候选或正式图来制造成功结果。负向断言测试与正常桌面业务验证分开报告。

若加强断言后发现真实生产采纳缺陷，记录最小复现、候选/前后数据及归属模块，停止受影响链路并汇总。**本轮不授权修改采纳/修订业务引擎来让验收变绿**；不得通过削弱断言掩盖范围外问题。

## 允许修改范围与记录收尾

仅允许以下项目内文件及直接相关内容：

- `desktop-app/runtime/story-events.mjs`：仅 J1；`desktop-app/runtime/story-event-agent.mjs` 仅 J1 必要的原始序号映射配合，无需则不改。
- `desktop-app/tests/story-events.test.mjs`、`desktop-app/tests/story-event-workflow.test.mjs`，以及新增 `desktop-app/tests/story-event-acceptance.test.mjs`。
- `desktop-app/scripts/verify-story-events.cjs`、`desktop-app/scripts/verify-story-events.assert.cjs`、`desktop-app/scripts/verify-story-events.fixtures.cjs`、`desktop-app/scripts/verify-story-events.model-stub.mjs`：仅 J2 及其必要夹具、断言接线、报告。
- `desktop-app/docs/story-event-chain.md`、`desktop-app/VALIDATION.md`、本任务书执行附录、`desktop-app/verification/story-event-chain/round6/` 本轮证据，以及打包自动更新的 `desktop-app/package.json`、`desktop-app/package-lock.json`、`desktop-app/build-info.json` 与产物。

同步纠正两份文档仍引用第五轮旧报告/旧版本/待 pack 回填的内容：保留历史事实并明确更新，以最终实际运行与包版本为准。区分开发模式业务链路、打包产物展示验证及真实模型未验证的边界，不能单凭报告中来自 Info.plist 的 version 字段推断全部链路运行了哪份源码。

本轮不修改 `ChapterGeneration.tsx`、`Chat.tsx`、`StudioContext`、`electron/main.mjs`、`runtime/story-events-apply.mjs`、生成/修订/采纳引擎，不恢复已移除超时；不做新功能、无关重构、schema/数据库变更、依赖升级或安全审计。不修改 dsh/内阁/auto-workflow/供应商插件及全局权限，不调用真实供应商、不写正式作品、不 push、部署或向外发送消息。

## 分派、预算、停止条件与数据保护

首辅先核对现场代码、文档和 J1/J2 复现，再细分任务、建立任务板并分派。每份子任务书写明问题编号、文件归属、依赖/共享接口、交付物、验收命令、预算来源和停止条件、核验负责人；共享文件指定唯一协调负责人。成员须知晓并行工作，不覆盖或回滚他人成果。首辅独立核验，成员自报完成或清空任务板不等于验收通过。

预算沿用当前内阁实际配置，记录数值、单位和来源；未配置或不可读如实说明，不编造 token/金额/时间授权，不通过新增成员或重复失败操作绕过额度。超预算、需超范围修改、关键需求/接口矛盾或业务决策缺失、无法隔离正式数据、明确权限拒绝时，停止受影响任务并汇总，独立任务可继续。只有影响实现的需求矛盾或关键决策缺失时向用户提问；已授权的常规可逆工作持续完成。

正式作品只读：`/Users/shenjiaolong/Library/Application Support/novel-agent-studio/projects/de35f11a-11ec-4925-a8a2-8939f07b9883/project.json`。

review SHA-256：`5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。执行前后核对；开始时若有外部变化，记录现场值，不覆盖恢复。全部写入验收使用隔离作品库及模型替身，替身缺失必须失败，不能回落真实网络。只关闭自己创建的测试实例，不强制结束用户正在生成的应用。

## 验收与交付

在 `/Users/shenjiaolong/Documents/GitHub/novel-agent-studio/desktop-app` 执行并保留原始输出：

```sh
node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs tests/story-event-acceptance.test.mjs
npm test
./node_modules/.bin/tsc --noEmit
git diff --check
npm run pack
NOVEL_E2E_INJECT_LAUNCH_FAILURE=1 node scripts/verify-story-events.cjs
NOVEL_E2E_INJECT_FAILURE=case-04 node scripts/verify-story-events.cjs
node scripts/verify-story-events.cjs
```

两条进程注入命令预期非零退出，记录本次 runId、实际退出码与失败报告，不让预期失败中断后续正常验证。最后正常运行必须退出 0。本轮报告写入 round6，保留前轮证据；435 项存量测试不得无理由删除/跳过，原 28 项端到端验收意图不得弱化，重组时给出对应关系。

J1 必须有当前工作区修复前失败、修复后通过证据；J2 必须有正常采纳正例和错误图结果被拒的负例，随后完成两条真实桌面链路。任一必需项 fail/unverified/unresolved，或实际产品问题仍阻断，不宣布第一阶段通过。

按实际会话契约调用 `workflow_status` / `workflow_verify` 验证最终改动，原生测试与工具结果分开记录；工具故障保留原始错误，不修改插件或绕过门禁，不冒称通过。

按项目要求 pack 自动升级可见版本，核对最终源码指纹、工作区/包内 build-info、界面及关于窗口；未实测的展示如实标注。最终报告必须引用 pack 后对应版本的证据，不把中间 build 版本或作品 revision 当交付版本。

交付：J1/J2 修改摘要及实际文件清单；修复前后回归及负向验收证据；两链路候选 ID、采纳前预期、采纳后逐项核对及重启证据；全部命令/退出码与 workflow_verify 实际结果；正式作品前后哈希；完整版本与包路径；未完成/未验证项。更新 VALIDATION.md 的问题来源、文件、要点和实际验证结果。

完成后停止，交给 Codex 与用户 review；不自行 push、部署或进入下一阶段。

---

# 执行附录（第六轮实际执行记录）

> 本节为执行记录追加，**不修改上述任务书正文要求**。所有数字来自本轮实测日志与报告；未实测项在末尾单列。

## 一、最终交付

- 版本：`0.1.181+20261109.142212.073.8ec118fa8a38`；`sourceHash` `8ec118fa8a38`；`builtAtLabel` 2026-11-09 14:22:12 北京时间；`package.json` version `0.1.181`。
- 包路径：`desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`。
- 三处版本一致：工作区 `build-info.json`、包内 `app.asar` 的 `build-info.json`（逐字节相同，SHA-256 `a343b72171f2…f278`）、打包产物界面实测文本（主窗口 + 空态窗口）。

## 二、命令与退出码（均在 `desktop-app` 执行）

| # | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| 1 | `node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs tests/story-event-acceptance.test.mjs` | 135/135 pass，0 fail / 0 skipped | 0 |
| 2 | `npm test` | 451/451 pass，0 fail / 0 skipped（第五轮 435，净增 16） | 0 |
| 3 | `./node_modules/.bin/tsc --noEmit` | 输出 0 行 | 0 |
| 4 | `git diff --check` | 输出 0 行 | 0 |
| 5 | `npm run pack` | 自动递增至 `0.1.181` | 0 |
| 6 | `NOVEL_E2E_INJECT_LAUNCH_FAILURE=1 node scripts/verify-story-events.cjs` | 预期失败，runId `2026-11-09T06-22-48-734Z-19171-a46e5c` | 1（预期） |
| 7 | `NOVEL_E2E_INJECT_FAILURE=case-04 node scripts/verify-story-events.cjs` | 预期失败，runId `2026-11-09T06-22-52-707Z-19220-11ce08`，`pass=27 fail=1`，仅 `case-04(R4)` | 1（预期） |
| 8 | `node scripts/verify-story-events.cjs` | `status: passed`，runId `2026-11-09T06-27-45-158Z-21171-430071` | 0 |
| 8b | `env -u NOVEL_E2E_ONLY_CASES -u NOVEL_E2E_INJECT_LAUNCH_FAILURE -u NOVEL_E2E_INJECT_FAILURE node scripts/verify-story-events.cjs` | 根级证据对齐重跑：`status: passed`、28/28，runId `2026-11-09T06-43-21-893Z-29633-a000b5`，四份 judgement 45/90/75/150 全 0 失败 | 0 |

分文件测试数：`story-events` 43、`story-event-workflow` 55、`story-build-channel` 24、`story-event-acceptance` 13。

## 三、J1 证据

- 实现：`runtime/story-events.mjs:532-562` `assignHistoryNodes`，`:536-541` 按既有 `duplicateDraft`（`:199`）归并同批等价草稿，只有组内首条参与 `:542-560` 的全局一对一历史身份裁定。落点循环未改：`:605` 被拒草稿 `draftIds` 记 `null`、`:640` 复用（含重复项 twin）、`:662` 新建。
- 修复前失败（当前第五轮工作区，先加用例后运行）：`tests/story-events.test.mjs` → not ok H1-D「重复的 A 草稿不得占用递回事件的身份」，actual `['甲把钥匙交给乙','甲把钥匙交给乙']`，tests 43 / pass 42 / fail 1；`tests/story-event-workflow.test.mjs` → not ok I1-4「递回事件不得被重复的 A 草稿改写」，actual `甲把钥匙交给乙` / expected `乙把钥匙递给甲`，tests 54 / pass 53 / fail 1。
- 修复后：上述两文件 98/98 pass，exit 0；含 I1-5（草稿顺序 A、A、C，关系 2→3，端点真实落在交出事件与新建事件上）。
- 保留回归：历史只有 A 时重建补入 A/B、历史已有 A/B 时重抽与逆序稳定、改标题/actors 顺序复用 ID、同文本不同位置两节点、无效草稿过滤后关系序号不串位，均通过。

## 四、J2 证据

- 实现：`scripts/verify-story-events.assert.cjs:259-706` `evaluateAcceptance`，导出 `:709-716`；`scripts/verify-story-events.cjs:20` require，`:3504`（链路 A 采纳）、`:3634`（链路 A 重启）、`:4791`（链路 B 采纳）、`:4907`（链路 B 重启）四处调用，`:600-612` `applyAcceptance` 并入 runner。
- 本 run 判据数（失败均 0）：`chain1-accept` 45、`chain1-restart` 90、`chain2-accept` 75、`chain2-restart` 150。
- 负向回归：`tests/story-event-acceptance.test.mjs` 13/13 pass，对**同一入口**覆盖正常通过，以及只更新正文/`accepted` 丢候选图、单丢本次跨章边、单丢本次问题、链路 B 作者决定被重置、应失效原点未失效、`sourceHash` 单钉不一致分别必须失败。

## 五、完整桌面验收与只读保护

- runId `2026-11-09T06-27-45-158Z-21171-430071`，报告 `desktop-app/verification/story-event-chain/round6/e2e/runs/2026-11-09T06-27-45-158Z-21171-430071/report.json`：`status: "passed"`、`caseSummary { total: 28, pass: 28, fail: 0, unverified: 0, unresolved: 0 }`、`versionMismatch: null`、`pageErrors: []`。
- 根级证据对齐重跑 runId `2026-11-09T06-43-21-893Z-29633-a000b5`，报告 `desktop-app/verification/story-event-chain/round6/e2e/runs/2026-11-09T06-43-21-893Z-29633-a000b5/report.json`：`status: "passed"`、28/28、`versionMismatch: null`、`pageErrors: []`、`buildInfoVersion 0.1.181+20261109.142212.073.8ec118fa8a38`；四份 judgement 45/90/75/150，失败均为 0。本次重跑后 `round6/e2e/` 根级聚合报告与 11 张截图已与通过口径同源。
- 正式作品 `project.json` SHA-256 前后均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。
- 未执行 `reset` / `clean` / `checkout` 整文件恢复；第五轮未提交改动全部保留；未 push、未部署、未调用真实供应商。

## 六、证据覆盖事故（不可还原）

1. **round6 根级证据：最终同源，历史事故保留**。（a）最终状态：`round6/e2e/story-event-chain-report.json` 与根级 11 张截图现已与通过口径同源，runId `2026-11-09T06-43-21-893Z-29633-a000b5`，`status: passed`，28/28，`versionMismatch: null`，`pageErrors: []`。（b）历史事故（保留，不删）：中间曾有一次误触发运行 `2026-11-09T06-33-53-040Z-24965-c7d31e`（`status: failed`、`pass=23 fail=4 unverified=1`，唯一直接原因为链路 B 阶段 `page.evaluate: Target page, context or browser has been closed`）覆盖过根级文件；该失败 run 目录原样保留，可作为过程证据查阅。（c）认读规则：通过与否以 `runs/<runId>/report.json` 与 judgement 文件为准——`06-27-45-158Z-21171-430071` 与 `06-43-21-893Z-29633-a000b5` 两次通过，`06-33-53-040Z-24965-c7d31e` 为过程失败，不得计入通过。
2. 第五轮 `round5/e2e/` 根级 11 张截图与聚合报告已在本轮被覆盖、无 git 记录亦无副本、不可还原；覆盖物移入 `round6/e2e/overwritten-round5-root/`，第五轮原始 8 个 runId 目录未受影响。
3. `round6/e2e/runs/2026-11-09T06-10-50-052Z-9189-cba041` 为过程失败（误删 `const root` 致 `ReferenceError`），原样保留，不计为通过。
4. 终验过程事故：误用 `npx asar extract-file` 把内容写到 `desktop-app` 目录（已核实工作区 `build-info.json` 未被污染，改用 `@electron/asar` 只读提取复核）；误跑一次 `verify-story-events.cjs --help` 触发非预期运行（60s 转后台后 kill，`git status` 无新增）。

## 七、未验证项

1. 「关于」窗口未单独定位点击实测（`aboutPanelVerified` 为空）；界面版本证据来自主窗口与打包产物空态窗口实测文本。
2. 全部模型响应来自 `NOVEL_E2E_MODEL_STUB` 替身（脚本强制 `NOVEL_E2E_NO_NETWORK=1`、隔离库假密钥）；真实 GLM/MiniMax 未验证。
3. 用户当前已运行的桌面进程是否已升级到 `0.1.181` 未验证；未强制结束任何用户进程。
4. J1「修复前失败」原始日志未归档进仓库，仅由工部尚书以隔离副本自证、大理寺卿另以隔离副本复核；成员自报部分标未验证。
5. 产品侧是否仍存在其他缺陷：未验证。
