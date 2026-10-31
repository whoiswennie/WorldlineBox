# 新伙伴系统源码交付核对

状态：**当前源码重构及本次约定范围的验证已完成。** 最后恢复与分页修复均已定向核验，完整类型检查通过。用户取消的长时间真实测试不再执行，也不改记为通过。

## 需求与实现

| 需求 | 当前实现与核对依据 |
| --- | --- |
| R01 创建后认知只读 | 创建事务封存起点；资料／提示词写入接口拒绝创建后的修改，界面只读。`asset-profile.ts`、`creation-store.ts`、`service.ts`、`CompanionCognitionDossier.tsx`；证据审计E1、E2、E7。 |
| R02 类型与默认拒收 | ArtifactRegistry 对类型、路径、生产者、消费者、owner、版本及可见性核验；未知目录不自动摄取。`companion-artifact.ts`、`artifact-registry-store.ts`；E4、E6、E19。 |
| R03 分道记忆与知识 | 经历、知识、方法、自我认识、导航、来源、历史和运行资料有独立类型及消费者；继续使用VCP检索，不把全部文件变成记忆。`memory-type-scope.ts`、`memory-library.ts`；E4、E6、E16。 |
| R04 来源与作者 | 原始事件先持久保存；候选、准确正文和派生依赖都绑定作者／版本／哈希。引用存在不冒充语义支持。`source-access.ts`、`memory-ledger.ts`、`memory-source-files.ts`；E6、E7、E18。 |
| R05 培养与实践 | 培养目标、实际反馈和修订持久保存，可暂停、结束；目标明确表示未来练习，不直接写成既有性格。`growth-store.ts`、`model-cultivation-scope.ts`、`CompanionGrowthGoals.tsx`；E5、E17。 |
| R06 正式人格演化 | 已提交的有条件本人认识经独立整合，局部发布当前人格及历史差异，后续实际请求采用当前版本；起点不并列压住新描述。`growth-service.ts`、`persona-fragments.ts`、`asset-profile.ts`；E5、E17、启动恢复定向证据。 |
| R07 定性状态 | 心理PAD、好感／信任／尊重分数及按次数解锁的性格阶段已退出行为消费；体验和关系使用带来源、语境和重评条件的记录。`qualitative-state-schema.ts`、`state-store.ts`、`companion-affect.ts`；E2、E7、E8。 |
| R08 统一上下文 | 按用途编译身份、指导、处理合同和获权输入，身份装配一次；发送前核版本和撤回，长话题采用有界原文／合法摘要。`asset-context.ts`、`context-snapshots.ts`、`topic-compaction-service.ts`；E3、E27、E28。 |
| R09 透明档案 | 四组横向导航与全宽内容，展示当前自我、表达、认识、处境、关系、记忆、培养、历史、起点、指导和实际请求；原稿蓝色竖条已移除。`CompanionCognitionDossier.tsx`、`CompanionActualContext.tsx`；E2、E13、E26。 |
| R10 可恢复发布 | 正文与账本有预备、校验、文件发布、提交及清理状态；准确版本／路径／读写依赖预留；已保存结果续接，未知发送不自动重放。`artifact-registry.ts`、`artifact-publication-reservations.ts`、`recovery.ts`；E12、E21、E29。 |
| R11 撤回不复活 | 准确来源撤回传播到认识、人格片段、索引、快照及派生物；恢复包不能覆盖新的宿主撤回权威。`memory-withdrawal-store.ts`、`recovery-fence.ts`、`persona-fragments.ts`；E12、E20、E21。 |
| R12 有界与公平 | 有界人格／输入／近期原文，按需回忆；后台轮转、精确文件依赖及独立任务隔离，坏项不能一直占据队头。`memory-file-readiness.ts`、`memory-publication-jobs.ts`、`topic-compaction-service.ts`；E27～E31。不是任意规模性能承诺。 |
| R13 独立处理与结算 | 捕获、知识、反思、整合、人格发布和梦分别准入；派生与虚构不作为新经历；结构修复至多两次，11类持久作业按真实失败三次搁置、明确恢复或放弃。`structured-repair.ts`、`job-control-store.ts`、`world-service.ts`；E3、E8～E11、E18、E20。 |
| R14 验证与研究边界 | 研究原则及工程假设分列，机制与真实内容结果分别报告。已有知识小型正例与人格正式发布／采用；人格额外因果增益不足，不声称真人等效发展。用户已撤销新长测；保留短时定向检查。 |
| R15 新协议唯一运行 | 开发旧资料按精确授权清单清理，正式空库初始化；旧账本、目录及恢复包拒绝转换或兼容读取，不重复清理真实库。`cognition-protocol.ts`、`development-cleanup.ts`；E14、E15。 |

逐项T-001～T-057的原始证据、失败和适用版本仍在[证据审计](companion-cognition-acceptance-evidence-audit-2026-10-28.md)。本表不会把各轮重叠数量相加成全仓通过，也不会把测试存在当作实际通过。

## 最后定向修复

1. 人格启动恢复改为按当前人格准确版本查pending writer，再按真实job索引找到唯一检查点。八条较新无关stale不再掩盖已保存结果；失效提议仍拒绝，park／abandon不复活，恢复错误按owner隔离。原始RED保留，最终[7项短门通过](../../artifacts/cognition-validation/growth-exact-pending-writer-freeze-v16.json)，30.52秒。
2. 成长历史补齐20条一页的准确续读与“加载更多”；分页前后核对撤回epoch，换伙伴或资料版本清旧响应，失效页立即清除已加载历史。[最终16项通过](../../artifacts/cognition-validation/growth-history-pagination-short-freeze-2026-10-29.json)，4.18秒，未启动真实模型或Native。
3. 保留的[28项快速检查](../../artifacts/cognition-validation/long-test-withdrawal-short-check-2026-10-29.json)通过，4.54秒。各集合独立报告；[最后完整类型检查及稳定性收据](../../artifacts/cognition-validation/final-cognition-source-delivery-verification-2026-10-29.json)确认主项目与extension均退出0，3438个源码／测试／脚本／配置输入在检查前后未变，两组最终修改的冻结hash一致，保留短源码的lint及tracked diff检查通过。

## 当前交付边界

- 交付是当前工作树源码及文档。此前ASAR attempt5实际构建与四项包内验证通过，但它早于最后恢复及历史分页修复；本次没有重新打包安装程序，不将旧包标为最新代码。
- 旧广集、完整Main分批结果、真实模型小样本及界面证据按各自冻结版本保留。最后改动只做受影响短用例与静态检查，不重新启动耐久、十万事件灌入、完整广集或多轮模型实验。
- 已取消的T036运行保留现场、临时事件数据和准确进程停止收据；T035 v6原超时及原始DB未保全的限制保留。它们不支持完整100k或最终版本两小时稳定的结论。
- 没有产品日／分钟／调用量／费用额度；并发、上下文容量及有限结构修复属于工程约束。伙伴成长的具体速度与内容取决于经历、模型、反馈和证据，允许无变化。

使用方法见[运行与管理说明](companion-cognition-runtime-guide.md)，当前实现与原始收据索引见[实施记录](companion-cognition-implementation-2026-10-28.md)。
