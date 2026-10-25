# DSH 原生 Web Host 接入

本实现以官方 DSH npm 运行版本与原生 `web` profile 为中心。每个实例运行一个持久 Web Host，用户工作台和所有使用该实例的伙伴通过同一套原生服务工作。没有伙伴专用 CLI、伪用户目录、跨版本共享存档或存档格式改写层。

## 版本与实例

`RuntimeService` 保留官方发行索引、下载、npm SRI 与 SHA-256 校验、固定依赖锁、Node 版本、运行文件封存、完整性缓存、安装提交恢复和引用感知删除。版本必须同时具有官方 GitHub Release 和同版本官方 npm Web 包；安装时再次检查精确 tag。发行物缺少依赖时安装失败，不能通过修改依赖或替换版本冒充成功。唯一运行适配器为 `node-cli-web-v1`，直接运行官方 `dsh web`，与 DSH 桌面版无关。

截至本次验收，GitHub Release 附件是源码归档和证明文件，官方 Web 分发入口是 `@deepseek-ai/dsh`。启动器选择 Release 版本后安装对应的精确 npm 包，不把 GitHub 源码 ZIP 当成可运行的 Web 制品。移除了 Desktop EXE、ASAR、桌面安装器解析和旧包格式兼容分支。

根目录是 `app.getPath('userData')/dsh`。原生实例与快照的注册文件分别为 `native-instances.json`、`native-snapshots.json`。旧目录没有迁移或 fallback 入口。

`InstanceService` 为每个实例提供原生 `DSH_HOME`、`DSH_AGENTS_HOME`、workspace 和浏览器 partition。`instanceEnvironment` 继承真实用户环境，仅清除上一 DSH 命名空间和启动器内部能力变量，再设置当前实例的原生命名空间。用户 PATH、HOME/USERPROFILE、APPDATA、Git、Python 和包管理器配置不伪装成另一个用户。

Host 启动采用参数数组执行原封不动的官方 `web --no-open --host 127.0.0.1 --port 0`。完整性检查只在 Host 启动时进行，缓存依据实际文件身份失效；任务和重复选择不触发全文件扫描。首次通过原生 CLI 生成默认 profile、安装桥接 bundle，内容 stamp 避免每次安装。

每个实例的并发 `ensureHost` 合并为一次启动，取消一个等待者不影响其他等待者。多个实例可同时运行。就绪要求：原生认证 Web URL、桥接就绪标记、协议/PID 健康检查和 Web 认证 cookie 交换全部成功。启动最多等待 120 秒，并保留真实日志。

进程由 Windows Job 与 PID/创建时间/解释器/CLI 身份记录管理。停止优先走原生优雅退出，超时只清理自己拥有的进程树。退出确认、journal 删除、状态落盘与工作台关闭完成后，stop 才结束。

## 标准桥接插件

`resources/dsh-bridge` 是普通 Cordis bundle，随应用资源分发，经原生 `plugin add` 安装到每个实例。DSH 代码、预设与模型配置不打补丁。其源码按内容摘要放在实例 Home 的 `.worldlinebox/bridge/<hash>`，打包配置在 `forge.config.ts`。

插件通过原生 `sessionController`、`agents`、`sessions`、`tools` 和 `agentPresets` 服务工作。启动时从环境读取随机 256-bit 能力 token 后立即删除，避免下游工具继承。独立监听 loopback 随机端口，所有请求要求 Bearer 能力，没有 CORS；健康检查验证协议与 PID。原生 Web 的用户登录与鉴权继续由 DSH 持有。

主要协议：

| 入口 | 行为 |
| --- | --- |
| `GET /health` | 返回协议、PID 与原生 profile 身份 |
| `POST /sessions` | 原生创建或采用 Session，返回事件游标、真实能力及权限 |
| `POST /sessions/:id/prompt` | 原生队列/steer 提交，使用稳定 requestId 去重 |
| `GET /sessions/:id/events?after=N` | 推送带序号 NDJSON 公开事件 |
| `POST /sessions/:id/cancel` | 取消该 Session，等待 Agent/子代理停止并 flush |
| `POST /capabilities` | 读取原生工具、技能、预设与命令，无模型请求 |
| `POST /plugins` | 调用原生 bundle 安装、开关、移除、列举 |
| `POST /shutdown` | 原生 Host 优雅退出 |

完成事件等待 Agent 空闲、子代理结束、队列与 session 序号稳定并 flush。只转发公开文本、工具输入输出、状态和交付物，不转发模型推理。事件保留有数量/字节上限；慢消费者断开，客户端遇到断流按失败处理并取消所属 Session，不会误报完成。

