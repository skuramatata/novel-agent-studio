# 故事事件链第一阶段第五轮返修任务书

日期：2026-11-08，北京时间。

本轮继续完成第一阶段，只处理最新独立 review 的 I1–I4。不依赖聊天历史或临时脚本。用户将配套话术交给内阁后，授权在下列范围内修改、补回归、更新文档并打包；本文件本身不启动执行。

## 基线与资料

- 项目：`/Users/shenjiaolong/Documents/GitHub/novel-agent-studio`。
- 别名：`/Users/shenjiaolong/Documents/GitHub/小说写作`，同一目录。
- 分支：`v2`。
- 基准提交：`dbda1a5aacca9443c9a183c252c4097afbe8d1ca`，`fix: 故事事件链第一阶段第四轮返修（H1-H7）`。
- 基准完整版本：`0.1.178+20261108.144107.762.9b9876ababae`。
- 编写本任务书前工作区干净；本任务书是本次交接新增文档，允许在交付中纳入。执行前重新记录 HEAD、分支及工作区变化，不覆盖他人修改。

先读 `/Users/shenjiaolong/.agents/AGENTS.md`、项目 `AGENTS.md`，以及以下真实文件（均相对上述项目根目录）：

1. `agent-design/story-event-chain-review-fix-stage-1-round4.md`：既有 H1–H7、数据与接口边界、两条验收链路。
2. `desktop-app/docs/story-event-chain.md`：事件、关系、证据、候选与持久化契约。
3. `desktop-app/docs/author-revision-workspace.md`：既有作者显式修订、草稿与采纳流程。
4. `desktop-app/VALIDATION.md`：改动记录；历史自述不得代替本轮实测。

本任务书的 I1–I4、范围和验收要求优先。上述文档中的“章节页候选死锁已确认”归因需要按 I2/I3 更正；通用自动修订能力不改变事件链的边界：本功能发现问题后标明原文、问题和修订建议，由作者决定是否发起修订，正式正文只在采纳时更新。已修好的 H2–H6 及其他既有行为继续保留，不继承旧任务书全部修改授权。

## 独立 review 的事实基线

- `npm test`：438/438 通过；TypeScript、`git diff --check` 通过。
- H2 启动异常注入实际退出 1，产生本次运行的失败证据。
- 原数量关系正反例转绿；源码、包内文件和构建指纹一致。
- 完整桌面验收实际退出 1：28 项中 25 通过、3 未验证，未验证项为 `chain1-accept`、`chain2-revise`、`chain2-accept-restart`。
- 已有图重建仍丢事件，见 I1。三项桌面未验证不能直接归因为产品死锁，见 I2/I3。未调用真实供应商，正式作品未改动。

## I1–I4 必修项

以下行号对应基准提交，修改时按当前调用链核对。对行为缺陷先建立能在基准上失败的回归，再修实现；不得靠换简单样例、手写正确输出或删除断言达成通过。

### I1｜P1｜历史节点被同一批两个不同事件重复占用

位置：`desktop-app/runtime/story-events.mjs:556–583`，关联 `sameEvent`、`draftIds` 与 `runtime/story-event-agent.mjs` 的关系映射。

可独立复现的输入：

- 单章 `{ id: 'h1', number: 1, title: '往返交接', content: '甲把钥匙交给乙，乙看过后把钥匙递给甲。' }`。
- 两个事件标题分别为“甲把钥匙交给乙”和“乙把钥匙递给甲”；均 `kind: 'handover'`、`actors: ['甲','乙']`、`objects: ['钥匙']`、`basis: 'narration'`、`sourceId: 1`，quote 共用整句，start=0，end=content.length。
- 第一次通过真实 `extractStoryEvents` 只返回交出事件，保存其 ID。
- 第二次把第一次的 `storyEvents` 传回同一真实抽取入口，返回上述两个事件，以及 `{ sourceId: 1, targetId: 2, type: 'state-transfer', basis: 'explicit', explanation: '交出后递回', evidenceSourceId: 1 }`。

