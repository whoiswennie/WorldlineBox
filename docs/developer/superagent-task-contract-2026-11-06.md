# Super Agent 任务、上下文与原生实例契约

日期：2026-11-06。研究对象是本机 `C:/Users/hp/Desktop/project/new/dsh-superagent-prototype` 的源码和文档；下文 `prototype/` 均指该目录。此处记录源码事实与集成判断，不将原型的产品状态或部署限制直接复制到伙伴产品中。

## Router 与 Worker

Router 负责受理、分派、用户沟通和控制授权；Worker 持有一个任务的执行上下文，调查、实现、验证并报告。两者的持久状态由宿主管理。Router 不通过轮询或等待占住一轮模型调用。

| 原型证据 | 含义 |
| --- | --- |
| `prototype/prompts/orchestrator.md:3-5,16` | 使用摘要与订阅；Worker 自行调查实现。报告、候选和后台完成自动到达，无事时结束 Router 轮次。 |
| `prototype/src/core/engine.ts`；`prototype/docs/007-architecture.md:46-48,64` | Engine 是领域记录的唯一写入者；命令同步、事务化，各调用角色仅持有所需接口。 |
| `prototype/src/app/sessions.ts:63-84,263-267` | Router 有工具范围和禁止阻塞等待的代码约束，职责分离并非只写在提示词里。 |
| `prototype/src/app/effects.ts:11-23,38-44,60-71` | 启动、输入投递、报告、通知、回复是持久副作用；同类同键合并，带代次、并发上限和退避。 |

伙伴界面与伙伴工具应调用同一组宿主任务命令，使用同一授权与状态转换。执行器不自行创建另一套管理状态；Router 不需要把队列锁、租约、调度参数和连接诊断塞进 Worker 的业务任务说明。

## 业务状态先收敛，后台清理独立完成

原型 `src/core/tickets.ts:345-362` 在结束事务中立即设置结束时间，清空未投递输入、attention 和 delivery，并结束所有 Assignment；之后才调用执行器停止。`src/executor/dsh.ts:357-379` 用 `afterCommit` 取消轮次、停止后台工作并跟踪清理。清理尚未完成不改变业务终态。

WorldlineBox 面向用户的约定如下：

| 状态 | 行为 |
| --- | --- |
| 排队 | 请求已保存，尚未取得执行资源。 |
| 执行中 | 正在进行任务，包括仍存活的后台命令、子代理。 |
| 已结束：成功／失败 | 当前请求已有明确结果，计时冻结；失败属于已结束，可另行选择重试。 |
| 已暂停 | 保留原任务、会话和产物，计时冻结；恢复沿原任务继续。用户暂停需要用户重新授权，Router 主动暂停遵守原授权。 |
| 已取消／已移除 | 撤销继续执行与自动接续，计时冻结；清理不要求用户核实，迟到事件不得复活任务。移除仅影响展示时应保留内部去重记录。 |

“需要回答”仅能是仍有效的明确问题，不能由模型正文、普通 progress、原生流结束或已完成报告推测。原型 `src/core/assignments.ts:99-132` 将问题独立保存，ready 清除问题并撤回未发送的旧提问；`src/core/stage.ts:9-20` 优先识别终态，再判 attention。`prompts/handoff-orchestrator.md:1-4` 明确禁止从普通进度编造问题。

原型也存在 `idle / waiting`（`docs/003-execution.md:15-21`），这是订阅新事件的空闲任务；不能把它直接标为“等待用户回答”。`src/executor/dsh.ts:629-669` 先检查后台命令与子代理，保留 ready 后的空最终输出；这是避免“DSH 已完而伙伴仍等待”的重要依据。

## 工作期间持续接收信息

原型在会话每个步骤接收 steer 输入，而不是必须等 Worker 全部结束。`src/app/delivery.ts:61-84` 区分 queue、steer、只注入历史的 notice。`src/executor/dsh.ts:476-503` 区分 inbox claimed 与真正进入 Session 历史的消息。

因此需要分别记录已接受、已投递、已读、已报告、已结束，不能以一次网络超时断言工作未发生。稳定消息 ID（`src/app/delivery.ts:16,27-29`）同时检查持久历史和两个 inbox 去重，再 flush 后确认；重启恢复也不应再做一次已发生的外部操作。

`src/app/notices.ts:107-128` 将普通 progress 留在任务内部，只转交结果、阻碍或结构化问题；摘要超过 600 字符提供全文读取地址。伙伴对话沿用这一原则：旧任务终态作为当前控制事实，默认不再提醒旧目标；用户追问时再读取完整记录。

