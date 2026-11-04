# Super Agent Router 原型核对与当前偏差（2026-11-03）

**后续架构澄清：** 用户已明确要求主脑Agent归世界线盒子所有，DSH仅作执行工具。原型把Router放进DSH是它的部署方式，不是本产品必须复制的边界。现实现转向App Agent，保留事件驱动、窄职责、独立Worker及耐久投递；当前接线以[运行说明](superagent-bot-runtime-guide.md)为准。下文原型事实继续有效，“当前实现/下一步修正”描述的是改动前检查点，不能作新版本实现证明。

本次以本地 `C:/Users/hp/Desktop/project/new/dsh-superagent-prototype` 的文档、默认提示与执行代码交叉核对。该项目 README 明确说明它是研究原型，公开代码与文章或内部实现并不完全相同；这里不把文章设想当作代码已实现的能力。本次只读研究，没有修改原型，也没有再次发送付费模型请求。

## 原型的真实职责边界

执行层面，原型要求 Router 把技术调查、方案、实现及验证交给 Worker。它自己负责接入与评估请求、关联旧任务、接纳新任务、停止任务、维持授权及状态、转交问题和交付结果。这是有模型的长期调度 Agent，不是无模型分类器。

| 问题 | 源码事实 | 依据 |
| --- | --- | --- |
| Router 自己调查代码、制定技术方案吗？ | 默认指令明确禁止；原始请求交给 Worker，路由备注最多30词，不加技术方案或验收清单。 | `prompts/orchestrator.md:4`；`prompts/dispatch.md:14,38,40`；`docs/004-prompts.md:77` |
| Router 只是分配一次就结束吗？ | 还负责候选评估、accept/attach/stop/ignore、恢复与任务状态、跨任务路由事实、向原来源交付结果/问题。 | `src/app/tools/main.ts`；`src/core/engine.ts`；`src/core/replies.ts` |
| Router 是否有独立 LLM 会话？ | `Sessions.ensure` 在同一DSH Host里创建 `dsh-superagent-router` preset 的原生Agent Session；orchestrator取 `eval.model`，Worker取 `executor.model`。两者可配置不同模型，并非必然两套Host。 | `src/app/sessions.ts:138`、`:144`、`:150`；`cordis.patch.yml:125` |
| Router 会等 Worker 干完才结束自己的turn吗？ | 不会。没有待办即结束；新候选、问题和结果由事件再次注入，禁止sleep/轮询等待，工具等待有上限。 | `prompts/orchestrator.md:16`；`docs/004-prompts.md:78`；`src/app/sessions.ts:77` |
| 它完全不能对外回答吗？ | 可以通过受限 `orchestrator_reply` 与Outbox回复。无ticket的真实human trigger，代码允许purpose=answer；已归属ticket的问题则要求Worker报告相应答案权限。不能据此说默认Router负责通用技术答疑。 | `src/core/replies.ts:64` 至 `:86`；`prompts/replies.md` |
| 普通闲聊如何处理？ | 这是单仓库工作协作原型，默认dispatch允许ordinary discussion被ignore；不是已经具备虚拟人格陪伴能力的IM产品。 | `README.md`；`prompts/dispatch.md:6` |
| Router加载完整编码Agent吗？ | 有专门的轻量preset；不挂子Agent、web、文件搜索/写入、todo、计划、插件管理、定时任务等执行能力；完整Router提示替代编码提示。保留少量读取/CLI能力用于调度管理，不等于鼓励它执行技术工作。 | `cordis.patch.yml:121` 起；`src/app/sessions.ts:245`、`:263`；`docs/004-prompts.md:61` |
| 原型是否提供VCP语义记忆？ | 没有。其持久状态、会话压缩、任务摘要与订阅不是VCP向量召回。`src/core/memory.ts`是测试用内存Repository。 | `src/core/memory.ts`；`src/app/store.ts`；`src/app/sessions.ts` |

上述均为本地文件相对原型根的路径，行号对应本轮只读检查版本。

## 映射到世界线盒子

应保留原型的长期主会话、窄职责、事件驱动、独立Worker以及耐久结果投递。把原仓库的GitHub/飞书事件改成用户/伙伴/群聊/世界事件，并用每位伙伴的身份和安全域隔离上下文、文件及记忆。

伴随聊天、回忆、表情和附件是本产品明确增加的通信能力：它们可由伙伴主脑完成，不必为每句寒暄新建执行任务。技术调查、文件处理、编码和多步执行交给独立DSH任务，Worker依据原始请求负责方案与核验；主脑不先做一遍同样的技术研究再转发。这里是领域适配，不宣称原型本来就有这些陪伴功能，也不照搬其“普通讨论忽略”的产品行为。

本产品里的“调用DSH”需要区分两件事：

