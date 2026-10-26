# VCP 与伙伴记忆生命周期对照调研

调研日期：2026-10-26。调研对象是用户指定的本地 VCPToolBox 和 WorldlineBox 当前工作区。目标架构见 [伙伴统一记忆生命周期架构方案](companion-memory-lifecycle-architecture.md)；可复核的文件哈希与供应文件比较见 [源码证据清单](companion-memory-research-evidence-2026-10-26.json)。

结论是：WorldlineBox 已经嵌入原版 VCP 的重要检索内核，问题主要出在宿主的记忆形成时机、维护调度、版本失效和长时间占用查询通道。VCP 值得学习的重点是事件完整后落笔、沿用旧记忆、区分事件与跨事件感悟，以及跨时间的联想；不能直接照搬其身份隔离、夜间调度和破坏式文件整理。

## 基准与证据范围

| 对象 | 本次基准 |
| --- | --- |
| 本地 VCPToolBox | C:/Users/hp/Desktop/project/VCPToolBox；HEAD 213bea48515ed9911a65cbedb876d1636a75b89f |
| WorldlineBox | C:/Users/hp/Desktop/project/new/WorldlineBox；HEAD c77eb9bcd29361b1b7e40f20dcfbeb62e637a4ba，含预先存在且继续变化的未提交修改 |
| 固定移植来源 | 两个 vendor manifest 都声明 7ceecd48c46caac8168b909ade5febbc4a254e42 |
| 供应校验 | 两 manifest 路径去重共 129 项，129 项的当前 vendor SHA256 均与固定 manifest 一致 |
| 对当前本地上游 | 上述 129 个路径中 95 项字节一致，34 项不同；当前上游还新增了不在旧 manifest 中的文件 |

129/129 只证明固定供应内容未偏离清单，不证明与较新的本地上游等价，也不证明二进制由当前随附源码可复现构建。95/129 也不能换算成能力覆盖率。详细路径及哈希保存在证据清单。

本轮进行了源码阅读、调用链追踪、git 差异和 SHA256 比较，没有启动 VCP 服务、读取真实 config.env、用户日记或记忆数据库，也没有调用真实模型和运行新的行为/性能基准。本文对代码的事实判断与目标架构的设计选择分别记录；不把代码存在当成当前部署已启用。

旧文档中的无向量自治记忆方案已经被当前 VCP 实现取代；2026-10-23 移植审计所列冷库、完整 DreamWave、合并能力缺口，也不能当作现在的缺失。当前源码已有这些能力。历史验收报告包含多轮修复过程，不能只引用其前半段判断当前行为。

## 主要差异

| 领域 | VCPToolBox 当前源码 | WorldlineBox 当前源码 | 架构判断 |
| --- | --- | --- | --- |
| 记录时机 | Agent 按提示主动 create/update，强调事件完整、思考和工具结束后落笔 | 合格正式来源先进入 capture，再独立调用模型判断是否记录 | 借鉴事件边界，保留自动补漏 |
| 同一件事 | 提示词要求更新同一篇；没有统一宿主 episode 状态机 | 检索旧记忆后生成候选或主动修订，主要精确身份去重 | 补 episode、coverage 和统一写契约 |
| 日记与感悟 | 独立事件并联，多个事件形成新想法时另写感悟 | 已有 relatedMemoryIds、selfDevelopment、睡眠反思 | 以实际新贡献控制反思，不强制日日产出 |
| 来源与身份 | 日记本、署名、目录名是主要组织方式 | owner、实际见证、来源域、原文校验、禁记和版本读集 | 保留宿主硬隔离 |
| 检索 | 原版 RiverMemo、RAGDiary、AIMemo、LightMemo 及可选模式 | 主要内核已嵌入，宿主增加获权物理视图和来源凭证 | 不另造简化排序器替代 |
| 时间线 | 插件初始化不自动定时生成，管理路由或工具调用生成 | 宿主在空闲后台自动逐月生成并核验依赖 | 自动化有价值，但不应每个小变化重写大月报 |
| 日记整理 | DailyNoteManager 主动 organize，先写整合文件再移源文件 | 精确版本合并、新索引成功后可逆归档 | 保留我们的发布协议 |
| 梦触发 | 默认 AgentDream manifest 禁用；启用后夜间窗口循环概率检查 | 实际 sleeping、无 work、新种子、一次睡眠一次抽签 | 两者都不能自然解决仅白天开机 |
| 梦改记忆 | 专用建议 pending_review；管理员批准后可能直接 unlink | 真实反思、合并与虚构梦分离，来源和索引后发布 | 梦用于提出有据候选，不直接删除或改事实 |
| 学习 | 知识、日记和工具可组成学习方式，未见我们的统一学习目标闭环 | 已有授权阅读、持续目标、new/reuse/revise 和回忆自测 | 增强实际应用、失败与反例验证 |
| 任务与维护 | 共享服务有写队列和原生锁，但无此产品的统一任务生命周期 | 已有冻结任务被动快照；新回忆准备仍比较全库修订 | 保留旧任务快照，稳定准备中的读取 |
| 多伙伴资源 | Dream 全局串行；部分文件写入 FIFO | 有 owner lane、轮转和全局 4 进程预算，但各子系统分散调度 | 每伙伴独立维护状态，共享公平资源调度 |

