# 伙伴消息系统

应用入口在 `ApplicationShell` 的 `companions` 模块，位于启动器和资产管理之间。消息、联系人、任务与社交观察通过独立 preload bridge 调用经 Zod 验证的 IPC；仅管理器主窗口的 main frame 可访问。三维世界使用可多开的原生观察窗口与窄 preload，只能访问世界观测、设置和自身窗口控制。

## 状态与存储边界

玩家公开资料由 `shared/companion-profile.ts` 定义，通过 `player.profile.get/update` 与 `state.playerProfile` 提供。固定 ID 为 `user`，姓名、自述与头像/三视图附件引用使用修订号控制并发；删除图片引用不会修改聊天作者 ID。伙伴也有公开三视图及资料修订号。Main 的 `CompanionPublicProfiles` 每次推理重新解析当前参与者，只接收管理副本；内置头像从源码或打包的 renderer hashed assets 物化到 `userData/companions/portraits`，不能把外部工具无法读取的 `app.asar` 虚拟路径冒充真实文件路径。

头像选择共用 `AvatarCropDialog`，通过管理器主窗口的 `avatar.crop` 请求生成正式 PNG。裁剪参数使用 EXIF 校正、用户旋转后的图像坐标：正方形边长为 `round(min(width,height)/zoom)`，中心与提取区域限制在图像边界内。Main 验证管理附件、20 MiB 与 64M 像素限制，Sharp 完整解码后旋转、提取并输出 512×512 PNG，保留透明度；原图与已保存资料不修改。圆形取景是 UI 显示规则，正式方形文件供聊天圆形遮罩与真实视觉读取共用。

裁剪界面使用语义主题变量、统一控制区与三种显示场景预览；窄窗口将预览移至画布下方，仅中间内容滚动，保留头部与确认区。取景圆直径始终为画布的 75%，与拖拽换算和导出几何一致；真实 Electron 验证覆盖明暗主题、窄窗口无横向溢出、焦点恢复、滚轮隔离、用户/伙伴表单保存及原始像素对比。美术验收截图使用现有角色头像，像素校验另用确定性的合成源图。

`public-profile-context.ts` 将公开资料、身份和当前图像交付状态投影到本次推理，旧 checkpoint 中的资料不能覆盖现状。完整图片经 Sharp 校验与有界转换，三视图最长边 1536、头像 512，单图最多 1 MiB。图像在内存中转换为各 provider 的原生内容块，不写入 checkpoint 或聊天正文；本轮最多四图、总计 4 MiB，最近实际工具图片优先于公开形象。`visionManifest` 与 `toolVisionManifest` 区分 `image_provided`、`path_only` 和不可用原因。模型能力未知时保留路径；明确不支持图像的 400/415 仅同模型重试一次纯文本，其他请求错误照常处理。

主脑只读能力由 `shared/companion-file-tool.ts` 定义：`read_file` 使用 0 基行 offset（默认 0）与 limit（默认 200、最多 2000）返回有行号的真实文本窗口和 nextOffset；`read_image` 返回管理快照引用；`send_file` 只把已有文件复制为当前回复附件。执行和文件修改仍由 DSH CLI 承担。`file-reader.ts` 限制普通绝对路径文件、输入字节和图片像素，验证读取过程与持久快照校验和；结果只保存文本和附件引用。每次推理按仍有效的来源重新加载工具图片；撤回的来源不会借旧工具结果恢复。自主闲聊和伙伴社交不能借此读取任意本机文件。

文件调用用来源、伙伴、步骤和 call ID 的稳定哈希标识。`file.result.commit` 在同一 SQLite 事务中登记管理快照与完整工具结果；恢复同一调用直接读取已保存结果，不重新读取已经变化或删除的原文件。该内部协议不向 Renderer 开放。成功遗忘会推进 Main 的来源修订标记，加载图片后及模型结果提交前检查变化，丢弃并重新生成受影响的推理；文件读取完成后也重新核查来源。

循环结果中明确的 `attachmentIds` 同步到同一个回复气泡，`images` 保留真正视觉所需的快照引用。每条回复最多展示十个附件；超过后只读仍可继续但工具结果明确说明未新增卡片，`send_file` 则明确返回限制，存储层拒绝静默截断。`worldlinebox-companion` 只服务已登记附件，支持 GET、HEAD 与单段 Range；媒体使用文件流、正确 MIME 和 206/416，不把视频整体读进内存。Renderer 的附件组件复用图片预览、原生音视频播放与类型文件卡；切换会话释放媒体资源，HTML/SVG 等未知文件不作为可执行文档展示。

