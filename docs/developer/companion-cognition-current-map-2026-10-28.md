# 伙伴目录与上下文消费路径现状映射

本附录记录 **2026-10-28 只读审计时观察到的实现基线**，用于重大重构定位。它不是新架构的完成说明，也不能替代冻结源码后的验收。本文不收录私人日记正文、模型密钥或连接凭据。

目标要求与后续实施门见[伙伴认知重构标准](companion-cognition-refactor-standard-2026-10-28.md)。下文将“当前事实”与“目标约束”分开；文件存在、模型读过文件、内容进入本次上下文、内容被认可或内化，是不同状态。

用户随后明确采用开发版清空重建，不兼容旧维护逻辑。下文是重构前的实现审计快照，“当前”均指当时审计基线，不代表新系统仍允许这些旧入口。原只读核验发现的2个删除占位、35条消息及4个会话，现已通过限定清单清理；生产构造器已初始化新协议空库，保留真实玩家资料、全局连接及无关资产。实际清理收据、当前实现与仍待验收项统一见[实施记录](companion-cognition-implementation-2026-10-28.md)，不得把本文旧事实当新系统状态。

## 1. 先区分存储位置与消费路径

当前伙伴空间中同时保存身份资料、模型工作指导、记忆正文、来源证据、历史修订、图片、检索索引和同步账本。这些内容不按“都在伙伴目录里”就获得相同职责。

```text
<资产库>/
  伙伴记忆/<伙伴ID>/          本人身份、正文、证据及认知运行空间
  .worldlinebox/companions/   消息与任务事务账本、附件、执行产物等
```

