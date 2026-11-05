# Super Agent 伙伴运行说明

基线更新：2026年11月5日。主脑由世界线盒子自身运行，DSH仅作委派执行器；新增每伙伴统一事件账本、授权任务与结构化业务报告。当前重构范围和验收见[伙伴持续主脑重构方案](companion-superagent-refactor-2026-11-05.md)。早期[实施方案](superagent-bot-implementation-plan-2026-11-02.md)与[调研报告](superagent-bot-research-2026-11-02.md)保留为历史记录，不再据其DSH承载主脑的决定解释新实现。

此前版本的436项相关单测、5项功能与2项渲染性能检查及其边界见[历史实现与验收](companion-superagent-current-2026-11-03.md)。下文保留的旧版性能样本不代表11月5日重构后的分布。

## 所有者与数据

| 组件 | 责任 |
| --- | --- |
| `src/main/companion-bot/store.ts` | 新 SQLite 消息、Inbox/Outbox、lane、任务、记忆作业、撤回来源与物理世界元数据；小事务在 Main 执行。 |
| `scheduler.ts` | 同伙伴跨会话串行接纳、同lane FIFO、不同伙伴并发、lease、恢复与取消。 |
| `companion-runtime.ts` | 每伙伴稳定身份、统一事件序列、获准协调视图、任务Mandate、订阅与跟进账本；无授权自动工作只记录候选。 |
| `service.ts` | 可信入口、主脑准备、工具回调、任务与世界事件投递、后台记忆作业。 |
| `app-brain.ts` / `app-brain-store.ts` | 应用内主脑：直接模型流、工具循环、有界历史与摘要、SQLite耐久事件/步骤/回执、取消与恢复；没有DSH Session。 |
| `brain-router.ts` | 主脑及记忆编码器走应用Agent；执行任务及其检查/指导走DSH；不做出错后跨引擎重发。 |
| `dsh-brain.ts` / 原生DSH Host | 仅负责委派Worker的原生Session、工具执行、取消、效果核实与恢复。 |
| `task-report.ts` | 校验根执行器的结构化业务报告及原生执行前回执；执行轮次成功不直接成为业务任务成功。 |
| `memory-service.ts` / `resources/vcp-memory` | 常驻 Node 24 Worker、VCP 检索与日记、历史适配、预处理／response 闭环、来源撤回。 |
| `retention.ts` | 主脑活动代际计量、应用摘要交接与CAS提交；兼容原回执格式。 |
| `world.ts` / `world-physics.ts` | 物理位置、A* 路径、出入口、家具占用、动作和见证者事件。 |
| `src/renderer/companion-bot` | 会话投影、有限流式覆盖、任务／记忆面板和世界视图。 |

数据根为 `app.getPath('userData')/companion-bot-v2`。`bot.sqlite`管理消息/任务，`router/app-brain.sqlite`管理主脑turn/step/tool journal，均独立于资产库；`memory/`按伙伴和受众安全域隔离。DSH只管理执行任务的原生会话/日志。主脑逻辑session哈希沿用旧回执格式，不表示创建同名DSH Session。

同一伙伴跨聊天保持同一个brain ID和事件序列。各lane保留自己的原话、模型摘要及VCP资料，作为该主脑按受众裁剪的视图。用户私聊可协调该伙伴在用户参与的direct/group中的任务；群、伙伴私聊和世界仅提供当前受众视图，跨会话元数据不授予新的工作权限。

伙伴联系先进入双方独立peer会话。请求对方向用户发消息时，目标伙伴凭宿主绑定的一次性reply grant自行发布本人消息；发送者不会写入用户与目标的direct。真实peer消息自动出现在聊天列表，浏览入口只筛选已有记录，用户保持旁观只读。

任务工作台的跟进入口将用户消息绑定原taskId；执行器问题还绑定该轮原questionId。明确跟进不会变成第二份同目标任务。Worker用worker_report提交progress/waiting/ready/blocked/failed/dropped，宿主结合真实效果回执结算；缺报告保持等待。续投沿原任务和原DSH Session，原始请求及已完成效果不重发。

启动器只预热默认实例，所有伙伴委派的任务复用该Host，普通主脑对话不连接它。玩家停止实例后，普通聊天保持独立，下一次真正委派任务才沿原ID/home恢复Host。VCP使用软件内置Node24，不经DSH解析Node或启动Host。伙伴有可读目录、受众子目录与独立任务工作区。

