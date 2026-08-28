# @deepseek-ai/dsh-host-workspace-tree

[English](README.md) | 中文

产品工作区浏览器的可替换 Host 服务定义。它定义有界目录列表、文件名搜索结果、类型化预览、经过验证的变更和 `workspace-tree/changed` 通知。

Provider 必须把注册的工作区根目录视为权威边界，并保留读取与搜索的取消语义。该包不包含文件系统实现。

## 模型体验

### 工作区浏览器服务

#### 模型看到什么

什么也看不到：`WorkspaceTreeListing`、预览和变更属于 Host 到 Client 的值，不是 Agent 工具。

#### Token 影响

调用工作区浏览器服务不会增加模型请求 token。

#### KV Cache 影响

工作区树状态不参与模型 prompt 组装，对 KV cache 没有影响。

## 已知限制与暂缓事项

- **需要 Provider**：挂载且仅挂载一个兼容 Host Provider 之前，服务定义无法列出、预览、监视或修改工作区。
