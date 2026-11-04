# 记忆与上下文迁移覆盖矩阵

核对日期：2026-11-02。本文区分**原码保存、宿主接线、真实执行、外部效果**，不把其中任意一项替代其他项，也不作“百分百无损”或任意语料召回率保证。

## 基准与判定

| 来源 | 实际基准 | 字节校验范围 |
|---|---|---|
| VCPToolBox | `b8e37d4fca6cab99db90c1a66b9a79d32825766b` 当前工作树 | `upstream/manifest.json`：336 文件，含当前 JS、完整 Rust 源/内部 crate、已发布原生二进制、公共配置/提示词、相关测试 |
| VCPChat | `2af26aaddcf82163c9f3e88b55d53518cb9db059` | `manifest-chat.json` 32 文件；`manifest-chat-memory.json` 26 文件，后者包含现役中央 CDS/DeepMemo/TopicMemo |
| WorldlineBox 本地模型 | `ecdace4b419ae7c4176be9be2cfb9e67c7d64f51` | `manifest-worldline.json` 119 文件，含原 session/owner TS、编译输出、模型/投影器、CPU/Vulkan、FFmpeg 与署名；约 1.10 GB |
| 官方白皮书/教学页面 | `references/official/` 静态文本，抓取信息见其 manifest | 4 份参考文本；正文嵌入白皮书为 V6，页面简介仍有旧版标记 |

`node scripts/verify-integrity.cjs` 已对上述五份 manifest 全部校验通过。它证明被记录文件的字节相同，不证明任意模型输出或文档宣传已经实现。ToolBox 的 `docs/MEMORY_SYSTEM.md`、旧 RAG README 及根 AGENTS 的“无测试”描述与当前代码存在时差；实际代码和测试优先。

以下证据代号：**S**＝上游原始测试已执行；**I**＝独立适配器测试使用真实原生存储、受控模型/HTTP 提供方；**R**＝真实本地 Gemma 推理。I 中的模型替身不是生产语义质量证据。真实远端模型测试单独记录，不预先记为通过。

## 持久记忆、索引与主动回忆

