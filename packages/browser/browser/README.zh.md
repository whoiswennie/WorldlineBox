# `@deepseek-ai/dsh-browser`

[English](README.md) | 中文

用于操控对话自有原生浏览器标签页的 Service Definition。契约只承载规范化浏览器操作和 JSON 安全结果；Electron 对象、CDP 传输、截图写入、标签页所有权和生命周期仍由 Provider 负责。

## 模型体验

间接影响，通过另行挂载的浏览器工具消费方产生。

#### KV 缓存影响

Host 能力自身不添加模型前缀；其消费方负责所有 Schema 与结果 Token。

## 已知限制与暂缓事项

- 当前契约面向可见的原生浏览器；尚未实现 Headless 或远程浏览器 Provider。
