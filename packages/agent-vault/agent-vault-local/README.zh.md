# @deepseek-ai/dsh-agent-vault-local

[English](README.md) | 中文

本地 `ctx.agentVaults` Provider 将语义真源保存到 `WORLDLINE_HOME/agents/v1`，SQLite FTS 只存在于每个 Vault 的 `.system` 中，并在真正提交变更的操作里强制执行领域、冻结、用户锁、revision、URI、符号链接和迁移包完整性检查。

## 模型体验

召回结合精确标题、别名、Canonical Tag、FTS 排名和字符 n-gram，不调用 embedding 模型或远程语义服务。

#### KV 缓存影响

有界召回使提示词规模不随 Vault 总量线性增长。

## 已知限制与待完成工作

- 迁移包加密仍由部署决定。
