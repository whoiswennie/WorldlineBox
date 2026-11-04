# Super Agent 伙伴系统完成度审计

更新日期：**2026-11-03**。保留原文件名以保持既有链接。本文取代 11 月 2 日的待修缺口表；历史通过与失败记录仍保留。

> **11月3日最终检查点，优先于下方历史记录。** 当前主脑已经改为 WorldlineBox 自有 App Agent，DSH只执行委派任务。当前相关单测436通过、6跳过；最终同包功能5项与软／硬件性能2项均通过，成品及完整资源校验已完成。下方274项、旧DSH主脑台词／耗时、旧包及清理数量是历史证据。当前指纹、实测边界和13个自动审批拒绝清理目标统一见[当前实现报告](companion-superagent-current-2026-11-03.md)。

本轮来源对照见 [上下文工程说明](companion-context-engineering-2026-11-03.md)、[VCP 原始存储与生命周期审计](../../artifacts/superagent-bot-development/vcp-storage-lifecycle-audit.json)、[官方白皮书核对](../../artifacts/superagent-bot-development/vcp-whitepaper-review-2026-11-03.json)。白皮书目标、原型已实现功能和本产品实际接线分别记录；没有宣称 AgentDream 或数月连续运行已经验收。

当前整套相关回归：**436项通过、6项 opt-in 跳过**，主／扩展 TypeScript 通过。App主脑真实14位功能联调 **14/14通过**：普通对话、原话回查与真实表情、单一DSH文件任务及结果16均有回执，日常互动及后台记忆不调用DSH。[真实App全链](../../artifacts/superagent-bot-development/companions-app-real-acceptance/result.json)、[逐人语义与阶段耗时](../../artifacts/superagent-bot-development/companions-app-real-acceptance/semantic-review.json)。三位普通续聊复测随后3/3功能通过，热轮约1.11–1.39秒；初始HTTP503及一次83.619秒上游异常仍保留，不能承诺所有回复都在1–2秒内结束，也不能以功能标记认证人格自然度。[复测语义与时延](../../artifacts/superagent-bot-development/companions-app-conversation-acceptance/semantic-review.json)、[503原始回执](../../artifacts/superagent-bot-development/companions-app-conversation-acceptance/initial-http503-result.json)。

延迟需分开看：首位新域准备10.60s，后13位新域普通对话中位6.107s（其中准备4.441s、模型1.594s）；同域下一轮回忆准备中位267.1ms，多工具完整回复仍需数秒。冷初始化不是每轮召回，首字也不是完整回复。独立受控 VCP＋App 被动回忆热样本总计约1.22s，但不能宣称所有对话都在1–2s完成。本轮14位时部分并跑单测，不是隔离性能基准。

随后模型接口恢复，三位普通连续对话复测 **3/3 功能通过**，同域热回复总耗时分别 **1.114s、1.385s、1.270s**，准备约178–243ms，DSH Host／worker 调用均为0；原503失败回执仍保留。[普通续聊实测与复核](../../artifacts/superagent-bot-development/companions-app-conversation-acceptance/semantic-review.json)。GPT首轮同时出现83.619s异常等待，其中模型／流阶段74.353s，不能用热样本掩盖上游延迟。措辞也仍有边界：咕嘎一条“有没有不想我碰的”继续暗示现实触碰能力，因此功能通过不等于所有表达均已完善。

## 历史检查点：11月3日上午

最新结论（11月3日上午追踪）：共享默认 Host、聊天耗时和阶段、FTS5 记录弹窗、表情原文件名与搜索、圆形头像的成品验收通过。最新 **274 项单测通过 / 6 跳过，5 项成品 Electron E2E 通过（56.1s）**，完整 TypeScript、定向 ESLint、package / postPackage 和正式配置启动核对通过。14位真实模型三类流程为 **13/14 完整通过**；Doro 一次回查发图连接失败如实保留。语义复核发现能力暗示、重复确认及日志口吻，不能把功能流程通过当作所有人物自然度达标。

