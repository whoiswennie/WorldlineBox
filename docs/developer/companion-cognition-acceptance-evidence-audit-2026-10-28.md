# 伙伴认知重构验收证据审计

审计日期：2026-10-28，更新至本轮备份恢复、失败治理及结构修复守恒的实际日志。范围为[主规范](companion-cognition-refactor-standard-2026-10-28.md)与[验收附录](companion-cognition-acceptance-2026-10-28.md) T-001～T-057。本文映射源码、已执行收据与缺口，不是发布通过证明。

2026-10-29最后源码收尾及用户撤销长测后的交付范围见[交付核对](companion-cognition-delivery-2026-10-29.md)。最后完整主项目／extension类型检查退出0，3438个受检输入稳定，两组最终修复的hash保持，详见[静态与稳定性收据](../../artifacts/cognition-validation/final-cognition-source-delivery-verification-2026-10-29.json)。本文保留的旧范围失败和不足，不作为重启已撤销长测的待办。

基线 HEAD 为 `7eb9322b544f0a6eecf569ef9e562f5e82a48222`，仍有并行未提交实现。日志属于各自时点的工作区，测试集合有重叠，不能相加成全仓通过数。下列“复核日志”不表示本审计重新执行了负责人测试；测试代码存在本身也不算通过。

用户已取消产品模型额度／预算及其自动化阻断。旧额度通过记录作废，不恢复旧 DTO、usage 表或预算面板。工程并发公平、真实发送、来源／版本、取消、上下文容量与至多两次结构修复仍保留。

## 可核验的收据

