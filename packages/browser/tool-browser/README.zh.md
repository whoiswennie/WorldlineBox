# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

Worldline 现有 Electron 内置浏览器的模型侧 `browser_control` 工具。它直接复用用户在“浏览器”页签中看到的会话浏览器标签页，并提供 27 个有界操作：标签页与导航、语义快照、HTML/文本读取、截图、JavaScript 执行、鼠标/键盘/表单交互、等待、控制台与网络诊断、DevTools，以及受保护的原始 CDP。

本包只在 `ctx.browserController` 可用时注册。截图只能写入当前 Session 工作区，结果有长度上限，不同 Session 的标签页彼此隔离，并禁止会绕过工作区边界的 CDP 下载路径命令。预设配置：

```yaml
- id: tool-browser
  name: '@deepseek-ai/dsh-tool-browser'
```

## 模型体验

模型会看到一个 `browser_control` schema，以及“先用 `snapshot` 观察、优先高级动作、等待加载完成、只把 `evaluate`/`cdp` 当作兜底”的提示。结果是有界 JSON，包含动作、可选标签页 ID/数据和当前标签页列表。
