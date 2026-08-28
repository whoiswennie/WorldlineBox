# @deepseek-ai/dsh-headless

[English](README.md) | 中文

构建在共享 Cordis 基线之上的一次性 CLI Runner Bundle。

## 模型体验

无；Runner 将任务作为普通用户消息提交，请求组合仍由已挂载的 Bundle 负责。

#### KV Cache 影响

Runner 不增加独立前缀；缓存行为由选中的 Session、Prompt 与工具插件决定。

## 已知限制与延后工作

- **一次性运行时**——该 Bundle 有意省略交互式产品 Session 所需的 Host、HTTP、Desktop 与 Browser 层。
