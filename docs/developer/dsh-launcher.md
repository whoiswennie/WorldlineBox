# DSH 原生 Web Host 接入

本实现以官方 DSH npm 运行版本与原生 `web` profile 为中心。每个实例运行一个持久 Web Host，用户工作台和所有使用该实例的伙伴通过同一套原生服务工作。没有伙伴专用 CLI、伪用户目录、跨版本共享存档或存档格式改写层。

## 版本与实例

`RuntimeService` 保留官方发行索引、下载、npm SRI 与 SHA-256 校验、固定依赖锁、Node 版本、运行文件封存、完整性缓存、安装提交恢复和引用感知删除。版本必须同时具有官方 GitHub Release 和同版本官方 npm Web 包；安装时再次检查精确 tag。发行物缺少依赖时安装失败，不能通过修改依赖或替换版本冒充成功。唯一运行适配器为 `node-cli-web-v1`，直接运行官方 `dsh web`，与 DSH 桌面版无关。

安装新版本时，生成依赖锁的 npm 元数据解析必须使用 `--prefer-offline=false --prefer-online`，备用源重试也相同，避免旧目录缓存遗漏新发布的依赖。自动模式在官方源与镜像之间提供一次故障切换；手动镜像缺包或不可用时，使用官方源及该目标的代理重试。固定依赖锁后的归档预取与 `npm ci` 继续复用经 SRI 校验的内容缓存，无需清空缓存。所有版本共用该流程，不对某个发行版打补丁，也不跳过完整性或 Node 引擎要求。

截至本次验收，GitHub Release 附件是源码归档和证明文件，官方 Web 分发入口是 `@deepseek-ai/dsh`。启动器选择 Release 版本后安装对应的精确 npm 包，不把 GitHub 源码 ZIP 当成可运行的 Web 制品。移除了 Desktop EXE、ASAR、桌面安装器解析和旧包格式兼容分支。

根目录是 `app.getPath('userData')/dsh`。原生实例与快照的注册文件分别为 `native-instances.json`、`native-snapshots.json`。旧目录没有迁移或 fallback 入口。

`InstanceService` 为每个实例提供原生 `DSH_HOME`、`DSH_AGENTS_HOME`、workspace 和浏览器 partition。`instanceEnvironment` 继承真实用户环境，仅清除上一 DSH 命名空间和启动器内部能力变量，再设置当前实例的原生命名空间。用户 PATH、HOME/USERPROFILE、APPDATA、Git、Python 和包管理器配置不伪装成另一个用户。

Host 启动采用参数数组执行原封不动的官方 `web --no-open --host 127.0.0.1 --port 0`。完整性检查只在 Host 启动时进行，缓存依据实际文件身份失效；任务和重复选择不触发全文件扫描。首次通过原生 CLI 生成默认 profile、安装桥接 bundle，内容 stamp 避免每次安装。

运行文件的完整性扫描上限为 15 分钟，给大型 SDK 依赖树、慢速磁盘和 Windows 杀毒扫描留出时间；等待者仍可单独取消。超时单独报告为「校验未完成」，不能据此判定文件损坏。

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

伙伴执行继承原生工具与技能，聊天、表情与 VCP 工具通过插件注入当前会话。原生子代理沿用伙伴工作区和当前能力。记忆编码与维护使用单独的原生会话，不构成另一层伙伴对话主脑。

## 每条消息的原生会话

`BotService` 只负责持久消息、权限、记忆准备与界面投影。它通过 `BotDshBrain` 连接启动器提供的原生 Host；每条消息使用 `turn-<eventId>` 派生新 Session。同一消息重试固定原 Session，同一伙伴后续新消息创建另一个 Session。没有本地模型循环、任务中心或 `DshTaskBroker` 执行框架。

伙伴工作目录固定为伙伴数据根目录下的 `workspaces/<SHA256(companionId)>`。桥接插件通过原生 workspace registry 把会话归入伙伴分组。显示名随伙伴改名更新，底层路径保持稳定；同名伙伴不合并目录。

`sessions_list/read/send/wait/spawn` 使用 DSH 原生持久化、会话控制和子代理服务，在本人工作区显式发现历史、读取正文、发送消息或新建子会话。不会把全部旧会话自动放入新请求。

`BotStore` 保留旧数据库表与版本迁移以保护历史聊天、产物和来源授权，旧任务创建、控制、通知、调度及本地主脑保留状态 API 已删除。当前气泡保存原生执行事件和最终正文；原生 `present` 交付经过文件核验后投影为该气泡的附件。

取消只发给所属 Session。会话和消息的权限版本、稳定事件 ID 与原生 Host 绑定共同约束重试和回调；切换共享实例不会重新投递已绑定的消息。

DSH 的权威会话仍保存在原生 Home。界面的过程详情是公开事件投影，不是独立的执行器或第二次模型总结。

## 插件、技能、终端和备份

启动器不提供插件市场、技能市场、伙伴能力目录或实例插件管理 IPC。插件与技能的安装、移除和开关统一在原生 DSH 工作台完成。内部原生插件适配仍用于桥接 bundle 初始化、依赖恢复和隔离验收；它不提供另一套用户管理界面。

用户终端是显式功能：ConPTY 和可选导出 dsh 命令使用相同原生 profile 与真实用户环境。它不参与伙伴任务执行，不覆盖机器上已有的官方命令。

复制/升级建立新的原生配置副本，不合并会话格式。快照/私人备份保存停止实例的 Home、agents、workspace 与精确运行引用，不复制运行缓存、node_modules、事务锁或浏览器存储；快照恢复要求保留匹配运行版本；完整 ZIP 备份还包含可校验导入的运行制品。实例依赖由原生包管理器重建。整合包去除凭据、会话及启动器自供的本地桥接依赖，见 [包格式说明](dsh-packs-format.md)。

## 验证

```powershell
npm run typecheck
node scripts/run-vitest-with-electron.mjs run tests/unit/bot-native-service.test.ts tests/unit/bot-store.test.ts
# 真实 DSH + 内置 embedding + 脚本模型，只验证协议
node scripts/verify-bot-real.mjs --protocol
# 真实 DSH + 当前已配置模型，使用临时资料目录
node scripts/verify-bot-real.mjs --real
```

当前原生会话验收证据写入 `artifacts/superagent-bot-development/real-acceptance/result.json` 与 `protocol-acceptance/result.json`。历史日期文档描述当时实现，不是当前架构规范。
