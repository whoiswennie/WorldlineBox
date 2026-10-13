# 伙伴消息系统

应用入口在 `ApplicationShell` 的 `companions` 模块，位于启动器和资产管理之间。消息/联系人界面通过独立 preload bridge 调用经 Zod 验证的 IPC；仅管理器主窗口的 main frame 可访问。

## 状态与存储边界

`CompanionService` 调度角色回复、主动联系和 DSH 行动。`CompanionStorageClient` 只负责 UtilityProcess 消息传输；`src/companions/worker.ts` 是独立 SQLite owner，主进程和 Renderer 不打开数据库。消息库位于 `userData/companions/messages.sqlite`，不修改资产数据库迁移。Forge 与隔离 E2E 构建均输出 `companion_worker.js`。

SQLite 使用 WAL、外键、事务迁移和 FTS5。私聊身份由角色 ID 确定；群聊身份由去重排序后的成员 ID 集合确定，与群名无关。旧重复群在事务中合并消息、行动、引用、搜索结果与发送指纹，旧 ID 保存为别名。群名的 auto/custom 标记保存在 metadata，自动标题读取成员当前姓名。发送使用客户端 ID 去重，跨聊天引用与非成员发言被拒绝。消息分页按稳定序号读取；任务历史通过 `actions.page` 按创建 UTC 时间与 ID 倒序游标分页、按角色过滤，列表省略大段输出，详情通过 `action.get` 单独读取，突破原有最近 100 条列表的范围。时间源保存毫秒 ISO 值；启动时刻来自真实 TaskRecord，终态时间在事务中记录。未知新 schema 拒绝打开并保留文件。

角色身份、人设与模型服务独立。无 `llm` 配置时每次请求读取当前全局连接；有 `llm` 时使用角色专属 API 格式、URL 和模型，密钥由 Main 的 `CompanionCredentials` 经 safeStorage 保存。无角色名称或 builtin 标记驱动的模型路由；专属密钥不作为配置字段送入存储 worker。

## 推理与并发

每个聊天空间串行提交角色回复。用户发送新消息先取消旧推理，再持久化新消息；已经运行的 DSH 行动具有独立生命周期。群聊被提及成员优先，否则每轮至多三个成员按顺序生成，每位成员只接收自己的人格、可见消息和允许的记忆，支持空回复/PASS。

模型层支持五种现有 API 格式，限制响应大小、上下文长度和调用时间。最近消息不等于完整存档；模型上下文由人格、当前聊天消息及记忆组装。来源聊天空间由数据库从源消息派生，不能由 Renderer 声明。群内长期记忆按来源空间过滤，私人记忆不自动注入。

自动记忆只接受最新用户消息所表达的可复用信息，保留来源；执行结果反馈不能形成新的用户事实记忆。原始思考链和凭据不进入角色消息；工具参数与结果经过凭据和二进制脱敏后进入独立进度记录。主脑唯一工具为 `dsh`，实际系统命令只由原生执行 agent 的内部工具运行。

主动检查在 Main 常驻，不依赖 React Activity。默认关闭；启用后本地 09:00–22:00，四小时联系间隔、每天两次上限、一次未答后等待用户新消息，另有三十分钟尝试冷却。时间、次数与来源用户消息在 SQLite 中保存。

## DSH 回流

用户委托先登记行动，再通过 `task.run` 固定执行实例。主脑五种协议均发布同一份 `dsh` 函数说明：每次可提交最多四个独立完整目标，依赖步骤留在同一任务。自然任务识别覆盖时间、新闻和写作等请求，短确认只解析最近尚未执行的真实用户请求；模型未发出 action 时仍有基于授权任务的实际执行回退。群内明确指定其他成员时才允许任务转交。主动事件、聊天模式与结果回流不启动新行动。来源消息已登记的行动不会因重生成而重放。

`companion-runtime-source.ts` 是对已安装官方 SDK 的薄 CLI 插件。原生 Agent 持有模型调用、上下文、工具调度、并行安全边界、收件箱、重试和 session 持久化；本项目没有复制或另写该 loop。关闭原生一次性 stdin 驱动，保留带回执的 NDJSON 输入：`steer` 使用原生下一步骤入口，`queue` 使用原生下一轮入口，取消调用原生 cancel。结束等待原生 whenIdle，并用输入修订号和短 admission 检查处理空闲边界。主进程与角色推理独立管理每条任务，排队任务可取消；实例仅在短暂准备 CLI profile 时串行，执行阶段允许并发。

