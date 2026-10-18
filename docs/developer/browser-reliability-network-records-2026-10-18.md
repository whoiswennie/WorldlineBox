# 浏览器播放、网络热切换与记录查询修复（2026-10-18）

本轮针对用户截图中的主进程 `Invalid webContents` 异常、采集处理器拒绝日志及网络连接错误修复，并补齐代理即时开关、常用来源和记录查询。保留 WorldlineBox 品牌、原有资产导入链路、登录分区和项目自定义功能。

同日后续的全局侧边栏、全部模块代理路径及新安装器收据，见 [全局网络增量记录](global-network-2026-10-18.md)。本文下方保留此前构建的历史收据。

## 视频页面与新标签

截图中的异常来自新窗口接管：Electron 已创建原生 guest WebContents，但旧实现另建视图并返回不同的 WebContents，违反原生对象身份约定。现在 `createWindow` 原样接管 `options.webContents`；对于普通链接经 `OpenURLFromTab` 打开且没有原生 guest 的路径，显式完成首次导航，并传递 Referrer、表单 POST 内容及对应请求头。这样分别覆盖 `target="_blank"`、`window.open()`、先开空白页再导航、表单和后台标签。该约定见 [Electron WebContents 文档](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler)。

接管前后均采用原浏览器持久分区、沙盒、上下文隔离和 Web 安全设置；页面没有 Node、应用桥或通用 IPC。保留 opener / postMessage、Cookie、Referrer 和页面关闭行为。标签仍限 50 个、活跃网页限 8 个；回收时保护活动页、来源页及正在发声的页面。容量或主窗口状态在准入后改变时，安全关闭被拒绝的 guest，避免创建回调抛出主进程未捕获异常。