## 记录与日记

### 上游强调完整事件后落笔

[TVStxt/Dailynote.txt](C:/Users/hp/Desktop/project/VCPToolBox/TVStxt/Dailynote.txt:3) 要求等事件脉络完整、认知成型，在回复末尾以及思考和工具执行完成后写入；用户正在叙述一件完整的事时要等其讲完。同一事件延续使用 update，不同事件另建。该文件第 61 行后的感悟写法，把独立事件并列保存，再用具体锚点串联跨事件认识。

这是提示词指导，不是可靠的自动调度器：是否调用、何时调用、能否识别事件边界仍取决于 Agent。上游并没有因此自动保证不会漏记或重复记。

WorldlineBox 的 [enqueueMessage](../../src/companions/memory-store.ts:252) 在正式来源发布后为相关伙伴排队；[后台编码](../../src/main/companions/memory-service.ts:977) 会调用日记模型，即使最后判定 notes 为空。两秒安排检查、来源批次最多八条，解决了自动覆盖，却可能在用户尚未讲完时产生早期笔记，并为大量低价值片段支付判断成本。

因此改进方向不是简单关闭自动记录，而是原始来源实时持久保存、按 episode 聚合后选择性编码，并给首次身份、明确纠正、重要约定和真实结果保留及时通道。主动记录与后台编码要共享同一事件覆盖和操作收据。

### 上游的自然文本和旧记忆意识值得保留

[记忆管理说明](C:/Users/hp/Desktop/project/VCPToolBox/docs/VCP记忆管理系统.md:170) 指出写新日记前应有机会看到旧日记，机械生成标签无法维持连续结构。DailyNote 指引强调实体、具体细节、逻辑链和特异性锚点；感悟要有原事件贡献。

WorldlineBox 已在编码前检索相关旧记忆，也要求 sourceMessageIds、逐字 evidence 和实际已读 relatedMemoryIds；[日记提示与校验](../../src/main/companions/memory-model.ts:101) 已覆盖人物、否定、更正、瞬态状态、资料和自我认识。缺口在于统一的事件身份和维护触发，不是再加一份类似提示词。

### 上游 DailyNote 的并发和身份边界

[DailyNote](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:42) 有进程内 FIFO 写队列；create 使用排他创建，update 在提交临时文件前复核原文件状态；接入 KBM 外部文件变更队列后可以 waitForIndex:false 返回。应保留保存确认和索引完成分离、写临界区短小的思想。

但 folder、maid 和目录搜索不是不可伪造的 owner 授权。update 优先搜索指定目录后，还可能扫描其他目录；名字匹配不能作为我们伙伴隔离的标准。进程内 FIFO 也不能替代耐久作业、租约、跨 owner 公平和重启恢复。