## 长期上下文不是无限单次输入

原型依靠持久 Session、领域记录、资源分页、摘要和原件回读保持连续性：

- `src/sources/admission-context.ts:5-16,22-41`：有限消息窗口，明确省略数量、是否完整和续页位置。
- `docs/007-architecture.md:540-567`：候选卡、有限关联任务、消息截断标识及分页资源；截断部分可按 ID 回读。
- `cordis.patch.yml:79-95,177-189`：每种 preset 使用独立 compaction 与 tool-result-pruner；工具输出阈值 8192 字符，保留头 4096 与尾 1024。
- `src/app/delivery.ts:40-58`：从持久事件分批恢复投递记录。

这些措施使任务可以跨轮次、跨重启延续，但每次模型调用仍有上下文上限；压缩摘要也不能替代可核验原始记录。交接摘要应带来源、覆盖游标、省略标志和全文读取方式，不把摘要未提到的事情当作从未发生。

WorldlineBox 已有对应机制：`src/main/companion-bot/app-brain.ts` 对完成历史轮次压缩并保留近期消息；`context.ts` 限制当前输入；`dsh-brain.ts` 保持 DSH 对原生历史及压缩的所有权。2026-11-07 起，`task-handoff.ts` 仅派发任务卡中的完整要求和所选附件绝对路径；Router 筛选必要上下文后写入要求，宿主不自动转发聊天或整个历史附件目录。附件字节或 base64 不应被重复塞进提示词。元数据留在宿主记录，不成为无关的任务正文。

## 插件配置隔离与会话工具选择的区别

原型 `src/app/sessions.ts:233-311` 为每个 Session 绑定提示词、skills 和工具范围；Worker 子代理继承工作工具限制，Ticket 结束后代码拒绝新工具调用。`cordis.patch.yml:39-43,79-100` 隔离 shell、compaction 和 workflowEngine 服务。Source 插件通过 `src/app/source-context.ts:33-70` 的窄接口访问宿主，并只能报告其声明的 health 项。

这不代表每个 Worker 拥有一份独立的任意原生插件配置。原型执行器仍以操作者 OS 用户运行，`docs/003-execution.md:80` 明确说明命令包装与工作目录不是安全边界。

当前 WorldlineBox 的事实：

| 层次 | 当前实现与限制 |
| --- | --- |
| 程序版本 | `src/main/dsh/runtime-service.ts:166-175,192-208,239-246` 按内容摘要保存、校验并去重不可变运行版本。同一版本可以供多个实例引用，不需要重复复制程序。 |
| 原生实例 | `instance-service.ts` 的 `create`／`ensureCompanion` 为实例分配独立 Home、agents、workspace 与浏览器 partition；`instance-process.ts:109-114` 通过 DSH_HOME／DSH_AGENTS_HOME 传入独立路径。 |
| 原生插件 | `instance-service.ts` 的 `initializeProfile`／`plugin` 安装到实例自己的 `home/profiles/web`；增删配置作用于该原生实例。 |
| 伙伴 Session | 每个伙伴必须显式绑定独占实例。`resolveCompanionInstance` 只读取已绑定实例，缺失即拒绝，不共享默认实例、不自动分配版本或创建。用户确认 `companion.environment.create`（必选 runtimeId）或 `bind`（选未绑定的停止实例）后，按需启动该伙伴的 Host。原生插件配置、缓存和服务由独立环境承载。 |
| 升级 | 原有 `instance.clone` 仍是环境模板克隆，排除 sessions／attachments／storages。新的 `upgradeCompanion` 保留同一实例目录和浏览器身份，通过完整数据快照、原生启动验证及回退切换 runtimeId。 |

当前产品要求每个伙伴都能独立安装、停用、配置原生插件，采用“共享不可变 runtime + 每伙伴独立原生配置和状态目录”设计，不能仅隐藏其他伙伴的工具名称。对于插件本身使用单例、进程内服务或全局定时器的情况，需要独立原生 Host 进程；只有插件明确支持 Session 作用域时，才能安全复用一个 Host。独立 DSH_HOME 也不能隔离插件硬编码的全局目录，迁移和配置审核必须覆盖这类插件。

## 按需启动与升级保留配置

执行实例使用稳定 companionId／环境身份映射，身份不由当前选中的程序版本推导。实例只引用 runtimeId，配置、登录态、会话和插件状态保持在实例自己的持久目录。相同版本的两个伙伴使用独立配置。

