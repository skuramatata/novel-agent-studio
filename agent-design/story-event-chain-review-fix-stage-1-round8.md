# 故事事件链第一阶段第八轮返修任务书

> 本轮针对第七轮交付后的两处遗留问题：**L1 历史边 `sourceHash` 漏检**（验收判据假绿）与 **L2 最终源码指纹与交付版本不一致**（证据追溯问题）。两项均属验收/交付链路缺陷，不是已复现的产品采纳损坏。本轮未改 `runtime`、`electron`、`src` 业务文件，未改 `evaluateAcceptance` 签名，未放宽任何既有断言。

## 问题来源

### L1｜P2｜历史关系证据的 `sourceHash` 未被逐份比对

第七轮已把历史关系的 `preserved` 判据写进 `scripts/verify-story-events.assert.cjs`，但当时只做了两层检查：

- `assert.cjs:220-223` 的共用 `evidenceListKey` 只拼接 `chapterId|start|end|quote`；
- `:781` 随后仅校验 `typeof item.sourceHash === "string"`。

两者合起来能证明「证据四字段一致」与「`sourceHash` 是字符串」，却**从未证明 `sourceHash` 等于采纳前的原值**。因此单独把历史边证据的 `sourceHash` 替换成新正文哈希，判据仍返回 `ok=true`、`failures=[]`，属**假绿**。同文件 `:733-741` 的历史节点 `origin.<id>.evidence` 已正确写成 `evidence.sourceHash === node.evidence.sourceHash`，关系侧属同款遗漏。

### L2｜P2｜最终源码指纹与交付版本不一致

第七轮 `npm run pack` 之后又修改了验收脚本的证据输出路径与注释，导致包内指纹早于工作区最终源码：包内 64 个业务文件与工作区内容一致，但 `build-info.json` 的 `sourceHash` 不再对应最终工作区。这是**交付追溯问题**，不是运行期缺陷。

## 修改文件与要点

### L1｜`desktop-app/scripts/verify-story-events.assert.cjs`

| 位置 | 改动 |
| --- | --- |
| `:220-223` | 共用 `evidenceListKey` **未改动**，仍只比 `chapterId/start/end/quote` |
| `:225-236` | 新增局部专用 `historicalEvidenceListKey`：`JSON.stringify` 逐份映射 `chapterId/start/end/quote/sourceHash`，数量与顺序天然一致 |
| `:793/:794/:795` | `originEdge.<id>.preserved` 三层比较：先按 `evidenceListKey` 比四字段，再按 `historicalEvidenceListKey` 逐份比含 `sourceHash` 的全量，最后保留原 `typeof sourceHash === "string"` 校验 |

`sourceHash` 的期望值取自采纳前 `beforeFacts.edges`（原值），**不重算新正文哈希**；`evaluateAcceptance` 签名、生产采纳逻辑与既有断言强度一律未动。

### L1｜`desktop-app/tests/story-event-acceptance.test.mjs`

| 位置 | 内容 |
| --- | --- |
| `:738-767` | 夹具：`see-c1-c2-key` 历史边带真实 `sourceHash`；`staleEvidencedEdge` 按 `impactOf` 契约标 `source-changed`，`expectedHash` 取原 `sourceHash` |
| `:769` | 正例：含非空历史边证据的采纳 + 同库重启均通过，并断言 `after.`/`restart.` 两条 `preserved` 确实产出 |
| `:785` | after 负例：只改采纳后该边 `sourceHash`，必须由 `after.B.originEdge.see-c1-c2-key.preserved` 拦住，且不得由 `stale` 代为拦截 |
| `:809` | restart 负例：只改重启后该边 `sourceHash`，必须由 `restart.B.originEdge.see-c1-c2-key.preserved` 拦住，并断言 `after.*` 无失败 |
| `:835` | 候选材料正例：候选证据本就不含 `sourceHash`，仍须 `ok=true`，`after.B.edge.0.contract` 不得误报 |

负例断言 `ok=false`，测试进程本身退出 0（错误被正常捕获，不抛栈）。

### L2｜`desktop-app/scripts/verify-story-events.cjs`