设计参考本机 `C:/Users/hp/Desktop/project/deepseek-harness` 的 `packages/fs/tool-fs/src/read.ts`、`read-image.ts` 与 `packages/llm/llm-deepseek/src/images.ts`：分页读真实文本、完整解码图片、持久附件引用、provider 真正像素传递。本项目没有复制其执行 Agent 或再造一层任务框架。原 DSH standard 已挂载 tool-fs；新增能力解决的是主脑直接查看与前端展示，DSH 原生工具仍可正常使用。

伙伴身份、玩家与 NPC 的回复对象、唯一伙伴私聊/群聊、主动手机通信和按天只读观察的契约见[伙伴身份与社交](companion-social.md)。主脑每次推理都由宿主投影真实 self、发言者、参与成员与回复源；provider 的 `role=user` 仅是传输信封。

`CompanionService` 调度角色回复、主动联系和 DSH 行动。`CompanionStorageClient` 只负责 UtilityProcess 消息传输；`src/companions/worker.ts` 是独立 SQLite owner，主进程和 Renderer 不打开数据库。消息库位于 `userData/companions/messages.sqlite`，不修改资产数据库迁移。Forge 与隔离 E2E 构建均输出 `companion_worker.js`。

SQLite 使用 WAL、外键、事务迁移和 FTS5。私聊身份由角色 ID 确定；群聊身份由去重排序后的成员 ID 集合确定，与群名无关。群名的 auto/custom 标记保存在 metadata，自动标题读取成员当前姓名。发送使用客户端 ID 去重，跨聊天引用与非成员发言被拒绝。消息分页按稳定序号读取；任务历史通过 `actions.page` 按创建 UTC 时间与 ID 倒序游标分页、按角色过滤，列表省略大段输出，详情通过 `action.get` 单独读取，突破原有最近 100 条列表的范围。时间源保存毫秒 ISO 值；启动时刻来自真实 TaskRecord，终态时间在事务中记录。

内置联系人只能完整重置，存储层拒绝删除。重置先持久化停止屏障与永久来源水位，确认外部任务取消后再分批清理；中断和错误均可从同一任务继续。玩家混群保留其他作者并退群，三人及以上的纯伙伴群保留稳定成员集合、仅删除重置作者的发言，同时隔离该伙伴的全部旧来源。接口、附件边界和 20 万条合成记录的实测见 [内置伙伴完整重置](companion-reset.md)。

本次已按维护者要求直接清空本机旧聊天、消息、共同记忆和关联任务，保留联系人资料及模型连接配置。代码仅维护当前数据结构，没有按旧编号切换实现或迁移旧聊天的分支。新记录的崩溃恢复、来源核对和未整理消息补登记继续工作，不能将这类恢复描述成对已清空旧数据的历史回填。内容修订号用于事实纠正、来源核验和并发审计，不表示存在多套代码逻辑。

聊天右侧「我们之间」现在是伙伴手帐：紧凑身份、真实动态心情与精力、周历和便签待办。记忆与任务历史通过按钮打开独立大窗口；共同记忆使用列表与来源双栏，后台进度默认折叠。日程窗口提供提醒/任务、重复周期、修订校验编辑、暂停/恢复、取消和立即执行；作息与习惯页读写宿主的真实配置和只读养成进度。状态及列表从当前聊天范围请求，并订阅 `onChanged` 自动刷新。完整人设仍在联系人资料；状态计算与产品参数见 [连续状态与关系算法](companion-state-algorithm.md)。

聊天正文从五类连接的真实流式返回中读取。Main 约每 60 ms 合并当前步骤的累计正文，通过 `COMPANION_REPLY_STREAM_CHANNEL` 推送；只发送正文，不把思考、工具参数或未结束的结构化提议混入气泡。Preload 校验 `CompanionReplyStreamEvent` 后通知 renderer。界面只有一个 IPC 订阅，各气泡通过按消息标识订阅的外部 store 更新；增量不会反复加载聊天、任务、记忆或侧栏。自动滚动遵守当前聊天和阅读位置，浏览历史时保持原位。

流事件绑定聊天、伙伴、来源消息、回复消息、步骤和尝试标识。重试或恢复采用新的尝试标识，替换当前步骤草稿并忽略迟到的旧帧；前序已提交步骤保留。`committed` 代表本步骤已持久化，renderer 在匹配的实际消息快照接管后才移除覆盖层；不能因新尝试的前缀恰好等于旧草稿就认定已提交。生成中显示轻量光标，能力执行阶段不继续假装吐字。取消与中断保留已有正文并显示标识。

