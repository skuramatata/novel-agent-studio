# DeepSeek Issue 助手

自动化版本：1.0.0。

## 启用

1. 将 `.github/workflows/issue-assistant.yml`、`.github/issue-assistant.md` 和 `scripts/issue-assistant.mjs` 合入 GitHub 仓库默认分支。
2. 在仓库 Settings → Secrets and variables → Actions → Secrets 添加 `DEEPSEEK_API_KEY`。不要把密钥写入代码或 Issue。
3. 可选：在同页 Variables 添加 `DEEPSEEK_MODEL`，默认 `deepseek-v4-flash`。API 固定为 DeepSeek 官方 `https://api.deepseek.com/chat/completions`。
4. 确保仓库允许 Actions；新建一个真实使用问题，查看 Actions 中“DeepSeek Issue 助手”的运行和 Issue 中的评论。
5. 使用 `/ai 补充的问题或复现信息` 继续追问。普通评论不会调用模型。

官方接口资料：https://api-docs.deepseek.com/

## 行为与边界

新 Issue 自动回复；仅处理开放的 Issue，不处理 PR、机器人或普通评论。每个 Issue 最多发布 5 次自动回复，同一事件重跑不会重复发布。相同 Issue 的运行串行；GitHub concurrency 可能替换尚在等待的旧任务，因此密集追问不保证逐条回复。

使用 Node.js 22 内置 fetch，无需安装业务依赖。不执行 Issue 中的代码、命令或链接。读取默认分支触发时的代码，以当前提交 SHA 生成文件和行号链接。分析任务只读仓库；发布任务只有 Issue 写入权限，不持有 DeepSeek 密钥。

检索范围：根 README、docs、agent-design、desktop-app 的 README/docs/src/runtime/electron。仅允许 Markdown 和明确的源码扩展名，跳过符号链接和大于 600 KB 的文件；不会读取作品正文、环境文件、模型文件、配置和 GitHub 工作流。提供给 DeepSeek 的数据包括 Issue、最近 12 条评论和最多 8 个检索片段。私有仓库的命中代码也会发送给 DeepSeek，请按仓库的数据使用约定启用。

第一版使用关键词与中文双字检索，不是完整代码调用链分析。源码链接仅证明片段存在，不能证明 AI 结论正确；回复会注明未经维护者确认。模型没有执行、修改代码、关闭 Issue 或承诺修复的能力。

每次生成最多 2200 输出 token，单次请求 120 秒超时；失败不自动重试、不发布半成品，可在 Actions 修复配置后重跑。五次上限统计已发布评论；删除机器人评论会影响计数，失败请求仍可能计费。默认不设全仓每日预算，公网大量新 Issue 仍可能产生费用，可在模型平台配置额度并按需停用工作流。

## 验证与维护

本地执行：`node --test scripts/issue-assistant.test.mjs`。

上线验收：新 Issue 得到一条中文回复 → `/ai` 追问获得一条新回复 → 普通评论不调用 → 重跑同一任务不重复 → 第六次不调用 → PR 评论不触发。使用文档与源码中能找到答案的问题检查引用；依据不足时检查是否明确追问。

HTTP 401 检查 Secret，402 检查额度，429 检查频率，其他状态检查 DeepSeek 服务与模型可用性。日志不输出请求正文、响应正文或密钥。停用方式：Actions 页面选择工作流并 Disable workflow。
