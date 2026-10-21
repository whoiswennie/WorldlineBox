# VCP 记忆内容链审计与真实模型验收

审计日期：2026-10-22。上游固定提交：`7ceecd48c46caac8168b909ade5febbc4a254e42`。本报告区分原版算法、宿主权限/来源适配、模型内容质量；运行成功和相似度高均不等于内容正确。原版 vendor 文件不修改。

## 上游实际信息流

- `VCPToolBox/docs/vcp-whitepaper.md:157-165`：RAGDiary 在主模型生成前被动唤起记忆，但必须有占位符、日记本范围及门控，并非每次请求无条件读全库。`:263-334` 给出“事实上下文→记忆检索→生成/工具→事实提交→可能写日记”的完整顺序。
- `VCPToolBox/docs/VCP记忆管理系统.md:47-64` 区分近期客观时间线、月度 TimeLine、热日记、冷知识库、聊天信源回查。`:168-200` 要求写新日记前看过相关旧日记，沿用有依据的 Tag，记录延续、转折、冲突、完成，不能机械复制旧摘要或堆标签。
- 同文 `:236-326` 的日记标记具有不同注入/相似度门控行为；聚合日记本使用整体 K。普通原生近邻结果不提供“当前没有相关记忆”的可靠语义结论。`:533` 提醒不同后处理管线的分数不可机械比较。
- `knowledge/VCP知识/10_日记系统使用规范.txt:25-35` 是旧知识条目，强调有价值的新知识、一事一记，同时包含“每天一篇、第二篇请示主人、只两种文件夹”等历史约定。它不是当前代码硬限制，不覆盖用户已经授权的完整日记管理和自主记录范围。
- 原 `RAGDiaryPlugin.js:1485-1589` 读取真实最后用户及助手上下文，使用 0.7/0.3 加权观察；原 `AIMemoHandler.js:325-545` 的 AIMemo+ 先用原 River/后缀管线取候选，再使用原 `AIMemoPrompt.txt` 综合相关证据或返回无相关。原 `VCPTimeLine.js:295-380` 默认会注入全部月摘要，然后展开相关月份。因此直接使用该 marker 也需要考虑无关上下文问题。

## 本项目实际记住哪些来源

| 来源 | 自动进入候选队列的条件 | 不会自动意味着什么 |
| --- | --- | --- |
| 用户与伙伴普通聊天 | `store.ts:1066` / `memory-store.ts:148` 正式、已发送、可见且未撤回的消息；进行中的 reply draft 不算正式来源，loop 完成后补入 | 每句话都永久写成日记 |
| 伙伴之间互动 | 同一真实社交/群会话的已发布消息，观察者与成员证据通过 `source-access.ts:167` 校验 | 玩家说过、玩家授权外部行动、另一伙伴私聊可见 |
| 实际虚拟生活 | `world-store.ts:615-620` 目前选择已完成公园散步、实际进入他人场景；`memory-store.ts:126-146` 校验真实 event ID/sequence、actor、世界来源哈希 | 移动中的每一帧、计划、姿态、普通 `world_query` 都已学习 |
| 外部行动/持续任务 | 正式结果反馈可形成聊天来源；`activity-task-store.ts:96-111` 在实际成功动作历史下登记生活证据，原 memory intent 工具仍经来源校验 | 模型说“我去做”就代表任务完成；原始工具输出全部无筛选入库 |
| 人类管理文本 | 真实自然文档经 MemoryLibrary 导入；人工创建是 `manual_input`；“记住消息”保留真实消息来源 | 伪造 sidecar 能获得来源权限 |
| 已授权学习文件 | LearningService 实际读取获权资产、按 revision/hash/offset 提交 `learning.commit`，生成 `asset_read` 证据后进入同一 capture 队列 | 任意磁盘文件自动可读、看文件名就算读过、材料建议等于亲自实验 |
| 睡眠反思与梦 | 真实 sleep admission、实际读取旧日记、同域原生关联、版本 bind 后生成；梦境单独元数据和日记本，原经验反思仍有来源 | 梦境变现实事实、获得外部工具权限、改写稳定人格 |