按需生命周期由宿主租用：首次实际需要 DSH 执行时确保 Host 已就绪；并发请求复用同一个启动 Promise；任务、会话、问题、后台工作和能力查询支持独立租用，原生工作台及 CLI 保活。默认两分钟后仅回收无租用且原生 `/idle` 明确确认无轮次、后台命令、子代理、问题、inbox 和状态收敛活动的私有 Host；未知证明不回收，共享默认实例不回收。启动新私有 Host 前，以三个非常驻 Host 为缓存软目标，优先回收最久未使用的真实空闲私有 Host，最多回收一个；若全部忙碌或无法证明空闲，仍允许已授权请求启动，不会为了缓存目标停止任务。因此这不是进程数或内存硬上限。空闲回收只停止进程，保留配置与会话。

升级先核实无活动，停止受影响 Host，保存完整可恢复数据快照，再切换程序引用并实际启动校验；失败恢复旧程序引用及快照。快照保留 sessions、attachments、storages、配置及 workspace；排除可由原生包管理器重建的 node_modules 和缓存。`upgrade.json` 在进程中断后驱动下次初始化恢复，已校验快照内容与实例身份。`initializeProfile` 仅在 profile 缺失时生成默认配置。未运行或明确停用的环境只临时启动校验，随后恢复停止。

新私有环境不复制默认实例的登录凭据。App 注入的 Worker 模型选择可继续使用；QQ 等自定义插件账号应在该伙伴对应的原生工作台独立配置。界面的能力页读取实际原生工具／技能目录，配置可直接使用该环境原生插件管理器；profile 与 agents 文件变更会刷新能力修订号，不把静态插件名单塞进提示词。

可启用持久 keepAlive 以运行消息监听等常驻插件；系统就绪后仅对已经配置私有环境、选择常驻且未被停用的伙伴恢复连接，最多两个同时启动，失败逐个记录，退出会取消等待者。恢复前还会复查实时启用状态和常驻偏好，等待期间关闭的伙伴不会被旧启动队列复活。明确停止伙伴会阻止延迟自动重启；后续明确启用或执行才解除。`tests/unit/dsh-instance.test.ts`、`dsh-companion-instance-leases.test.ts` 与 `dsh-companion-keep-alive.test.ts` 的 22 项测试涵盖同版本独立配置、并发创建、全维度空闲证明、检查中的新租用、显式停止与自动重启交错、LRU 空闲回收及忙碌时正常超出软目标、常驻恢复的筛选／并发／取消及排队时停用、同环境升级保留、迁移失败字节回退及中断升级恢复。测试使用实际 Node 子进程与 HTTP Host fixture；原生第三方插件登录与服务行为仍需实际集成验收。

真实版本升级已单独验证：`tests/unit/dsh-companion-upgrade-native.test.ts` 使用实际安装的 DSH 0.2.1-rc.5 与 0.2.2-rc.1 CLI，在同一私有环境升级后继续同一个持久 Session。实际安装的 demo_palette 工具前后分别返回反色结果，原始历史前缀、effect receipt、插件配置、storage、附件、技能文件与工作区产物字节保持；重复提交旧任务未调用模型或工具。证据为 `artifacts/superagent-bot-development/native-private-upgrade/worldlinebox-bot-host-UTrfz4/receipt.json`，测试耗时 57.55 秒，无付费模型调用。此测试仅反射注入两份真实程序及核对 manifest 身份，不冒充运行包封存完整性验收；正常导入器的完整性验证另行覆盖。

原生嵌套 preset 有代次保留语义。安装或配置变化后，新 Worker 挂载当前伙伴 preset，能力查询使用同 preset 的空白发现 Session；已有历史 Worker 保留原代次并返回 `scope.pending`。桥接没有在后台强制 dispose／resume 既有 Worker：rc1 原生公共 API 没有将“关闭所有新入站、释放旧作用域、同 Session 恢复”组合成原子事务，异步 dispose 间仍可能接受工作台或插件消息。保留旧代次可避免丢入站、重复执行和伪造迁移完成；因此原生全局工具变更与旧 Session 的嵌套工具变更应区别看待，不能承诺任意运行中任务即时迁移全部能力。下次正常 Host 生命周期恢复同 Session 时会挂载当前代次。

## 集成验收重点