约每 750 ms 保存 `checkpoint.draft`，用于异常关闭后的部分正文恢复。`message.isReplyDraft` 与 `replyDraft` 由宿主投影，前者覆盖整个尚未完成的循环，不能由用户提交注入。正式消息发布后才能作为自动记忆来源；已经出现在屏幕上的最后一小段在崩溃前未必已经落盘，不能承诺逐字符恢复。细节与验证边界见 [伙伴自治记忆实施说明](companion-memory-implementation.md)。

角色身份、人设与模型服务独立。无 `llm` 配置时每次请求读取当前全局连接；有 `llm` 时使用角色专属 API 格式、URL 和模型，密钥由 Main 的 `CompanionCredentials` 经 safeStorage 保存。无角色名称或 builtin 标记驱动的模型路由；专属密钥不作为配置字段送入存储 worker。

## 推理与并发

用户消息先持久化，再为参与的每个角色登记独立工作项。FIFO 事务调度限制全局20、每角色5；新消息不会取消旧推理，超额工作等待空位。群聊被点名成员优先，否则所有成员均有独立发言机会，允许空回复/PASS。每位成员只接收自己的稳定人格、当前聊天消息、公开成员资料和允许的记忆。

模型层支持五种现有 API 格式，保留响应大小和调用超时保护。最近消息不等于完整存档；模型上下文由人格、当前聊天消息、自动召回的相关记忆与来源组装，不另设主脑总 token 或字符裁剪层。来源聊天空间由数据库从源消息派生，不能由 Renderer 声明。群内长期记忆按来源空间过滤，私人记忆不自动注入。

普通循环使用源消息序号读取之前49条记录，并单独固定完整当前请求与显式引用。基础 system/user 输入在第一次推理前存入 loop checkpoint，后续步骤与中断恢复复用该快照，只追加本循环的工具结果和明确引导。旧消息是背景，不是待办列表；后续消息不会挤掉较早的排队请求或随时间变化混入已启动的回复。主动联系继续使用触发时的最近50条对话。该快照用于任务隔离，不构成长期记忆检索或长任务 token 压缩机制。

正式消息与记忆待处理项在消息库事务中登记。后台增量处理用户消息及已发送伙伴回复，保留来源身份、序号、修订和校验；原生记忆工具与后台共用事实修订、标签、证据校验和遗忘规则。执行计划不能作为已完成成果，伙伴感想与未决假设不升级为用户事实。召回组合主体/事实键、事件、标签别名、全文和有来源的关系，必要时检索原始消息；全链路不配置、不请求 Embedding。实现边界与验证见 [自治记忆实施说明](companion-memory-implementation.md)。原始思考链和凭据不进入角色消息；工具参数与结果经过凭据和二进制脱敏后进入独立进度记录。主脑提供 `dsh` 与原生 `memory.*` 工具，实际系统命令只由原生执行 agent 的内部工具运行。

主动检查在 Main 常驻，不依赖 React Activity。默认关闭；启用后本地 09:00–22:00，四小时联系间隔、每天两次上限、一次未答后等待用户新消息，另有三十分钟尝试冷却。时间、次数与来源用户消息在 SQLite 中保存。

## 主脑循环与标准 DSH

所有 message.send 进入同一个主脑循环。原生 function call 的 id、参数、assistant 正文与 tool result 成对保留，五种协议分别序列化实际调用历史。主脑公开 dsh 与 memory 工具；宿主分别分发外部执行和本地记忆请求，不使用意图正则决定是否提供能力，不再走单轮聊天加后台反馈路径。每步等待本批全部能力结束，再继续推理。正文直接使用 Markdown，避免官方 DeepSeek 在 JSON 正文与工具调用并用时返回未完成 JSON。

loop/<source>/<role> 与 message-loop/<message> 保存完整决策、结果与段落；一个来源和角色使用稳定 clientId，恢复不产生第二个气泡。决策先提交再开始外部操作，重启按父消息、步骤、toolCallId 找回已登记行动。有结果的不重做，没有结果的同一原生会话核对后继续。

