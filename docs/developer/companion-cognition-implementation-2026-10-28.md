# 伙伴认知重构当前状态

2026 年 10 月 29 日的重构交付核对见[交付说明](companion-cognition-delivery-2026-10-29.md)。下文原验证表保留其时点，不能作为 10 月 30 日性能修复后的最终构建收据。用户此前取消的两小时运行、耐久／大规模真实事件灌入及多轮真实模型成长测试不再续跑；本轮新增授权为真实当前伙伴的短时延迟、并发、主动／被动回忆验收，以及完成后的 Windows 打包和代码推送。

## 2026 年 10 月 30 日任务上下文与延迟修复

- 每条新收到的聊天消息各自进入真实任务队列，在任务开始时封存一次世界、角色状态与时间快照，执行一次相关记忆召回及聊天滑动窗口装配。同一任务的工具继续、重试与持久恢复复用已封存内容；新任务重新读取。时间、天气、属性与活动进度更新不修改记忆索引，也不触发整段上下文重建。
- 按用户本轮最后确认的架构，所有伙伴推理入口不提供 `memory`／`memory.*` 或个人经历回顾能力；每个任务只消费系统自动召回的结果，不在工具循环中自主补搜。后台记忆捕获、人格成长、灵魂学习与来源撤回保留原正式链路，记忆板的用户主动／被动回忆与管理入口继续使用内部 API。旧保存策略兼容读取，但不能重新开启伙伴记忆工具。
- 人格、灵魂学习与成长仍通过正式来源和发布链路生效。当前任务保持开始时的版本，下一任务采用新版本；来源撤回、访问权限变化与正式文件损坏仍在发送前阻止使用。
- 一次准备中的重复来源、准确记忆修订及登记信息共用有限核验窗口，窗口在发送前结束。正式文件继续读取并核对字节，窗口结束前重新检查当前登记和授权；下一任务重新核验，不把进程内缓存当作长期授权。
- 状态进度通知使用轻量状态入口，不读取人格、历史动作或完整认知正文。实际消息、完成状态和内容变化继续触发完整界面刷新。取消信号贯穿准备、文件检查和模型请求，结束后释放身体及优先级占用。
- 每条伙伴回复保留实际处理累计耗时，并支持秒、分钟、小时、天、月和年。排队、暂停与离线时间不计入实际处理；旧消息没有记录时明确显示未记录，不用消息显示时间推算。
- 真实延迟测试对用户库做 SQLite 在线备份并复制正式文件和原生缓存，使用原伙伴历史与正式主执行链路；原库不写入。并发测试中的“大肥鱼”仅在隔离副本内创建。诊断区分原生检索、宿主来源核验、上下文装配与实际模型首字时间，冷启动建索引另列。实际时延、最终 ASAR 功能、安装包与导航收据见下方冻结版本小节，不沿用旧包结果。

10 月 31 日的界面优化保留已有 React Activity 页面驻留与聊天分页：首批 50 条、渲染窗口最多 200 条／100 万字符，近期会话缓存最多 8 个；可见动作按实际消息中的 ID 精确查询，正在执行的动作另有界补充。15 个可选伙伴面板、浏览器的附属面板和富文本依赖按需加载；纯文字聊天先走轻量渲染。隐藏的人格、记忆、作息与认识面板停止读取和订阅，恢复时重新核验；普通进度通知不再清空正文缓存或重查文档、政策。真实内容或权限通知仍立即清除旧正文并重新读取，同修订号不能冒充新授权。

伙伴首次导航另有明确的安全初始化屏障：先完成账本、生命周期中断、删除恢复、当前人格待发布事务和来源撤回；会话概览、聊天分页与话题列表随后可用。聊天正文仍经过原有实时来源／文件／权限围栏。历史传输审计、成长作业恢复和日程设施继续完成，所有模型、工具、写请求、详细档案及默认 `state` 入口仍等待完整执行初始化。真实导航验收分别记录自动化操作上界、实际 DOM 点击到内容就绪，以及点击伙伴模块到首条真实消息就绪；不把后一次点击前的自动化等待伪装成产品提速。

后续真实并发诊断还定位到独立的工具续轮问题，不能把它归因于 Rust 检索：某条普通伙伴来信在初始已有 7 条引用、5052 字回忆后，又执行了 9 次搜索和 1 次阅读，始终没有提交最终提案，也没有最终提案被拒绝。10 次模型响应共 22.099 秒，工具主执步骤共 77.933 秒；整个同时运行队列的记忆 API 时间上界为 15.696 秒，因此至少 62.237 秒位于工具 API 之外的本地来源围栏和读集处理。逐条保存／读取推理日志与工具前后捕获，会反复验证累计来源闭包；它与每任务只召回一次不是同一问题。另每次约 91 KB 的原始检索回执把候选正文、格式器正文和界面诊断重复送入模型，导致输入从 28.8K 增至 121.5K tokens。社交宿主合同明确当前来信是唯一任务，已有资料充分即可交付；旧已保存工具回执的兼容模型投影只保留原版格式器正文、候选目录和准确分页信息，不提示伙伴再次调用记忆工具，完整回执及来源证据仍原样留在宿主。此段是问题定位与对应改动记录，最终并发是否通过仍以修复后的独立验收为准。

续轮主执现将同一次准备、推理日志保存和工具前后读集捕获纳入有限宿主核验窗口；每次实际 HTTP 或工具效果执行前，仍重新完成正式文件字节、SQL 来源和当前授权的最终围栏，然后关闭窗口。工具返回后的材料进入新窗口，权限证明不跨实际发送复用。模型输入投影、输入量估算与步骤压缩采用同一份实际发送视图，宿主保留完整原始回执。最终围栏由传输层在 `beforeDispatch` 后等待完成，成功后才调用 fetch 并登记已发送；若拒绝，记录为 `cancelled_before_send`，不出现零 HTTP 却标为已发送的凭证。

