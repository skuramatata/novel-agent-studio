# 故事事件链第一阶段第七轮返修任务书

日期：2026-11-09，北京时间。

本轮仅完成 J2 剩余的两类验收缺口，编号 K1、K2。J1 已独立通过，事件合并实现不再修改。用户将配套话术交给内阁后，授权按下述范围修改验收脚本、直接相关测试和文档并打包；准备本文件不代表启动 dsh。本任务书无需读取聊天历史或临时脚本即可执行。

## 起点、资料与既有结论

- 项目：`/Users/shenjiaolong/Documents/GitHub/novel-agent-studio`；`/Users/shenjiaolong/Documents/GitHub/小说写作` 为同一目录别名。
- 分支：`v2`；HEAD：`dbda1a5aacca9443c9a183c252c4097afbe8d1ca`。
- **实际基线是该 HEAD 加当前第五、六轮尚未提交的改动**。当前完整版本 `0.1.181+20261109.142212.073.8ec118fa8a38`，源码指纹 `8ec118fa8a38`。编写任务书前，207 个已审查文件与最新 review 时一致。
- 当前的 runtime 修改、两个超时测试删除、事件/工作流测试修改、新增采纳验收测试及旧任务书均属于需保留的工作起点。执行前记录工作区和 diff，不 reset、clean 或整文件恢复至 HEAD；若已形成新提交，核对内容并记录实际基线，不重做已通过工作。

先读取 `/Users/shenjiaolong/.agents/AGENTS.md`、项目 `AGENTS.md`，以及以下项目文件：

1. `agent-design/story-event-chain-review-fix-stage-1-round6.md`：既有候选、采纳、证据与两条业务链路要求。
2. `desktop-app/docs/story-event-chain.md`、`desktop-app/docs/author-revision-workspace.md`：产品与接口契约。
3. `desktop-app/VALIDATION.md`：历史记录和本轮记录入口。
4. `desktop-app/runtime/story-events.mjs` 的 `impactOf`、`desktop-app/runtime/story-events-apply.mjs`、`desktop-app/electron/main.mjs` 相关采纳路径：仅用于只读核对既有契约，不获得修改授权。

本任务书的范围和验收要求优先，不继承旧轮全部修改授权。事件图仍由作者和模型共享；问题先展示原文、缺口、矛盾与建议，作者决定是否发起修订，正式正文只在采纳后更新。

已独立确认：J1 原重复草稿反例、连续重抽、无效/重复项混排及原始序号关系映射通过；451/451 测试、类型检查、diff 检查通过；完整桌面复跑 28/28、退出 0、版本一致。源码与包内文件一致，workflow_verify 通过记录已核实。旧“丢掉全部候选图仍通过”的主要缺口已补，但以下反例仍会误判通过，因此第一阶段尚未通过。

下列问题全部属于**验收判据/接线缺口**，不是已经复现产品采纳损坏。当前真实候选确有边和问题，不得写成“本轮实际候选丢边”。

## K1｜P2｜必需增量检查未接入桌面，跨章判据不完整

位置：`desktop-app/scripts/verify-story-events.cjs:3504`、`:3634`、`:4791`、`:4907` 的四个 `evaluateAcceptance` 调用；`desktop-app/scripts/verify-story-events.assert.cjs:272`、`:322`、`:531–556`；现有专用测试的 `baseInput`。

当前单测设置 `requireIncrements: true`，真实桌面调用及保存给重启复用的输入却未设置。候选只带事件而边/问题为空时，循环不执行，必需内容检查也关闭，仍可通过。另 `edge.cross` 只判一端历史 ID、一端新增 ID；现有“跨章边”单测正例实际上两端都属 c1。

独立反例：复用现有采纳验收夹具，按桌面实际入参关闭/省略 `requireIncrements`，清空 candidateEdges/candidateIssues，并让 after 只保留历史边/问题；新增事件和正文正确。当前 `evaluateAcceptance` 返回 ok=true。该情况不能满足本阶段含跨章关系和问题的验收要求。

要求：