当前总回执见[追踪验收](../../artifacts/superagent-bot-development/chat-followup-acceptance.json)，逐人台词质量与耗时见[14位伙伴实测报告](companion-ai-quality-2026-11-03.md)。下列原生异常与有限样本限制继续保留；这不是数月运行或任意模型质量的保证。后文原236项/4项成品表格保留为上一交付检查点，最新数字以本段和追踪回执为准。

## 上午追踪的实测边界

- 成品正式配置只运行默认“我的 DSH”；旧伙伴专用实例保持停止。14位联系人、VCP原生查询与加密配置前后不变均已核对。[正式配置回执](../../artifacts/superagent-bot-development/chat-followup-production-bootstrap.json)。此次默认 Host 冷准备119.024秒，仍需优化，不能宣称冷启动秒开。
- 较早的正式主应用4条真实寒暄验证同Host复用与停止后同实例/home重启：首次50.784秒、热回复1.084秒、另一伙伴首次5.686秒、停止后再请求16.414秒；4条实际inbox均只claim一次。测试器确实向正式聊天新增了4条“你好”，与上一检查点零提交的只读启动不同。[真实复用回执](../../artifacts/superagent-bot-development/shared-default-real-acceptance.json)。
- 14位批测使用同一deepseek-flash连接、真实DSH和内置768维向量。独立 Host 冷准备128.906秒、向量预热2.546秒，首位大肥鱼对话另为45.413秒，其余普通回复6.636–8.038秒。不能把45.413秒全部归因VCP。14个实际文件任务均完成并发送内容为数字16的文件；一轮样例不代表长线人格稳定性。
- 最新界面保留原文件名意义和搜索：缩略图下方短名、悬停完整原名/说明、工具列表originalName，底部搜索按钮按需展开；没有以美观为由删除功能。聊天参与者头像统一圆形。[明亮表情面板](../../artifacts/superagent-bot-development/ui/stickers-panel-light.png)。
- 原4个临时目标重试仍被自动审批在执行前以blocked by policy拒绝；本轮冷启动探针另有1个目录及3个生成文件同样保留，合计8个目标，未绕过删除。新的14位批测2个owned根已正常清理，取消打包scratch检查时已不存在。见[重试记录](../../artifacts/superagent-bot-development/temp-cleanup-retry-2026-11-03.json)、[探针拒绝记录](../../artifacts/superagent-bot-development/dsh-cold-probe-cleanup-rejection.json)、[取消打包清理核对](../../artifacts/superagent-bot-development/canceled-package-cleanup-2026-11-03.json)。

## 已有证据与完成边界

