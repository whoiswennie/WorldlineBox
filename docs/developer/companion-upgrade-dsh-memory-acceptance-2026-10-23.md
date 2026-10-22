# 伙伴升级：DSH 执行、实例管理与话题记忆验收

日期：2026-10-23。本文记录当前工作区实现和本机实际验收，不把静态研究、合成模型测试、真实在线模型测试混为同一证据。整体设计见 [统一 Agent 工程方案](companion-agent-upgrade-design-2026-10-22.md)，上游语义调查见 [DSH 能力研究](dsh-cli-companion-capability-research-2026-10-22.md)。

## 版本与范围

| 对象 | 核实身份 | 本文用途 |
| --- | --- | --- |
| 当前安装运行包 | `@deepseek-ai/dsh 0.2.1-rc.2`；`runtime-7166bc2240b170bff29c0dfe` | 真实原生 Agent、CLI、技能/工具目录、在线执行、完整启动器验收 |
| 用户提供的上游源码 | `deepseek-harness` HEAD `639ed015397290b3745d163aafe02ffee4aa3f84`，源码 package `0.2.0-rc.2` | 追踪原生 session、preset、Cordis、Agent 循环实现；与已安装包分开标识 |
| 历史隔离 fixture | `0.2.0-rc.2` 与 `0.2.1-alpha.2` | 历史组合探针回归；不冒充当前运行包 |
| WorldlineBox | 本地未提交的当前工作区 | 本次执行协议、池化、管理 UI 和记忆边界的实际实现 |

所有新增验收使用独立临时用户目录或资产库。运行包 fixture 只读链接其封存文件，写入发生在临时实例私有目录。在线验收只在内存传递既有账户配置，报告不含密钥。

## 已实现的调用边界

伙伴按次提交 `DshTaskSpec`：执行模式 `native/ptc`、工具名集合、技能集合、显式说明与上下文、工作目录策略、新建或恢复 session，以及文本或 JSON 交付要求。插件安装、启停、卸载、账号和模型设置由启动器管理，任务协议不允许伙伴配置这些项目。

原生 Agent 循环仍由 DSH 执行。适配器通过官方 CLI profile 启动其原生 `agents.create/resume`，没有另写一个模型工具循环。每个请求创建或恢复自己的 AgentHandle，并在完成后释放 scope、监听器、工具 guard 和技能选择包装。相同宿主进程复用不意味着复用前一个任务的模型消息。

工具选择同时约束模型可见 schema 与实际工具 dispatch。插件管理工具 `plugin_manager` 在两处均封锁；普通插件提供的执行工具仍可被选择。原生 preset 在 `agent/created` 后才发布的 `subagent` 等工具，改在 create/resume 返回后读取和验证目录，避免过早把真实工具误报为不存在。

任务结束条件包括 root idle、子 Agent 完成，以及 root 状态/session 修订/input 修订稳定。真实 subagent 延迟测试已证明不会在子任务尚未完成时提前回传任务成功。

当前恢复策略保留原任务的实例、runtime、工具/技能组合、模式和 cwd。改变这些组合时新建 session 并显式交接资料。这是当前适配器的约束；不能据此声称上游核心绝对不支持 preset switching/fork。

交付向伙伴返回状态、最终回复、可校验的文件、结构化 JSON 和记录引用，必要时分页读取审计事件。原生完整 session 留在 DSH 存储中，不默认全量回灌主脑。两层模型自身后续请求仍可能重发有效历史，原生压缩也会消耗模型资源；这里没有承诺零重复 token 成本，也没有增加用户未要求的主脑总上下文预算。

## 性能实现与证据

`DshWarmCliPool` 保持官方 CLI 宿主存活，每个 worker 同时只租给一个请求。并发忙碌任务使用不同 worker；空闲池有数量和使用次数上限。当前选定实例保留一个 ready 空闲宿主，隔十分钟调用也不因普通 TTL 冷启动；其他空闲宿主仍在五分钟后清理。选定宿主达到 32 次租约、崩溃或配置代际改变仍会退役，启动器在失去最后一个 ready 宿主后补充；启动失败不无限重试。改选恢复旧实例的普通 TTL，关闭不再补充。工作进程、context pin 和 Windows Job 同寿命，只有确认进程树退出后才清理所属上下文。