| 能力 | 源码证据/白皮书 | 独立入口 | 验证及边界 |
|---|---|---|---|
| 日记 create/update、独立 folder/maid、Tag 与文件名协议、FIFO 写队列 | `Plugin/DailyNote/dailynote.js`；白皮书 8.8 | `tool DailyNote`，保留原 manifest 参数 | S/I：创建、索引、重启、更新、删除；没有用简化 writeFile 替代原服务 |
| 日期范围列出、整合后归档、联想关联 | `Plugin/DailyNoteManager/daily-note-manager.js`、`modules/associativeDiscovery.js` | `tool DailyNoteManager` 的 list/organize/associate | 原码/入口具备；S 覆盖 River 联想；大规模真实归档操作未用用户数据验证 |
| 热库事实存储、批处理、哈希重用、增量/删除、外部写协调 | `KnowledgeBaseManager.js`、`modules/knowledgeBase/*` | `sync`、`status`，原 DailyNote 依赖注入 | S/I：Rust SQLite、原子增量、失败文件隔离、重启一致性；sync 验证完整向量和 Tag 回执 |
| 原生 watcher 代际/稳定事件、溢出重整、退出排空 | Rust `VexusWatcher`，`fileWatcher.js`、`ingestionPipeline.js` | 知识库生命周期；独立 worker close | S：watcher/backpressure/reconciliation/drain；不能把“watcher 安静”当入库成功 |
| SQL 权威、索引快照恢复、代际发布、空闲卸载、向量精度/维数边界 | `indexRepository.js`、`databaseCoordinator.js`、Rust `knowledge_*`/index 代码；8.9 | 自动生命周期及 `invoke knowledge.getMemoryProfile` | S/I：恢复、基线差异阈值、SQL 路由、3072/4096 兼容、维数上界；独立 Gemma 默认 768D |
| AGS 几何、TagMemo 原生控制面、共享感应/观测、RiverMemo 拓扑/Ω | `TagMemoEngine.js`、`TagMemoV10Engine.js`、`RiverMemoEngine.js`、Rust `memo_*`/`rivermemo_topology_v3.rs`；8.1–8.3 | 标准检索管线；`invoke knowledge` 的几何、训练、快照 API | S：共同观测、共享预算、geometry-before-artifact、冲突重试、原生联合检索；I：River 查询真实执行；不承诺任何语料都优于 ANN |
| 手动训练、几何重算、标签一致性预览/应用 | KBM 的 requestActiveFullTraining/recomputeGeometry/previewTagConsistency/applyTagConsistencyPreview | `invoke` 的 knowledge 白名单 | S：任务共享与错误状态、增量 Tag 一致性；高级变更应在独立工作区验证 |
| 主动热记忆、日期/作者/文件夹范围、BM25 候选证据、KNN/RiverMemo | `Plugin/LightMemo/LightMemo.js`、`nativeQuery.js` | `search`；`tool LightMemo` | S/I：真实索引查询；`--diary`/`--k` 必须映射原 folder/k；旧 TagMemo retrieval 退休并明确拒绝是源行为 |
| 四轨实验室：TDB 原向量、Rerank、Jev、RiverMemo | LightMemo `memory_ab` | `tool LightMemo`，command=memory_ab | 原实现保留；外部两轨未配置/失败会说明，不能用回退分数冒充外部评分 |
| 文本/正则/模糊/BM25 搜索独立服务 | `Plugin/DailyNoteSearcher/DailyNoteSearcher.js`、Rust 源及 EXE | `tool DailyNoteSearcher`，每工作区动态端口 | 真实二进制保留；具体搜索方式和平台按原 manifest；不把所有文本搜索都叫向量检索 |
| 冷库可靠摄取、重试/租约、文本/向量/图混合、TQL/图遍历、压缩/卸载 | `TDBKnowledge.js`、TriviumDB；8.4 | `<home>/knowledge`，`sync`，`invoke cold`，LightMemo knowledge_base | S/I：真实 TriviumDB 摄取与检索；**默认 TDB_KNOWLEDGE_ENABLED=false**；图语义依赖实际资料与图数据 |
| 历史聊天中央索引、owner/topic 范围、排除当前话题、关键词 DSL、窗口与 Unicode 预算 | VCPChat `DeepMemoService.js`、`modules/services/chatDataService` 与 Rust CDS；白皮书 13.20 | `tool DeepMemo`，`lib/chat-memory.cjs` 从独立 sessions 镜像到独立 AppData | I：现役 CDS 实际二进制、SQLite/Tantivy、话题排除；legacy EXE 关闭，未用简化关键词扫描代替当前默认链 |
| 话题列表、完整话题原文格式化 | VCPChat `TopicMemo/TopicMemo.js` | `tool TopicMemo`；`session list/get` 是另外的文件接口 | I：原 TopicMemo 子进程格式化当前独立会话；不自动扫描原 VCPChat 私人 AppData |

## 被动召回与上下文寻址