| 要求 | 当前证据 | 结论 |
| --- | --- | --- |
| 替换旧主脑、聊天与资产库记忆入口 | 新 Main / Preload / Renderer 入口；[运行依赖审计](superagent-bot-runtime-dependency-audit-2026-11-02.md)；[旧数据清理复核](../../artifacts/superagent-bot-development/legacy-reset-d10b7c8fc721cde7/post-verification.json) | 已替换，无旧运行时 fallback。旧 4 个精确目标、locator、2,133 条旧 linked asset 索引清理完成；无关资产库、模型与 DSH 保留。 |
| 原生主脑、独立 worker 与持续会话 | [真实模型全链](../../artifacts/superagent-bot-development/real-acceptance/result.json)、[原生可靠性](../../artifacts/superagent-bot-development/native-reliability.json) | DSH 0.2.1-rc.5 原生 loop、稳定 event / task / lane、实际任务产物、冷恢复与去重已通过。用户聊天会话 ID 不随内部原生代际变化。 |
| 多来源持久调度、群聊与恢复 | 236 项单测中的 service / prepared / scheduler / task 回归；真实全链 peerChat；[重复冷恢复](../../artifacts/superagent-bot-development/native-repeat-recovery.json) | 用户、伙伴、群聊、世界与任务通知已有入口。群聊迟到回复按 publication journal 入上下文，未知原生投递复用冻结 prepared 输入，不放宽 input hash；5 次原生冷恢复未重复原始输入。 |
| 有界活动上下文与交接 | [原生可靠性](../../artifacts/superagent-bot-development/native-reliability.json)、[取消恢复](../../artifacts/superagent-bot-development/native-cancel-recovery.json)、真实全链 retention | 已验证原生压缩 / handoff、消费证明、取消后冷重放、最多 16 个驻留 lane。正式模型压力夹具把阈值设为 3 turn，达到 epoch 3 且保持同一 UI 会话；不能称为默认 128 turn 阈值的长期 soak。 |
| 原文封存与长期回查 | [原文规模报告](superagent-bot-memory-scale-2026-11-02.md)、history-projection / retention 回归 | 连续 publication 游标、队列公平与 handoff 前耐久原文 barrier 已接通。barrier 不等待编码 LLM 或全量语义索引；单个 episode 原文有界，已验证跨 episode 与迟到低 UI sequence 回复。 |
| 独立 VCP、原算法与内置向量 | staging / native ABI 门禁；[运行依赖审计](superagent-bot-runtime-dependency-audit-2026-11-02.md)；真实全链 embedding | 453 源文件、405 个原始文件哈希及 246 生产依赖闭包通过，Node 24.15 / ABI 137；实际使用内置 EmbeddingGemma2 compact 768 维，无第二套模型权重。managed 配置启用独立 local embedding 会在创建 Worker 前显式拒绝。 |
| 自动记忆与真实依据 | 真实全链 memoryModel / capture | 正式模型实际调用 memory_search，有成功工具回执；自动 capture 作业、来源 ID 与自身索引回执确认，保留“晚上喝茶 / 早上咖啡 / 非全天禁咖啡”。已超过“答案出现关键词”的弱验收，但仍只是有限案例。 |
| 写入未确认、删除与派生撤回 | native recovery / source-withdrawal 回归；[撤回同步说明](superagent-bot-memory-source-withdrawal-2026-11-03.md) | DailyNote 已创建而 ledger 未确认的窗口可按稳定 ID / 正文证明恢复；冲突不误删。SQL 派生 C/D 的撤回同步到 VCP 日记、episode、CDS、OneRing 与 prepared；pending 时查询关闭，实际进程退出后冷修复通过。 |
| 任务问答、未知效果与后台进程 | [原生 worker I/O](../../artifacts/superagent-bot-development/native-worker-io.json)、[原生子任务](../../artifacts/superagent-bot-development/native-descendants.json)、task 回归 | 用户问题 / 答案、指导、冷恢复、宿主效果 gate、确定失败和 unknown 区分已覆盖；后台完成等待实际产物，取消 / suspend 的本任务及子任务 PID 已退出。没有把无回执的句柄认作停止证明，也未承诺任意 shell 副作用恰好一次。 |
| 来源预算、参与策略与并发 | service / activity-budget / scheduler 单测；原生多 lane 与子任务报告 | 持久预算、按来源准入、群参与门控、同域 FIFO / 跨域并发、因果 hop 上限已有覆盖；不是全平台、所有负载组合的容量保证。 |
| 长聊天 UI 与原静态人物 / 世界素材 | [源码 E2E](../../artifacts/superagent-bot-development/ui-source-e2e.log)、UI 组件回归 | 有界 400 条窗口、分页 / 搜索 / 锚点、任务交互、联系人 / 聊天 tab、浮动输入框与 rail 提示修复已接；原 Three 房间 / 公园资源保留。人物静态设定不再被当作“形象模式”功能或 API。 |
| 双向附件与伙伴斗图 | 最新真实全链 sticker / fileDelivery / peerChat；[媒体源码 E2E](../../artifacts/superagent-bot-development/ui-media-preview-e2e.log)、[媒体说明](superagent-bot-media-2026-11-02.md) | 4 包 91 张原字节、静态首帧预览及语义标签可选；正式模型实际发出动图、worker 读取输入并发送实际文件。追加条件发送验证 previousDeliveries=1 / finalDeliveries=1，taskCardHasReceipt=true；伙伴媒体交换及私有事实隔离通过。早期复用断言失败另行保留，不据新结果推定原失败原因。 |
| 大文件与播放策略 | sparse / read 禁止仪表、media 回归、媒体源码 E2E | 图片 ≤50MiB、视频 ≤500MiB、音频 ≤200MiB 可内嵌；超限只登记元数据与原路径引用，不 hash / copy / decode，不交给任务，不提供协议 GET。显式保存才复制；显式系统打开按会话 / ID 核验。小 MP4 / WAV 的实际播放 currentTime 推进通过；OS 默认应用启动由 E2E stub 替代，尚未证明外部软件真的启动。 |
| 热路径与规模 | [720 / 10k / 100k 实测](superagent-bot-memory-scale-2026-11-02.md) | 720 条真实内置向量日记索引完成；重复检索 p50 / p95 约 13 / 16ms，RAG 准备约 97 / 169ms。100k 原文 DeepMemo 热回查约 4.58 / 15.85ms，已有索引冷重启首次回查 1.81s；100k 是原始消息，不是 100k 向量日记。 |
| 单元、类型与本轮 lint | [最终顺序总表](../../artifacts/superagent-bot-development/unit-final.log)、[原生失败批次](../../artifacts/superagent-bot-development/unit-native-initial-failure.log)、[专项重跑诊断](../../artifacts/superagent-bot-development/bot-memory-runtime-retry-diagnosis.json) | 最新 39 文件 / 236 项通过、6 opt-in 文件 / 6 项跳过，耗时 49.23s。此前 235 通过 / 1 原生退出 / 6 跳过已归档；runtime 独立 4 项及整体复跑均未复现，不能据此声称已修复原生异常。19 个 lint 问题已收口，相关严格类型与 25 项定向回归通过。 |
| 最新包与 packaged E2E | [最终打包日志](../../artifacts/superagent-bot-development/package-final.log)、[成品 E2E](../../artifacts/superagent-bot-development/packaged-e2e-final.log)、[正式配置核对](../../artifacts/superagent-bot-development/production-bootstrap.json) | Node24.15 / Electron43.8.3 的 Windows x64 package 与 postPackage 门禁通过；4 项成品 E2E 全通过（30.2s）。正式配置使用大肥鱼及14位内置伙伴，旧小伴清理 complete、相关SQL记录为0；成品原生VCP只读查询成功，模型元数据和加密凭据哈希不变，未发送测试聊天。 |