代际指纹包含实际 runtime、实例、私有 profile、Agent/技能配置、共享模型/凭据、权限模式和 cwd `.env` 内容。会话产物、匿名用户 ID、缓存和日志不参与失效。首次官方启动会规范化 profile，启动完成后记录实际加载代际。大体积技能资源使用文件身份与修改时间参与校验，避免每个任务反复读取整个资源库。

runtime/context pin 固定运行版本和目录绑定，不等于冻结原生凭据服务或模型设置的官方热更新语义。配置变化会使旧 worker 退役，仍在执行的租约保留其所属进程和目录直到完成。

选择实例或保存影响能力的配置后，启动器在 300 毫秒防抖后进行零模型 discovery 预热；显示 `warming/ready/cold/failed`。任务流事件不会清空能力快照。文件系统事件按实际内容去重：共享配置准备流程重复写入相同内容，不应销毁已就绪宿主。关闭应用取消定时器、运行包探针和所属 CLI。

| 验收路径 | 实测结果 | 证据与边界 |
| --- | --- | --- |
| 在线真实 Agent + production Broker，薄 stdio carrier | 冷 session ready 7,950 ms；温调用 49 / 64 / 31 ms，四次同一宿主 PID | `.tools/test-output/companion-dsh-real-agent-acceptance-final.json`；工具/模型/session/broker 均真实，但该 helper 不走完整 RuntimeService/SharedInstanceData 准备 |
| 完整 Main launcher → prepareCli → 正式 shim → 官方 CLI（runtime 已准入） | 新 private 实例 ready 12,676 ms；重复选择 116 ms | `.tools/test-output/companion-dsh-launcher-warm-preverified.json`；同内容 rewrite/重复选择保留 worker、真正配置变更重预热、实际管理操作后的目录变化与 shutdown |
| 最终完整 Main 管理与自动轮转 | 已准入 runtime 上的新实例 10,888 ms；重复选择 61 ms；32 次后自动补充，下一调用 160 ms | `.tools/test-output/companion-dsh-launcher-warm.json`；默认 access API、相同/不同权限模式、真实 profile/插件/技能变化、宿主关闭均通过 |
| 从未准入的新临时 runtime | 最新完整准入 77,837 ms，其中 seal 全文件 44,258 ms；较早冷文件缓存时曾约 203 秒 | `.tools/test-output/companion-dsh-launcher-fresh-runtime-admission.json`；首次安装/准入成本，不是每个 Agent 任务成本；预热先完成有独立五分钟上限的准入，再开始短 discovery |
| 原生 worker 隔离与 subagent | 同一官方 CLI，连续四次不同 Agent/session/cwd；前一任务 marker 不进入后一模型输入；工具空集合→恢复全部→仅 subagent；等待真实子 Agent | `tests/unit/dsh-warm-native-profile.test.ts`，实际已安装 rc.2 + 本机合成 Anthropic 传输 |
| 选定实例宿主轮转 | 前 32 次为同一 PID，自动补充新宿主，补充后下一次查询 40 ms，模型请求为 0 | `.tools/test-output/companion-dsh-selected-standby-native.json`；production Broker、官方 CLI、薄 carrier，回调执行与启动器相同的 300 ms 补充策略 |
| 最终 Main 故障门 | 真实 Main 自动轮转后下一查询 159 ms；临时插件在 agent/created 退出后进入 failed，没有继续创建补充任务 | `.tools/test-output/companion-dsh-launcher-standby-final.json`；47.4 秒，模型任务 0，检查失败稳定窗口后关闭所属宿主并还原临时 patch |

完整启动器验收另发现并修复：新建实例尚无 `profiles/web/package.json` 时，模型 overlay helper 先于原生 CLI 运行，无法读取不存在的 manifest。现在只对缺失 profile 调用官方 `initProfile` 原生模板；已有 manifest 仍按原字节读入，不触发 convenience load 的规范化。实际 rc.2 overlay 三项测试通过。

最终 fresh-profile 复验还发现目录观察漏口：安装观察器时 `profiles` 尚不存在，原实现忽略失败后不会重装，导致首次实例之后的 profile 改动未触发预热。现在观察已有 home 并过滤会话/缓存等非能力产物，覆盖后来创建的 profile 与原子替换。能力查询默认采用当前启动器权限模式，与后台预热保持同一个代际指纹，避免查询因省略 access 而冲掉已经准备的宿主。同权限模式保存保温，实际模式变化退役并重新准备。