本机实际访问用户截图中的 [BV1tyJt61EUX](https://www.bilibili.com/video/BV1tyJt61EUX/) 并启动播放，记录到 `currentTime=0.971654`、`readyState=4`、`paused=false`、`videoWidth=640`，首页与视频页分别保留为标签。证据为 `artifacts/browser-live-bilibili.log`。这是该次真实访问的结果，不代表全部网站、账户状态、视频格式或 DRM 内容均兼容。

## 采集生命周期与网络失败

采集兼容桥只在 HTTP/HTTPS 文档初始化；空白页、srcdoc、data、浏览器错误页和本地 file 文档不读取设置或发送采集 IPC。非所属窗口、无效请求、已分离 iframe、页面关闭或跳转均返回结构化拒绝，兼容桥通过 Chrome 回调的 `runtime.lastError` 处理；异步读取完成后再次检查来源页面。拒绝响应不含资源库或私有目录数据。外部浏览器扩展的文件网址授权流程保持原样，本地图片仍通过内置浏览器侧栏的原生选图入口采集。

网页主框架的 DNS、连接中断、离线、超时、TLS 和代理失败显示对应中英文说明，并提供重新加载、全局网络设置及折叠的原始错误码。停止、被后续导航替代的加载和子资源错误不会覆盖已成功打开的页面。截图中的 `-100` 是连接关闭，`-105` 是域名解析失败；播放器 tracker 的子资源日志本身不能证明视频解码失败。错误定义依据 [Chromium 网络错误表](https://chromium.googlesource.com/chromium/chromium/+/refs/heads/main/net/base/net_error_list.h)。保留证书校验，不自动忽略 TLS 错误或替用户切换代理。

## 代理、来源与即时生效

「当前生效」区域增加代理开关：关闭立即切换直连，重新开启恢复此前系统/自定义模式及原地址。端口或来源快捷选择只提交对应字段，其他未保存编辑继续作为草稿；显式选择 npm 源时同步选择“仅使用所填注册表”，避免自动择优覆盖用户选择。

Node 的 `setGlobalProxyFromEnv()` 在代理环境为空时不会主动清除既有 dispatcher。修复先恢复上一组 dispatcher/agents；对启动时已经继承代理的 Worker，使用上一条有效代理配置加通配绕过规则实现直连。删除旧代理环境并过滤 `undefined` 值，避免环境中出现字符串 `"undefined"`。Chromium 既有分区、Node fetch/HTTPS、已启动的 Library Worker 及之后创建的命令使用更新策略；已运行的外部命令不承诺中途更新环境。具体 API 行为见 [Node 24 HTTP 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html)。

常用本机 HTTP/混合端口为 `7897`、`7890`、`7896`、`7898`、`10809`、`8080`；它们是可选地址，不会探测或启动代理服务。旧配置只补充一次新建议，保留自定义名称、地址和用户后续移除结果。

| 来源 | 内置选项与地址 |
| --- | --- |
| npm | 官方 `https://registry.npmjs.org`；npmmirror `https://registry.npmmirror.com`；华为云 `https://mirrors.huaweicloud.com/npm` |
| Python | 官方 `https://pypi.org/simple`；TUNA `https://pypi.tuna.tsinghua.edu.cn/simple`；USTC `https://mirrors.ustc.edu.cn/pypi/simple`；阿里云 `https://mirrors.aliyun.com/pypi/simple`；华为云 `https://repo.huaweicloud.com/repository/pypi/simple` |

地址按各服务的公开说明核对：[npmmirror](https://npmmirror.com/)、[华为云 npm](https://mirrors.huaweicloud.com/mirrorDetail/5ea14e0f0cbca48259f6e3e0)、[TUNA PyPI](https://mirror.tuna.tsinghua.edu.cn/help/pypi/)、[USTC PyPI](https://ipv4.mirrors.ustc.edu.cn/help/pypi.html)、[阿里云 PyPI](https://developer.aliyun.com/mirror/pypi)、[华为云 PyPI 配置](https://support.huaweicloud.com/sdkreference-cloudrobo/cloudrobo_03_0002.html)。保留既有三条 GitHub 公共回退线路和自定义入口；不将仅镜像部分仓库的服务当成任意 GitHub URL 的通用镜像。公开地址核对及受控线路测试不等于外部镜像的持续可用性或带宽保证。

## 记录查询

- 启动器操作记录每页 20 条，支持按操作、实例、错误、阶段及本地化状态搜索，提供状态筛选和匹配数量，保留原暂停、继续、取消、重试及清理入口。
- 浏览器下载记录每页 20 条，支持文件名、URL、错误及状态搜索和状态筛选，完整访问原有最多 200 条记录，修复仅显示前 100 条的问题；原文件操作和进度展示保留。
- 浏览历史每页 50 条，搜索变化回到第一页；清理或数据收缩后校正页码，过期搜索响应不会覆盖新查询结果。操作与下载记录也会在数据收缩时校正页码。

## 验证记录

以下是本轮各自执行的证据组，存在用例重叠，不相加为一个独立测试总数。

| 验证 | 结果与证据 |
| --- | --- |
| 最终聚焦单测 | 14 文件、111 项通过；`artifacts/browser-fixes-unit-final.log` |
| 网络专项单测 | 5 文件、42 项通过；`artifacts/browser-network-fix-unit.log` |
| 原生 Electron 回归 | 4 项通过，24.0 秒；覆盖弹出页面、原生会话/下载/全屏及采集沙盒与生命周期；`artifacts/browser-fixes-native-e2e.log` |
| 采集独立复核 | 真实 BrowserService 的权限、分离/关闭/跳转请求与严格 CSP 下真实鼠标拖拽共 2 项通过；`artifacts/browser-capture-lifecycle-fix.log`，已包含于原生证据范围 |
| 完整源码应用播放 | 真实 H.264/AAC 播放、链接新标签、失败后手动重试与导航恢复通过，6.7 秒；`artifacts/browser-playback-source-e2e.log` |
| 完整源码记录查询 | 预置 55 条操作、125 条下载和 125 条历史，验证末页、末条搜索与清理后归位通过，7.8 秒；`artifacts/record-pagination-source-e2e.log` |
| 代理热切换 | 真实 Chromium HTTPS CONNECT、Node fetch/HTTPS、继承代理的 utility Worker 启动与热更新、受控 npm/Python/GitHub 来源 A/B 切换通过；`artifacts/proxy-toggle-local-regression.log`。端点与证书受测试控制，不冒充外网镜像测速 |
| 哔哩哔哩实站 | 用户相同视频 URL 实际播放，指标见上文；`artifacts/browser-live-bilibili.log` |
| 类型与静态检查 | 主项目及扩展 TypeScript 通过；全项目 ESLint 0 错误、7 条原有 Hook 警告；外置扩展构建通过；`artifacts/browser-fixes-types-final.log`、`artifacts/browser-fixes-lint.log`、`artifacts/browser-fixes-extension.log` |
| BAT02 | 实际入口验收退出码 0，首页可用耗时 11,820 ms；`artifacts/browser-fixes-bat02.log`，隔离证据目录 `.tools/dev-bat-acceptance/2026-10-18T09-10-47-159Z-e6912d7c-84d1-4ba7-8f55-5d96728aeffd/` |
| BAT03 安装器构建 | 实际 `03-Build-Installer.bat` 退出码 0；完整 TypeScript、生产编译、原生依赖、资源完整性与 Inno 校验通过；Inno 编译 403.266 秒；`artifacts/browser-fixes-bat03.log` |
| 最终打包程序回归 | 最终一次完整运行 7 项全部通过（1.1 分钟）；实际 `app.isPackaged` 程序覆盖播放、采集、代理/来源即时切换及重启保留、记录查询、真实 Worker 导入、FTS5 搜索和托盘；`artifacts/browser-fixes-packaged-e2e-final.log` |

上述验证没有安装器覆盖安装、所有互联网网站/地区/账号和全部 DRM 播放环境的结论。

## 本轮构建收据

本轮重新生成 `out/make/inno/WorldlineBoxSetup.exe`，并验证同一 `out/WorldlineBox-win32-x64/WorldlineBox.exe`，没有复用此前 Serpent 升级的旧产物。

- 安装器时间：2026-10-18 17:42:43（UTC+8）。
- 安装器大小：723,647,354 字节，约 690.1 MiB。
- SHA-256：`bdc1429c08e0bf490b71e2c1dc5b0857376c1ed0fb55834dbab15d50a19c0387`。
- 校验文件：`out/make/inno/WorldlineBoxSetup.exe.sha256`。
