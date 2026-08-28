# `@deepseek-ai/dsh-llm`

[English](README.md) | 中文

本包拥有与 Provider 无关的模型词汇和 `ctx.llm` Service。Agent、Session、Prompt、Tool、Provider 与 UI 包依赖这套词汇，而不是某个具体 SDK。

Adapter 注册一个或多个 Provider Route。Route 注册与替换是原子 Effect，失败的候选实现不会留下空窗。一次模型调用只针对一个确切的 Adapter Generation 准备：模型元数据、输出默认值、推理强度与重试策略会一起解析，随后 Prepared Handle 只能流式执行一次。

Stream Protocol 保持模型输出结构化。文本、推理、Tool Call 参数、用量、Replay State 与终止 Finish Reason 始终是独立 Chunk。Adapter 选择、Iterator 构造、同步 Provider 失败与迭代失败都规范化为一个终止 `finish` Chunk；Middleware 与 Consumer 缺陷仍直接抛出。

Message 是不可变且带身份的值。Provider/Model 来源和 Replay State 保留在 Assistant Message 上。Loop 构建的请求会深度冻结并在进程内标记，所有模型可见字段都必须能在之后从 Session Event Log 重建。

`LlmRuntime` 是 Cordis Service。Provider 继承 `LlmAdapter`；策略包装 `llm/stream`；Consumer 调用 `prepareCall()` 并发送返回的、绑定到 Registration 的 Stream。任何 Consumer 都不直接实例化 Provider SDK。

## 模型体验

无；Registry 将已经组装的模型请求原样转交给所选 Adapter。

#### KV Cache 影响

中立 Runtime 不增加 Prompt Token；Adapter 选择决定 Provider Cache 命名空间与线上的缓存行为。

## 已知限制与延后工作

- **需要 Provider 实现**——本包定义路由与流式约定，但只有 Adapter 注册所请求的 Provider 和 Model 后才能执行模型调用。