当前实例布局由 [companion-instance.ts](../../src/shared/companion-instance.ts#L5) 定义，目录初始化与清单写入见 [asset-profile.ts](../../src/main/companions/asset-profile.ts#L213)。

| 当前事实 | 对目标设计的约束，尚不代表已经实现 |
| --- | --- |
| 日常推理以当前 `profile.md` 为身份依据；当前仍允许创建后的用户修改。 | 创建确认后收口人工认知编辑，后续人格变化只能走正式成长提交。 |
| 实例有日记、资料、自我认识、世界经历、时间线等现有目录。 | 可复用检索与来源核验的代码基础；旧实例数据清空后按新类型协议重新建立，不沿用旧目录或正文。 |
| 本轮核对的当前实例没有 `起点/`、`成长记录/`。 | 这两个名称来自拟议方案。新增时必须先定义文件类型、消费者和摄取边界。 |
| 界面可以列出提示词文件和数量，但没有完整表达每次调用的实际装配关系。 | 当前资料查看与实际请求快照应分别展示，不能用“文件数”代表伙伴认知。 |

## 2. 当前伙伴根目录逐项说明

### 2.1 身份、职能配置与宿主策略

| 当前文件或目录 | 保存什么、由谁维护 | 谁读取、何时读取 | 是否进入模型上下文 |
| --- | --- | --- | --- |
| `profile.md` | 名称、简介、完整人格，以及头像引用、主动联系等非密钥设置。当前由用户编辑入口经宿主保存。 | 每次实际模型准入读取当前文件，刷新角色插槽；状态列表也有较轻量的资料读取。 | **直接身份依据**。聊天与多数后台模型使用；后台使用身份不等于都在扮演聊天。 |
| `提示词/` | 通用原则、各职能指导及 VCP 原生模板。创建时复制当前实例副本，当前仍可人工编辑。 | 清单按用途选择；详见第 5 节。 | **选中的模块进入**，不是整个目录同时发送。 |
| `提示词/manifest.json` | 哪些是共同模块，某个用途选择哪些文件。 | 提示词装配器；亦校验路径、归属和版本。 | 清单是选择规则，JSON 本身不作为人格或经历全文注入。 |
| `instance.json` | 实例 ID、创建信息和固定路径清单。 | 实例结构、归属和文件布局核验。 | 不作为人格正文或记忆注入。 |
| `记忆策略.json` | 编码静默窗口、批次、深度维护间隔、梦的概率与冷却等调度参数。 | 编码和维护调度器读取。 | **不作为提示词发送**；它决定何时、以什么资源节律处理。 |

依据：[资料及 manifest 结构](../../src/main/companions/asset-profile.ts#L11)、[快照及用途装配](../../src/main/companions/asset-profile.ts#L153)、[记忆策略结构](../../src/shared/companion-memory-policy.ts#L5)。

### 2.2 记忆、知识、自我认识与时间导航

| 当前目录 | 正文性质与写入方 | 实际消费者 | 上下文关系 |
| --- | --- | --- | --- |
| `日记/` | 自动事件编码或主动记忆工具形成的经历笔记。 | VCP 索引、检索、主动原文读取、反思和整合。 | 按需载入，不整目录常驻。文件通常按 note ID 命名，不是一天固定一篇。 |
| `资料/` | 获准阅读所得知识、方法，或当前允许的手工资料。 | 学习、检索、回忆、方法复用。 | 按需载入；“读过”不自动等于认可、亲历或掌握。 |
| `自我认识/` | 本人的主观反思、喜好、价值与表达认识；可含受校验的 `selfDevelopment`。 | VCP 检索，以及有界的当前 `characterDevelopment` 投影。 | 可被检索，也可通过当前认识投影参与推理。不是整目录每轮全部发送，也不是当前 profile 的自主重写机制。 |
| `世界经历/` | 以世界观察来源形成的历史经历笔记。 | 回忆、反思。 | 按需。**历史世界经历不等于当前实时世界状态**；实时状态另从宿主观察取得。 |
| `时间线/` | VCP 自动月度时间线与短摘要，例如 `VCP-*.md`、`*.summary.md`。 | 长期事件导航、VCP 月度组织和用户查看。 | 按对应功能需要使用；自动产物不重新当新经历摄取。 |

一篇记忆正文还可带来源、适用条件、方法候选、修订和撤销信息。正文、检索注释和投递状态并非同一概念。目录分类是呈现方式，最终来源归属和可见性仍由宿主账本核验。

依据：[当前认识结构](../../src/shared/companion-character-development.ts#L5)、[当前认识投影](../../src/companions/character-development-store.ts#L73)、[日记文件发布](../../src/main/companions/memory-live-files.ts#L80)、[时间线发布](../../src/main/companions/memory-library.ts#L826)。

### 2.3 来源、历史、形象和索引

| 当前目录 | 内容 | 用途与模型关系 |
| --- | --- | --- |
| `来源/` | 正式消息、行动、阅读来源的精确只读副本；文件名含来源 ID、revision、hash。 | 编码、反思或主动核查时读取原文证据。副本文件不自行授予身份或访问权限，编辑副本不能成为合法新来源。 |
| `记忆历史/<noteId>/` | `r<revision>-<bodyHash>.md` 等准确历史正文与元数据。 | 修订对比、追溯、合法任务继续读取所持历史版本。不会自动重新学习成新经历。历史仍服从来源撤回与遗忘规则。 |
| `形象/` | 头像、正交设定图和对应初始化或选择凭证。 | 联系人、公开形象、多模态输入准备。知道路径不代表已看图；实际附带像素的调用才能声称模型看过。 |
| `.认知索引/` | 检索运行空间、原生索引、视图缓存、临时发布及恢复资料。 | 支撑检索、聚焦、时间线和管理查询。**不是应该直接发给模型的一份“人格正文”。** |

依据：[来源文件](../../src/main/companions/memory-source-files.ts#L19)、[历史路径及格式](../../src/shared/companion-memory-history.ts#L28)、[历史发布与恢复](../../src/main/companions/memory-history-files.ts#L32)。

## 3. 说明文件、隐藏文件与二级目录

### 3.1 根级和正文旁的技术文件

| 文件 | 当前职责 | 不应怎样解释 |
| --- | --- | --- |
| `.伙伴配置.json` | 一次初始化完成标记，包含 schema、owner 和初始化时间，防止反复从模板播种。 | 不是另一份人设。 |
| `.同步状态.json` | 路径到 note ID、版本、hash、同步状态、待导入操作、扫描游标及移动恢复等登记。 | 不是她的主观认识或经历。 |
| `.时间线索引.json` | 自动时间线文件的作用域、来源版本、内容 hash、owner 身份和游标登记。 | 不是月度经历正文。 |
| `同步状态.md` | 面向用户的同步成功、冲突和核对说明。 | 不是需要形成记忆的生活事件。 |
| `*.md.meta.json` | 对应正文的 note ID、owner、版本、标签、来源、captureMethod、procedure 等说明。 | 不是额外一篇记忆；sidecar 不能自行伪造权限。 |
| `形象/.avatar-initialized.json`、`.orthographic-initialized.json` | 形象初始化及当前选择凭证，防止文件缺失后静默恢复出厂图片。 | 不是图片像素或人格设定。 |

因此，磁盘文件数、记忆条目数、当前有效认识数、实际载入条目数必须分别统计。一篇正文、一份 sidecar 和多个历史修订不能显示成多次成长。

依据：[同步登记](../../src/main/companions/memory-library.ts#L233)、[同步说明](../../src/main/companions/memory-library.ts#L406)、[正文 sidecar](../../src/main/companions/memory-library.ts#L636)。

### 3.2 `.认知索引/` 二级空间

| 子目录或文件 | 当前职责 | 当前存在与按需支持的区别 |
| --- | --- | --- |
| `hot/<hash>/…` | VCP 热侧原生数据库、图与 scope 运行空间，按语义和编码配置隔离。 | 本轮实际实例有该空间。 |
| `generation/<hash>/…` | 聚焦、时间线等生成侧运行空间，也可承载 prepared recall 包。 | 本轮实际实例有该空间。`generation` 指生成运行时，**不是人格成长档案**。 |
| `views/*.json`、`*.json.timeline` | 当前合法记忆视图、时间线视图缓存。 | 本轮实际实例有对应缓存。 |
| `历史发布/` | 不可变历史正文提交的临时文件与崩溃恢复。 | 本轮实际实例有该空间。 |
| `management/` | 记忆管理界面的搜索索引。 | 代码按需支持；不是主脑 VCP 召回管线。 |
| `cold/` 等知识空间 | 冷知识相关运行空间。 | 是否实际创建取决于使用；不能把支持路径写成每个实例都已存在。 |

依据：[生成侧运行空间](../../src/main/companions/vcp-runtime.ts#L121)、[热侧空间](../../src/main/companions/vcp-runtime.ts#L221)、[生成空间配置](../../src/main/companions/vcp-runtime.ts#L285)、[管理索引接线](../../src/main/companions/service.ts#L275)、[视图缓存](../../src/main/companions/memory-view-cache.ts)。

## 4. 邻接的 `.worldlinebox/companions/` 不是另一份人格目录

| 当前文件或目录 | 内容和用途 | 与上下文、记忆的关系 |
| --- | --- | --- |
| `messages.sqlite` 及 WAL/SHM | 正式消息、任务 loop、世界状态、来源归属、记忆元数据、版本、租约、撤销等事务账本。 | 从中查询当前入口消息、状态和任务输入；不将整个数据库发送给模型。记忆正文文件缺失时，不把 SQL 当静默正文回退。 |
| `attachments/` | 用户发送、主脑查看或发送的受管附件副本。 | 本次获准并实际读取的附件参与上下文；整目录不自动学习。 |
| `dsh-tasks/<owner>/…` | DSH 托管工作目录与产物。 | 通过实际回执、读回和结果反馈形成执行证据，不自动将所有产物变成记忆。 |
| `experiences/<owner>/<day>/<entry>/` | UI 经历归档，包含 `index.json`、`detail.md`，必要时保存 `dsh-report.md`。 | 是实际生产者账本的展示归档，不是新的事实来源。 |
| `模型资源预算.json` | 统一模型调用与资源预算配置。 | 决定准入和资源调度，不是人格。 |
| `llm-keys.enc.json` | 加密连接凭据。 | 不属于认知正文，不应进入查看器的模型输入内容或学习资料。 |

DSH 的完整追加事件日志、报告和索引另由任务记录存储管理，不能把它与 `dsh-tasks` 的工作产物目录混为一谈。应用诊断日志也另有用途：排错不等于形成伙伴经历。

依据：[服务存储接线](../../src/main/companions/service.ts#L233)、[附件处理](../../src/main/companions/service.ts#L4494)、[经历归档](../../src/companions/experience-store.ts#L246)、[DSH 记录](../../src/main/dsh/task-record-store.ts#L57)、[应用诊断日志](../../src/main/app-logger.ts#L82)。

## 5. 33 个提示词模块怎样按用途选用

### 5.1 普通拼接规则

实际实例中有 33 个 `.md` 文件，另有 `manifest.json`。清单的 `common` 当前是 `提示词/共同.md`。

普通路径的选用关系是：

```text
本次 purpose
  → 共同模块 + 该用途列出的模块（路径去重）
  → 渲染 self.id / self.name / self.persona / mode
  → 与当前 profile、宿主合同、本次运行资料共同装配
```

读取器先读取所有被清单引用的文件以验证一致快照，但只选择当前用途参与拼接。**“全部文件被读取核验”不等于“全部文件被发送给模型”。** 未登记用途使用 `default`。

依据：[用途编译与原生模板分离](../../src/main/companions/asset-profile.ts#L170)、[实际用途选择](../../src/main/companions/asset-context.ts#L68)、[变量渲染](../../src/main/companions/asset-behavior-defaults.ts#L187)。

### 5.2 实际 manifest 的用途表

下表省略普通路径共同包含的 `共同.md`；profile、宿主合同和运行资料不包含在这一列文件数内。原生功能见第 5.3 节，不能直接套普通拼接公式。

| 用途 purpose | 当前选用文件 | 实际职责 |
| --- | --- | --- |
| `default` | `默认.md` | 未登记用途的通用指导，包括部分语义校验和整理调用。 |
| `chat` | `对话.md` | 清单登记的对话别名；主回复实际使用下一行。 |
| `companion_reply` | `对话.md`、`职能-companion_reply.md` | 用户聊天、主脑工具循环。 |
| `companion_action_feedback` | `结果反馈.md`、`职能-companion_reply.md` | 按真实执行证据向原委托人反馈结果。 |
| `world_attention` | `世界认知.md` | 当前世界注意与感知相关判断。 |
| `world_decision` | `世界认知.md`、`职能-companion_reply.md`、`职能-world_decision.md` | 世界生活行动决定。 |
| `world_message_authorization` | `伙伴交流.md` | 来信、社交来源等语义判断；不能扩大授权。 |
| `world_social` | `伙伴交流.md`、`职能-companion_reply.md`、`职能-world_social.md` | 回应伙伴来信。 |
| `companion_social_initiative` | `伙伴交流.md`、`职能-companion_reply.md`、`职能-companion_social_initiative.md` | 自主联系、邀约和社交意图。 |
| `visit_peer_speech` | `伙伴交流.md`、`职能-companion_reply.md`、`职能-visit_peer_speech.md` | 拜访相关发言。 |
| `companion_internal_work` | `职能-companion_reply.md`、`职能-companion_internal_work.md` | 伙伴内部认知工作。 |
| `activity_task_step` | `职能-companion_reply.md`、`职能-activity_task_step.md` | 持久生活或社交目标的下一步。 |
| `vcp_experience_journal` | `记忆编码.md`、`职能-vcp_experience_journal.md` | 把真实交流片段编码为日记、资料或自我认识。 |
| `vcp_sleep_reflection` | `真实反思.md`、`职能-vcp_sleep_reflection.md` | 依据已读真实记忆形成新认识。 |
| `vcp_sleep_memory_maintenance` | `记忆整合.md`、`职能-vcp_sleep_memory_maintenance.md` | 判断 merge/defer，整理重叠日记。 |
| `companion_dream_wave_narrative` | `梦境与联想.md`、`职能-companion_dream_wave_narrative.md` | 明确虚构的梦或清醒联想。 |
| `companion_learning`、`companion_learning_goal` | `资料学习.md` | 清单登记的通用学习用途；持续学习的实际执行分为下列阶段。 |
| `companion_learning_plan` | `职能-companion_learning_plan.md` | 选择下一轮学习重点。 |
| `companion_learning_learn` | `职能-companion_learning_learn.md` | 整理实际读到的材料。 |
| `companion_learning_consolidate` | `职能-companion_learning_consolidate.md` | 比较、修订同一学习目标的已有知识。 |
| `companion_learning_questions` | `职能-companion_learning_questions.md` | 生成自测问题。 |
| `companion_learning_answer` | `职能-companion_learning_answer.md` | 依据本次真实回忆作答。 |
| `companion_learning_assess` | `职能-companion_learning_assess.md` | 检查回答，记录不足与下一计划。 |
| `vcp_aimemo` | `记忆聚焦.md` | VCP 原生聚焦模板；走专门通道。 |
| `vcp_focus_guidance` | `记忆聚焦指导.md` | 原生聚焦调用的伙伴侧系统指导。 |
| `vcp_tagmaster` | `自动标签.md` | 原生标签模板；走专门通道。 |
| `native_timeline` | `月度时间线.md` | 原生月度经历导航模板。 |
| `native_summary` | `时间线摘要.md` | 月度时间线短摘要模板。 |

初始化规则见 [asset-profile.ts](../../src/main/companions/asset-profile.ts#L53) 和[清单写入](../../src/main/companions/asset-profile.ts#L272)；学习阶段调用见 [learning-goal-integration.ts](../../src/main/companions/learning-goal-integration.ts#L102)。当前实例文件是运行依据，代码默认文本主要用于首次初始化，不是每次再追加一套出厂人格。

### 5.3 原生聚焦、标签与时间线的例外

| 功能 | 当前准确路径 | 不能作出的推断 |
| --- | --- | --- |
| `记忆聚焦.md` | `nativeFocusTemplate` 直接取得该原文件，不包含 common。VCP 用实际查询和候选资料渲染为原生 user 输入。 | 不是普通聊天的固定人格段，也不是每次回复将整个文件夹作为回忆发送。 |
| `记忆聚焦指导.md` | 原生 AIMemo 只有 user 输入、system 为空。通用装配识别为 `vcp_focus_guidance`，加入当前 profile、共同模块与指导；已经渲染好的 user 模板保持原样。 | 聚焦模板与系统指导不是两份可互换文件。 |
| `自动标签.md` | 专用标签 resolver 仅采用当前原 TagMaster 系统模板与待标正文；已有末尾明确 Tag 行时可以直接解析，不调用模型。 | **标签不是通用 profile/common 追加路径**，不能说所有后台处理都加载完整人格。 |
| `月度时间线.md`、`时间线摘要.md` | 原文件分别作为 native 模板，展开 `agentName/month`，附宿主作者归属；模型准入时重读当前模板，再经过通用身份装配。原生 user 正文通常没有宿主 purpose JSON，通用层采用 default 指导。 | 不是将四个原生模板一起加载；时间线生成也不等于该全文已进入本次聊天。 |

依据：[四个独立原模板](../../src/main/companions/asset-profile.ts#L187)、[聚焦用途识别](../../src/main/companions/asset-context.ts#L68)、[原生网关](../../src/main/vcp-chat-gateway.ts#L73)、[标签专用接线](../../src/main/companions/service.ts#L311)、[实际标签模型输入](../../src/main/companions/memory-tags-service.ts#L82)、[月度原生传输](../../src/main/vcp-memory/peripherals.cjs#L338)、[准入时重读](../../src/main/companions/service.ts#L710)。

### 5.4 短说明、完整职能和宿主合同存在重叠

当前 `共同/对话/记忆编码` 等文件多为较短职责说明，`职能-*` 中许多文件包含较完整的行为合同。普通回复同时使用 `共同.md + 对话.md + 职能-companion_reply.md`；世界、社交等用途又复用主脑职能并添加领域职能。

已经观察到的重叠包括：

- 对话短说明与主脑职能都包含主动核查和完整回顾的原则。
- `职能-companion_reply.md` 自带 `self.persona` 插槽；通用装配另加入完整 profile，部分领域职能还包含人格插槽。
- 输出 schema、实际工具、来源权限和领域交付合同还由宿主代码提供，不完全体现在磁盘文件列表中。

依据：[主脑职能人格插槽](../../src/main/companions/asset-behavior-defaults.ts#L13)、[通用完整人格追加](../../src/main/companions/asset-context.ts#L87)、[正式与非正式默认路径](../../src/main/companions/asset-behavior-defaults.ts#L194)。

目标约束：重构需清楚划分人格、可成长表达指导、职能指导与宿主协议，并记录每段实际来源。不能仅重新命名文件后继续无说明地重复装配。

## 6. 某次伙伴上下文从哪里组成

| 上下文部分 | 当前来源 | 是否等于一个磁盘目录 |
| --- | --- | --- |
| 当前身份与人格 | 当前 `profile.md`，以及选中模块中的角色插槽。 | 有直接文件依据，但不是整个人物目录。 |
| 当前职能与输出合同 | 选中的 purpose 模块、宿主代码的领域合同、实际 schema 和工具目录。 | 部分来自文件，部分由代码产生。 |
| 当前目标、消息与话题连续性 | 消息数据库、当前 invocation、话题 checkpoint、近期正式消息、任务过程。 | 不是日记目录的别名。 |
| 当前状态与世界观察 | 宿主实际状态、作息、感知和关系资料。 | 不从历史 `世界经历/` 全文推算此刻。 |
| 当前本人认识 | 有来源、当前有效且本入口可见的 `characterDevelopment`。 | 是受权限约束的投影，不是整个 `自我认识/` 常驻。 |
| 本次回忆 | VCP 以当前查询准备和聚焦的合法记忆；必要时主动读原文。 | 不是全部 `日记/资料/时间线`。 |
| 附件、图像和工具结果 | 本次实际获准、实际读取或执行的输入。 | 文件存在不代表模型已读取；路径不等于像素。 |

多数正式通用后台模型也获得当前 profile。例如记忆编码和反思同时携带本人身份、当前状态、已读记忆与认识目录，但仍受“只返回编码提议”等领域合同约束。依据：[记忆模型输入](../../src/main/companions/memory-model.ts#L126)、[通用身份装配](../../src/main/companions/asset-context.ts#L87)。自动标签是前述例外。

同一伙伴可能同时有聊天、工作、社交和学习请求。当前有效文件、已经准备的任务回忆、某次实际发出的模型请求是不同快照。查看器应以真实模型准入记录展示，而不是读取目录后宣称所有内容都已发送。

| 当前事实 | 目标约束，尚不代表已经实现 |
| --- | --- |
| 当前界面主要按文档、模块、版本及处理记录展示。 | 新界面应按身份、表达、价值认识、当前处境、目标、实际回忆和成长变化组织。 |
| 一个 purpose 的清单只说明可能选用的指导。 | 实际请求记录还应包含本次采用的人格版本、选中模块、消息范围、回忆、工具结果与附件读取状态。 |
| 当前角色资料与某次过去请求可能不同。 | 明确区分“当前有效资料”“排队中未发送”“某次实际采用的内容”，不能让新版本改写旧请求展示。 |

## 7. 当前摄取边界与污染风险

### 7.1 已有排除规则不是严格的目录类型白名单

当前监控和发现会排除点号文件/目录、根级 profile/记忆策略/同步说明、提示词、形象、来源、记忆历史、sidecar/临时文件，以及 `时间线/` 中特定自动产物。依据：[文件事件排除](../../src/main/companions/memory-library-dirty.ts#L62)。

但完整 discover 仍会遍历伙伴根下 **其他非隐藏子目录**，寻找 Markdown 或文本文件；并非只允许日记、资料、自我认识、世界经历、时间线五个类别。依据：[发现与遍历](../../src/main/companions/memory-library.ts#L719)。

| 当前事实 | 重构必须解决的目标约束 |
| --- | --- |
| 未知的普通可见子目录仍可能被扫描为笔记。 | 采用明确文件类型与允许的生产者/消费者；不能以未知目录默认可学。 |
| 当前还没有正式 `起点/`、`成长记录/` 类型。 | 新建这些目录前先登记不可重新摄取的边界；其中的原稿、diff、凭证不能再次变成新经历。 |
| 文件同步当前支持手工新增、正文外部修改和登记后的记忆写入。 | 创建后认知写入应由统一提交控制；不能继续将任何外部字节自动当成合法人格或本人经历。 |
| sidecar 不自行授予来源和权限，旧未登记导出也有拒绝恢复规则。 | 保留现有来源核验，不能因为新类型加入就绕过版本、归属或遗忘屏障。 |

外部新增及正文修改处理见 [memory-library.ts](../../src/main/companions/memory-library.ts#L655)，未登记旧导出拒绝规则见[同文件](../../src/main/companions/memory-library.ts#L781)。这项风险是具体摄取路径问题，不能简单描述成“全部目录现在都会直接进入模型”。

### 7.2 自主资料库阅读与显式 file 学习边界不同

| 入口 | 当前保护 | 仍需区分的边界 |
| --- | --- | --- |
| 资料库自主学习 | 拒绝当前 memoryRoot、库内伙伴记忆，以及 `.worldlinebox/伙伴记忆` 等路径段；仅从授权范围选择资料。 | 不能将“授权整个资产库”解释成自动学习自身全部运行资料。 |
| 持续学习的显式 `file` 材料 | 用户选定附件，经普通文本、大小、编码和版本校验读取。 | 没有同等目录类型判定。显式提供的配置副本等技术文本仍可能作为材料。 |
| 复制到 `资料/` 的文本 | 经正常文档/来源登记与写策略处理。 | 文件位置或来源字符串不能证明语义上没有重复自己的旧资料。 |

依据：[资料库路径保护](../../src/main/companions/learning-assets.ts#L27)、[显式 file 入口](../../src/main/companions/learning-goal-integration.ts#L143)、[普通文本读取器](../../src/main/companions/learning-goal-file.ts#L5)。

目标约束：明确“作为材料读过”“真实经历”“本人认可”“人格依据”的不同关系。技术材料即使被合法阅读，也不能自动成为身份、权限或一份新的独立成长证据。

### 7.3 深度整合不直接扫描目录

深度整合消费已登记、已索引、未归档、具有未覆盖真实来源的合法记忆。普通自动合并还排除梦、模拟、procedure 和当前成长元数据等；旧派生物不能独立制造新的经历欠账。依据：[整合种子选择](../../src/main/companions/memory-model.ts#L77)、[整合校验](../../src/main/companions/memory-model.ts#L237)、[新维护来源选择](../../src/companions/world-store.ts#L1392)。

必须分别理解四步：

```text
文件扫描/同步 → 正式来源与记忆写入 → 索引收录 → 深度记忆整合
```

扫描发现文件不等于已获得合法来源；写入不等于已索引；已索引不等于本次回忆命中；回忆命中不等于本人认可或人格已经改变。

## 8. 本附录对主规范的交付约束

| 当前审计结论 | 主规范应规定的目标 |
| --- | --- |
| 认知正文、指导、历史、证据、自动派生和技术登记同处 owner 根，消费规则分散。 | 给每类文件声明生产者、唯一职责、合法消费者、可见范围、版本和是否可成为新来源。 |
| 33 个模块按职能选择，原生模板又有专门入口。 | 查看器展示实际 purpose 与已采用内容，不能展示库存数量后让用户自行推断。 |
| 一些人格及行为指导重复注入。 | 从统一当前人格装配一次完整身份，避免混合版本和无说明重复。 |
| 创建后的人工编辑与外部文件同步仍是正式路径。 | 完成创建边界与认知提交协议，既覆盖 UI，也覆盖 API、文件同步和模型准入。 |
| 现有起点、反思、记忆历史等内容的角色不同。 | 新起点档案和成长凭证属于非摄取历史类型，发布人格本身不增加新成长证据。 |
| 日记/知识/自我认识具有现有来源与版本机制。 | 复用 VCP 算法及来源、版本机制的代码基础，以新 schema 初始化空账本，新增人格整合与发布；不继续读取旧账本数据。 |

本附录完成的是目录、提示词与上下文消费路径的映射。新架构的实现状态、实施顺序和验收门以[主规范](companion-cognition-refactor-standard-2026-10-28.md)及后续独立验收记录为准。