| 证据 | 原始记录 | 已观察结果及边界 |
| --- | --- | --- |
| E1 | [本组八组旧夹具](../../artifacts/cognition-validation/p5-owned-eight-fixtures-final-v2.txt) | 本组执行8文件67/67。只读、外改、缺失不回填、72位双图住户、冷读144／热读0、新UUID模板及选图竞态；不是生产时延／长时资源指标。 |
| E2 | [档案与实际HTTP](../../artifacts/cognition-validation/electron-horizontal-cognition-final.txt)、[培养方向](../../artifacts/cognition-validation/electron-horizontal-growth-final.txt) | 本组分别2/2、1/1。真实UI新建、宽窄深浅、HTTP实收body与快照一致、暂停／结束目标不注入。开发构建，不能代替安装包。 |
| E3 | [中央修复真实Registry](../../artifacts/cognition-validation/p5-central-repair-integration.txt) | 本组8选中通过／29未运行。真实SQLite及最终body，私有原模型／全局修复、两次上限、根链、unknown、撤回与前台并行；提供方响应为确定性夹具。 |
| E4 | [Registry合同](../../artifacts/cognition-validation/owner-final-registry-contracts.txt)、[10万元数据](../../artifacts/cognition-validation/owner-scale-canonical-final.txt) | 复核51/51、2/2。100,042对象中100,000笔记只有元数据，没有正文或模型调用；只证明索引／分页机制。 |
| E5 | [成长与话题合同](../../artifacts/cognition-validation/owner-growth-topic-repair.txt)、[培养域](../../artifacts/cognition-validation/owner-cultivation-scope.txt) | 复核116/116、2选中／1未运行。支持检查点、来源与域，不是长期人格语义试验。 |
| E6 | [来源版本及文件](../../artifacts/cognition-validation/p2-source-revision-latest.txt)、[typed夹具](../../artifacts/cognition-validation/owner-typed-fixtures.txt) | 分别19/19、23/23。后续lease拒绝更严格，旧日志不能自动覆盖新改动。 |
| E7 | [完整Main](../../artifacts/cognition-validation/main-service-full-governance-v3.txt)、[完整memory Main](../../artifacts/cognition-validation/memory-service-full-governance-v7.txt) | Root执行，本审计核对结尾：159/159、70/70。覆盖大量服务并发、撤回、取消和恢复；不代表所有模型语义或安装包通过。 |
| E8 | [世界／标签](../../artifacts/cognition-validation/job-control-world-tags-final.txt)、[学习](../../artifacts/cognition-validation/job-control-learning-final.txt)、[计划／资料](../../artifacts/cognition-validation/job-control-plan-assets-final.txt) | 复核77/77、48/48、21/21。真实生产适配、坏资料和后续独立材料、累计失败／恢复；均为工程测试。 |
| E9 | [作业核心](../../artifacts/cognition-validation/job-control-core-final.txt)、[capture](../../artifacts/cognition-validation/job-control-capture-final.txt)、[分页规模](../../artifacts/cognition-validation/job-control-index-scale-final.txt)、[时间线Main](../../artifacts/cognition-validation/timeline-governance-main-v3.txt) | 复核53/53、8/8、2选中／12未运行、17/17。含连续3次真失败、保留累计、坏事件与50个后续事件、131条分页和准确取消。 |
| E10 | [无额度UI](../../artifacts/cognition-validation/p5-no-quota-processing-ui-final.txt)、[生命周期／VCP](../../artifacts/cognition-validation/p5-source-lifecycle-routing-final.txt)、[全局配置](../../artifacts/cognition-validation/p5-service-global-repair-noquota-final.txt) | 本组13/13、30/30、1选中／156未运行。预算接口退出，来源guard与回调保持，修复使用全局连接。 |
| E11 | [故障UI](../../artifacts/cognition-validation/fault-original-event-ui-final.txt)、[受控暂停](../../artifacts/cognition-validation/recovery-controlled-pause-ui.txt) | 本组33/33、1选中／63未运行。显式inspect、原事件可见性、冻结UUID／版本、跨owner／迟到拒绝、分页及暂停保留现有画面。 |
| E12 | [恢复集成](../../artifacts/cognition-validation/recovery-integrated-final-v4.txt)、[严格IPC](../../artifacts/cognition-validation/recovery-utility-strict-envelope.txt) | 本组30/30，另1/1。实际SQLite／正文／来源／历史／附件往返、旧包拒绝、准确修复、stage重建、旧CAS失效、旧格式拒绝及模板副本不吸历史。真实UI发现的协议覆盖失败保留于[v4](../../artifacts/cognition-validation/recovery-electron-ui-v4.txt)。 |
| E13 | [实际Electron故障及恢复](../../artifacts/cognition-validation/recovery-fault-electron-final.txt)、[恢复收据](../../artifacts/cognition-validation/recovery-electron-ui-proof.json) | 本组2/2：63条事件分页／放弃保留原消息；备份后继续消息、错库拒绝、profile准确补回、缺DB全局入口及完整恢复后休眠／旧作业held，宽窄深浅溢出≤2。仅临时库、无模型配置；不是打包构建。 |
| E14 | [实库执行](../../artifacts/cognition-validation/companion-cleanup-executed-v3-2026-10-28.txt)、[清理后核验](../../artifacts/cognition-validation/actual-cleanup-verified-before-initialization-2026-10-28.json)、[生产空库](../../artifacts/cognition-validation/actual-empty-production-store-verification-2026-10-28.json) | Root清理、本组核验和授权初始化。5精确文件及旧账本退出，新库身份／消息／会话／记忆／发布等为0，玩家hash精确保留、无旧额度表。未创建真实角色／调用模型／打开该库GUI。 |
| E15 | [实际CLI](../../artifacts/cognition-validation/managed-cleanup-cli-player-only-final.txt)、[新权威保护](../../artifacts/cognition-validation/cleanup-enrolled-authority-gate.txt) | 本组1/1、2选中通过。错误hash拒绝，人类资料、未知附件、密钥保留；fence或enrollment出现后旧工具plan／execute均拒绝。 |
| E16 | [真实知识v4-native](../../artifacts/cognition-validation/knowledge-heldout-real-v4-native.txt)、[机器收据](../../artifacts/cognition-validation/knowledge-heldout-real-v4-native.json) | 复核1选中通过／2未运行，23次真实HTTP，4固定独立题hostPassed均true，只带当前题，typed VCP与准确body有凭据。两轮合成借阅材料的小样本，不是广泛保持／因果证明。 |
| E17 | [人格A/B/C v3](../../artifacts/cognition-validation/persona-causal-real-v3.txt)、[v3机器收据](../../artifacts/cognition-validation/persona-causal-real-v3.json)、[交流修复v9](../../artifacts/cognition-validation/real-model-smoke-v9.txt)、[人格v6原生阶段分离](../../artifacts/cognition-validation/persona-causal-real-v6-native-phase-separation.txt)、[v6完整收据](../../artifacts/cognition-validation/persona-causal-real-v6-native-phase-separation.json) | v3实际12HTTP、候选被修复成空、C未发布；v4／v5各7HTTP，反思无已读依据而拒绝，原失败均保留。v6实际22HTTP，3条正式经历→2条有条件本人认识→C正式人格发布，实际后续请求采用新profile；B／C同源、typed回忆readset一致、目标暂停／只带当前题均经host核验。A／B／C两类行为题全部达标，incrementalProfileEffect=false，最终仍为insufficient_evidence：证明发布管线运行，不证明行为因果增益或人类成长曲线。 |
| E18 | [值守恒](../../artifacts/cognition-validation/structured-repair-value-conservation-final.txt)、[记忆／世界](../../artifacts/cognition-validation/structured-repair-memory-world-conservation-final.txt)、[认知](../../artifacts/cognition-validation/structured-repair-cognition-conservation-final.txt)、[话题](../../artifacts/cognition-validation/topic-repair-conservation-final.txt) | 复核47/47、122/122、176/176、504/504，集合重叠。修复不靠丢集合、删重复或改已知值洗成空成功，恢复重验；不是所有真实输出都能修好的保证。 |
| E19 | [SQL精确撤回](../../artifacts/cognition-validation/owner-sql-withdrawal-exact-final.txt)、[整合撤回](../../artifacts/cognition-validation/owner-sql-withdrawal-consolidation-final.txt)、[负向重验](../../artifacts/cognition-validation/owner-revalidation-negative-privacy.txt) | 复核10/10、19/19、7/7。派生SQL与准确当前版本清理、来源剩余贡献正式重验；更早87项与25项记录有失败，不能只凭final文件名认为全过。 |
| E20 | [人格恢复冻结](../../artifacts/cognition-validation/owner-growth-restore-freeze.txt)、[已付输出续跑](../../artifacts/cognition-validation/owner-growth-resume-final.txt) | 分别1选中／22未运行、6通过／23未运行。原parked／abandoned也推进修订，保留attempt／已付输出，显式resume继续finish不重新生成。 |
| E21 | [话题及文件故障 UI](../../artifacts/cognition-validation/topic-compaction-fault-ui-final.txt)、[dirty／checkpoint恢复回归](../../artifacts/cognition-validation/recovery-dirty-checkpoint-final-v1.txt)、[当前定向 ESLint收据](../../artifacts/cognition-validation/owned-before-final-asar3-confirmed-eslint-result.json)；[此前文件 UI](../../artifacts/cognition-validation/file-publication-fault-ui-final.txt)、[此前恢复](../../artifacts/cognition-validation/recovery-file-publication-governance-final-v2.txt) | 当前43/43、34/34与lint退出0；source_files／history_files／topic_compaction按真实原row分页／CAS管理，显式详情才读仍获权原事件，话题还须精确topic／sent／非draft。held原row可备份恢复且revision推进，旧token失效、旧操作重放不解封新状态；未发布正文不造正式文件，实际running lease拒备份。恢复已覆盖新dirty hold／review及已验证checkpoint缓存撤回；此前37/37、32/32日志保留。UI为确定性夹具，不当作Main连续失败、当前打包版本或大规模性能证明。 |
| E22 | [记忆库新合同](../../artifacts/cognition-validation/memory-library-registry-contract-final-v2.txt)、[旧测试快照](../../artifacts/cognition-validation/companion-memory-library-legacy-fixture-before-rewrite.txt)、[新文件 ESLint](../../artifacts/cognition-validation/memory-library-registry-contract-eslint.txt) | 2026-10-29 独立执行11/11及lint退出0。旧19项 scanner／人工写入／sidecar导入正向合同退出，改为真实Store＋Registry＋受管FS：未知和伪sidecar不授权、移动／缺失不暗中forget或SQL回建、junction拒绝、正式撤回及peer隔离、按owner／artifact有界轮转、导航身份／修订／在途失效、并发分页与无状态文档重写。首轮10/11的额外失败为测试误把档案页等同仅当前note，已按正式path查重并分别验证current noteId；未改生产分页或放松断言。旧19项broad失败保留，不能把替换后的独立绿改写成原轮broad通过。 |
| E23 | [单 worker 选择清单](../../artifacts/cognition-validation/companion-worker-broad-selection.json)、[完整日志](../../artifacts/cognition-validation/companion-worker-broad-discovery.txt)、[机器结果](../../artifacts/cognition-validation/companion-worker-broad-discovery.json)、[逐项错误](../../artifacts/cognition-validation/companion-worker-broad-failures.json)、[分类](../../artifacts/cognition-validation/companion-worker-broad-triage.md)、[后续逐文件证据映射](../../artifacts/cognition-validation/companion-worker-broad-followup-evidence.md) | 231文件中选160、排71；maxWorkers=1，不跑真实模型／规模／soak／安装native DSH，不触实库。实际160文件111通过／49失败，1327项1166通过／161失败及5未处理错误，exit1，2226.22秒。明确新门拒绝与旧夹具、状态／读集／原生待复核分别记录；后续逐文件映射区分独立绿、补选、合同替换及尚未核实范围，不合成一次新全绿。并行代码变化下的发现回归不能宣称冻结最终构建已全过，也不把后来独立绿替换原失败。 |
| E24 | [新协议两小时](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v1.txt)、[完整机器收据](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v1.json)、[摘要](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v1-summary.json)、[冻结清单](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v1-implementation.json) | 2026-10-29实际1/1，整个测试7440秒，最后任务样本elapsed 7,219,977ms。100正式注册／3活跃／97无native请求；整Main重启后6任务全部完成，每项真实read_file一次、wait 55～57次；12次实际上下文压缩，native观察峰2、模型排队观察峰0。独立撤回保留原聊天／删准确正文／拒读／peer不变四项全true；errors为空。末端每owner仍有1项待capture，running／failed／pendingIndex均0，不声称原事件全被编码。观察进程树RSS峰约2.34GiB，不测VRAM；同机普通并行开发，冻结为dirty WIP且不含后来阶段分离／文件治理修复。确定性聊天只证明编排及资源基线，不证明人格语义或最终版本全部性能门。 |
| E25 | [捕获／索引真实host强杀](../../artifacts/cognition-validation/owner-lifecycle-crash-newprotocol-v2.txt)、[准备回忆20项](../../artifacts/cognition-validation/owner-prepared-recall-newprotocol-v1.txt)、[两项早期拒绝收据](../../artifacts/cognition-validation/owner-prepared-recall-early-rejection-v2.txt)、[ESLint](../../artifacts/cognition-validation/owner-crash-fixtures-newprotocol-lint.txt) | lifecycle新协议实际5/5：claim／model-return／commit／partial-native-index／before-publish强杀后，准确正文／来源／历史、原聊天与未完条件、native kind域、非重复日记及撤回门保留。model-return尚未耐久保存生成结果允许再次调用，不能称exactly-once付费。prepared首轮20项18通过，另2项ACL／外改在更早启动阶段已正确拒绝、仅缺真实launch计数；补收据后定向2/2。合计20场景各有通过证据，不冒充同一轮20全绿。旧fatal缺Registry与旧native scope误读失败均保留；只改隔离测试管线，无构造器fallback。 |
| E26 | [attempt5构建](../../artifacts/cognition-validation/current-asar-package-attempt5.txt)、[当前ASAR四项](../../artifacts/cognition-validation/packaged/20261028T223134Z-40800/report.json)、[精确摘要](../../artifacts/cognition-validation/current-asar-attempt5-acceptance-summary.json)、[源码冻结v6](../../artifacts/cognition-validation/current-asar-production-source-freeze-v6.json)、[末指纹](../../artifacts/cognition-validation/current-asar-attempt5-source-comparison-final.json)、[全流程退出收据](../../artifacts/cognition-validation/current-asar-attempt5-pipeline-status.json)；[包4基线](../../artifacts/cognition-validation/packaged/20261028T195516Z-48908/report.json)、[包4摘要](../../artifacts/cognition-validation/current-asar-attempt4-acceptance-summary.json)、[较早attempt2](../../artifacts/cognition-validation/packaged/20261028T172911Z-21344/report.json)、[helper原失败](../../artifacts/cognition-validation/packaged/20261028T172511Z-46704/report.json)、[attempt3精确取消](../../artifacts/cognition-validation/current-asar-package-attempt3-cancelled.json) | **最新attempt5冻结版本的Windows portable构建、native 1/1、资源门及实际ASAR四项均exit0，4/4、1.9分钟。**ASAR `67f3fc3c1a13be4b5a269fbbde102f8caf000239ce5bc0f19082fd9419619371`／真实worker `732ce209fa36eb190c5f72078ae38e5d8bc444ec1e0d3720cdc7c7608b46a41d`；五次build观测均isPackaged／隔离profile／同hash。3559项src／scripts／配置／tests在完整双tsc及全仓lint前后完全一致，两者exit0，保留7个无关既有warning；1830项production在打包及验收后SHA均未变，包括file-readiness／HOL修复、Registry精确预约和三个文件publisher。宽窄深浅、只读档案、实际本地HTTP体与身份、暂停／结束目标不注入、63故障事件分页和明确放弃保留原事件、来源／历史／话题kind入口、备份后可聊天／丢DB全局恢复／旧包拒回滚均过；已查看本轮截图，无旧起点蓝竖条或横向挤压（overflow门仍≤2px）。故障UI正式park夹具不冒充自动三失败全流程；离线恢复工具宿主为dev Electron，使用的worker准确来自本轮ASAR，角色分别记录。包4及更早成功／失败／取消证据完整保留；本轮不冒充安装／更新、最终Main／worker广集、长时规模或人格因果质量已通过。 |
| E27 | [话题作业核心20项](../../artifacts/cognition-validation/topic-auto-reconcile-window-final.txt)、[实际后台22项](../../artifacts/cognition-validation/owner-topic-background-acceptance-v18.txt)、[Main压缩单元17项](../../artifacts/cognition-validation/topic-maintenance-source-window-unit-v1.txt)、[尾来源原始反例](../../artifacts/cognition-validation/owner-topic-tail-reconcile-red-v16.txt) | 三个独立集合各自通过，不能相加为独立用例总数。前台不等后台摘要，模型前登记完整实际前缀及旧检查点；反向依赖失效、owner缓存撤回、最终发送／发布租约、结果未知后的明确恢复、确定性修复子调用均有实际Registry／SQLite反例。非末尾／尾来源撤回后，无新enqueue和无用户resume也可自动选合法来源、按原双水位继续并完成；原聊天／peer及累计失败保留。暂停范围让出队头，无合法来源取消而非假成功；恢复后的dirty保持搁置。尾来源原反例确曾被前台turn barrier阻塞，host-only源页租约修复后才转绿；公开模型schema拒绝该guard。上述为工程机制，不替代T035真实吞吐、最终ASAR或人格语义。 |
| E28 | [原始前台阻塞反例](../../artifacts/cognition-validation/memory-files-foreground-hol-red-v2.txt)、[文件准入同轮78项](../../artifacts/cognition-validation/file-publication-exact-readiness-freeze-v15.txt)、[该域源码清单](../../artifacts/cognition-validation/file-readiness-source-freeze-manifest-v15.json)、[该轮完整TS](../../artifacts/cognition-validation/typecheck-exact-readiness-freeze-v15.txt)、[中止的Main v14](../../artifacts/cognition-validation/main-and-memory-background-v14-cancelled.json) | 12文件78/78在该域冻结下通过，未拼接其它轮计数。修复前，已有A的读取及普通请求确实等了无关晚到C。修复后只读已发布固定视图、准确修订既有作业；pending写入保原ID/修订，文件发布单独推进cache、Native准入和学习回执。真实重启时C已claim挂起，初始化、A strict读取及普通provider发送仍完成。134 owner超过128排除名单后，轮转游标仍让后排实际source/history正式可读；未完成全局poll合并且关闭等待。已提交损坏硬拒，held不洗，旧历史只读不领新任务。Main v14因确认轮转溢出边界精确中止自身4进程，部分通过不算整轮。该证据仅覆盖文件准备与调度，Registry失败pending包对无关新发布的互斥仍另行复现修复，尚不等于最终Main/ASAR/T035全门通过。 |
| E29 | [独立原始反例](../../artifacts/cognition-validation/publication-isolation-independent-red-v1.txt)、[Registry同轮22项](../../artifacts/cognition-validation/publication-isolation-reservation-contract-final-v9.txt)、[该域冻结收据](../../artifacts/cognition-validation/publication-isolation-owned-freeze-v2.json)、[准确文件周期及Main同轮34项](../../artifacts/cognition-validation/exact-file-cycle-and-main-final-v5.txt)、[完整聊天独立正例](../../artifacts/cognition-validation/main-unrelated-prepared-file-snapshot-green-v3.txt)、[独立只读审查](../../artifacts/cognition-validation/registry-reservation-independent-review-v1.md) | 原始可靠反例是B已有耐久prepared包、无关真实请求A的快照被旧owner-wide门拒绝；Main夹具在WIP期间的超时／准备失败没有被冒充为该反例。修复用SQLite事务内的索引化对称读写及规范路径预留，Main在读取旧正文前准确预查；无关发布、共享只读及合法三节点批内next依赖可继续，同目标、大小写／祖先路径、创建、来源撤回和迟到提交仍受限。已知busy继承admission，实际generate边界HTTP为0且保留可重试等待，外改仍硬拒。完整Main正例中A原正文不变、B整份包／作业／失败1／原始来源不动，新聊天快照正式且provider实际发送。另source/history各覆盖直接前周期与中间周期未成包，17个无关active包不再遮挡明确恢复；旧包精确cancel/清暂存、新包commit，旧累计失败及新attempt保留。22与34为不同集合，不能相加为独立总数。备份仍拒未完成包，退役纳入派生reservation表；最终全静态、Main、ASAR及规模门另依其真实冻结收据。 |
| E30 | [原完整Main233/236](../../artifacts/cognition-validation/main-and-memory-background-v15.json)、[原轮次指纹](../../artifacts/cognition-validation/main-and-memory-background-v15-process.json)、[记忆完整73/73](../../artifacts/cognition-validation/memory-service-followup-v16.json)、[逐文件真实对账](../../artifacts/cognition-validation/current-main-coverage-reconciliation-v16.json)、[调整后全静态](../../artifacts/cognition-validation/current-asar-static-after-main15-pipeline-status.json) | 当前同一生产及共用夹具字节下，未改的主服务163/163与调整测试准备后的记忆73/73分别通过；不是把原v15改写为同一轮全绿。原三失败对应删除的私有drain、raw SQL未正式文件、异步发布与Native第一次失败前提，唯一unit文件按准确Main发布和真实remember/job回执改正，原全文/分页/权限/累计失败及原35秒backoff断言保留。原15/30秒恢复门不变。更新后完整类型检查和全仓lint exit0，静态v7与ASAR包5生产digest相同；没有新增生产改动或伪称重建。 |
| E31 | [短时多伙伴实际报告](../../artifacts/cognition-validation/multiowner-newprotocol-smoke-v11-final-publications.json)、[真实启动](../../artifacts/cognition-validation/multiowner-newprotocol-smoke-v11-final-publications.launch.json)、[过程与退出](../../artifacts/cognition-validation/multiowner-newprotocol-smoke-v11-final-publications.exit.json) | 本次最终生产的短时场景真实1/1通过，实际总墙钟321.97秒；45秒是配置场景，初始化及重启不能隐去。100位owner、3位活跃、97位闲置，两个真实Main进程及同冻结bundle，六项真实任务各有一次read_file和wait，来源撤回四门通过、原始事件保留、errors为空、native峰值2。包含被动空后实际Native主动搜索及canonical读取的合法路径，不是假注入。外部精确PID/creation观察及退出后独立检查没有遗留应用；这仍是短时工程证据，不能代替正在另行启动的真实两小时或T035完整十万事件门。 |