`memory-store.ts:197-233` 每批最多八条同 owner、同会话真实来源；模型可以输出 `notes=[]`，完成来源水位而不写日记。提示词要求只记录可持续的新约定、具体偏好变化、实际结果、可追溯学习、有形成背景的新认识；问候、附和、重复确认、查询旧记忆和回答格式要求不当流水账。标签由实际内容生成、沿用同义稳定实体锚点；Tag 自动补充服务仍受同一来源、禁记与修订约束。

新日记必须有本批来源 ID 和每个来源的逐字引文；普通新日记只看到同逻辑来源域的旧日记，能关联其真实 ID/version，但不把旧证据冒充新证据。`memory-model.ts:72-100` 和 host 事务共同验证，持续禁记再经过语义核验及 prohibition revision 原子守卫。来源撤回、改版、授权缩小会使日记/依赖失效，物理授权视图随之重建。

## 本轮修复的真实缺口

1. 原全局 provider transport 对部分接口无条件强制 JSON，原 TimeLine 纯文本 prompt 在真实 DeepSeek 上返回 HTTP 400。`model.ts:135-178` 区分 structured 与原版纯文本，五种格式均保留各自协议，不能把工具/思考当正文。
2. 原日记依赖验证要求新来源和旧日记来源相同，阻止真实“今天的新更正关联昨天日记”。现允许实际读取的同域旧日记为依赖，新证据仍只来自当前批。进一步只把同来源域旧日记传给普通 capture 模型，避免模型反复申请非法跨域关联而卡住队列。
3. 原 capture 完全串行。`memory-service.ts:375-430` 改成最多两位 owner 独立推理；撤回只 abort 对应 owner，另一位 pending 时第三位可继续。每个 owner 内保留顺序与 lease；前台持续繁忙最多 15 秒后也会处理一批。
4. 被动检索以前只给一个当前文本，丢失原版最后助手上下文。现在只传实际获权的最近对话并保留自己 assistant 身份，引用/当前消息优先取权限，用户粘贴的检索声明被中和。
5. 原生 top-K 总有近邻。真实 Gemma 在木星、代数、问候上仍给个人日记较高分；0.35–0.65 Truncate 均不能可靠排除。继续沿用原算法，接原版 `::RiverMemo::AIMemo+` 和全文原 prompt，而非新写宿主检索器。
6. 旧 context 同时注入原版 processed text 和原始 native 候选全文，绕过聚焦。`context.ts:69` 在 processed context 存在（包括空/无相关）时不再注入原始候选正文；主动 memory.search 仍可让工具判读候选。
7. 旧 TimeLine marker 无条件注入所有月摘要。现通过已验证 sourceDigest 的月文件加入同一原 River+AIMemo+ 候选，不再绕过话题门；原 Timeline 生成、summary、持久化、索引与手动原 marker 能力保留。
8. 真实测试中原 AIMemo 曾先承认问候无关又附私人背景。宿主 facade 上级规则明确：无直接关联、纯问候返回原“未找到相关记忆”格式，不能附近期个人背景；保留上游原 prompt 字节。另明确记录者别名不是玩家、已确定日期/时段不因具体钟点未定而消失。
9. 加入真实伙伴间互动后，模型一度把随后 `authorId=user` 的私聊沿用成周岚的发言。日记输入现在明确给出 self/player/peers 身份，以及每条的 human_player/self/other_companion/host_evidence 标签；不由模型从最近人名猜说话人。
10. 同一真实小库中，咖啡更正日记已经 indexed，原生语义近重复合并仍可能只保留旧日记，导致原 AIMemo 根本看不到新证据。宿主仅在各物理 runtime 私有 `rag_params.json` 副本中将上游 `KnowledgeBaseManager.deduplicationThreshold`、`resultDeduplication.semanticThreshold`、`finalSemanticThreshold` 设为 1；算法源码及 vendor 参数模板不变。复测保留了新旧限定。该配置减少近义合并，也可能增加候选重复和 token；完全相同向量的碰撞及有限 K 仍然是边界，不能宣称解决所有矛盾。
11. 原明确“未找到相关记忆/知识库为空”输出统一成 `memoryContext.text=''`，保留 revision/profile 校验，不把 preamble 或候选数量当实际注入。空授权库在 snapshot 后直接返回空页，不解析模型资源或初始化 worker；不是调用旧检索 fallback。

