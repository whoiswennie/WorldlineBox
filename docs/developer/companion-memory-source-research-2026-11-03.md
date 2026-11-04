# VCP 原始代码：日记生成时机与 Agent 记忆管理

> 本文是研究阶段的冻结源码报告：原 VCP 事实固定于下述提交，WorldlineBox 对照、建议与验收边界记录当时状态。研究完成后，用户追加授权的整理与梦境适配已实装，当前流程与验证范围见[伙伴记忆整理与梦境](companion-memory-maintenance-2026-11-03.md)。这不表示后续所有成品、768 维语义或真实模型验收均已完成，也不改变本文对原版默认行为的判断。

核查日期：2026-11-03。研究对象为 `C:/Users/hp/Desktop/project/VCPToolBox`，本地 `origin` 为 `https://github.com/lioensky/VCPToolBox.git`，固定提交 **`77aa55797057800261d8417fea6ca2156c81c7bb`**（下文 H）。已读取根、Plugin、modules 的 AGENTS 与相关插件文档；tracked 文件无修改，仅存在既有未跟踪 `docs/research/`。本文依据本地源码，不代表用户运行中的私有配置；未读取真实 env、密钥或日记库，未运行模型、DSH 或生产 App，未修改原仓。下列原仓行号均属于 H；[固定版本目录](https://github.com/lioensky/VCPToolBox/tree/77aa55797057800261d8417fea6ca2156c81c7bb)由本地 Git 元数据定位，未另行在线验证页面可访问性。

## 核心结论

原版没有一条“每次回复后必自动生成长期日记”的默认链路。正常日记主要由 **Agent 依据系统提示词判断值得记录的时机，再输出 DailyNote 工具调用**；框架负责解析、写文件和后台索引。另有独立的 OneRing 原话记录、可配置滚动摘要、显式时间线生成与可选梦境整理，不能统称为自动写日记。

对 WorldlineBox，现有 captureV2 是 App 自己承担的主动记忆策略：已发布交互后产生持久任务，由主脑编码，再经真正 VCP 写入。它不是原版默认能力，也不应因原版依赖 Agent 自主调用工具就被删除。值得学习的是事件成型、同事件更新、来源和状态保真，以及读全再整理；不是照搬一个默认未启用的自动梦境系统。

## 各模块何时真正工作

| 模块 | 实际触发与产物 | 实装边界及证据（H） |
|---|---|---|
| DailyNote create/update | 模型输出工具请求后执行；create 写日记文件，update 查找并替换已有正文。 | [manifest](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/plugin-manifest.json:20)、[非流解析](C:/Users/hp/Desktop/project/VCPToolBox/modules/handlers/nonStreamHandler.js:309)、[流式解析](C:/Users/hp/Desktop/project/VCPToolBox/modules/handlers/streamHandler.js:494)、[工具执行](C:/Users/hp/Desktop/project/VCPToolBox/modules/vcpLoop/toolExecutor.js:432)。工具本身不决定哪段聊天值得保存。 |
| OneRing 原话 | 开启且 system 开头连续区域存在触发声明后，整轮有效并且 HTTP finish，宿主才结算 assistant 原话；失败标 aborted。 | [触发识别](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRing.js:980)、[宿主结算](C:/Users/hp/Desktop/project/VCPToolBox/modules/handlers/interactionCompletion.js:17)、[兼容写库分支](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRing.js:3220)。这是对话 SQLite，不是 DailyNote。 |
| OneRingMemo | 成功记录响应后检查开关、模型、生成锁及上次成功间隔，符合条件才 `setImmediate` 生成；写 `Plugin/OneRing/memo/<Agent>.json`。 | [默认配置](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingMemo.js:8)自动生成为 false、间隔 360 分钟、model 为空；[响应触发](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRing.js:3244)、[条件](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingMemo.js:457)、[存储](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingMemo.js:93)。没有新响应就不会因到点自动生成；tracked OneRingConfig.json 没有 memo 块。 |
| DailyNoteManager | 调用 list/associate 获取候选；organize 接收调用者给定的 urls、maid、Date、Content，创建合并日记，再归档原件。 | [命令](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNoteManager/daily-note-manager.js:657)、[必填与新文件](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNoteManager/daily-note-manager.js:268)、[归档](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNoteManager/daily-note-manager.js:369)。没有自带总结模型、response hook 或巡检调度。 |
| MemoMaster / MemoriaSorter | 专职整理人格及提示词：扫描、整理、追踪、深清等由调用者选择，可受其他 Agent 委托。 | [由调用者选模式](C:/Users/hp/Desktop/project/VCPToolBox/Agent/MemoMaster.txt:34)、[委托](C:/Users/hp/Desktop/project/VCPToolBox/Agent/MemoMaster.txt:347)。tracked 源码检索未发现专门周期召唤绑定。通用 `timely_contact` 可显式安排一次性工具任务，[提交](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentAssistant/AgentAssistant.js:728)、[执行后删任务](C:/Users/hp/Desktop/project/VCPToolBox/routes/taskScheduler.js:134)，不证明存在默认整理任务。 |
| AgentDream | 若启用，initialize 启动每 15 分钟检查；本地时间窗口、白名单、冷却及概率共同决定入梦。产生梦 JSON；Agent 提交的合并/删除提案进入 pending_review，管理员批准后才改日记。 | 当前清单为 [plugin-manifest.json.block](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/plugin-manifest.json.block:1)，[加载器](C:/Users/hp/Desktop/project/VCPToolBox/Plugin.js:800)只加载正常 manifest。实装见[初始化](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/AgentDream.js:92)、[条件及串行调度](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/AgentDream.js:901)、[待审快照](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/AgentDream/AgentDream.js:571)、[批准 DailyNote create](C:/Users/hp/Desktop/project/VCPToolBox/routes/admin/dream.js:86)。不能将禁用状态说成缺少代码，也不能说当前默认运行。 |
| AIMemo / AIMemo+ | 请求预处理识别许可与占位符，对检索材料总结并缓存、回填本次上下文。 | [许可检查](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js:1457)、[结果缓存](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/AIMemoHandler.js:174)。不写 DailyNote，无后台 cron。普通 AIMemo 缓存键未包含源文件内容，默认 TTL 30 分钟；AIMemo+ 提供 sourceFiles 时有内容 fingerprint，[差异](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/AIMemoHandler.js:189)、[fingerprint](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/RAGDiaryPlugin/AIMemoHandler.js:409)。 |
| VCPTimeLine | 管理 API 显式 startTask，模型生成月记至 `<Agent>timeline/YYYY-MM.md`，一句话摘要另存 JSON；占位符主要负责召回注入。 | [初始化无调度](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/VCPTimeLine/VCPTimeLine.js:38)、[占位符](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/VCPTimeLine/VCPTimeLine.js:379)、[任务启动](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/VCPTimeLine/VCPTimeLine.js:828)、[默认跳过已有月份](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/VCPTimeLine/VCPTimeLine.js:661)。未找到日记更正或撤回后自动级联重建。 |

## 日记时机来自哪里，框架保证到哪里

`config.env.example` 的 `VarDailyNoteGuide=Dailynote.txt` 是示例配置，不证明私有运行配置已启用。实际注入代码只在 system 消息中展开已配置 Var/Tar；`.txt` 值交给 TVStxt 管理器读取并递归替换。插件清单另形成 `{{VCPDailyNote}}` 等工具描述。见[示例配置](C:/Users/hp/Desktop/project/VCPToolBox/config.env.example:663)、[变量展开](C:/Users/hp/Desktop/project/VCPToolBox/modules/messageProcessor.js:941)、[工具描述生成](C:/Users/hp/Desktop/project/VCPToolBox/Plugin.js:1050)、[工具占位符展开](C:/Users/hp/Desktop/project/VCPToolBox/modules/messageProcessor.js:1053)。

[Dailynote 提示词](C:/Users/hp/Desktop/project/VCPToolBox/TVStxt/Dailynote.txt:4)要求有新知识、经历或判断，等事件脉络完整后在回复末尾记录；同事件 update，不同事件各写原子日记。其第 28 行要求时间来自用户消息的真实当前时间，第 45 行强调信源，第 58 行要求感悟串联注明事件来源。另一个实际人格也明确不把日常讨论全部日记化，见 [Aemeath](C:/Users/hp/Desktop/project/VCPToolBox/Agent/Aemeath.txt:215)。这些是交给模型的行为要求，不是中间件确定性判定，不能仅凭提示词宣称必然遵守。

DailyNote 实装有常驻 FIFO、原子排他创建和更新冲突检查：见[分发](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:1537)、[队列](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:1575)、[创建](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:734)、[更新版本检查](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:1113)。update 必须有至少 15 字 target 且限定 maid/folder，不允许退到全库，见[校验](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:1224)。这与 WorldlineBox 的 owned ID + MD5 checksum API 不同，不能把后者称为原版工具参数。

创建/更新成功只返回 **indexStatus: queued**，索引后台进行；DailyNoteManager 同样明确 `waitForIndex:false`，允许逐文件归档 partial，未提供整体事务回滚。见[创建回执](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:755)、[整理回执](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNoteManager/daily-note-manager.js:438)、[最终一致索引](C:/Users/hp/Desktop/project/VCPToolBox/modules/knowledgeBase/databaseCoordinator.js:324)。`archery:no_reply` 只是免 AI 成功结果回灌或二次 loop，不证明写入或检索完成，见[执行器说明](C:/Users/hp/Desktop/project/VCPToolBox/modules/vcpLoop/toolExecutor.js:479)。TagMaster 只是可选标签生成，默认关闭；没有标签时开启它才会调用标签模型，不能把它当作聊天自动生成整篇日记的机制，见[默认开关](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:25)、[标签流程](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/DailyNote/dailynote.js:453)。

## 权威来源、更正与长期生命周期

原版存在真实作者、时间、前端来源、编辑替换和原件归档机制，但并非统一的来源依赖图。OneRing 默认每 Agent 留最新 100 条；retry/edit 更新原话正文，见[数据库](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingDB.js:67)。OneRingMemo 记录摘要生成时间、模型、消息数与首尾时间，并无逐条 source message ID；模型摘要和人工修改覆盖同一 JSON，见[摘要 metadata](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingMemo.js:409)、[人工覆盖](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingMemo.js:125)。区分发言者、观点不可升格事实等来自[摘要 prompt](C:/Users/hp/Desktop/project/VCPToolBox/Plugin/OneRing/OneRingMemo.js:310)，不能代替可验证的来源约束。

MemoMaster 的保真、情感记忆豁免、最多 20 篇和来源头是人格工作规范；DailyNoteManager 不强制把这些规范变成结构化血缘。Dream 虽保留待审源快照且需要审批，批准后未找到撤销或版本恢复入口；TimeLine 与普通 AIMemo 也不能保证源更正立即反映。因此“原版已经完整解决更正、撤回传播和长期无损整理”不成立。

WorldlineBox 应继续以真实来源原话与已确认执行回执作为证据，VCP 日记、摘要和时间线是派生材料；检索排名表示相关度，不能代替发生时间或更正关系。统一上下文也不能跨伙伴或受众安全域授权：私聊记忆进入群聊仍须明确权限，不能照搬原仓按 Agent 聚合的范围。

## 与 WorldlineBox captureV2 对照及最小建议

| 项目 | 当前 App 实装与差异 |
|---|---|
| 自动记录时机 | [service.ts](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/service.ts:476)在完成的用户交互后排持久 capture 任务，并排除明确 skip 与简单寒暄；[captureV2](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/memory-capture.ts:36)用独立编码调用保存明确事实及实质互动经历。原 VCP 日记主要靠 Agent 工具自主选择，不是同一自动机制。 |
| 来源与状态 | [编码约束](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/memory-capture.ts:17)区分陈述/推测/计划/未执行/实际完成，保留更正；[输入](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/memory-capture.ts:74)含来源 ISO 与本地时间；[写入](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/memory-capture.ts:145)带 root event/message lineage。不能把编码 prompt 等同于已证明的模型表现。 |
| 主动管理 | [context.ts](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/context.ts:23)已要求主动记录、先读全文再 checksum 更新/整理；[同文件](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/context.ts:14)已要求最新有据更正优先、按 clock.now 与来源时间解释相对日期。它们是新加入的行为约束，后续真实语义尚未复验。 |
| 事务与撤回 | [bot-host](C:/Users/hp/Desktop/project/new/WorldlineBox/resources/vcp-memory/lib/bot-host.cjs:46)和[managed-notes](C:/Users/hp/Desktop/project/new/WorldlineBox/resources/vcp-memory/lib/managed-notes.cjs:38)提供 owned ID、checksum、durable operation、来源撤回等宿主保障。属于本产品适配，不应按原版 queued/no_reply 行为削弱。 |

以下为当时研究阶段的最小改进建议，不能据此判断后续实现状态：

1. 保留 captureV2 和主脑自主写/更新两条入口，避免把同一交互重复提炼。观察真实捕获状态、来源及回执；不能为凑日记数强制每轮写，也不能用零条证明原话没有保存。
2. 对已加入的来源时间、更正优先、clock.now 做独立真实语义复验：旧计划被新计划明确替代、未执行请求保持未执行、同日事实不能变成上周。代码检查通过只证明机制存在。
3. 当时建议新增后台整理时，先做单安全域、有限候选、逐篇全文读取的整理提案，再调用现有 checksum/operationId 管理接口；保留原件和来源、以真实索引回执报告完成，并约束周期费用和失败恢复。**研究阶段当时尚未实现**；后续已按用户追加授权实现独立适配，见[实现指南](companion-memory-maintenance-2026-11-03.md)。它仍不是原版的默认能力。
4. 当时建议不直接启用原版全局 Dream、周期全库扫描或 TimeLine 重生成；这些涉及模型调用、源材料生命周期和审批/撤回责任。后续采用受伙伴与受众约束的适配，未以简单启用原插件代替这些保障。

## 已有真实模型验收边界

保留的 [auto-captureV2 真实报告](C:/Users/hp/Desktop/project/new/WorldlineBox/artifacts/superagent-bot-development/auto-capture-v2-real-2026-11-03T12-24-52-452Z/result.json)用了 10 次真实模型请求：4 次自然交互、4 次 capture、2 次冷重启回答；真实 VCP 768 维入库 5 条，未手工 seed。结构检查通过，但人工审查发现冷回答重新询问已明确更正的旧计划，并把同日交流说成上周，所以 **overall passed=false**；[人工复核](C:/Users/hp/Desktop/project/new/WorldlineBox/artifacts/superagent-bot-development/auto-capture-v2-real-2026-11-03T12-24-52-452Z/human-review.json)和原始机器报告均保留。

该次冷模型输入使用规范化 inspection hits，未覆盖完整 production prepare card 与 BotService/UI 链，不能直接把失败归因于最终产品上下文，也不能据入库 5 条宣称长期记忆语义已全部正确。其后 fixture 补了更严格断言与真实 evidence 输入，但当时源码研究阶段没有再发模型请求；本文保留这一历史边界，不将其改写为后续修复的真实模型通过证明。
