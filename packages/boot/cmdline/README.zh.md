# @deepseek-ai/dsh-cmdline

[English](README.md) | 中文

Host 提供的不可变命令行参数，以及 Cordis 应用有界的进程退出集成。

## 模型体验

无；本包只在 Session 创建前保存启动参数快照并处理进程退出。

#### KV Cache 影响

不可变参数传递不增加模型请求 token，也不会使可复用 Prompt 前缀失效。

## 已知限制与延后工作

- **不可变快照**——Service 构造后，消费者无法观察 `process.argv` 的后续变化。
