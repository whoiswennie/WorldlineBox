# Super Agent 伙伴系统开发记录

截至 2026-11-03，源码、原生恢复、独立 VCP 与正式 DeepSeek 全链已有通过结果，最终顺序单测 236 项通过 / 6 跳过；最终 Windows package、新产物 4 项 E2E 与 primary profile 启动核对仍待验收，长期目标保持 active。凭据加密保存，日志不记录密钥。下列 11 月 2 日内容保留为当时的阶段记录，最新结论见末尾 11 月 3 日验收及[更新后的完成度审计](superagent-bot-completion-audit-2026-11-02.md)。

## 开发约束

- 用户已授权清理旧伙伴资料、聊天和记忆；不做迁移、双写和旧运行时 fallback。
- 保留无关资产、DSH 任务、模型配置和工作区已有通知 UI 修改。
- 首版应用内多来源；IM 与手机只预留接口。
- 用户允许用临时文本模拟 LLM 验证流程。模拟服务只在隔离测试中启用，正式应用仍读取原全局模型配置。
- 协议流程、真实模块、真实模型内容质量、安装资源分别验收，不互相替代。

## 2026 年 11 月 2 日

- 已建立长期目标，状态为 active。
- 已拆分事件存储与调度、DSH 接入、VCP Memory 三项并行开发。
- 应用整合负责者实施新 IPC、流式聊天 UI、内置模型桥接和旧运行入口退出。
- 新前后端协议已替换旧伙伴入口；SQLite Inbox/Outbox、来源幂等、同 lane FIFO、跨 lane 并发、lease 与恢复已接通。
- 已将应用伙伴入口接到新 BotService 和 BotWorkspace；旧 CompanionService 启动、认知档案和旧存储 Worker 构建入口已退出。
- 当前定向本地测试 19 个文件、135 项通过；3 项需要显式启动原生 Host 的测试默认跳过，不能算通过。另有保留的 DSH／浏览器集成 17 项通过。证据：`artifacts/bot-refactor-2026-11-02/bot-local-tests.log` 和 `retained-integrations-tests.log`。
- 实际 Electron UI 验收通过，覆盖新伙伴、持续私聊、群聊和未配置主脑时的真实错误提示。
- 真实官方 DSH 0.2.1-rc.5 的协议集成已跑通原生主脑、记忆工具接续、两个 lane 并行、冷重启去重和 worker 写文件。模型协议夹具不作真实质量结论。
- 独立 VCP 使用 Node 24.15 ABI137 单独安装依赖；453 文件与源哈希一致，405 个原始 VCP 文件完整。SQLite、Vexus、CDS、RAG、OneRing 及内置 768 维向量接入已有真实模块证据，无重复 embedding 模型资源。
- 全项目 TypeScript 与扩展项目检查通过。完整检查使用 8GB Node 堆，未把此前默认 4GB OOM 计作通过。
- 当前原生代际默认在 128 个终态 turn 或累计 512KiB 输入输出后，经 DSH 官方 compaction/handoff 交接；UI 会话 ID 不变。交接可能调用模型，失败保留旧代际。
- 未知投递按相同 event ID 与冻结输入恢复，重试间隔封顶 30 秒。取消先 fence 发布，再凭原生终态或明确 absent 核实；任务重启不会重新提交已请求取消的 prompt。
- 任务确定失败与来源通知事务提交；指导具有稳定 requestId 和待投递意图，重复 ID 的不同正文拒绝。
- 新 UI 已接回 Markdown、代码块和图表；新世界状态驱动原 Three 美术与 2D fallback。当前两项 Electron 测试和生产 Vite 构建通过；软件 WebGL 截图不证明硬件帧率。
- 最新与历史消息窗口均最多 400 条，支持新消息提示、回到最新和阅读锚点；完全没有重叠的新页不会拼成假连续历史。19 项 UI 组件测试覆盖相关竞态。
- 伙伴消息、任务回执与世界动作继承因果链预算，6 层后停止创建新工作；用户新输入重新建立预算。已覆盖任务自触发、世界双 actor、物理 arrival 和启动后立即关闭。
- 旧认知 registry/publication 链、旧主脑和记忆 Worker、旧独立世界窗、旧 UI 与无效测试／脚本已退出。研究旧源码快照只保留在 artifacts。
- 实际旧数据清理完成：4 个精确目标及旧 locator 均不存在；原 2,133 条 linked assets、旧 linked root 与旧 active assets 只读复核均为零；共享库、Assets、新根和 DSH 保留。证据：`artifacts/superagent-bot-development/legacy-reset-d10b7c8fc721cde7/post-verification.json`。

