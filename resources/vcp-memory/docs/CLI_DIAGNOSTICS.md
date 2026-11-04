# CLI 分数与耗时的来源

诊断只观察本次原 VCP 调用，既不额外检索，也不重新计算、归一化、四舍五入或排序任何分数。评分、召回参数和原函数返回对象保持原样。诊断由独立宿主保存副本，不修改 `upstream/`；唯一开启的源诊断选项是下述 `includeTrace`。

Node 客户端可以使用 `request(operation, payload, { home, withTelemetry: true })` 获取 `{ result, telemetry }`；不启用时仍返回原来的 `result`。JSONL 协议使用请求顶层 `diagnostics: true`。CLI 默认显示诊断，开关以 `vcp-memory --help` 为准。

## 三种数据必须分开看

| 字段 | 含义 |
|---|---|
| `telemetry.vcp.spans[].raw` | 对应源函数当次返回数据的快照；原生 JSON 字符串会被解析为 JSON 对象，分数字段和数组顺序不变 |
| `telemetry.vcp.spans[].input.candidates` | 对应源函数被调用时的候选数组快照，包括重排前或格式化前的数据；不是重新检索结果 |
| `telemetry.vcp.spans[].hostTiming.durationMs` | 独立宿主使用 `performance.now()` 测量的本次 JS 方法边界墙钟耗时；包含内部调用、等待和编排，不能当作原生内部阶段耗时 |

宿主方法会嵌套，因此耗时会重叠，不能把所有 span 相加当作总耗时。`parentId` 表示实际异步调用关系；`id` 的顺序是调用开始顺序。源对象中未出现的内部阶段耗时保持缺失，绝不按比例拆分 `totalMs`。运行中尚未完成的任务会显示 `status: running`、`durationMs: null`。重复 `finishTrace()` 会重新读取同一请求的快照，供一次性 CLI 关闭前排空后台摘要后补充结果；下一次 `startTrace()` 建立新的请求记录。

## 原生分数与诊断

`native.lightmemo` 来自 `rust-vexus-lite/src/light_memo.rs` 的原生执行结果。保留原来的 `results`、`tdbTopK`、`comparisonPool`、`river`、`diagnostics`。

- `vectorScore` 是原实现计算的余弦值，可能为负；宿主不截断。
- KNN 的 `score`、`hybridScore` 按源实现复制自 `vectorScore`。
- `bm25Score` 按源实现返回。LightMemo 的 `candidate-substring-tf-v1` 表示候选池内子串词频证据，不能称为全库 BM25 倒排召回。候选初始化时也可能带有零值字段，单凭字段出现不能声称稀疏评分已执行。
- RiverMemo 的 `score`、`baseScore`、`topologyBonus`、`anchorBonus`、`omega`、`rank`、`role`、`riverRegime`、`originalScore` 和 `riverMemo` 等均直接来自源实现。
- `river.diagnostics.loadMs`、`computeMs`、`totalMs`，以及 LightMemo 的 `diagnostics.totalMs` 是原 Rust 计时器报告的数据，和宿主 `hostTiming` 分开保留。
- `topologyV3`、`relativeTopology`、`geometry`、`observables` 由原生 `includeTrace` 序列化分支提供。仅在诊断开启时，宿主克隆合法 JSON 计划并设置这个源已有开关，不修改调用方对象、评分配置、检索范围或 K。Rust 在评分与排序结束后才用该开关决定是否返回解释字段，缺失字段仍不推导补齐。`span.input` 保存原始计划，`span.diagnosticOptions` 明确保存字段原值、是否原本存在、实际观测值及其序列化用途。

`knowledge.lightmemo` 是 `KnowledgeBaseManager.executeLightMemoQuery` 对同一个原生结果作原有路径/label 标准化后返回的副本。它和 `native.lightmemo` 是同一次检索的两个边界，不能计作两次召回。

## 重排与最终顺序

`lightmemo.rerank` / `rag.rerank` 与 `lightmemo.jev` / `rag.jev` 的 `input.candidates` 保留原始输入顺序，`raw` 保留原函数输出顺序和字段。`rerank_score`、`jev_score`、`rrf_score`、`retrieval_rank`、`rerank_rank`、`rerank_failed` 若存在则原样显示。

