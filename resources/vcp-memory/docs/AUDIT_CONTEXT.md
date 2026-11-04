# VCPChat 与 ToolBox 上下文迁移审计

核对日期：2026-11-02。VCPChat 源版本 `2af26aaddcf82163c9f3e88b55d53518cb9db059`。源仓库未修改，未复制 AppData、聊天记录、附件或私有配置。

## 真实调用链与边界

VCPChat 的 `modules/chat/singleChatRequestOrchestrator.js` 是单聊请求构造边界。它从完整持久化历史中通过 `effectiveContextHistory` 选择最后一个宿主 checkpoint 之后的有效历史，构建多模态正文与附件文本，处理 AgentName、Tavern system/user/context 规则、工作区占位符，最后附加每条原始历史的机器时间信息。HTML 净化、隐藏工具回执与思维链清理在 IPC 出站层完成。它不是记忆向量检索引擎。

`modules/ipc/chatHandlers.js:77-132` 和 `:1316-1327` 把 `__vcpchatTimestampMeta` 转为请求体 **`vcpchatExtensions`**：包含 `schemaVersion:1`、`messageMetadataMode:'hash_only'`、`messageTimestampBindings`、`requestContext`。绑定的是**最终发送文本**的 SHA256、发送下标、messageId、role、客户端时间；内部元数据从模型消息中剥除。`vcp_context_bindings` 不是这个版本的真实字段。

ToolBox `modules/chatCompletionHandler.js:746` 截获 `vcpchatExtensions`，不转发给上游模型，通过 requestPreprocessorConfig 交给预处理器。`OneRing` 在 ToolBox 的 `Plugin/OneRing` 内，不属于 VCPChat 源码。它维护按 Agent 隔离的 SQLite 时间线，原始客户端时间/服务端推断两套策略、同端快照编辑与 retry 更新、跨端补齐、来源标记、Only 模式以及 Memo 摘要。必须保留 OneRing 附在消息数组上的不可枚举 `__oneRingMeta`，并在回复完成时走 ToolBox 的 interaction completion hook 写回 AI 结果，单次预处理不构成完整闭环。

ToolBox 的 `contextManager.js` 有旧位置裁剪和 `pruneMessagesSmart` 两个入口，后者经 `jevContextPruner.js` 对可删消息评分，失败回退旧规则。system、`[系统提示:]` 字符串 user、最后两条消息是不可删边界。它按文本字符数估算，不是模型精确 tokenizer；预算小于必须保留内容时允许超限。

`foldProtocol.js` 是 Toolbox/TVS 文档的分段阈值折叠协议 `[===vcp_fold:...===]`。它不同于 `ContextFoldingV2` 对会话历史的语义折叠，也不同于 VCPChat 的模型压缩 checkpoint。完整迁移应分别保留三个机制。规划文档中的设想须与实际消费字段和现有代码区分。

## 保留的 VCPChat 原算法

`upstream/manifest-chat.json` 记录原始源文件/测试/许可证的 SHA256 和源 revision，包括附件 `fileManager.js` 与 `pdfAttachmentService.js`。所有快照文件按字节复制，`modules/chat/package.json` 与 `modules/renderer/package.json` 是运行边界适配，令 Node 22.19+ 能在 CommonJS CLI 中加载原始 ES module，不修改算法正文。

