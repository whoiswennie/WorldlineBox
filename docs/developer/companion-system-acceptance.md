# 伙伴系统闭环验收

日期：2026-10-22，Windows x64。本次以真实记忆内容、实际执行与持久状态共同判断，不以返回成功或界面截图单独代替验收。源码范围、VCP 适配和来源规则见[实施说明](companion-memory-implementation.md)，原版信息流与真实模型原文见[内容审计](vcp-memory-content-audit.md)。

## 记录与生活链路

正式可见消息、真实伙伴交流、已完成的世界事件、人工记忆文档和实际读取的获权资料进入持久候选队列。模型选择性形成完整日记、资料或自我认识，宿主逐字核验证据、身份、版本和可见范围，再经原 DailyNote/outbox/原生索引发布。问候、重复确认、计划、姿态不会自动升级为新经历；没有值得保留的变化可以不写。自动标签与人工标签优先级、来源撤回、长期禁记、重置恢复使用同一账本。

回复前自动运行原 River 与 AIMemo+ 聚焦；主动记忆工具可进一步检索、阅读、修订和整理。世界认知、持续行动及睡眠反思也使用真实来源和原 VCP 检索。共享编码器有界排队，聊天/捕获/世界/睡眠/资料阅读分别有并发控制；慢伙伴不会占住所有伙伴的认知通道。无法承诺任意规模零等待。

每位伙伴可拥有多个明确授权的资料库或目录，多位伙伴可共享一个来源。新授权默认手动；自主阅读按现实时间核对，在作息允许并取得有效读取租约后进入真实世界学习工作。读取只支持目前已实现的纯文本格式和大小，不以缩略图、文件名或看书动作冒充学习。移除授权会取消租约并撤回依赖记忆，不删除原资产。

日常事件在时间窗口内重复评估，评估/行动/沉默/失败节奏可分别设置，跨午夜、重启不重置冷却。默认15/90/20/30世界分钟；默认不主动向玩家广播。各内置角色已有固定的不同习惯和时段，通用睡眠与三餐的默认时间可以由用户分别调整。

梦境需要真实睡眠、可用的已索引来源日记、单次持久抽签与八个世界小时冷却，默认入梦机会0.6；未抽中仍可反思。梦中虚构画面只进入明确标注的梦境日记，不能改人格、变现实成果或授予权限。醒来、资料修订、遗忘与重置会中止过期作业。宿主采用原 River 同域关联，没有声称整体照搬原 DreamWave 的三级时间桶和公共库管理器。

## 分层验证结果

| 验证层 | 实际结果与边界 |
| --- | --- |
| 三伙伴真实内容 | 林澄、周岚、陈青使用真实全局 DeepSeek 配置、本地量化 Gemma、SQLite、原 VCP。最新完整轮12/12内容断言通过：共同约定、两轮实际伙伴间回答、各自见证日记、更正、无关/问候排除、群私密隔离、遗忘、实际多段文件学习及睡眠边界。不是公开模型基准或人格长期研究。 |
| 实际梦境 | 较早独立轮已生成、host提交并索引一篇有4份真实来源的虚拟梦，完整正文与回执留存；该轮咖啡更正曾失败，不能称整轮通过。最新完整轮修好更正并全绿，睡眠模型选择空反思/无梦，未强行制造内容。 |
| 两天生活调度 | 真实SQLite及世界时钟推进48.08虚拟小时，三角色在不同节奏下分别27/19/14次行动；每人经历一次沉默、一次受控失败再恢复；24小时重启，0次睡眠联系、0条玩家消息。模型传输受控，此项验证调度与持久行为；真实文字质量由上一层单独验证。 |
| 学习与权限 | 实际LibraryService分页、目录成员前后复查、稳定文件读取、UTF-8/UTF-16、多对多授权、默认不读、分段游标、撤销/到期/旧租约/重启保护、2位并行与第三位继续均通过。实际UI授目录、修改安排、读取2个原文件、撤回与来源过滤已通过；UI模型夹具返回空日记，不冒充内容质量证明。 |
| 真实聊天UI | 三个稳定reply气泡立即出现，实际read_file工具、流式文字、第三位排队、单独取消和同气泡重试通过；重复底部队列卡已移除。SSE工具续说及整应用重启恢复沿用同一消息ID；四次本机首有效文字约0.48–1.05秒，不代表云模型或其他机器速度。 |
| 文档规模 | 十万条短记录catalogue和三千篇720字真实文件验证分页/中文全文/标签/增量目录扫描；列表最多64项，目录可见窗口绘制。原生VCP另测100/1000篇温查询，无每次重读全部日记或重编码。没有十万篇真实Gemma全量构建的性能结论。 |
| 资产语义搜索 | 开关独立且默认关闭，记忆不受其关闭影响。真实14资产、文字/图片/音频/视频检索5/5小样本Top1；实际应用启用、索引、重启复用和清缓存进程退出通过。向量身份与记忆相同；大量首建仍需要时间。 |
| 代码回归 | 最新相关广回归1334通过、0失败、11跳过；十万消息/十万日记的重置测试单独串行8/8通过，合计1342项。大规模重置的严格单批时延不与其它压力测试争抢CPU。完整类型检查通过；lint 0错误、8条非阻断警告，主要为现有页面的Hook依赖提示。 |
| 实际打包程序 | 本次03生成的Windows x64 ASAR，7个Electron端到端用例全部通过、0跳过/重试：自然文件与资产库绑定/修订/遗忘/重启，普通对话原AIMemo召回，内置模型设置，学习来源，三伙伴气泡，SSE工具/重启恢复，资产语义搜索/向量复用/清缓存退出。每次启动断言app.isPackaged与独立userData，未改用户安装。此项不是实际安装/卸载向导旅程。 |
| 上游与资源 | 127份上游原文件SHA未变。去重阈值仅在宿主runtime私有参数副本调整，保留相近但矛盾的来源；参数影响、成本及边界在内容审计中明确。内置模型与CPU/Vulkan运行组件按固定清单校验，权重直接从安装资源读取。 |

