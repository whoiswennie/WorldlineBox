# 内置工作进程与资源

WorldlineBox 通过 `lib/client.cjs` 启动随应用分发的 Node 24 工作进程。ToolBox 提供 RiverMemo、日记索引和上下文预处理器，VCPChat 提供 CDS、DeepMemo、TopicMemo 和聊天上下文处理。宿主负责选取伙伴的记忆空间、连接模型、提交会话及管理进程的退出和恢复。VCPToolBox 与 VCPChat 的许可原文保存在各自源码目录。 [ToolBox](upstream/toolbox/LICENSE) · [VCPChat](upstream/chat/LICENSE)

内置模型网关使用应用实际提供的向量空间和文档、查询两种编码方式，按工作进程传入临时凭据。构建时只分发一份应用向量模型。工作进程使用独立的 Node 依赖目录和适配此版本 Node 的 SQLite 原生库，构建阶段按本目录的锁文件安装并核对生产依赖。

## 一轮聊天中的记忆

1. 宿主根据当前伙伴、受众和话题选择历史发言，排除撤回来源。后台按发布顺序把聊天原文写入 VCPChat 的话题存储，供 DeepMemo 和 TopicMemo 回查。如果把排队的消息转作对正在执行任务的补充，原文归入实际接收它的话题。
2. 每轮回复前，宿主把话题历史和自己的日记、时间线、OneRing、折叠声明交给 VCP。MemoryThinkingTray 与 RAGDiaryPlugin 处理语义、时间和标签关联。新库的标签覆盖不足时可用同一模型的 KNN 召回。处理后的材料通过 DSH 的每轮模型上下文送达，聊天界面只显示实际对话。
3. 在本轮聊天中，伙伴判断哪些约定、经历或更正值得留下，调用 DSH 的记忆写入工具。上游 DailyNote 创建带时间、署名和 Tag 的日记原文，原生索引处理片段与标签之间的关联。宿主绑定本轮的消息来源、写入回执与撤回状态。整轮回复结束后提交 OneRing 回执。
4. AgentDream 按上游默认规则在本地时间 01:00 至 06:00 每 15 分钟检查一次，每位合格伙伴有 60% 的入梦概率，成功后冷却 8 小时。DreamWaveEngine 在同一受众的完整日记库中按时间取样，近期最多 3 篇、中期最多 2 篇种子，并利用 RiverMemo 进行多层联想。梦境叙事使用随包模板和伙伴人格。合并、归档和感悟在工作台逐项交由用户审批。

### 桌面的闲时维护