上游 TagMaster 默认关闭；显式 Tag 优先，缺 Tag 且关闭自动标签时会拒绝写入。WorldlineBox 则主要为允许自动标签且无标签的手工资料补 Tag；普通自动日记本来就可由编码模型给标签。不能把两者都描述成“每条日记还要额外问一次标签模型”。

## 维护与合并

[DailyNoteManager.organize](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNoteManager/daily-note-manager.js:239) 是主动工具，不是默认夜间任务。它创建整合文本，再把源文件移到已整理目录，失败时可能 copy 后 unlink，返回索引仍 queued。其输入不为空即可，没有我们的至少两篇、准确版本、完整来源覆盖和索引后发布要求。associate 提供了以旧记忆为种子的关联发现，但默认全局范围不能当本人授权过滤。

值得借鉴的是 list、读取、associate、判断、organize 的完整维护行为；需要保留的是我们的 [合并状态机](../../src/companions/memory-consolidation-store.ts:110)：固定读集、版本核对、待发布计划、新条目索引成功后才归档原文，保留来源、可追溯历史与恢复。

当前自动维护是 [真实睡眠任务的一部分](../../src/main/companions/world-service.ts:431)，模型独立作 merge/defer 判断，排除梦、模拟与成长档案，要求原始新来源贡献。这比强制每晚压缩全部日记合理。但实际睡眠和未结束 work 会阻止领取；始终白天在线或长期做任务的伙伴可能积累欠账。统一方案应把必要维护从身体作息中解耦。

## 梦与自我迭代

### 上游默认状态及三种入口

AgentDream 当前文件是 [plugin-manifest.json.block](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/plugin-manifest.json.block)，即检出状态禁用；不能说安装 VCP 后默认每晚自动做梦。代码默认频率 8 小时、窗口 01:00 至 06:00、概率 0.6，示例配置却写 3 小时、01:00 至 08:00；实际部署还需其真实配置，本次未读取。

[AgentDream 调度器](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/AgentDream.js:899) 每 15 分钟按服务器本地小时检查。未抽中时不保存尝试水位，下轮可以重新抽；只有成功后更新持久冷却，失败也可下轮再试。全局锁使梦串行，伙伴之间另等 30 秒。未见统一最大尝试次数或离线欠账补偿。

直接 triggerDream 工具入口调用核心函数，不经过自动调度的窗口、概率、冷却和全局锁。它与自动调度不是相同门槛。

新增的 [VCPSleep](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/VCPSleep/VCPSleep.js:127) manifest 是启用态，但它是工具链 await 的等待工具，最长 12 小时，不是虚拟身体睡眠。可选睡前梦由 Plugin.js 异步触发，默认 VCPSLEEP_DREAM_ENABLED 关闭；仍依赖 AgentDream 启用、名单、时间窗、冷却、额外概率及梦锁。梦慢不会延长指定等待时间。应借鉴等待期间的非阻塞维护，不照搬长工具等待或夜间限制。

### 我们的门槛更严格，但仍过度依赖实际睡眠

[WorldlineBox 睡眠入口](../../src/companions/world-store.ts:1250) 要求真正 sleeping 至少五现实秒、无未结束 work、有未处理的已索引原始记忆。同一 sleep episode 持久化一次抽签；冷却从上次获准入梦计算，而非上次成功叙述；最多三次作业尝试、梦任务并发为二。每批最多十二篇，水位按 note ID 和 version。

优点是没有新原始记忆时不重复整理，旧梦和无新来源的派生物不推动下一轮；弱点是标签也增长 version，可能造成无新经验的再次整理，以及用户白天开机时无法自然获得深度维护。

上游按成功叙述计冷却，我们按获准入梦计冷却；抽签未中不进入八小时冷却，失败重试退避是另一机制。目标方案应分开 last_attempt、last_success、failure_backoff 和输入覆盖：必要整理不看梦概率，梦叙述绑定一次有真实输入的会话，未中即结算，失败有界重试。

