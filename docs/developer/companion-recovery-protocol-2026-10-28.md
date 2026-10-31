# 新协议伙伴备份与恢复

本页描述 2026-10-28 工作区的实际实现与已执行的隔离验证，对应[主规范](companion-cognition-refactor-standard-2026-10-28.md)及[验收 T-033](companion-cognition-acceptance-2026-10-28.md#t-033-新协议备份恢复副本与撤销凭证)。它不表示安装包、长时资源或人格学习质量已通过。

## 权威与包的边界

伙伴账本位于所选资产库的 `.worldlinebox/companions/messages.sqlite`；包外宿主权威是 `.worldlinebox/companions-recovery-authority.sqlite`，并有 `companions-recovery-enrollment.json` 登记。包内没有这些权威文件，也不能根据旧包重建它们。库身份由宿主选择和实际 `library.db` 核对，账本文件身份、谱系和水位也必须匹配。

[recovery-fence](../../src/companions/recovery-fence.ts) 使用一个常驻连接及固定权威行。所有实际 Store 子组件共用受管连接，实际 SQL 写入在主事务提交前推进包外水位；失败时不让主写入静默提交。不会为每条消息重新连接或计算全库 hash。预提交中断只保守推进不透明水位，不恢复旧正文。

因此，**完整账本恢复只接受仍有当前宿主凭据的准确包**。备份以后有实际写入，旧包便不能回滚 SQL。这是一项保守恢复政策，不能被解释成任意历史备份都可灾难恢复。丢失独立宿主权威时也明确拒绝，不创建替代权威。当前文件修复是另一种模式，不能充当整库恢复。

## 实际备份

[Main 入口](../../src/main/companions/recovery.ts) 在宿主独占停止执行后使用专用 worker。[worker](../../src/companions/worker.ts) 同时停止自己的索引／退役计时器并拒绝并发请求。合法 queued／failed／parked／abandoned 作业可以随原 SQL 备份，包括来源和历史文件发布任务；其未发布正文不补造为正式文件。正式 Registry 的 prepared／validated／file_published 状态、来源／历史作业的 running 或未释放 lease，以及未完成退役仍拒绝备份。

[recovery-package](../../src/companions/recovery-package.ts) 使用 SQLite 原生 online backup、64 KiB 分块复制与 hash、逐项 NDJSON 索引，不把整个 SQL 或正文包读入 JavaScript 内存，也不设置 128 MiB SQL 总量限制。

包是一个新建目录，包含 `manifest.json`、`ledger.sqlite`、`catalog.ndjson`、`files.ndjson` 和按内容 hash 命名的 `objects/`。只有正式登记正文、SQL 管理的附件和可核验的当前形象回执／图片进入文件索引。未知目录、密钥文件、共享 DSH 目录不扫描或收集；外部文件引用保留引用，外部字节不自动复制。版本、hash、路径、owner、单项结构和链接均核验；字节变化或后续 SQL 写入使备份不能获得新的恢复凭据。

完成凭据绑定原操作及保存位置的负载 hash。丢失回复后，同一个 UUID 可以核对先前已完成的备份；有新写入时只返回历史完成凭据，不假称旧包仍可回滚当前账本。

## 两种恢复

| 模式 | 实际行为 | 明确拒绝或不执行 |
| --- | --- | --- |
| `database` | 普通 worker 关闭后，在独立恢复子进程中校验当前包、SQL 协议／完整性／外键及宿主水位，再恢复缺失账本。 | 不覆盖现存不同账本，不接受过期包、旧格式目录、跨库包或缺失宿主权威。 |
| `current_files` | 保留现 SQL，只补回当前正式登记的准确缺失正文，并重新核对 live owner、非退役状态、来源／依赖版本及真实 SourceAccess 可见性。 | 不覆盖外改字节，不补回撤销对象，不回滚 profile；保守 owner-epoch 的运行快照／日志等不透明历史 payload 不从旧包重建。 |

完整恢复先耐久登记 `pending=2` 与操作 UUID。恢复 SQL 暂存只能从不可变、ticket 绑定的原包构建；中断后的准确重建使用固定宿主时间，不能仅凭一个看似正确的 SQL marker 接纳任意暂存库。文件以独占原子发布进入目标；中断留下的准确两链接对有专门核验，未知字节或无关链接保留冲突。普通 Store 在未完成恢复期间拒绝启动。

恢复后，[recovery-hold](../../src/companions/recovery-hold.ts) 将原任务搁置或中断，清实际 lease／自动续跑标记，保留原输入、已有结果、失败／尝试累计及资料授权。SQL 处理域及材料作业的管理修订均推进，包含来源／历史文件发布和原已 parked／abandoned 项，恢复前的 CAS 令牌不能控制新恢复状态。旧控制 UUID 重放只核对历史回执，不改当前作业。

所有伙伴先保持休眠，`recovery.review.page` 按主键范围分页读取待核对身份。Main 经[人格检查点恢复冻结](../../src/main/companions/growth-service.ts)后，worker 还实际检查 SQL 作业已 held、JSON／标量状态一致、原发送不自动续跑，才清复核门。清门不自动激活伙伴，恢复也不等于原发送已成功。

## 用户入口

[全局资产库栏](../../src/renderer/companions/CompanionWorkspace.tsx)提供[备份与恢复面板](../../src/renderer/companions/CompanionRecoveryPanel.tsx)，不依赖联系人存在或普通 Store 能初始化。包预览走独立只读子进程；没有账本时仍可检查当前宿主凭据。

选择目录、只读预览、执行确认各分开。写操作包含明确的库 ID，后台复核选择范围。UI 先耐久保存操作 UUID／负载，再发请求；丢回复后重开面板不自动重发，只有明确点击才重试同一操作。旧包不能回滚、历史回执和仍需核对的状态都如实展示。授权备份期间的只读轮询保留当前画面，不把正常暂停显示为初始化失败；明确的用户操作仍解释暂停原因。

一次性旧开发数据清理工具在检测到新系统权威或登记后拒绝 plan／execute，不删除 fence 来重建新库。后续清理应使用正式退役或另选资产库。

## 已执行的验证与限制

| 证据 | 实际覆盖 |
| --- | --- |
| [30 项集成](../../artifacts/cognition-validation/recovery-integrated-final-v4.txt) | 真实 SQLite、受管正文／来源／历史／附件往返；旧包在撤权／新写入后拒绝；当前准确文件修复、外改保留、错库／坏包／丢权威拒绝、stage 中断重建、原子发布恢复、旧 parked 令牌失效、旧格式拒绝及显式模板副本不吸收历史。包括真实 UtilityProcess 与六项 UI 反例；各集合不能再相加。 |
| [文件作业治理后的 32 项恢复回归](../../artifacts/cognition-validation/recovery-file-publication-governance-final-v2.txt) | 前述四组重新执行，新增两个真实 SQLite 反例：来源／历史各 parked 与 abandoned 原 row 随包保全、恢复修订前进与旧 CAS 拒绝；原消息保留，未发布正文不伪造；两类真实 running lease 都拒绝备份，等待释放后准入。 |
| [严格 IPC 回归](../../artifacts/cognition-validation/recovery-utility-strict-envelope.txt) | 完整 workspace command 的额外 `type` 不能覆盖 worker 启动协议。此前实际 UI 失败保留在 [v4](../../artifacts/cognition-validation/recovery-electron-ui-v4.txt)。 |
| [实际 Electron 两项](../../artifacts/cognition-validation/recovery-fault-electron-final.txt) | 备份后正常消息发送；准确 profile 修复；缺 DB 全局检查并完整恢复、伙伴休眠／旧作业 held；宽窄／深浅与横溢出；63 条故障分页和明确放弃保留原事件。参见[备份 UI 收据](../../artifacts/cognition-validation/recovery-electron-ui-proof.json)。 |
| [旧清理工具保护](../../artifacts/cognition-validation/cleanup-enrolled-authority-gate.txt) | fence／enrollment 两种存在情形均在 plan／execute 前拒绝，原账本及宿主文件保持。 |

这些是隔离工程证据。实际用户空库没有被本轮备份／恢复测试打开；没有调用模型、恢复旧额度表、把目录当认知源或把候选当人格。尚不据此声称任意规模／任意故障点／安装包恢复均已测完，也不证明长期人格演化的心理学效度。来源被撤销后，旧离线包不能绕宿主恢复门；系统不能把用户自行保存的离线副本宣称为已经物理抹除。
