# 伙伴改为原生 DSH 会话

开发分支：`codex/dsh-native-companion-refactor`。本次开发不包含打包、合并或远程推送。

## 执行边界

WorldlineBox 保存联系人、人设、消息、媒体授权和 VCP 记忆，只进行确定性的消息路由、工具回调与界面投影。应用不再运行主脑模型循环，不再维护任务中心、委派计划或第二层 Worker 调度器。

同一话题按伙伴绑定原生 DSH Session，空闲追问接续所选话题；新话题产生独立 Session。同一事件传输中断时重新连接原会话，不通过新事件重做操作。同一伙伴的会话共用稳定工作区，不同伙伴拥有不同工作区；界面聊天历史不会整段重放到新话题。每轮输入包含当前消息、角色提示词、当前受众、已核验附件和 VCP 被动召回证据；原生 Session 自行保留本话题上下文。

插件为原生 Agent 增加表情、记忆、伙伴联系与用户提问回调。原生 DSH 保留执行、工具、上下文和子代理机制。`sessions_list/read/send/spawn/wait` 面向通用任务，只查询同伙伴工作区；原生子代理继承该伙伴身份和回调能力，不复制父会话完整上下文。

文件交付使用 DSH 原生 `present` 工具及 `deliverables/presented` 事件。WorldlineBox 把这些原生交付投影到当前回复的附件，不再提供 `chat_send_file`、`worker_chat_send_file` 或按旧任务编号发布产物的工具。用户上传附件和表情功能保留。

## 消息表现

任务进行时，紧凑进度和必要的原生询问、继续执行控件显示在气泡外；完成后移除进度栏。完成的聊天气泡仅保留最后一段原生正式正文、表情包组和附件，不显示中途正文、工具产生的表情台词或完成统计。界面只保留最右侧的信息栏展开按钮。

`bot_reply_parts` 持久保存所有已提交的公开正文、表情和原生 `present` 交付，原始片段按原生事件序号完整保留供历史、记忆和恢复使用；渲染投影只选择最后一段非空正文，并汇集实际表情和附件，不显示媒体台词。工具回调带宿主验证的根 Session/序号；文件导入完成时间不改变展示顺序。原生终态回执包含同样的输出身份，重连补齐缺失片段，已存在片段不重复发布。媒体发送回执与授权保留，原始媒体发布行在聊天、搜索、历史投影中由父回复代替，历史游标仍越过被抑制的发布行。只合并相邻、完全相同的正文/表情台词，不猜测删掉语义相似的不同回答。纯表情无需补造正文，后续失败也保留此前已经确认的正文和交付物。内部 VCP 编码/维护沿用受限 `brain` 通道的原输出，不混入公开聊天片段。

## 话题路由与消息队列

`bot_native_topics`、`bot_topic_bindings`、`bot_topic_events` 将 UI 话题、伙伴、ACL 代际与原生通道绑定，数据库版本为 21。实例选择、停止、恢复和工具回调均解析相同绑定；切换共享实例仍不能搬移已绑定话题。旧版 `turn-${event.id}` 会话按话题列表的有限页面接入，不扫描或导入无关 DSH 工作区。

话题默认最近 6 条，全部/收藏夹每页 12 条。查询在数据库中合并当前话题与未接入的旧会话，支持多关键词、间隔字符模糊匹配、置顶与活动时间的稳定游标；不先载入全部话题到渲染进程。显式重命名不改变活动排序。`bot_topic_title_sync` 将每个伙伴绑定会话的名称及版本保存为可重试任务，确认 DSH 原生 `session/title` 后清除待同步状态；较旧操作不能覆盖较新名称。冷会话的临时 Agent 由桥接器拥有并在返回确认前释放，防止占用会话写锁阻塞后续追问。有待执行原生 Inbox 的冷会话等待正常任务携带完整配置接入，不因重命名唤起推理。新表均进入已有后台伙伴清理范围，保留 DSH 工作区的边界不变。