### DreamWave 已移植，重点是给联想正确的位置

[原版 DreamWave](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/DreamWaveEngine.js:565) 从近期多种子开始，产生共振与二级联想，再结合中期和远期；时间桶初始七天和九十天，材料不足扩到三十天和一百八十天，复用已有向量并限制召回规模。

我们已有 [原版引擎适配](../../src/main/vcp-memory/dream-runtime.cjs:1)，增加 owner、真实来源时间、版本、内容 hash 和时间域硬约束，不能再把缺少 DreamWave 写成当前缺口。上游按目录名/署名匹配本人，并可回退文件 mtime；我们的真实事件时间更适合多人世界。

上游批准后的梦感悟写入带伙伴名字的梦目录，而后续 DreamWave 会扫描包含该名字的目录；未见对应的梦/派生硬排除。因此存在自身感悟再成为梦素材的回流风险，这是依据调用链的推断，不是本轮运行复现。目标方案应明确：虚构梦不作为事实，重复自我总结不增加独立支持，联想只产生待验证的问题、结构建议或有真实依据的反思。

### 梦提出操作不等于可靠自动改进

[AgentDream](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/AgentDream.js:198) 生成梦时重新进入 VCP 的聊天和工具路由。专用 DiaryMerge、DiaryDelete、DreamInsight 先保存 pending_review，不立即执行；但核心入口未见强制仅准这三个工具的隔离能力清单，不能把提示词当严格沙箱。

[管理员审批](C:/Users/hp/Desktop/project/VCPToolBox/routes/admin/dream.js:83) 后，merge 会创建新文件再直接 unlink 源文件，delete 也会直接 unlink，没有我们的准确版本 CAS 和索引就绪后可逆发布。故不能把这套审批设计复制成数百伙伴的日常自治维护。我们应让梦与反思共用受限统一提交，只允许有据、可恢复的记忆操作，不授予现实工具执行权限。

## 检索 增量与上下文

### 已继承的能力

当前被动路径使用原版 RAGDiary、RiverMemo 和 AIMemo+；主动路径使用 LightMemo。WorldlineBox 已有获权物理视图、过滤范围、时间处理、可选模式、冷资料摄取、原版时间线和实际引用观察。语义图、拓扑和模型聚焦不应被“为了快”而替换成一套简单相似度排序。

上游 [RAGDiary](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js:1387) 有不含占位符就返回、纯文本/LastN/BM25 快路径，以及按需上下文向量和历史增强。[AIMemoHandler](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/AIMemoHandler.js:406) 对具体 sourceFiles 计算正文指纹，排序、去重并分批聚焦。应保留完整候选与精确聚焦输入，避免模糊摘要抹掉关键限制。

原版普通查询缓存的 TTL 不等于撤销保障；部分 AIMemo 路径的键未绑定全文来源。宿主已经增加 corpus epoch、时钟、策略和引用凭证，应该精细化这些失效域，而非退回只靠 TTL。

### 原版增量机制

[ingestionPipeline](C:/Users/hp/Desktop/project/VCPToolBox/modules/knowledgeBase/ingestionPipeline.js:74) 的收集窗口由首个事件固定，后续事件不反复延后截止；同内容移动/复制可复用向量，提交前复核来源版本。[databaseCoordinator](C:/Users/hp/Desktop/project/VCPToolBox/modules/knowledgeBase/databaseCoordinator.js:266) 提供索引及删除确认。这些相应供应文件已经存在，不是需要重新发明的能力。

宿主应利用它们实现真正的内容差量，并把等待 embedding 与短原生写入分开。固定窗口也应借鉴到 episode 前缀结算，防止持续讲话一直没有闭合机会。

### 当前模型等待仍占用原生通道

