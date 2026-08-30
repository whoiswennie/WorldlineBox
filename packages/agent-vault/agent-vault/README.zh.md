# @deepseek-ai/dsh-agent-vault

[English](README.md) | 中文

与角色类型无关的 `ctx.agentVaults` 服务边界，统一管理可迁移 Agent 的自我模型、分阶段记忆、程序性经验、资源、治理、召回和整包迁移。语义真源必须是文件；实现可以维护可重建索引，但索引不能成为唯一真源。

服务严格分离 `self`、`memory`、`procedure` 和 `resource` 操作。普通召回不能搜索 `self`，每次语义写入都携带调用者、原因和可选 revision，由 Provider 在提交点强制执行权限。

## 模型体验

间接影响，通过挂载的 Vault Skill 与工具消费方产生。

#### KV 缓存影响

服务自身不添加前缀；消费方负责其渲染的有界后缀。

## 已知限制与待完成工作

- 静态加密策略仍由部署决定；可迁移包当前首先保证完整性。