| 能力 | 源码证据 | 独立入口 | 验证及门槛 |
|---|---|---|---|
| `{{角色日记本}}` 全文、LastN、BM25 与文本匹配 | `DirectDiaryTextProcessor.js`、RAG 主文件；8.5 | `preprocess`，纯文本路径无需向量 API | S/I：直接注入、真实 user 识别、角色阀和多模态保留；不强制为纯文本注入联网 |
| `[[...日记本]]` 片段、`<<...>>` 阈值全文、`《《...》》` 阈值+片段 | `RAGDiaryPlugin.js`；8.5 | `preprocess` | S 覆盖源管线；I 直接/片段；其他组合的存在不能替代生产语料阈值标定 |
| 多日记本虚拟聚合、动态 K、共享预算、去重及上下文已写内容排除 | RAG、ResultDeduplicator、KBM 原生查询；8.6/8.11 | 同一占位符内 `|` 和修饰器 | S：原生候选、语义去重、copy-on-write、共享观测、占位符去重；未逐一做所有修饰器的笛卡尔积测试 |
| Time/TimeDecay、Group、RiverMemo、BM25/BM25+、Truncate/Expand、Associate、RoleValve、Base64Memo | RAG 各 helper、TimeExpressionParser、SemanticGroupManager | 原占位符修饰器 | 原码完整保留；S 覆盖关键边界；所需语义组和记忆内容由工作区提供，不复制原作者私人资料 |
| 外部 Rerank、RRF、Jev 筛选 | RAG、LightMemo、`modules/jevClient.js`/Scorer | 原修饰器及配置 | S/I：受控协议、分批、超时、失败退回原排名；真实 Rerank/Jev 服务效果单独验收 |
| AIMemo、预设、共享总结桥与缓存 | `AIMemoHandler.js`、AIMemoPrompt/MoreAIMemoPresets、getAIMemoBridge | `::AIMemo`、LightMemo aimemo | 实码与模型路由具备；须有效聊天配置；没有将未配置总结器宣称为已工作的模型 |
| 元思考链、二维簇寻址、River Sense 路线和 ANN 降级 | `MetaThinkingManager.js`、meta_thinking_chains.json；8.13 | `[[VCP元思考...]]` 原语法 | 配置模板保留；**RAG_RIVER_THINKING_ENABLED=false**，真实簇内容需自行建设；旧 EPA/ResidualPyramid 名称不能当现役 JS 模块 |
| 冷库 `[[xx知识库]]`/`《《xx知识库》》`、库范围与门控 | `TDBPlaceholderProcessor.js` | `preprocess` | S/I 涉及真实冷库；独立于热记忆的 Tag/联想语义；未启用冷库时会跳过，不是已经查询成功 |
| ContextBridge 查询向量/引力场/缓存/FoldingStore | RAG getContextBridge、ContextVectorManager、CacheManager、FoldingStore | 内部依赖注入；Node MemoryRuntime；高级只读 invoke | S：向量复用和共同观测；I：RAG/时间线/折叠注入；缓存通常在长驻 serve 内复用，单次 CLI 进程缓存会结束 |
| 工具轮内真实 system RAG 区块刷新 | `ChatCompletionHandler.refreshRagBlocksIfNeeded`、RAG.refreshRagBlock；8.11 | `lib/rag-refresh.cjs` 复用原 helper；内置记忆模型工具循环接线 | 独立刷新测试已通过：system-only、fence 隔离、原输入不改、美元字面量、OneRing 非枚举 metadata；实际工具轮接线见 runtime 测试 |

## 近期连续性、长期时间线和压缩