上游 AgentDream 写下每位伙伴最近一次成功入梦的时间。VCPSleep 是伙伴主动调用的休眠工具，它触发的梦仍检查时间窗口。VCPChat 的桌宠闲时任务分别记录每位伙伴的真实互动，生成中出现新互动会让路。OneRing 在对话轮次提交后按自身间隔更新近期摘要。这几个时钟各自承担不同的工作。 [AgentDream](https://github.com/lioensky/VCPToolBox/blob/fd1eec0dfe25507c22a42232b4b64cac8c0c7768/Plugin/AgentDream/AgentDream.js) · [VCPChat 闲时任务](https://github.com/lioensky/VCPChat/blob/ea8942cfbe275bbe7fca1cbf1222f6c0ca0b3fe4/modules/deskpet/idleRunner.js) · [OneRing](upstream/toolbox/Plugin/OneRing/OneRing.js)

WorldlineBox 为间歇打开的桌面应用增加了白天的启动时机。索引回执确认一篇日记新增或变化后，宿主为这位伙伴和这个受众保留待处理版本。退出应用会保留进度。启动或系统唤醒有 20 秒宽限，同一伙伴约两分钟没有真实输入、前台任务已经结束时，宿主可运行原生梦境。成功冷却由白天和夜间共用。生成期间开始新的聊天会让维护让路，稍后沿原任务继续。梦境使用日记写下时的日期。如果久未开机、波次找不到种子，宿主会分批使用原生日记和语义关联生成整理建议。

普通整理由 MemoMaster 的原始规则指导。DailyNoteManager.associate 读取日记首段的索引向量做多种子联想。待处理版本按原始月份分批，已确认索引的日记有 30 天的冗余判定沉淀期。宿主保存到期时间，重开后可在空闲时检查已经成熟的版本。普通整理默认由独立模型逐项核对原文证据，确信时执行，有疑问时留给用户。梦境候选保留人工审批。长事件可生成共享事件标签的脉络卷与结晶卷，两份索引都确认后才归档原件。 [MemoMaster 原始规则](upstream/toolbox/Agent/MemoMaster.txt) · [DailyNoteManager](upstream/toolbox/Plugin/DailyNoteManager/daily-note-manager.js)

建索引、写原文、提交 OneRing 回执和做梦都在后台运行。当前回合为自动召回预留有限时间。引擎忙或超时时，该轮使用已经取得的聊天上下文继续回答。后来返回的材料只供后续回合使用。伙伴发起的日记写入若未及时取得原生回执，宿主先持久化正文、标签和来源，并向伙伴返回排队状态。重启后按同一写入标识核对回执，已撤回的来源会被排除。

应用首次启用新版时会清理该用户资料目录下的旧 `companion-bot-v2/memory`。新记忆保存在 `companion-bot-v2/vcp-memory-v5`。主数据库升级时清理依赖旧索引的任务、候选和游标，保留聊天原文和撤回记录。

每个伙伴在每个受众下拥有独立目录。目录中的 `dailynote/Companion/` 保存 DailyNote 写出的 UTF-8 日记文件。文件名包含日期、时刻和稳定写入标识，正文包含日期、写入时的伙伴署名、日记内容与 `Tag:` 行。同一次群聊的两位伙伴可以分别记录各自的观察，之后各自编辑、召回或忘记。话题原文由各自的 VCPChat 历史存储管理。

例如，伙伴可以用「观鸟」「集合地点」「青鹭湾」为一次约定打标签。VCP 把日记片段和标签写入原生索引，利用跨日记的标签关联训练 RiverMemo。下一次提问会结合话题里的实际发言生成查询，相关片段随模型请求送达。 [日记写入源码](upstream/toolbox/Plugin/DailyNote/dailynote.js) · [RiverMemo 引擎](upstream/toolbox/RiverMemoEngine.js) · [梦境波次](upstream/toolbox/Plugin/AgentDream/DreamWaveEngine.js)

RiverMemo 使用 VCP 的原生索引、标签训练和排序。上游 `::Jev` 和外部 `::Rerank` 模式需要各自的推理服务，本包的默认召回链路使用随包模型与原生排序。写日记、生成摘要与梦境所需的推理由应用已配置的聊天模型承担。

## 更新与核验

在项目根目录运行下列命令。前两条用于维护者更新上游快照时，从干净的两个指定源码检出提取文件并重建来源清单。日常构建只需后两条，所用快照已纳入本仓库。

```powershell
node resources/vcp-memory/scripts/snapshot-upstream.cjs --toolbox ../vcp/VCPToolBox
node resources/vcp-memory/scripts/snapshot-chat-memory.cjs ../vcp/VCPChat
node scripts/stage-bot-memory.mjs
node scripts/verify-bot-memory.mjs
```

打包工具从 `.tools/bot-memory-release/vcp-memory` 复制工作进程与资源。校验覆盖文件字节、平台依赖、SQLite 的实际开库和 Vexus 的原生能力探测。内置模型由应用模型资源清单独立校验。

Windows 上可运行 `npm run verify:bot:memory:recall` 做真实向量验收。它使用随包 CPU 模型在临时目录写入三个带标签的日记，等待原生训练完成，并在工作进程重启前后检查严格 RiverMemo 召回和上下文注入。

`npm run test:bot:protocol` 使用真实 DSH、VCP 和内置向量模型，聊天生成使用本地协议测试模型。它从普通聊天开始，验证伙伴自主写日记后另开话题，只问集合地点，模型请求即收到先前的决定。
