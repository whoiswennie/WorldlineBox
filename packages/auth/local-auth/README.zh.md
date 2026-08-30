# @deepseek-ai/dsh-local-auth

[English](README.md) | 中文

世界线 Host 的本地账号与会话权威。它在配置的认证根目录下以仅所有者可访问的文件存储 scrypt 密码 hash、记住的账号、跨入口自动登录偏好、带过期时间的会话 token hash、个人资料字段和当前账号租户。

插件通过 `host-webserver` 暴露同源 JSON 路由，设置 HttpOnly 且 `SameSite=Strict` 的 cookie，并在受保护 API 或 upgrade 请求继续之前验证受管理的账号租户。WebUI 与 Electron 使用同一账号运行目录，但保留各自独立的浏览器 Cookie 容器；随机生成且仅可使用一次的 URL fragment 票据可以为每个容器签发 Cookie，无需复制密码。票据会在 Host 变更前消费且永不落盘。变更操作串行执行，并通过临时文件替换持久化。仅对当前受管理租户，上传的 data URL 头像会原子物化到租户资料目录。只读的 `ctx.localAccountProfile` 可以把这条 Host 路径提供给受信任的模型工具，而浏览器响应仍只包含展示资料；凭据、Cookie 会话、记住的账号和其他租户不会越过这条边界。

## 模型体验

### 已认证的浏览器身份

#### 模型看到什么

此包不会直接提供任何模型内容：`worldline_session` cookie 始终留在 Host/浏览器边界，且此包不注册 prompt。显式选择使用的上下文消费者可以通过 `ctx.localAccountProfile` 读取当前受管理租户的显示名称、个人简介与可选 Host 头像路径；图片字节只会由显式调用的受信任图片工具加载。

#### Token 影响

认证不会增加 prompt、消息、工具 schema 或工具结果 token。

#### KV Cache 影响

登录、切换账号或更新个人资料不会改变已经组装的模型请求前缀。

## 已知限制与暂缓事项

- **仅限本地身份**：存储不提供远程身份提供方、账号找回、多因素认证或跨设备同步。
- **Host 进程并发**：WebUI 与 Electron 可以持有各自的会话，但暂不支持同时运行两个可写 Host；切换入口前请先关闭另一个入口。
