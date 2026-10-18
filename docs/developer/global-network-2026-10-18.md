# 全局网络入口与实际请求范围（2026-10-18）

本轮是在已有 Serpent 0.3.0 同步及浏览器修复基础上的增量修改，保留 WorldlineBox 名称、资源库、自定义功能与原网络配置文件。

## 独立入口

最左侧应用栏增加「全局网络」，启动器内的网络菜单移除。浏览器设置与错误页转到同一个全局页面。页面使用独立 `worldlinebox.network` IPC；读取或修改网络不需要激活 DSH、伙伴服务或资产 Worker。主进程在各模块启动前初始化统一策略，DSH 的初始化失败与全局网络接口分开处理。

保留 `userData/dsh-launcher/network.json`，避免迁移造成旧配置或导出 CLI 失效。页面继续支持即时开关、恢复此前代理、常用端口、国内来源预设、草稿与连接检查。只有主应用窗口的主框架可以访问全局 IPC。

## 实际流量

Chromium 的默认会话、浏览器持久分区和 DSH 工作台分区共享同一策略。新分区也注册策略，浏览器和工作台首次导航前等待应用完成。切换时关闭旧连接。

Node 的 Main、Library Worker、标准及可信插件 UtilityProcess 和脚本 UtilityProcess 使用统一环境。运行中的 UtilityProcess 通过经过校验的私有 parentPort 消息更新配置；退出竞态不影响全局保存。QuickJS 的标准插件与脚本通过 Main Gateway 执行网络功能。

应用拥有一个只绑定回环地址的认证 HTTP/CONNECT 入口。Node 请求及托管命令通过这个固定入口连接；入口逐个目标解析最新代理，而不是将 npm 的系统路线用于所有模型、同步和更新请求。策略版本变化时关闭旧连接，让已运行的 DSH/CLI/npm 等命令在后续请求使用新路线。检查状态、探测结果等普通发布不会关闭连接。退出时先等待托管进程和 Worker 关闭，再释放入口。

入口认证只存在于当前进程环境，不写入网络配置、CLI 上下文或导出脚本，认证与辅助头不会转发给上游。应用日志与 DSH 日志均对 URL 凭据脱敏。独立从系统终端运行的导出 CLI 每次执行读取正式配置；它不会依赖已退出应用的临时入口。

| 路径 | 使用策略的方式 | 本轮证据 |
| --- | --- | --- |
| 浏览器、DSH 工作台、默认 Chromium 请求 | 统一 Session 配置 | 原生代理回归、成品开关及播放/采集回归 |
| 资产 AI | 真实 LibraryWorkerClient、生产 Worker AI adapter | 同一 Worker 中 A→直连→B，随后系统 PAC 域名分流 |
| 伙伴模型 | 服务实际注入的默认 Session `net.fetch` | 生产 structured provider 的真实请求 |
| 语义 HTTP | Main 的生产 embedding 请求 | A→直连→B、系统 PAC 域名分流 |
| 资产 URL 下载 | 保留目标 IP 固定的 CONNECT 通道 | HTTP/HTTPS、双层 TLS、取消、认证隔离、原域名 PAC 判断 |
| 插件与脚本 UtilityProcess | 显式初始环境、私有实时消息 | 绑定/退出竞态单测及原 CLI/QuickJS 回归 |
| 已运行的托管命令 | 固定认证入口、每次连接解析当前路线 | 同一个真实 Node 子进程 A→直连→B；活动连接切换和防止重复代理 |
| 音乐、更新、模型下载、WebDAV | 审计确认使用默认 Session 或全局 Node fetch/HTTP agents | 相应统一传输层的原生请求验证；未逐个调用所有外网服务 |

系统 PAC 回归使用真正的 Chromium PAC 解析器；测试在隔离 Session 内模拟系统配置，不改 Windows 注册表。规则令 npm 直连，模型目标使用指定代理，并验证真实请求流量。通用 CONNECT 只携带隧道目标，不能承诺 Node 与 Chromium 对原始 URL 协议、路径相关 PAC 规则完全相同；本轮证明了按目标域名分流、自定义 HTTP(S) 代理与直连。

代理设置不改操作系统或其他应用。自定义全局代理明确要求 HTTP/HTTPS 或混合端口；历史 SOCKS 专用端口配置在启动时保留原文件、显示提示并暂用直连，选择不兼容的活动地址会明确失败。镜像切换用于后续下载和新命令；已经开始的安装需要取消后重试才能切换来源。

## 安全下载

