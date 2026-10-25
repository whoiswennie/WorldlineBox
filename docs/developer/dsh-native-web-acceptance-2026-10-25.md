# 原生 DSH Web Host 接入验收（2026-10-25）

本次验证在 Windows x64 上通过代码、Electron 测试进程及实际 DSH Web Host 完成。没有使用电脑操控技能。验证对象是 GitHub Release 对应的官方 Web 分发，与 DSH 桌面版无关。

## 发行与运行边界

- [官方 Web 安装方式](https://www.deepseek.com/harness/)是运行 `@deepseek-ai/dsh web`。[RC.2 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) 的附件为源码归档和证明文件，不能把源码 ZIP 当成已构建 Web 应用。
- 启动器版本目录取官方 GitHub Release 与官方 npm Web 包的交集。安装再次验证精确 `dsh-v<version>` tag、包名、版本、官方 tarball 地址及 SHA-512 SRI；包依赖、Node、npm 和运行文件均封存校验。GitHub 不可用时只展示已核对的缓存，不把 npm-only 版本悄悄变成可安装发行版。
- 已移除 Desktop 安装器、EXE/ASAR 运行适配、旧整合包格式、旧共享存档/凭据层和伙伴专属 CLI。当前唯一适配器为 `node-cli-web-v1`，直接执行官方 `web` 命令。
- 一个实例拥有自己的原生 Home、agents、workspace 和一个常驻 Web Host。用户 Web UI 与绑定该实例的伙伴共享 Host、账号、模型、插件和技能；任务各有原生 Session。多版本、多实例仍独立存在，不混合不同版本的存档。

## 实际安装与旧版本清理

按用户授权，通过项目 `RuntimeService.delete` 删除原运行版本 `runtime-7166bc2240b170bff29c0dfe`，删除时当前引用为空。证据：`artifacts/dsh-latest-install/old-runtime-cleanup.json`。未操作机器上另行安装的 DSH。

经新的 `runtime.install` 路径重新下载、安装并验证 RC.2，完整安装耗时约 152 秒。这是下载和解析、安装 557 个依赖及封存约 8 亿字节运行文件的一次性成本，不在每次伙伴调用时重复。

实际运行制品：

| 项目 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.2` |
| 来源 | `npm:@deepseek-ai/dsh@0.2.1-rc.2`，对应官方同版本 Release |
| Node / npm | `24.15.0` / `11.12.1` |
| 运行 ID | `runtime-7df5783bbce9ffa55b8bda32` |
| 文件 / 字节 | 63,645 / 829,676,325 |
| 当前实例 | `c5183485-db1e-446b-9bba-e6c8535e3ff8`，我的 DSH |

安装证据：`artifacts/dsh-latest-install/install.json`。增加精确 GitHub Release 安装前置检查后，又通过同一个启动器安装接口复验，包含发行目录核对总计 142.881 秒，得到相同运行 ID 与摘要；该次发行目录与安装结果保存在 `artifacts/native-release-final/`。

另外核验到用户 PATH 仍残留旧启动器的 `dsh-launcher/cli/bin`，其 `dsh.cmd` 具有 WorldlineBox 自有标记。仅移除了这一条旧受管 PATH 记录，没有修改独立 DSH 安装；新启动器内终端使用新原生路径。证据：`artifacts/native-release-final/retired-path-cleanup.json`。已打开的终端和应用需要重新启动以获得新的 PATH。

另实测 RC.3 时，官方依赖 `@deepseek-ai/dsh-acp-app@0.2.1-rc.3` 返回 `ETARGET`。截至验收，GitHub 已有 RC.3 Release，但这不代表其全部 npm 依赖都可安装。该错误如实返回，未修改官方依赖、伪造成功或替换成 RC.2；本次按用户指定验证 RC.2。

真实 Electron HTTPS 下载测试覆盖：原始 Response URL 为空、HTTPS 跳转、拒绝降级 HTTP、503、空响应、截断、摘要不符、取消和残留清理。测试调用当前 Node Web 安装器使用的下载函数。证据：`artifacts/native-download-transport.txt`。

## 小肥鱼查看桌面的真实调用

使用当前小肥鱼、实际伙伴主脑、实际 `dsh` 工具与实际 DSH 模型执行两次；测试聊天与执行记录隔离保存。请求为只读枚举当前 Windows 桌面顶层，含隐藏项，不递归，不写入文件。

| 阶段 | 第一次 | 第二次 |
| --- | ---: | ---: |
| 用户消息进入 → 小肥鱼正式交付 | 35.152 秒 | 31.153 秒 |
| 主脑 `dsh` 工具调用开始 → 返回 | 28.161 秒 | 23.236 秒 |
| 其中：伙伴世界到达执行位置的等待 | 8.667 秒 | 8.806 秒 |
| 启动器收到提交 → 任务回执 | 0.0079 秒 | 0.0048 秒 |
| DSH broker 接手 → 完成 | 19.184 秒 | 13.962 秒 |
| 其中：连接/准备 Host | 2.603 秒 | 0.039 秒 |
| 其中：创建原生 Session | 0.167 秒 | 0.063 秒 |
| 原生 Agent 就绪 → 原生执行完成 | 16.409 秒 | 13.858 秒 |

两次使用同一 Host PID `1892` 和不同 Session。第一次调用发生在后台预热尚未完成时；第二次连接加建会话为约 0.102 秒。阶段存在包含关系，不能将整张表相加。主脑工具调用还包含世界行走等待，不能将这 8 秒多算成 DSH 启动。

两次均交付 58 个顶层条目：41 个文件、17 个文件夹；与独立只读目录枚举逐项比较，无缺失，执行前后目录清单未变。DSH 执行时间主要是原生模型与实际工具运行，已不包含每任务重建 CLI、覆盖模型配置、合并共享存档等旧步骤。

精确证据：

- `artifacts/native-web-fish-final/summary.json`：从真实 trace 和原生审计记录提取的时间。
- `artifacts/native-web-fish-final/run-oIsg8t/trace.json`：完整调用链。
- `artifacts/native-web-fish-final/run-1-tool-input.json`：主脑实际 `dsh` 工具参数。
- `artifacts/native-web-fish-final/run-1-host-input.json`：工具到启动器的原始请求及来源约束。
- `artifacts/native-web-fish-final/run-1-tool-output.json`：真实结构化返回和完整桌面清单。

实际主脑输入结构如下，省略长提示词：

```json
{
  "operation": "run",
  "tasks": [{
    "title": "列出Windows桌面顶层内容",
    "prompt": "只读枚举实际桌面顶层，含隐藏项，区分文件与文件夹，不递归、不写入。",
    "delivery": { "format": "text" }
  }]
}
```

工具返回 `tasks[]`，每项包含真实 `status`、`recordId`、原生 `session.id`、`statistics`、`finalReply`、`verification` 和能力摘要。它通过普通原生插件调用 Session Controller 创建会话、提交 prompt 并接收事件流，最终由小肥鱼交付。没有启动伙伴专用 CLI。

旧截图中的 7 分钟等待和过去的 1 分 48 秒，缺乏足够的同期完整 trace，不能断言其全部耗时均来自某一个 DSH 启动步骤。本次改造移除了已知重准备链路，并记录了当前各阶段实际耗时。

## 市场插件与技能共享

通过与启动器界面相同的 `DshLauncher.handle` 后端入口完成市场查询与安装，随后从原生用户 Session 和两个不同伙伴 Session 验证。测试未为伙伴重复安装环境。

| 内容 | 验证 |
| --- | --- |
| `dsh-glass-weather@0.3.0` | 原生 Web UI 加载 client 模块和样式；用户和伙伴均发现 `get_weather`；两个伙伴实际调用上海天气并返回工具数据 |
| `@climber47/dsh-step-clock@0.1.1` | 原生 Web UI 加载时钟 client 模块和样式；安装后 Host PID 不变。该插件为 UI 能力，不虚构伙伴可调用的工具 |
| `@deepseek-ai/dsh-experimental-badge-skill-bundle@0.2.1-rc.2` | 通过官方 npm 包安装，进入同一原生插件目录 |
| `anthropics/skills` 中的 `internal-comms`、`webapp-testing` | 技能市场下载固定 commit `dbd4588f9e1033efb41dad4bef2f7947c8993d44`；原生用户 Session 和两个伙伴均发现；伙伴实际读取技能 |

市场证据：`artifacts/native-launcher-market/result.json`、`web-ui.json`、`deepseek-flash-events.json`、`sister-events.json`。用户 Web UI、插件安装及两伙伴任务使用同一 PID `39400`。原生页面加载通过代码级 Electron BrowserWindow 验证。

另用随机标记插件 `native_marker`、加法插件 `native_add` 和本地原生技能验证：

1. 两个伙伴并发执行，实际调用插件与技能，返回随机标记、42、技能标记，分别通过 JSON Schema 验证。
2. 限制单会话工具/技能与纯认知模式后，原生能力目录按会话生效，其他用户 Session 不受影响。
3. 停用/启用插件时检查原生返回。停用曾返回 `restart-required`、原因 `package-moved`；启动器持久化并展示需要重启，按要求重启后用户和伙伴能力同步变化。不能将“配置已保存”误报为当前 Host 已生效。
4. Host 重启后，插件/技能仍存在；恢复同一原生 Session，真实历史上下文保持。RC.2 的恢复使用 `resolveAgent`，避免调用 `create` 时替换已有会话。
5. 备份/恢复原生 Home、agents、workspace，由原生包管理器重装依赖；恢复后新 Host 可继续旧原生 Session。普通 workspace 中的 logs 文件也保留。

证据：`artifacts/native-web-ecosystem/` 的 `toggles.json`、`adoption.json`、`resumed.json`、`backup.json`；完整测试日志 `artifacts/native-web-final-integration.txt`，47.55 秒通过。

## 回归与构建

| 检查 | 结果 / 本地证据 |
| --- | --- |
| DSH 单元测试 | 41 文件，206 通过、1 跳过；`artifacts/dsh-native-unit-final.txt` |
| 伙伴服务与任务监控 | 126 通过，真实 Electron ABI 运行；`artifacts/dsh-native-companion-unit.txt` |
| 原生能力查询 | 实际 Host、完整分页技能、原生工具 schema/命令，模型请求数为 0；`.tools/test-output/companion-dsh-capability-describe-native.json` |
| 类型检查 | `npm run typecheck` 通过；`artifacts/dsh-refactor-typecheck-final.txt` |
| 修改的 DSH 代码 lint | 通过；`artifacts/dsh-refactor-lint-final.txt` |
| Main / Preload / Renderer | 均通过生产构建；`artifacts/native-main-preload-build.txt`、`artifacts/native-renderer-build.txt` |

原生 DSH 的插件引擎范围、工具权限、模型可用性、依赖发布完整性和必要重启行为仍按上游执行；没有保证任意未来插件无需重启或修改就能运行。上述验证覆盖实际安装、用户/伙伴共享、热加载与需要重启两种结果、会话恢复和备份恢复。

当前运行中的应用不会自动替换已经加载的 Main 模块。使用这批改动需要安装本轮生成的版本并完整退出、重新启动 WorldlineBox；新版本随后连接受管原生实例。2026-10-26 已制作 Windows 安装器，并通过真实打包版启动与记忆验收；具体校验和、完整回归结果和验证边界见 [伙伴核心交互验收](companion-core-acceptance-2026-10-26.md)。没有替用户安装新版本。