companion_work_queue 是 UtilityProcess 独占的 SQLite FIFO 队列，事务 claim 限制全局20、单角色5。消息与待调度标记原子保存，启动时补齐提交后尚未 enqueue 的消息。尚未开始的 queued 自动调度；running 转 interrupted，等待用户明确恢复。原生 CLI 能力还有独立20/5容量队列，超过上限等待，不通过失败丢弃目标。引导从队列摘取是原子事务，避免与 claim 竞争。

companion-runtime-source.ts 是已安装官方 SDK 的薄适配器。它在 create/resume 的 unpublished setup 中通过 agentPresets.mount(scope, 'standard') 挂载实例的标准预设，不另造精简工具名单，不覆盖用户预设的插件或技能。tools 使用 native 呈现，新的伙伴能力显式采用 danger-full-access。headless 仅提供进程与输入输出载体，模型/工具循环、收件箱、上下文压缩、子代理与原生 session 仍属于 DSH。

官方 DeepSeek 临时连接同时设置 llm-deepseek 和 web-search-deepseek 的凭据引用；实际密钥只在子进程环境。公开 token、工具参数草稿、调用与返回通过带序号 NDJSON 流投影到前端，私有推理与凭据不进入进度。Main 记录真实启动、退出与原生会话，手动结束只针对自己拥有的进程树。

附件登记绝对路径，不读取字节进入主脑请求；头像单独缓存。原文件引用通过主进程的受控协议预览，原路径由文件选择器登记。正文、附件与能力结果均为数据，不可覆盖角色身份或扩大用户任务。

## 参考机制

中断恢复通过官方 `agents.resume({resumeSessionId})` 接回原生持久会话，由原生工厂修复缺失的工具结果与 turn/step 结束事件，并取得独占写入权。Main 仅保管恢复所需的任务目标、原实例/版本/工作目录/权限、输入标识及排队依赖，存于消息 SQLite 的 metadata；密钥不进入 checkpoint。原版本通过临时 CLI selection 选择，不改实例的长期默认版本。

恢复输入在原生工厂 maintenance 阶段安排：原任务继续要求放在 next-turn 队列前端，未完成补充按原 next-step/next-turn 位置恢复；随后用公开 steer 入口唤醒，避免私自调用驱动内部方法。已完成 turn 的输入以及现有收件箱输入按稳定来源 ID 去重。每次恢复沿用同一领域任务 ID，归档前一次可见进度，增加 attempt 并记录本次时间。

普通角色回复通过与用户消息同事务的 reply checkpoint 保存 delivery 与 completedIds；角色发言与完成标记同事务提交。重启后只恢复未完成发言，明确取消的回复保留 cancelled。`task.terminate` 仅调用 broker 当前持有的进程能力，终止选中 CLI 树，不接受任意 PID。

维护者指定的本机 `C:/Users/hp/Desktop/project/deepseek-harness` 调研快照为 `639ed01539`。研究了 Agent.followup/steer/cancel/whenIdle、原生工具并发调度和公开流事件。SDK JSON-RPC 不提供 steer，一次性 headless 驱动也不保留 stdin，因此以官方 Agent API 构建 CLI 传输适配器，执行行为仍由原生 loop 管理。

