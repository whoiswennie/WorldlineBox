# @deepseek-ai/dsh-session-title-llm

[English](README.md) | 中文

Session 标题 Provider 插件共用的模型生成策略。

## 模型体验

### 辅助标题请求

#### 模型看到什么

标题模型接收固定指令，要求使用消息语言返回一个简洁纯文本标题；随后是 `Generate the session title from this JSON array of human messages:` 与编码为 JSON 的所选人类消息。

#### Token 影响

该独立请求受 `maxInputBytes` 与 `maxOutputTokens` 限制；它不向主 Agent 请求添加 token。

#### KV Cache 影响

对于同一解析后的目标词数配置，系统指令保持稳定；JSON 包装的用户消息后缀随所选 Session 消息改变。

## 已知限制与延后工作

- **纯文本标题约定**——Tool Call、空输出、无效结束原因和达到 token 上限的输出都会被拒绝，而不是再次调用模型修复。
- **硬输入上限**——所选消息超过 `maxInputBytes` 时标题生成失败；本包不会对其总结或截断。