静态检查必须等待进程退出。本组恢复及UI的[ESLint](../../artifacts/cognition-validation/recovery-eslint-final-v4.txt)退出0；后续三项E2E适配完成后的[全仓TypeScript](../../artifacts/cognition-validation/typecheck-packaged-companion-adapters.txt)也已实际退出0，[适配文件ESLint](../../artifacts/cognition-validation/packaged-companion-adapters-eslint-final.txt)退出0。V8以后曾出现的新测试错误及其修复不抹去；当前0错误不自动覆盖之后的改动或打包产物。旧[broad](../../artifacts/cognition-validation/companion-unit-broad-governance-v1.txt)为198/200文件、2405通过／8失败；E8补强原world／tags失败，不能把旧日志改写成一次新全仓运行。

来源／历史文件治理接线后的[后续全仓 TypeScript](../../artifacts/cognition-validation/typecheck-file-publication-governance.txt)已实际退出1，错误集中于 `memory-model.ts` 新校验后的提案类型推断；该时点不宣称全仓编译通过。E21 的 UI／恢复定向运行与其 ESLint 结果仍分别记录，不替代这项失败。

2026-10-29最终包准备前的[全仓双tsc收据](../../artifacts/cognition-validation/typecheck-before-final-asar3-confirmed-result.json)现为exit0，[完整日志](../../artifacts/cognition-validation/typecheck-before-final-asar3-confirmed.txt)保留；这不覆盖上述历史失败，也不代表随后发现的隐私反例已经修好。最终包仍须在必要修复冻结后重新绑定源码与实际ASAR。