## 11 月 2 日阶段性集成验收与当时待办（历史记录）

- 完整模拟模型协议链已通过：真实 DSH 0.2.1-rc.5、独立 VCP、内置 768 维向量，覆盖工具接续、自动捕获、实际任务文件、原生代际交接到 epoch 2 与重启，任务数保持 1。结果：`artifacts/superagent-bot-development/protocol-acceptance/result.json`。该次报告中的一项 BOT_SUSPEND 为主动关闭的预期记录；之后已避免将正常关闭记为错误。
- 原生取消与冷恢复专项通过：真实 Host 给出终态和 absent 证明，冷恢复不调用模型。结果：`artifacts/superagent-bot-development/native-cancel-recovery.json`。
- Windows x64 成品构建及 postPackage 门禁已通过，产物为 `out/WorldlineBox-win32-x64/WorldlineBox.exe`。原始 VCP、Node24 原生依赖、唯一内置向量、媒体、便携工具与 ASAR 工具入口均校验通过；旧 vcp-memory-host 不在成品中。
- 首次构建遇到 Windows `.node` 占用，已修为完整校验后复用同版本资源；实际原生插件保持加载时的 455 个文件元数据均未改变。第二次因 Electron 下载 ECONNRESET 退出，之后使用本机校验匹配的 Electron ZIP 完成离线构建。失败记录保留，没有计为通过。
- 上述实际成品的聊天与 3D 世界两项 Electron 测试均通过（16.2 秒），使用独立临时用户目录和空模型配置，未调用用户收费模型。证据：`artifacts/bot-refactor-2026-11-02/packaged-e2e.log`。
- 真实模型早期曾因 HTTP 402 未完成验收。用户后来提供正式凭据后，已通过成品的模型设置 API 加密更新，`deepseek-flash` / `api.deepseek.com` 正式连接测试成功（1,332ms）。凭据未写入报告；真实 Bot 全链与质量验收待后续恢复修复收口后统一执行。
- 未宣称数月运行、所有模型、所有平台、固定延迟或永不丢失历史事实已经验收。

初始框架与模拟协议冒烟已取得通过证据；随后按全量要求进行的[完成度审计](superagent-bot-completion-audit-2026-11-02.md)发现并发 prepared 恢复、首 epoch 交接消费、遗忘退休、原文封存、写入未确认和任务人工输入／未知效果等缺口，当前正在修复，不能把初始通过视为全目标完成。早期成品也必须在这些源码更新后重建。

用户要求的临时文件清理已移除 33 个旧运行目录、2 个可再生接受测试程序及模型配置临时脚本。另两个 `.tools` 目录的清理被自动审批拒绝，理由仅为 `blocked by policy`；这两个目录包含隔离 profile/缓存及复制的美术资源，已停止操作并原样保留，未换方法绕过。精确清单和原拒绝记录在 `artifacts/superagent-bot-development/temp-cleanup-rejected-inventory.json`。正式回归源码、运行模块及脱敏报告保留。

组件职责与命令见[运行说明](superagent-bot-runtime-guide.md)，设计依据见[调研报告](superagent-bot-research-2026-11-02.md)和[实施方案](superagent-bot-implementation-plan-2026-11-02.md)。

## 2026 年 11 月 3 日验收记录

