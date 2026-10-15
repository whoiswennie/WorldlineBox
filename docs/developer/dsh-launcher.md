# DSH 启动器实现

实现参考维护者提供的 PCL / DSH 调研，独立实现管理逻辑，不复制 PCL 源码。入口是 `ApplicationShell` 的 `dsh` 模块，preload 提供类型化 request / state 通知；IPC 只接受管理器主窗口的 main frame。资产 Worker 和资源库数据库不持有 DSH 实例。

## 管理目录与适配器

`app.getPath('userData')/dsh-launcher` 下保存 `runtimes.json`、`instances.json`、`snapshots.json`、`packs`、`operations`、`cache`、staging 和 `shared`。实体 ID 不依赖版本号或显示名。程序版本与插件环境独立，共享存档层持有日常会话、默认工作区、账户和模型配置。

`application-user-data.ts` 统一开发版与安装版的用户目录：默认 `appData/WorldlineBox`，
可由绝对路径 `WORLDLINEBOX_USER_DATA_PATH` 覆盖。E2E 与显式多实例开发仍隔离。
`legacy-dsh-storage.ts` 在取得目标单实例锁后、启动器初始化前，只迁移无实例、无已安装
环境且无运行操作的旧 DSH 存储。物理复制前后检查完整文件摘要，提交前再次确认目标不存在；
旧目录始终保留。已有目标不合并，存在实例或环境时返回明确的备份导入结果；路径、祖先及内容链接
或复制期间源数据变化均拒绝提交。它不会迁移整个 Chromium profile 或覆盖已有资产/世界数据。

主路线为 `node-cli-web-v1`：`OfficialVersionCatalogue` 合并 GitHub Releases 说明与官方 `@deepseek-ai/dsh` npm 目录，固定具体版本和官方 SHA-512 SRI。`node-runtime-service.ts` 使用内置 Node / npm 安装依赖、检查第一方 DSH 包版本闭包、封存完整文件清单及规范化依赖图。单纯 GitHub source archive 不会登记为可运行制品。制品包含 `program/bin/node.exe`、`program/dsh/node_modules` 和 `node-runtime.json`，不依赖用户全局 Node。

兼容导入仍支持官方 Windows SFX / NSIS 制品和原有完整桌面安装目录。使用固定 `7zip-bin` 解包，不执行安装向导；在解包前检查列表路径、链接、数量和容量，之后对物理文件创建 SHA-256 清单。程序、seal、artifact 先在 staging 完整写入，再提交整个目录；完整目录与索引写入之间的中断可在初始化时重新登记。来源摘要和程序内容摘要分别保存。

`LauncherNetwork` 使用应用专属 Chromium Session 管理系统 / 直连 / 固定代理，原子保存多组地址、npm / Python 镜像与 GitHub 镜像。`setProxy`、连接池刷新和每次生成子进程环境使用当前配置；鉴权发布只允许官方 GitHub API / Uploads 域名，拒绝 Token 重定向或镜像。便携工具由 `portable-tools.ts` 在主日志初始化后加载，工具字节、完整清单、第三方许可和打包门禁见 [便携工具说明](portable-tools.md)。

官方下载使用 Electron `net.request` 的 Chromium 网络栈，保留系统代理，在每次重定向事件中确认 HTTPS 后跟随。不要依赖 `net.fetch` 的 `Response.url`：实际 Electron 返回空字符串，会导致 `new URL` 抛出 `Invalid URL`。传输流受取消和超时信号约束，校验长度和来源摘要，异常只记录为失败操作，并移除未完成文件。真实 Electron 网络夹具覆盖重定向、降级、取消、截断和摘要不符；官方完整安装包下载、解包与封存复验也已通过。

Electron 会把 ASAR 当作虚拟目录，因此 DSH 的 `disk.ts` 使用 `original-fs`。物理 ASAR 通过 FileHandle 有界块读取，避免 Node stream 内部重新使用 Electron 的虚拟 fs。完整备份归档也从该物理读取器惰性取流，不展开或遗漏 ASAR 文件。