旧 URL 下载器显式 `agent: false`，原本会绕过全局 Node 代理。现在先按既有 SSRF 规则检查并固定目标 IP，再经 HTTP/HTTPS 代理 CONNECT 该数字地址，继续使用原 Host、TLS SNI 和证书验证。重定向的每一跳保持原有校验，不把 DNS 决策交给代理。

内部认证入口可接收专用的原站来源提示供 PAC 判断，但 CONNECT 仍指向已验证的数字 IP。提示必须为规范的 HTTP(S) origin、端口匹配且目标为数字 IP；未认证、包含路径/凭据或端口不一致的提示被拒绝。外部代理不接收内部认证与提示。代理连接失败不会悄悄回退直连。

## TLS 日志与诊断

`handshake failed ... net_error -100` 表示 TLS 建连期间连接被关闭，并非编译失败；`-100` 的 Chromium 定义为 CONNECTION_CLOSED。仅凭该日志无法确定是站点、代理还是某个子资源。反复出现且伴随播放或加载失败时，需要按目标排查。[Chromium 网络错误定义](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/net_error_list.h)

全局页面新增当前运行期的 Chromium HTTP 失败记录，按站点来源、错误码、资源类型与会话类别聚合，最多 40 类，每页 10 条，支持搜索和清空。只保存 origin，不保存路径、查询参数和凭据；忽略正常取消及非 HTTP 地址。UI 更新合并为每 250 ms 一次，不将单个子资源失败当作应用崩溃。低层预连接、WebRTC 或没有建立 HTTP 请求的握手日志未必出现在记录里。证书验证与原始终端诊断保留。

## 验证收据

证据组存在用例重叠，不相加为独立测试总数。

| 检查 | 结果 |
| --- | --- |
| 最终聚焦单测 | 13 文件、95 项通过；`artifacts/global-network-focused-final.log` |
| 子进程及 CLI/QuickJS 回归 | 4 文件、24 项通过；同一子进程代理热切换及 CLI 凭据隔离 |
| Worker 采集回归 | 56 项通过；`artifacts/global-network-extension-worker.log` |
| 真实模块与 PAC | 13 次请求通过；独立及最终合并执行均通过，`artifacts/global-network-coverage.log`、`artifacts/global-network-native-final.log` |
| 原 Chromium/Node/Worker 代理与来源回归 | 最终与真实模块回归共 2 项通过（5.5 秒），保留代理流量计数验证；`artifacts/global-network-native-final.log` |
| TypeScript | 主项目完整检查通过，BAT03 另含扩展检查 |
| ESLint | 全项目 0 错误，7 条原有 Hook 警告；`artifacts/global-network-eslint-final.log` |
| BAT02 | 实际入口通过，首页 13,204 ms；验证全局栏及原生 IPC 开关、与 DSH 共用已应用状态；`artifacts/global-network-bat02-final.log` |
| BAT03 | 实际 `03-Build-Installer.bat` 退出码 0；完整类型检查、生产编译、原生依赖、便携资源与打包后校验通过；Inno 编译 406.672 秒；`artifacts/global-network-bat03.log` |
| 最终成品 | 最终一次 7 项全部通过（1.1 分钟）；包含新侧边栏、即时开关和镜像重启保留、真实 TLS 失败聚合/隐私/搜索/清空、播放、采集、Worker 导入、FTS5、托盘及记录分页；`artifacts/global-network-packaged-final.log` |

BAT02 隔离证据目录：`.tools/dev-bat-acceptance/2026-10-18T10-18-35-468Z-7f81217e-0341-48d0-95fa-6b697ebc9923/`。

记录分页夹具通过真实 DSH IPC 确认已读取 55 条记录，再断言每页 20 条、末页 15 条与末条搜索；避免将导航已经显示误当成异步服务已经初始化。

## 最终安装器

- 路径：`out/make/inno/WorldlineBoxSetup.exe`。
- 生成时间：2026-10-18 18:54:38（UTC+8）。
- 大小：723,689,889 字节，约 690.2 MiB。
- SHA-256：`8a42679f159762028dc6c5d18983e3d6c0677693f7bdbe9f41d401a1c09850fd`。
- 相邻校验文件：`out/make/inno/WorldlineBoxSetup.exe.sha256`。

验证针对上述安装器输入的最终 `out/WorldlineBox-win32-x64/WorldlineBox.exe`，不是此前构建；未进行覆盖安装或宣称所有外网网站、地区、账户与 DRM 场景均已验证。