在线内容验收不是单纯 ping：真实算术得到 410；CSV 的初始 cost/revenue/profit 为 430/830/400；同 session 追加 C 行后为 480/955/475 且无重复行；另一伙伴以新 session/cwd 独立复核 475。宿主验证了真实文件、JSON 与展示引用。四阶段角色分工由 fixture 安排，不能用这份报告单独证明主脑自主协作；主脑及群体协作的独立验收由总验收报告记录。

后续真实自主协作已单独通过：唯一用户请求交给林澄，模型自行发起有限 collaborate，周岚独立模型接受并用自己的主脑与 DSH 目录核验，林澄继续生成交付；四行 CSV 得到 18,430 分，四份真实文件逐项核对。另有 schedule task 和 work-order 两条真实后台入口完成随机标记 JSON。证据分别为 `.tools/test-output/companion-autonomous-collaboration-content-acceptance-final.json` 与 `.tools/test-output/companion-background-dsh-content-acceptance.json`；详见 [整体验收记录](companion-agent-upgrade-acceptance-2026-10-23.md)。

## 实例级插件和技能管理

市场安装目标显式选择具体实例。目标卡展示实例名称、ID、runtime 和私有目录；更换目标丢弃旧检查结果，异步返回不会把上一实例的插件/技能画到新实例上。实例详情集中展示来源、版本、安装路径、运行包组件与私有组件的区别，以及启停、删除和刷新操作。

插件启停修改官方私有 profile 的有序 bundle 清单，保留用户其他设置；必需官方核心 bundle 不允许被关闭。列表按原生 bundle 的安装优先规则报告实际来源，不把同名私有包误认为覆盖了封存 runtime。卸载继续走所选实例的官方 CLI plugin 命令。

技能启停按物理 active/disabled 目录移动，目录当前状态优先于旧 receipt。合法手动放入的本地技能也可管理。安装记录保留 commit、归档摘要与来源；拒绝链接、冲突名称和越界路径，失败操作回滚。私有 disabled 技能不进入原生 skills 目录。

| 验收 | 结果和证明范围 |
| --- | --- |
| 插件/市场/管理 UI 单元回归 | 目标明确、来源/版本和路径、core 保护、配置保留、技能目录启停删除及异步竞态 |
| `launcher-ui-feedback.test.ts` 实际 Electron UI | 市场初始无隐式安装目标；选择 B 后检查 drawer 明示 B 与“安装到「环境 B」”；UI 不重排。这里 launcher 使用 UI fixture，不能把它当实际后端安装证明 |
| `dsh-launcher-warm-management.test.ts` 实际 Main 与原生目录 | 实例本地技能被原生目录发现，关闭消失、开启恢复、移除后物理目录和列表均消失；临时私有 bundle 对应工具随启停变化；删除由真实官方 CLI 执行 |

上述最后一项完整 Electron 测试最终通过（2.8 分钟）：使用明确的离线临时 bundle fixture 验证实际已安装包的生命周期，没有在本轮重新下载社区市场插件。官方卸载移除了依赖、bundle 注册和原生目录中的工具；测试手工放置的未受 pnpm 管理源文件仍保留，报告明确标记此边界，生产代码没有增加递归删除未托管文件的逻辑。后续在同一个已准入临时 runtime 上，以独立真实 Electron Main 加载生产构建的 DshLauncher，直接通过公共 taskCapabilities API 验证 32 次后的自动补充和 160 ms 温调用；它不是第二个 renderer UI 安装测试。历史社区插件联网安装测试不作为本轮新运行包已通过的证据。

## 实际能力发现

能力 overview 来自当前实例的实际 Agent scope：已启用工具、技能、可用模式、preset、runtime 和 cwd。按需 describe 返回完整原生工具 schema、技能正文及续读位置、slash command descriptors 和实际 `native --help` 文本。已安装依赖、启用 bundle 和真实可用工具是不同层次，UI 安装列表不会替代 runtime live catalog。