实际调用链是：memory-service 的 owner queries.run 包住完整 searchView，等待 client.preprocess；client 持有进程 permit，worker 的 tail 串行完整 command；peripherals 等待原版 processMessages；原版准备候选后还在同次调用中等待 AIMemo。

证据位置：[memory-service](../../src/main/companions/memory-service.ts:433)、[client](../../src/main/vcp-memory/client.ts:258)、[worker](../../src/main/vcp-memory/worker.cjs:11)、[peripherals](../../src/main/vcp-memory/peripherals.cjs:441)、[候选到聚焦接缝](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js:2373)。这使昂贵远端生成同时占住 owner 查询队列、worker 命令队列和进程 busy 许可。前台优先只能越过未开始的后台项。

目标方案沿现有 sourceFiles 接缝拆分候选准备、锁外聚焦和短验证发布，保留原版候选顺序、提示词、分批和输出意义。可选 external rerank/Jev 也包含网络等待，需要单独固定阶段输入；没有完成阶段拆分时不能宣称所有模式已经短锁。具体新增接口与约束见架构方案。

### 原生锁不是完整 MVCC

[index_handle.rs](C:/Users/hp/Desktop/project/VCPToolBox/rust-vexus-lite/src/index_handle.rs:7) 使用 RwLock 和维护互斥；Tag 差分通过排他更新发布，多日记查询按确定顺序取得读锁。已有 Arc、资产 generation 和快照不等于对宿主开放长期可 pin 的多版本图。

首期应采用短原生准备/发布临界区、固定候选正文、锁外聚焦和任务文本快照。真正 readAtEpoch/pinIndexGeneration 需要新增原生 ABI、回收和内存设计后验证，不应从 SQLite WAL 推导它已经可用。

## 当前宿主并发与失效的实际边界

### 已有任务快照应保留

[task_passive_v1](../../src/main/companions/memory-service.ts:632) 允许已经准备好的任务继续使用普通修订前的被动输入；[恢复逻辑](../../src/main/companions/task-passive-recall.ts:7) 也会保留原结果，包括空回忆。原始来源字节变化、明确遗忘和权限收回仍通过 [frozenMemoryValid](../../src/companions/source-access.ts:85) 阻断。

因此不能把“普通整理一定打断正在做的任务”当作当前事实。真正缺口是：新查询准备期间仍前后比较整个 memory.snapshot.revision，无关新写入可能使最多三轮检索重新开始。快照的保守依赖还来自完整输入语料，而非仅最终片段，存储和核验成本可能随全库增长。精确化依赖必须覆盖聚焦模型实际看过但未输出的正文，不能为了性能只留下最终引用。

### 全局忙闲与版本放大

capture 在全局前台 busy 时先让出十五秒，之后仍可推进一批；它不是完全停工。但 timeline 和 warmup 直接要求全局不 busy，长期前台活动仍可能饿死这些工作。睡眠整理还要经过身体状态、work 占用和伙伴任务容量。capture、索引、timeline 的资源准入又各自分散。

普通 revise、organize 和标签更新使用 preserveIndexes，确实保留 clean 的持久索引；不能说每次改标签都全删索引。然而 [memory.invalidate](../../src/main/companions/memory-service.ts:734) 仍会中断该 owner 的查询和生成，并清除时间线尝试、冷却等；[视图缓存](../../src/main/companions/memory-view-cache.ts:168) 即使保留索引也删除该 owner 的 timeline artifacts。

现有单一 version 同时覆盖正文和标签；修改标签可触发依赖失效、历史来源重新提炼和睡眠再次处理。重提炼已有 cause、来源版本和 lease 去重，不是无条件无限循环，但维护放大仍值得从版本语义上消除。

### 多伙伴已有保护但缺统一治理

[query scheduler](../../src/main/companions/memory-query-scheduler.ts:26) 有每 owner lane 和前台 burst 上限；运行中的工作真正结束才释放。capture 有游标轮转和两个并发，时间线候选也有界。[process broker](../../src/main/vcp-memory/process-broker.ts:1) 全局默认四进程，活动进程不被 LRU 杀掉、真正退出后才释放；已存在进程可以绕过等待新连接的尾队。