## 可复现入口与证据

`WORLDLINEBOX_CONTENT_EVALUATION=1` 显式开启真实内容测试；它使用已有全局聊天配置但不保存明文密钥、不改用户实际伙伴存档。真实模型测试会产生API调用。普通回归不假装执行了这些可选外部调用。

- `tests/worker/companion-memory-content-scenario.test.ts`：真实三伙伴、资料学习和睡眠内容。
- `tests/worker/companion-life-rhythm.test.ts`、`tests/unit/companion-world-service.test.ts`：长时节奏、并发与睡眠。
- `tests/worker/companion-learning-store.test.ts`、`tests/worker/companion-learning-assets.test.ts`、`tests/unit/companion-learning-service.test.ts`：读取、授权、取消与恢复。
- `tests/e2e/companion-parallel-progress.test.ts`、`tests/e2e/companion-learning-sources.test.ts`、`tests/e2e/companions.test.ts`：实际气泡、学习来源、SSE和原版被动回忆。
- `npm run verify:companion-memory:packaged`：实际打包ASAR的来源/索引/召回/遗忘/重启及资源断言。

完整本机证据位于 `artifacts/vcp-validation/`（构建产物不提交Git）：`content-three-companions.json`、`content-real-dream-positive-evidence.json`、`companion-life-rhythm-validation.json`、`closed-loop-final-regression.json`、`closed-loop-reset-standalone.log`、`learning-sources-ui/reading-permission-proof.json`、`parallel-reply-progress/`、`asset-ui-lifecycle/sqlite-reuse-proof.json`、`packaged-companion-memory-both.json`、`closed-loop-packaged-interactions.json`。截图使用实际1440/1040 CSS像素及记录的DPR，不将请求800但被最小宽度限制的窗口称为800像素验收。

本次实际执行 `03-Build-Installer.bat`，完整类型检查、资源校验、Forge及Inno均退出0。安装包在2026-10-22 02:07（UTC+8）生成：`out/make/inno/WorldlineBoxSetup.exe`，1,207,363,658字节（1151.4 MiB）。SHA-256为 `17b00354c6bf8e1f2062643721ccfcb74d5fe651d220a71c3ff5835856805b61`，同目录附`.sha256`文件。

实际验收的ASAR SHA-256为 `942a38595d08bcdadf8bde24c6705dfb8e855b4f151acbfa5905616823e32b2f`。构建日志`closed-loop-installer-build.log`及汇总`closed-loop-release.json`保存在本机证据目录。旧安装包、开发构建及未完成的尝试不计入本次通过；未执行用户系统中的实际安装/卸载，不改现有安装和资料。