| 能力 | 原码 | 适配入口 | 验证及配置门槛 |
|---|---|---|---|
| OneRing 按 Agent SQLite、跨前端来源、Only/Post、编辑/retry 幂等与近期补齐 | `Plugin/OneRing`，白皮书第九章 | `preprocess` 的 `[[OneRing::Agent::Frontend]]`，随后 `response` | S/I：写入/完成闭环；共享同一 home 才共享同一账本；**源默认 ONERING_RECORD_ONLY=true**，需要补齐时显式 false |
| 客户端 hash/time 权威绑定与服务端推断双路径 | VCPChat IPC wire contract、OneRingRawClientTimeline/ServerInferredTimeline | `context/session prepare` 返回 vcpchatExtensions，交给 preprocess.options；元数据不发模型 | I：最终文本 hash、有效时间戳、内部元数据清理；绑定必须对应同一份发送消息，不可丢失或自行重算假时间 |
| 回复成功/取消的写回、数组非枚举 metadata | OneRing recordAIResponseFromMessages、ToolBox interactionCompletion | `preprocess` 返回 metadata，`response` 接收原 messages+metadata 与 completed/outcome | I：assistant 真正进入数据库；仅 preprocess 无法记录后续模型回复，调用方必须完成闭环 |
| OneRingMemo 数日压缩、递归合并、原子替换、上次完整摘要继续可用 | `OneRingMemo.js`；9.4 | `invoke oneringMemo.generateMemo/readMemo/updateMemoText` 与 `[[OneRingMemo::Agent]]` | I：独立模型桥生成/持久化/注入；**autoGenerate=false、model=''**，自动模式需配置并维持任务生命周期 |
| VCPTimeLine 月生成/一句话摘要/年月与 Agent 范围/持久化 | `VCPTimeLine.js`；9.5 | `invoke timeline.saveConfig/generateTimelines/generateSummaries/...` | I：原月度生成管线；**model=''**，生成前配置模型；不会假造没有的月份 |
| 时间线常驻月摘要 + 当前语义选中整月展开 | VCPTimeLine buildQueryContext/buildInjection，经 ContextBridge RiverMemo | `[[VCPTimeLine::Agent:K:threshold]]` | S：River 路由与整月展开；独立宿主须先初始化向量桥并同步时间线索引，不能仅返回摘要就声称语义展开已执行 |
| ContextFoldingV2：旧 assistant 按相似度折叠/恢复、异步摘要重试 | `ContextFoldingV2.js`、FoldingStore；5.4 | preprocess.options.folding；长驻 serve / 单次请求的任务排空 | Source 原异步模型保留；必须等待摘要任务落盘或明确返回待处理，不能退出时静默丢弃队列 |
| MemoryThinkingTray：思维/工具材料托盘搬移 | `Plugin/MemoryThinkingTray` | 默认预处理阶段，options.tray=false 可关 | S：托盘与真实顺序；不等于生成或读取模型私有思维 |
| 上下文角色语块切分、历史可信 system 边界 | `modules/roleDivider.js` | options.roleDivider | S：工具结果域隔离，角色禁用清理；显式启用，不擅自把用户文本升权 |
| 文本预算裁剪、Jev 辅助裁剪与保底位置规则 | `contextManager.js`、`jevContextPruner.js` | options.contextTokenLimit | S：不可删 system/特定系统 user/最近消息；是源字符成本估计，必须保留内容过大时允许超预算 |
| TVS/Toolbox 分段 foldProtocol、Jev 折叠过滤 | `foldProtocol.js`、toolboxManager、jevFoldFilter | prompt 变量展开 | S：原始折叠/Jev 测试；与会话 ContextFoldingV2 和 checkpoint 压缩是三种不同机制 |

## VCPChat 会话和模型请求上下文

| 能力 | 源码 | 独立入口 | 验证及宿主边界 |
|---|---|---|---|
| 原始完整历史、最后 checkpoint 后有效历史、DailyNote create/update 按序回放 | contextCompactionState/Prompts 与协议扫描 helper | session put/append/get；context inspect/effective/compaction-input | S/I：原文保留、版本替换、代码/回执不能被当工具执行 |
| 模型压缩报告、保真/未决事项审计与缺失回灌 | contextCompactionFidelity/Continuity/Service | context/session compact | S/I：报告不等于语义绝对无损；离线 response 仅为明确测试输入，不代表模型已调用 |
| 压缩 busy/cancel/超时/并发修改拒绝/持久 checkpoint 原子提交 | 同上及 chatHistoryMutationAuthority/Persistence | Node ContextService；session compact 文件宿主 | S/I：并发历史修改不能被过期结果覆盖；桌面 Flowlock/Stop UI 并不随 CLI 出现 |
| 自动阈值判断 | 源 shouldCompactContext（85%） | Node API；CLI context/session auto-compact | I：阈值动作、实际附件内容计入预算、持久化压缩；prepare不自动消费模型额度，auto-compact动作显式检查并按需压缩；不包含桌面Flowlock生命周期 |
| 侧聊冻结父快照、祖先链、独立分支历史、环/孤儿容错、结晶笔记 | sideChatSessionService、branch-tree、note-exporter | session fork/branch/crystallize；context branches | S/I：孙分支祖先不丢、源分支不跟随父后续编辑；不移植 Electron Tab/轨道可视化 |
| 群上下文最近 N 楼窗口 | Groupmodules/groupContextWindow | context group-window | S：边界和不修改原历史；群聊自动裁决/调度不在记忆模块中 |
| 单聊请求构造、AgentName、Tavern system/user/context 规则、元数据剥离 | singleChatRequestOrchestrator、tavernRulesEngine | context/session prepare | I：Tavern 顺序、checkpoint 边界、多模态 API 数组、准确 timestamp hash |
| HTML→Markdown、隐藏工具/思维链清理 | contextSanitizer，jsdom/turndown | prepare 的 sanitize 选项与 Node sanitizer | 原始 sanitizer 保留；不将文本过滤结果解释为知道或复现模型内部思维 |
| 附件实时内容、base64、多模态载荷、工作区占位符 | 源 orchestrator 的 getTextContent/getFileAsBase64/expandWorkspacePlaceholders 能力；原fileManager/PDF服务 | context/session prepare默认只读显式声明文件；Node仍可注入宿主能力 | I：实际文本/图片/音频、DOCX、PDF原Poppler回退、live引用、分支祖先附件和压缩输入。显式缺失文件报错，原不支持格式和降级写attachmentDiagnostics；工作区动态展开仍须相应宿主能力，不能虚构文件内容 |
| Agent/Tar/Var/SAR、多阶段递归、工具说明和动态工具注册表 | ToolBox messageProcessor 及其 managers | preprocess.options.variables/agents/staticPlaceholders；home 内 Agent/TVStxt/maps | S/I：角色限制、递归、去重、纯文本文件与多模态保留；不复制原 Agent 人格与私人 TVStxt |