上述窗口及传输边界此前冻结版本的四文件定向回归 **89／89 通过**，包括真实 SQLite 权限变更、同大小同修改时间的文件篡改、持久意图保存后撤回、取消与修复子请求的发送状态；见[宿主窗口回归](../../tests/worker/companion-structured-agent-host-gate.test.ts)、[实际请求快照回归](../../tests/unit/companion-context-snapshots.test.ts)、[结构化主执](../../tests/unit/companion-structured-agent.test.ts)和[步骤内核](../../tests/unit/companion-agent-kernel.test.ts)。该轮完整 TypeScript 检查退出 0，全仓 lint 为 0 error、7 项既有 warning；不能把它当作后续所有改动的末版静态收据。该定向数量与其他记录存在重叠，不相加计总数；该较早节点的工程回归和静态检查不能替代真实模型并发验收，后续真实结果见下方冻结版本小节。

读取该失败任务保存的 24 份实际模型请求还发现：宿主提示要求调用最终提交通道，但能力策略把该控制工具从实际声明中移除了，模型只看见记忆与等待工具。现已保留宿主真实注册的最终交付控制，不受行动能力开关误删，仍执行原领域格式、来源和权限核验。新增测试直接核对五种提供方的实际请求工具清单，不能靠模拟返回未声明工具蒙混通过。随后按用户最新要求彻底移除伙伴自主记忆与个人经历回顾工具，所有任务相关回忆只由系统初始自动准备；旧配置仅兼容读取，不重新开放工具。

后续[真实并发原因诊断](../../artifacts/memory-latency-20261030/full-respond-benchmark/post-ui-batch-cause-concurrent-result.json)进一步把发送前等待定位到传输审计：暖轮前四次 `contextSnapshots.prepareAttempt` 的墙钟分别为 7.238、8.937、4.379、5.220 秒。这些值包含 owner 串行队列等待，不能相加成独立 CPU 或检索耗时。源码中，每次准备都会扫描最多 24 条近期请求状态以阻止未知结果自动重发，旧实现对每条分别开启登记读取和来源核验窗口；审计虽然已正确脱离模型输入 ledger，却也失去了同批历史共同依赖的复用。这是宿主记录链路的实际热点，不能称为 Rust 搜索慢或另一轮记忆召回。

本次[审计 journal 窄修](../../src/main/companions/context-snapshots.ts)保留 detached 隔离与 unknown 防重发：在 journal 内将近期索引、状态元数据批量查询和全部准确正文读取纳入一个独立只读有限窗口，结束前仍执行真实登记、文件字节和来源的最终围栏；窗口结束后才清理旧记录、发布新快照及更新索引。结果结算也先在共同只读窗口读取 body 与 state，再按原准确修订 CAS 发布新状态，不把读改写整个包入不可变窗口。两个旧状态共用依赖的实际 SQLite 回归中，扫描与结算各为一次引用准入、两侧 fresh final 引用核验；正文仍实际打开，未改为元数据展示或长期缓存。

同一 owner 串行准备还复用刚完成最终围栏的索引作为本次 CAS 基线，消除扫描后、发布前后的重复索引读取；实际退役过旧记录则重新读取准确新索引。预留一格后才提交新记录，故成功发布后不再无条件重复清理。真实索引竞争写入仍由原修订与文件字节 CAS 拒绝，未减少 unknown 状态扫描；这些调用次数变化不是未经测量的端到端提速结论。

[模型传输准备](../../src/main/companions/model.ts)现在把临时取消信号传到审计准备，不保存到快照、schema 或 provider 正文。尚未开始的 owner 排队项可以立即取消并跳过后续工作；已开始的只读扫描可中止，写前再次检查取消。一旦耐久发布开始，仍完成原事务，不用全 journal 的取消竞速遗留半份准备记录；后续结算独立于已取消的信号，仍能如实记为 `cancelled_before_send`。准备期取消返回 `CANCELLED`，生命周期结算为 `cancelled_before_send, 0`，不会误报成上下文容量不足或已发送。该轮[快照回归](../../tests/unit/companion-context-snapshots.test.ts)与[宿主窗口回归](../../tests/worker/companion-structured-agent-host-gate.test.ts)同轮 **54／54 通过**：覆盖批次 SQL 次数、调用者 ledger 隔离、写后不自失效、同 stat 字节篡改、准确依赖撤回、状态 CAS、未知发送恢复，以及真实模型入口阻塞扫描时取消后零 HTTP、零新增准备记录、后继任务正常完成。相关三文件 lint 退出 0；该数量与此前 89 项重叠，不相加，该较早节点仍需独立验证修后真实时延和最终构建；后续收据见下方冻结版本小节，不由这54项机制结果推定。

传输审计窄修后的[真实并发记录](../../artifacts/memory-latency-20261030/full-respond-benchmark/journal-final-concurrent-result.json)仍显示准备期未达预期：暖轮最后一个目标首次发出前，记录了 221 次 `memory.contextValid` 和 314 次经 Main 来源准入的 `memory.records.filter`。这些是多任务与界面并行的累计计数，耗时不可相加。[随后单聊分段诊断](../../artifacts/memory-latency-20261030/full-respond-benchmark/journal-segments-single-result.json)把重复定位到正式库的 `current` 读取和文件验证：读取 note 后又经 guarded row 准入，递归展开该 note 来源消息的历史执行读集。现代 `fileReceiptOnly` 已进入有限 SQL 凭证窗口，却仍通过 `ports.validate()` 回到这条完整链路；不能把它笼统归为旧格式回退、人格拼接、世界状态变化或又一次语义召回。

