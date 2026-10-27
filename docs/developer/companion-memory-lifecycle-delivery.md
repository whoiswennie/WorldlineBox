# 伙伴记忆系统重构交付报告

本次交付把伙伴的来源、事件合批、日记、维护、学习和回忆统一到同一套版本、授权与恢复标准。
使用方法见[伙伴记忆运行指南](companion-memory-user-guide.md)，本报告只列交付范围、验证证据和剩余边界。
代码与测试夹具冻结提交：`56cda718a3dfcce82eef595c823a1851f781ab8b`，最终运行前后工作区干净。用户于2026-10-27明确要求尽快交付并取消两小时测试；本报告记录已完成实现、已取得结果和仍未通过的范围，不追加重构或重跑。

## 提交与交付范围

| 提交 | 含义 |
| --- | --- |
| `918baf4` | 按用户要求提交重构前完整工作区，保留可复核基线 |
| `ab4e57a` | 统一记忆生命周期与伙伴文件上下文第一阶段 |
| `ac2ef22` | 文件权威、来源/历史、维护、预算及宿主恢复补强 |
| `75d6fbf` | 合法索引 ACK 减少重复来源写入，经历投影 SQL 短事务及索引优化 |
| `56cda718` | 资源验证夹具与生产耐久初始化凭证对齐；当前最终运行范围冻结 |

核心行为已经实现：

- 每个伙伴的正文、来源副本、不可变历史、提示词、策略、形象及认知索引归入其资产目录；实际模型正文读取受文件、来源和权限核验约束。
- 内置角色模板只用于首次初始化；UI 保存修改伙伴的实际文件，缺失文件不会通过 builtin 或 SQL 正文回退悄悄修复。
- 连续消息先组成事件片段；均衡默认静默 60 秒、12 条或首条等待 5 分钟后处理稳定前缀，模型可以决定不新增日记。
- 主动记录与后台捕获核对同源贡献；部分概述不能标成全部覆盖，遗漏事实仍可补入，append/correct 绑定实际已读版本。
- 正文修订、注释和硬撤销分离；任务可以保留合法旧正文，遗忘、来源撤回、权限失效和停止不能被快照绕过。
- 每伙伴按自己的实时策略维护；白天和任务期间也能推进，关闭期间不执行本地思考，不补演离线梦。
- 反思、真实整合、梦及学习自测保存阶段回执；本地预算延期保留欠账，合法已成功阶段可以复用。
- 梦后问题仅引导已有授权内的真实阅读；方法候选需要客观实践回执，不能把自述成功或 exit0 当作掌握。
- 保留 VCP 原生检索数学，候选准备与锁外聚焦分开；主动回忆可继续搜索/读取，排序候选不冒充查遍全库。
- 多 owner 队列、公平、取消、热冷原生进程与共享模型预算统一约束；索引未就绪时明确 pending，不伪报完整新结果。

“文件权威”不表示物理上只有一份字节：SQLite 仍保存原始消息、权限、事务暂存和不可变副本，但不能代替缺失的 canonical 模型正文。

## 已有关键验证

各行是独立批次或场景，存在交叠，不能相加为一个总通过数；多数发生在最终冻结运行之前。