轮询同时检查 TaskRecord 和 Operation，覆盖环境准备失败而尚无 TaskRecord 的情况，另有硬性截止。取消期间的晚到启动或结果不能覆盖 cancelled；关闭应用只将仍未完成的行动保留为 interrupted，已确认的 cancelled 保持原状态。

完整结果独立持久保存于行动卡。角色反馈使用独立 `actionResult` 资料事件，有明确来源消息与状态；工具输出不能覆盖人格或成为新的系统指令。进程退出成功只表示执行器完成，角色仍须依据结果内容判断用户目标是否实际达成。

Main 通过 `requestTask` 的内部参数启用伙伴工具集。临时 patch 启用选定 SDK 已有的文件、图片、搜索、平台 shell、后台作业与技能基础模块，补齐原生 headless runner 未加载 Web preset 时缺少执行工具的差异。不会移除基础模块或改写用户的 CLI 长期 profile。当前 native overlay 验证版本为 0.2.0-rc.2 与 0.2.1-alpha.2。

启动器在 `execution-access.json` 中保存统一权限，默认 `danger-full-access`。Main 初始化完成后读取当前设置，并在任务环境准备前冻结权限快照。原生 patch 同时配置 sandbox policy、文件与平台 shell 执行器、permission preset 和 approval policy，权限不是提示词约定。伙伴的新任务使用新的执行 session；原生 session 持有已记录的策略，因此禁止用新权限续跑旧 session。受限模式是 DSH 对文件效果的约束，Windows 原生 SDK 报告 shell enforcement 为 partial，不宣称为独立 OS 容器或权限提升。

官方 DeepSeek 全局连接通过 Main 私有参数临时注入 DSH 官方 provider，映射其 Anthropic 兼容入口。密钥仅存在子进程环境，patch 使用环境变量引用；上下文、任务元数据、公开 IPC、SQLite 和事件都不携带密钥。任务结束清除非秘密临时 patch。其他全局 provider 沿用 DSH 原生配置，角色专属连接只影响对应人格推理。

Broker 投影原生 session/status/tool_call/tool_result/final/error，并订阅 `agent/assistant-stream` 的公开文本与工具参数增量，约 100 ms 合并为有界快照。草稿、提交和放弃状态分别显示，参数生成不被当作已执行；reasoning-delta 不进入流。Key、Authorization、环境变量秘密、像素 base64 等经过脱敏，跨帧密钥尾部会暂缓发布。Renderer 直接订阅实时 IPC，再用序号合并持久快照，晚到的 SQLite 读取不能回退流内容。任务保留最多 1000 个事件，伙伴行动保留最近 150 个合并事件；完整 native session 仍由 DSH 保存，不承诺窗口无限保留原始日志。

底部模式菜单、群聊任务弹窗与历史分页独立于任务生命周期。消息渲染采用 react-markdown / GFM / KaTeX / highlight.js；Mermaid 懒加载，严格固定配置并通过 DOMPurify 限制 SVG，不执行原始 HTML。Markdown 外部图片显示链接，应用附件通过受控协议预览。

## 参考机制

中断恢复通过官方 `agents.resume({resumeSessionId})` 接回原生持久会话，由原生工厂修复缺失的工具结果与 turn/step 结束事件，并取得独占写入权。Main 仅保管恢复所需的任务目标、原实例/版本/工作目录/权限、输入标识及排队依赖，存于消息 SQLite 的 metadata；密钥不进入 checkpoint。原版本通过临时 CLI selection 选择，不改实例的长期默认版本。

恢复输入在原生工厂 maintenance 阶段安排：原任务继续要求放在 next-turn 队列前端，未完成补充按原 next-step/next-turn 位置恢复；随后用公开 steer 入口唤醒，避免私自调用驱动内部方法。已完成 turn 的输入以及现有收件箱输入按稳定来源 ID 去重。每次恢复沿用同一领域任务 ID，归档前一次可见进度，增加 attempt 并记录本次时间。