## 真实模型报告证明了什么

[2026-11-03 最新正式全链结果](../../artifacts/superagent-bot-development/real-acceptance/result.json)已重新只读确认为 passed:true、usesRealModel:true、usesRealEmbedding:true、errors:[]，模型为 deepseek-flash，端点主机为 api.deepseek.com，原生 DSH 为 0.2.1-rc.5。记录包括实际 memory_search 回执、自动捕获来源与索引、动图发送、唯一任务与产物、worker 双向文件、重启不重建任务、peer 媒体及隐私隔离。新增“已交付则不重发”的断言也通过：前后交付均为 1，任务卡具有实际文件回执；模型通过 files / task_control 核对，不只是正文声称未重复。没有把本地模拟输出列为正式模型结果。正式凭据加密保存，本文不记录密钥。

这是一轮受控的真实端到端案例，不代表所有事实都会被永久正确回忆、所有模型都有效或任意自然聊天质量已全面达标。自动提炼目前针对已完成用户 turn，简单寒暄会跳过；伙伴 / 世界 / 任务来源仍有耐久原文与显式记忆工具，不会对每个物理 tick 自动跑提炼 LLM。同一伙伴不同安全域默认隔离，受控跨域长期知识发布尚未作为独立能力验收。QQ / 微信 / 手机入口按用户确认保留后续扩展，不属于本轮真实平台接入结果。