| 验证 | 实际结果与证据 | 证据边界 |
| --- | --- | --- |
| 关联失败联合收敛 | [23 文件 358 项 exit0](../../artifacts/vcp-validation/current-unified-related-23-files-final.log) | 稳定源码定向批次，不是完整仓库全部通过 |
| Main/记忆/投递 | [3 文件 208 项 exit0](../../artifacts/vcp-validation/current-main-services-index-pending-final.log) | 保留初次普通来信 pending、主动查询门及已有任务恢复边界 |
| 真实 Electron UI/文件 | [6 场景，5.1 分钟，runner/observer exit0](../../artifacts/vcp-validation/final-electron-memory-20261027-071222/summary.json) | 实际 Gemma、Rust、SQLite、UI/文件；聊天为本地确定性提供方，付费请求 0；precommit bundle |
| 原/新捕获对照 | [同 24 条来源，模型请求 24→2；重要来源 3→3，原文保留](../../artifacts/vcp-validation/memory-capture-paired.json) | 真实旧/新 Store+Coordinator，确定性 HTTP、模拟时钟；不是语义重复率或实际账单 |
| 同源遗漏质量 | [全摘要不重复、原抽屉遗漏补同 ID/v2](../../artifacts/vcp-validation/memory-contribution-real-2026-10-26T17-20-49-222Z.json) | 实际配置聊天模型和 Rust，确定性 16 维向量；旧失败保留 |
| 真模型/真 Gemma 固定六例 | [6 输出事实通过，12 HTTP=12 账本](../../artifacts/vcp-validation/passive-recall-quality-real-live-owner-guidance-20261027-0550.json) | 小样本；该旧 runner 随后 IOCP exit1，不能将内容判定通过写成整次进程干净通过 |
| 复杂故事产品路径 | [自然 capture 与真实 Main 自主补查的严格输出审计](../../artifacts/vcp-validation/memory-story-product-audit-2026-10-26T21-17-18.091Z.json) | 最新两路径各曾成功；原生首次平铺漏段及早期模型遗漏仍保留，非统计可靠度保证 |
| 注释与月导航重用 | [100 次 tag/remember 后模型夹具调用仍 4，真实正文变更后 6](../../artifacts/vcp-validation/memory-100tag-native-reuse-2026-10-26T23-06-36-709Z.json) | 实际 Rust；模型/向量确定性，不是真实提供方费用 |
| 真宿主强杀恢复 | [五阶段 host SIGKILL](../../artifacts/vcp-validation/memory-lifecycle-host-kill-2026-10-26T22-21-53-177Z.json)、[prepared/focused 正负恢复](../../artifacts/vcp-validation/prepared-host-restart.json) | 实际子进程、SQL、native/文件；不冒称 GUI 父进程崩溃或断电，模型/向量确定性 |
| 小预算学习续进 | [实际 HTTP/账本、同 round 跨日和重启完成](../../artifacts/vcp-validation/learning-paid-checkpoints-complete-2026-10-26T10-00-02.050Z-c297fe3f.json) | 真实 SQLite 与文件、确定性提供方及模拟跨日；不是模型权重训练 |
| reset 历史隐私 | [owner SQL current/body/version secret 全部清零，Bob 保留](../../artifacts/vcp-validation/memory-reset-history-audit-2026-10-26T22-32-52-697Z.json) | 隔离临时 DB；不是旧用户导出物理删除证明 |
| ACK 写放大修复 | [1000 同语料，16.38→14.28 秒，WAL 472→446 MB，来源 DELETE 1000→0](../../artifacts/vcp-validation/memory-index-ack-before-after-summary.json) | 仅 SQLite+同步经历归档诊断，不是原生全 N 性能；FULL sync 保留，测量夹具关闭自动 checkpoint |

这些证据分别覆盖工程正确性、文件/授权边界、部分内容质量和资源诊断，不能互相替代。
真实文件、真实 Rust 或真实 HTTP 并不自动意味着用了真实编码器或真实付费语言模型。

## 保留的基线失败与历史红例

原广回归在在途源码上有 390 文件、113 项失败及 1 个夹具异常；[原始日志保留](../../artifacts/vcp-validation/current-unified-memory-broad-regression.log)，未改写成全绿。
其中本次关联的 23 个失败文件已在后续定向批次通过；另外 14 个文件按以下证据单列，未为了消红放宽产品或断言。