Windows 的运行计划同时对程序目录取 `realpath`，再由同一物理前缀产生 exe 与 ASAR CLI 路径。
`WorldlineBox` 与 `worldlinebox` 在 Windows 可指向同一目录，但不同大小写的文件 URL 会让
Node ESM 实例化两份模块；官方 `app-boot` 的 Include WeakMap 因而不能识别根配置，原生设置
写入会报 `profile reload requires the root Include entry`。统一物理路径修复该问题，不改动 sealed 程序。

当前 `desktop-cli-web-v1` 适配器启动固定制品中的：

```text
DeepSeek Harness.exe --expose-internals resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js web --no-open --host 127.0.0.1 --port 0
```

启动环境设 `ELECTRON_RUN_AS_NODE=1`，由该发行物提供宿主 ABI 与私有包管理工具。Home、agents、user、包缓存、临时目录与浏览器分区各实例独立；默认工作目录进入共享 workspace。边界见[使用指南](../user-guide/dsh-launcher.md)。上游命令通过参数数组调用，禁止 renderer 任意 shell 命令。未来发行物必须具有可识别的 Desktop/CLI descriptor 和入口，实际就绪交换也必须通过；缺少适配能力时失败，不把未知版本伪装为已兼容。

## 共享存档与模型设置

`SharedInstanceData` 在实例启动前协调共享迁移与技术路由。独立 `DSH_HOME` 和 web profile
继续持有插件、技能、锁文件及实例 UI 状态，不通过共享整个 Home 或 profile 实现存档。

| 共享内容 | 受管路径 / 原生入口 |
| --- | --- |
| 会话 | `shared/sessions`，`session-persistence-jsonl.root` |
| 附件 | `shared/attachments/v1`，`attachment-local.dshHome` |
| 默认工作区 | `shared/documents/deepseek-harness/default-workspace`，`workspace-controller.documentsDirectory` |
| 登录 / API 凭据 | `shared/.credentials.yaml`，原生 CredentialsLocal 文件与跨进程锁 |
| 模型设置 | `shared/model-settings.json`，选择性同步到各私有 `profiles/web/cordis.patch.yml` |

共享日志之外，`shared-workspace-adapter.ts` 生成实例私有的技术插件，在已运行的官方 Web Host
中同步共享默认工作区的会话成员和列表摘要。官方 workspace v2 只在首次启动分组已有日志，
不能仅靠共用 Session 文件发现另一 Host 后来创建的会话。适配器使用原生
`workspace.attachSession` 与 `sessionQuery.observeSession`：读取并验证 Header / cwd，
更新本实例索引、发布原生列表事件，不创建 Agent、抢占会话 writer 或改写聊天日志。
标题等投影使用只读 observation 的准确切面，保留为有界内存摘要；不把可能含恢复事件的
冷读切面写回 checkpoint。派生列表摘要服务于首次读取与重连，关闭插件时恢复原处理器。
程序制品保持密封，插件清单、私有工作区排序与 UI 偏好保持独立；用户删除的工作区注册不会
被后台重新创建。冷摘要通过实际输入与返回值协商，不按发行版本号选择调用方式。共享资格来自安装后自动执行的隔离原生检测，绑定完整制品 SHA-256 和检测代码摘要；前后端均读取检测证据，不再维护发行版本白名单。流程、检查项和失败边界见 [运行版本兼容性检测](dsh-runtime-compatibility.md)。

模型设置只共享当前官方适配器的四个 namespace：`llm-deepseek`、`llm-pi-ai`、
`llm-deepseek-account` 和 `agent-default-model`。`shared-settings.ts` 按已知字段读取和改写，
保留 profile 的插件条目、顺序、禁用状态、skills、其它选项以及 `ui-settings-general`。
`apiKeyEnv` 是引用，密钥值由共享凭据提供；回调与诊断仅包含 namespace、字段路径与错误码。

启动前在停机 profile 中同步。在线使用 `shared-settings-rpc.ts`：认证实例 ready URL 得到
HttpOnly Cookie，向同一 loopback origin 的 `/api/settings/describe`、`/api/settings/mutate`
发送官方 unary envelope，写入携带 namespace 的 `expectedRevision`。经认证
`/api/remote.mux` 的 `$events` 监听 `settings/document-updated`，并以有界周期读取作为失联兜底。
协调器串行收集各实例的 user config，按最后同步基线进行三方合并：不同字段可合并，同字段双改
明确报告冲突，CAS 失败不盲目重试。涉及已脱敏 secret 路径时拒绝替换，保留实例值。