旧DSH主脑的闲置lane先完成VCP原文投影，再原子轮换epoch、清delivered、标记近期历史重建；保留聊天/记忆/原生日志，不复制或重放旧Session。未确认投递、取消或未知效果阻止对应lane切换并保留绑定；不能用App journal中“不存在”证明旧DSH执行已停止。

旧 `CompanionService`、CompanionStore、认知 registry/publication 证明链、旧 VCP host/worker 和独立世界窗不再是启动或 fallback 入口。旧数据不迁移、不双写。研究证据的源码快照是只读历史资料，不能作为运行模块导入。用户资产、模型设置、DSH 环境和无关通知 UI 属于保留范围。

## 一条消息的执行路径

1. 主窗口 IPC 经 schema 校验，宿主绑定真实 sender/source、会话受众和安全域；渲染层不能自选 actor 或跨域 scope。
2. BotStore 以来源标识和内容指纹去重，事务保存原始消息、每位收件人的 Inbox 事件和回复占位。相同来源换内容会拒绝。
3. 调度器取得 lane lease。同 lane 保序，其他 lane 可并发；分页消息只保留有界近期窗口，不序列化整个聊天历史。
4. 恢复VCP撤回revision，过滤来源和任务，准备有界记忆。App journal保留活动代际真实消息与完整工具对，长期原话仍经VCP回查。
5. 应用主脑直接调用配置模型并流式显示正文。完整模型步骤及工具计划先提交，工具投递前标记invoking，收到回执再提交结果。只有dsh_task进入DSH，其他互动经宿主授权工具处理。
6. 最终回复、Outbox 和记忆作业事务提交；UI 消费已提交状态。取消或过期 lease 不能被迟到正文重新发布。
7. 后台依次处理 response、历史投影和自动编码。VCP 的检索与记录不等于它负责决定任务状态；DSH 工具回执也不自动证明长期记忆已成功索引。

事件ID、UI会话、主脑lane和DSH任务Session各有职责。App journal使用WAL/FULL；完整步骤已保存则重用，纯模型请求中断可重试；已投递写工具必须先核实宿主回执，缺证明时保持未知。未决旧turn阻止同lane后继越过，只读查询可安全重查。

## lane、epoch 与活动上下文

一个逻辑 lane 绑定伙伴和受众会话；同一个伙伴的私聊、群聊与世界观察不是一个混合原生上下文。epoch 表示该 lane 的活动原生代际，UI conversation ID 保持不变。

生产 Main 按当前模型规格配置活动窗口，不再把 32k 或 128 turn 当作所有模型的上限。窗口来源依次为显式配置、同一模型元数据、已核官方默认值；未知连接明确使用 65,536 的保守估计。输出预留与工具定义也计入预算。32k 仍作为回归压力夹具，验证受限模型也能连续处理多来源。App 内先按预算摘要；更大的代际寿命边界才由 `BotRetention` 在**下一条未绑定事件开始前**检查。已绑定 epoch 的恢复事件始终沿原代际重试，不跨代重发。

App主脑按contextWindow、输出预留和保守UTF8字节上界控制容量，包含system、工具schema与完整消息序列。仅按完整过去turn/tool pairs分批滚动摘要，当前输入不静默截断。摘要最多12,288字符、尾部JSON最多8,192字符、总UTF8最多64KiB。摘要有损，原话需VCP回查。

只有App handoff完成且 `commitLaneHandoff(laneId, expectedEpoch, handoff)` CAS接受，才提升epoch并保留首轮交接材料。原记录保留；压缩会调用模型并增加费用/等待，失败不丢旧上下文、不盲开空epoch。

交接材料预约给新代际的首个持久事件；同事件恢复使用相同材料，后续事件不反复注入。首次事件尚无原生派发回执就停止时，可把预约转交下一事件。forget 会原子清该 lane 的保留材料并提升 epoch，迟到 handoff 的 CAS 必须失败。

原生支持 succeeded、failed、cancelled 的最后已 settle 事件作为锚点。只有确认原生终态时才可累计并更新该锚点；本地准备失败、未知投递或尚未 settle 的取消不能伪装成原生终态。helper fixture 通过不等于实际服务全部异常路径已有恒定 lifetime 保证，最终接入与专项回归需要单独核对。

## VCP 与遗忘

