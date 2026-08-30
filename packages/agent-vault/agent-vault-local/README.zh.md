# @deepseek-ai/dsh-agent-vault-local

[English](README.md) | 中文

本地 `ctx.agentVaults` Provider 将语义真源保存到 `WORLDLINE_HOME/agents/v1`，SQLite FTS 只存在于每个 Vault 的 `.system` 中，并在真正提交变更的操作里强制执行领域、冻结、用户锁、revision、URI、符号链接和迁移包完整性检查。

## 模型体验

间接影响，通过挂载的 Vault Skill 与工具消费方产生。

#### KV 缓存影响

存储 Provider 不添加前缀；消费方负责其渲染的有界召回结果。

## 已知限制与待完成工作

- 迁移包加密仍由部署决定。