- **实际隔离基线复跑：4 文件。** `companion-message-bubble`、`companion-state-disturbance`、`companion-store`、`companion-user-task-stop` 在 918baf4 原样跑 49 项，41 通过、8 失败，与当前相同断言匹配；Electron43.8.3/Node24.22.0，exit1。见[归档与源码哈希清单](../../artifacts/vcp-validation/baseline-918baf4-eight-red-20261027/actual-baseline-verification.json)。
- **静态基线合同对照：10 个 world 文件。** 测试与 918baf4 原文相同；8 文件 26 项请求已禁止的 compressed 时钟，另 2 项仍预期旧物化时间而原代码已显示现实时间。见[当前栈与基线源码证据](../../artifacts/vcp-validation/current-broad-world-baseline-classification.json)。这 10 文件未进行完整旧版本实跑，不能混称实际基线复现。
- 原首次被动召回漏片段、早期概括遗漏和工具选择失败均留存，后续单次成功不删除这些质量边界。
- 旧 Electron IOCP fatal 的原始 PID 归因及一次 close 停滞未找到确定根因；新 runtime 的干净退出与后续未再复现不倒推旧现场已定位。

## 最终冻结运行及用户取消的验证

冻结版本 `56cda718` 的最后 10k 专项已经结束，实际exit1，不作为规模验收通过。
前一次 `ac2ef22` 矩阵的 1k/100 样本完成，但 10k 在原生入库 600 秒触门；后一次 `75d6fbf` 10k 也保留了触门红例。
`56cda718` 修正夹具耐久初始化路径，不会自动把前两次红例转绿，须以本次完整报告为准。

| 最终 10k 专项字段 | 实际结果 |
| --- | --- |
| 收据路径 / 源码与冻结 hash | `artifacts/vcp-validation/native-memory-resources-2026-10-27T01-12-09-951Z-23152/report.json`；前后HEAD均56cda718、clean，sourceChanged=false、frozenIntegrity=true |
| 完整主 owner 入库 ACK / peer 状态 | 退出后只读SQLite聚合：主伙伴实际ACK8406/10000，queued1594（outbox pending1593、running1）；三个活跃peer各8条均done |
| 各阶段 / 停止门 | 当前正文、来源及历史已发布；首次原生索引投递触原600秒门；未提高门槛或减少N |
| 查询样本 / 延迟 | 配置100样本、768维；未到cold/warm查询阶段，实际查询样本0，不能声称10k本地准备p95 300ms通过 |
| 树工作集 / 磁盘 / 原生进程 | 实测峰949,997,568B / 436,003,181B / 4；5个被测进程及辅助读取进程均已退出，按原创建时间、父PID与命令复核残留0；不是实际编码器资源或付费模型测量 |
| runner / 范围 | 实际exit1、1622.16秒；失败收据保留，不再追加调优或重跑 |

完整两小时Main连续任务测试按用户最新要求取消，未启动，不判为通过。此前87秒Main实际工具/等待/恢复smoke及旧partial两小时记录各有原始边界，均不能替代本次未执行的长时程验收。无需为了交付等待两小时。

## 仍然不能宣称完成的范围

十万级原矩阵在源账本阶段约 58,432/100,000 条时触发 1GiB 磁盘门，尚未建立完整十万原生图；本次专项不等于该门已通过。
旧认知导出的物理删除曾被执行工具自动审批拒绝；数据库清理不等于旧磁盘文件消失，不能写“旧文件已全部清空”，也不能换方法绕过删除限制。
交付前只读复核仍有旧伙伴记忆98文件、attachments7、dsh-tasks1、experiences590、vcp1006、vcp-context10；未再次尝试删除。旧目录不能视为已初始化的新标准伙伴目录，实际存量环境的清理仍需解决。
新系统不自动迁移旧导出恢复记忆；物理清理待解决的事实仍需保留，不因此重新导入旧资料。
模型存在概括、条件保留和主动补查局限；梦中原句核查不证明假设为真，方法交付验证不等于通用熟练度。
最终运行未通过的门应报告实际状态和限制，不能通过删语料、缩候选、改原生数学或降低门槛宣告完成。

交付结论：**核心重构和使用说明已提交，定向回归与真实界面验证通过；10k完整建库未在既定阶段时间内完成、100k磁盘门未通过，两小时验收按用户要求取消。旧物理清理仍受工具拒绝，整体目标不能标为全部完成。**
