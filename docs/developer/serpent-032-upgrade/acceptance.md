# 0.3.2 验收记录

执行日期：2026-10-22。上游固定提交 `7e86e1b0`；WorldlineBox 名称与独立版本保持原值。

测试使用仓库内 Node 24.15.0，以及已有 Electron/原生依赖。日志存于本机 `artifacts/serpent-0.3.2-upgrade/`；日志与构建产物不提交。

## 已完成的检查

| 检查 | 实际结果 | 本机证据 |
| --- | --- | --- |
| 全项目 TypeScript | `tsc --noEmit`，exit 0 | `typecheck.log`、`ai-typecheck.log` |
| 扩展 TypeScript | `tsc -p tsconfig.extension.json`，exit 0 | `extension-typecheck.log` |
| 修改文件 ESLint | 97 个源文件/测试/配置，0 errors、4 条 Hook 依赖 warnings；后续 AI 修改单独复核 | `changed-files-lint.log`、`ai-final-lint.log` |
| 扩展构建 | 验证可安装扩展成功，exit 0 | `extension-build.log` |
| AI 配置与迁移 | 8 文件、62 项通过，含坏文件、凭据失败、清密钥保留配置、事务恢复、探针时效和活动配置搜索请求 | `ai-unit.log` |
| 本项目文本分析 Worker | 2 项通过，保留可读文本/二进制与纯文字模型处理 | `ai-text-worker.log` |
| MCP | 14 文件、97 项通过，含 token 持久化、SID/ACL 恢复、错误分类及 preload | 本次工具执行结果 |
| 拖拽、传输、全局模型与文本 | 10 文件、117 项通过 | `renderer-transfer-unit.log` |
| 媒体预算、图像序列、自带模型配置 | 9 文件、95 项通过 | `import-media-unit.log` |
| 导入、媒体、watcher 与语义索引 | 9 文件、176 项通过、2 项跳过 | `import-media-worker.log` |
| 迁移与资源管理 | 8 文件、281 项通过、3 项跳过 | `import-media-migration.log` |
| AI 真实应用 | 多配置切换与重启恢复、草稿地址/密钥读取模型、慢测试切换隔离、实际图像分析；自有 TXT 分析 Inspector 刷新，2 项通过 | `ai-e2e.log` |
| AI Inspector 回归 | 单资产和批量分析完成后立即刷新，2 项通过 | `ai-inspector-e2e.log` |
| 追加真实应用 | 同名 PNG 导入/预览/重启；MCP 连接、旧 pepper 恢复、损坏密钥与无权请求分类；自带向量设置；扩展指定合集与失效目标；原生回收站与重启；本地语义索引/检索/重启复用/缓存释放，8 项通过 | `integration-e2e.log` |
| 品牌与来源 | `package.json`、`package-lock.json`、`forge.config.ts`、`LICENSE` 无本次差异；README 中英文补充 Serpent 感谢和来源，删除 VCP 改造许可表述 | 工作区 diff；升级逐路径清单 |

各测试组可能覆盖相同模块，不将它们相加声称独立测试总数。5 项跳过单独列出，没有计入通过数。

## 实际应用验证边界

真实应用由当前源码构建到 `.tools/e2e-app`，Main、preload、renderer 与 Worker 均使用此次实现；没有覆盖用户日常开发构建。外部 AI 服务由本机 HTTP fixture 提供，真实密钥、真实用户配置和真实资源库未使用。

本地语义验证实际使用随项目提供的 `embeddinggemma-2-compact` 模型，5 个文字/图片资产全部完成索引，随后验证查询、完整进程重启后的 SQLite 向量复用及运行时缓存释放。没有用固定假向量代替模型。扩展验证实际经过 Main/Worker 并检查合集成员、根目录导入及失效目标拒绝。

首次导入/媒体测试曾遇 Electron 退出时 `PostQueuedCompletionStatus` 无效句柄，以及共享 AI 协议文件编辑期间的 collect 失败。修复/稳定后相应三组均完整复跑、exit 0；中途日志保留为 `*-during-ai-edit.log`，不冒充成功证据。

源码升级验收阶段没有制作安装器；后续按用户要求执行正式 Windows 打包，见下方交付记录。未做 Linux/macOS 实机验收、系统内存耗尽压力实测或真实超大型库的耗时基准。导入性能结论限于索引查询计划、缓存/目录枚举次数和正确性回归，不宣称加速倍数。网络代理实现原本属于另一组已有工作区改动，后续按用户明确要求一并提交。

## Windows 打包与工作区交付

用户要求运行 `03-Build-Installer.bat`，并明确将工作区全部源码和文档改动（含智能代理）提交远程 `main`。构建产物、依赖、缓存和模型权重继续按既有 `.gitignore` 保留在本机。

- 正式脚本执行主工程与扩展类型检查、Forge 生产构建、原生依赖处理、打包后完整性校验和 Inno 安装器编译；日志为 `installer-build.log`。
- 实际 `out/WorldlineBox-win32-x64/WorldlineBox.exe` 通过 7 项打包版回归：Worker 导入、FTS5 搜索过滤、关闭隐藏与托盘、内置模型设置、内置模型语义索引/检索/重启复用/缓存释放、纯文本 AI 分析、扩展指定合集。日志为 `packaged-e2e.log` 与 `packaged-e2e-fixture-rerun.log`。
- 首轮两项旧测试错误地启动开发版 Electron，被 `app.isPackaged` 断言拒绝；已统一使用 `resolveElectronLaunchOptions()` 后完整复验通过，没有删除或弱化打包身份断言。
- 智能代理新增 45 项定点单元测试和 1 项真实 Chromium/Node 本地网络回归通过；未重复执行真实 Pixiv 外网测试。日志为 `release-network-unit.log`、`release-smart-proxy-e2e.log`。
- 发现 `.tools/portable-release` 持续积累各次构建的工具导出快照。新增成功验证后仅清理本次 UUID 的回收逻辑；失败时保留诊断，不扫描清理其他构建。9 项真实文件系统测试（含 Windows junction 和外部目标保护）全部通过，日志为 `cleanup-safety-tests.log`。
- 历史快照清理逐项核验绝对路径、UUID、目录身份与根路径，拒绝越界或根层链接；保留 Node/Inno/Electron ZIP、真实资源与模型、DSH 测试夹具、用户数据、下载缓存及测试证据。清理计划与结果保存在本机 `tools-cleanup-plan.json`、`tools-cleanup-result.json`。
- `03-Build-Installer.bat` 最终 exit 0，安装器为 `out/make/inno/WorldlineBoxSetup.exe`，1,213,128,210 字节（1156.9 MiB），产品版本保持 `0.1.0`。SHA-256：`1ae09344f6d961f31f6affb772b67f44d25883d5204ae8a8eaaf56e58df39a17`；本机旁置 `.sha256` 文件及 `windows-release-receipt.json` 保存相同校验值。
- 本轮清理 66 份历史快照及验证成功后的本次快照，共 67 份；安装器与应用包不依赖这些源导出副本。清理没有遇到自动审批拦截，也没有更改审批设置。
- 不跟随 junction 的前后扫描显示 `.tools` 从 85.52 GiB 降至 12.25 GiB，减少 73.27 GiB（78,667,934,157 字节）；扫描结果为 `tools-size-audit.json` 与 `tools-size-after.json`。