- 已关闭 11 月 2 日表中的主要恢复缺口：群聊迟到 publication 与冻结 prepared 重试、handoff 消费证明、连续原文投影与封存 barrier、未知写入恢复 / 内容冲突拒绝、遗忘 epoch fence、人工问答、未知效果核实及后台进程回收。下面各类证据分别保留，不用模拟结果代替真实模型质量。
- 原生专项使用真实 DSH 0.2.1-rc.5 / Host 和本地模型协议夹具，通过多 lane / LRU 16、原生压缩与 handoff、5 次冷恢复、稳定事件去重、问答及效果状态恢复、scoped 路径 / junction 约束、子 Agent 与后台 shell PID 退出。恢复不额外请求模型，也不把 unknown 当成功或已停止。证据：[native-reliability](../../artifacts/superagent-bot-development/native-reliability.json)、[native-repeat-recovery](../../artifacts/superagent-bot-development/native-repeat-recovery.json)、[native-worker-io](../../artifacts/superagent-bot-development/native-worker-io.json)、[native-descendants](../../artifacts/superagent-bot-development/native-descendants.json)、[native-cancel-recovery](../../artifacts/superagent-bot-development/native-cancel-recovery.json)。
- 独立 VCP 最终 stage / 完整性门禁通过：453 源文件、405 原始文件哈希、246 个生产依赖闭包、Node 24.15 / ABI137。只使用应用内置 EmbeddingGemma2 compact 768 维；managed home 若启用独立 local embedding 则显式拒绝，不下载第二份模型。SDK 常驻 / 域队列 / LRU 与关机、真实 kill 后重建均已有回归。
- 来源撤回补齐到了实际 VCP：A 文件衍生任务通知 C / 自动回复 D，即使已进入旧 episode 和 CDS，也通过 SQL append-only 撤回 outbox 耐久同步；相关衍生日记反查、原始删除回执、episode 重写、OneRing / prepared / cache 与 CDS 同步全部完成后才确认游标。真实进程 exit74 中断时 raw 查询被 fence，冷修复后原文与检索不再回流；空删除回执不算成功。[撤回设计与专项验收](superagent-bot-memory-source-withdrawal-2026-11-03.md)。
- 已取得真实正式模型全链 passed：deepseek-flash / api.deepseek.com、真实原生 DSH 与真实内置向量，errors 为空。包括真实 memory_search 工具回执、自动 capture 的源 ID / 索引回执与时段否定、真实动图发布、唯一委派任务和实际产物、输入文件读取及结果文件发送、冷重启连续性、伙伴间媒体事件与私有事实隔离。压力夹具用 3-turn 阈值达到 epoch3，不冒充默认阈值长期运行。证据：[real-acceptance/result.json](../../artifacts/superagent-bot-development/real-acceptance/result.json)。较早 observer 失败报告和原生异常退出证据仍单独保留，不计通过。
- 最终顺序总表为 **39 文件 / 236 项通过，6 opt-in 文件 / 6 项跳过，49.23s**；跳过不计通过。此前 **235 通过 / 1 原生退出 / 6 跳过**已归档到[unit-native-initial-failure.log](../../artifacts/superagent-bot-development/unit-native-initial-failure.log)。runtime 独立 4 项和整体 236 项复跑均未复现，但 0xC0000409 尚未定位原生模块，不能推断 OOM、改算原失败通过或宣称根因已修复。[诊断记录](../../artifacts/superagent-bot-development/bot-memory-runtime-retry-diagnosis.json)。lint 修正的 25 项定向回归不能重复加总。本项目与扩展类型检查通过，19 项 lint 问题已收口。证据：[unit-final.log](../../artifacts/superagent-bot-development/unit-final.log)、[typecheck-final.log](../../artifacts/superagent-bot-development/typecheck-final.log)、[typecheck-extension-final.log](../../artifacts/superagent-bot-development/typecheck-extension-final.log)、[lint-final.log](../../artifacts/superagent-bot-development/lint-final.log)。
- 真实内置向量的 720 日记、10k / 100k 原始消息规模已实测。100k DeepMemo 热回查 p50 / p95 约 4.58 / 15.85ms，已有索引冷重启首次回查 1.81s；720 日记重复检索约 13 / 16ms，自动 RAG 准备约 97 / 169ms。不是 100k 向量质量 / 性能证明，25 次样本不替代长期分布，RSS 不是峰值；曾失效的重启 JS 探针计数明确剔除并保留原记录。[完整规模报告](superagent-bot-memory-scale-2026-11-02.md)。
- 前端改为紧凑聊天 / 联系人 tab、浅色 canvas、浮动输入框与左右消息气泡，保留有界历史、任务 / 记忆控制、原静态人物和世界素材；全局 rail 的提示位于右侧且点击后收起。**正常气泡截图是人工语料视觉夹具**，不作为正式模型生成这些台词的证据。较早未配置 API 的失败态图也只证明失败态布局。
- 媒体模块独立于资产库和 VCP。4 个内置包共 91 张、57,416,936 原始字节；实际内容为 88 个 animated WebP / 3 个 AVIF，原扩展名 GIF / JPG 不能当格式依据。另有 160px 首帧预览及可读语义元数据；正式模型确实调用表情 / 文件工具，而非只回复“已发送”。[媒体说明](superagent-bot-media-2026-11-02.md)。
- 正式阈值为图片 ≤50MiB、视频 ≤500MiB、音频 ≤200MiB 内嵌。超限 **只登记 metadata 和原路径引用，不读取源字节、不 hash、不 copy、不 decode、不自动交给任务**；SHA 缺省，不伪造。协议读取拒绝，点击系统打开先核验会话 / ID / 元数据；显式保存才复制，用户原始引用文件不属于清理范围。实际 sparse 与禁止 read / open / copy / Sharp 仪表测试通过。
- 源码主窗口聊天 / 世界 / 媒体 3 项 E2E 曾通过，随后媒体专项验证真实 File 拖入、用户包导入、原字节保存、跨会话拒绝、冷 reload，以及 MP4 / WAV 播放 currentTime 推进。[源码 E2E 日志](../../artifacts/superagent-bot-development/ui-source-e2e.log)、[媒体播放专项日志](../../artifacts/superagent-bot-development/ui-media-preview-e2e.log)。**系统选择器可使用测试路径，OS 打开使用 shell.openPath stub，只验证目标和字节，不等于第三方应用真实启动。**
- 清理保留一个明确例外：共 4 个测试临时目标因自动审批返回 blocked by policy 而未删除，未改用其他方式绕过。精确路径及拒绝记录见[原两项盘点](../../artifacts/superagent-bot-development/temp-cleanup-rejected-inventory.json)、[新增两项拒绝](../../artifacts/superagent-bot-development/additional-cleanup-rejections.json)、[媒体 fixture 原始审计](../../artifacts/bot-refactor-2026-11-02/media-temp-cleanup-rejection.json)。它们不是旧业务数据清理失败，也不作为新运行时的数据源。