新增强路径只接受同一当前 Worker proof 的准确读集摘要和合法撤回 epoch，并重新核对完整读集摘要；`complete` 必须为真，每个文件凭证必须由**本条 proof** 的 `memoryReads` 或 `frozenMemories` 精确覆盖 note ID、正文修订与完整原始来源集合，不拼接多份弱证明。内部凭证在本次 context 回调结束后立即失效，模型、工具 JSON 和持久记录不能制造它。只有当前 SQL 正文仍为同一修订、来源全集也一致时，文件验证的权威元数据读取才使用 raw SQL 端口，避免再次把同一派生 DAG 当作新模型输入准入；原外层完整 DAG、实时行动授权、初末 SQL current/history 围栏和 Registry 正文／原始来源的真实字节检查全部保留。弱证明、缺覆盖、无撤回 epoch、历史正文和当前修订变化继续走原完整路径；强弱缓存及不同捕获来源完全分域，成功不能从强路径提升给弱上下文，合法旧正文仍可经完整历史路径使用。

这次[准确文件强路径回归](../../tests/unit/companion-memory-attested-files.test.ts)与[执行读集](../../tests/unit/companion-execution-evidence.test.ts)、[正式文件验证](../../tests/unit/companion-memory-live-validation.test.ts)、[来源闭包](../../tests/unit/companion-source-execution-evidence.test.ts)同轮 **86／86 通过**，包括 18 项新增的真实 SQLite／正式 Registry／实际文件正负场景：覆盖不足与错绑拒用强路径、旧摘要缺 epoch、强弱已完成及在途隔离、凭证过期／伪造、跨 gate 和同 gate 最终围栏的正文及原来源改写、来源撤回，以及普通修订后独立合法旧正文的完整历史回退。相关八文件定向 lint 与 diff-check 通过；此数量不与此前回归相加，不是整仓最终静态收据，也不证明真实聊天端到端已经提速。该节点的最终时延须由包含 `memoryFilesAttestedValid` 实际命中次数的独立真实单聊、并发及取消记录确认；后续结果见下方冻结版本小节，不用这86项机制结果替代实测。

VCP 对比限定于[本项目锁定的上游版本](../../vendor/vcp-memory/upstream-manifest.json)与对应配置。[LightMemo](../../vendor/vcp-memory/Plugin/LightMemo/nativeQuery.js)和普通被动 RAG 的原生检索不等于必经一次聊天模型；显式 AIMemo／AIMemo+ 则是上游已有的可选模型聚焦分支，含自己的缓存与模型调用，不能宣称 VCP 完全没有模型处理环节。当前默认路径只在明确 `focus: true` 时进入该分支；本轮无额外模型调用的实测不涵盖所有高级模式。Rust 查询阶段的毫秒指标也不包含编码器冷加载、索引迁移、正式文件与授权检查、传输审计或提供方响应，不能外推为整个伙伴回复的毫秒承诺。移植中需消除重复核验和无关准备，保留本应用的来源、隐私和耐久发送凭证。

### 10 月 31 日记忆板主动／被动回忆实测

以下为 10 月 31 日伙伴改用系统自动召回、记忆文件批量核验及记忆页有限读取窗口落地后、**本次 journal 窄修之前**，对用户记忆板内部入口完成的一轮真实 Main、SQLite UtilityProcess、原生 VCP/Rust 与已检测 Vulkan1 编码器结果，不是下文 10 月 28 日历史收据，也不冒充新 journal 代码的实测。查询与记忆板按钮一致：`memory.recall.test`、话题“早上好”、`limit: 8`，不传额外检索选项或聊天历史。每种模式先启动隔离副本，正常关闭后在**同一目录**重新启动；不重新复制或删除缓存。首次点击在实际空闲准备完成后计时，启动成本单列。探针 Main 编译入口 SHA-256 为 `c52a964dddb1972f536ce672a4a500f22a07e4c01dfbd6bc2f22074db8c4807f`，worker 为 `128151e7d8d098bb0a314b3837d8de6b664a601b4a85f57d78eb16b49cb17f2c`；这不是安装包或其他测试入口的构建指纹。

| 模式 | 首次点击（空闲准备后） | 随后暖查询 | 同目录重启后首次 | 重启后暖查询 |
| --- | ---: | ---: | ---: | ---: |
| 主动回忆 | 3.521 秒 | 0.713 秒 | 3.383 秒 | 0.815 秒 |
| 被动回忆 | 0.932 秒 | 0.773 秒 | 0.882 秒 | 0.812 秒 |

Main 初始化与空闲准备合计：主动首次副本 17.576 秒、同目录重启 5.524 秒；被动分别为 7.022 秒和 5.523 秒。首个主动进程的启动较慢，既有指标记录原生 `prepare` 6.212 秒、投影同步 3.269 秒及原生初始化 2.236 秒，保留本次值而不重跑挑选较快启动。每个进程只有一次物理编码器准备，加载耗时约 2.60–3.65 秒。副本首次迁移确实同步 10 篇正文；同目录重启则为 **10 篇复用、0 篇更新、查询前 0 次文档向量化**。查询期间没有再次执行原生 `prepare`；主动模式首次点击还需打开本次前八项结果的独立原生上下文视图，所以不把首次点击宣传成全程毫秒级。