1. A/B 的采纳后与重启后四处均启用相同的必需增量要求。若通过 `chain1AcceptInput` / `chain2AcceptInput` 保存输入再展开，必须保存标志，不能只修首次调用。允许最小集中复用，禁止新建通用配置框架。
2. 采纳前材料必须包含**本次实际被采纳候选**的事件、至少一条真正跨章关系、至少一条本次问题；A 链路不能用已放弃候选 A 的检查替代候选 B。
3. 关系 source/target 按既有候选→正式 ID 映射解析后，必须能找到两端正式节点，且 `chapterId` 不同；同时保留“一端为指定历史事件、另一端为本次候选事件”的判据。仅 ID 不同、标题不同、历史/新增身份不同均不能证明跨章。不要求所有候选关系都跨章，但规定的跨章关系必须真实存在并正确落地。
4. 修正正例为真实不同章节的端点，补同章“历史→新增”关系不能充当跨章关系的负例。候选材料无边、无问题时也必须失败，不能由空数组静默通过。
5. 正负回归使用与桌面相同的最终入参和断言入口，覆盖四处接线要求；不能继续只在单测手动开启标志而实际调用遗漏。保留已有整图丢失、单边/单问题丢失、作者决定和证据等负向检查。

上述必需非空要求只针对本轮刻意包含跨章关系和问题的验收夹具；产品中合法的零问题结果不变，不为凑数捏造无依据问题。

## K2｜P2｜已有失效冒充本次变化，历史关系缺少保留和失效核对

位置：`desktop-app/scripts/verify-story-events.assert.cjs:658–699`，以及主脚本 `:4693–4706` 的失效前置条件。

当前 changedCount 统计“采纳后失效的全部旧节点”，没有比较采纳前是否有效；主脚本还允许“原来已经失效 OR 任意候选正文变化”满足本次旧证据变化前置。历史节点有检查，历史关系没有相应保留/失效检查。

独立反例均直接调用当前真实断言入口，结果 ok=true：

- 把 before.chapters 设为已经修订后的正文，并令历史原点已 stale；本次候选不改变任何正文/旧证据，仍通过“本次修订确实改变至少一条旧证据”。
- 本次事件、候选边、问题均正确，只从 after.edges 删除一条未被其他问题引用的历史关系，仍通过。
- 历史关系仍在，但将其应有的 stale 清为 null，仍通过。

要求：

1. 链路 B 选定明确的历史原点：按**采纳前正文**校验证据有效，本次候选最终正文使该证据失效；只有这种有效→失效变化才计入“本次产生”。原来已经失效的节点可保留并核对，但不得满足新增失效前置。不得只检查“有正文改动”，必须证明改动涉及选定原点。
2. 在既有隔离夹具/模型替身中准备可完成这一过程的内容：选定旧原点、一条因该变化受影响的旧关系，以及仍然有效的对照事件/关系。通过真实 UI 修订和采纳产生变化；不能在流程中直接改盘或强行写 stale 制造成功证据。
3. 选定历史关系不由本次候选重新定义。采纳后核对其 ID、source/target/type/basis/explanation、原证据 chapterId/start/end/quote/sourceHash 保留，端点仍存在。缺边、错连、旧证据被替换都应失败，不能仅依赖问题恰好引用该边来间接检查。
4. 按现有 `impactOf` 契约核对历史关系的失效；随后同库重启复核同一组原点、关系和对照项。忽略 stale.at 时间戳，不要求全部旧关系失效，也不把所有可达下游无条件判 stale。

现有失效契约（只读核对，不能改 runtime 迎合断言）：

- 每份证据按 chapterId 查最终正文：无章节为 chapter-missing；sourceHash 等于最终正文哈希为有效；哈希变化但原 quote 仍在为 source-changed；quote 不在为 quote-missing。
- 关系自身任一证据失效，或者 source/target 任一节点失效，该关系才应 stale。
- 自身证据失效：按 evidence 顺序取第一份实际失效的证据，reason 为该证据原因，expectedHash 为该证据的旧 sourceHash。
- 仅端点失效、自身证据仍有效：reason 为 source-changed，expectedHash 为 `edge.evidence[0]?.sourceHash ?? ''`，不能拿端点节点的哈希代替。
- 关系证据和两端都有效：stale 必须为 null。`normalizeStoryEvents` 的暂存旧标记不能代替最终失效契约的验证。