当前源模块是 `resources/vcp-memory`，暂存闭包在 `.tools/bot-memory-release/vcp-memory`，最终安装资源名为 `vcp-memory`。模块使用 Node 24 自己的原生依赖，不复用 Electron ABI 的 better-sqlite3。向量由应用内置 EmbeddingGemma 2 桥提供，仍为 768 维；用户不选择第二套向量模型。

`prepareTurn` 的完整 messages/metadata 按请求保存，随后由对应 `finishTurn` 结束。检索、历史回查、日记写入、增量索引与聊天片段由 VCP 负责；主脑 transcript 与 compaction 由 App Agent 负责，DSH 仅持有各执行任务的上下文。普通回复后的自动记忆编码是持久后台作业；长源按实际预算分段，冻结原始范围和幂等键，任一片段未完成都不冒称完整保存。寒暄和忘记请求不制造新事实。

### 日记更新、整理与手动回忆

受管写入仍使用原 DailyNote／VCP 索引。日记读取返回真实 checksum；更新仅对本域 owned ID 做物理路径校验和 CAS 原子换写，冲突必须重读。整理计划先耐久保存，确认新日记完整向量与标签索引后，才将旧原件归档并核实旧索引删除。pending／partial 与 indexed 分开；同操作重试复用计划。源依赖是有向关系，遗忘 A 会撤回 merge(A,B) 的使用，但不能反向忘掉独立 B。原始 `DailyNote.update` 的旧全库扫描回退没有直接暴露给主脑。

记忆工作台通过 SQL keyset 分页查询日记和标签，全文按需读取；归档保留阅读。自然语言试查分别运行原 RAG 预处理与原 LightMemo，原话查找使用 DeepMemo 关键词。仅显式试查开启已有 VCP telemetry，保留真实返回顺序、原量纲评分和边界计时；不编造统一总分，嵌套阶段不加总。测试问题不写为聊天或日记。最近试查是有界运营诊断，单域最多20份、全局最多200份，未接入语义检索；更新／撤回清理本域诊断并拒绝在途旧证据。

记忆来源包括 root event 与原始消息 ID。forget 的 VCP tombstone/revision 是权威：宿主同步撤回来源，取消受影响回复／任务，过滤后续原文与任务卡，并轮换活动上下文；VCP 在最终写入处再次拒绝已撤回来源，防止在途 capture 回灌。重启时须先恢复 tombstone 再恢复相关任务。

UI「忘记」只承诺撤回使用，不承诺清除 DSH 原始日志、聊天显示、外部产物或备份。忘记也不会撤销已经发生的外部文件修改。

## 多来源、任务和物理世界

应用内用户消息、同域伙伴消息、群聊、宿主世界事件和任务回执进入同一持久事件模型。来源种类与真实 actor 由宿主绑定，文本不能自称 user 来扩权。派生的伙伴消息、任务回执及世界事件继承 correlation 和递增 hop；达到 6 层后拒绝新任务、伙伴消息与物理变更，仍允许正常回答、记忆查询与观察。新的用户输入建立新的预算。QQ／微信、手机及远程网关尚未接入，未来适配器也必须生成同样的可信信封。

独立 DSH worker 有稳定任务 ID、单独 Session 与工作目录；指导、取消与结果回流受来源会话及伙伴绑定检查。当前仅用户私聊来源的任务可取得 `full` 原生工具范围；群聊、伙伴、世界等来源为 `scoped`。任务恢复时再按真实来源检查，不能靠保存的 extra 标志或文本自称 user 获得 full。来源不能借用户工作的能力扩权；实际范围由原生工具／权限边界落实，工作目录提示词不等于文件沙箱。

未知 worker 结果按同一 `work-taskId` 恢复，不新建任务。停止请求持久保存为意图：从未投递的 queued 任务可直接结束，已尝试 native admission 的任务恢复后通过 `cancelDurable` 核对 absent 或真实终态，不能重提 prompt 来“恢复取消”。执行器先前已成功时按真实成功回执处理。确定失败与来源通知事务提交；指导使用稳定 requestId、待投递 intent 和原生去重回执，重复 ID 的不同正文会拒绝。

世界层是真实物理状态，不只是一个叫 world 的聊天频道。伙伴只能控制自身；移动先沿路径到达，旅行先抵达出入口，家具动作先到交互锚点并取得资源。观察只暴露自己的私屋与公共场景中获准的同场人物；世界事件写入各观察者的私人 world lane，不把私人来源放到全群 transcript。

