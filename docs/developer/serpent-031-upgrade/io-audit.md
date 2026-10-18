# 传输性能与模型安装检查审计

## 合并范围

对照上游 `03c99c0b..7a94cabc`，包含 `45bb7816`（模型检查路径）、`52b43972`（Windows 传输切片）、`a50bd133`（导出收尾类型收窄）和 `50bbd35f`（切片内逐文件取消）。只合并下列局部逻辑，未覆盖 Worker 或模型模块整个文件。

| 路径 | 处理与保留内容 |
| --- | --- |
| `src/main/embedding-install.ts` | 安装状态只读取 `userData/embedding-models` 下已知权重文件及 `runtime` 的有限深度子目录；移除 C 至 Z 盘、用户家目录和 Hugging Face 缓存递归发现。下载、全局网络、磁盘空间检查、共享投影文件卸载规则保持。 |
| `src/main/library-request/embedding-models.ts` | 状态、安装前检查、卸载均使用托管目录检查；保留本项目等待索引停止完成、远程向量服务、只读状态查询及按库绑定实现。 |
| `src/main/index.ts` | 由主集成 agent 改 import 和 `installedLayout` 回调：调用 `inspectManagedEmbeddingInstall(app.getPath("userData"))`，不再触发全盘发现。 |
| `src/worker/library-service.ts` | 仅修改 `transferCheckpoint`：50 ms 切片外使用零延时 timer，让 UtilityProcess 消息轮询有机会运行；切片内每个文件仍使用 `setImmediate` 让出宏任务，保留即时取消。未删除文件边界取消判断。 |
| `src/worker/legacy-semantic-cache.ts` | 无需重复修改。本项目已在读取摘要及解析失败的 `finally` 中 `destroy()` 并等待 `finished()`，覆盖上游流关闭修复。 |
| ZIP 导出错误处理 | 本项目已保存外层 `zipOutput` 和 `abortArchive`，失败时先等待输出流释放再删除自身拥有的目的路径；闭包使用块内 const，无上游类型收窄问题。另保留将 archiver warning 视为失败的更严格检查。 |

WorldlineBox 资产文本/多模态分析、浏览器来源记录、IMPORT007、原数据库与迁移链、导出所有权清理、语义索引随库备份均未被上游实现替换。手工放在其他磁盘的同名模型不再被自动标记为应用已安装模型；已配置的自定义模型/向量服务不受此安装状态扫描调整影响。

## 验证

以下命令均在仓库根目录使用 `.tools/node-v24.15.0-win-x64/node.exe`。Worker 测试由 `scripts/run-vitest-with-electron.mjs` 使用 Electron Node 运行，非 GUI 模拟。所有临时库在测试结束关闭 SQLite 和 watcher 后清理。

| 命令参数 | 结果 | 本机日志 |
| --- | --- | --- |
| `node_modules/vitest/vitest.mjs run tests/unit/embedding-install.test.ts tests/unit/embedding-model-catalog.test.ts tests/unit/legacy-semantic-cache.test.ts` | 3 文件、20 测试通过。包括安装状态/已安装启动/卸载完全不访问会抛错的 homePath、同目录 runtime、共享投影文件保留。 | `artifacts/upgrade-031-io-unit.log` |
| `scripts/run-vitest-with-electron.mjs run tests/worker/library-zip.test.ts tests/worker/library-export-import.test.ts` | 2 文件、55 测试通过，2 项平台条件跳过。覆盖文件夹和 ZIP 即时取消、仅删除操作拥有的文件、源读取失败、语义索引备份与恢复。 | `artifacts/upgrade-031-io-worker.log` |
| `scripts/run-vitest-with-electron.mjs run tests/worker/library-transfer-performance.test.ts tests/worker/semantic-index-handler.test.ts tests/worker/semantic-index-store.test.ts` | 3 文件、18 测试通过。 | `artifacts/upgrade-031-io-performance.log` |
| `WORLDLINEBOX_TRANSFER_BENCH_FILES=10000` 加同一性能测试 | 真实创建 10,000 文件，文件夹导出、ZIP 导出及文件夹导入均通过，文件数量完整。 | `artifacts/serpent-031-io-transfer-10000.log` |
| `node_modules/eslint/bin/eslint.js src/main/embedding-install.ts src/main/library-request/embedding-models.ts src/worker/library-service.ts tests/unit/embedding-install.test.ts tests/unit/embedding-model-catalog.test.ts tests/worker/library-transfer-performance.test.ts` | 通过。 | `artifacts/upgrade-031-io-lint.log` |