1. 用户和 Router 使用同一任务命令；暂停、恢复、取消的权限和结果一致。
2. 终态及暂停即冻结计时；后台连接清理失败不改变业务终态，也不自动重新派发。
3. 新旧回调绑定任务、事件和代次；迟到进度不能覆盖取消、暂停或更新结果。
4. ready、失败和取消清理失效 attention；只有有效结构化问题进入“需要回答”。
5. 工作过程中注入补充信息，在下一步骤读到；重启、超时重投不重复执行。
6. 历史可回查，提示词保持有限；绝对路径附件随任务交接保留，正文只包含完成任务所需内容。
7. 会话工具隔离、插件配置隔离、OS 访问范围分别验证，不互相冒充。

原型研究与本项目实现依据分别如上；用户账号、第三方插件和真实 DSH 版本的验收结论应附对应运行证据，不能仅凭 Host fixture 推断。


## 多 Worker 与多伙伴协作的耐久交接

本轮增加 `workflow-runtime.ts` 与 `delegation-runtime.ts`。它们保存任务事实、依赖、来源及交付回执，不替 Router 做业务判断，也不把普通聊天升级为执行授权。

- `dsh_plan` 最多八个阶段，拒绝循环和未知依赖。阶段只能绑定一个真实任务；直接前置必须成功、来源仍有效，且 Router 已读到当前结果才能派发下一阶段。真实 `task_done` 本身包含该任务的当前结果时，也可构成已读事实，不强迫冗余查询。
- 前置任务产出文件时，`requireDependencyArtifacts` 要求为每个这样的前置阶段选择至少一份真实成果。文件先发布到当前聊天，后级 Worker 接收其核验副本的绝对路径；不得用抄写 JSON 代替原件，也不让后级搜索其他任务目录。纯文字依赖不强制制造文件。
- 同计划尚待集成的前置任务最多自动返工两次。计划关闭、来源撤回、用户停止、前置失败或暂停均不能触发后续派发；无新事件不轮询自聊。
- `companion_delegate` 将用户明确授权的独立子任务交给真实伙伴。宿主在原聊天创建可见的代理任务，在双方专属私聊复制显式选中的附件，创建可核实的窄委派凭据。代理任务不启动本地 Worker，不伪造原生执行；真正的 Workers 由接收伙伴的 Router 派发。
- `companion_delegation.result` 只能交回本委派 Workers 已实际发布的成果；省略附件列表时选这些实际产物，不能回传同一伙伴私聊中其他任务的文件。文件跨房间拥有新 ID，字节和 SHA 保持一致，来源撤回可以传播到返回文件。发布、结果回执、代理终态和委派关闭同一事务提交，重试核对原参数指纹。
- 接收方完成全部真实任务却仅发普通聊天时，宿主不会把聊天当交付。错误的 `message_peer` 返回正确交付入口；仍漏交付时，最多产生两条绑定原任务的宿主提醒。提醒不另开任务、不编造成果、不启动无限对话。
- 当前轮自己刚发布的附件可立即继续使用：水位例外只包含该事件、该角色、该聊天的真实 publication，仍核验撤回血缘。其他后到消息和文件不因此进入冻结快照。
- 原聊天整体停止仅撤销其委派及关联子任务，不停止接收伙伴无关的私聊、群聊或同 peer 房间的独立任务。暂停冻结计时；仅补充信息保留暂停，恢复之后按序交付业务补充和最新恢复事实，避免旧的“等我继续”覆盖新的恢复请求。

`message.send(replyToTaskId)` 现在只绑定任务范围，文字意图仍交给真实 Router 解释；不能绕过 Router 将“暂停”“停止”或“只补充、不恢复”直接送成自动执行。原生暂停/恢复复用初次 Worker 工具目录，避免官方 DSH 以工具选择变更拒绝挂载。断线和恢复保持同一任务、原生 Session、事件与工作目录；未知外部副作用继续要求真实回执，不改成盲重试。

委派追加指导当前支持文字；带新附件的跟进会明确拒绝并要求新授权的后续委派，不静默丢弃文件、不偷偷扩大原任务附件范围。

## 五类真实复杂场景验收

以下业务用例均使用配置中的官方 `api.deepseek.com`、OpenAI Chat Completions 协议 `deepseek-flash`，执行器为官方 DSH `0.2.2-rc.1`。Router 与 Worker 均为真实模型调用，没有脚本代写目标、计算报告或完成回执。