2D 与 Three.js 消费同一快照，3D 只负责绘制，不持有旧 Store 或世界 IPC。原小屋／花园 mesh 和美术资源保留；旧日常自主 routine、关系、梦境、街区导航、独立窗口与旧认知链退役。物理 work 动作不代表已经启动或完成 DSH。

## UI 与验证

当前 UI 支持 14 位内置伙伴／人格编辑、持续私聊和群聊、参与策略、世界频道、分页、流式回复、停止、任务指导与人工答复、scoped 记忆管理，以及原文搜索定位。默认大肥鱼具有两种静态形象设定，共用同一身份；不存在形象模式 API。画像与设定继承，不导入旧 cognition。

消息正文、表情与文件附件在新消息存储中绑定 canonical media refs。独立媒体服务不接资产索引或 VCP；用户未发送草稿不进入主脑文件 inventory。主脑选择表情、委派带输入文件的独立任务，执行器或主脑把真实产物发表到来源聊天。原图、预览、格式核验与导入规则见[媒体说明](superagent-bot-media-2026-11-02.md)。

最新窗口和历史浏览窗口均最多显示 400 条消息；历史模式保留阅读锚点并提示新消息，可回到最新。完全没有重叠的新页直接重置窗口，避免跨缺口拼接。迟到 snapshot、记忆响应、附件导入和跨会话流式结果按选择代次隔离；消息历史和活动 stream overlay 不是同一个存储。记忆规模与冷暖查询边界见[实测报告](superagent-bot-memory-scale-2026-11-02.md)。

Schema v14 为原文增加独立 FTS5 trigram 索引；≥3个 Unicode 码点走加引号的字面 MATCH 并以 LIKE 复核，短词只在当前授权会话字面匹配。索引通过插改删触发器同步，旧数据原子回填；不接资产库或语义索引。历史弹窗提供真实媒体 / 表情 / 文件 / 链接分类，不把空回复占位作为原文记录。

回复阶段由宿主的实际准备 / 连接 / 模型 / 恢复事件驱动；消息的 timing_json 持久记录收到触发消息至该消息发出的 elapsedMs，包含排队和恢复。首字是相对收到消息的时间，并非另一个可以与阶段相加的耗时；modelMs含连接及工具，不能当作纯推理时间。已有成功历史仅在有 outbox 结束回执时回填总耗时。聊天头像统一圆形；表情搜索默认收起为底部按钮。

正式配置复测中，大肥鱼热回复1.084秒；同一默认Host内GPT首次域初始化5.686秒；停止默认实例后原ID重启并回复16.414秒。应用完全冷启动的首条消息仍为50.784秒（准备23.258秒、主脑执行27.518秒），没有冒称全部秒回。官方隔离探针测得冷完整性校验约5.4秒、同进程watcher复用约0.05毫秒，但第一次官方Host准备126秒；之前未覆盖这条冷路径的测试不足以证明产品启动速度。证据见 `artifacts/superagent-bot-development/shared-default-real-acceptance.json` 和 `dsh-cold-integrity-probe.json`。

```bash
npm run test:bot:quick       # 短时定向 fixture / SQLite / UI 测试
npm run test:bot:e2e         # 真实 Electron：伙伴、媒体播放、物理世界、视觉夹具
npm run test:bot:protocol    # 真实 DSH/VCP 边界，受控模型协议
npm run verify:bot:memory    # 已暂存模块的完整性与 ABI 检查
npm run test:bot:real        # 显式联网模型验收，可能产生费用
npm run verify:package      # 已构建安装资源的校验
```

以上命令的存在不是通过证明。真实模型验收结果写入 `artifacts/superagent-bot-development/real-acceptance`；协议结果在相邻 `protocol-acceptance`。世界截图与图形信息在 `artifacts/bot-refactor-2026-11-02/ui`；当前 screenshot 使用 Microsoft Basic Render Driver 软件 WebGL，不能证明硬件帧率。

本机真实模型已验证带时间范围与否定条件的记忆捕获、真实附件输入和产物交付、动图、伙伴互发媒体及压缩后冷重启。完整证据和当前成品状态见[完成度审计](superagent-bot-completion-audit-2026-11-02.md)。正常气泡截图使用人工语料视觉夹具，不能作为模型回答质量证明。

一次完整回归曾记录原生记忆进程以 0xC0000409 退出；单独四项及随后完整 236 项复跑未再出现，尚未定位故障模块或根因，不能宣称已经修复。固定延迟、通用记忆准确率、数月运行和所有平台的安装环境不属于此次有限样本能够证明的范围。
