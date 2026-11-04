# VCPToolBox 真实代码审计

日期：2026-11-02。基准是本机源树；旧文档不能替代代码。

## 必须保留的能力与源代码

| 能力 | 权威实现 |
|---|---|
| 热记忆权威存储、增量摄取、Rust watcher 稳定事件/代际、迁移向量复用、删除、索引发布/恢复/卸载、外部写入协调、标签一致性 | `KnowledgeBaseManager.js`、`modules/knowledgeBase/*`、`rust-vexus-lite/` |
| TagMemo V9 全上下文感应/传播、V10 原生控制面、RiverMemo Topology V3/Ω 泛函与共同观测 | `TagMemoEngine.js`、`TagMemoV10Engine.js`、`RiverMemoEngine.js`、`modules/tagmemoV10/*`、Rust 全部 crates/src |
| Embedding 分批、Token 分块、重试/备用模型、去重 | `EmbeddingUtils.js`、`TextChunker.js`、`ResultDeduplicator.js` |
| 四种日记占位符、聚合检索、动态 K、角色阀、Time/Group/TagMemo/RiverMemo/BM25/BM25+/Rerank/Jev/TimeDecay/Truncate/Expand/Associate/Base64Memo/AIMemo | `Plugin/RAGDiaryPlugin/*`（不仅主文件） |
| 净化/上下文历史向量、缓存、FoldingStore、元思考链、语义组、AIMemo 与预设 | RAG 插件各同名模块、配置/提示词模板 |
| 日记创建/更新队列与索引协调 | `Plugin/DailyNote/dailynote.js`；不可用简化文件写入替代 |
| 日期范围列出、整合后归档、联想关联 | `Plugin/DailyNoteManager/`、`modules/associativeDiscovery.js` |
| 主动回忆、原生 KNN/RiverMemo、四轨实验室、冷库、AIMemo/Jev | `Plugin/LightMemo/*` |
| 低成本全文/模糊/BM25 预筛 | `Plugin/DailyNoteSearcher/` 的 JS 服务及 Rust 二进制/源码 |
| 冷知识库可靠摄取队列、TriviumDB、图/向量/文本/混合检索、TQL、压缩与卸载 | `TDBKnowledge.js`、`Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor.js`、npm `triviumdb` |
| 跨端近期原始消息、时间戳绑定、Only/Post/重试幂等/响应完成与取消、模糊 Worker 池、短期摘要 | `Plugin/OneRing/` 全部当前 JS、`OneRingConfig.json` |
| 月级时间线生成、摘要、保存、展开 | `Plugin/VCPTimeLine/VCPTimeLine.js` |
| 上下文动态折叠、Jev 级联筛选/预算裁剪、托盘搬移 | `Plugin/ContextFoldingV2/`、`Plugin/MemoryThinkingTray/`、`modules/contextManager.js`、`modules/jevContextPruner.js`、`modules/jevFoldFilter.js` |
| Agent/TVS/Toolbox/SAR 静态上下文、折叠协议 | `modules/messageProcessor.js` 及其纯上下文依赖 |
| 语义组编辑 CLI | `Plugin/SemanticGroupEditor/`（原入口无条件 main，需子进程 stdio 调用） |
| 可选离线梦与三模型会议 | `Plugin/AgentDream/`、`Plugin/MagiAgent/` |

历史聊天 DeepMemo、TopicMemo 在 VCPChat，必须单独移植，不能因 ToolBox 无实现而遗漏。

## 与旧文档的重大差异

- `docs/MEMORY_SYSTEM.md` 的 EPA/ResidualPyramid/JS better-sqlite3 热库描述已经过时；根 `EPAModule.js`、`ResidualPyramid.js` 已不存在。当前热库由 Rust `NativeKnowledgeRuntime` 持有 SQLite，TDB-SM 检索内核与 Rust 同编译。
- `docs/VCP记忆管理系统.md` 与当前代码较接近，列出 OneRing、冷知识库、VCPTimeLine 等完整边界；`Plugin/RAGDiaryPlugin/README.md` 含旧名字和旧 Worker 架构，不能照搬承诺。
- LightMemo 默认 RiverMemo，纯向量 `knn` 仍可用；退休 TagMemo 模式会明确拒绝。占位符管线仍保留 TagMemo，与 RiverMemo 互斥。
- AgentDream 有完整实现但 manifest 默认 `.block`。只把源码复制过去不代表已配置模型或应默认开启调度。
- 根 AGENTS 说“无正式测试”，但当前 `tests/` 已有大量 Node 测试。应读取并选择真实相关测试；`npm test` 本身仍是占位。

## 独立宿主必须补齐的契约

1. 在首次 require 前设置根路径、模型与维数环境变量，因多个模块在导入时捕获配置。每个 home 用独立进程和可写运行镜像，防止 singleton/环境串库。
2. 注入 `knowledgeBaseManager/vectorDBManager`、`tdbKnowledgeManager`、`jevClient`、RAG 的 `getContextBridge()`、`getAIMemoBridge()`、`getSingleEmbeddingCached()` 和本地事件回调。
3. 原始次序先 OneRing，再 ContextFoldingV2；保留消息数组非枚举 `__oneRingMeta`，并在响应完成或失败时调用 OneRing 的响应收尾方法。仅调用预处理会丢失 assistant 记忆。
4. OneRingMemo/VCPTimeLine/AgentDream 硬编码访问本机 `/v1/chat/completions`，需轻量 loopback 模型桥；MagiAgent 直读 root/plugin config.env，并直接访问 API_URL。
5. `AgentDream` 动态 require `Plugin.js` 仅取事件接口，可在独立进程 require.cache 提供 memory-only host；不可拉起完整插件服务器。
6. CLI sync 必须显式排空摄取和删除队列并验证每文件完整向量回执。仅等待 watcher 安静会漏掉刚写入文件。
7. `DailyNoteSearcher` 含原生常驻端口，独立 home 并行时必须选不同端口；stdio 编辑器要禁用 shell。

## 依赖与验证边界

核心 npm：`@dqbd/tiktoken`、`@node-rs/jieba`、`axios`、`better-sqlite3`（OneRing/FoldingStore/冷库元数据）、`chokidar`、`dayjs`、`dotenv`、`mime-types`、`node-fetch`、`https-proxy-agent`、`chinese-lunar-calendar`、`triviumdb`；messageProcessor 闭包另需其导入依赖。

Rust：必须保留 Cargo.lock、`crates/vcp-tdb-index` 和完整 src，不应只拷贝薄 JS loader。`.node` 必须与当前 JS 原生 ABI 配套，否则 watcher/native-query 会失败。

有意义的验证：真实 Rust+SQLite 的创建→同步→KNN/RiverMemo→重启→更新→删除；所有占位符和多模态保留；OneRing 响应/取消闭环；冷库真实 TriviumDB 摄取；可控服务实测外部 embedding/rerank/Jev/summary 协议。确定性测试向量只能证明执行完整性，不能证明生产语义质量、召回率或远端模型表现。

源项目运行数据与真实密钥均不在迁移快照内。自动修复/归档行为先只在隔离数据中验证。
