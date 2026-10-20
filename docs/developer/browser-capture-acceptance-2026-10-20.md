# 浏览器播放布局、登录兼容与屏幕工具启动验收

日期：2026-10-20。环境：Windows、Electron 43.1.0 / Chromium 150，隔离测试配置。

## 问题与修复

- 普通页面播放时，网页子资源加载提示原本占用 2 px 文档高度；出现、消失会缩放原生网页。提示改为零高度轨道中的覆盖层。
- 声音开始播放后，标签上的 `♪` 会改变字体行盒并撑高标签栏。真实 B 站页面观察到标签栏从 47 px 变为约 48.67 px，播放器由 816 × 459 变为 814 × 458。标签栏和状态图标改为固定高度，声音状态使用统一 SVG 图标。
- 播放/暂停原本执行完整导航刷新，重复设置原生页面的 bounds/visibility。现在媒体事件只更新声音状态，原生布局仅在实际变化时写入；同时订阅 `audio-state-changed`，避免声音标识依赖其他导航事件才更新。
- 截图工具原本在 `loadURL` 完成后立即显示，早于 React 懒加载模块和截图底图解码。工具现在通过仅限自身主框架的 ready 握手，等待底图和界面绘制机会后显示；首次原生尺寸修正在透明状态下完成。屏幕工具不再渲染主应用启动壳。录屏选区切到控制条时同样等待控制条准备好。
- 内置网页本来就由可见的 `WebContentsView` 承载，并非无头浏览器。保留 Chromium/Electron 的真实标识及专属持久会话。Google 账户页提供明确说明和手动打开默认浏览器的入口；来源可确定时打开原网站。任意 HTTP/HTTPS 页面也可从更多菜单打开默认浏览器。网址不能携带账户密码或使用非网页协议。

## 验证结果

1. `npm run typecheck`、改动文件 ESLint、`git diff --check`。
2. 浏览器、截图/录屏、桌面选区和启动相关回归：35 个文件、280 项测试通过。
3. 五项 Electron 端到端测试通过：
   - `browser-playback-resilience`：实际 H.264/AAC 解码、有声状态图标、播放及子框架加载前后 viewport 相同，未产生原生 bounds/visibility 写入；Google 页面使用本地响应验证提示和来源跳转，未调用真实登录。
   - `browser-native`：独立 Electron 子进程的 `navigator.webdriver === false`，UA 无 `HeadlessChrome`；Cookie/LocalStorage 跨重启保留，清缓存保留登录，原生全屏和下载正常。
   - `browser-popups`：链接、脚本、表单 POST、来源关系、共享会话、后台标签和容量上限。
   - `capture-tools`：首次 show 时无启动壳、截图底图已解码；真实视频/系统声音、暂停恢复、MP4/GIF 和手动滚动长截图。
   - `desktop-screenshot-selection`：真实快捷键、Windows 物理像素覆盖、智能窗口选区、拖拽和调整选区。
4. 额外访问公开 B 站视频 `https://www.bilibili.com/video/BV1GJ411x7h7/`，在普通页面点击播放器按钮：播放继续到约 5.60 秒，`paused === false`；连续 3 秒采样期间 viewport 始终为 1371 × 767，视频始终为 816 × 459。来源和结果保存于本地 `.tools/test-output/browser-live-playback.json`。此检查使用临时 profile；Playwright 启动的自动化实例会有 webdriver 标记，未修改此标记。

截图、录屏和公开网页检查未使用玩家的浏览器 profile、账户或登录 Cookie。公开网页检查只覆盖该页面和本次网络条件，不代表验证了所有网站或所有账户的登录策略。

## 登录策略与边界

Google 拒绝嵌入式浏览器登录是提供方策略，改 UA 不能使其成为支持的 OAuth 环境。默认浏览器中的会话不会复制回 WorldlineBox；用户需继续在那里使用对应网站。没有通过关闭网页安全、忽略证书错误或伪造设备身份来处理这个限制。

参考：

- [Google：嵌入式浏览器登录限制](https://developers.googleblog.com/en/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/)
- [Google：原生应用 OAuth 使用系统浏览器](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Electron：WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