当前结果：只剩“递回”一个节点，关系为空；两个草稿映射到同一历史 ID，使边变为自连。`historyNodes = [...nodes]` 仅浅复制；本批第一次匹配后的原地更新也会影响后续匹配。已有“空图同时抽两个事件”的通过用例不能覆盖这一缺陷。

要求：

1. 第二次抽取后保留两个不同节点及交出→递回关系，交出节点保留原 ID，不能被递回覆盖。
2. 历史身份匹配不得让本批两个已判定不同的事件复用同一历史身份；避免前一草稿写入污染后一草稿的历史匹配依据。说明最小匹配规则，不能仅新增一条特定措辞例外。
3. 重复执行相同重建不得继续增生节点；历史已含两节点时再次抽取，两节点及关系端点保持稳定。调整输入顺序并同步关系序号后也不得换指，不能把数组顺序直接当永久身份。
4. 保留同一事件改写标题、actors 顺序变化复用 ID，以及同文本不同发生位置分成两节点、无效草稿过滤后原始序号映射正确等已修行为。真正重复的草稿仍应正确去重。
5. 将关键输入和断言纳入仓库测试，覆盖真实抽取→合并→关系映射，不只测内部计数。继续使用既有 schema；不引入通用 NLP、方向词库或新的模型调用。

### I2｜P2｜链路 A 实际执行顺序错误，误报候选死锁

位置：`desktop-app/scripts/verify-story-events.cjs:2566` 附近的 `chain1-accept`、2577 附近候选清理，以及 2789 附近才执行的 `chain1-abandon`。

当前实际顺序是生成→预览→再次生成/采纳→放弃，虽注释说“上一轮候选已放弃”，实际尚未执行；清理还保留 `generatedCandidateId`。旧 pending 合理阻止再生成，不能由此推断产品死锁。独立 review 中该候选确实包含第三章正文变化，随后真实放弃操作也成功。

要求：

- 真正执行“生成候选 A→预览 A→放弃 A→读盘确认 A 已拒绝且正式正文/图未污染→生成新的候选 B→预览 B→采纳 B→同库重启核对”。修改代码执行顺序，而不只是调整 CASE_PLAN 或注释。
- A、B 均来自本次真实生成，记录各自 ID，断言 B 与 A 不同；按钮选择绑定对应候选，禁止点任意第一个“采纳/放弃”。
- 前置不成立时保留实际 pending ID、状态、目标章节差异、任务终态和错误，不把原因写死成产品缺陷。
- 保留真实建图按钮、当前画布、共享 revision、保存设定、空补全不写版本、部分补全与主动重建请求、请求含历史 ID/原文、候选跨章边/问题/证据等已有验收意图。

### I3｜P2｜链路 B 绕过共享状态，未验收真实保存与显式修订

位置：`desktop-app/scripts/verify-story-events.cjs:3246`、3303–3318、3345–3393；并核对 F9/F10 与 chain2 用例之间的数据和候选依赖。

当前脚本通过 `window.studio.load/save/generate` 改 pending 状态、取最新 revision 再生成，绕过界面共享状态；随后返回 UI 清理时可能仍面对旧状态。清理只选择第一个“放弃候选”，忽略部分等待失败，又把原因固定写为 ChapterGeneration 无差异死锁。“没有出现版本冲突文本”也不能证明保存与生成成功。

要求：