用户通过当前话题、手动新话题、话题列表或历史回复旁的话题入口选择去向。路由依据明确选择与因果关系；主脑可使用 DSH 原生 `sessions_*` 工具联系本人已有会话。应用不运行额外的语义分类模型。群内伙伴交接继承原任务话题；用户同时发送的独立问题可以排队进入另一话题，迟到的项目回报仍回原项目。伙伴私聊为相同项目保有独立的双方会话，不混入各自与用户的私聊历史。

忙碌期间的新输入保存在原有持久 Inbox，显示在输入框上方。引导先在同一事务中把尚未运行的队列项保留为 `bot_guidance`，再以稳定消息 ID 调用原生 `Agent.steer`。桥接器先写 prepared 回执、同步原生 Inbox/日志，再写 accepted；重试核对原回执和原生日志。确认未接收才恢复排队；未知结果保留待核实，不能同时创建替代任务。附件查询只额外授权明确引导给本事件的消息，不扩大到其他后续队列输入。成功答复的 VCP 捕获包含实际接受的补充消息。

压缩通过当前预设的原生 `/compact` 命令处理器执行；它能访问 DSH 预设内部隔离的压缩服务。桥接器保存稳定 command/run、command/done 与操作回执，原生 compaction/start、summary、end 提供恢复依据。HTTP 响应丢失不再次压缩；短历史明确返回无需压缩，已确认失败与未知结果区别处理。压缩保留 Session 身份，模型总结仍由 DSH 完成。

一个项目有一个负责用户任务的伙伴主脑；本次真实案例由大肥鱼担当，Claude 开发、GPT 独立验收。三者各有一个原生项目话题 Session，使用多轮事件接续。盒子的一个共享 router 服务负责投递，项目内没有 Router 模型会话。DSH 原生子代理属于可选额外执行会话，本案例未以额外 Router 替代任何伙伴。

移除了启动器的插件市场、技能市场、伙伴能力及其冗余管理实现。插件、技能与账号配置在 DSH 原生界面管理。运行版本、实例、整合包、操作记录及启动功能保留。

## 数据兼容

已有用户聊天、角色、记忆与文件保留。旧任务表、版本迁移及历史来源关系仅用于升级兼容；旧任务不会由新引擎重新启动。VCP 写入沿用稳定的来源和操作编号，回调响应丢失时先读取持久回执，避免重复写入。撤回来源和群成员变化会撤销旧事件的工具授权。

重启后首次同步 VCP 撤回版本时，仅将尚未投递、尚未冻结记忆输入的新用户事件接入干净话题。同一群消息的伙伴事件使用同一替代话题；旧事件的原生绑定保留，用于取消和回执核对，已投递事件不会被改投。

成功交互与待写记忆在同一次数据库事务中提交。新策略先在 VCP 写入一条确定性的互动日记并等待真实索引回执，再进行语义提炼；提炼结果按输入校验值冻结，重试不重新生成另一份结果。日记包含作者、时间、来源消息、公开答复和已核验的原生交付，并明确区分会话完成与正文对外部动作的声称。同一伙伴和受众的 VCP 操作按 FIFO 排序，不同域隔离；持久作业通过租约恢复，重启不会丢弃待写记录。

## 验证

- 原生适配与消息服务：`tests/unit/bot-native-service.test.ts`，覆盖新会话、干净输入、同伙伴工作区、原生文件交付和用户提问。
- 真正的 DSH 进程：`tests/unit/bot-dsh-router-session-native.test.ts`，覆盖真实文件工具、原生子代理、跨会话、进程重启、重放去重和取消。
- 真实模型验收：`node scripts/verify-bot-real.mjs --real`。已使用安装的 DSH 0.2.2-rc.1 和 deepseek-flash 跑通文件计算与原生交付、复杂子会话任务、主动/被动 VCP 召回、动图、群聊和伙伴私聊。报告位于 `artifacts/superagent-bot-development/real-acceptance/result.json`。
- 协议验收：`node scripts/verify-bot-real.mjs --protocol`。报告位于同目录的 `protocol-acceptance/result.json`。
- Electron 开发布局验收：`tests/e2e/companion-native-execution-ui.test.ts`，覆盖过程折叠、附件和表情、侧栏、群聊、私聊旁观与窄窗。