普通任务继承原生默认预设、全部工具/技能与权限。显式工具/技能选择通过 Agent scope 的原生 registry 与工具 guard 实施，子代理继承边界；用户和其他伙伴的 registry 不变。仅思考任务使用新会话、只读权限和空工具集合。无伙伴专属模型或凭据覆盖。

## 伙伴主脑循环

`CompanionService` 使用 `dsh` 能力接口，查询与执行由 `DshLauncher` 转交 `DshTaskBroker`。提交操作快速登记后，broker 连接所选实例 Host，准备授权工作区，创建原生 Session，再发送 prompt 并订阅事件。DSH 自己完成 Agent loop、工具调用、子代理、审批和存档。

Main 从伙伴状态读取 `companionName`；该字段不属于模型 TaskSpec。默认托管工作目录固定为库内 `dsh-tasks/<companionId>`，不按任务另建 cwd。桥接插件通过原生 `workspaceRegistry.create(cwd, companionName)` 登记工作区、用 `workspaceId` 创建 Session，并由原生 API 关联会话。显示名随伙伴改名更新，底层路径保持稳定；同名伙伴不合并目录。指定已有项目目录时不发送伙伴工作区标题。已存在的 Session 恢复保留原 cwd，不改写原生存档。

`tests/worker/dsh-companion-workspace-native.test.ts` 使用真实 RC.2 Web Host 验证并发会话归组、同名伙伴隔离、改名和重启持久化，模型请求数为零；证据写入 `artifacts/companion-workspace-native/result.json`。

broker 负责来源 ACL、授权证据、输入校验、恢复所有权、交付 JSON Schema 与真实产物检查。恢复固定原实例、版本、目录与策略，任意 sessionId 不能绕过任务 checkpoint；切换默认实例不影响在途任务。

取消只发给所属 Session。传输失败仍尝试确认原生取消；无法确认时记为 interrupted，并阻止该 Session 恢复，直到终止确认。早到的补充输入等待初始 prompt 受理，再按 messageId 去重送入原生收件箱。

`DshTaskRecordStore` 保存独立的来源审计投影与按行索引，运行时环缓存不替代完整记录。DSH 的权威会话仍保存在原生 Home。启动指标分别记录连接/工作区准备与创建 Session 的耗时；端到端主脑交付时间需另行从真实用户消息计时。

## 插件、技能、终端和备份

运行中插件变更调用同一 Host 的原生 plugin manager；停机操作使用所选运行版本的原生 CLI。原生应用失败/取消必须报告失败，不能只看命令已受理。断开安装请求会取消原生安装。插件是否热加载或需要重启由上游决定。插件市场搜索同时匹配展示名、npm 名和来源。

技能安装仍有固定 Git commit、下载摘要与安全解包检查，目标为原生 agents/skills；文件变化直接供 DSH 发现。用户 Web UI 与伙伴能力查询读取同一个 registry。

用户终端是显式功能：ConPTY 和可选导出 dsh 命令使用相同原生 profile 与真实用户环境。它不参与伙伴任务执行，不覆盖机器上已有的官方命令。

复制/升级建立新的原生配置副本，不合并会话格式。快照/私人备份保存停止实例的 Home、agents、workspace 与精确运行引用，不复制运行缓存、node_modules、事务锁或浏览器存储；快照恢复要求保留匹配运行版本；完整 ZIP 备份还包含可校验导入的运行制品。实例依赖由原生包管理器重建。整合包去除凭据、会话及启动器自供的本地桥接依赖，见 [包格式说明](dsh-packs-format.md)。

## 验证

```powershell
npm run typecheck
npx vitest run tests/unit/dsh-
# 使用已安装版本，临时原生 Home；不请求模型
npx vitest run tests/worker/dsh-capability-describe-native.test.ts
# 以下显式使用已配置的真实模型，分别运行，不要并发操作同一个用户管理器
$env:WORLDLINEBOX_DSH_ECOSYSTEM_REAL = '1'
npx vitest run tests/worker/dsh-native-web-ecosystem.test.ts
$env:WORLDLINEBOX_DESKTOP_TRACE_REAL = '1'
npx vitest run tests/worker/companion-desktop-dsh-trace-real.test.ts
```

真实安装、市场入口、共享插件/技能、重启持久化、伙伴桌面任务与耗时证据见 [2026-10-25 验收](dsh-native-web-acceptance-2026-10-25.md)。历史日期文档描述当时实现，不是当前架构规范。