1. 同一会话中通过真实界面完成“问题证据→作者保留/驳回/裁定→保存→下一次生成”，不靠 reload 或读盘取得新 revision 作为后续写入参数来掩盖状态不同步。断言操作成功及 revision 对应关系；生成以明确成功终态和真实候选为证，其他错误不能算通过。
2. 通过实际输入框/按钮提交显式修订要求，等待真实草稿/候选形成，记录该次候选 ID；预览正文、事件、跨章关系、问题和出处，未采纳前正式正文不变；采纳同一 ID 后同库重启，核对正文、图、问题、作者决定与原点失效标记。
3. 理顺 F9/F10 与链路 B 的依赖，避免前置用例留下未处理候选又重复发起任务。需要清理时只通过对应候选的真实 UI 操作，验证操作确已完成；必要时使用已有“创作对话”处理入口。不要因章节页不显示某按钮就断言整个产品无入口。
4. 轮询必须处理成功、失败和超时，失败留证，不能忽略返回值；不等错误 selector 超时后猜测成功，也不靠任意延长等待来遮盖错误顺序。
5. 隔离夹具初始化、模型响应替身、只读 IPC/磁盘断言可以保留；两条连续链路中的保存、生成、拒绝、采纳和修订必须经过真实用户入口。禁止直接改 pending/revision、手写候选或调用写入 IPC 替代业务步骤。
6. 更正 `desktop-app/VALIDATION.md` 和 `desktop-app/docs/story-event-chain.md` 中“章节页死锁已确认、缺陷不在验收脚本”等表述。区分已确认的脚本问题、仍待验证的产品问题和本次最终结果，不改写历史原始报告冒充新证据。

本轮不授权修改 `ChapterGeneration.tsx`、`Chat.tsx`、`StudioContext` 或生成/修订业务引擎。若修正脚本后独立复现真正产品问题，保留最小复现和现场证据，停止受影响链路并提交范围外问题；不要凭旧报告直接改产品。

### I4｜P2／范围｜精准移出第四轮额外加入的全局超时

位置：`desktop-app/runtime/chapter-agent.mjs` 的默认 120 秒检索等待，以及 `desktop-app/runtime/structured-step.mjs` 的默认 30 分钟模型调用等待。

这两项不属于 H1–H7，现场卡死根因也未坐实；本轮明确选择将其移出阶段交付，不再继续设计超时策略，不宣称已复现新的超时运行时缺陷。

- 以 `01ac52ef8bfe2aa54e31a0ddd2e4ee3ba03c656e..dbda1a5aacca9443c9a183c252c4097afbe8d1ca` 的 diff 为依据，仅撤出这两文件由第四轮新增的 timeout 包装、默认值及专用注入参数，保留此前正常生成、取消、追踪和恢复逻辑。
- 移除仅为这两项新增的 `desktop-app/tests/chapter-retrieval-stall.test.mjs`、`desktop-app/tests/structured-call-stall.test.mjs`，同步更正文档。若执行时这些文件已有他人后续改动，先识别归属，不能整文件覆盖。
- 不 revert 整个第四轮提交，不回退 H1–H7 其他修复，不删已有测试来掩盖失败。
- 上述两个专用文件各有 3 个测试，撤出共 6 项，因此基准 438 → 432，新回归另计。交付列出移除与新增用例数及原因，不机械追求保留 438，也不减少其他存量测试。

## 允许修改范围与排除项

项目根目录下仅允许：

- `desktop-app/runtime/story-events.mjs`；`runtime/story-event-agent.mjs` 仅 I1 直接需要的端点映射配合。
- `desktop-app/tests/story-events.test.mjs`、`tests/story-event-workflow.test.mjs`，以及必要的专用事件身份/验收脚本回归文件。
- `desktop-app/scripts/verify-story-events.cjs`、`verify-story-events.assert.cjs`、`verify-story-events.fixtures.cjs`、`verify-story-events.model-stub.mjs`，仅 I2/I3 与保留原验收语义所需修改。
- I4 指定的两个运行时文件和两个专用测试，仅用于精准撤出超范围改动。
- `desktop-app/docs/story-event-chain.md`、`desktop-app/VALIDATION.md`、本任务书执行附录、`desktop-app/verification/story-event-chain/round5/` 本轮证据，以及打包自动更新的 `desktop-app/package.json`、`desktop-app/package-lock.json`、`desktop-app/build-info.json` 与构建产物。不得增加无关依赖。

不做新功能、无关 UI/架构重构、schema/数据库变更、全面依赖升级或安全审计；不修改 dsh、内阁、auto-workflow、供应商插件和全局权限；不调用真实模型，不写正式作品，不部署或 push，不向外发送消息。常规可逆修正按已授权范围完成，不重复请求确认。

