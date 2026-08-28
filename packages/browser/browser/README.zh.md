# `@deepseek-ai/dsh-browser`

[English](README.md) | 中文

用于操控对话自有原生浏览器标签页的 Service Definition。契约只承载规范化浏览器操作和 JSON 安全结果；Electron 对象、CDP 传输、截图写入、标签页所有权和生命周期仍由 Provider 负责。

## 模型体验

无。本包声明 Host 能力；独立 Consumer 决定是否以及如何向模型公开。

## 已知限制与暂缓事项

- 当前契约面向可见的原生浏览器；尚未实现 Headless 或远程浏览器 Provider。