这些机制应保留。进一步需要跨所有维护阶段统一 owner 公平、模型连接与费用预算、最老欠账、背压和阶段检查点；每伙伴独立状态不等于每伙伴常驻一个原生进程。索引投递也应避免由某个慢 owner 阻塞其他 owner 的整轮进展。

## 新上游版本的独立升级价值

固定版本到当前本地上游的差异不限于三个 JavaScript 文件。完整比较发现 34 个旧清单路径已变化，包括原生检索、拓扑、资产构建、存储和 Windows 二进制；还新增 memo_workspace、native_rerank 等文件。不能把对三个 JS 文件的局部差异统计当成全部升级范围。

已定位的方向包括：

- River 与外部精排独立候选池、并行和 RRF 融合，以及请求级 Jev 配置。
- 原生候选排除下推与补找预算，可能改善严格时间/权限域候选筛选。
- 构图共享向量工作区、单次读入、覆盖索引校验、冷加载减少复制、双场单次 CSR 遍历。
- 浮点往返、固定求和顺序等可重复性修复。
- TextChunker 和文本清理缓存减少长文本事件循环阻塞。

新上游 [index.query-options.v1](C:/Users/hp/Desktop/project/VCPToolBox/rust-vexus-lite/src/retrieval_index.rs:12) 提供数字 ID 的 excludeIds，最多十万项，及 efSearch；排除贯穿 ANN、历史补充、稀疏候选和合并，但不是现成的 allowedFileIds 前置白名单。DreamWave 可以研究把桶外文件转换成 chunk ID 排除集，以改善候选先占位再去重的问题，但须固定 ID 映射与代次、处理规模上限，并保留本人物理图隔离。新的原生 executeRiverQueryHybrid 支持 annSearch，而 [普通 KBM River 门面](C:/Users/hp/Desktop/project/VCPToolBox/KnowledgeBaseManager.js:2776) 的 hybrid plan 归一化仍未透传该字段；当前新精排门面才显式传递。仅替换二进制或开启 enabled 无法证明修复，必须配套门面适配、ABI 能力校验、空桶/高度相似跨桶/超规模排除集/来源变化及 fallback 测试。

这些是值得独立验收的性能、正确性与可重复性改进，不是仅凭 commit 标题就已证明我们的速度会提高。升级要绑定源码、ABI、随包二进制、候选过滤和原生同输入结果对照，尤其不能直接把新参数传给旧二进制。生命周期重构与上游升级应分开变更和测量，避免无法判断收益与回归来自哪一层。

## 取舍与后续重构依据

| 保留 | 改造 | 不照搬 |
| --- | --- | --- |
| 原版 VCP 检索和聚焦数学 | 按事件闭合编码和语义 coverage | 每句昂贵判断成为常态 |
| 本人来源、见证、禁记和受众边界 | 内容、注释、撤销和检索代次分离 | 目录名/署名代替权限 |
| 冻结任务快照、幂等回执和租约 | 稳定的新查询候选准备及锁外聚焦 | 全库变化就取消所有读取 |
| 索引后发布、可逆归档 | 白天维护、离线欠账合并和公平服务 | 必须夜间开机或等身体 sleeping |
| DreamWave 多尺度联想 | 有据反思、可验证方法和可选梦叙述分离 | 梦直接删除记忆或成为事实证据 |
| 自主阅读和持续学习目标 | 用真实使用结果、失败和反例改进方法 | 自我评价或摘要次数当掌握 |

拟真和工程可靠需要同时成立：事件尚在发生时保留连续性，事后只写值得再用的内容；平时持续整理，深度回顾有真实原因；执行中的任务有稳定上下文，新的问题能看到更新；忘记、撤权和撤回不因任何缓存或旧快照失效。具体协议、参数、故障矩阵和实施验收见 [统一架构方案](companion-memory-lifecycle-architecture.md)。