| 场景 | 验收重点 | 本地证据目录末段 |
| --- | --- | --- |
| 私聊、多文件分析 | CSV、政策、区域映射、退款更正四文件；跨消息约束完整交接；只读、禁联网、隐私字段不输出；净额 207 | `multifile-real/worldlinebox-bot-real-multifile-I68Y7P` |
| 单 Router、多 Workers | 独立金额核算与审计并行，等待两者成功及当前结果，再派集成 Worker；真实文件交接与净额复核 207 | `multifile-real/worldlinebox-bot-real-multifile-mIq4SB` |
| 群聊、多伙伴 | 大肥鱼与 GPT 各自派 Worker；真实并行；用户对话更正其中一方口径，原任务原 Session 续作；最终两报告合并为 312 | `multi-companion-real/worldlinebox-bot-real-multi-companion-vOSuUo` |
| 私聊发起、多伙伴正式协作 | 三份原件以新 scoped ID 转至伙伴私聊，西区报告以相同 SHA 返回原用户聊天；最终 Worker 只接收 east/west 两报告绝对路径，核验 207 + 185 = 392 | `multi-companion-real/worldlinebox-bot-real-multi-companion-Kw7tAp` |
| 反问、对话控制与中断恢复 | 真实 Router 完成后注入上层回执丢失，同事件从账本恢复且零新增模型请求、任务或工具效果；原生 ask_user → Router 按已知授权 answer；暂停计时冻结、只补充不恢复、明确恢复；硬中断本测试 Host 后沿同 Task/Session/Event 恢复；真实 final.json 交付；用户停止后迟到门文件不产生结果或重派 | `resilience-real/worldlinebox-bot-real-resilience-E5xZyq` |

目录均在 `artifacts/superagent-bot-development/`，保存实际 Router journal、Worker prompt、状态采样、结果及清理证明。多伙伴两个场景分别采样 105 和 87 条真实状态；最终私聊集成 prompt 保持有界，仅有完整任务要求和两份成果文件，无私聊 canary 或无关文件。所有样例原件字节保持不变。

复现入口（需本机配置真实模型、官方运行程序并承担真实 API 用量）：

```powershell
$env:WORLDLINEBOX_BOT_DSH_PROGRAM = '已安装官方 DSH 程序的完整目录'
node scripts/verify-bot-multifile.mjs --real
node scripts/verify-bot-multifile.mjs --real --collaborative
node scripts/verify-bot-multi-companion.mjs --real
node scripts/verify-bot-multi-companion.mjs --real --peer
node scripts/verify-bot-resilience-real.mjs --real
```

Runner 只清理自己标记的隔离目录和进程，不操作用户真实任务。真实模型有非确定性；失败运行也保留证据。本轮曾捕获并修复旧历史污染、任务跟进绕过 Router、原生暂停工具目录不一致、恢复指令时序、错误附件编号卡为未知效果、当前轮新发布文件不可见及普通聊天漏交付。另保留模型错误领取区域、尝试不必要记忆写入等失败记录，不能把一次成功视为模型永远正确。

边界：真实业务测试关闭长期记忆，仅证明模型、Router、DSH、任务及媒体链路；NoMemory 在任何 I/O 前拒绝写入且能证明未写入，不冒充 VCP 成功。多个角色使用同一隔离官方 Host 中的独立 Session，不据此声称任意第三方插件全局配置已隔离。此验收运行目录缺少 pwsh/ripgrep 可执行环境，Worker 如实披露并使用原生文件工具核验，因此不声称此轮已覆盖终端长进程取消。

聊天 UI 另由 `companion-collaboration-ui.test.ts` 在真实隔离 Electron + Main IPC 验证：私聊、群聊、两位任务所有者、实时进度、暂停计时、停止、任务跟进归属、追加消息及完整重启后任务记录保留，1024/1440 窗口几何检查通过。此 UI 用例使用显式标记的状态夹具，与上述真实模型业务验收分开；截图在 `artifacts/companion-collaboration-ui/`。

增强恢复用例明确区分故障边界：Router 故障是在真实模型已完成且 durable journal、唯一 dsh_task 工具效果均提交后，丢失一次向 BotService 返回的完成回执，不是杀掉 Router 进程。Main 将同事件从 inbox attempt 1 重领为 2；二次返回保留相同 taskId、callId、账本/效果/正文哈希，重放没有新的 provider 请求。随后仍执行真实 DSH Host 硬中断、暂停恢复与停止防晚到全部检查。


## 2026-11-08：强制角色独占实例与显式确认

旧版“未配置伙伴共享默认实例”已移除。安装运行版本不会自动创建实例；未绑定时允许查看历史及角色卡，但私聊、群聊、通话输入和伙伴间任务委派均不能触发模型工作。群聊全部成员均须有自己的有效实例及已安装版本。

