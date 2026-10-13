# DSH 停机副本的会话路径迁移

当前正常运行采用共享存档：不同版本和整合包的私有 Home / profile 独立，而会话、附件和默认
工作区路由到 `dsh-launcher/shared`。`shared-session-data.ts` 在停机准备时将旧私有数据迁入
共享层，保留原始目录及冲突文件。下述 `rebaseCopiedSessionData` 仍用于旧布局、停机副本和
历史备份的明确路径适配，不能据此把所有运行会话重新隔离到每个实例。

共享默认工作区由 `workspace-controller.documentsDirectory` 指向共享 Documents，
会话持久化使用共享 session root，附件通过共享 dshHome 解析。不同实例共用会话并不取消写入
协调：同一会话的写入需要受管排他锁，程序版本和插件环境的并行运行不能同时改写同一日志。
未知会话格式和版本适配仍拒绝盲目迁移；共享数据的降级兼容性独立于程序回退。

`src/main/dsh/instance-data-rebase.ts` 的 `rebaseCopiedSessionData` 只操作尚未发布的新副本。调用方先验证来源备份的完整文件封存，再复制完整实例，最后调用迁移并验证副本；来源目录不变。

DSH 的会话工作目录来自持久化 `SessionHeader.cwd`，终端和 `workspace-write` 权限边界使用该字段。仅改变启动进程 cwd 或 DSH_HOME，不能改变已经保存的会话。工作区登记还持有 `home/storages/workspace.json` 中 `tables.workspaces[id].path`。

当前路径适配器固定到官方 DSH `0.2.0-rc.2`，识别其原生 Session V0/V1 的 `seedLength` 头，以及 V2–V4 的 `isSeeded` 头。它只将来源实例根内的 cwd 和 Workspace path 映射到新实例根，外部用户项目保持原路径，因此属于明确共享的项目。未知运行版本、未知有内部 cwd 的会话格式、额外头字段、损坏或截断的首帧、世代元数据分歧、存储目录不符和目标碰撞都拒绝迁移，不推测兼容性。

默认 `.jsonl.zstd` 包含独立压缩帧：第一帧只能是一行会话头。迁移解析其边界，最多解压 4 MiB 头，修改 cwd 后重新压缩该帧；其后的压缩事件帧逐字节复制。普通 JSONL 则只重写第一行。所有原始和历史世代一起搬到官方 `projectKey(newCwd)` 目录。会话 id、时间、父子关系、权限事件、消息、工具参数、任务证据和历史文本均不改写。

工作区 JSON 的适配只接受 `unit.name = workspace`、`unit.version = 2`，并只更新记录的 `path`。可再生 `session_projcache` 被清除，DSH 在新根重新建立读模型；原始会话和附件保留。`session-rebase-receipt.json` 记录改变的头、旧/新 cwd 和头字节摘要，便于审查迁移。

现有上游头字段只有 cwd 是文件系统引用；额外动态头字段不被这个适配器接受。默认附件使用不含文件路径的内容地址，实际对象由新 DSH_HOME 下的 `attachments/v1` 解析。权限预设和模式是会话事件，`sandbox-policy` 用迁移后的头确定 workspace 边界。插件自定义 storage、外部数据库、历史命令中的显式绝对路径和用户选定的宽权限模式仍遵循上游行为；目录迁移不构成系统访问沙箱，也不会修改历史证据来伪造另一段执行历史。

`tests/unit/dsh-instance-data-rebase.test.ts` 验证普通/压缩多世代日志的事件字节保持、工作区迁移、外部项目保留、拒绝未知格式与截断数据，以及来源目录完整性。设置 `WORLDLINEBOX_DSH_REAL_DIRECTORY` 后，还通过实际官方 `runProfile`、`sessionPersistence.create/append/flush` 创建带原生事件的会话，迁移后用上游 `list/open/read` 验证，并检查工作区指向新副本。这项验证不调用模型、不读用户默认 `.dsh`、不打开图形窗口。