参考 [Generative Agents](https://arxiv.org/abs/2304.03442) 的经历、检索与反思，以及 [MemGPT](https://arxiv.org/abs/2310.08560) 的分层上下文思路。实现为本项目独立代码，不采用外部聊天框架来持有角色身份。

维护者指定的 [DeepSeek-Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot) 已独立拉取到 `C:/Users/hp/Desktop/project/new/test2`，固定调研快照 `7e1c5184d63e796def85469793117befbbe5003f`（仓库重定向至 Fei2411/DeepSeek-Bot）。学习长期联系人、群聊沉默/轮次预算、来源记忆和上下文 checkpoint 的机制，不搬运源码。该项目把 Bot 对应到 DSH session；WorldlineBox 的人物状态与存档由自身领域持有，仅把行动委托给 DSH。

当前实现采用群聊合理沉默、提及优先、独立来源记忆，以及同伙伴聊天模型驱动的后台增量提取和请求前自动召回。持久化处理水位与会话快照分别用于记忆形成和任务恢复；没有将永久聊天维护成不断 append/compact 的执行 session。独立审核角色和用户自然语言创建角色/组群仍是后续可扩展点。

源码依据：[群聊顺序与 PASS](https://github.com/Fei2411/DeepSeek-Bot/blob/7e1c5184d63e796def85469793117befbbe5003f/ds-bot/src/host/groups.js)、[来源记忆与审核游标](https://github.com/Fei2411/DeepSeek-Bot/blob/7e1c5184d63e796def85469793117befbbe5003f/ds-bot/src/host/memory.js)、[上下文整理预算](https://github.com/Fei2411/DeepSeek-Bot/blob/7e1c5184d63e796def85469793117befbbe5003f/ds-bot/src/host/steward.js)。该项目 SQLite 是 DSH 日志的可重建搜索索引；WorldlineBox 的 SQLite 是伙伴消息的权威存档，领域职责不同。

## 世界观测界面

`shared/companion-world.ts` 的快照是世界观测的唯一状态来源。`scene.objects` 同时提供寻路的实体占地、交互锚点和可视家具数据；Three.js 窗口不维护第二份人物移动或碰撞状态。观察相机的旋转、缩放、平移与住户切换不会发出人物指令。公开 IPC 通过同一 `companionsRequestSchema` / `companionsResponseSchema` 校验世界请求与快照；房主审批由对应伙伴完成，观测窗口只显示结果。

`renderer/companions/world` 延迟加载原生观察窗口，可以多开且与主聊天同时使用。可见时每秒请求世界快照，多个窗口共享短时合并结果；React 只更新已接收的状态。命令式渲染沿已知路径按快照实际间隔插值，动态上限按可见窗口数量为 30/24/20 fps，静止画面在三帧切换或状态变化时按需绘制，隐藏和最小化不绘制也不轮询。三帧动作由宿主开始时刻与素材时长确定，每帧使用配准后的独立身体锚点与语义接触点，不逐帧缩放，不把合理跑步腾空压平。无素材的自定义伙伴使用自己的头像标记。

观察偏好按窗口槽位单独保存在本机 `companion-world-observer` 及带槽位后缀的 localStorage 项中，仅包含场景、跟随选择与各场景相机 position/target/zoom，不复制世界权威数据。`WorldViewportEngine.getView/restoreView` 提供视角接口；操作结束、隐藏、关闭、beforeunload 及定期检查时仅在发生变化后保存。偏好通过有限数值、相机距离、缩放与数量边界校验，损坏或不可访问时回退。全局世界入口恢复对应窗口上次观看位置，指定伙伴的小屋入口优先打开该家。真实 Electron 验收覆盖多窗口互不覆盖、关闭重开后的相机与场景，以及应用重启后的跟随选择。

静态房屋按材质合并几何体，仅保留所选场景的人物纹理；分辨率比限制为 1.5，后台停止绘制，关闭时释放控制器、监听器、几何体、材质和纹理。共享布局包含室外建筑实体占地，街区外观与室内观测分别按当前场景创建。天气、光照与温度取快照中的虚拟环境，不调用外部气象服务。

## 验证

数据库测试使用 Electron ABI 的真实 better-sqlite3；模型协议与 UI 测试使用明确 fixture。桌面测试使用独立用户目录、真实 IPC/UtilityProcess/SQLite 与本地 HTTP 模型服务，验证全局连接继承、专属连接隔离、密钥加密和重启持久性。自动测试不调用真实付费模型账户；维护者另行授权的真实桌面任务使用应用已保存的连接，验证记录保存在 Git 忽略的 `artifacts/companions/live/`。

原生工具集测试直接加载上述两个封装 SDK，验证文件、图片、搜索与平台 shell 的实际注册；权限验收对每个 SDK 的三种策略实测工作区内外的文件及 PowerShell 写入，模型请求数为零。消息与联系人界面的截图在 `artifacts/companions/verified-*.png`。

新架构的真实两角色十章写作、下一步骤引导、下一轮排队、并发和自然时间查询结果见 [任务循环验收](companion-loop-acceptance.md)。自动化另用 125 条真实 SQLite 记录验证完整任务分页、角色隔离与重启，桌面测试用 45 条离线 fixture 验证布局、精确时间与翻页；这些 fixture 不冒充真实模型执行。

2026-10-13 的真实桌面验收使用应用已保存的全局 DeepSeek 连接：小肥鱼生成委托，DSH 在 `danger-full-access` 下实际调用 PowerShell 和 `read_image`，检查桌面顶层 8 张图片及维护者提供的 3 张参考图，持久保存 42 条可见执行事件，并生成独立角色反馈。未修改原图片。详情只留在本机消息库和忽略目录，避免把私人桌面内容写入仓库。SDK 首次准备环境约三分钟，界面在此期间显示已接单、准备状态与计时；工具开始后逐步回传真实记录。
