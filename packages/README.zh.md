# Worldline 包与插件地图

[English](README.md) | 中文

所有产品能力位于 `packages/<domain>/<package>`。Service Definition、Provider 和 Consumer 在能够独立演进时拆包；应用 Bundle 选择实现。

| Domain | 职责 |
| --- | --- |
| `core` | Session、Prompt、Tools、Agent、Agent Loop、Scope 脊柱 |
| `llm` | 模型能力定义、DeepSeek/pi-ai Provider、重试和 token meter |
| `fs`、`shell`、`subprocess`、`terminal`、`lsp` | 本地与沙箱执行世界 |
| `sandbox`、`e2b` | 进程隔离和远程执行 Provider |
| `skill`、`video`、`web`、`browser`、`mcp` | 可复用技能、原生视频检查、外部知识、网页、浏览器自动化和 MCP 能力 |
| `subagent`、`workflow`、`jobs` | 并行 Agent、工作流和后台任务 |
| `session`、`session-query`、`storage` | 持久化、投影、检索和非 Session 数据 |
| `goal`、`plan`、`todo`、`compaction` | Agent 协作状态和上下文管理 |
| `interaction`、`feedback`、`schedule` | 人机协作、反馈和后续任务 |
| `api`、`typert`、`sdk`、`acp` | Host/Client Remote 与进程外协议 |
| `host` | WebServer、API Proxy、Directory Picker、Workspace Tree、受限媒体网关和 Desktop Browser |
| `client` | 浏览器 Runtime、Slot/Locale、UI 插件、常驻媒体界面和产品 Chrome |
| `auth` | Worldline 本地账户与访问控制 |
| `bundle`、`preset`、`boot` | Profile 组合、Agent Preset 和应用启动 |
| `extensions` | Cordis 自省与运行时插件扩展 |
| `runtime-diagnostics` | 包级运行时 invariant 注册表 |
| `credentials`、`settings`、`identity` | 用户配置、机密引用、持久化授权记录与流程，以及匿名身份 |
| `attachment`、`spill`、`workspace` | 二进制内容、大输出和 Workspace 实体 |
| `tools` | Worldline 独有的可选 Workspace 工具包 |
| `util`、`test-support`、`examples` | 基础工具、测试设施和可运行示例包 |

新增包必须更新本地图，提供 `./invariant`，并在 Host 或 Client TypeScript aggregate 中注册。详细规则见[知识库](../docs/README.md)。
