# @deepseek-ai/dsh-session-projection

[English](README.md) | 中文

Session 追加式事件日志的可重建投影注册表。领域插件贡献纯 Reducer 与序列化 Schema；投影不是事实源，注册与缓存均随 Cordis Fiber 生命周期卸载。

## 模型体验

无；Projection 向 Client 暴露派生读模型，不注册模型上下文。

#### KV Cache 影响

Projection 重建和缓存读取不会改变模型请求或 KV Cache 复用。

## 已知限制与延后工作

- **仅限日志派生状态**——Session 日志未记录的事实没有 Projection 值；消费者必须容忍缓存丢失后的重建。