Root随后执行的[当前伙伴单元集合v4日志](../../artifacts/cognition-validation/companion-unit-final-v4.txt)与[机器结果](../../artifacts/cognition-validation/companion-unit-final-v4.json)已复核：实际219文件全部通过，2573/2573、success=true，Root记录exit0、417.67秒。Vitest的269 suite包含describe分组，不能当成269文件；这是单元集合，不替代E23的worker发现回归、真实模型语义、最终包或随后必要修复。

随后[记忆库重构后的全仓 TypeScript](../../artifacts/cognition-validation/typecheck-memory-library-registry-contract-final.txt)已实际退出0，修复了新测试的可选 `limit` 核对与另一并行夹具的配置类型问题；它仍只代表对应时点的静态检查。

## T-001～T-014：创建、类型与来源

| 编号 | 当前入口 | 证据判断与边界 |
| --- | --- | --- |
| T-001 创建封存 | [creation](../../src/companions/creation-store.ts)、[profile](../../src/main/companions/asset-profile.ts) | E1／2／7／12／13：双UUID、起点封存、提交前不可用、真实UI／worker新建；按钮关闭不是唯一成功凭据。 |
| T-002 创建后只读 | [profile拒写](../../src/main/companions/asset-profile.ts)、[档案](../../src/renderer/companions/CompanionCognitionDossier.tsx) | E1／2／7：profile／prompt／人工记忆编辑退出，运行配置与形象按权限更新。工程机制有证据，非人格质量证明。 |
| T-003 外改封口 | [Registry](../../src/main/companions/artifact-registry.ts)、[live](../../src/main/companions/memory-live-files.ts) | E1／4／6／12：hash／版本、缺失不SQL回填、链接／外改拒绝；恢复不覆盖未知字节。不是OS禁止用户改文件。 |
| T-004 副本隔离 | [恢复测试](../../tests/worker/companion-recovery-package.test.ts) | E1／2／12：合法模板显式创建新身份／新封存，放回旧日记不获登记；历史恢复与模板创建是不同操作。 |
| T-005 显式类型 | [artifact合同](../../src/shared/companion-artifact.ts)、[类型域](../../tests/worker/companion-memory-type-domain.test.ts) | E4／6／7：不按目录猜类型／owner／权限，新正文有版本与来源准入。 |
| T-006 未知目录 | [library](../../src/main/companions/memory-library.ts)、[学习准入](../../src/main/companions/learning-source-admission.ts) | E1／8／12／16：无自动扫描摄取，显式获权阅读可学习，未知文件本身不成认知依据。 |
| T-007 来源与副本 | [source files](../../src/main/companions/memory-source-files.ts)、[SourceAccess](../../src/companions/source-access.ts) | E6／7／12：原文hash／修订及host行为域；副本不造新sourceId，历史同字与严格native版本职责不同。 |
| T-008 派生防回流 | [消费者](../../src/shared/companion-artifact.ts)、[growth](../../src/main/companions/growth-service.ts) | E4／5／7：日记、知识、自我认识、导航、梦、历史分型，按原始闭包计支持；长期联合语义仍看T-039。 |
| T-009 消息／执行分离 | [host receipt](../../src/companions/host-behavior-receipts.ts)、[执行准入](../../src/companions/execution-source-access.ts) | E7／8：正式消息和宿主完成回执核验，草稿／总结／模型自述不当成功。 |
| T-010 批次编码 | [memory-model](../../src/main/companions/memory-model.ts)、[capture](../../src/companions/memory-store.ts) | E7／9／18：选择性批次日记，并非逐消息必写；共享批次、失败拆单、空产出分结算。 |
| T-011 追加／更正 | [history](../../src/main/companions/memory-history-files.ts)、[修订测试](../../tests/worker/companion-memory-source-revision-files.test.ts) | E6／7／19：准确当前／历史与迟到CAS；广泛数字、否定、未决计划的真实保真仍需S评测。 |
| T-012 知识层次 | [knowledge](../../src/main/companions/knowledge-evidence.ts)、[learning](../../src/main/companions/learning-goal-service.ts) | E8／16：读取、理解、方法、自测、整合分层；4/4小样本正证据不外推为广泛或间隔“掌握”。 |
| T-013 本人立场 | [growth](../../src/main/companions/growth-service.ts)、[host行为](../../src/shared/companion-host-behavior.ts) | E5／17／20：本人实践与玩家期待／教材区分；v6正式发布保留一次反馈的条件与未知，不把目标直接当已内化；人格行为因果仍不足。 |
| T-014 可见域 | [source](../../src/companions/source-access.ts)、[片段编译](../../src/main/companions/asset-context.ts) | E4／5／6／7／19：私聊／群／世界、作者、来源及片段audience隔离，不能以模型称呼推断作者。 |