新增 `tests/worker/library-transfer-performance.test.ts` 实际创建多文件库，执行文件夹导出、ZIP 导出及文件夹导入，逐项校验文件数量，并计数零延时 timer 次数以防止恢复成每文件一次的 Windows 等待。默认 512 文件；可用 `WORLDLINEBOX_TRANSFER_BENCH_FILES` 增至 20,000。使用次数上限而非硬性耗时门槛，避免磁盘和其他后台负载造成偶发失败。设置 `WORLDLINEBOX_TRANSFER_METRICS_PATH` 可输出本机测量 JSON。

本次 512 个小文件测量：文件夹导出 413.9 ms / 9 次 timer；ZIP 导出 278.0 ms / 1 次；文件夹导入 331.3 ms / 7 次。数据见 `artifacts/serpent-031-transfer-metrics.json`。这些是此机器和小文件负载的实测值，不是大文件复制吞吐保证。

本次 10,000 个小文件测量：文件夹导出 12,734.2 ms / 192 次 timer；ZIP 导出 3,195.3 ms / 15 次；文件夹导入 6,566.4 ms / 128 次。数据见 `artifacts/serpent-031-transfer-10000-metrics.json`。这是新实现的实际结果，未在用户工作区来回替换运行时代码做旧版本计时，因此不宣称未经同机对照测量的倍数。

首次全量 TypeScript 检查见 `artifacts/upgrade-031-io-typecheck.log`：当时仍有主集成正在处理的 Main 旧模型 import、扩展 `onListCollections` 接线和菜单测试 zoom mock 错误；本次所有 owned 源码/测试无报错。全量门禁需以主集成的最终结果为准，不将这个中途运行记为通过。

映射盘修复验证范围是应用自行做安装发现时不访问无关盘符或 home；用户显式选择位于失联网络卷上的资源库，仍可能受操作系统网络文件系统超时约束，不能用本项扫描修复宣称网络文件系统本身总能立即返回。

真实应用、BAT 02/03、打包版和全量自有功能回归由主集成流程另行执行；本子项未运行 GUI 或构建，也未提交 Git。

## 上游测试清理增量补审

- `tests/unit/embedding-llama-session.test.ts` 的模拟子进程在 stdin 结束时已输出 `WORLDLINEBOX_EMBEDDING_STOP`，与本项目真实会话协议一致，覆盖上游新增 STOP 输出；不改回上游品牌字符串，也不重复覆盖整文件。
- `tests/worker/library-zip.test.ts` 已在 afterEach 等待全部 `closeAllAsync()`，再用 `fs/promises.rm` 的 5 次 / 100 ms 重试清理临时库；比上游同步 close + 同步删除重试更完整地等待 watcher/句柄释放，保留现有实现和所有 ZIP/来源/取消断言。
- `tests/worker/folder-custom-cover.test.ts` 原有 service 跟踪已经覆盖上游新增项，本次只将 afterEach 收尾改为等待 `closeAllAsync()` 后异步有界重试删除。保留 v57 历史封面、来源资产删除等自有断言。
- `src/worker/legacy-semantic-cache.ts` 的摘要与解析两条读取路径原已 `finally { stream.destroy(); await finished(stream).catch(...) }`；不覆盖为上游弱化或重复关闭版本。此处只记录审阅，不更改运行源码。
- 新增 `tests/e2e/app-update-handoff.test.ts`：按 WorldlineBox 启动 helpers、品牌与 GitHub 仓库适配上游更新交接验收；仅在非打包 Windows 开发 fixture 生效。inert 安装器不执行，下载哈希、解压、真实隐藏 PowerShell、应用退出与临时文件/空目录实际清理均保留真实路径；finally 先等待 helper 清理，随后校验 tmp 直接子目录名称/真实路径后才删除测试根。由主集成执行 GUI 验收，本子项只写入、类型/静态检查，不宣称已运行通过。