补充最小正负回归：正常“有效→本次失效”及对照项通过；只有已有 stale、本次无旧证据变化必须失败；删除指定历史边、清空应失效旧边的 stale 分别失败；对照关系被误标失效也应失败。复用现有测试入口，不引入通用图验证框架。

加强断言后如暴露真实产品采纳问题，保留最小复现和采纳前/候选/采纳后数据，停止受影响链路并报告范围外问题。不得修改生产合并、采纳或修订逻辑，也不得削弱判据来通过。

## 修改范围与证据保护

仅允许修改：

- `desktop-app/scripts/verify-story-events.cjs`、`desktop-app/scripts/verify-story-events.assert.cjs`。
- `desktop-app/scripts/verify-story-events.fixtures.cjs`、`desktop-app/scripts/verify-story-events.model-stub.mjs`：仅 K1/K2 必要的隔离夹具和模型响应。
- `desktop-app/tests/story-event-acceptance.test.mjs`：仅 K1/K2 直接正负回归及实际接线核验。
- `desktop-app/docs/story-event-chain.md`、`desktop-app/VALIDATION.md`、本任务书执行附录、`desktop-app/verification/story-event-chain/round7/` 本轮证据；以及 pack 自动更新的 `desktop-app/package.json`、`desktop-app/package-lock.json`、`desktop-app/build-info.json` 和构建产物。

**不允许修改任何 runtime、electron 或 src 业务文件，包括已通过的 J1；不改已有事件身份测试，不恢复已撤出的全局超时。** 保留它们并运行必要回归即可。不做新功能、无关重构、schema/数据库变更、依赖升级或安全审计；不修改 dsh/内阁/auto-workflow/供应商插件、全局权限，不调用真实供应商、不写正式作品、不 push 或部署。

本轮产物只写 round7，报告、judgement 和截图明确绑定本次 runId；不得再写 round5/round6，也不得覆盖其他 run 的产物。此前第五轮根级截图损失已披露，本轮不尝试伪造、回填或清理历史证据。文档准确区分开发模式 Electron 的业务链路与打包产物展示验证，未实测的关于窗口/真实模型明确标注。

## 分派、预算、停止条件与数据隔离

首辅先核对代码、文档、四处接线和上述反例，再细分任务、建任务板并分派。每份子任务书写明 K 编号、文件归属、依赖与共享接口、交付物、验证命令、预算及来源、停止条件、核验负责人。共享文件指定唯一协调负责人，成员不得覆盖或回滚他人成果；首辅独立核验，不能只采信成员自报或任务板状态。

预算沿用当前内阁实际配置，记录数值、单位、来源；未配置或不可读如实说明，不编造 token/金额/时间额度，不通过新建成员或反复重试绕过预算。超预算、需超范围修改、关键需求/接口矛盾或业务决策缺失、无法隔离正式数据、明确权限拒绝时，停止受影响任务并汇总，独立任务继续。只有影响实现的需求矛盾或关键决策缺失时向用户提问；已授权的常规可逆工作持续完成。

正式作品只读：`/Users/shenjiaolong/Library/Application Support/novel-agent-studio/projects/de35f11a-11ec-4925-a8a2-8939f07b9883/project.json`。