## 可选离线整理与提供方

| 能力 | 来源 | 独立入口 | 实际边界 |
|---|---|---|---|
| DreamWave R1–R3 联想、时间层种子、模型叙事、独立梦日志、定时梦 | AgentDream/DreamWaveEngine；8.12 | tool AgentDream、invoke dream；配置 DREAM_AGENT_* | I：实际原 Wave/日志及受控模型；源 manifest 默认 `.block`，仅显式调用后独立宿主才加载；持续调度需要长驻进程与有效 agent 配置 |
| 梦中 consolidate/delete/insight 操作记录 | AgentDream _parseOperation | tool AgentDream 原操作 | 产生 pending_review 沙箱操作；**源 approveDreamOperation/rejectDreamOperation 本身返回 not_implemented**。审批后提交现实不属于已实现能力，不能以白皮书文字替代源码 |
| Magi 三角色多轮会议与异步结果回注 | MagiAgent；8.13 | tool MagiAgent，回调落盘，原 VCP_ASYNC_RESULT 变量 | I：三角色+总结、异步 drain、回注；默认可共用同一 CHAT_MODEL，MAGI_MODELS 可分配不同模型，不保证三种独立模型已配置 |
| 本地文本/图像统一向量空间、真实模型进程及回收 | WorldlineBox 原 session/owner；本项目独立本地适配 | embed；lib/local-embedding.cjs | R：中文语义排序、768D单位向量、红/蓝真实图像区分、文本→图像、鉴权与 task-prefix HTTP；无 hash/随机回退 |
| 本地音频/视频接口 | 同上、FFmpeg | CLI embed audio；Node typed audio/video methods | R：2秒16k PCM音频及红/蓝真实MP4均返回768D单位向量，视频内容控制cosine=0.950503；见 local-modalities-smoke.json。不是语音理解/长视频检索质量基准 |
| 聊天/文档/查询独立地址和凭据、OpenAI/Anthropic/Gemini 文本协议 | lib/providers.cjs，DSH 原设计参考 | CHAT_*、EMBEDDING_* 与本地模型双任务 URL | I：协议映射、凭据遮蔽、错误/取消/无自动重试；真实 DeepSeek/Anthropic/Gemini 实测须另列。OpenAI Responses/OAuth 专有协议未实现且显式拒绝 |
| 物理数据空间隔离、加锁、JSONL 常驻、备份、源码升级与机器 JSON | workspace/client/worker/CLI 适配层 | --home、serve、backup、runtime-upgrade | I：JSON 与锁；持续会话、搜索与聊天记忆应复用同一 owned lock；原码 hash 变化不会默默覆写已有数据 |

## 已确认的源能力边界