## 并发、额外成本和缓存边界

- 同一前台 audience 查询按序执行，授权视图物理隔离；不同 owner 可独立使用有限 native worker pool（四个进程）。日记模型并发上限二，睡眠/生活服务也有各自有界队列。不是所有伙伴共用一个长 LLM 串行锁。
- **编码器仍是一个共享的有序队列**（`embedding-global-service.ts:47,110`），单个批次/多媒体窗口可能让后来查询等待；不能声称无论多少伙伴、多少资产都零阻塞。云模型 provider 本身也可能限流或中断。
- 每个有非空候选的被动召回通常额外一次 AIMemo 全局聊天调用；候选超过 18,000 估算 token（上游含 10,000 固定开销）时原版分批，最多两批并行，还可能有汇总调用。原请求的 40,000 output 上限是上游预算，本应用 provider 本身另有输出限制，不代表每次消费该数量。
- 原 AIMemo 缓存限定 32 项、60 秒。原 cache key 包含日记本、当前用户/助手语境、预设、候选 sourceFingerprint；修订/删除/缩权会换物理 scope，发布前再次验证 snapshot revision/profile。禁用无 source revision 的原 RAG_QUERY_CACHE。未变输入/候选命中缓存不再付一次聊天调用；新问题、新来源不命中。模型参数改动的质量缓存最长 60 秒，权限不以 TTL 为边界。
- 后台月时间线另有生成和摘要调用，同一月五分钟限频；前台独立 scope，不等它生成。撤回中断后不发布过期结果，月 sourceDigest 不符不导入。文档首次大批导入与首次向量化是后台建设，不能以 warm 查询数字隐瞒首建成本。

## 可复现证据与限制

`tests/worker/companion-memory-content-scenario.test.ts` 是 opt-in 的真实内容验收，使用 `WORLDLINEBOX_CONTENT_EVALUATION=1`。在独立 Temp 档案中建林澄、周岚、陈青三个不同角色，真实已配置全局聊天 API、真实本地 Gemma、真实 SQLite capture/outbox 和原 VCP 原生检索；模型日记与回答不伪造。读取真实配置只为解密已有 key，key 仅驻内存、不打印、不写报告，不改真实用户伙伴/笔记。聊天输入和报告均为合成公开夹具。

保留失败证据：`artifacts/vcp-validation/content-three-companions-before-relevance-fix.json`、`content-three-companions-before-greeting-and-time-fix.json`、`content-three-companions-before-journal-domain-fix.json`、`content-three-companions-before-native-dedup-and-identity-fix.json`、`content-three-companions-provider-interruption.json`。首轮基线发现无关正文注入，后续真模型复测进一步发现问候附背景、时间限定丢失和跨域依赖重试；这些不能归因于“程序已跑通”。较早实际正向梦的完整正文、原提交、indexed 梦日记及来源已提取到 `artifacts/vcp-validation/content-real-dream-positive-evidence.json`，并带源报告 SHA 和该轮未全绿的声明。

原生 Gemma 相关性分数校准：`content-relevance-calibration.json`。它只证明该合成小库上的相关/无关分数重叠，不给出通用相似度阈值。最终完整内容结果写入 `content-three-companions.json`，报告中逐项保留来源、版本、模型正文、调用用途与 token usage；SSE reply usage 未由 provider 返回时保持未知，不补造成本。

学习夹具真实通过 LearningService/file.readFile/host receipt/capture/检索，但它的资产目录发现适配器和 ready admission 为夹具；完整 LibraryWorker 权限读取与真实 learning world admission 由独立 worker/E2E 验证，不能混称本测试已覆盖。睡眠 admission 抽签在夹具固定为 .1，仅用于取得已有规则允许的 episode；不是模型或日记 stub。睡眠/生活机制长时回归由对应模块报告覆盖。本测试不证明自我意识，也不保证所有模型、任意文本都不会误记或漏记。

## 最新完整结果与人工内容核查

最新独立运行：`2026-10-22 01:25:40` 启动，测试正文耗时 **127.54 秒**，**12/12** 内容断言通过，未记录宿主错误。整个档案在结束后安全删除，模型与 VCP worker 已关闭。没有继续增加 QA 范围来美化结果。