## T-015～T-023：培养、人格与处境

| 编号 | 当前入口 | 证据判断与边界 |
| --- | --- | --- |
| T-015 培养目标 | [goals](../../src/companions/growth-store.ts)、[UI](../../src/renderer/companions/CompanionGrowthGoals.tsx) | E2／5／7：具体反馈有正式消息／版本，只表示未来练习；目标到实践语义效果仍看T-044／046。 |
| T-016 调整／暂停／结束 | [目标测试](../../tests/unit/companion-growth-goals-ui.test.tsx) | E2／5：UUID／CAS，暂停编辑仍暂停、结束不可同ID复活；真实HTTP核对方向过滤，profile不即时改变。 |
| T-017 表达练习 | [goals UI](../../src/renderer/companions/CompanionGrowthGoals.tsx) | 目标／候选／发布分开；E17未形成有效人格增量，不宣称无提示语气迁移通过。 |
| T-018 唯一当前人格 | [fragments](../../src/main/companions/persona-fragments.ts)、[编译](../../src/main/companions/asset-context.ts) | E2／4／5／12：唯一当前正文与准确片段进入请求，历史不并行充当当前；真实自然行为因果仍未完成。 |
| T-019 条件／反例 | [growth](../../src/main/companions/growth-service.ts) | E5／18／19有局部替代、no_change、保留有效部分的合同；多主题真实反证S评价未完成。 |
| T-020 无新证据稳定 | [coverage/checkpoint](../../src/main/companions/growth-service.ts) | E5／20：原始闭包coverage、已付输出复用；跨天低空转与长期资源待T-036。 |
| T-021 去心理分数 | [定性experience](../../src/shared/companion-current-experience.ts)、[世界UI](../../src/renderer/companions/world/CompanionWorld.tsx) | E1／2／7：旧心理数值退出，改为有来源自然描述；客观精力／时钟保留，非心理测量效度证明。 |
| T-022 旧字段扰动 | [state model](../../tests/unit/companion-state-model.test.ts)、[disturbance](../../tests/worker/companion-state-disturbance.test.ts) | 有旧appraisal／PAD拒绝和扰动反例，不借兼容器恢复评分；最终生产依赖仍须冻结核对。 |
| T-023 当下／长期 | [state-context](../../src/main/companions/state-context.ts)、[clock](../../tests/worker/companion-state-clock.test.ts) | E7／8支持处境、再评估和人格分离；短期感受影响自然表达而不永久改性格的S轨迹未完成。 |