本轮暖主动原生搜索约 29–33 毫秒，原生片段整理约 28–34 毫秒；暖被动实际 `prepare-recall` 约 11 毫秒。上表按钮总耗时还包含正式正文、来源与授权核验，不能用这些原生阶段数字代替总延迟。四个进程均实际检索 10 篇获权文档，主动／被动分别返回 8／7 条一致引用，无降级、无额外聊天模型调用、无生成模型准入；正常关闭后原生进程、排队、连接池及引用计数全部归零。真实学习资产适配器照常核验，原库授权条目为零，因此没有把本轮测速写成用户学习历史实测。父页面的实际状态／进度刷新参与运行；连续点击后立即清掉旧结果，本轮不宣称覆盖结果展示后的权限轮询。

证据见[本轮四进程完整对照](../../artifacts/memory-latency-20261030/memory-probe-benchmark/post-ui-batch-final-comparison.json)，各进程的阶段、引用、缓存迁移和退出资源记录随同保留；[自动召回初版](../../artifacts/memory-latency-20261030/memory-probe-benchmark/final-automatic-recall-default-chain-comparison.json)、[此前一轮](../../artifacts/memory-latency-20261030/memory-probe-benchmark/final-current-default-chain-comparison.json)及[更早一轮](../../artifacts/memory-latency-20261030/memory-probe-benchmark/idle-core-final-verified-comparison.json)保留各自源码指纹和实测，不冒充当前结果。复现入口为[真实记忆板测速脚本](../../scripts/benchmark-companion-memory-probe.mjs)，仅对指定库建立只读备份及临时副本，不修改原库：

```powershell
$env:WORLDLINEBOX_PROBE_LABEL = 'local-memory-probe'
node scripts/benchmark-companion-memory-probe.mjs "<伙伴资产库根目录>"
```

### 2026-10-31 最后冻结版本的真实短测

本轮 `release-verified` 使用同一实际用户库的只读在线备份、正式 Main／Utility Process、原生 VCP 与本机编码器，并调用原已配置的真实模型。该轮原生短测的生产源码摘要为 `ec15bf37a22eed288732cee6f94ad8706d284e197d8765aa5d769d049ea7d318`；汇总见[最终真实短测记录](../../artifacts/memory-latency-20261030/final-validation-summary-v2.json)。测试记录位于本地忽略目录 `artifacts/memory-latency-20261030/`，不将私人聊天、凭据或副本提交仓库。

| 实际场景 | 本轮测量 |
| --- | --- |
| 单聊旧聊天事实问答 | 首次请求发出 6.782 秒，热轮 3.991 秒；对应首次正文流增量 8.293／4.743 秒，完整任务 10.785／7.013 秒。冷、热回复都命中原聊天的正确数量 91。 |
| 两条用户消息＋双向伙伴聊天 | 冷、热共 8 个目标任务全部完成；每批最后一个目标请求于 11.486／11.815 秒发出，最后一个目标任务于 15.836／27.748 秒完成。自然产生的后继伙伴对话也结算，不能把其全部时长当作单条上下文准备。 |
| 准备中的真实取消 | 正常 `reply.cancel` 确认 140 毫秒，任务结算 142 毫秒；身体／优先级占用均由 1 回到 0，原目标未发模型请求，随后独立新消息正常完成。取消预期的 `AbortError` 单列，不当作未处理失败。 |
| 记态板主动回忆 | 新进程首次查询 3.094 秒、热查询 0.540 秒；同一副本保留索引重启后 2.846／0.563 秒。8 条引用，未降级。 |
| 记态板被动回忆 | 首次／热查询 0.656／0.615 秒；同一副本重启后 0.691／0.609 秒。7 条引用，未降级。 |

所有已派发宿主任务的系统自动召回均为一次，每任务仅一次被动查询，实际提供给伙伴的记忆工具声明为零。记态板四个原生进程没有生成模型调用，资源清理均完成，原库均未写入。引用归属与来源一致，结果仍明确带有索引待处理标记（`pending=true`），不冒充全部后台索引已经完成。记态板的首次查询是在正式初始化及空闲预热后触发；初始化总时长 5.088–6.537 秒，已包含 3.403–4.643 秒的空闲预热，不能把这项一次性成本藏进热查询结果，也不能把 Rust 的向量检索时间当作整个宿主链路时间。

四路并发仍有约 12 秒到全部目标请求发出的尾延迟，热轮全部目标任务完成仍需约 28 秒，本轮不宣称任意并发都可瞬时准备。实际查询、来源／文件核验、辅助世界评估及模型网络分别计时；重叠方法时间不可相加为墙钟。界面秒开需要下面的新安装包独立导航验收，不能由这份 Main 基准替代。三场真实 Main 短测前后原有 64 项可用执行记录和 13 项已索引记忆均保持可用，没有新增执行失效记录。

最终强路径及按文件批复用的五文件聚焦集 **98／98 通过**：`companion-memory-attested-files`、`companion-execution-evidence`、`companion-memory-live-validation`、`companion-source-execution-evidence`、`companion-source-validation-cancellation`。真实 Store 证明覆盖 `[a,b]→[a,c]` 仅新增 `c`、不同入口各自 SQL 准入、原始来源集合隔离、失效租约、取消、正常历史回退及最终字节／来源篡改拒绝。该轮工具记录为 session `35531`、输出 chunk `a5ccec`，不与较早的 86 项或其他重叠回归相加。

