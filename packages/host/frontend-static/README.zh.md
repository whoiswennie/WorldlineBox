# @deepseek-ai/dsh-host-frontend-static

[English](README.md) | 中文

带路径穿越拒绝和 Index 变换支持的静态 SPA Fallback 插件。

## 模型体验

无；本包只提供浏览器静态资源并变换 SPA Index 响应。

#### KV Cache 影响

静态 HTTP 响应不会进入模型请求，对 KV Cache 没有影响。

## 已知限制与延后工作

- **仅限 SPA 资源**——Fallback 不提供通用目录托管、动态渲染或应用 API Route。