人工体验使用项目根目录 `02-Start-Development.bat`。

首次重构验收基线为伙伴与 DSH 相关测试 173 个文件、1133 项通过；条件依赖测试 17 项跳过。话题改造的专项验收另见下文，不将历史基线当作本次重跑数量。

## 话题改造的真实验收

`tests/e2e/companion-topic-real.test.ts` 使用真实 Electron IPC、DSH 0.2.2-rc.1、已配置真实模型和隔离用户目录。实际模拟上传需求与 CSV、回答项目确认问题、执行中上传补充需求并引导、独立问题排队、大肥鱼通知 Claude/GPT 协作、原生附件交付、返回原项目追问新增功能。首轮项目 10 项测试通过，追问后的新统计函数另外使用不同数据独立验证。

验收重新启动应用后继续同一真实项目，成功执行原生压缩；压缩后主脑正确保留项目、协作者、补充需求标记和新增函数。随后手动新建独立话题，再接回排队话题并正确回答其约定口令。原生回执验证项目共用一个主脑 Session 和两个伙伴 Worker Session，没有 Router 模型 Session；59 处实际输入文件交接均核对绝对路径与 SHA256，补充附件确实进入主脑、Claude 和 GPT。

报告、截图及实际原生 ZIP 保存于 `artifacts/companion-topic-real/`，报告标明重启后的接续验证。`tests/helpers/companion-topic-evidence.cjs` 在 Electron Node ABI 下只读复核原生回执、附件哈希、Session 身份和 ZIP 内容。`tests/e2e/windows-taskbar-icon.test.ts` 读取真实 Windows 窗口 Property Store，确认主窗与子窗使用 WorldlineBox App ID、名称及 ICO relaunch 图标。

## 话题收藏与有序回复的真实验收

`tests/e2e/companion-topic-organizer-real.test.ts` 使用相同隔离环境的真实模型，验证原生先输出正文、再发表情、写文件交付并发送最后正文；聊天只显示最后正文、表情组及附件，隐藏中途文字、媒体台词和完成统计，核对实际文件 SHA256；也测试纯表情输入、斗图、27 个新增话题、最近 6 条/全部 12 条分页、多关键词模糊搜索、收藏夹、置顶、重启后重命名及同 Session 追问。独立读取 DSH 原生日志中的 `session/title`，并验证追问能取回原交付标记。报告和截图保存在 `artifacts/companion-topic-organizer-real/`。DSH v4 日志使用多个连续 Zstandard 帧，验收解码所有帧，避免只读到会话头就误判原生事件不存在。

## 原生上下文统计

`topic.context` 验证当前用户、聊天成员、话题 ACL 与 epoch 后，解析该伙伴独立的 native lane；桥接器再次核验 lane 与 Session 哈希。只调用公开的 `sessionController.projections`，冷会话也只读，不激活 Agent、争用写锁或发送模型请求。取 DSH 自己的 `contextPressure`、`contextBreakdown`、`tokenUsage`，过滤为公开数字字段；不暴露提示词、工具参数或凭据。

当前占用严格使用 `(projectedTokens ?? pressureTokens) / contextWindow`，与 DSH UI 一致。构成是估算，不能相加代替占用；累计用量的四个桶独立展示，也不能充当当前窗口占用。未知容量不显示虚构的 0%。原生投影变化以 100ms 合并推送，终态前补发一致快照；只读查询在详情打开时每秒、关闭时每三秒补齐恢复与冷会话。指标帧不形成执行步骤，也不视为任务已经投递。

缓存键包含聊天与 native lane，同话题不同伙伴独立存储；相同 Session 的 `asOfSeq` 单调，旧推送不能覆盖新值。快照仅包含当前所选话题的伙伴统计。渲染器以聊天、话题、伙伴作为组件身份，取消旧请求的界面写入；切换时不沿用前一会话，离线明确标注保存值。清空盒子聊天时删除相应缓存，保留 DSH 原生工作区。