封版验收发现统一日程迁移遗漏了故障作业入口，已在“系统事件”补回按需打开的正式管理入口。默认及隐藏时不挂载故障浏览器、不读取作业，关闭或隐藏后旧请求不能覆盖新页面，返回重新读取；对应入口、原日程与故障分页控制三文件聚焦集 **41／41 通过**，保留每页 20 条及有界 60 条显示窗口。Main 培养来源的 `revision` 严格投影另有 **9／9 通过**；仅按实际培养来源形状投影字段，完整来源版本校验、归属与权限核验没有放松。这两轮各自记录范围，不与上述 98 项相加。

随后补回档案“正在成长”中的来源驱动培养方向管理，沿用正式 `growth.goals` 接口，和日程计划分别管理。新组件 11 项及原档案 14 项的同轮聚焦集 **25／25 通过**：提出、暂停、结束均需真实反馈和准确修订；暂停时调整定义不会恢复练习，已结束方向保持只读，当前人格不允许直接编辑。只读查看不调用 `conversation.open`，避免自身变更通知反复触发读取；无私聊时，只有明确打开私聊的操作才建立范围，重新核对后才接受反馈。隐藏、切换伙伴、完整来源变更及手动核对被拒时，均清除旧来源表单或拒绝晚回包；进度通知不重读。测试还覆盖真实打开会话和提交反馈同步触发变更通知的情况，未用静默通知替代正式生命周期。这 25 项不与前述重叠集相加。

隔离开发应用的完整四项功能预验 **4／4 通过**，耗时约 2.2 分钟，输入漂移为 0；[预验收据](../../artifacts/memory-latency-20261030/dev-preflight-normal-window/result.json)明确记录 `isPackaged=false`。这份结果只证明开发应用功能，不代替 ASAR、安装包、导航时延或原用户资料验收。

v3 的生产输入冻结摘要为 `1f9758d82a3b18cb7591ae635572a711f6b6bb83dcc61446ace38e80cceb2fb3`。与上述原生短测的 `ec15bf37…` 输入逐文件比对，仅 `CompanionCognitionDossier.tsx` 和 `CompanionGrowthGoals.tsx` 两个 renderer 文件不同，Main、Worker 及后端字节不变，因此上表仍是相应原生处理链的有效证据，但不冒充最终 ASAR 的同轮原生测速。

最新 ASAR 的完整四项功能验收 **4／4 通过**，耗时约 2.0 分钟，见[最终包内报告](../../artifacts/cognition-validation/packaged/20261030T234717Z-8872/report.json)。ASAR SHA-256 为 `04c6b28ac520cdb914afe77c5dc79f78c4b91337b014814bddab4a0c178813e4`，包内 Worker SHA-256 为 `2ad8aae29062addc407dd9a3c07e50a5a7d18404ce3ee2ea15913c87c85628b9`。这是最终包内功能结果，和前述 `isPackaged=false` 开发预验分别记录；验收没有安装或覆盖用户正在使用的版本。

同一 ASAR 对真实用户库隔离副本的七个界面分别执行首次访问和返回访问，**14／14 均在实际 DOM 点击后 5 秒内显示真实内容**。该副本有 22 条实际聊天消息、52 篇记忆文档；未用模拟正文代替。用例耗时 27.7 秒并正常退出，Main 共 48 次请求、错误 0，页面错误 0。证据见[完整导航结果](../../artifacts/memory-latency-20261030/final-packaged-navigation/navigation-result.json)、[独立首条真实消息结果](../../artifacts/memory-latency-20261030/final-packaged-navigation/first-real-message-result.json)及[证据摘要](../../artifacts/memory-latency-20261030/final-packaged-navigation/evidence-summary.json)，原始[运行日志](../../artifacts/memory-latency-20261030/delivery-final-navigation.log)保留。

| 界面 | 首次访问（秒） | 返回访问（秒） |
| --- | ---: | ---: |
| 资产管理 | 3.487 | 0.199 |
| 浏览器 | 0.771 | 0.049 |
| 伙伴入口 | 3.584 | 0.052 |
| 消息子页 | 0.230 | 0.017 |
| 联系人 | 0.040 | 0.024 |
| 记忆 | 1.713 | 0.113 |
| 人格档案 | 0.357 | 0.859 |

独立测量的“点击伙伴入口→首条真实消息就绪”为首次 **3.785 秒**、返回 **0.016 秒**，不能用消息子页的 0.230／0.017 秒替代完整首入时间。上表的首次访问指新应用进程内第一次访问该页，磁盘和库缓存仍保留；计时从首个实际 DOM 点击开始。资产首次访问从自动化操作起点计为 **5.452 秒**，应用进程启动到资产首屏为 **6.986 秒**，因此不宣称整个应用启动在 5 秒内完成。两次空闲观察实际均未产生 progress 或 full 通知，不能用这轮导航证明进度通知风暴已经覆盖；该行为由独立机制测试核验。这是当前真实库规模的导航结果，不外推任意历史规模、任意并发负载或长期无限聊天吞吐。

正式打包脚本 `powershell -File scripts/windows.ps1 -Action Installer` 退出 0，Inno 成功编译耗时 734.968 秒，见[官方打包日志](../../artifacts/memory-latency-20261030/delivery-final-official-installer.log)。已生成[Windows 安装包](../../out/make/inno/WorldlineBoxSetup.exe)，大小 **1,232,241,332 字节**，SHA-256 为 `58da6c24b7d0bd5bcac6d8b4bd5ee91c4b5883b1a4f4833f9f49e9e797908e7e`。`release:checksums`、原生依赖重建及 FTS5 检查均退出 0，生成的[校验清单](../../out/make/SHA256SUMS-win32-x64.txt)记录同一安装包摘要。生成和验收均未安装或覆盖用户版本，真实原库未写入；代码远程提交状态以实际推送回执为准，不由打包成功推定。

