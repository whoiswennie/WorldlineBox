# @deepseek-ai/dsh-host-desktop-browser

[English](README.md) | 中文

用于对话自有 Electron 浏览器标签页的桌面专属 Host 适配器。它验证回环桥接环境，通过 `host-webserver` 暴露用户浏览器操作，发布底层 `electronViewHost`，并提供第一方 `ctx.browserController` CDP 自动化能力。同一路由会为无法承载 Electron 原生覆盖层的 Worldline 客户端提供有界 JPEG 合成帧，并转发归一化的预览输入。用户切换会话或应用页面时会保留原生视图，同时通过最多八个会话的最近最少使用缓存和每个会话十二个标签页的上限控制内存占用。网页请求 HTML 全屏时会使用完整 Electron 内容区，退出后恢复到中间栏上报的边界。

工作区本地页面使用不透明路由 token 和 realpath 包含性检查。只有所选工作区内的 HTML 入口文件可以打开，交付前每项引用资源都会对同一规范根目录重新检查。

CDP 动作词表与诊断设计改编自 MIT 许可的 Master Cat 浏览器自动化实现；详见 [MASTER_CAT_NOTICE.md](MASTER_CAT_NOTICE.md)。

## 模型体验

### 用户自有原生标签页

#### 模型看到什么

未安装 `@deepseek-ai/dsh-tool-browser` 时什么也看不到；桌面 Agent 挂载该插件后，模型会获得有界的 `browser_control` 契约，并直接操作用户看到的同一组 Session 自有原生标签页。

#### Token 影响

用户导航和原生视图生命周期不会向 Agent 请求增加 token。

#### KV Cache 影响

产品浏览器状态与模型前缀相互独立，不会使现有 cache 条目失效。

## 已知限制与暂缓事项

- **桌面进程生命周期**：对话标签页会在应用内导航期间保留，但 Host 插件释放时会销毁，应用重启后不会恢复。已有八个会话包含浏览器状态时，第九个会话会淘汰最近最少使用的会话。
- **受限的本地入口**：只有工作区内的 HTML、HTM 或 XHTML 文件能成为本地页面；任意本地文件和非 HTTP 远程 scheme 会被拒绝。
