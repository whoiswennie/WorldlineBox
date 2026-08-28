# Host 与 Client 边界

[English](host-client-boundary.md) | 中文

## Host 权限

只有 Host 插件可以直接访问 Node、文件系统、子进程、PTY、环境变量、凭据、持久化数据库、Electron 和本地网络监听。Host 方法必须在执行权限操作前验证路径、身份、所有权和取消信号。

## Client 权限

Client 插件运行于浏览器：

- 通过 Client Runtime 访问 Session 和 Workspace 投影；
- 通过 Typert 生成的 Remote 调用 Host；
- 通过 Slot Registry 贡献 UI；
- 通过 Locale Registry 贡献文案；
- 不导入 Host 实现或 Node 内置模块。

## Remote

Remote descriptor 是 Host/Client 的类型真源。Host Gateway 验证参数并选择 receiver；Client 验证返回值并绑定调用生命周期。新增 Remote 必须包含：

- 明确的 namespace 和方法名；
- JSON 安全参数/返回值；
- 需要时注入 `AbortSignal`；
- Host 端授权，而不是只隐藏 UI 按钮；
- 至少一个跨边界失败用例。

## Electron

Electron 主进程只负责窗口、安全策略、单实例、运行时监督和桌面专属桥接。Agent、Session、Tools 和数据库不得通过自定义 Electron IPC 形成第二套架构。

WebView 导航、权限和新窗口必须在主进程拒绝默认行为，再交给受控桌面浏览器桥接。