## T-024～T-040：上下文、撤回、恢复与维护

| 编号 | 当前入口 | 证据判断与边界 |
| --- | --- | --- |
| T-024 用途／身份 | [asset-context](../../src/main/companions/asset-context.ts)、[manifest](../../src/main/companions/asset-profile.ts) | E1／2／3：显式purpose、身份一次、native模板专用、处理器职责；不声称所有用途均实际调用模型。 |
| T-025 实际快照 | [snapshots](../../src/main/companions/context-snapshots.ts)、[UI](../../src/renderer/companions/CompanionActualContext.tsx) | E2／3／7：最终真实body、每attempt状态；当前预览不冒充历史发送，本地HTTP不是外部语义质量。 |
| T-026 排队／继续版本 | [model](../../src/main/companions/model.ts)、[transport tests](../../tests/unit/companion-context-snapshots.test.ts) | E3／7／10／18：排队后source／profile／epoch再准入，prepared不当sent，修复根链保持身份。 |
| T-027 完整／隐私 | [snapshots](../../src/main/companions/context-snapshots.ts)、[images](../../src/main/companions/public-profiles.ts) | E1／2／3：可读body、工具／视觉清单、无key、owner／撤回；hash不代正文，大输入明确容量或准确引用。 |
| T-028 并发／迟到 | [Registry](../../src/main/companions/artifact-registry.ts)、[growth](../../src/main/companions/growth-service.ts) | E4／5／7／19：CAS／读集／UUID，不按模型结束顺序覆盖；未冻结，不声称全部组合穷尽。 |
| T-029 崩溃／恢复 | [outbox](../../src/main/companions/memory-history-files.ts)、[recovery](../../src/companions/recovery-package.ts) | E3／7／12／13／25：durable发布、stage重建、真实worker／App重启、准备回忆有界恢复及缺DB恢复；不是逐机器指令均已强杀，也不声称未耐久模型结果绝无重复HTTP。 |
| T-030 不同结算 | [jobs UI](../../src/renderer/companions/CompanionGrowthJobs.tsx)、[control](../../src/shared/companion-job-control.ts) | E7／9／11／20：no_change、待依据、失败、unknown、parked／abandoned区分，放弃不假成功；产品额度场景退出。 |
| T-031 撤回全阶段 | [snapshots](../../src/main/companions/context-snapshots.ts)、[withdrawal](../../src/companions/memory-withdrawal-store.ts) | E3／7／19覆盖排队、在途、派生SQL、正文及依赖；E12阻旧包绕过，已发HTTP不宣称从提供方抹除。 |
| T-032 不复活旧立场 | [profile repair](../../src/main/companions/asset-profile.ts)、[growth](../../src/main/companions/growth-service.ts) | E5／19／20：退役片段／原始闭包保留有效部分，剩余贡献需正式重验，不回起点／旧立场；长期S仍独立。 |
| T-033 新协议备份／副本 | [恢复协议](companion-recovery-protocol-2026-10-28.md)、[实际测试](../../tests/worker/companion-recovery-package.test.ts)、[派生checkpoint缓存撤回](../../artifacts/cognition-validation/recovery-checkpoint-cache-withdrawal-v2.txt) | **新增工程矩阵已执行，E12／13／21。**包外权威、当前ticket完整恢复、后写／撤权使旧包失效、现SQL准确文件修复、旧格式拒绝、模板不吸旧经历、来源／历史／话题held原row保全及旧CAS拒绝。缓存反例首轮1选中通过／19未跑，后纳入E21四组34项同轮通过：旧包含已验证DAG／owner_reads／ACL绑定，非尾源撤回后仍拒缺DB旧包；当前包恢复并显式激活后Alice旧head不可见、Bob范围不变。丢fence不重建，不是任意历史包可灾备／安装包证明。 |
| T-034 实库清空／新协议 | [CLI](../../scripts/companion-managed-cleanup.mjs)、[空库收据](../../artifacts/cognition-validation/actual-empty-production-store-verification-2026-10-28.json) | **实际限定步骤已完成，E14／15。**v3-final hash为 `732399076c64c3edfcb1484aa5e4bc398f958b8d42b1a801c813b7762961abb7`；新库0身份等，玩家、未知wav、密钥、library.db保留。新建／重启在临时库验证，不重复清实库。 |
| T-035 真实增长有界 | [实际事件规模入口](../../tests/worker/companion-cognition-event-scale.test.ts)、[v1](../../artifacts/cognition-validation/cognition-event-scale-v1.txt)、[v2](../../artifacts/cognition-validation/cognition-event-scale-v2.txt)、[v3](../../artifacts/cognition-validation/cognition-event-scale-v3.txt)、[v4](../../artifacts/cognition-validation/cognition-event-scale-v4.txt)、[v4完整收据](../../artifacts/cognition-validation/cognition-event-scale-v4.json)、[字节观测合同](../../artifacts/cognition-validation/owner-scale-wire-observer-contract.txt) | **未通过。**v1发现旧world.defer失效回调错误；v2败于夹具无生产依据的80消息假设；v3败于HTTP观测逐chunk解码损坏UTF8，相关确定性反例保留。v4首1k真正通过：完整事件审计、三任务、准确wire／快照／profile一致，最大254793B／138条近期消息／摘要28字。10k原事件也已完整审计，但约42次前台topic压缩追平9k欠账使三任务超过原180秒观察窗；最后已见实请求217917B／68条消息，容量有界而等待未达标，不能算该阶段通过。四次原失败和源码冻结均保留；100k尚未运行，不冒充10万条已编码记忆或语义质量，不提高生产容量或静默加长观察窗。 |