实施依据为已同步调整验证范围的[主规范](companion-cognition-refactor-standard-2026-10-28.md)与[验收附录](companion-cognition-acceptance-2026-10-28.md)。失败、修复和逐门证据由[证据审计](companion-cognition-acceptance-evidence-audit-2026-10-28.md)及原始 artifacts 保留。[后续人格因果方案](companion-persona-causal-followup-plan-2026-10-29.md)已撤销，不能把未执行试验或用户取消的长测记成通过。

## 当前实现

- **身份和人格生命周期**：创建时绑定固定 UUID、操作凭据及请求哈希，起点正式封存后才可运行。创建后的用户界面与公开接口不再直接编辑人格、指导或认知正文。`profile.md` 是当前正式人格；起点只承担来源和核验职责。失败续建沿用原创建凭据，退役后的再次添加必须使用新身份。
- **类型和存储职责**：新协议拒绝旧维护库与旧运行回退。SQLite 保存类型、权限、版本、依赖与发布事务元数据，文件保存正式认知正文；目录、附件路径或 SQL 副本不能代替正式准入和文件核验。经历、知识、方法、本人认识、导航和虚构梦境分道，来源→历史→当前正文经过耐久发布队列。
- **学习与人格演化**：捕获先保留有真实作者及证据的经历、知识或方法；独立反思读取已正式存在的记忆，提出有条件的本人认识；人格整合再独立核验并发布局部变化。同批未提交候选不能冒充已读依赖。培养方向保留语境、练习、反馈与反例，可暂停或结束，不等于用户直接改人格；`no_input`、`no_change` 都是合法结果。
- **当前处境与关系**：使用带来源、事项、适用范围和重新评估条件的定性记录。PAD、好感／信任／尊重分数以及按交流次数推进的人格阶段已退出生产行为消费；精力等客观世界资源仍保留工程数值。
- **推理和结构修复**：按用途编译当前人格、相关资料和实际读取，保持上下文有界。结构化输出至多使用两次全局模型修复，仅修语法／形状；来源、权限、版本及语义资格失败不交给修复。原始非空集合、正文、来源证据和明确语义值不能被修成空、伪造或改写来取得通过；已确认工具效果不自动重放。
- **故障治理与历史整理**：11 类实际作业已接持久状态、精确租约、逐项分页、幂等控制及累计失败计数。每个周期三次真实处理失败后搁置；等待、取消和来源失效不计质量失败，明确放弃不删除原事件，也不标成整理成功。新消息和普通唤醒不洗掉搁置或放弃。未完成发布按真实对象、路径及对称读写依赖持久预留；无关请求可以继续，准确恢复不依赖全伙伴前16条记录。占用作为typed等待传播，真实外改继续拒绝。
- **话题后台欠账**：前台使用当前合法检查点和有界近期原文，不等待积压摘要或摘要锁。后台逐块让出，固定领取时的创建序号／正式发布双水位；在任何相关模型前绑定实际前缀及检查点，发送与发布继续核验。检查点依赖使用增量元数据索引及可失效的读取凭据，不在每个作业中复制历史闭包。普通来源失效会按耐久游标自动核对剩余合法来源；暂停范围让出队头，无合法来源时结束该处理但保留原事件。用户搁置、放弃和未知发送结果不会因此自动恢复。
- **文件发布与前台隔离**：普通回忆只纳入已正式发布的类型化固定视图，再检查真实文件。准确修订读取仅准备自己的已有依赖作业，不等待整个伙伴目录的后续发布。已保存但文件待发布的写入返回原 ID、修订与明确待处理状态；不能当作未保存而重复记录，也不能当作已可召回。后台连续处理积压，搁置及放弃保持原样，损坏的已提交正文仍严格拒绝。
- **隐私与恢复**：撤回按准确来源版本、依赖、登记路径和哈希清理派生产物、错误回执、人格片段及请求快照，不退回旧模板或复活旧正文。退役统一停止并逐批清理受管数据与凭据。备份恢复使用包外单调权威，旧包不能覆盖新撤回；恢复后的待运行和待重核任务保持搁置、伙伴休眠，须完成核对并明确恢复。
- **请求与界面**：实际快照保存最终 provider 正文、工具／图片传输及发送状态，区分当前预览和具体任务。只读认知档案展示当前人格、分类记忆、本人认识、关系、培养方向、发布、起点、实际请求与故障处理；运行连接、形象和活动开关独立维护。
- **已取消产品额度**：日／分钟／次数／输入量／输出量／费用额度、预算设置及对应 SQL 账本已移除。工程并发公平、上下文容量与有限修复次数仍生效；来源和租约检查使用无金额／无额度计数的发送生命周期门。

## 用户运行资料

已完成一次授权的受管开发资料清理及生产空库初始化，之后不再直接操作该真实库。清理只处理核验清单内的旧伙伴账本和 5 个精确文件，保留全局连接、玩家资料及无关资产。清理当时的新库伙伴、消息、会话、记忆和登记发布均为 0，玩家资料哈希保持；这是当次收据，不是对后续用户操作状态的推测。依据：[清理执行](../../artifacts/cognition-validation/companion-cleanup-executed-v3-2026-10-28.txt)、[初始化前核验](../../artifacts/cognition-validation/actual-cleanup-verified-before-initialization-2026-10-28.json)、[生产空库核验](../../artifacts/cognition-validation/actual-empty-production-store-verification-2026-10-28.json)。此前功能验收使用隔离合成临时库；本轮用户实际上下文短测及导航验收只使用上述真实资料的隔离副本。

