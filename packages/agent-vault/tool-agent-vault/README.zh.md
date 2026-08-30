# @deepseek-ai/dsh-tool-agent-vault

[English](README.md) | 中文

面向模型的 Agent Vault 工具，覆盖快速记忆与能力方向、受限 Wiki 深挖、短期记忆即时写入、结构化自我查看和修改、检查点整理以及资源发现。运行时 Agent 必须先由 Host 绑定到唯一私有 Vault，模型不能自行选择其他 Agent ID。

`resource_find.roles` 是“满足任一项”的列表：同时请求 expression、appearance、source 和 attachment 时，会返回具备任一所请求角色的资源。私有结果与公共结果会合并，但不会因此开放其他 Agent 的私有 Vault。

## 模型体验

### Vault 定位与操作

#### 模型看到的内容

一个简短的方向说明解释领域边界和渐进式披露。十个固定 Schema 返回有界 JSON，携带 `vault://` URI、revision、分数和命中原因，不包含主机路径。

#### Token 影响

方向说明与十个 Schema 构成固定的请求前缀成本；数据相关且受长度限制的工具结果在会话中追加。

#### KV 缓存影响

Schema 和说明保持前缀稳定；数据相关工具结果追加在可复用前缀之后。

## 已知限制与待完成工作

- 二进制资源新增仍通过 UI/Host 上传流程完成，不提供 base64 模型工具。
