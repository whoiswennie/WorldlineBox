# 应用智能 / 全局代理与 Pixiv 检查（2026-10-22）

## 原因与实现

本机原配置已使用 `http://127.0.0.1:7897`，Chromium 与 Node 请求共享应用网络策略。实测当前 Clash 节点可达 Pixiv 主站、登录页与 API，但访问 `s.pximg.net`、`i.pximg.net` 的 TLS 链路超时。Clash 本地日志也显示这些请求已匹配代理节点，因此不能把本次问题简单归因为 CDN 未走代理。`s.pximg.net` 同时存在可用的直连 HTTPS 线路。

在原配置结构中新增可选 `proxyRouting: smart | global`，保留 `proxyMode: system | direct | custom`、配置路径与代理开关恢复逻辑。旧配置缺少新字段时仍采用原有全局行为。设置页提供两个明确的应用代理模式及原系统 / 直连模式，顶部可立即切换，连接表单仍支持草稿保存。

智能模式通过共享的域名规则决定国内站点、局域网地址与代理路由；未知公网域名默认使用代理。对两个固定的 Pixiv CDN 域名做最多约 5 秒的 HTTPS 双线路探测：优先代理，只有代理失败且直连通过时才添加精确的 CDN 直连例外。保留原域名、TLS SNI、证书校验和页面 Referer，不改写为第三方镜像。图片 CDN 根目录的 404 仅作为 TLS 可达性证据；专项检查另行读取实际作品图片。

Chromium 的 bypass rules 与 Node / 后台进程的按目标路由都使用同一规则和本次探测结果。模式更新会关闭旧连接，既有后台进程继续使用稳定的私有中继地址；新会话应用当前策略。探测期间仍展示上一份已应用配置，应用失败回滚设置与 CDN 例外。修改普通下载来源复用检测结果；重新应用智能模式或点击重新检测时刷新。

全局模式不使用 CDN 直连例外。两种模式都仅管理 WorldlineBox 自己的请求，不修改 Windows 或 Clash 全局模式，也不能强迫上游节点成功访问某个 CDN。

## 真实网络结果

在独立测试用户目录中，生产 `LauncherNetwork`、`getApplicationNetwork()`、`BrowserService` 和 `persist:worldlinebox-browser` 分区完成真实请求，未读取或修改日常登录账户、站点 Cookie、代理配置或图库。

证据：`C:/Users/hp/AppData/Local/Temp/worldlinebox-pixiv-live-AghKO9/evidence/result.json`。

| 项目 | 全局模式 | 智能模式 |
| --- | --- | --- |
| Pixiv 公开主页 | HTTP 200，经代理 | HTTP 200，经代理 |
| Pixiv 登录页面 | HTTP 200，经代理 | HTTP 200，经代理 |
| 主页实际 CSS | 12 秒超时，经代理 | HTTP 200，直连 |
| 主页实际 JS | 12 秒超时，经代理 | HTTP 200，直连 |
| 公开作品 pages API | HTTP 200，JSON 结构正确 | HTTP 200，JSON 结构正确 |
| 实际作品图片 `i.pximg.net` | 12 秒超时 | 12 秒超时，未找到可用直连线路，保留代理 |
| reCAPTCHA API 脚本 | HTTP 200，经代理 | HTTP 200，经代理 |

生产浏览器真实 DOM 返回 Pixiv 标题、4 个 stylesheet、非空页面内容和 1 张已加载图片（不能据此推断作品图片正常）。隐藏窗口截图接口返回 `UnknownVizError`，没有生成可用截图；JSON 中的 DOM 及各项 HTTP 结果保留。CSS / JS / 图片专项检查仅读取有界响应前缀，不能代替完整资源下载、执行或播放测试。

用户明确选择暂不更换节点，继续修复并标明失败项。当前图片、原图、动图以及登录后的收藏、关注、R-18、投稿和支付不能声明全部可用。公开检查不执行这些账户操作；当前图片 CDN 仍需要可用的上游节点或直连线路。

## 验证

- 单元测试覆盖域名边界、智能 / 全局切换、旧设置、开关恢复、重启、新会话、失败回滚、CDN 双线路判定、IPC、UI 草稿保留及各项 Pixiv 失败展示。
- `smart-proxy.test.ts` 的本地夹具使用真实 HTTPS 源站、HTTP CONNECT 代理、Chromium 和 Node，验证主站 / 登录 / 验证码 / 图片走代理、选定静态 CDN 直连、国内域名直连、IPv4 / IPv6 局域网直连、CSS / JS / 图片实际加载及切回全局。仅 CDN 健康判定在该本地夹具中受控；真实联网测试使用生产探测。
- 既有 `dsh-proxy-toggle.test.ts` 验证 Chromium、Node fetch / HTTPS、Utility Worker、运行中连接切换及下载来源保持有效。
- `WORLDLINEBOX_PIXIV_LIVE=1` 可显式运行真实 Pixiv 检查；外网失败按结果记录，不伪造为通过。默认自动测试不访问 Pixiv。