1. 用共享DSH Host承载Router原生Session及模型循环。原型自身就是这样；普通聊天经过原生Session不代表创建了执行任务。
2. 主脑调用 `dsh_task`，创建有自己目录、会话及状态的执行Worker。这只在需要工作时发生。

因此，改成“主脑完全不使用DSH运行时、只靠手写HTTP循环”并不能称作照搬原型；同样，要求每句闲聊都生成一个Worker也没有原型依据。

当前实现已具有同Host、原生Session/compaction、独立任务与事件回执，但仍存在接入差异：`resources/dsh-bridge/index.js:595` 的 `ensureBotPreset`复制默认preset，只调整compaction，再通过工具策略隐藏执行工具。它已经使用 `complete:true` 的伙伴提示（`:564`），不能误称每轮把完整编码提示一并送给模型；然而“加载后限制工具”仍不同于原型从preset就只装Router需要的插件。精简preset应作为下一项实现修正，并经冷/热附着测量确认效果，不能预先声称它必定省几秒。

## 6–8秒不能直接解释为VCP召回慢

14位普通轮实际均为0工具调用、0 `dsh_task`、0新任务。后13位总耗时中位6.820秒，首次可显示文本中位6.234秒，首字后尾部中位0.659秒。等待主要发生在首字之前，不是只因正文很长。

但每一位都是全新VCP home和原生Session，本轮 `maxActiveDomains=3`，还可能与前一位的后台记忆工作重叠。它测的是“同共享Host下，各角色首次启用”，不能作为“同伙伴常驻记忆的稳定热聊天”数据。批测没有保存逐轮的prepare/model/finish细分，临时DB随后已清理，现有证据不能把6秒定量分配给召回、初始化、原生接入、网络或模型。

当前代码中可确认的成本是：

- 每个新/重新打开的域创建VCP进程，并在首次激活串行doctor/status/sync/repair。doctor还在子进程里再次运行Node核验快照；新home会复制上游代码。不是稳定热轮每次发生，但3域LRU下切换伙伴会反复经历。[接入代码](../../src/main/companion-bot/memory-service.ts:109)、[打包模块workspace](../../.tools/bot-memory-release/vcp-memory/lib/workspace.cjs:62)。
- 每轮等待VCP prepared.get/source.filter/context.prepare/preprocess/status/prepared.put，保持幂等与撤回边界；同域FIFO也可能让前台prepare等待已经开始的后台工作。[prepareTurn](../../src/main/companion-bot/memory-service.ts:244)。
- 普通主脑经过原生Session附着与模型推理；热Host只做health，不逐轮重新校验整个DSH运行包。[主脑适配](../../src/main/companion-bot/dsh-brain.ts:75)、[Host复用](../../src/main/dsh/instance-service.ts:148)。

独立的正式主应用短寒暄实测已有热回复1.084秒（prepare约100ms），但只有单个样例，不能据此保证所有自然对话1–2秒结束。供应商推理、输出长度和工具轮次应单独测量，不能从召回几百毫秒推导最终回答固定上限。

## 具体设计修正与验收条件

| 修正项 | 保留的语义 | 验收方式 |
| --- | --- | --- |
| Router独立轻量preset、Worker执行preset | 原生持久会话、工具协议、压缩/取消/恢复及任务回执 | 对比新域及同域热轮的lane附着；确认Router无编码执行插件/执行工具泄漏 |
| 不可变VCP代码/校验与可变安全域数据分开 | 原模块算法、签名、独立域、撤回与写入修复 | 包级一次完整性证明；域级配置和数据校验保留；新域/淘汰后重开不再重复复制及验证完整代码包 |
| 当前联系人有限预热，避免发送时才初始化 | 不发模型请求、不启动全部实例、不把14个域全常驻 | 切换前后首字/准备/RSS分别记录；取消预热和LRU行为有界 |
| VCP prepare合并接口与前台优先队列 | prepared冻结输入、幂等、来源撤回及已启动修复不能被跳过 | 与现有六步语义一致；前台等待后台时间单列；不通过绕过记忆检索制造快响应 |
| 拆细测量 | 不把Host/附着统称纯模型耗时 | 记录队列、VCP等待/初始化/召回、Host等待、lane附着、模型调用到首文本、总文本完成；测试器保存所有字段 |

1–2秒可作为“Host/活跃记忆域就绪、无工具普通短聊”的首文本目标；完整回复另列。当前还没有形成此目标的p50/p95及稳定达标证据，不应宣称已经实现。后续测试应复用同一安全域做足够的热轮，再单测换伙伴、LRU重开、Host重启与后台记忆负载；人工视觉占位和提前显示“正在回复”不算模型首文本。

逐人原始交互与语义结果见[14位实测](companion-ai-quality-2026-11-03.md)，首文本复算见[普通轮延迟拆分](../../artifacts/superagent-bot-development/companions-real-acceptance/ordinary-latency-breakdown.json)。本文是代码核对和具体设计修正，不把这些尚未实施的优化写成已交付。