`lightmemo.final-candidates` 在原 `formatResults` 被调用前记录最终有序候选。此处的数组顺序才是交给格式化器的顺序；候选内部的 `rank` 仍可能是较早原生阶段的排名，宿主不会覆盖为所谓“最终排名”。原格式化器显示的百分比可能是其选择的单项分数，不能反解析为原始综合分数，尤其不能替代 RRF 顺序。

当 AIMemo 成功时，原实现可能在格式化前直接返回模型摘要；`lightmemo.pre-aimemo-candidates` 保存送入摘要器的真实最终候选。最终摘要文字由原模型链生成，不是数值评分。

`availability.status: hook_observed` 只表示这个函数边界被调用，不表示算法成功生效；未配置的重排、失败回退或空候选也可能经过该函数。应检查原请求选项、原 diagnostics 和候选评分字段。`disabled` 仅用于已观察到原查询明确关闭的机制，例如 KNN 关闭 RiverMemo、`useBm25: false`；没有观察到调用时使用 `not_observed`，数据为 `null`，不会冒充零分或零毫秒。

## 其他阶段与负载

日记入库、删除、索引加载、纯文本/BM25 引入、插件预处理、冷知识库检索都有对应源方法边界。没有源诊断返回值的阶段只提供宿主边界耗时，`raw: null`。

诊断会省略 embedding 向量、二进制和 Base64 媒体，并遮蔽已知凭据字段。候选文本、路径、标签、原分数和顺序可用于本地排查，因此诊断报告本身也是记忆工作区的数据。诊断观察与复制需要时间，会影响墙钟测量；原始算法和排名保持不变。

验证位于 `tests/telemetry.test.cjs`：精确比较原始分数与数组顺序、验证只调用一次源函数、保留返回对象引用、关闭诊断不捕获，以及使用真实 Rust/SQLite 的 KNN 和 RiverMemo 调用比对 N-API、KB、最终格式化前的同一批数据。另用同一库、同一查询、同一候选、同一观测句柄分别执行原生 `includeTrace: false/true`，严格比较每个候选的全部评分字段与排名完全相等，并检查解释字段确实由原 Rust 分支增加。测试也验证无效 N-API 入参不会因诊断被修正成有效参数，诊断准备失败不会增加新的源异常。

## DeepMemo / TopicMemo 的独立源系列

纯聊天回查不启动热记忆向量运行时，诊断放在 `telemetry.chat`，`family: vcpchat-cds`。`cds.searchMemories` 保存原 CDS 返回的 `owner`、`windows`、`formattedResult`；`windows[].score` 是原 Rust/Tantivy 窗口得分，`startOrdinal`、`endOrdinal`、消息与窗口数组顺序全部原样保留。`cds.searchMessages` 保存原消息命中得分。`cds.reconcile`、`cds.flush`、`cds.status` 保存原返回值，只有方法边界提供宿主墙钟计时；原服务没有返回内部搜索分阶段耗时，因此不补 `computeMs` 或类似数字。

DeepMemo 启用外部 Rerank 时，`deepmemo.external-rerank-http` 在原私有 `rerankWindows` 发出的同一次 Axios 请求处记录原 documents 顺序和原 HTTP response 的 `relevance_score`，不重新发送请求、不计算跨批得分、不覆写 CDS 的窗口得分。原源码的 `rerankWindows` 只改变窗口顺序，并不把外部分数附到窗口对象；它的最终窗口数组也未通过导出接口暴露。所以 `sourceLimitations.postRerankWindows` 明确为 `null`，不能根据最终 Markdown 倒推分数或伪造一个新数组。

TopicMemo 按原实现完整读取和格式化指定话题，没有评分算法，只有 `chat-host._topicMemo` 边界耗时。不能为它创造相关性分数。`tests/chat-memory.test.cjs` 通过原 CDS 可执行文件和真实 HTTP 协议验证开启/关闭诊断得到相同 DeepMemo 结果，源窗口顺序/分数不变，以及诊断没有增加检索或 Rerank 请求。
