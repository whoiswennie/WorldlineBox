# @deepseek-ai/dsh-client-ui-auth

[English](README.md) | 中文

面向 local-auth Host 路由的浏览器账号界面。它在具备作用域的 UI Slot 中注册登录与注册浮层、已记住账号选择、个人资料编辑、头像裁剪和账号设置区。

Client 只保留浏览器安全的认证快照。密码 hash、会话 token 存储、租户选择和授权仍由 Host 负责。启动交接会先从 URL 中移除一次性票据再完成交换，并在账号触发 Host 重启后等待新一代运行时就绪，再重新加载界面。

## 模型体验

### 账号控件

#### 模型看到什么

什么也看不到：认证表单和 `AuthSnapshot` Client 状态不会复制到 Agent 消息或工具中。

#### Token 影响

渲染或提交账号控件不会增加模型请求 token。

#### KV Cache 影响

账号 UI 状态与模型 prompt 前缀相互独立，不会使 cache 复用失效。

## 已知限制与暂缓事项

- **依赖 local-auth**：该界面不能通过 OAuth、企业身份或远程账号 API 认证；它需要同级 local-auth 路由和同源 cookie。