### 最终交付

最新正式链追加了文件复用断言：previousDeliveries=1、finalDeliveries=1、taskCardHasReceipt=true；worker 实际交付文件，模型通过文件清单 / 任务回执核对不重发。此前[文件复用断言失败](../../artifacts/superagent-bot-development/real-acceptance/file-reuse-initial-failure.json)保留，观察器已按本轮 sourceMessageRecordId 等待，不将新通过等同于确认原失败具体根因。

**最终 Windows package 与 postPackage 通过；该新成品上的 4 项 Electron E2E 全通过（30.2s）。** 产物为 `out/WorldlineBox-win32-x64/WorldlineBox.exe`，日志为[package-final.log](../../artifacts/superagent-bot-development/package-final.log)和[packaged-e2e-final.log](../../artifacts/superagent-bot-development/packaged-e2e-final.log)。成品验收覆盖实际 MP4 / WAV 播放、导入与保存、双主题气泡、伙伴聊天与Three世界。

正式用户配置启动核对同样通过：14位内置伙伴、默认大肥鱼、旧小伴 cleanup complete，旧伙伴 / lane / inbox / task 数均为0。成品使用资源中的原生VCP及内置向量完成只读查询；模型设置和加密凭据的前后哈希一致，没有向正式聊天提交测试消息。[production-bootstrap.json](../../artifacts/superagent-bot-development/production-bootstrap.json)。本轮开发及本机验收完成；原生异常与四个被拒绝删除的测试临时目录仍按上述限制记录。