## 证据使用与实际限制

- anime-chat-light.png / anime-chat-dark.png 等正常气泡排版图使用人工语料视觉夹具；它们证明布局，不证明这些台词由正式模型生成。真实模型依据来自上述 result 与工具 / 来源回执。未配置模型的失败态截图同样不作主脑成功证据。
- 媒体 E2E 验证真实 File、原文件字节、导入 / 保存、跨会话拒绝、冷 reload 及 MP4 / WAV 播放；系统选择器可由测试选定路径，shell.openPath 被 stub 记录目标，不能据此声称操作系统已实际打开第三方播放器或编辑器。
- 超限原文件是外部引用，SHA 缺省而非伪造。路径 / size / mtime 等变化会要求重新选择；引用源文件不属于清理对象。metadata no-copy 与小文件的内容 hash 不应混为同一种存储保证。
- 规模延迟各项只有 25 次样本，RSS 是阶段末采样而非峰值；原生数据库队列没有可靠观测钩子，未编造数值。重启阶段早期 JS 探针计数错误已保留并声明无效，另用短 10k 轮验证修复。不能据此声称数月无泄漏或 100k 向量性能。
- [早期原生退出 3221226505](../../artifacts/superagent-bot-development/native-create-recovery-initial-failure.json)与[正式链早期观察失败](../../artifacts/superagent-bot-development/real-acceptance/initial-observer-failure.json)单独保留，不计通过。后续成功报告不会抹去这些失败，也不提供所有外部效果自动重试的恰好一次保证。
- [文件复用初次断言失败](../../artifacts/superagent-bot-development/real-acceptance/file-reuse-initial-failure.json)保留。最新观察器按本轮用户事件的 sourceMessageRecordId 等待，避免混入异步 task_notice；新一轮通过不等于已确认前一次重复断言的具体根因。
- 最近综合单测曾发生原生退出 3221226505 / 0xC0000409；单独 runtime 4 项和最终顺序 236 项复跑均未复现，但 Windows 日志未定位 faulting module，亦无原生 stack trace。见[诊断记录](../../artifacts/superagent-bot-development/bot-memory-runtime-retry-diagnosis.json)。不能归因于 OOM、并发或测试观察器，也不能用重跑通过抹去这次异常或宣称根因已修复。

## 清理状态与最终交付

旧伙伴专用业务数据已按清理回执移除。另有 **4 个测试临时目标**的删除被自动审批拒绝，原因仅为 blocked by policy，均保留且未换方式绕过：.tools/global-network-coverage/run-lAkyfG、.tools/legacy-companion-reset/d10b7c8fc721cde7、%TEMP%/bot-media-test-78pOc8、%TEMP%/wlb-bot-media-ui-SO4c0d。见[前两项拒绝与盘点](../../artifacts/superagent-bot-development/temp-cleanup-rejected-inventory.json)、[后两项拒绝记录](../../artifacts/superagent-bot-development/additional-cleanup-rejections.json)、[媒体 fixture 原始拒绝审计](../../artifacts/bot-refactor-2026-11-02/media-temp-cleanup-rejection.json)。

最终程序为 `out/WorldlineBox-win32-x64/WorldlineBox.exe`；完整成品资源目录需要一起保留。最终封装采用本机已校验 Electron ZIP，postPackage 验证了 VCP / ABI、唯一内置向量、媒体、便携工具与 ASAR 入口。该程序实际完成聊天、媒体、视觉夹具和世界四项 E2E；正式配置随后完成内置人物、旧默认清理、VCP 原生查询与凭据不变的核对。汇总见[最终验收清单](../../artifacts/superagent-bot-development/framework-acceptance.json)。本轮开发与本机验收所需检查已完成，四个自动审批拒绝的测试目录和未定位原生异常均作为明确例外保留。