完整备份恢复先调用 `assertImportableFrom` 做只读模型冲突预检，与会话 schema 和凭据 dry-run
一起完成后才发布共享内容，避免最后才发现模型冲突而留下部分导入。它不写 canonical 设置或
实例基线；正式 `importFrom` 再合并允许的值。恢复阶段需全部 Web Host 和 CLI 停止。

不能用 Home patch 或 CLI `--patch` 覆盖模型设置：官方 ConfigEditor 会拒绝其 UI 写入，
因为最终配置被更高优先级的层覆盖。技术 patch 路由共享存储和凭据，并挂载只读会话列表桥；模型仍写入原生可编辑的
私有 profile，并由原生锁、HMR 与 revision 校验提交。实际官方 0.2.0-rc.2 的原生 provider
修改、过期 revision 拒绝和 WS 推送已在 canonical 程序路径与完整 instanceEnvironment 下验证。

## CLI 上下文与逐行终端

`cli-terminal.ts` 的 `DshCliTerminal` 持有当前 CLI 上下文、命令 shim 与受管 PowerShell，
状态通过 `DshLauncherState.cli` 分发。`cli.select` 只选择实例，不启动 Web Host；
`cli.install-command` 显式把 bin 放到当前用户 PATH 首位，并广播环境变更。命令位于
`dsh-launcher/cli/bin/dsh.cmd`；只更新管理器标记的文件，不覆盖其它命令文件。机器 PATH 的
同名命令若仍会抢先则拒绝启用，不改机器 PATH；已有用户 PATH 命令文件保留。

shim 每次读取 `cli/context.json`，检查实例、精确 runtime 摘要和受管路径，然后用选中版本的
Electron Node 调用随包 CLI。无参数 `dsh` 使用自身 readline 循环，逐轮向原生 headless
driver 发送任务并保留会话 id；`/new` 清除当前会话选择，`/exit` 退出，不删除共享日志。
有参数时直接转发原生 CLI 参数。

`cli-profile-mode.ts` 沿用实例私有 web profile 与已安装插件树，附加官方 `dsh-headless`
bundle，再关闭 `web-startup`、`webserver`、`web-runtime`、`connection`、`modules` 等
Web carrier 条目。外置 patch 不改 sealed runtime、manifest 或插件安装；共享存储技术路由
随后附加。任何发行版本都可以接受同一套实际能力检查；共享存档必须具有当前制品的通过证据。原生 CLI 组合始终检查随包 manifest 与 Web / headless transport 行，未知能力不会因为版本名称较新而获得放行。

`terminal.open/input/resize/select/clear/export/remove/close` 管理多会话真实 ConPTY。
`node-pty` 在独立 RunAsNode worker 内加载，主进程先把 worker 放入 Windows Job，再允许其创建 PTY。
Shell 自然退出和关闭都会等待 Job 活动进程归零，解决 ConPTY conout worker 残留导致主进程不能退出的问题。
原始 ANSI 流使用 revision + UTF-16 offset 有序增量，单会话保留 64 KiB、最多八个活跃和八个保留会话；清屏会隔离旧 IPC 增量。xterm 的输入和 resize IPC 不触发全页面刷新或通知。
默认 CLI 上下文可以在终端运行时更新；每个终端、执行任务使用独立固定上下文文件，已有任务不会改换程序、插件和工作区。

`LauncherTerminal` 保留用户的非底部输出滚动位置，回到底部后跟随增量输出；命令发送不重建
工作区或弹出逐条成功提示，IME 选词键不参与历史切换。`dsh-launcher-ui.test.tsx` 覆盖这些
行为；共享设置 shutdown 测试还确认挂起的 HTTP 读取会在 dispose 时先取消，再等待串行队列。

## 主脑与角色调用的任务入口

未来角色和主脑委托统一使用类型化 `task.run` / `task.cancel` / `task.result` / `task.events`，实时订阅 `onTaskEvent`。`DshTaskBroker` 在请求进入时固定实例与精确运行版本，使用受管 CLI shim、私有上下文、共享账户路由和原生 headless 驱动，不通过用户全局 Node 或猜测 PATH 中的其它 DSH 执行。切换默认实例只影响后续任务；既有任务的 metadata 和进程保持原绑定。