T-035 的 [v5取消收据](../../artifacts/cognition-validation/cognition-event-scale-v5-background-producer8.cancellation-summary.json) 与[原始现场](../../artifacts/cognition-validation/cognition-event-scale-v5-background-producer8.json)另行保留：独立确定性测试确认 source／history 全 owner drain 会阻塞无关前台请求后，Root 要求停止旧冻结构建，分类为 **cancelled_known_HOL，不作整门通过或失败**。停止时已在 actual Main／Utility／Gemma／VCP 的 event_scale 阶段，不能称为“只在build停”。原现场1k三任务曾完成（seed12.50秒、probe57.18秒、后台topic请求4／前台0）；10k还在写入，100k未运行。准确PID／creation／进程树核验后仅停止本次12个进程；冻结Main／worker字节未变。原始SQLite保留7160条独立事件，7152条提交回执与请求／返回tuple／哈希完全吻合，另8条属于强制停止时已提交但未记返回的在途边界；全部SQL、逐条JSONL、原报告和临时现场保留。读审计v1误将Buffer原始哈希与其JSON表示哈希比较，v2已用独立原始文件哈希证实数据库未变，原误判也保留。下一轮不得继承这些部分结果跳过任何1k／10k／100k阶段。
| T-036 多伙伴资源 | [公平队列](../../src/main/companions/model-quota.ts)、[VCP](../../src/main/companions/vcp-runtime.ts) | **100 owner两小时编排／资源基线已执行，E24。**真实Main重启、241样本、三活跃owner推进及97空闲不驻native有凭据。不是1000活跃owner或最终新构建基准；完整延迟分位与持续GPU／磁盘峰值仍不能从采样外推。 |
| T-037 阶段续跑 | [structured-agent](../../src/main/companions/structured-agent.ts)、[growth](../../src/main/companions/growth-service.ts) | E3／7／10／18／20／25：已确认阶段复用、取消／429／重启／来源变化；已耐久output继续finish，不自动换attempt，不恢复额度限制。 |
| T-038 独立维护 | [world](../../src/main/companions/world-service.ts)、[growth](../../src/main/companions/growth-service.ts) | E7／8／18有清醒、睡眠／梦、失败独立结算和反思；真实长时触发频率与低空转待资源试验。 |
| T-039 派生防自证 | [typed scope](../../src/shared/companion-memory-scope.ts)、[coverage](../../src/main/companions/growth-service.ts) | E4／5／7／19：按真实闭包而非派生条数，导航／梦／历史不冒充事实；长期联合语义轨迹未完成。 |
| T-040 梦后检验 | [dream](../../src/main/companions/dream-wave-model.ts)、[测试](../../tests/worker/companion-dream-wave.test.ts) | fiction、至多3个调查提议及获权原文检验有机制；真实支持／反证／条件内化S未通过，contains命中不当假设成立。 |

## T-041～T-048：语义和发布硬门

| 编号 | 当前证据 | 未满足门 |
| --- | --- | --- |
| T-041 A/B/C预登记 | E17 v6完成真实native三组登记试验；B／C同源同typed回忆、C正式发布且实请求采用。 | **因果语义门未通过。**A／B／C都已能通过通用自然闲聊／复杂任务rubric，v6不足以区分学习带来的行为增益；保留insufficient_evidence，不重复付费挑选轨迹。 |
| T-042 回忆保真／弃权 | E6／7及真实正负小样本。 | **完整S门pending。**多作者、否定、更正、未决计划、无答案及撤回语义评分未统一完成。 |
| T-043 知识保持／应用 | E16四题全部hostPassed、typed召回／准确body。 | 小样本正证据，不外推为间隔保持、任意错误材料、重启保持或盲化因果对照均通过。 |
| T-044 人格轨迹 | E17 v6一次真实交流→正式经历→独立反思→有条件人格变更已观察；v3～v5失败保留。 | **pending。**一次可追溯发布不等于稳定习惯；多起点、多独立经历、无提示自然语气／选择与反证轨迹未合格，不能称复现人类成长曲线。 |
| T-045 发布因果消融 | E17 v6同训练历史／回忆readset、目标暂停，只有C正式人格变化。 | **未通过。**incrementalProfileEffect=false；两组实际回答同样达标，尚无可归因于当前人格的盲化增益。 |
| T-046 三类共同成长 | 各通道实现、E16知识四题与E17人格正式发布局部证据。 | **pending。**知识v4与人格v6不是同条合格联合长期轨迹，不能相加为共同成长质量通过。 |
| T-047 可观察性 | E2／11／12／13：语义档案、培养、具体事件、精确请求、分页处置和全局恢复，真实宽窄深浅。 | 开发UI主要机制已验；候选／目标／数量／indexReady不当学会。最终安装构建的综合复验仍待T-048。 |
| T-048 打包发布 | E26的最新attempt5包含file-readiness／文件HOL／Registry精确隔离修复，完整静态稳定后真实重建；native／资源及四项ASAR均通过，准确hash／worker／隔离profile绑定。 | **本冻结的构建、资源与四项实际ASAR门已完成，整体发布仍pending。**安装／更新及全部语义、规模硬门尚未统一结清；最终Main／worker广集另按当前冻结及真实结果验收，不能由四项UI门替代。开发、包2／包4、失败／取消与本轮包5证据分别保留。 |

## T-049～T-057：结构修复与失败治理

| 编号 | 当前入口／证据 | 判断与边界 |
| --- | --- | --- |
| T-049 全局修复 | [model](../../src/main/companions/model.ts)、[contracts](../../src/main/companions/structured-contracts.ts)；E3／7／10／18 | 准确原输入、坏输出、结构错误交全局模型；可与原作者不同，修复后仍过原来源／权限／版本。v9有真实成功，不保证所有领域均能修好。 |
| T-050 次数／公平 | [repair](../../src/main/companions/structured-repair.ts)、[队列](../../src/main/companions/model-quota.ts)；E3／7／18 | 子修复≤2，原作者循环不重置上限，前台能在后台修复未完时完成；无产品费用／用量阻断。 |
| T-051 durable／守恒 | [agent](../../src/main/companions/structured-agent.ts)、[run-store](../../src/companions/agent-run-store.ts)；E7／18 | 次数、准确rootContext及成功字节耐久绑定，重启复验，不重放确认工具；显式领域数组／重复／已知值守恒，合法空值不强填。 |
| T-052 真实链／结果 | [frame](../../src/shared/companion-cognition.ts)、[UI](../../src/renderer/companions/CompanionActualContext.tsx)；E2／3／17／18 | root／previous／attempt／purpose及实际body可查，unknown不自动重发、撤回整链，失败／空产出不被最后成功抹去。 |
| T-053 持久搁置 | [control](../../src/companions/job-control-store.ts)、[schema](../../src/shared/companion-job-control.ts)；E7／8／9 | 每周期3次真实失败park；等待模型／文件、取消／失效不计；显式resume只清cycle，lifetime保留，普通wake不解封。 |
| T-054 明确放弃／幂等 | [UI](../../src/renderer/companions/CompanionJobControls.tsx)；E9／11／12／13 | 明确确认、owner／input／revision／UUID；不删事件、不假成功。旧CAS失效、旧receipt不改新周期或误取消新signal。 |
| T-055 队头／生产适配 | [processing](../../src/companions/memory-processing-store.ts)、[world](../../src/companions/world-store.ts)、[asset jobs](../../src/companions/learning-asset-jobs.ts)、[话题作业](../../src/companions/topic-compaction-job-store.ts)；E7／8／9／20／21／27 | 当前11kind分别使用真实生产队列，覆盖坏事件与50个后续、同批兄弟恢复／watermark、来源与历史逐文件故障、话题逐块让出与已知失效的耐久自动重核。暂停scope不能占住后续合法重核队头，held不进入自动解封。UI手动park夹具不冒充连续3失败完整E2E。 |
| T-056 超50分页 | [paged UI](../../src/renderer/companions/CompanionJobFailures.tsx)；E9／11／13／21 | 131作业及63事件UI，owner／kind／state／keyset，显示窗口60；含来源／历史／话题整理共11kind选择，不开故障区不后台扫描全部kind，不列表N+1读取原事件，显式详情再核可见源与准确话题。 |
| T-057 未知／局部失败 | [growth](../../src/main/companions/growth-service.ts)、[Registry恢复](../../src/main/companions/artifact-registry.ts)；E7／8／12／18／20 | 未知待核对／park、确认输出复用；单项失败不以共享失败Promise堵独立作业，恢复不自动重发，历史receipt不假称当前仍是旧状态。 |

