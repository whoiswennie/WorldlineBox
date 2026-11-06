# 伙伴任务记录与执行环境恢复补充

本次跟进不运行打包脚本。这里记录源代码与隔离开发环境验证，不覆盖已有安装包的行为。

## 对话中的任务记录

私聊和群聊的任务动态是持久消息，伙伴发送自然回复、新消息到达或重新载入后仍保留。列表中没有当前任务快照时使用消息携带的标题、负责人和状态；不会为了显示历史卡片重新把已结束任务塞进 Router 上下文。卡片显示负责人头像、姓名、时间、两行标题、状态和详情入口，避免重复展示执行器长报告。

实际 Electron 测试使用隔离 BotStore 和真实主进程 IPC，覆盖私聊旧任务超出当前任务快照、群内两位负责人、新消息、重载、键盘打开详情、亮色、暗色窄窗和主题背景。测试源为 `tests/e2e/companion-bot-tasks.test.ts`，截图与结构化证据保存在被忽略的 `artifacts/task-activity-history/`。

## 执行环境与恢复

- 首次执行按绑定选择默认或伙伴私有实例，再按需启动。已安装运行本但没有普通实例时自动创建默认实例；同一实例的并发启动合并。
- Host 配置缺失、启动失败、人工停止和启动器关闭采用结构化错误。Host 尚未获得时的失败不等于原生任务已经投递，不凭空建立未知执行或取消义务。
- 人工停止实例立即暂停已绑定任务、冻结用时并停止本地等待，后台预热、能力查询和任务重连不会绕过停止意图。用户明确继续原任务才可启动原实例；较新的停止操作优先于正在等待的继续请求。
- 意外断线沿用任务 ID、原生 event ID、Session 和工作目录。启动失败最多自动尝试三次，其他连接恢复最多五次，之后保留进展并暂停，避免无限重试占住执行位置。明确继续会重置恢复额度。
- 取消或暂停的失败 Promise 不永久锁住通道。新的恢复先核实旧事件；只有身份匹配的原生终态、持久暂停或不存在证明可以解除控制门禁。单纯 `accepted`、其他事件的回执和非终态回执不能放行下一次执行。
- 暂停状态、已完成输入和未确认操作均保留到软件重启之后。任务动态只通知一次当前暂停，不因持续普通聊天反复唤醒旧任务。

相关行为回归位于 `bot-task-recovery`、`bot-task-pause`、`bot-task-cancellation-regression`、`bot-dsh-adapter`、`dsh-instance` 和 `dsh-bot-host-selection` 单元测试。实例测试启动本地受控子进程，覆盖启动合并、停止发生在准备阶段、继续等待关闭和较新停止覆盖继续。

## 真实原生验证

实际 DSH **0.2.2-rc.1** 使用独立临时 Home 和本地确定性模型协议服务，运行以下五项测试；不使用用户现有会话或账号，不产生付费模型调用：

```powershell
$env:WORLDLINEBOX_BOT_DSH_PROGRAM = (Resolve-Path '.tools/dsh-0.2.2-rc.1-acceptance/staging-retry/program').Path
node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/unit/bot-dsh-repeat-recovery-native.test.ts tests/unit/bot-dsh-pause-native.test.ts tests/unit/bot-dsh-cancel-native.test.ts --maxWorkers=2
```

2026-11-06 最后一次运行三个文件、五项通过，44.18 秒。证据分别为 `artifacts/superagent-bot-development/native-repeat-recovery.json`、`native-pause-recovery.json`、`native-cancel-recovery.json`：五次 Host 冷崩溃后仍只有一份原始输入，重复原事件没有新增模型请求；冷暂停不调用模型，继续沿同一 Session；取消回执和不存在证明在冷启动后可重放核实。

这些测试证明上述恢复路径，不代表任意第三方插件的外部操作都具备幂等性。未知文件操作或外部效果仍先核实，不能因断线自动重做。

## Worker 并发与异步准备

每位伙伴默认同时执行 5 项 Worker 任务，在「角色卡 → 任务执行」可配置 1 至 32 项。调度前先为连接、附件准备占位，等待问题回答时释放执行容量；调低配置不会强制中断已运行任务。全局最多 64 项活动工作，按负责人轮转选择待办，避免单个伙伴的长队占满候选窗口。