任务 ID 与操作 ID 相同，最多四个同时执行，结构化输出有行、总量和保留上限。Prompt 通过 stdin 发送，任务登记不保存 Prompt、工具参数或密钥；回复只在内存里保留，原生会话 ID 记录可用于继续会话。重启时未完成记录标记 interrupted，不擅自重复执行可能有外部副作用的任务。取消只终止该任务的 Windows Job，并释放固定上下文。

两个真实版本已验证无模型账号时的任务失败仍记录正确绑定；成功回复与取消的执行协议由实际子进程夹具覆盖。真实模型任务需要用户在 DSH 中配置账户或 API。

## 监督与一致性

只有上游完成初始化打印专属 `dsh web:` URL，且其 token 交换返回本适配器预期的 HTTP 303 / `Location: ./` / Set-Cookie 后，才标记 running。认证 URL 仅保存在主进程内存，不进入状态或磁盘日志。工作台是独立 BrowserWindow，没有管理器 preload，使用实例专属 partition，限制跨源导航和新窗口。

每个实例的写操作互斥。插件命令、克隆、快照、包生成不并发修改同一 Home。Web 启动全局串行且同时只允许一个 Host；普通第二次启动拒绝，明确 `instance.switch-start` 才停止旧 Host 后启动新实例。默认 CLI 选择携带主进程意图序号，较慢的旧选择请求或旧启动回调不能覆盖较新的选择。停止只结束观察到的自有子进程树。恢复 journal 通过 PID、可执行路径、CLI 路径和 Windows 创建时间确认身份，避免误杀复用的 PID。进程或插件安装崩溃不会要求管理器一起退出。

静态 JSON/YAML 配置审计与链接审计保护已知管理数据位置；YAML 使用不执行自定义 tag 的解析器和别名 / 深度限制。不可将这个边界解释为第三方插件代码的 OS 沙盒。克隆重绑定受控配置和 pnpm 布局中的旧实例路径，不改写用户工作区源码。

DSH 0.2.0-rc.2 的会话 Header 保存绝对 cwd。`instance-data-rebase.ts` 仅在停机新副本内迁移受管实例的内部 cwd，并按官方 projectKey 重定位所有日志世代；Zstd 日志仅重写首个 Header frame，后续聊天事件 frame 字节保持原样。Workspace v2 只重写对应 path；清除已知可再生项目缓存，记录迁移摘要。外部用户项目保留。未知会话格式或运行版本存在内部引用时拒绝迁移，原实例和完整备份仍保留。官方 writer / loader API 已验证迁移后的 list / open / read。

Windows 的受管进程立即加入实例专属、不可继承句柄的 Job Object，关闭句柄、Host 退出或管理器崩溃都会结束所属子树。旧 PID journal 恢复仍核对精确身份；不通过进程名终止其他应用。

归档每次只消费一个物理文件源，输入与输出错误均进入操作结果。1,200 文件压力验证断言源句柄峰值为 1；模拟 EMFILE 会失败并删除 partial，避免未捕获 stream 错误产生原生错误弹窗。耗时操作临时关闭主窗口节流并使用有界并发校验，结束后恢复窗口策略。

启动器依赖在主日志初始化后加载，其构造、依赖或注册表失败局限在启动器模块，资产主窗口继续可用。Electron 真实验证覆盖损坏的登记文件和缺失的启动器依赖。

操作 journal 在发出任务前写入，重启时将未完成操作标为 interrupted。复制升级永远新建私有环境，继续使用共享存档。快照只恢复实例执行环境；完整备份另含共享层，导入导出需全部 DSH Host、内置终端和外部受管 CLI 停止，先预检再合并缺失数据与保留冲突。程序版本回退与共享数据格式降级是不同问题。

`copyData` 封存 `home`、`agents`、`workspace`、`user`，已迁移实例排除这些目录里的共享
会话、附件、默认工作区和凭据原件，以及模型共享字段；共享层由 `exportTo` 单独封存。
外层完整备份再追加精确 `runtime/program`。Electron partition 在管理器 sessionData 下，不在
实例 `user` 内，故 Cookies / LocalStorage 不随归档；可再生缓存、事务锁及 `.cli-users` 控制树排除。