review SHA-256：`5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。执行前后核对；开始时若有外部变化记录现场值，不覆盖恢复。全部写入验收使用隔离库与已有模型替身，替身缺失必须失败，不能回落真实网络。只清理自己创建的测试实例，不强制结束用户应用。

## 验收与交付

在 `/Users/shenjiaolong/Documents/GitHub/novel-agent-studio/desktop-app` 执行并保留原始结果：

```sh
node --test tests/story-event-acceptance.test.mjs
node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs
npm test
./node_modules/.bin/tsc --noEmit
git diff --check
npm run pack
NOVEL_E2E_INJECT_LAUNCH_FAILURE=1 node scripts/verify-story-events.cjs
NOVEL_E2E_INJECT_FAILURE=case-04 node scripts/verify-story-events.cjs
env -u NOVEL_E2E_ONLY_CASES -u NOVEL_E2E_INJECT_LAUNCH_FAILURE -u NOVEL_E2E_INJECT_FAILURE node scripts/verify-story-events.cjs
```

两条注入命令预期非零退出，记录实际退出码、本次 runId 和失败报告；勿让预期失败中断后续正常验收。最后完整运行才应退出 0。451 项存量测试及原 28 项桌面验收意图不得无理由删除、跳过或弱化；不以增加判据数量代替关键负例确实被拦截。

新负例先记录在当前实现上误判通过，再验证修复后明确拒绝；负向测试应正常捕获错误，测试命令本身退出 0。保留第六轮已有正负例，两条链路均须通过实际 UI、IPC、转换和持久化，四处采纳/重启判据启用一致。报告给出真正跨章端点 chapterId、选定旧原点的采纳前有效/采纳后失效证据，以及旧关系和对照关系的结果。

按当前会话契约运行 workflow_status / workflow_verify，原生测试和工具结果分开记录；故障保留原始错误，不改插件或绕过门禁。pack 自动更新可见版本，核对最终源码指纹、工作区/包内 build-info、界面版本；关于窗口未实测则明确标注。最终报告引用最终打包版本对应的运行，不用中间 build 版本或作品 revision 代替应用版本。

交付：K1/K2 修改摘要与文件清单；修改前误判/修改后拒绝的负例证据；四处接线核验；两链路候选 ID、跨章端点、旧原点/旧关系及对照项前后和重启结果；实际命令/退出码及 workflow_verify 结果；正式作品前后哈希；完整版本与包路径；未完成/未验证项。更新 VALIDATION.md 的问题来源、文件、修改要点和真实验证结果。

任一必需项未完成、未验证或失败，不宣布第一阶段通过。完成后停止，交给 Codex 与用户 review；不自行 push、部署或进入下一阶段。

## 执行附录（2026-11-09，第七轮实际执行记录）

本附录只追加，不改上方任务书正文。实际执行起点为 HEAD `dbda1a5aacca9443c9a183c252c4097afbe8d1ca` 加第五、六轮未提交改动；未 reset、未 clean、未整文件恢复。

### 分工与任务板

| 编号 | 任务 | 负责衙门 | 依赖 |
| --- | --- | --- | --- |
| T0 | 基线误判复现（K1/K2 反例在当前实现上误判通过） | 翰林院编修 | 无 |
| T1 | K1 四处接线 + 真实跨章判据 + 负例 | 工部尚书 | 无 |
| T2 | K2 本次产生失效 + 历史关系保留与失效核对 | 工部尚书 | T1 |
| T3 | 独立核验（四处接线、契约、额外变体、判据删除检查） | 大理寺卿 | T1、T2 |
| T4 | 文档收尾 | 左都御史 | T1–T3 |
| T5 | 证据路径由 round6 改 round7 并重跑完整验收 | 工部尚书 | 无 |

共享文件 `scripts/verify-story-events.cjs`、`scripts/verify-story-events.assert.cjs`、`tests/story-event-acceptance.test.mjs` 由工部尚书唯一写入；证据目录按成员分属。预算按任务书第 91 条与会话口径执行（简单 ≤30、多文件 ≤100 次工具调用；同一失败重试 ≤2 次）；当前内阁配置中未发现数值化 token／金额／时长额度，未编造。

### 结论

K1、K2 的判据与接线缺口已补齐，正负例经修改前误判、修改后拒绝两段验证，四处接线由执行方与核验方分别确认。完整桌面验收 28/28、退出 0。可交 Codex 与用户 review；本轮未 push、未部署、未进入下一阶段。

### 证据覆盖事故

修复证据路径前，首辅直接跑过一次完整验收，当时脚本仍硬编码 `round6/e2e`，覆盖了 round6 根级 11 张截图与聚合报告。第六轮历史 run 目录未受影响。随后改路径为 round7 并重跑，本轮全部证据落 `round7/`；被覆盖文件未回填、未恢复、未删除。事故与认读规则已记入 `desktop-app/VALIDATION.md` 第七轮小节。