1. 白皮书 8.10 的“用户采纳/忽略→路径学习、查询频率→Tag 学习、习惯→自动建议词元组”是比现有可证调用链更强的描述。已核对几何重训练、Tag/语义组配置与传播，未找到足以证明三种反馈闭环均完成的独立端到端证据，**不将其列为已验收**。
2. AgentDream 审批/拒绝是当前源的明确 stub，不能通过原样迁移变成已工作的审批提交。
3. 日记、历史聊天、思维簇、语义词元组和 Agent 提示词是用户运行内容。全量源码迁移不等于复制原作者私人记忆或自动生成这些内容。
4. 分布式星型网络、完整插件服务器、情感系统、桌面渲染/办公/浏览器/音乐、心跳与群聊调度不随记忆模块启动。OneRing/分支/压缩的记忆计算保留；其 Electron UI、网络接线和外部生命周期由调用宿主负责。
5. 旧 TagMemo 独立 retrieval、旧 EPA/ResidualPyramid JS 和 legacy DeepMemo EXE 并非当前标准路径；明确退休/拒绝或使用当前原生链，才与当前源码一致。

## 测试证据与未完成验收

- 上游 ToolBox 67 文件：448 个测试，359 通过、0 失败、89 跳过。87 个跳过依赖未移植的无关第三方插件；2 个依赖单独实验 TDB validation 产物/旧基线。见 `UPSTREAM_TEST_REPORT.md` 与完整日志。
- VCPChat 原始与独立 context 断言覆盖完整历史、checkpoint、日记回放、并发、分支、Tavern、净化和时间 hash；中央 CDS/DeepMemo/TopicMemo 另有 `tests/chat-memory.test.cjs`。
- `tests/integration.test.cjs` 使用真实 Rust/SQLite/TriviumDB，模型向量来自明确的受控提供方；`runtime-advanced.test.cjs` 覆盖 OneRing/Memo、时间线、Magi、Dream 和变量。
- `tests/local-embedding.integration.test.cjs` 真实 CPU 模型测试已通过；`tests/rag-refresh.test.cjs` 原 system RAG 刷新和安全边界测试已通过。
- `reports/live-validation.json` 已记录真实 DeepSeek official Chat Completions 的 deepseek-flash 与本地 CPU Gemma 联调 12 步通过：独立初始化、真实聊天、原 DailyNote、本地向量→原生存储、限定范围 RiverMemo、OneRing 注入和完成写回、真实 OneRingMemo、真实 AIMemo+、同一长驻进程追加会话、原 CDS/DeepMemo。它是小型端到端连通验证，不是综合召回质量基准。
- `reports/local-modalities-smoke.json` 已记录实际 typed audio/video 推理和视频内容差异控制通过；音频样本是生成的正弦音，不是语言理解测试。
- 本地推理测试里的 norm/cosine 仅作测试断言，不进入 VCP 生产评分、候选排序或 CLI 记忆 score。诊断只可透传原引擎已返回字段，禁止构造新的综合分数或为了显示而重排结果。
- 所有修饰器组合、超大记忆量/持续多日负载、真实长期自动梦/自动 Memo、Anthropic/Gemini 远端服务，以及未提供服务凭据的 Rerank/Jev，均不能只凭上述测试宣称已完成效果验收。

最终独立全量测试日志与真实模型联调记录优先于本文中的阶段计数。审计发现的搜索范围/K、错误JSON、catalog可调用性、长驻进程锁、cwd隔离、时间线向量桥、异步折叠/Memo drain、冷库query-prefix、轮内RAG刷新和CLI附件宿主，均已在最终代码中补接；相关行为断言分别位于workspace/runtime-advanced/rag-refresh/context/telemetry测试。不能以文件出现替代这些断言的最终通过记录。

## 数据与独立性核查

运行库只使用本包相对路径和显式 home/配置；`lib/` 中未发现默认指向原 ToolBox/Chat/WorldlineBox 的绝对源路径。模型与原生引擎均已复制到目标，移走原项目不应影响正常运行。快照脚本记录源绝对路径用于溯源，这些路径不参与正常运行。

ToolBox 快照排除私有 config.env、原 dailynote/knowledge、Agent/TVStxt 内容、state/cache、SQLite、node_modules 与构建 target。唯一白名单 TVStxt 文件是 Git 跟踪且未修改的 413 字节公共 JEV 协议提示词；OneRingConfig/rag_params 为公共配置代码。Chat 快照未复制 AppData 或真实历史。WorldlineBox 只提取公共源码、清单和模型/运行时资源，未读取其用户库。新建的日记、模型密钥、缓存和工作区数据库属于运行空间，不属于源码快照。