新用户流程：前往启动器下载官方 DSH → 打开伙伴会话 → 绑定弹窗自动给出实例名称 → 用户手动选择已安装版本并确认创建，或者选择未绑定、已停止的现有实例并确认绑定 → 注册表原子保存后开放聊天。取消弹窗保留历史和草稿，输入与拨号仍关闭。查看、取消、刷新、读取角色卡都不分配环境。已拥有专属实例的老伙伴保持原绑定；曾共享默认实例的伙伴必须经过上述确认，不能静默领取默认实例。

实例一对一独占；已有普通实例绑定后保留名称、数据路径、浏览器分区和插件配置，移除其默认身份。禁止抢占其他伙伴、运行中绑定、后台租用中绑定、为已有伙伴再创建一个实例或隐式改绑。运行版本供多个实例共享，插件/技能/配置/原生状态各自持久化；无需每个伙伴安装一份 DSH 版本。按需启动和原生空闲证明回收规则不变，不会在打开群聊时同时启动全部角色进程。

服务器在消息保存、附件转写、Router 内存/模型调用、Worker 启动和伙伴交接前检查绑定，不能靠绕过界面使用未配置角色。旧排队消息在缺绑定时明确失败一次，旧任务暂停保留已有进展；停止/移除仍可操作。既有原生任务绑定到旧共享环境或其他角色时不迁移、复制、重新派发，由明确错误保留原执行证据。

启动器中角色实例的“升级角色实例”调用 `companion.environment.upgrade`，使用同一实例 ID、DSH_HOME、agents、workspace、浏览器分区和角色所有权。升级前完整快照，验证新运行版本及原生启动；失败回退原版本和配置。普通未绑定实例仍可创建升级副本，该副本需用户显式绑定角色。未声明兼容的第三方插件可能无法在新版 DSH 加载，这类实际启动失败会回退，不保证任意未来插件协议兼容。

验证：创建/绑定原子持久化、失败清理、两角色争用、重启恢复、未安装版本、无默认回退、所有群成员门禁、对话/音频/委派服务器拒绝、原任务暂停和恢复、角色实例升级 UI。真实官方 DSH 0.2.1-rc.5 → 0.2.2-rc.1 原生升级测试使用本地确定性模型传输，实际插件管理器与工具执行；核验插件仍可调用、原生 Session/历史前缀/耐久回执不重放、技能/配置/存储/附件/工作区字节保留。证据保存在 `artifacts/superagent-bot-development/native-private-upgrade/`，此测试不调用付费模型，也不声称检验未知版本的第三方插件。

## 2026-11-08：伙伴与用户同等任务权限

宿主核实的真实聊天参与者请求采用同等任务权限。伙伴私聊、显式伙伴消息和自然群聊观察事件（`source=group, senderType=companion`）都可以使用角色自己的完整 DSH 执行环境、插件、技能、并行 Worker、计划、跨伙伴委派及任务控制；不以用户是否在房间、是否亲自重说请求区分权限。系统任务回执、世界观察、伪造事件及已经停止或撤回的来源仍不能凭文字生成新的任务。

`companion_contact.destination` 仅选择回复路由。旧实现将 `destination=user` 当成仅发言权限，导致“让大肥鱼查天气后告诉我”被拒绝；现与 `peer` 一样核验已提交回执、当前参与者、ACL、因果关联及撤回状态。查天气、分析原件等执行请求优先使用 `companion_delegate`。若先走了联系路径，接收方首次实际创建 Worker 或计划时，在同一 SQLite 事务中建立唯一的正式委派及原聊天代理，普通问候不会单独创建任务。

正式子委派和联系提升使用 `parentDelegationId`；普通伙伴消息沿活动委派因果链启动的 Worker 使用 `causalDelegationId`。停止、暂停和恢复沿这些持久关联级联，不仅依赖迟到消息的准入检查。已派生任务未结束时不能提前交付；状态只披露关联任务元数据，不复制其他受众聊天或附件。伙伴同权不取消活动预算、因果跳数、去重或用户停止机制；结束的旧链不能自行重新开启。新的独立请求正常执行。

Worker 返回失败、缺数据或工具不可用也需要通过 `companion_delegation.result` 如实交付；不能仅在正文说明或问是否重做而悬挂代理。原有最多两次事件驱动交付提醒继续生效。模型请求输入与原回执保持不可变，存量已经完成的错误拒绝不自动重跑，新请求采用更新后的合同。