| 位置 | 改动 |
| --- | --- |
| `:31-32` | 注释由「本轮（第七轮）」改为「本轮（第八轮）」，runs 路径 `round7/e2e/runs` → `round8/e2e/runs` |
| `:615-616` | 注释同步改为落 round8，`out` 目录 `round7/e2e` → `round8/e2e` |

仅路径与注释；业务流程、失败处理与断言零改动。

## 反例前后证据

### 修改前（假绿，实测）

`node /tmp/review-round8-k2-sourcehash.mjs` → `positiveOk=true`、`mutatedOk=true`、`failures=[]`，node 退出码 0。即历史边 `sourceHash` 被替换后仍被判为通过。

### 修改后

同一入口 → `mutatedOk=false`，node 退出码 1；该脚本末行断言 `rewritten old sourceHash is no longer accepted` 主动抛错，证明反例已被拦住。

大理寺卿独立脚本（`verification/story-event-chain/round8/l1-audit/audit-sourcehash.mjs`）四条对照精确命中：仅 `after.B.originEdge.see-c1-c2-related.preserved` 与 `restart.B.originEdge.see-c1-c2-related.preserved` 转红，`stale` 判据仍绿——说明失败来自目标判据本身，不是被其他判据顺带兜住。

### TDD 时间序（先红后绿）

| 时刻 | 事件 | 结果 |
| --- | --- | --- |
| 16:25:53 | 先写用例并跑测试（`l1-fix/red.log`） | `tests 30 / pass 28 / fail 2`，两条新负例失败，断言为 `true !== false` |
| 16:27:00 | `assert.cjs` 落盘修复 | — |
| 16:27:12 | 重跑测试（`l1-fix/green.log`） | `tests 30 / pass 30 / fail 0` |

RED 早于修复落盘的 mtime 可核，非事后补写。原 26 条既有用例在修改前后均通过，未被削弱。

## 命令与退出码