`tests/e2e/companion-context-real.test.ts` 使用真实模型验证新话题无旧读数、独立 Session 的快速切换、原会话追问与材料输入、跨话题查看期间的原生压缩及另一会话统计隔离；也打开同一 Session 的 DSH 原生界面核对占用和构成，并检查窄窗排版。报告与界面截图保存在 `artifacts/companion-context-real/`。单元测试另覆盖迟到请求、群聊伙伴切换、离线值、公开字段过滤及清理。

同文件的群聊验收只读接回已完成的真实三伙伴协作项目，依次选择大肥鱼、Claude、GPT，核对三个独立 Session 与原生读数，且 Session 身份与原项目主脑／Workers 回执一致。没有为读取统计发送新任务或构造模拟用量。

## 11 月 10 日：中断、阅读器与内置浏览器应用连接

用户「停止」与撤回资料的永久取消分开处理。用户停止原子写入发布租约围栏、原生 suspend 意图和 interruption 状态；收到原生停止回执后原子清除意图并启用「继续执行」。应用重启不会自动领取被用户中断的事件。继续复用原 event、reply、topic lane、VCP prepared turn 和 DSH Session，先等待旧处理器释放资源，再幂等入队。未完成时不关闭或提交 VCP response；最终完成后提交一次。原生推送按 streamGeneration 与 sequence 标识，恢复后的新阶段不会与旧阶段重名。资料／ACL／epoch 变化及同话题已推进的后续事件不能被旧恢复按钮覆盖。

真实冷恢复发现停止检查用的 cancel-only 配置被写成待选模型。桥接器现在不在停止操作中选择临时模型，并在冷会话 setup 中、恢复 inbox 驱动之前选择正常模型。`companion-interrupt-real.test.ts` 实际中断前台文件任务、切换话题、重启应用、空输入框一键继续，核对同消息和 Session，观察恢复后的新工具阶段与流式正文，最终交付实际文件。报告与截图：`artifacts/companion-interrupt-real/`。原生暂停／取消协议另有四项真实 DSH Host 回归。

文本阅读器采用独立文档滚动区、目录、紧凑页边距、阅读／原文切换与字号。每种模式保存自己的滚动位置，关闭滚动锚定，避免切换或字号变化造成跳动。最多读取当前 64 KiB 分段；单段文件不显示无意义的分页按钮。`companion-text-reader.test.ts` 用实际导入文件与生产分页 IPC 验证滚轮、PageDown／Ctrl+End、目录、字体、模式位置、五段长文本、深色与窄窗，确认不滚动背后的聊天。

浏览器右键「呼唤伙伴」由主进程生成有界、带 document/version 身份的网页引用，经 IPC 提供给伙伴选择器。用户用 @ 名称搜索，确认选择后只添加草稿中的应用卡。发送时再次验证实际标签、文档、URL 与期限；引用经 event payload 进入本次原生 DSH 请求，执行中的引导同样携带引用。任务的 browser 工具接到同一 BrowserService 的 WebContentsView，沿用真实 Session；Cookie、Token 与 storage 不经聊天、提示词或桥接器传送。截图落到受管工作区供原生 read_image 读取，页面文字和标题始终是资料，不能覆盖用户任务与权限。清理伙伴记录会删除相应的引用元数据。

网页长图最初使用单次 CDP 截图；实际长页触发尺寸限制后，已改为下面的分块预览流程。

`browser-companion-connected-real.test.ts` 在已登录的本地工作台中触发真实 Chromium 右键事件及生产菜单，保存并核对 2394×18180 长图底部像素与滚动位置，通过 @ 大肥鱼附加网页，使用真实模型和 DSH 修改筛选框，再于同 Session 追问修改。核对 WebContents ID、标签 ID 和标签总数均保持，账号来自原 HTTP-only 登录会话。报告及截图：`artifacts/browser-companion-connected-real/`。

## 11 月 10 日：长图进度、预览与当前动作

