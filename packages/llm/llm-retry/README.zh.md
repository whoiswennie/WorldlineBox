# @deepseek-ai/dsh-llm-retry

[English](README.md) | 中文

Provider 路由感知的模型请求恢复插件。它在 Agent 的 request-error 扩展点执行 Provider 自己声明的退避策略，并在等待前把 retry 事件写入 Session，因此重试决策可审计、可恢复且能被取消。

## 模型体验

### 重试主请求

#### 模型看到什么

同一份已经组装的请求会再次发送；`llm/retry` 与 `llm/retry-started` 事件是持久控制记录，不会添加 Prompt 文本。

#### Token 影响

每次尝试都会重新发送请求 token，并可能生成新的输出 token；重试策略本身不贡献上下文 token。

#### KV Cache 影响

未变化的重试保留原始前缀与路由，因此可能复用 Provider 侧前缀缓存；缓存可用性与淘汰仍由 Provider 决定。

## 已知限制与延后工作

- **需要 Provider 策略**——所选 Adapter 未声明重试策略或错误码不可重试时，失败会交给其他恢复处理器。
- **进程内等待**——持久事件记录重试决策，但进程重启不会恢复只进行了一部分的退避计时。
