# @deepseek-ai/dsh-client-ui-slots

[English](README.md) | 中文

浏览器 Cordis 插件共享的纯 UI Slot 内核。页面、布局、设置页、工具渲染器和蓝图编辑器都通过声明式 Slot 合约贡献组件；注册项归属当前 Fiber，插件卸载时精确撤销。

本包不拥有产品页面，也不依赖 Electron 或 Host 实现。React 只出现在类型边界和可替换的 renderer seam 中。

## 模型体验

无；Slot Registry 只组合浏览器侧 React Renderer。

#### KV Cache 影响

Slot 注册只改变 UI 组合，对模型请求和 KV Cache 没有影响。

## 已知限制与延后工作

- **进程内渲染**——贡献必须运行在同一个浏览器 Cordis Runtime 中；Registry 不为第三方组件提供 iframe 或 Worker 隔离。