## CLI 诊断的原始字段溯源

诊断适配只观察**同一次原始调用**，复制其已返回的数据和原顺序，不为诊断重跑查询、不计算新的候选分数、不改写候选 rank、不排序。原生返回、外部精排、最终 formatter 入参是不同阶段，分别保留；不能把阶段中的字段混成新的“综合分”。

| 原字段 | 原始生产者 | 含义与输出约束 |
|---|---|---|
| vectorScore | Rust `light_memo.rs` 原件向量 cosine | 直接复制源数值；不是从 Markdown 百分比反算，不做额外归一化 |
| score / hybridScore（KNN） | 同上 | 源 KNN 路径把原件 vectorScore 复制到这两个字段；诊断不另外赋值 |
| score / baseScore / topologyBonus / anchorBonus / originalScore | Rust `rivermemo_topology_v3.rs` 的 NativeResultItem | 原生最终分、基础分、拓扑/锚点奖励及原候选分；LightMemo 将源 score 复制为 hybridScore 是原代码自身行为 |
| rank / role / omega / riverRegime / matchedTags / coreTagsMatched / candidateSources | 同上 | 原生阶段的顺序、角色、可观测性、匹配与来源；后续 Rerank 改变候选排列时仍保留源 rank，不假称该 rank 是最终数组位置 |
| topologyV3 / relativeTopology / geometry / observables | 同上，只有源 includeTrace=true 时输出 | 诊断显式开启原生序列化开关，在 diagnosticOptions 记录原值与观测值；不改变评分参数，不推导缺失分量。真实同一原生计划的开关对照测试验证分数与排名相同 |
| bm25Score、diagnostics.bm25Mode | Rust `light_memo.rs` | LightMemo 是候选内子串词频证据，模式为 candidate-substring-tf-v1，不等于全库倒排 BM25；字段可能只是原初始化0，不能仅凭字段存在宣称实际计分发生 |
| rerank_score / rerank_failed / jev_score / rrf_score / retrieval_rank / rerank_rank | 原 LightMemo/RAG 外部精排和源 RRF 路径 | 原样保留；观察到方法被调用不等于服务成功。不能把回退分数标成真实 Rerank，不能用 formatter 显示分替代原 rrf_score 排序依据 |
| diagnostics.scopeChunks/candidateCount/synchronizedRows/databaseGeneration/ffiTrips/totalMs | Rust `light_memo.rs` | 范围和候选数、同步事实代际、原生FFI及耗时；totalMs 为源 Instant.elapsed；不按比例拆出不存在的阶段时间 |
| river.diagnostics.loadMs/computeMs/totalMs、*Candidates、*SqlBatches、rayonThreads、artifactNodes/Edges | Rust `rivermemo_topology_v3.rs` | 原生阶段时间、候选和SQL批次；嵌套时间可以互相包含，不相加成新的引擎时间 |
| formatter 最终 candidates 有序入参、AIMemo 前 results | 原 LightMemo formatResults / _summarizeWithAIMemo | 复制源最终有序候选；AIMemo 可能直接返回模型摘要，不触发 formatter，因此前总结阶段单独注明，不冒充最终用户文本 |

`hostTiming` 若存在，属于适配器在原调用边界用 performance.now 观察的包含性墙钟时间，必须标注 reportedBy=standalone-host，与原生 diagnostics 时间分开。hook_observed 只能说明捕获到调用，不能代替原输入开关、原降级原因或精排成功证据。密钥、向量大数组和 base64 媒体可以在诊断副本中遮蔽；生产返回对象必须保持不变。

独立审阅了 `lib/telemetry.cjs`。诊断回归包含原方法只调用一次、返回原对象/原串，native→KB标准化→formatter的score字段逐项精确相同、原候选顺序不变、原生时间不被host时间替代、关闭诊断时原结果不变；真实Rust的KNN和RiverMemo以及原生解释开关对照均有测试。最终计数见 `docs/VALIDATION.md`。