| 能力 | 原始模块 | 独立接口与验证 |
|---|---|---|
| 最后一个 checkpoint 边界、完整历史保留 | contextCompactionState | `effectiveContextHistory`、`inspectHistory`；原始测试 |
| DailyNote create/update 按源顺序回放；代码/回执域不可误执行 | contextCompactionState + toolRequestScanner/toolResultRegions/markdownCodeDomainScanner | `prepareCompactionState`；原始日记回放、字面量隔离、替换字符测试 |
| 日记独立保管，压缩模型不改写日记 | contextCompactionState + contextCompactionPrompts | 原文与最新版本保存在 checkpoint 元数据、主模型正文 |
| 真实 role 历史发送、旧 system 降权为历史数据、禁止续写 | contextCompactionPrompts | `buildCompactionMessages`；原始请求体测试 |
| 标识符保真审计、未决问题连续性审计、审计缺失回灌 | contextCompactionFidelity/Continuity | 原样导出；这些是审计信号，原版不保证语义绝对无损 |
| HTTP 压缩、超时、取消、busy、过期结果拒收 | contextCompactionService | 原样导出 + `createContextService`；原始错误/并发测试 |
| 持久写权限串行化、终态流记录并发合并 | chatHistoryMutationAuthority/Persistence | 原样导出；文件适配器在事务外增加进程间锁 |
| 侧聊 descriptor、冻结父快照、祖先链传递 | sideChatSessionService | `ContextStore.fork/branchContext`；孙分支不丢根测试 |
| 分支森林、环/孤儿容错、面包屑/子树统计 | side-chat/branch-tree | 原样导出；`context.branches` 投影可序列化 JSON |
| 知识结晶笔记与现场深链接 | side-chat/note-exporter | `ContextStore.crystallize`；CLI 默认保留完整答案，原版默认1200字仍可参数指定 |
| 群上下文最近 N 楼窗口 | Groupmodules/groupContextWindow | 原样导出；原始边界与不修改历史测试 |
| Tavern 提示注入、AgentName、时间绑定 | singleChatRequestOrchestrator + tavernRulesEngine | `prepareMessages`；发送哈希、多模态与注入顺序测试 |
| HTML 到 Markdown、隐藏工具/思维链清理 | contextSanitizer | 原样导出 `sanitizer`，HTML 模式依赖 jsdom/turndown |

## 独立宿主接口

`lib/context.cjs` 同步导出所有上表原算法 API，并增加 `dispatch(operation,payload,{home})`。`home/sessions/<agent|group>/<encoded item>/<encoded topic>` 是独立文件数据，不接触 VCPChat 现有 AppData。历史写入使用同目录临时文件原子 rename，保留最近一次 `.bak`；history mutation 增加进程间独占锁。异常退出留下 `.history.lock` 时，需先确认其中 PID 对应进程已经退出，再显式恢复；不冒险自动删除其他进程的锁。原始完整历史不会因为压缩被删除。

操作名：

| 操作 | payload |
|---|---|
| `context.inspect/effective` | `{history}` |
| `context.prepare` | `{history, options:{agentId,topicId,agentName,agentConfig,settings,tavernRules,...}}`，返回 messages 与 vcpchatExtensions |
| `context.compaction-input` | `{history,settings}`，仅构造真实压缩输入，不联网 |
| `context.compact` | `{history,settings,options}`；options.response 仅用于明确离线测试，其余正常请求模型 |
| `context.auto-compact` | `{history,settings,agentConfig:{contextTokenLimit,systemPrompt?},pendingText?,options?}`；显式action才按原85%阈值评估，低于阈值/关闭/只有checkpoint不请求模型 |
| `context.group-window` | `{history,config:{enableContextMessageWindow,contextMessageWindowSize}}` |
| `context.branches` | `{metadata:[SideChatDescriptor...]}` |
| `session.list/get/inspect` | `{itemId,itemType,topicId}`，支持别名 agent/session |
| `session.put` | scope + `{history}`，显式替换，写备份 |
| `session.append` | scope + `{messages:[...]}` 或 `{message:{...}}` |
| `session.prepare` | scope + `{options}`，读取历史并构造上下文 |
| `session.fork` | scope + `{childTopicId?,forkMessageId?,title?,forkLabel?}` |
| `session.branch` | scope，读取 metadata、冻结祖先 snapshot、自有 history、合并 messages |
| `session.crystallize` | scope + `{options:{maxAnswerChars?}}` |
| `session.compact` | scope + `{settings}`，设置 enableContextCompaction:true、contextCompactionModel、vcpServerUrl、vcpApiKey；response 仅作显式离线验证 |
| `session.auto-compact` | scope + `{settings,agentConfig,pendingText?}`；复用原阈值和持久化压缩事务，返回compacted与decision |

附件JSON支持 `attachments:[{path:"C:/path/file.txt"}]`，也支持原 `sourcePath/internalPath/file://` 字段。默认只读调用中明确声明的文件，不扫描目录。文本编码/BOM/GB18030、DOCX、PDF文本与扫描页判定调用原fileManager/PDF service；图片按原IPC的JPEG/800px/quality70及GIF500ms采帧，音视频保留原base64与类型。`isLiveReference:true`每次prepare重读；已有extractedText/imageFrames且没有显式path或live标记的快照保持可用。显式文件缺失/读取失败会报错，原版不支持的格式保留路径并给attachmentDiagnostics，PDF转图失败的原残余文本回退也在诊断中声明。