任务业务状态与实际异步准备分别跟踪。暂停、停止立即落库并冻结计时；同任务再次继续前等待旧准备退出。附件按块复制，可取消并只清理自身未完成的排他副本，原文件保留。应用关闭时有界等待 Router 和 Worker 的真实异步准备，防止取消包装 Promise 已结束而旧操作仍访问已关闭数据库或与恢复后的附件复制竞争。

实际 DSH 0.2.2-rc.1 的额外并发验收在同一冷启动 Host 中同时持有 17 项原生 Worker 请求，完成后回收到 16 条空闲通道目标；同一通道重复打开只建立一个原生 Session。两项通过，18.77 秒，使用本地确定性模型，不产生付费调用。来源为 `tests/unit/bot-dsh-concurrency-native.test.ts`，证据为 `artifacts/superagent-bot-development/native-worker-concurrency.json`。

## 角色卡与动态能力档案

私聊头部保留「拨号」「任务」「角色卡」三个入口。角色卡统一人格模板、基本资料、形象与声音、任务执行和能力档案；任务中心独立。编辑区按页保留草稿，明确保存状态。会面偏好按伙伴保存在本设备，并能读取在会面中刚修改的设置。

能力档案只读展示真实生效的能力与安装来源，不代替 DSH 配置插件。皮肤、桌宠等来源不会因为安装而冒充可调用工具。浏览档案不创建或启动实例；用户点击「前往专属 DSH」时才准备并打开对应私有环境，在 DSH 原生界面安装、配置和管理插件。

默认共享实例与伙伴私有实例均监听其原生配置、插件清单和技能文件变化，以逐实例 revision 使摘要和详细列表失效。旧数量不会在新 revision 下继续显示为当前状态；其他实例的变化不触发本角色的无关刷新。真实文件监听回归覆盖 Windows 父目录元数据通知、会话日志过滤、原子配置替换以及停止后的监听清理。原生插件能否热更新仍由 DSH 自身决定，不将磁盘上的配置误称为当前会话已装载的工具。

## Claude 与内置人格

内置伙伴增至 15 位，新增 Claude。依据用户提供的橙发书卷少女设定，通过内置 ImageGen 分别绘制三视图、头像和全身立绘；原始参考图也随源代码保留。文件位于 `public/companion-bot/builtins/claude/`，`source-manifest.json` 记录各次完整提示词、参考关系、尺寸与 SHA-256。这里没有新增或宣称 Claude Live2D 模型。

15 位默认人格使用各自的偏好、短处、说话节奏和口语示例；Claude 与大肥鱼双方都有亲近关系设定，但不把关系设定当作已发生的聊天记忆。升级只在保存文本逐字匹配旧内置原文时继承新默认；用户修改的提示词、模板名称、已激活自定义模板和删除标记各自保留。大肥鱼四份用户提供的原文仍由完整内容指纹回归保护。

## 界面与最终验证

全局模型页区分正在使用的连接和当前草稿，连接测试不保存，保存后更新当前连接；操作栏放在正常文档流内，避免固定按钮覆盖地址、密钥和模型字段。新配置默认使用 OpenAI Chat Completions 与官方 DeepSeek 地址，已有配置保留。

2026-11-07 最终相关回归：207 个文件、1471 项通过；15 个文件中的 18 项需要特定原生环境，常规回归中跳过。此前上述实际 rc.1 原生恢复和并发测试单独通过。全项目 `npm run typecheck` 通过，变更文件 ESLint 零错误（`App.tsx` 两处既有 Hook 依赖警告），`git diff --check` 通过。

真实 Electron 主进程 IPC、SQLite 与渲染验收分别覆盖私聊/群聊持久任务记录、角色卡草稿与并发保存、只读能力档案、全局模型页和 Claude。Claude 验收读取真实种子数据，加载头像、三视图、立绘和原设定，在亮色 1440px、暗色 1440px 和暗色 850px 下无横向溢出；未发送消息、未启动 DSH。截图与证据位于 `artifacts/companion-claude/`，测试源为 `tests/e2e/companion-claude.test.ts`。

最终日志为 `.tools/companion-followup-final-tests.log`、`.tools/companion-followup-final-typecheck.log` 和 `.tools/companion-followup-final-eslint.log`。`.tools/` 与 `artifacts/` 是本机验证输出，不随 Git 分发；生产源代码、测试、角色美术和素材清单随仓库分发。本轮未运行打包脚本。