右键和更多菜单共用一个主进程长图作业。准备、捕获、编码、预览、保存、失败与取消状态经浏览器快照返回；原生菜单的异步 rejection 也会被捕获并显示。只有用户在预览中确认后才打开保存框，通过同目录临时文件异步复制与重命名完成保存。失败保留预览以便重试；目标路径、ID、预览索引均在主进程校验，不能读取任意文件。

使用同一 WebContents 的小视口捕获，暂时关闭后台节流，保持隐藏且唤醒页面；等待滚动后的两次重绘，避免复制上一帧。捕获结束或取消后恢复滚动、样式和节流。Windows 直接把有界 BGRA 像素交给 Worker，颜色转换与压缩都在后台进行。Worker 保留约 400 万像素的横向带，逐行写入 zlib/PNG，不分配完整长图；预览为独立 JPEG 横带，按可见区域载入。移除旧的 6400 万像素、65500 高度、90 MiB 和 30 秒整项限制，仅为无响应的单项操作保留超时。PNG 格式及物理资源仍有边界。

`browser-page-image.test.ts` 使用 56 张真实懒加载图片，验证进度、确认前无保存框与目标文件、整页底部、每一张图片的独立颜色位置标记、预览首尾、取消、原生错误反馈和主进程心跳。加入逐图校验是为了覆盖仅检查尺寸与底部无法发现的分块重复。报告：`artifacts/browser-page-image-preview/result.json`。[Electron capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts) 与 [后台节流](https://www.electronjs.org/docs/latest/api/web-contents#contentssetbackgroundthrottlingallowed) 为原生捕获依据。

伙伴过程默认保持折叠。当前行与展开后的工具行共用原生参数中的 description/title、文件名、查询或浏览器动作短述；思考行显示简短文本预览。使用原生 sequence 与 streamGeneration 选取最新事件，避免合并后的流片段被较旧的数组位置遮蔽。完成后继续只保留正文、表情与附件。网页卡片的打开与移除按钮统一采用 SVG、相同点击区与居中方式。

## 11 月 10 日：全局工具列表保留背景页面

浏览器的 WebContentsView 始终位于主窗口 HTML 之上。旧版 DOM portal 触发遮挡检测后隐藏了整个原生页面，之后临时使用的系统原生菜单又与其他模块样式不同。现在浏览器通过主窗口专用的 `menu.popup` 打开透明 WebContentsView，加载与其他模块共用的 `CaptureToolsMenuList`、主题与样式。原生页面保留可见性、视口、输入和滚动，并继续绘制。其他模块及设置对话框继续使用 DOM portal；选中工具后先关闭菜单再分派原有 open 请求。

主进程限定弹出请求来自主窗口主框架，菜单自身仅可读取语言、报告就绪和选择固定枚举任务；菜单视图继承主窗口的尺寸与缩放，渲染就绪后才显示。关闭、主窗口导航、退出与渲染进程结束均结清请求并销毁视图。启动入口使用独立的动态导入回调，确保生产构建正确加载每个工具界面的 CSS。`browser-tools-menu-live.test.ts` 核对同一浏览器视图仍可见、计时器推进、页面像素更新、输入与滚动不变，并用真实桌面窗口捕获验证透明菜单与网页的合成画面；还逐项比对启动器、网络与伙伴菜单的计算样式和图标。`application-rail-layout.test.ts` 覆盖三种窗口大小及四种缩放、设置对话框菜单、键盘关闭与实际工具分派。报告：`artifacts/unified-capture-ui/result.json`。

截图与录屏不再调用主窗口 hide/show，也不会恢复用户手动隐藏的窗口；旧 `hideApp` 设置在读取或保存时移除，保留其余偏好和快捷键。截图工具自身采集前临时隐藏，整屏录制必要时隐藏控制条，均不影响主窗口。`capture-main-window-visible.test.ts` 实际截图并录制 WorldlineBox 自身，检查暂停、继续和保存期间主窗口可见，解码生成的 MP4 验证有效画面，并检查手动隐藏后打开和关闭工具不会恢复主窗口。报告：`artifacts/unified-capture-ui/capture-window-result.json`。
