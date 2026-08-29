# @deepseek-ai/dsh-tool-agent-vault

[English](README.md) | 中文

面向模型的 Agent Vault 工具，覆盖快速记忆与能力方向、受限 Wiki 深挖、短期记忆即时写入、结构化自我查看和修改、检查点整理以及资源发现。运行时 Agent 必须先由 Host 绑定到唯一私有 Vault，模型不能自行选择其他 Agent ID。

## 模型体验

### 系统提示词

一个简短的方向说明解释领域边界和渐进式披露。

### 工具 Schema

挂载时提供十个固定 Schema。结果是有界 JSON 文本，携带 `vault://` URI、revision、分数和命中原因，不包含主机路径。

#### KV 缓存影响

Schema 和说明保持前缀稳定；数据相关工具结果追加在可复用前缀之后。

## 已知限制与待完成工作

- 二进制资源新增仍通过 UI/Host 上传流程完成，不提供 base64 模型工具。