## 当前验证

每份记录只覆盖其运行时的源码及夹具。下面的广集、定向集、旧构建和真实模型试验存在时点差异与用例重叠，**不能相加或拼成同一轮全绿**。确定性提供方响应验证工程合同，不等于真实模型长期人格质量。

### 工程回归和构建

| 范围 | 当前可确认结果 | 证据与仍有的限制 |
| --- | --- | --- |
| 较广单元集 | v6：221 个文件、2589 项通过 | [原始 JSON](../../artifacts/cognition-validation/companion-unit-final-v6.json)、[起止指纹](../../artifacts/cognition-validation/companion-unit-final-v6-process.json)。该轮源码及夹具指纹一致，排除两份耗时 Main 文件；早于本次文件发布与前台隔离修复。 |
| Worker 广集 | v2：165 个文件、1371 项通过 | [原始 JSON](../../artifacts/cognition-validation/companion-worker-final-v2.json)、[进程收据](../../artifacts/cognition-validation/companion-worker-final-v2-process.json)。记录明确保留运行期间整体指纹变化；变化发生于未被本轮引用的新专用人格夹具，不能冒称全部文件冻结。原 v1 的四项失败及分批后续仍保留。本轮早于本次文件发布修复。 |
| Main两文件 | 同一当前生产下，主服务163/163与记忆73/73分批通过 | [真实对账](../../artifacts/cognition-validation/current-main-coverage-reconciliation-v16.json)、[完整记忆复验](../../artifacts/cognition-validation/memory-service-followup-v16.json)。两个运行的生产及共用夹具字节一致；主服务文件未改，唯一记忆测试文件按正式发布及真实Native回执准备数据，原权限、全文、分页和重试断言保留。原[v15完整233/236](../../artifacts/cognition-validation/main-and-memory-background-v15.json)和三项失败保留，**不重命名成同一轮全绿**；原15／30秒门未变。 |
| 追加话题与控制 | 压缩单元 17、界面单元 14、作业核心 20、独立实际后台 22 分别通过 | [17 项](../../artifacts/cognition-validation/topic-maintenance-source-window-unit-v1.txt)、[14 项](../../artifacts/cognition-validation/cognition-effect-lifecycle-ui-v2.txt)、[20 项](../../artifacts/cognition-validation/topic-auto-reconcile-window-final.txt)、[22 项](../../artifacts/cognition-validation/owner-topic-background-acceptance-v18.txt)。覆盖双水位、精确实际读集、发布事务内旧租约拒绝、非尾／尾来源撤回后无新消息继续整理及保留原文；不是另一轮广集。 |
| 文件准备及发布隔离追加 | 文件域78、Registry22、准确周期及完整聊天34分别通过 | [证据E28/E29](companion-cognition-acceptance-evidence-audit-2026-10-28.md)。包括134 owner轮转、重启不等无关发布、正式文件及Native准入、坏prepared包不挡无关聊天、模型HTTP0等待、17个无关包不遮挡准确恢复。各轮范围与冻结不同，不相加计总数；完整Main后续结果另列；本轮不再启动完整打包或长测。 |
| 备份恢复追加 | 四组 34 项通过 | [恢复记录](../../artifacts/cognition-validation/recovery-dirty-checkpoint-final-v1.txt)。覆盖依赖缓存、旧包撤回屏障与 peer 隔离；新增 dirty hold／明确恢复的存储边界也在上述作业核心独立验证，最后构建仍需完整复核。 |
| 最终包内功能与交付 | v3 ASAR 四项4/4、实际导航14/14、官方Installer成功生成 | [同轮包内报告](../../artifacts/cognition-validation/packaged/20261030T234717Z-8872/report.json)、[实际导航](../../artifacts/memory-latency-20261030/final-packaged-navigation/navigation-result.json)、[官方打包日志](../../artifacts/memory-latency-20261030/delivery-final-official-installer.log)。冻结输入 `1f9758d8…`，ASAR `04c6b28a…`，Installer `58da6c24…`；完整摘要、分段时延及规模边界见上方冻结版本小节。未安装或覆盖用户版本，不将包内功能通过当作实际安装或任意规模秒开。 |
| 历史包装应用 | ASAR attempt 5：构建、资源校验及四项真实 E2E 全部通过 | [全流水线收据](../../artifacts/cognition-validation/current-asar-attempt5-pipeline-status.json)、[同轮4/4报告](../../artifacts/cognition-validation/packaged/20261028T223134Z-40800/report.json)、[末源码比对](../../artifacts/cognition-validation/current-asar-attempt5-source-comparison-final.json)。1830项生产输入在构建及验收后保持不变，包含本次文件与发布隔离；真实包内worker、isPackaged、隔离profile、宽窄深浅、实际HTTP及缺DB恢复均同包核验。ASAR `67f3fc3c1a13be4b5a269fbbde102f8caf000239ce5bc0f19082fd9419619371`。包4及更早成功／取消收据独立保留，不替代本轮，这是该冻结版本的历史结果；后续长测已按用户要求撤销。 |
| 历史静态检查 | 记忆夹具更新后，完整 TypeScript、全仓 lint 均退出0 | [该轮完整静态收据](../../artifacts/cognition-validation/current-asar-static-after-main15-pipeline-status.json)、[起止指纹](../../artifacts/cognition-validation/static-before-static-after-main15-final-end.json)。3559个生产／测试输入起止一致，保留7项既有无关warning。[该轮静态生产清单](../../artifacts/cognition-validation/current-asar-production-source-freeze-v7-static.json)的1830项生产digest与[包5清单v6](../../artifacts/cognition-validation/current-asar-production-source-freeze-v6.json)相同，因此没有伪造重建或用旧包覆盖新生产代码。 |

