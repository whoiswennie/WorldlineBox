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

WorldlineBox 已有对应机制：`src/main/companion-bot/app-brain.ts` 对完成历史轮次压缩并保留近期消息；`context.ts` 限制当前输入；`dsh-brain.ts:81-82` 保持 DSH 对原生历史及压缩的所有权。附件业务交接使用 `task-handoff.ts:13-32` 的核验绝对路径、原始要求、相关聊天和目标；附件字节或 base64 不应被重复塞进提示词。元数据有宿主管理用途，但应留在宿主记录，不成为无关的任务正文。

## 插件配置隔离与会话工具选择的区别

原型 `src/app/sessions.ts:233-311` 为每个 Session 绑定提示词、skills 和工具范围；Worker 子代理继承工作工具限制，Ticket 结束后代码拒绝新工具调用。`cordis.patch.yml:39-43,79-100` 隔离 shell、compaction 和 workflowEngine 服务。Source 插件通过 `src/app/source-context.ts:33-70` 的窄接口访问宿主，并只能报告其声明的 health 项。

这不代表每个 Worker 拥有一份独立的任意原生插件配置。原型执行器仍以操作者 OS 用户运行，`docs/003-execution.md:80` 明确说明命令包装与工作目录不是安全边界。

当前 WorldlineBox 的事实：

| 层次 | 当前实现与限制 |
| --- | --- |
| 程序版本 | `src/main/dsh/runtime-service.ts:166-175,192-208,239-246` 按内容摘要保存、校验并去重不可变运行版本。同一版本可以供多个实例引用，不需要重复复制程序。 |
| 原生实例 | `instance-service.ts` 的 `create`／`ensureCompanion` 为实例分配独立 Home、agents、workspace 与浏览器 partition；`instance-process.ts:109-114` 通过 DSH_HOME／DSH_AGENTS_HOME 传入独立路径。 |
| 原生插件 | `instance-service.ts` 的 `initializeProfile`／`plugin` 安装到实例自己的 `home/profiles/web`；增删配置作用于该原生实例。 |
| 伙伴 Session | 普通伙伴可以共享默认实例；首次为某伙伴配置私有能力时，`resolveCompanionInstance` 自动创建该伙伴持久独立实例及按需启动的 Host。工具选择继续限制当前任务，但原生插件配置、缓存和服务由独立环境承载。 |
| 升级 | 原有 `instance.clone` 仍是环境模板克隆，排除 sessions／attachments／storages。新的 `upgradeCompanion` 保留同一实例目录和浏览器身份，通过完整数据快照、原生启动验证及回退切换 runtimeId。 |

若产品要求每个伙伴都能独立安装、停用、配置原生插件，应以“共享不可变 runtime + 每伙伴独立原生配置和状态目录”设计，不能仅隐藏其他伙伴的工具名称。对于插件本身使用单例、进程内服务或全局定时器的情况，需要独立原生 Host 进程；只有插件明确支持 Session 作用域时，才能安全复用一个 Host。独立 DSH_HOME 也不能隔离插件硬编码的全局目录，迁移和配置审核必须覆盖这类插件。

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