验证覆盖两种转达目的地、普通伙伴请求、自然群聊实际观察通道、计划/暂停/恢复、真实原件成果转回、嵌套委派与联系提升停止、普通消息派生任务停止、来源撤回、无效计划事务回滚及提交回执恢复。`scripts/verify-bot-peer-work.mjs --real` 使用实际配置的 DeepSeek OpenAI Chat 接口验证路由，工具和 Worker 回执明确为本地测试桩，不声称实际查询天气或启动原生 DSH。累计 15 次实际 POST：发起方正式委派、接收方忽略旧拒绝历史并派 Worker、普通伙伴消息执行均通过；曾观察到漏交付，保留原失败证据，增强后的生产提醒驱动完整 `result` 及最终回复通过。证据位于 `artifacts/superagent-bot-development/peer-work-*`；所有用户配置保持不变，隔离测试目录完成清理。

## 2026-11-08：执行环境故障的跨伙伴通知与运行文件校验

执行方暂停时，原委派方现在会收到持久化的暂停事件，包含代理任务、实际子任务和故障原因。事件按暂停事件身份去重，数据库重开不重复发送；收件箱满时持久延迟投递。任务保留暂停与已有进展，不能将启动失败称为已完成，也不能由后台通知自动重建或重试。明确继续仍沿原任务恢复。

旧实现只通知执行方，而且交付提醒和真实伙伴回复观察共用一个异常边界：代理暂停导致提醒校验抛错后，委派方收不到执行方已经发出的失败回复。现在两条路径独立，暂停提醒安静退出。代理区分随子任务镜像的暂停与用户明确暂停；子任务独立恢复时可以刷新前者，后者继续保持。环境故障标记为执行器暂停，上下文保留真实原因；旧记录中的用户控制标志不能安全推断，保持原值，仅中性披露执行器中断历史，不自动恢复用户任务。

旧运行文件校验把权限、监控、缓存和真正的字节变化统一改写成英文“files changed or are missing”，且丢弃底层原因，因此不能仅据旧界面证明程序已损坏。此次对本机官方 0.2.1-rc.5 的 63,741 个文件逐项读取，文件、清单、注册摘要一致；生产 RuntimeService 全量校验和真实私有原生 Host 启停前后校验均通过。旧报错的具体底层异常没有被保存，不能事后断言一定由缓存或文件占用引起。

校验现在保留 cause，区分文件变化、清单异常、文件访问、目录不稳定、超时及其他校验失败。真实变化报告增删改数量和最多八条相对路径；清单摘要错误不冒充文件损坏。哈希索引为可丢弃缓存，读取失败改为完整字节校验，写入失败不否定已通过的校验；不读取或写入不安全缓存路径。Windows 的 EACCES/EPERM/EBUSY 或明确的校验不稳定最多退避 100ms 后再完整校验一次，支持取消；真实 seal 差异、损坏清单和超时不重试、不重新封存、不跳过完整性校验。

验证分开记录，避免将模型用例冒充原生环境验收：

- `dsh-runtime-diagnostics.test.ts` 覆盖缓存读写失败、清单/真实文件差异、原因保留、瞬态访问恢复、持续失败的两次上限、取消退避和不重试真实差异。
- `dsh-runtime-sealed-native.test.ts` 使用已安装官方运行文件及真实生产校验器，在独立临时实例中启动/关闭原生 Host，前后强制读取完整字节；不调用付费模型，不修改用户实例或运行程序。
- `verify-bot-peer-work.mjs --real --scenario=requester-receives-environment-pause` 通过生产暂停/委派刷新发出事件，实际 DeepSeek 收到并如实说明暂停。
- `verify-bot-peer-work.mjs --real --scenario=peer-acknowledges-environment-pause` 通过生产回复观察路径，实际 DeepSeek 以 Claude 身份回复大肥鱼，不新增任务或自动重试。两例各一次真实 POST，Worker 故障为明确注入的本地夹具，不声称实际查询天气。证据分别在 `peer-work-real-2026-11-08T05-59-55-688Z` 与 `peer-work-real-2026-11-08T06-13-34-419Z`。

## 2026-11-08：Worker 交付正文与核验依据完整回传

实际只读检查发现，截图中的天气任务已持久提交 252 字的 ready 报告及四条核验依据，最终原生回复却只有 47 字的“已完成、答案见上文”。旧版优先采用非空的原生结束语，导致任务卡和 task_done 通知省略了真正的业务报告；这不能据以断言 Worker 没取得任何数据，也不能只凭成功状态证明查询结果真实。

