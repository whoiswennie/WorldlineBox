# 最终验收与交付

验收日期：2026-10-19，Windows x64。上游固定为 `7a94cabcf74e98667347a69961524c72b9df6f84`；从 `03c99c0b` 增量审阅 142 个路径，包含 0.3.1 发布提交及其后的本地源码修复。WorldlineBox 产品名、应用命名空间、自有模块、数据目录及独立版本 `0.1.0` 保持不变。

## 检查结果

| 检查 | 结果与本机证据 |
| --- | --- |
| TypeScript | 应用及扩展两份配置通过，`artifacts/serpent-031-final-typecheck.log`。 |
| ESLint | 本次全部变更无错误；App 原有两条 Hook 依赖警告保留。最终测试适配也单独通过，`serpent-031-final-lint.log`、`serpent-031-final-e2e-lint.log`。 |
| 快捷键 | 28 文件 221 项相关单测及新增 3 项来源去重单测通过；真实菜单、查看器、冷启动主壳、伙伴/启动器/原生网页全屏、全局工具双向冲突、导入导出及重启保存通过。 |
| 侧栏/筛选 | 8 文件 116 项单测通过；真实鼠标同级排序、跨层级移动、拒绝循环、刷新保存通过。文件夹批量操作、菜单、背景区域与连续浏览的最终复验通过。 |
| 传输与模型目录 | 10,000 个实际小文件导入、文件夹和 ZIP 导出通过；源读取失败、取消和索引备份/恢复回归通过。针对性的模型探针不访问无关 home/盘符。详见 `io-audit.md`。 |
| 安装清理 | Node 与 Electron 下各 9 项原生测试通过，真实应用交接 E2E 通过。系统进程在父应用退出后实际删除惰性安装器和空目录；没有执行系统安装。 |
| 文本及模型错误 | 171 项相关单测、93 项 Worker 测试通过；打包版实际正文请求、结果落库、Inspector 更新通过。具体 IPC 原因保留、异常供应商响应分类及 DashScope 文本探测均已修复。 |
| BAT 02 | 实际执行 `02-Start-Development.bat`，退出 0；启动、懒加载、网络页、主题与模块保持通过。证据目录 `.tools/dev-bat-acceptance/2026-10-18T17-47-56-828Z-265e9599-d46d-48b0-9505-82631530f8a9/`。 |
| BAT 03 | 实际执行 `03-Build-Installer.bat`，退出 0；原有媒体与 portable tools 门禁保留，生成新的 Inno 安装器。日志 `artifacts/serpent-031-bat03.log`。 |
| 打包应用 | 17 项全部通过，0 失败、0 跳过，3.8 分钟；见 `artifacts/serpent-031-packaged-e2e.log`。 |
| Linux 实物 | 固定 x64 媒体包下载、ZIP/manifest/8 项文件哈希、ELF 架构与来源锁静态校验通过；没有执行 Linux 二进制。arm64 仍未晋升，详见 `platforms-audit.md`。 |

打包版的 17 项包含真实 Worker 导入、FTS5 搜索、关闭到托盘、纯文本分析、网页文字/音频/文档采集与新建目录、H.264/AAC 播放、侧栏 12 种尺寸/缩放组合、截图编辑、MP4/GIF 录制、整台显示器采集及自动隐藏窗口、两类临时多轮问答、三项快捷键场景、侧栏排序和扩展按合集保存。桌面采集使用实际操作系统显示器和真实媒体流，未用合成 MediaStream 代替。

LLM 用例使用隔离配置与本地受控 HTTP 供应商，核对正文/像素、多轮上下文、取消、错误和实际存储；未使用用户真实 API Key，也未把桌面内容传到外网。音频、Office、HTML 等目前没有 AI 内容提取器，仍明确提示暂不支持分析；“可以采集/导入”不等于“已经支持 AI 理解”。

## 测试适配与保留逻辑

源程序复验包括 `serpent-031-source-final-e2e.log`、`serpent-031-source-fixtures-recheck.log`、`serpent-031-source-layout-final.log` 和 `serpent-031-source-pagination-complete.log`。初轮暴露的旧定位器、默认入口和断言先保留失败记录，再作针对性修正并复验：

- 新 tooltip 不再依赖 HTML `title`；测试使用实际可访问按钮或稳定属性。
- 原生拖拽明确等待目标的真实 `dragover`，不注入 DataTransfer 或结果。
- 新 UI 的根层缩进和按显示缩放取整的边框，用真实层级/内容框检查，保留 Worker 父级断言。
- 本项目页签内筛选会跨同页导航保留，测试明确清除后测实际合集成员加载；173 项合集切换实测 901 ms，原 5 秒上限保留。
- 本项目链接资产只参与明确的磁盘删除，不参与托管回收站；保持原规则并分别核对菜单数量。
- 一次测试宿主异常退出后，标签菜单完整场景重跑通过，没有增加自动重试或跳过来掩盖失败。

原有 8 项 Windows 框选拖拽跳过条件未改动；没有把它们计入通过，也未宣称运行全仓 `verify:mainline`。本次新侧栏排序有独立的真实 Windows 鼠标拖拽验收。macOS/Linux 的 UI、native 菜单和实际发行版运行仍需各自宿主验收。

## 安装器与源码一致性

- 路径：`out/make/inno/WorldlineBoxSetup.exe`。
- 文件大小：`723739424` 字节。
- SHA-256：`ef0e87f7741b92916004523fcc15df3cf7cca31675e5d998f5451dcc9f1ec0f5`。
- 产品/版本：`WorldlineBox / 0.1.0`。
- 编译前后 1,387 项运行源码、构建脚本与来源锁汇总 SHA-256 相同：`009d9f89badeac0ce2f50298a39dfc831427b78d294ef0371f1ab62724e9ab8d`。打包期间没有再修改运行源码；后续修改只涉及测试与验收文档。

交付分支为 `origin/main`。提交后以 `git ls-remote` 对照本地 HEAD，并检查工作区干净；最终提交、远程一致性和上述产物信息保存在本机 `artifacts/serpent-031-delivery-receipt.json`。大体积安装器、截图和运行日志不提交到源码仓库。
