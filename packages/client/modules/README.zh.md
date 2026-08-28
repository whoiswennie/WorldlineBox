# @deepseek-ai/dsh-client-modules

[English](README.md) | 中文

双面 Client 模块图：Host 侧负责发现与打包，Browser 侧提供惰性模块表。

## 模型体验

无；模块加载器只发现并执行浏览器插件。

#### KV Cache 影响

Client 模块加载不组装模型请求，对 KV Cache 没有影响。

## 已知限制与延后工作

- **Web Client 格式**——浏览器入口必须符合生成的惰性 CommonJS 模块表；本包不在浏览器中加载任意原生或服务端模块。
