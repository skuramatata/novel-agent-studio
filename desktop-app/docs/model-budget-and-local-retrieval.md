# 模型预算、分批审稿与本地混合检索

实现日期：2026-09-09。当前源码以本文件描述的新流程为准；旧任务与旧文档中的固定60,000预算保留作历史证据。

## 模型和请求预算

`model-capabilities.mjs` 区分模型上下文、模型输出上限、接口独立输入/上下文限制和应用预算。GLM-5.2 内置官方1M/128K规格，应用预算默认120,000；MiniMax-M3按官方最低512K窗口、24,000保守输出回退及120,000应用预算配置。模型介绍不证明当前套餐入口权限；未单独核实的部分在界面和日志明确标注。未知模型回退60,000/24,000。

模型连接的“Token预算”允许覆盖上述数值，按供应商、接口、模型和思考模式绑定；切换模型/接口会清空表单覆盖值。配置由主进程校验并保存，不保存在作品正文内。输出仍按任务需要申请，受模型上限约束；MiniMax适配器使用`max_completion_tokens`，GLM使用`max_tokens`。

计数继续采用o200k_base代理估算与至少25%余量，结合实际usage向上校准。计数不是供应商官方tokenizer。最终消息（系统指令、材料、问题、纠错历史）与输出预留一并核算；供应商拒绝上下文时显示独立错误，不自动推断更大的窗口或更换计费入口。

## 分批审稿与局部修订

`review-context.mjs`按实际消息预算装配审稿文档。整份材料在阶段软额度内时沿用完整请求；超过时，若当前章可以完整装入，就每批共享当前章、只轮换历史原文；否则按段落分片，组合检查当前章段落与其余已提供原文，覆盖跨场景和历史证据。每个当前段落与所有已提供段落至少共同出现在一批中。数量可能随材料增加，因此每次调用总预算与超时仍有效；中断后复用已成功批次。

每批保留原始文档版本、sourceId、段号、句号和来源哈希，校验引用必须在该批实际可见范围中。所有批次完成才汇总为一次完成的审稿。未见前情只能对当前覆盖范围陈述；不能将某批检索未见提升成全书不存在，也不能直接删除事实。

依据核对、裁决、补丁和复核按问题组执行。预算按最终发送的消息计算，包含工作流指令、字段表和实际传输字段，不重复计入本地问题快照中的引文。明确引用和作者裁定的原文必需保留；邻段优先装入，其余原文按问题关键词回查，均受阶段额度与模型输入硬上限约束。

共享修改段落的问题优先保持一组。依据核对、裁决与复核超限时可继续按问题拆批；生成补丁仍保留关联组，避免同一段得到互相覆盖的替换。所有批次在首个请求前完成预算预检，单个问题或不可拆的补丁组超限时报告问题编号与估算，不把重复点击恢复当作解决方式。模型只见局部视图，补丁仍针对完整文档版本校验，未授权段落保持不变。补丁提交后仍重新审稿。批次缓存保存模型原始结构，恢复时重新校验，避免将转换后的领域对象误当模型输出。

单个超长段落或不可拆的必需证据本身超过预算时仍明确停止，不静默裁短原文。分批增加部分调用次数；语义判断仍可能漏报或误报，不代表全书文学质量保证。

## 本地向量索引

每部作品目录的`retrieval.sqlite`保存已采纳正文的片段、原文偏移、章节、哈希、Embedding标识和向量。SQLite存储、JavaScript精确向量相似度排序与关键词评分融合；当前不使用近似向量索引，也不需要数据库服务。

Embedding使用`Xenova/paraphrase-multilingual-MiniLM-L12-v2`，固定revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`，ONNX q8、mean pooling、384维归一化向量。模型随安装包提供，运行时禁止远程模型下载，正文不会为Embedding上传。模型是上游Apache-2.0许可，出处和文件SHA-256记录在`models/manifest.json`及`models/UPSTREAM-README.md`。

索引片段用于匹配，模型上下文回填命中段落的完整当前原文。多个片段命中同段只放一次，再按Token额度装入。查询限定projectId、此前章节、当前sourceHash及Embedding版本；章纲、候选、别部作品、未来章与过期正文不进入正式检索。索引按章事务更新，可中断恢复，能由原文重建。切换写作模型无需重建，Embedding变化需重新索引。

新章节任务与“整理全部记忆”自动维护索引，创作日志显示片段数、检索数量和预算。后续记忆优化采用按章增量更新、多路按记录召回和原文复用；当前交付以新数据、新任务为范围，详见[分层记忆与增量更新](layered-memory-and-incremental-updates.md)。

## 验证入口

- `npm test`：模型预算、作品隔离、版本/偏移、检索预算、审稿覆盖、未见引用拒绝、批次恢复和补丁约束。
- `node scripts/verify-repair-budget-recovery.mjs 快照目录 [--live]`：快照目录包含 `project.before.json` 与 `chapter-task.before.json`。`--live` 使用任务原供应商，最多八次依据核对调用，至作者等待或补丁入口停止；默认按该目录 `live/requests.json` 重放并逐字比较请求。不改写正式作品，不代表整章完成。
- `node scripts/verify-context-memory.mjs 作品JSON [--live]`：在独立目录运行真实本地Embedding并组装审稿请求；`--live`最多两次真实模型审稿调用，仅验证第一批协议，不采纳或改写输入作品。
- `node scripts/verify-context-memory-desktop.cjs`：打包应用中的真实IPC、预算设置/重启、真实本地向量推理、章节候选与采纳；写作模型使用明确的测试响应。
- `npm run prepare:embedding`：开发机缺少模型文件时，下载固定revision并核对已登记SHA-256。
- `npm run pack`：打包前验证模型文件，模型放在Resources/models，原生推理库从asar解包。构建指纹包含模型清单。

具体计数、版本和验证边界见`verification/context-memory-v3/`。

来源：[GLM-5.2](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)、[MiniMax M3](https://www.minimax.io/models/text/m3)、[MiniMax兼容参数](https://platform.minimaxi.com/docs/api-reference/text-openai-api)、[本地推理](https://huggingface.co/docs/transformers.js/tutorials/node)、[Embedding模型](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)。