完整 `.dshbackup` 同时封存实例数据、内层备份清单和程序制品。外层归档检验全部字节，内层实例恢复再次核对数据清单与精确程序摘要。软件 `.dshpack` 的边界另见[整合包格式](dsh-packs-format.md)。备份包含凭据，包不包含默认私有账户和会话数据。

## 验证

单元测试包括运行制品去重与篡改、路径 / 归档校验、单 Web 启动与显式切换、配置与插件隔离、依赖锁重放、不同测试版本的升级副本、快照恢复、取消与身份匹配恢复，以及 UI 请求与异步错误。模拟版本只用于测试，不修改官方版本标签。此前双 Host 验证属于采用单工作台要求之前的历史验证。

实际官方 Windows 0.2.0-rc.2 / Node 24.18.1 已验证下载、SFX 提取、固定制品封存、双实例并行启动、单独停止、插件 list、包创建与新实例安装启动、快照恢复及应用重启。验证没有发送模型请求、读取原 `.dsh` 的凭据或执行实际账户登录。

```powershell
# 使用项目 Node 24 执行 vitest / playwright；普通本机 Node 也须满足项目要求。
node node_modules/vitest/vitest.mjs run tests/unit/dsh-runtime.test.ts tests/unit/dsh-instance.test.ts tests/unit/dsh-pack.test.ts tests/unit/dsh-launcher-ui.test.tsx
$env:WORLDLINEBOX_DSH_REAL_DIRECTORY = (Resolve-Path '.tools/dsh-research/extracted').Path
node node_modules/vitest/vitest.mjs run tests/unit/dsh-pack.test.ts
$env:WORLDLINEBOX_DSH_TEST_RUNTIME = $env:WORLDLINEBOX_DSH_REAL_DIRECTORY
node scripts/run-e2e.mjs tests/e2e/dsh-launcher.test.ts
```

桌面测试应设置 `WORLDLINEBOX_E2E_ISOLATED_BUILD=1`，使用 `.tools/e2e-app/.vite` 和独立临时用户目录；本任务的测试通过 `resolveElectronAppPath()` 获取该测试应用。该模式不清理或覆盖开发中的 `.vite`。DSH 工作台验证使用静默窗口，不在用户桌面反复弹出测试窗口。

真正不同官方数据 schema 的升级 / 降级、第三方原生插件 ABI 兼容、模型请求和平台账户仍需在对应版本和账户上验证。管理器展示失败与保留原环境，不承诺自动兼容所有插件。

2026-10-12 首轮 Windows x64 检查：主程序 / 扩展 TypeScript 与修改文件 ESLint 通过，49 项普通单元测试通过（6 项需显式环境或其他平台的测试跳过），7 项隔离 Electron 验证通过。另已显式执行官方 HTTPS 下载 / SFX 导入、真实原生插件安装与移除 / 包安装后继续管理依赖，以及官方 Session API 写入与迁移后读取的验证。完整备份的真实桌面流程包含空白环境离线导入运行文件、恢复数据和再次启停。未执行模型请求。

后续共享用户目录与安装提交修复验证：真实 Electron 使用已有官方安装包分别测试短时锁、持续可读锁与独占锁。三种原生 `CreateFileW` 占用均复现目录移动 `EPERM`；修复后重试、复制校验、失败保留与恢复通过，每例封存 9,769 个文件并在重新初始化后再次校验。未重新下载安装包。Vite watcher 开启前 / 开启时 / 关闭后同目录移动分别为成功 / `EPERM` / 成功，证明项目内存储会受开发监视器影响；历史失败的具体句柄持有者无法追溯。

共享目录、浏览器存储持久化与 E2E 隔离、旧缓存校验迁移、历史通知清理、全局壁纸、设置导航及启动器故障隔离的 7 项桌面回归通过。主程序 / 扩展类型检查及修改文件 ESLint 通过；Forge 开发和生产配置共 18 次隔离构建不再出现 `inlineDynamicImports` 弃用警告，真实 Electron 日志事件验证不再出现 `console-message` 弃用警告。
