# 所有伙伴共用一个 DSH 执行实例

2026-11-08。此设计取代此前按伙伴分配专属 DSH 的方案。

## 目标与边界

启动器中选定一个共享执行实例，账号登录、API、插件和技能均在该实例的原生 DSH 工作台配置一次。不同伙伴使用同一原生 Host，不再按角色创建、绑定、启动或保活一批实例。角色卡展示共享环境的实际能力，能力配置继续交给 DSH。未来角色能力差异由 DSH 插件扩展，此次不引入另一套按角色安装插件的系统。

Router 仍由世界线盒子运行，使用全局模型连接。不同伙伴保留各自人格、聊天、VCP 记忆、事件、任务归属及 Worker 并发设置（默认每位 5 个）。DSH 负责独立 Worker Session 和工具执行。共用 Host 不代表共用聊天上下文；任务工作目录、回执、取消和恢复仍以任务 ID 隔离。这是应用层归属与会话隔离，不是操作系统沙箱：共享 DSH 的插件和凭据属于同一个信任环境。

本地参考原型 `dsh-superagent-prototype/docs/003-execution.md` 以每个 Ticket 的 `worker-<id>` Session、独立目录组织工作，`006-deployment.md` 在一个 profile 内统一配置 Router/Worker 的 preset 和默认模型。原型自身声明是研究参考实现，不能由此推断任意第三方插件都具有并发安全性。

## 使用与迁移

1. 没有 DSH 时，用户先下载运行版本，再确认创建共享实例；已有实例可直接设为共享执行实例。一次完成后适用于所有现有、新建及群聊中的伙伴。
2. 已选定且停止的共享实例在任务执行时按需启动，并合并并发启动请求；用户主动停止后不偷偷重新启动，原任务暂停，用户可明确继续。
3. 已有默认执行实例优先保留。仅有旧角色实例的配置保留其原文件，通过统一选择规则提供一个共享实例；不复制或合并旧账号和插件。
4. 旧实例、浏览器登录分区、home、插件、技能和原始 Session 均保留。用户可把其中任意兼容实例设为共享执行实例，无须再给每位伙伴绑定。旧 `companionId` 标记仅作兼容历史元数据，不再作为实例独占权限。
5. 新任务在原生提交之前持久绑定当前共享实例。切换共享实例只影响后续新任务，不改变已接受任务的 Session、工作区或效果账。旧专属实例上的未完成任务继续指向原实例，绝不自动改投、搬迁 Session 或重新执行。不存在原实例时明确暂停，不能静默换用默认实例。
6. 升级选定实例保持同一实例身份和 home，使用快照和失败回滚。插件、技能、账号配置与浏览器分区随实例保留；不要求删除实例重新配置。

关闭某位伙伴仅停止该伙伴的 Router 事件和任务，不关闭共享 Host，其他伙伴及用户的 DSH 会话继续运行。启动器主动停止共享实例会暂停该实例上受影响的全部伙伴任务；恢复遵循各任务已有的中断与效果核实协议，不把连接丢失解释成任务已完成。

## 验收

定向测试覆盖单次配置准入、群聊、新角色、伙伴委派、默认实例选择、历史私有实例复用、共享能力档案、启停隔离、同 home 升级与回滚。Worker 选路测试覆盖共享新任务、固定旧实例、丢失原环境禁止 fallback、角色身份及原始任务归属校验。

实际安装 DSH 的原生测试使用隔离临时 profile 与本地协议模型，验证多伙伴 Worker 并发、独立 Session/工作目录、单项暂停和取消，以及 Host 中断后冷恢复和回执重取。此类测试证明协议与生命周期，不代表真实模型语义质量；真实模型验收另记录范围与证据。

已执行的原生验收：

- `bot-dsh-shared-instance-native.test.ts`：官方本地 `0.2.1-rc.5`，两伙伴四 Worker 并发，暂停/取消一项不影响其他项；Host 中断后恢复原 Session/event，没有重复原输入或写入；完成回执重取不调用模型。另在同一个新 profile 经原生插件管理安装一次 `text-statistics`，两伙伴发现相同能力摘要并分别调用真实插件工具，重启后配置保留。两例使用本地协议模型、无付费请求，证据在 `artifacts/superagent-bot-development/shared-instance-native/` 和 `shared-plugin-native/`。
- `dsh-companion-upgrade-native.test.ts`：单个共享实例实际从 `0.2.1-rc.5` 原地升至 `0.2.2-rc.1`，同 instance/home/browser partition/Session 和历史前缀保持，`demo_palette` 插件在升级后仍可续跑。重复回执不重新推理。使用本地模型传输，证据在 `artifacts/superagent-bot-development/native-shared-upgrade/`。
- `node scripts/verify-bot-multi-companion.mjs --real`：官方 `api.deepseek.com` 的 `deepseek-flash` 与实际 `0.2.1-rc.5`。群聊中两伙伴分析三份相关输入文件，排除无关附件和私聊，真实并发执行；用户补充排除订单后沿同任务同 Session 更新，汇总 Worker 仅读取两份最新已发布成果，最终 `127 + 185 = 312`。生产共享选路方法记录全程仅一个实例。记忆在此隔离夹具明确关闭，不代表 VCP 验收。证据 `artifacts/superagent-bot-development/multi-companion-real/worldlinebox-bot-real-multi-companion-7m1OKi/`。

真实模型的汇总交接中出现过 Router 提供错误预期 `135` 的情况，Worker 按实际原件核实采用 `127`，并在最终报告说明差异。因此本案例证明共享选路、真实并发、文件和修正交付链路能够跑通，不应解释为模型永远不会产生业务数值或上下文错误。

最终回归命令 `node scripts/run-vitest-with-electron.mjs run tests/unit/bot- tests/unit/dsh- --maxWorkers=2`：210 个文件通过，17 个按环境条件跳过；1,590 项测试通过，21 项跳过。原生 DSH 与跨版本升级用上述环境变量另行实际执行。相关 UI 回归 14 个文件、143 项通过；实际 Electron 共享配置 E2E 通过，1440/850/640 窗口截图与几何检查未发现溢出。类型检查通过；ESLint 无错误，保留 4 项现有资产界面 Hook 依赖警告。