`tests/worker/dsh-capability-describe-native.test.ts` 通过实际 rc.2 验证 `read` schema，技能正文 31,056 字符通过两页完整读取，commands `compact/feedback/goal/permission/plan`，native help，以及未知工具 unavailable。监听的本机 provider 收到 **0 次模型请求**。命令描述的返回不是赋予主脑执行任意 slash 命令的端口。证据：`.tools/test-output/companion-dsh-capability-describe-native.json`。

## 虚构话题与 VCP 长期记忆

中央记忆边界拒绝把 game/story 原文、其派生 world observation 或 topic index 回执写为跨入口现实事实。显式 record/revise、正式 loop 完成、被动捕获、历史 backfill、已租 capture job 和 outbox 完成均经过中央 guard。旧虚构来源记忆不再向检索/当前状态投影；已索引后才发现被重新分类为虚构的记录被撤回并进入 forget 流程。

删除话题会在中央 source access 撤销原文与旧 topic index receipt 的可读性，包含 discussion；未完成 capture/index lease 也不再形成有效记忆。另修复已遗忘来源仅藏在历史 `world.inspect` 回执时的恢复漏洞：宿主 world 回执的来源与 memory 回执一样重新核验，旧私人拜访原因不会在恢复推理时重放。对应真实 SQLite 主服务回归 20 项通过。

`memory.sources.filter` 保持可用并按真实 ACL 返回话题原文，供主脑读取和来源核验；没有以隐藏原文代替写入边界。普通对话中明确记录“实际一起玩过某局”的真实经历仍可记录。

host-only participation receipt 只来自宿主核实的 join/leave/close 转换，记录谁、何时、参加或退出哪个 topic，以及 topicId/title/kind/tags。固定记为“活动体验”和 `actual_participation_only`，没有游戏角色、秘密、剧情正文或其他读者 workingState。通用 memory.record/revise 也不能利用这张真实收据改写出虚构现实知识。未曾激活的休眠伙伴会先建立隐藏记忆消息端口，不会被激活或凭空出现在世界中。

topics 索引直接查询真实 SQLite topic 与成员关系：本人仍属于该 room，并且已参加或受邀才能访问。索引可返回标题、标签、类型、状态、公共摘要；加入后可返回本人 working summary，指定 topicId 才返回本人完整 workingState。受邀未加入者不会拿到私态，任何读者都拿不到他人的私态。结果明确标记 `topic_state_not_real_world_facts`，不会全局知识化。

真实 VCP 证据 `.tools/test-output/companion-topic-vcp-participation.json`：使用实际 vendored VCP worker/SQLite/Rust，四条参加/退出/结束活动记录实际 remember 并确认 indexed；跨入口 native river recall 至少一条，四页标签浏览得到四个不同合法 note。外部伙伴不能检索，embedding 输入不含 raw fiction 或秘密。测试传输使用本机合成 16 维向量，因此证明原生管线、权限、标签分页和来源隔离，不证明语义 embedding 质量；相似事件被 native river 合并，不能声称一次语义搜索穷尽四条。

联系人目录多词查询按空格/中英文标点拆词，任一 name/id/description 命中可召回，精确 ID/名称优先。`周岚 zhou` 不会因为另一个别名未完整匹配而误报不存在。未扩大联系人目录原有权限。

## 话题真实 UI 接线

`tests/e2e/companion-topic-management.test.ts` 已通过真实 Main IPC、renderer 和 UtilityProcess SQLite（未替换任何 Main handler 或 storage response）。测试未配置网络模型，并让伙伴休眠；伙伴 join/private checkpoint 使用独立真实 UtilityProcess fixture 写同一个选定资产库，不将宿主安排的 fixture 行为称为模型自主参与。

覆盖私聊/群聊新建、邀请不代替本人加入、用户与伙伴不同 current 指针、他人私态不可见、查看历史不改变新消息发送目标、真实发送显式绑定 topic、暂停/恢复、编辑标题和 tags、52 条真实 topic 的 UI 分页和搜索。最终两轮均通过（每轮约 2.2 分钟）。删除保留内部审计关联，同时拒绝可读入口重读正文，不把它降为日常。工件：`.tools/test-output/companion-topic-ui-native.json`。

