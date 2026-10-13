# DSH WebUI 启动器交付与验收（2026-10-13）

参考项目已拉取至 `C:/Users/hp/Desktop/project/new/test1`，固定提交 `290a52483c3cda37229a5d92c500cba321eab068`。WorldlineBox 独立实现管理逻辑；正式路线为官方 npm 发行版的 WebUI / CLI，不以桌面安装包或 GitHub 源码 ZIP 冒充版本管理。

## 交付入口

- 开发：项目根目录 `02-Start-Development.bat`。
- 构建安装包：`03-Build-Installer.bat`。
- 安装包：`out/make/inno/WorldlineBoxSetup.exe`，约 550.3 MiB，校验文件为同目录 `.exe.sha256`；最终产物登记为 `.tools/dsh-research/dsh-webui-final-artifact.json`。
- 打包后程序：`out/WorldlineBox-win32-x64/WorldlineBox.exe`。
- 使用方式：[DSH 启动器指南](../user-guide/dsh-launcher.md)。

普通开发版与安装版的运行数据均为 `%APPDATA%/WorldlineBox/dsh-launcher`；项目 `.tools` 中的 SDK 仅是本次测试夹具，正常软件下载与解包不会使用该测试目录。测试使用独立 Temp profile，没有读取或改写用户已有账号凭据。

## 已实现的行为

官方版本目录、精确 npm 版本 / SRI 安装、完整运行文件封存、版本并存、独立实例、升级副本、启停、运行日志、私有快照、完整离线备份、整合包 v2 与依赖锁重放、公开分发清单与 GitHub 草稿发布接口均已接入。

同时只允许一个 WebUI；显式「切换并启动」先走原生关闭流程，释放写入队列，再启动目标版本。选择 CLI 实例无需启动 WebUI，之后默认命令采用新选择；已经执行的任务与终端保留原绑定。受管 `dsh web` 不另行启动未登记的第二个工作台。

两个已验证版本默认共享会话、附件、默认工作区、登录凭据及核心 API / 模型配置。插件、技能、浏览器存储与其它私有配置分别保存；工作区隐式技能扫描受控，官方内置技能仍保留。其它未验证格式的版本默认使用独立存档。

网络配置支持系统 / 直连 / 自定义代理、多组保存地址、国内 npm / Python / GitHub 镜像，无需应用重启。CLI 每次调用读取当前网络和共同模型配置。任务入口 `task.run/cancel/result/events` 固定真实 SDK 与实例，可用于后续主脑和角色委托。

真实 ConPTY / xterm 支持多终端、颜色、光标、交互输入、Ctrl+C、尺寸变化、搜索、复制粘贴和脱敏导出。PTY 放在独立进程与 Windows Job 内，退出回收 worker、shell 和所属子任务。

## 便携工具

安装包实际包含 Node 24.15.0、npm 11.12.1、pnpm 11.7.0、完整 Python 3.13.12 / pip 25.3 / venv、Git 2.48.1.windows.1、FFmpeg / ffplay / ffprobe 8.0.1。工具树封存 13,265 个文件、943,438,461 字节；应用启动自动加载进程环境，测试以最小系统 PATH 验证，外部安装的软件不能满足该门禁。许可与来源见 [便携工具说明](portable-tools.md)。

## 实际证据

| 检查 | 结果与证据 |
| --- | --- |
| 真实官方 SDK 安装 | `0.2.0-rc.2`：26,649 文件；`0.2.1-alpha.2`：28,774 文件。`.tools/dsh-native-node/result.json` |
| 版本互读、账号格式、模型设置、写入锁 | 两个 SDK 的原生 API 验证通过；无真实模型调用。`compatibility.json` |
| 依赖锁重放 | 609 个锁定包 `npm ci`，来源 / SRI / 依赖图 / 解释器 / 运行 payload 均相等。`replay-payload-result.json` |
| 外部 CLI 热配置 | 两个版本通过真实 manager shim 与 native `--dump-config`，模型更新生效且私有配置未改写。`cli-hot-result.json` |
| 原生关闭与会话写盘 | RC → alpha → RC 立即改名后切换保留标题，停止约 72–99 ms。`.tools/dsh-research/native-host-lifecycle.json` |
| 完整应用流程 | 真实双 SDK、CLI 工具、多终端绑定、单 Web、共同会话、同包两实例、分发导出、完整离线恢复：1 项 Electron 场景通过（7.6 分钟）。`webui-real-e2e.log` |
| 实际 02 入口 | 默认启动器、设置停留原模块、亮暗主题、原生 IPC、便携工具自动加载与自有进程清理通过。`.tools/dev-bat-acceptance/*/result.json` |
| 实际 03 入口 | TypeScript、Forge、完整工具 / 媒体 / ASAR 门禁与最终 Inno 编译通过。`webui-installer-final-build.log` |
| 最终打包 EXE | 最小 PATH 下工具、Python venv/pip、Git、本机 DSH CLI / WebUI、ConPTY、子进程回收和重启保留通过。`webui-packaged-final-e2e.log` |
| 资产回归 | 同一最终 EXE 的 Worker 导入、FTS5 搜索、Windows 关闭 / 托盘行为通过；总计 4 项包内桌面检查通过。`webui-packaged-final-e2e.log` |
| 模型数据加固 | 共享 JSON 与 YAML 中拒绝惰性表达式 marker；模型同步、原生 RPC、停机和实例检查 21 项通过。`webui-final-model-unit.log` |
| 布局与外观 | 1280 / 1920 窗口几何、亮暗主题、设置保留模块、31 个实际版本、全局背景节点保留通过。`ui-acceptance/receipt.json`；仅 `verified-*.png` 按人工确认页面使用 |

`webui-packaged-e2e.log` 的首个 DSH 工具案例曾因测试对 Windows SGR 的邻接顺序假设而失败；修正为真实颜色状态断言后，专用 EXE 记录在 `webui-packaged-tools-fixed.log`，保留失败过程作为诊断证据。测试并未改为仅接受纯文本输出。

隐藏窗口的 `capturePage` 首帧存在延迟，部分原始 PNG 的文件名与实际页面不一致，不能以其文件名宣称页面通过。几何 / DOM 验收独立通过；三张人工匹配的图片保存为 `verified-versions-light-1920.png`、`verified-network-dark-1280.png` 和 `verified-terminal-dark-1920.png`。

## 验证边界

成功模型回复和取消协议使用真实子进程夹具验证；本次未使用用户模型账户发送实际模型请求，也未向 GitHub 发布任何真实资产。GitHub 发布采用受控 API 夹具验证完整上传、校验和草稿流程。第三方插件的跨版本 ABI 不作自动兼容承诺，升级先在副本验证。

一个只包含空测试 profile 和网络目录元数据的临时目录，因为自动审批拒绝删除而保留：`C:/Users/hp/AppData/Local/Temp/worldlinebox-ui-acceptance-ymY7m3`。拒绝理由仅为 `blocked by policy`；未通过其它方式重试该清理。