## 分派、数据保护、预算与停止条件

首辅先核对代码、文档和本轮复现，再细分任务、建任务板并分派。每份子任务书写明 I 编号、文件归属、依赖及共享接口、交付物、验收命令、预算及其来源、停止条件、核验负责人。共享文件指定唯一协调负责人；所有成员须知晓并行工作，不覆盖或回滚他人成果。首辅负责独立核验，成员自报完成或任务板清空不等于验收通过。

预算沿用当前内阁实际配置，记录数值、单位和来源；未配置或不可读如实写明，不编造 token、金额或时间授权，不新建成员或重复失败操作绕过额度。超预算、需要超范围修改、关键需求/接口矛盾、缺失业务决策、无法隔离正式数据或明确权限拒绝时，停止受影响任务并汇总；独立任务可继续。只有影响实现的需求矛盾或关键决策缺失时向用户提问。

正式作品只读：`/Users/shenjiaolong/Library/Application Support/novel-agent-studio/projects/de35f11a-11ec-4925-a8a2-8939f07b9883/project.json`。

review SHA-256：`5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`。执行前后核对；开始时若已变，记录现场值与外部变化，不覆盖恢复。所有写入验收使用隔离作品库与既有模型替身；替身缺失必须失败，不能回落真实网络。只清理自己创建的测试实例，不强制关闭用户应用。

## 验收命令与交付

在 `/Users/shenjiaolong/Documents/GitHub/novel-agent-studio/desktop-app` 执行并保留原始输出：

```sh
node --test tests/story-events.test.mjs tests/story-event-workflow.test.mjs tests/story-build-channel.test.mjs
npm test
./node_modules/.bin/tsc --noEmit
git diff --check
npm run pack
NOVEL_E2E_INJECT_LAUNCH_FAILURE=1 node scripts/verify-story-events.cjs
NOVEL_E2E_INJECT_FAILURE=case-04 node scripts/verify-story-events.cjs
node scripts/verify-story-events.cjs
```

两条注入命令预期非零退出；分别记录实际退出码、本次唯一 runId、原始错误及失败报告。不要让命令串因预期失败跳过后续正常验收。最后正常运行才应退出 0。本轮证据落在 `verification/story-event-chain/round5/`，保留每次运行的报告；旧轮次证据不覆盖。

I1 新回归先确认在基准失败、修改后通过。I2/I3 必须完成两条真实连续链路；原 28 项的验收意图不能删除、跳过或弱化，若重组步骤，列出对应关系。正常报告不得仍有必需项 fail/unverified/unresolved，页面异常需明确处理；任何未验证项都不能宣称第一阶段通过。

使用 `workflow_status` 核对当前会话实际契约，按正常权限调用 `workflow_verify` 验证最终改动。原生测试与工具结果分开记录；工具故障保留原始错误和 blocker，不改插件、不绕过门禁，不冒称工具通过。

按项目规则执行 pack 更新可见版本，核对源码指纹、工作区 build-info、包内 build-info、界面与关于窗口使用一致的完整版本；未实测的展示明确标注。不要手写版本或用作品 revision 代替应用版本；不为更换运行版本而结束用户正在生成的进程。

交付必须包含：

1. I1–I4 逐项修改摘要、实际文件清单与完成状态。
2. I1 修改前失败、修改后通过的回归证据；保留其他已修项的结果。
3. 两条链路的候选 ID、实际操作顺序、正文/图/revision 前后与重启证据；异常注入退出码及本次报告。
4. I4 撤出范围、测试数量变化及原因；更正后的诊断，不把猜测写成结论。
5. 全部实际命令结果、workflow_verify 现场结果、正式作品前后哈希。
6. 完整应用版本、包路径，未完成/未验证项及真实模型未验收的边界。

更新 `VALIDATION.md` 记录问题来源、修改文件、修改要点和验证结果。完成后停止，交给 Codex 与用户 review；不自动进入下一阶段，不自行 push 或部署。