`options.attachmentBaseDirectory`选择相对path基目录，默认调用进程cwd；`attachmentMaxBytes`可显式限制单文件字节；`readAttachmentFiles:false`关闭自动读文件，只使用已存内容与显式注入能力。Node API仍可提供electronAPI能力对象覆写同名读方法和工作区展开，无Electron依赖。`session.prepare`自动读取本分支冻结parent-snapshot并保留其附件上下文。prepare不会自动花费模型额度进行压缩；只有compact/auto-compact动作才可请求模型。

桌面 UI、Tab、分支轨道可视化、Electron IPC 生命周期、Flowlock heartbeat 控制不属于 standalone CLI 宿主，原函数保留能力注入入口；禁止把没有接入的 UI 生命周期宣称为已迁移。

TopicMemo 的 ListTopics/GetTopicContent 实质是读取 VCPChat Agents 配置与 UserData history 后做格式化；独立 `session.list/get` 提供对应内容能力，但不自动导入真实 AppData。若需要旧数据迁移，必须用户显式选择源目录与范围，禁止启动时扫描复制用户聊天或密钥。

### VCP-CDS 与 DeepMemo 2.0 的独立边界

当前 DeepMemo manifest 的默认入口是 **`DeepMemoService.js`**（2.0.0，hybridservice/direct），不是同目录旧 `DeepMemo.js`。README 描述的真实默认链是 `vcpchatExtensions.requestContext → ToolBox execute_tool._vcpContext → DeepMemoService.processToolCall(toolArgs,trustedContext) → ChatDataServiceClient.searchMemories → VCP-CDS /v1/search/memories`。Rust VCP-CDS 由 Electron 主进程持有，负责持久中央索引。默认路径不扫描 history.json、不初始化临时 FlexSearch/Jieba、不启动旧 deepmemo_rust.exe。旧 EXE 与旧 JS 仅用于配置回滚，不能用它们代替当前真实默认实现。

该链还包含：可信传输上下文优先于模型伪造的 agentId/_vcpContext；maid 名称解析歧义显式失败；排除当前 Topic；关键词 DSL 与 QueryPreset；窗口邻接、候选/最终数量、Unicode 字符预算；rerank true/false/省略三态；并发分批精排，每候选仅评分一次，跨批次全局排序，任一批次失败完整回退原排名。`lib/context.cjs` 负责新会话存储和分支适配，中央索引与这两个工具由独立的 **`lib/chat-memory.cjs`** 接入。该适配器仅将本home拥有的sessions映射到独立chat/AppData，再启动原Rust中央服务，不扫描用户原项目。CLI前向验证已实际使用DeepMemo查到过去聊天中的PostgreSQL决定，并通过原TopicMemo列表及读取内容，证据见 `docs/skill-evaluation-evidence.json`。不得用简单关键词筛选代替该链而宣称等价；可信当前topic传播、完整DSL/rerank等场景需按各集成测试证据分别核对。

## 验证证据

2026-11-02 已运行初版适配器8个端到端/并发测试和原始68个测试：76通过、0失败；附件与auto-compact补充后，`node --test tests/context.test.cjs` 最新 **16通过、0失败**。新增实际文件文本/音频/图像、live引用、持久session附件、分支祖先prepare、85%阈值、真实DOCX文本提取与原Poppler PDF转页回退，以及压缩输入包含实际附件文本且不修改原历史、自动阈值计入该附件内容。原测试命令：`node --test tests/context.test.cjs upstream/chat/tests/*.test.mjs upstream/chat/tests/*.test.js`。PDF fixture在原pdf-parse判读失败后由原Poppler成功转成1页JPEG，测试未把该回退冒称文本提取成功。

这些测试证明本地确定性逻辑与宿主适配行为，不证明任意 LLM 的压缩语义百分百无损。真实压缩模型、OneRing 跨端后端、向量/检索链路的外部验证由集成测试单独记录。
