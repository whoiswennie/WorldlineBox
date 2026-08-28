# 浏览器包

[English](README.md) | 中文

浏览器域把与模型无关的 `ctx.browserController` 契约和模型侧 `browser_control` 工具分离。桌面 Host 复用 Worldline 中用户可见、对话自有的 Electron 标签页来提供该能力。

- [`browser`](browser/README.md)——能力类型与稳定动作词表。
- [`tool-browser`](tool-browser/README.md)——有界 Agent 工具、schema、提示词和输出策略。
