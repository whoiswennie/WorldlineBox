# DSH 下载网络回归夹具

`cert.pem` 和 `key.pem` 是公开的本地测试证书及测试密钥，不用于生产 TLS 或任何身份认证。测试中的证书回调只接受这张固定证书的指纹和 `127.0.0.1` 主机，其他连接继续使用 Electron 默认的证书验证。

`main.ts` 不创建应用窗口，通过真实 Electron Chromium 网络栈验证重定向、流下载、取消和失败清理。入口由测试编译到独立临时目录，加载失败由入口包装捕获，避免 Electron 默认错误弹窗。

运行：`playwright test tests/e2e/dsh-download-network.test.ts`。设置 `WORLDLINEBOX_DSH_REAL_DOWNLOAD=1` 时，额外完整下载官方 Windows 安装包、提取并封存校验；默认使用本地 HTTPS 服务器。