普通角色回复通过与用户消息同事务的 reply checkpoint 保存 delivery 与 completedIds；角色发言与完成标记同事务提交。重启后只恢复未完成发言，明确取消的回复保留 cancelled。`task.terminate` 仅调用 broker 当前持有的进程能力，终止选中 CLI 树，不接受任意 PID。

维护者指定的本机 `C:/Users/hp/Desktop/project/deepseek-harness` 调研快照为 `639ed01539`。研究了 Agent.followup/steer/cancel/whenIdle、原生工具并发调度和公开流事件。SDK JSON-RPC 不提供 steer，一次性 headless 驱动也不保留 stdin，因此以官方 Agent API 构建 CLI 传输适配器，执行行为仍由原生 loop 管理。

参考 [Generative Agents](https://arxiv.org/abs/2304.03442) 的经历、检索与反思，以及 [MemGPT](https://arxiv.org/abs/2310.08560) 的分层上下文思路。实现为本项目独立代码，不采用外部聊天框架来持有角色身份。

维护者指定的 [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot) 已独立拉取到 `C:/Users/hp/Desktop/project/new/test2`，固定调研快照 `7e1c5184d63e796def85469793117befbbe5003f`（仓库重定向至 Fei2411/DeepSeek-Bot）。学习长期联系人、群聊沉默/轮次预算、来源记忆和上下文 checkpoint 的机制，不搬运源码。该项目把 Bot 对应到 DSH session；WorldlineBox 的人物状态与存档由自身领域持有，仅把行动委托给 DSH。

当前实现已采用群聊合理沉默、提及优先、有界轮次和独立来源记忆。专用记忆审核模型、自动 context checkpoint 与用户自然语言创建角色/组群是后续可扩展点，未标记为已实现。

源码依据：[群聊顺序与 PASS](https://github.com/Fei2411/DeepSeek-Bot/blob/7e1c5184d63e796def85469793117befbbe5003f/ds-bot/src/host/groups.js)、[来源记忆与审核游标](https://github.com/Fei2411/DeepSeek-Bot/blob/7e1c5184d63e796def85469793117befbbe5003f/ds-bot/src/host/memory.js)、[上下文整理预算](https://github.com/Fei2411/DeepSeek-Bot/blob/7e1c5184d63e796def85469793117befbbe5003f/ds-bot/src/host/steward.js)。该项目 SQLite 是 DSH 日志的可重建搜索索引；WorldlineBox 的 SQLite 是伙伴消息的权威存档，领域职责不同。

## 验证

数据库测试使用 Electron ABI 的真实 better-sqlite3；模型协议与 UI 测试使用明确 fixture。桌面测试使用独立用户目录、真实 IPC/UtilityProcess/SQLite 与本地 HTTP 模型服务，验证全局连接继承、专属连接隔离、密钥加密和重启持久性。自动测试不调用真实付费模型账户；维护者另行授权的真实桌面任务使用应用已保存的连接，验证记录保存在 Git 忽略的 `artifacts/companions/live/`。

原生工具集测试直接加载上述两个封装 SDK，验证文件、图片、搜索与平台 shell 的实际注册；权限验收对每个 SDK 的三种策略实测工作区内外的文件及 PowerShell 写入，模型请求数为零。消息与联系人界面的截图在 `artifacts/companions/verified-*.png`。

新架构的真实两角色十章写作、下一步骤引导、下一轮排队、并发和自然时间查询结果见 [任务循环验收](companion-loop-acceptance.md)。自动化另用 125 条真实 SQLite 记录验证完整任务分页、角色隔离与重启，桌面测试用 45 条离线 fixture 验证布局、精确时间与翻页；这些 fixture 不冒充真实模型执行。

2026-10-13 的真实桌面验收使用应用已保存的全局 DeepSeek 连接：小肥鱼生成委托，DSH 在 `danger-full-access` 下实际调用 PowerShell 和 `read_image`，检查桌面顶层 8 张图片及维护者提供的 3 张参考图，持久保存 42 条可见执行事件，并生成独立角色反馈。未修改原图片。详情只留在本机消息库和忽略目录，避免把私人桌面内容写入仓库。SDK 首次准备环境约三分钟，界面在此期间显示已接单、准备状态与计时；工具开始后逐步回传真实记录。
