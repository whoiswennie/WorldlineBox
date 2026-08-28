# @deepseek-ai/dsh-session-title

[English](README.md) | 中文

Cordis Session 标题 Service、确定性 Fallback、事件日志 Projection 与 Provider Registry。

## 模型体验

### 标题 Provider 调度

#### 模型看到什么

无直接内容：`ctx.sessionTitle` 选择 Provider 并记录规范化标题状态；模型支持的 Provider 拥有任何辅助请求。

#### Token 影响

该 Service 与确定性 Fallback 不增加模型 token；辅助 Provider 分别核算自己的独立输入与输出。

#### KV Cache 影响

标题状态从不改变主 Agent 前缀；任何辅助标题请求都拥有独立的缓存生命周期。

## 已知限制与延后工作

- **受注册 Provider 作用域限制**——自动生成受活动 Provider 的节奏与来源消息选择约束；该 Service 不合并相互竞争的 Provider 结果。
- **规范化边界**——标题会收敛为一行安全的非空文本，因此无法保留富格式和多行标签。
