# @deepseek-ai/dsh-agent-default-model

[English](README.md) | 中文

未来 Agent 的默认 Provider、模型与推理强度选择。该配置由独立 Cordis Service 持有，并通过统一 Settings Provider 实时读取；Agent Loop 不硬编码具体模型。

## 模型体验

通过未来 Agent 请求所选择的 Provider、模型和可选推理强度间接影响模型。

#### KV Cache 影响

该 Service 不增加 token；改变选择会把后续请求路由到可能不同的 Provider Cache 命名空间。

## 已知限制与延后工作

- **延后可用性检查**——保存的 Provider、模型与推理强度标识在准备请求时由所选 Adapter 验证，而不是由本 Settings Service 验证。