## 最后定向收尾证据（2026-10-29）

| 证据 | 实际结果与范围 |
| --- | --- |
| E32 准确人格启动恢复 | [冻结收据](../../artifacts/cognition-validation/growth-exact-pending-writer-freeze-v16.json)。原始反例中八个较新无关stale确实遮挡待提交的已付费人格。修复改为准确persona当前版本的pending writer索引，再定位唯一检查点；不扩大状态页、不扫描全伙伴。最终7项短门通过，30.52秒；来源变更／撤回、无pending、park／abandon及累计计数保持原语义，生成只调用原一次。恢复错误转typed ArtifactError，适用Main既有逐owner隔离；不是新跑整库Main。两文件lint及定向TS通过，原RED和中间测试顺序误判保留。 |
| E33 成长历史分页 | [冻结收据](../../artifacts/cognition-validation/growth-history-pagination-short-freeze-2026-10-29.json)。首屏20条，续页按准确Registry keyset逐正文核验；归属、类型、版本、hash与撤回epoch均核对。换owner／人格／首屏版本或撤回epoch时丢弃旧分页与迟到结果，读中撤回返回失效页并清旧UI。最终2文件16项通过、4.18秒，六文件lint通过；服务case使用隔离mock Registry适配器，复用已有SQL分页，没有伪称重跑真实大规模或ASAR。 |
| E34 短检查与长测撤销 | [28项短检查](../../artifacts/cognition-validation/long-test-withdrawal-short-check-2026-10-29.json)，3文件通过、4.54秒；仅编译／模拟提供方结构修复／小型事件回执。长测入口及旧广集启动器已撤除，原文惰性封存及原始失败保留。[取消与保留汇总](../../artifacts/cognition-validation/long-real-tests-removed-2026-10-29/final-withdrawal-summary.json)。 |

## 2026-10-29 用户调整后的验证范围

用户明确要求不再运行时间超长的真实测试，并撤除相关入口。本节覆盖本文早期关于“必须再跑两小时／100k／真实模型多轨迹才可完成”的计划措辞：这些长测已撤销，不再是后续开发或交付前置条件。保留短时定向机制检查、类型检查和必要的有限故障注入；不自动运行全部广集或重复打包。历史证据和原判保留，取消不记为通过。

- 正在运行的T036 v2已按精确PID、创建时间和QA子树取消；临时库、现场报告与取消凭据保留，原有进程已退出。[停止收据](../../artifacts/cognition-validation/multiowner-newprotocol-two-hours-v2.cancel-request-2026-10-29T00-42/stop-receipt.json)。
- T035 v6原30分钟观察门超时，实际1k／10k阶段通过而100k未完成。85423条成功返回凭据独立核验无重复或哈希差异，但原始临时DB未保留，不补称完整SQL审计。[独立凭据审计](../../artifacts/cognition-validation/cognition-event-scale-v6-independent-receipt-audit.json)。未启动的v7与人格后续真实模型实验均撤销。
- 人格启动恢复先有三文件38项及类型检查通过的[v13窄修](../../artifacts/cognition-validation/growth-publication-startup-freeze-v13.json)，后续最终准确writer恢复与历史分页分别见E32／E33。未再启动Native或付费实验。ASAR包5早于这些最后源码修复，不能称它包含最终源文件。

## 调整前的缺口记录（历史范围，长测不再待执行）

1. T-035真实1k／10k／100k原始事件整门尚未通过；此前v4只有1k三probe及10k原文审计，10k前台摘要阻塞已有E27修复但最终大规模复跑未完成。后续v5因已确认的文件发布HOL缺口[准确取消](../../artifacts/cognition-validation/cognition-event-scale-v5-background-producer8.stop-receipt.json)，[取消摘要](../../artifacts/cognition-validation/cognition-event-scale-v5-background-producer8.cancellation-summary.json)与原始记录保留，不算通过。T-036已有E24两小时基线，通过版本早于新后台lane／guard，不把基线或元数据规模当作最终版本长时吞吐证明。
2. T-041～046的长期语义、保持、人格迁移与因果门仍有缺口。知识E16仅小型合成正例；人格v6已有正式发布／采用，但增量因果证据仍不足；早期v3失败与v6不足都保留。后续预登记须先冻结新夹具及盲评，不能用E27机制通过代替真实语义结论。
3. T-048最新包5已在稳定冻结v6上真实4/4，包含文件发布HOL与Registry隔离实现，构建、资源、前后指纹和退出收据均在E26；包4及更早证据保留。最终Main／Worker／Unit仍按各自当前冻结和实际执行结果验收，旧完整绿或本轮四项UI门都不能替代新复跑及尚缺的规模／语义门。
4. T-029逐机器故障窗口、所有外部提供方和任意规模没有穷尽。T-033仅支持有当前宿主凭据的整库恢复，不把丢权威时重建、过期包回滚或仅修正文包装成完整灾备。

实际清理和新空库不再是“尚未执行”，也不能依据历史基线重复清理真实库。工程具备正式、可审计的逐步认知形成／发布基础；目前没有证据保证人格成长质量达到经验证的人类心理发展模型。