均在 `desktop-app` 执行：

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node --test tests/story-event-acceptance.test.mjs`（修改前，含新用例） | 30 tests / 28 pass / 2 fail | 1 |
| `node --test tests/story-event-acceptance.test.mjs`（修改后） | 30 tests / 30 pass / 0 fail | 0 |
| `npm test` | 468 pass / 0 fail（468 = 438 存量 + 30 本文件，本轮新增 4 条 L1） | 0 |
| `./node_modules/.bin/tsc --noEmit` | 无输出 | 0 |
| `git diff --check` | 无输出 | 0 |
| `grep -n "round[567]" scripts/verify-story-events.cjs` | 仅剩 `:615` 一行历史说明文字，无 round6/round7 写入目标 | 0 |
| 只读复算源码指纹（同 `stamp-version.mjs` 范围/排序/算法） | 149 文件，`ae4a146c6c8c`，与 `build-info.json` 一致 | 0 |

## 桌面验收与两个 runId 并存

最终通过 run：`2026-11-09T08-41-26-407Z-99069-5efe2f`

- `status: "passed"`、`caseSummary { total: 28, pass: 28, fail: 0 }`
- `versionMismatch: null`、`pageErrors: []`、`restartVerified: true`、`injection: null`
- `buildInfoVersion` / `uiVersion` 均为 `0.1.185+20261109.164106.316.ae4a146c6c8c`
- 四份 judgement 判据数 53 / 104 / 93 / 184，失败均为 0
- 报告：`desktop-app/verification/story-event-chain/round8/e2e/story-event-chain-report.json`；分阶段证据在 `round8/e2e/runs/2026-11-09T08-41-26-407Z-99069-5efe2f/`

**污染 run：`2026-11-09T08-35-09-924Z-95644-93aa40` 亦为 `status: "passed"`，但不计入通过。** 三条独立理由：

1. `package.json` 为 `0.1.184`，而该 run 的 `buildInfoVersion` 为 `0.1.183+20261109.163437.974.01e9e8af4119`，工作区版本文件本身处于错配状态；
2. `dist` 产物为 `index-CcCiUIrc.js`，而 pack 产物为 `index-DTKU4frZ.js`，即该 run 跑的不是同一份前端构建；
3. `versionMismatch` 为该 run 的假阴性——脚本 `:1043-1046` 只比较 `Info.plist` 与 `build-info.version`，两者同为 `0.1.183` 时即判一致，无法发现 `dist` 与包体不同源。

两个 run 目录**原样保留**、互不覆盖，读证据时以上述理由区分，不得只凭 `status: passed` 认通过。

## 版本与指纹

- 最终 `displayVersion`：`0.1.185+20261109.164106.316.ae4a146c6c8c`
- `sourceHash`：`ae4a146c6c8c`，按 `stamp-version.mjs` 相同范围（6 个根文件 + `src`/`runtime`/`electron`/`scripts`）与排序对 149 个文件只读重算，与工作区 `build-info.json` 一致
- `builtAtLabel`：2026-11-09 16:41:06 北京时间
- 版本五方一致：工作区 `build-info.json`、工作区 `package.json`、包内 `app.asar` 的 `build-info.json`、包内 `Info.plist`（`CFBundleShortVersionString=0.1.185`）、release version，均为 `0.1.185`
- 包路径：`desktop-app/release/NovelAgentStudio-darwin-arm64/NovelAgentStudio.app`
- 版本号由构建钩子生成，未手工写死

## 正式作品哈希

正式作品 `project.json`（`de35f11a-11ec-4925-a8a2-8939f07b9883`）SHA-256 本轮前后均为 `5c8687820d1d819d6b5cf5a994ab8d4024ea4688b52f19af2467b706f6fc4ec0`，未被本轮任何操作改写。

## 事故与越权写入（如实记录）

- **16:36:03**：大理寺卿为核验误跑 `npm run build`，其 `prebuild` 钩子（`stamp-version.mjs`）改写了 `package.json`、`package-lock.json`、`build-info.json` 三份版本文件。这是**越权写入**，已披露，未做回退；当时写入的值后续已被正常 `pack` 覆盖。
- **16:36:51**：`build-info.json` 的另一次回写，经首辅核定属左都御史 16:34 `pack` 的 `prebuild` 落盘时序，非第三方改写。
- 上述两项共同构成污染 run 的成因。事故现场与两个 run 目录一并保留，**不写成「仅注入项失败」**，也不伪造恢复。

## 预算实况

| 执行方 | 任务 | 工具调用 | 结论 |
| --- | --- | --- | --- |
| 工部尚书 | task-1、task-2 | 均未超 30 | 符合预算 |
| 大理寺卿 | 独立核验 | 36 次 | 超 30，已报备 |
| 左都御史 | 打包与验收 | 约 30 次内 | 符合预算 |

来源：本会话首辅令制第 5 条；dsh profile 未配置数值额度，未编造。

## 未完成 / 未验证项

1. **未真机人工目视核对界面版本**——仅由脚本断言 `uiVersion` 与 `build-info` 相等，无人眼确认界面右下角实际显示。
2. **未验证已打开的旧进程自动升级**——磁盘重新打包不影响运行中的进程，需重开应用；本轮未强制结束任何用户进程。
3. **污染 run 未重放复现**——三条判据（版本错配、dist 不同源、`versionMismatch` 假阴性）来自现场文件比对与脚本源码，未在隔离环境重新复刻该 run。
4. **round8 截图未逐张人工目视**——11 张截图由脚本产出并断言，未逐张人工核对。
5. **真实 GLM/MiniMax 未调用**——模型响应全部来自替身（`NOVEL_E2E_MODEL_STUB`），脚本强制 `NOVEL_E2E_NO_NETWORK=1`。
6. **未 push、未部署、未进入下一阶段。**
7. 产品侧是否仍存在其他缺陷：未验证。本轮只证明「修正后判据下 28 项全部通过」，不构成「产品无缺陷」的证明。

## P3 遗留

`scripts/verify-story-events.cjs:1043-1046` 的 `versionMismatch` 只比较 `Info.plist` 与 `build-info.version`。当两者同版但 `dist` 产物与包体不同源时，该判据**假阴性**——本轮污染 run 即为实例。本轮按纪律未改：它属于验收脚本判定逻辑，改动会牵动验收口径，应单独立项处理。

## 交付边界

本轮可交 review 的范围：L1 判据修复与其正负例、L2 证据路径隔离、最终版本与指纹一致性、两个 runId 的并存说明。超出此范围的产品行为结论一律不在本轮证明力内。
