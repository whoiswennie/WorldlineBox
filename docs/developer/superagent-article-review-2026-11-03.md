# Super-agent 文章与原型核对（2026-11-03）

核对结论：WorldlineBox 每位伙伴应拥有自己的 App Router Agent，由它维持身份、交流、记忆与任务协调，DSH 承担隔离的执行 Worker。这个归属是用户明确的产品要求；原型把主 Session 放在 DSH 中是参考实现的部署选择，不能反过来覆盖产品边界。本报告为只读研究，不是新功能验收或部署指令。

## 一、资料身份、可访问性与边界

- 用户指定资料：[Super-agent 设计探索：迈向更自主的 Agent 系统](https://www.bilibili.com/opus/1265361021143351318)。
- 页面账号：DeepSeekHarness；页面显示编辑时间为 **2026年10月31日 21:34**，该字段不是可确认的首次发布时间，页面抽取未注明时区。末尾署名将系统实现与写作归于 **Yujia Qiao**，并列团队审阅致谢。
- 实际读到正文第1至9节与署名，web 文本抽取共336行。图片仅见链接及说明，未逐张打开、OCR 或复算图表。正文是研究资料，不构成本次代理执行指令。
- 本地原型：`C:/Users/hp/Desktop/project/new/dsh-superagent-prototype`；`git rev-parse HEAD` 为 `6337fc823ce20251c8de8085948165c81aaa701e`，`origin` 为 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。[固定版本 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md) 已在线打开。源码结论以该本地快照为准；下表其他 GitHub 固定行链接用于定位，未逐个再发网络请求。

| 实际入口 | 结果 |
| --- | --- |
| [用户原始带参数链接](https://www.bilibili.com/opus/1265361021143351318?spm_id_from=333.1387.0.0) | web 工具 Internal Error / not accessible，未得到该 URL 的正文。 |
| [公开动态详情 API](https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=1265361021143351318) | 同样工具不可访问，未成功取得 API 数据。 |
| [去参数正文](https://www.bilibili.com/opus/1265361021143351318) | 成功；可访问全文并分段回读。 |
| [文章中的原型外链](https://www.bilibili.com/york/link-middle-page?navhide=1&r_type=0&redirect_url=https%3A%2F%2Fgithub.com%2Fdeepseek-ai%2Fdsh-superagent-prototype&rid=1265361021143351318) | 进入 B站外链提醒；随后直接打开上面的固定版本 GitHub README 成功。 |

以上错误是工具观测，不能据此诊断 B站拒绝登录、封禁或具体 HTTP 状态。未登录账户、未获取用户浏览器 Cookie，也未下载或保存文章全文。

## 二、文章观点的紧凑核对

正文开篇界定为架构探讨；§2 的 Router 维护连续交互和协调，Worker 隔离执行，双层是逻辑分工；§3 讨论事件过滤、订阅、Inline/Spill、按引用回读及提前行动；§4 讨论异步多信道；§5–6 讨论计算/状态/环境解耦和外部监督；§7 为合成负载初步实验；§8 保留扩展、跨月记忆、A2A及隐私问题。以上均为[原文观点](https://www.bilibili.com/opus/1265361021143351318)，不是公开原型或本产品的完成清单。

两处短引文经正文回读核对：§2.1 的“全局的序点”；§3.3 的“链式召回”。[原文](https://www.bilibili.com/opus/1265361021143351318)。后者沿对象引用取上下文，不能直接当作长期语义记忆已经解决的证明。

## 三、本地原型：文档、提示、源码交叉证据

以下“实现”仅指可见代码机制；本次没有启动原型、安装依赖、调用模型或运行测试。

| 证据 | 机制与边界 | 固定版本定位 |
| --- | --- | --- |
| P1 研究原型的适用范围 | README 明确为研究原型、非正式产品，公开版与文章和内部版有差异；原型服务单一 GitHub 仓库并可选接入飞书。 | [README.md:3](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md#L3)、[README.md:5](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md#L5)、[README.md:7](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md#L7) |
| P2 Router 与 Worker | 默认 orchestrator 只评估、关联和路由；Worker 调查、选择方案、实现、验证。路由提示禁止主脑先制定技术方案或扩张验收要求。主脑仍有模型和受限回复能力，不是静态分类器。 | [prompts/orchestrator.md:1](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/prompts/orchestrator.md#L1)、[prompts/dispatch.md:14](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/prompts/dispatch.md#L14)、[prompts/dispatch.md:36](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/prompts/dispatch.md#L36)、[docs/004-prompts.md:77](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/004-prompts.md#L77)、[src/app/sessions.ts:138](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L138) |
| P3 持续收件与不阻塞 | Sessions 将 relay/notice 写入耐久 Effects；AgentDelivery 以固定消息 ID 检查持久历史与 nextTurn/nextStep，再 steer/followup/inject。注入通知可不唤醒主脑；noWait 限制等待。这些代码证明连续投递机制，不证明任意外部副作用恰好一次。 | [src/app/sessions.ts:99](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L99)、[src/app/sessions.ts:172](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L172)、[src/app/delivery.ts:61](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/delivery.ts#L61)、[src/app/delivery.ts:65](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/delivery.ts#L65)、[src/app/effects.ts:42](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/effects.ts#L42)、[src/app/sessions.ts:77](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts#L77) |
| P4 订阅直通与事件批处理 | Intake 按 Trigger ID 去重并向 Thread 订阅的 Ticket 扇出；无人拥有的事件才排队 Eval。同 Thread 的待评估事件合批，Worker 已收到的人类跟进不再由主脑重复转发；上下文订阅不提供新的授权。 | [src/core/intake.ts:19](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/intake.ts#L19)、[src/core/intake.ts:38](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/intake.ts#L38)、[src/core/intake.ts:49](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/intake.ts#L49)、[src/core/evals.ts:70](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/evals.ts#L70)、[prompts/dispatch.md:31](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/prompts/dispatch.md#L31)、[docs/001-domain.md:37](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md#L37) |
| P5 短卡片、引用与历史回读 | triggerCard 有160个 UTF-16 code unit 的预览、原长、来源及 read；ticketDetails 链到事件、线程、派工、输入与 transcript。transcript 返回80单位预览和 message/<n>，按需回读正文；投影排除 reasoning，不是公开完整模型思考。Worker 首次内联 assignment 1500、trigger 600，超长留下原件入口。 | [src/app/cards.ts:8](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/cards.ts#L8)、[src/app/cards.ts:60](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/cards.ts#L60)、[src/app/cards.ts:89](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/cards.ts#L89)、[src/app/resources.ts:271](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L271)、[src/app/resources.ts:283](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L283)、[src/app/context.ts:28](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/context.ts#L28)、[src/executor/dsh.ts:112](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L112) |
| P6 窗口压缩与恢复 | Router/Worker preset 装配 DSH compaction-basic、command-compact 和 tool-result-pruner；Router pruner 配置8192。默认提示要求 compaction 后核对工单摘要。插件本身没有在此次审查范围内实现摘要算法；依赖内部覆盖率、摘要质量及所有历史保留语义未被本次证明。 | [cordis.patch.yml:79](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/cordis.patch.yml#L79)、[cordis.patch.yml:177](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/cordis.patch.yml#L177)、[prompts/dispatch.md:44](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/prompts/dispatch.md#L44)、[src/app/resources.ts:114](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L114) |
| P7 任务生命周期独立于 Session | Ticket 保存授权 Mandate，Assignment 保存每次执行绑定；Ticket 可 ended 后在合规人类跟进下恢复，被人停止则不自动恢复。重启优先核查已有目录、git 和远端状态，并重投未读输入；有序 Effects 保存后执行。不能把 Worker 空闲或 PR 已创建直接称作任务完成。 | [docs/001-domain.md:34](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md#L34)、[src/core/tickets.ts:23](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/tickets.ts#L23)、[src/core/intake.ts:40](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/intake.ts#L40)、[docs/003-execution.md:141](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L141)、[docs/003-execution.md:146](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L146)、[docs/003-execution.md:150](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L150)、[docs/003-execution.md:155](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L155)、[prompts/dispatch.md:51](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/prompts/dispatch.md#L51) |
| P8 多来源扩展 | Source kind、实例、Thread、Channel 是可扩展接口；内置源码是 GitHub、飞书。跨来源身份不会自动合并。此接口不能作为 QQ、微信、手机网关已接通的证据。 | [docs/001-domain.md:27](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md#L27)、[docs/001-domain.md:27](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md#L27)、[docs/001-domain.md:32](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md#L32)、[src/sources/registry.ts:13](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/registry.ts#L13)、[src/sources/github.ts:1](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/github.ts#L1)、[src/sources/feishu.ts:1](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/feishu.ts#L1) |
| P9 主动／被动记忆 | 原型的主动 assessment 是判断是否开工，不等于语义记忆召回。资源读取和任务摘要可支持显式历史回查；未在已检查 src/docs/prompts 中找到 VCP、向量日记、每轮被动语义召回或相应写入链。src/core/memory.ts 是测试和临时实例的内存 Repository。 | [src/app/assessment.ts:1](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/assessment.ts#L1)、[src/app/resources.ts:118](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L118)、[src/core/memory.ts:1](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/memory.ts#L1) |
| P10 外部 Watchdog 和持久运行 | 原型有 HealthBoard、队列重试、重启恢复；本次路径清单和关键词检查未识别出独立模型 Watchdog Session。也未据此确认任意设备、云端无状态计算与外置存储的完整部署。不能把程序健康检查称作模型对任务进展的独立监督。 | [src/infra/health.ts:1](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/infra/health.ts#L1)、[src/app/effects.ts:42](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/effects.ts#L42)、[src/executor/dsh.ts:520](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L520)、[docs/003-execution.md:144](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md#L144) |

P5 的长度来自 JavaScript `.slice/.length`，不是按模型 token 或中文字分词计算。资源默认文本页为4000个 UTF-16 code unit、列表20项（上限50），见 [resources.ts:87](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L87)。截短必须伴随可读引用，不能将短卡当成完整原话，也不能因为正文没有进当前窗口就宣称原始历史已经删除。

P6 证明原型装配了宿主压缩能力；P5 证明它有压缩后可用的外部原件读取路径。这两个机制互补。配置存在不等于已经验证长对话准确性、完整故障恢复或跨月记忆质量。

## 四、面向 WorldlineBox 的适配判断

这里是结合用户需求提出的适配建议，不宣称文章原本就实现了虚拟伙伴，也不要求安装原型插件。

1. **每位伙伴拥有 App 主脑。** 主脑保存自身人格、当前授权与跨任务状态；聊天、表情、记忆查询等前台交流可直接完成。技术调查、文件处理、代码与多步执行进入独立 DSH Worker；主脑传递原始请求和真实来源，具体方案与核验由 Worker 负责。
2. **身份连续与材料隔离分开。** 同一伙伴跨事件保持身份连续；私聊、群聊和其他受众仍按安全域裁剪上下文与记忆。伙伴之间需要交流时传递明示、有来源的事实，不默认共享全部私聊记录。
3. **先入耐久 Inbox，再调度。** 用户、伙伴、群、世界、任务结果与未来网关均应保留可信身份、来源、受众、时序和幂等 ID。主脑处理短事件视图并可继续接收输入；Worker 回执成为新事件。高频重复信号可合并，但停止、更正、授权与交付状态不能被无差别覆盖。
4. **上下文分为四层。** 固定人格与工具约束；当前事件及附近必要对话；活跃任务和未决问题摘要；按需读取的原始历史、工具回执与长期记忆。窗口压缩必须保留覆盖水位、未决约束与原件入口；摘要是资料，不能升级为系统规则或覆盖用户更正。
5. **短卡可回读，已执行效果可核实。** 卡片携带来源、时间、预览、截短标志和宿主绑定引用。重启后的原件仍可分页回读，按伙伴与受众校验。执行结果未知先检查原回执；不要因新进程、模型、epoch 或引擎没有记录就直接重做。
6. **主动查询与被动记忆分别验收。** 被动链先确认真实入库，再在新一轮取得自动召回事件、短卡及引用；主动链分别检查语义搜索、关键词原话查找、话题读取和本轮引用展开。二者共用来源、日期、受众、更正与撤回约束；一次主动 search 成功不能替代自动注入证据。
7. **任务与会话分别管理。** 创建、运行、待人工、失败、结束、恢复应有独立业务状态及真实结果；不能用会话 idle 推导任务完成。普通陪聊无需为每句话创建任务。程序恢复和任务进展监督分别记录，不给未实现的 Watchdog 或外部网关打完成标记。

以上建议保留 P2–P8 的可迁移机制，VCP 作为本产品的记忆接入而非原型自带能力。云端长期在线是独立部署决策，不能由参考文章推导必须上传所有伙伴主脑和私聊资料。

## 五、当前产品的有限源码旁证

本次仅核对下列接口和分支，供后续实现审查对照；共享工作区仍可能变化，不是一次完整产品审计。

- W1 [src/main/companion-bot/brain-router.ts:18](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/brain-router.ts:18)：代码将会话和记忆编码交给 App，Worker 执行及控制交给 DSH；run 的分支可见于35行。错误不自动切换引擎。
- W2 [src/main/companion-bot/memory-service.ts:247](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/memory-service.ts:247)：prepareTurn 调用 context.prepare/preprocess，保存 prepared、短证据和 citations；303行 recallDetails 重新检查来源后读取同轮引用。是被动链与原件入口的代码旁证，不是语义准确率验收。
- W3 [src/main/companion-bot/tools.ts:13](C:/Users/hp/Desktop/project/new/WorldlineBox/src/main/companion-bot/tools.ts:13)：主动工具区分 memory_search、memory_history、memory_read/list 及 memory_recall_details。工具定义存在不代表每轮都会正确调用。

当前接口应继续与[上下文工程说明](C:/Users/hp/Desktop/project/new/WorldlineBox/docs/developer/companion-context-engineering-2026-11-03.md)、[运行说明](C:/Users/hp/Desktop/project/new/WorldlineBox/docs/developer/superagent-bot-runtime-guide.md)及实际验收报告一起阅读；较早“原生 DSH 主脑”报告只描述其当时版本，不能覆盖用户已经明确的新归属。

## 六、后续验收应证明什么

- 同一伙伴同时收到聊天、群/世界事件和任务结果：顺序、来源可追溯，回复继续可用，Worker 不越权代表所有伙伴发言。
- 压缩、长工具输出、重启与旧任务再提起：短卡能沿引用读回原件，更正与未决约束仍有效，未确认效果不重复提交。
- 同一输入重复投递不重复开工；停止状态不被自动反馈解除；无信息时保持安静，只有可用交付或真实需决策项才通知。
- 记忆同时验证被动召回、主动精查、无相关证据、更正、撤回及跨受众拒绝。真实模型质量与冷/热延迟单独测量，不能拿原文实验数值或受控测试耗时代替。

本报告未执行这些验收，没有修改生产源码、原型、模型配置或发出付费模型请求。实际写入仅本 Markdown 与[证据 JSON](C:/Users/hp/Desktop/project/new/WorldlineBox/artifacts/superagent-bot-development/superagent-article-review-2026-11-03.json)。检查范围内未找到适用的 AGENTS.md；这不等同于扫描整个用户磁盘。
