# 伙伴改为原生 DSH 会话

开发分支：`codex/dsh-native-companion-refactor`。本次开发不包含打包、合并或远程推送。

## 执行边界

WorldlineBox 保存联系人、人设、消息、媒体授权和 VCP 记忆，只进行确定性的消息路由、工具回调与界面投影。应用不再运行主脑模型循环，不再维护任务中心、委派计划或第二层 Worker 调度器。

每条消息以 `turn-${event.id}` 绑定一个全新的原生 DSH Session。同一事件传输中断时重新连接原会话，不通过新事件重做操作。同一伙伴的会话共用稳定的伙伴工作区，不同伙伴拥有不同工作区；界面聊天历史不会整段重放到新会话。新会话得到本次消息、角色提示词、当前受众、已核验附件和 VCP 被动召回证据；需要前文时主动查询聊天或记忆。

插件为原生 Agent 增加表情、记忆、伙伴联系与用户提问回调。原生 DSH 保留执行、工具、上下文和子代理机制。`sessions_list/read/send/spawn/wait` 面向通用任务，只查询同伙伴工作区；原生子代理继承该伙伴身份和回调能力，不复制父会话完整上下文。

文件交付使用 DSH 原生 `present` 工具及 `deliverables/presented` 事件。WorldlineBox 把这些原生交付投影到当前回复的附件，不再提供 `chat_send_file`、`worker_chat_send_file` 或按旧任务编号发布产物的工具。用户上传附件和表情功能保留。

## 消息表现

执行期间显示原生阶段、工具与进展。完成后默认收起过程，直接显示原生终态正文；用户可以展开详情。原生询问通过气泡中的回答表单继续同一会话。界面只保留最右侧的信息栏展开按钮。

移除了启动器的插件市场、技能市场、伙伴能力及其冗余管理实现。插件、技能与账号配置在 DSH 原生界面管理。运行版本、实例、整合包、操作记录及启动功能保留。

## 数据兼容

已有用户聊天、角色、记忆与文件保留。旧任务表、版本迁移及历史来源关系仅用于升级兼容；旧任务不会由新引擎重新启动。VCP 写入沿用稳定的来源和操作编号，回调响应丢失时先读取持久回执，避免重复写入。撤回来源和群成员变化会撤销旧事件的工具授权。

成功交互与待写记忆在同一次数据库事务中提交。新策略先在 VCP 写入一条确定性的互动日记并等待真实索引回执，再进行语义提炼；提炼结果按输入校验值冻结，重试不重新生成另一份结果。日记包含作者、时间、来源消息、公开答复和已核验的原生交付，并明确区分会话完成与正文对外部动作的声称。同一伙伴和受众的 VCP 操作按 FIFO 排序，不同域隔离；持久作业通过租约恢复，重启不会丢弃待写记录。

## 验证

- 原生适配与消息服务：`tests/unit/bot-native-service.test.ts`，覆盖新会话、干净输入、同伙伴工作区、原生文件交付和用户提问。
- 真正的 DSH 进程：`tests/unit/bot-dsh-router-session-native.test.ts`，覆盖真实文件工具、原生子代理、跨会话、进程重启、重放去重和取消。
- 真实模型验收：`node scripts/verify-bot-real.mjs --real`。已使用安装的 DSH 0.2.2-rc.1 和 deepseek-flash 跑通文件计算与原生交付、复杂子会话任务、主动/被动 VCP 召回、动图、群聊和伙伴私聊。报告位于 `artifacts/superagent-bot-development/real-acceptance/result.json`。
- 协议验收：`node scripts/verify-bot-real.mjs --protocol`。报告位于同目录的 `protocol-acceptance/result.json`。
- Electron 开发布局验收：`tests/e2e/companion-native-execution-ui.test.ts`，覆盖过程折叠、附件和表情、侧栏、群聊、私聊旁观与窄窗。

人工体验使用项目根目录 `02-Start-Development.bat`。

最终汇总：伙伴与 DSH 相关测试 173 个文件、1133 项通过；条件依赖测试 17 项跳过，真实 DSH/真实模型/真实 VCP 的专项验收另行实际执行并通过。`npm run typecheck`、开发启动前置检查及 `git diff --check` 通过；`npm run lint` 无错误，仅有未修改的 `App.tsx` 和 `AssetPreviewModal.tsx` 中 4 条既有 Hook 警告。