最终真实 Electron 在 1440 / 1040 CSS 宽度各保存明暗截图 `topic-ui-{light,dark}-{1440,1040}.png`；话题条、目录、composer 与文档均断言 `scrollWidth <= clientWidth`，并实际检查长标题、标签、参与者、历史选择和发送目标。另有 `.tools/test-output/topic-ui-message-badges-dark-1040.png`：真实 Main 发送的游戏正文与日常正文同屏，各自显示话题 badge，历史为“全部话题与日常”时 composer 仍绑定当前游戏。截图中的排队回复来自未配置模型的休眠伙伴，未冒充模型正文。

## 本轮回归命令与边界

- `npx vitest run`：插件控制、市场、管理 UI、warm pool、TaskSpec、Broker、CLI terminal 共 7 文件 56 项通过。
- `node scripts/run-vitest-with-electron.mjs run`：fiction boundary、memory processing、memory trace、world experience、topics 共 5 文件 34 项通过；包含真实 VCP worker 和 Rust 管线。
- 最终补齐删除与恢复边界后，主服务 memory + fiction boundary + processing + trace + world experience 共 5 文件 51 项通过（20.39 秒），包含已遗忘世界工具结果不重放、删除讨论正文撤回、实际参与体验保留。
- 实际安装 rc.2：warm native profile + capability describe 共 2 文件 2 项通过；没有将历史 fixture 运行冒充 rc.2 运行。
- `dsh-cli-model-overlay.test.ts`：实际 rc.2 三项通过，包括 fresh profile 初始化和已有 profile 无变更。
- 最终 standby / Broker 两文件 28 项通过，包括 fake clock 推进 11 分钟、改选、32 次退役、关闭拒重启；实际 rc.2 的 32 次零模型轮转另在 14.05 秒内通过。
- 最终实际 Main 管理与轮转 Electron E2E 2.8 分钟通过；追加真实原生进程故障退出的 Main E2E 47.4 秒通过，验证 terminal failed 后不无限重新预热。
- `npx tsc --noEmit`：全项目协议/源文件类型检查；与并行修改收敛后的最终状态以总验收结果为准。
- `npx eslint src/shared src/main/dsh src/renderer/launcher ...`：共享协议、执行/管理实现、记忆边界与新增验收文件。

最终完整隔离构建在 **2026-10-23 02:52:15（Asia/Shanghai）** 结束，耗时 12,514 ms，包含 Main、全部 preloads、workers、plugin runtimes 和 renderer，以及最后冻结的 peer-topic admission / 群调度 / reset 源码。日志 `.tools/test-output/companion-upgrade-final-build.log`，元数据 `.tools/test-output/companion-upgrade-final-build.json`。该末次操作使用 Playwright `--list`；实际运行的 UI、原生执行与模型内容验收以各自独立工件为准。

后续 CI 一致性审计迁移了四个已有 E2E fixture 的私有工具调用到三能力入口，并按当前契约核对 stateObservation 回执、显式玩家激活、真实家具观察和独立 home 场景之间的入口 travel。五个受影响用例分别实际通过：文件/图像/附件、三人并行工具与取消、SSE 工具续答与恢复、状态/日程/提醒、沙发手机聊天与电脑任务/中途取消。原有副作用与交付断言均保留；world-flow 保留站起、急扰跑步、离门路线、目标 home、电脑坐稳前不执行、唯一执行及未到达取消资源释放。共十次执行，五项去重通过，来自分轮定向修复；不是一次五项全绿运行。汇总 `.tools/test-output/companion-public-capability-e2e-summary.json` 保留各轮原报告引用。模型使用 localhost 脚本 fixture，真实 Main/SQLite/renderer 与公开能力派发仍执行；world-flow 的外部 DSH 后端按该测试原有边界单独模拟。此后只改测试，沿用最终隔离产品构建。

这里没有宣称跨任意未来 DSH 版本免检兼容，没有宣称所有第三方插件可用，也没有将 synthetic provider 当成真实模型内容评测。本轮另有真实 rc.2 PTC 在线内容验收：选择 read/write/present，模型通过原生 run_code 读入 17/23/19，产出带随机标识的 total=59 JSON 和实际文件，耗时 9,950 ms；证据 `.tools/test-output/companion-dsh-ptc-content.json`。完整任务耗时仍包含模型推理、工具执行与文件 I/O；温调用数字只度量原生 session ready 之前的启动成本。启动器同内容重写保温测试含 1.2 秒的失效观察等待，不能将该总时长当成任务启动耗时。