真实模型案例只覆盖特定模型与有限事实；自动 capture 目前只针对已完成用户 turn，其他来源保留原文与显式记忆工具。安全域默认隔离，跨域长期知识发布、实际 IM / 手机接入、多月 soak、所有平台与任意副作用恰好一次均未据此宣称完成。

## 2026年11月3日上午追踪修复

用户实测的一条“你好”在08:16:37.096入站、08:17:51.817提交，耗时74.721秒且经历11次claim。原实测夹具预先ensureHost并省略runtime.verify，漏掉了产品冷初始化。当前已改为只自动启动默认实例，所有伙伴复用它；不再创建伙伴专用实例，并修复Host尚未通过完整就绪检查就提前放行的窗口。旧闲置lane先封存原文再切换；未知效果保留并阻止盲重发。

正式主应用复测实际只运行一个默认Host，大肥鱼与GPT共用同一PID；手动停止后沿同一实例/home重新启动，没有新增实例。热回复1.084秒；首次完全冷启动50.784秒、停止后重启16.414秒仍明确保留，不能据单个热样本承诺固定延迟。气泡展示实际阶段，每条伙伴文字 / 媒体消息持久保存真实耗时。

历史原文新增FTS5及v14原子迁移，宽弹窗提供真实分类、日期分组、头像、高亮和定位；空回复不进入记录。表情与Emoji统一面板，包图标置底、搜索按需展开，聊天头像改为圆形。明暗两套E2E与真实主应用结果分别保存；排版语料仍不是正式模型输出证明。

本轮额外发现并修复了空DSH配置时联系人页面无法初始化、隔离测试的受信内置资源junction未规范化两处Main接线问题；没有通过给测试塞假DSH或放宽用户媒体路径校验来绕过。一个异步worker测试的提前断言已改为等待实际启动；失败日志保留。此前4个目录重试依旧被自动审批在执行前以blocked by policy拒绝；新增官方启动探针的1个临时目录及3个生成程序同样被拒绝，均保留、未换方法绕过。

### 上午追踪交付与逐人质量验证

最终本轮274项单测通过、6跳过；完整TypeScript（含14位真实验收fixture）与定向ESLint通过。最新Windows package/postPackage通过，新成品5项E2E通过（56.1秒）；正式配置只读启动再次确认14位、仅默认Host运行、旧专用实例停止、原生VCP查询和加密凭据不变。该成品默认Host本次冷准备119.024秒，仍保留为性能短板。

表情原文件名、语义说明、搜索与模型工具originalName已保留；短名置于图片下方，完整名和说明可悬停查看。搜索入口底置并可展开，聊天参与者头像为圆形。

14位伙伴均使用真实deepseek-flash、官方DSH、VCP和内置向量，完成普通交流、回查斗图、实际文件任务三类测试。完整通过13位；Doro回查斗图一次连接失败，下一轮自恢复不回填原失败。14个实际任务均只创建一次，读取真实附件并发送内容16的文件。两名审阅代理逐人检查台词与工具回执，发现计时/提醒能力暗示、确认重复、任务通知日志口吻等待改项，用户自然度验收仍未被替代。[逐人质量及耗时](companion-ai-quality-2026-11-03.md)、[本轮总回执](../../artifacts/superagent-bot-development/chat-followup-acceptance.json)。
