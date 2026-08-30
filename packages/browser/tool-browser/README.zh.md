# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

Worldline 现有 Electron 内置浏览器的模型侧 `browser_control` 工具。它直接复用用户在“浏览器”页签中看到的会话浏览器标签页，并提供 27 个有界操作：标签页与导航、语义快照、HTML/文本读取、截图、JavaScript 执行、鼠标/键盘/表单交互、等待、控制台与网络诊断、DevTools，以及受保护的原始 CDP。

本包只在 `ctx.browserController` 可用时注册。截图只能写入当前 Session 工作区，结果有长度上限，不同 Session 的标签页彼此隔离，并禁止会绕过工作区边界的 CDP 下载路径命令。预设配置：

```yaml
- id: tool-browser
  name: '@deepseek-ai/dsh-tool-browser'
```

在 Agent 作用域中，本包会屏蔽第三方插件继承进来的旧式 `browser_*` 命令，避免 Agent 操作另一套不可见的 Electron 视图、而用户看到的世界线浏览器仍为空白。其他第三方工具不会受到影响。

## 模型体验

### 浏览器控制

#### 模型看到的内容

模型会收到 [`browser_control` Schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser)，以及“先用 `snapshot` 观察、优先高级动作、等待加载完成、只把 `evaluate` 或 `cdp` 当作兜底”的提示。结果是有界 JSON，包含动作、可选标签页 ID/数据和当前标签页列表。

#### Token 影响

固定 Schema 与说明构成稳定的请求前缀成本；有界操作结果仅在调用后追加。

#### KV 缓存影响

工具契约保持前缀稳定；导航状态与操作结果不会重写该前缀。

## 已知限制与待完成工作

- 工具依赖 Worldline 的可见 Electron 浏览器 Provider；尚未实现 Headless 或远程浏览器 Provider。
