# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

由 Cordis 拥有的 HTTP/Upgrade Route Registry、Index 变换和 Fallback Seat。

## 模型体验

无；Server 传输浏览器与 API 流量，不组装模型请求。

#### KV Cache 影响

Route 注册与 HTTP 传输不增加模型 token，也不影响 KV Cache 复用。

## 已知限制与延后工作

- **传输原语**——TLS 终止、认证策略与外部可访问的部署拓扑必须由拥有它的 Host 应用提供。