交付现在由两个独立耐久事实组成：当前任务根 Worker 的有效 ready 报告与原生正文。报告必须通过原有指纹、调用来源、执行分段基线及后续工具失效检查，再按包含关系去重组合。无报告、过期报告、未核实效果及失败/暂停均不被提升为成功；普通原生终态仍不强制需要可选报告。任务卡、status 和 dsh_task_result_read 使用同一交付投影。旧成功任务已有完整报告时可只读取回，保持原记录和终态，不改写用户历史，不重跑执行器。

DSH 桥接的 Worker 结果同时保留本次执行段已提交的多条助手正文，避免正文在 worker_report 调用之前、结束语在其之后时被覆盖。只采集当前根 Session 的 assistant/message 文本，排除推理、工具参数/结果、未提交尝试、中断草稿、投影改写、旧任务及旧续任务分段；App Router 与原生脑部仍仅使用最后回复。正文聚合最多 128,000 个 Unicode 字符，超限保留开头与结尾并明确标注省略，可在 DSH 原任务会话查看完整记录，不将有界预览声称为全文。重启、取消核实和重复请求复用相同提取规则及耐久结果，不触发额外推理。

正常完成事件不默认复制全部核验日志。Router 的 status.report.verificationView 明确显示核验条目的总数、预览遗漏、单项截断以及只读 readArgs。dsh_task_result_read 的可选 section 默认为 delivery，兼容已有调用；section=verification 分页读取当前有效 ready 报告的完整编号核验文本，返回 reportCallId 区分版本。预览包含跳段时从 offset=0 开始，按 nextOffset 继续。读取核验依据不冒充读取了协作计划前置阶段的正式交付正文。跨聊天、跨伙伴、撤回来源及已移除任务仍被隔离。

Worker 提示与原生 worker_report 工具说明要求自包含的具体答案、数值及单位、适用时间、来源、成果绝对路径和不确定性，不能仅给成功宣言或“见上文”。Router 在遇到缺少答案的通知时先只读已有交付及报告，不能为了取回现有正文重新派发，也不能把成功状态当成事实内容。

验证入口：

```powershell
node scripts/run-vitest-with-electron.mjs run tests/unit/bot-task-report.test.ts tests/unit/dsh-worker-output.test.ts
$env:WORLDLINEBOX_BOT_DSH_PROGRAM = '已安装官方 DSH 程序的完整目录'
node scripts/run-vitest-with-electron.mjs run tests/unit/bot-task-report-native.test.ts tests/unit/bot-dsh-output-native.test.ts tests/unit/bot-dsh-native.test.ts --maxWorkers=1
node scripts/verify-bot-worker-delivery.mjs --real
```

unit 覆盖截图中的结束语覆盖、长 Unicode 交付和核验分页、旧任务重启只读取回、失效报告、受众隔离及计划依赖门槛。原生用例使用真实安装的官方 DSH，模型传输为 localhost 确定性夹具；覆盖报告工具前正文、最后收尾、续任务边界、重启回放无新增模型请求、截断续写及脑部行为不变。

真实验收使用隔离 BotService → App Router → 官方 DSH → 当前配置的 DeepSeek OpenAI Chat 接口 → Router，不模拟 Worker 答案或工具结果。样例为两份收据/更正文件，Worker 实际读取后提交包含金额、来源及核对标记的 ready 报告，验收要求允许最终只用简短结束语；Router 必须在同一聊天返回正确的 194.35 和 CEDAR-4829，只有一个任务和一次原生执行。透明本地转发器最多允许 18 次真实 provider POST，报告保存实际请求数。两次真实运行各 7 次 POST 均通过，证据目录分别为 `worldlinebox-bot-real-delivery-UjbE7O` 与 `worldlinebox-bot-real-delivery-jfd90b`。第一轮原生末尾仅结束语，第二轮 Worker 交付了更完整正文，并明确披露样例未注明币种及 Router 派发中的计算符号差异；验收证明正文/报告/不足都能传回，不据此声称模型永不误判或查询过真实天气。

长期记忆单独关闭，不声称覆盖 VCP。证据保存在 `artifacts/superagent-bot-development/worker-delivery-real/`，包含原生 Session、实际派发要求、聊天、完成事件及清理结果；用户原配置只读并校验前后哈希一致。整合回归 210 套通过、16 套按原生 opt-in 条件跳过，共 1,584 项通过、19 项跳过；三个原生确定性套件另行显式启用并通过。Typecheck 通过，ESLint 零错误（四条既有 React Hook 警告）。