早期文件发布、来源／权限、创建退役、知识学习、真实 UtilityProcess、目录／索引与恢复的证据，以及旧失败后的对应定向结果，保留在[逐门审计](companion-cognition-acceptance-evidence-audit-2026-10-28.md)和[Worker 失败后续映射](../../artifacts/cognition-validation/companion-worker-broad-followup-evidence.md)。本文不重复列出已被后续完整结果取代的“最新版本”叙述，也不删除历史失败。

### 真实模型与规模边界

| 范围 | 已观察结果 | 允许的结论 |
| --- | --- | --- |
| 知识学习 | v4-native 使用 23 次真实 HTTP，两轮学习、固定四题 4/4 | [原始报告](../../artifacts/cognition-validation/knowledge-heldout-real-v4-native.json)。实际获权材料、正式知识、原生编码／召回、准确正文及独立新题请求的小型合成正例；不能外推任意知识或人格质量。 |
| 人格发布 | v6 使用 22 次真实 HTTP，完成三条经历、两条有条件本人认识、正式人格发布与新版实际请求；结果为 `insufficient_evidence` | [原始报告](../../artifacts/cognition-validation/persona-causal-real-v6-native-phase-separation.json)。A／B／C 都达到通用行为 rubric，未证明发布带来额外行为增益。不得把发布管线成功改称自然人格、人类学习曲线或长期成长通过；后续预登记夹具 v2 未执行真实模型，现已按用户要求撤销。 |
| 两小时基线 | 100 位正式 owner、3 位活跃 owner 的旧冻结版本实际通过 | [两小时收据](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v1-summary.json)。实际任务区间 7,219,977 ms，6 项任务完成、12 次压缩、97 位闲置 owner 无 native 请求；后加后台 lane／读集／发布 guard 不在该冻结中，不能称当前最终版本已通过两小时。 |
| T035 实际事件规模 | **1k／10k／100k 整门尚未通过** | [v4 原始失败](../../artifacts/cognition-validation/cognition-event-scale-v4.json)。v5 到达真实 Main／native，1k 阶段通过、10k 录入途中因已确认的文件发布阻塞主动取消；[准确停止收据](../../artifacts/cognition-validation/cognition-event-scale-v5-background-producer8.stop-receipt.json) 与原始记录保留。取消不算通过或完整失败；后续v6在原30分钟观察门超时，100k未完成；v7计划已撤销，不再重跑。 |
| 多 producer 并行准备 | 小型集成 4 项通过、1 项 opt-in 跳过 | [准备收据](../../artifacts/cognition-validation/owner-scale-producer-eight-integrated-contract.txt)。通过最多八个在途请求逐条调用真实消息入口，保留每条提交回执；尚不能代替真实规模、长期运行或提供方吞吐结论。 |

登记与删除的十万级工程测试仍有独立价值，但与 T035 不同：[100,042 登记对象的元数据测试](../../artifacts/cognition-validation/owner-scale-canonical-final.txt) 没有十万份正文；此前十万消息＋有来源笔记的分批退役证明清理与 peer 哈希守恒，不证明长时推理或人格语义。二者不能用于填补实际 T035 或最终两小时缺口。

## 当前收束方式

1. **按改动选择短检查**：保留类型、权限、来源、发布事务、失败搁置／放弃、队列公平和恢复的现有短机制测试；入口为 `npm run test:companion:quick`，必要时只选择受影响用例。不自动重跑全部广集或完整打包流水线。
2. **已完成的最后恢复与历史修复**：222文件回归v7确实出现2599通过、1失败，暴露已保存人格提议在元数据提交失败后被记为stale、启动恢复却只找generated的问题；三文件38项及类型检查通过的[v13窄修](../../artifacts/cognition-validation/growth-publication-startup-freeze-v13.json)保留原记录。随后核对又确认最新8项会被无关stale挤满，最终改为准确pending writer索引及唯一检查点，保持来源／撤回／搁置门并按owner隔离恢复错误；[最终7项短门](../../artifacts/cognition-validation/growth-exact-pending-writer-freeze-v16.json)通过，30.52秒。成长历史补齐准确分页及撤回epoch，修复只显示最近20条；[最终16项短检查](../../artifacts/cognition-validation/growth-history-pagination-short-freeze-2026-10-29.json)通过，4.18秒。包5早于这些修复，不能改称包5包含它们。
3. **长测已撤销**：T035 v6实际1k和10k阶段完成，但100k阶段在原30分钟观察门超时；85423条成功返回事件凭据经独立哈希核对，原始临时DB未保全，不能声称完整SQL守恒或100k通过。v7未启动计划撤销。T036 v2按用户要求取消，已有现场与数据保留，取消不是失败或两小时通过。[取消收据](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v2.cancel-request-2026-10-29T00-42/stop-receipt.json)。
4. **保留结论边界**：现有知识为小型合成正例；人格已有有据发布和实际采用的证据，额外因果增益仍不足。不再等待新长实验，也不把短机制结果宣传为复现人类学习曲线。下一步开发按已发现问题和短检查收束。

真实开发库清理已经完成，不重复操作真实库。取消长测并未代替开发收束：最后准确人格恢复、错误按owner隔离和成长历史分页均已修复；[完整类型检查及稳定输入核对](../../artifacts/cognition-validation/final-cognition-source-delivery-verification-2026-10-29.json)通过。交付边界、已有实测及研究效果的限制保留在交付说明，不把未验证质量或旧安装包标为已验证的新版本。