| 检查 | 实际内容证据 |
| --- | --- |
| 选择性记录 | 三位伙伴收到普通问候后均零日记；已有记忆库时再问好，原 AIMemo 无相关正文，不带咖啡/收藏/雨伞背景 |
| 三位伙伴的共同记忆 | 三人各自记住周六下午、蓝伞/空表/见闻分工，最终回答保留尚未发生、尚未准备 |
| 伙伴间互动的实际作用 | 周岚真实模型回复提出时间点位、天气光照、对象状态及存疑栏；陈青真实模型回复将可核对观察与推测/待核分开。三位 owner 均形成各自真实见证来源日记，没有把 peer 说成玩家 |
| 更正 | 新旧两条来源保留，最终回答为“你现在白天可以喝淡咖啡，晚上不喝。之前那句……是你自己更正的”而非继续旧习惯；新日记正确写“玩家”而非周岚 |
| 无关召回 | 木星问题没有附个人安排；问候没有附私人背景。原 native 候选不再双份绕过聚焦进入主脑 |
| 权限与撤回 | 私聊收藏代号/旅行箱位置不进入群上下文；执行真实删除和 invalidate 后，后续实际模型回答不复原被撤回正文 |
| 实际学习 | 从真实多段 UTF-8 文件读到“青芽七号”、表土两厘米干才浇、雨后潮湿跳过，产生 `sourceType=asset_read` 的资料日记；实际回答保留“材料建议，未亲自验证”，不声称做过实验 |
| 睡眠边界 | 最新获准 episode 的真实模型选择 `notes=[]/dream=null`，允许没有新认识时不强造。较早独立完整 run 确实生成并通过 host 提交有逐字来源的虚拟梦，已保存在 `before-native-dedup-and-identity-fix` 报告：雨伞、空白表与尚未确定的碰面信息是梦境联想，正文明确“承诺……不能把准备和到场提前写进记忆”，没有把梦中到场升级为真实完成。该较早 run 的咖啡项曾失败，不能将其整体说成全绿 |

最新一轮共 **72 次真实云聊天调用**：31 次 journal（包含空日记决策）、12 次最终回复、19 次后台 Timeline/summary、9 次原 AIMemo、1 次睡眠整理。非流式已知 usage 合计输入 **141,806 token**、输出 **15,207 token**；12 次流式回复 usage 未采集，不能把零占位当免费或完整总费用。没有根据未知套餐推算金额。

原 AIMemo 的完整非流式请求 p50 **1,050.74 ms**、p95 **1,699.52 ms**，这只含该聊天请求本身，不是整个召回或最终流式回答时延。完全相同查询/来源的 warm 缓存检索实测 **62.68 ms**、新增 AIMemo API 调用 **0**。普通回复记录的是 fetch headers 时间，不能拿它当首个有效 token 或完整回复完成时间。后台月度生成调用数较多，是多 owner/多 audience 的独立授权视图与更新，不能假设每位伙伴只要一次生成。

代码关门回归：纯文本/结构化五协议、显式身份和来源域、空/无相关不注入、被动历史权限与标记注入、journal 两 owner 并发/单 owner 取消、实际月 Timeline 生成→重启→聚焦候选、长生成期间前台查询及撤回/关闭均有单测或真实 native worker 回归。`vendor-vcp-memory.mjs --verify` 确认 **127 个原文件 SHA 未变**。原参数阈值变更只在 owned runtime 副本，已列为明确适配差异。

最终整合回归由主任务统一执行，`artifacts/vcp-validation/closed-loop-final-regression.json` 为 **1,334 passed / 0 failed / 11 skipped**；reset 性能组单独 **8/8**，合计 **1,342 passed**。全源 TypeScript 与本轮 scoped ESLint 通过。中途另一个并发运行的关门 runner 有一次用例约 1,553ms 失败，该夹具连首次 cold remember 都受 requestTimeout=1,500ms 限制，符合并发 CPU/文件竞争下短 deadline 的表现；停止前未输出完整失败堆栈，不能确定失败断言位置。该 runner 随后按主任务要求停止，不能计作全绿。统一最终回归包含相同超时/崩溃恢复用例并通过，没有额外生产回收错误证据。该短夹具截止与生产 120 秒请求预算不同。
