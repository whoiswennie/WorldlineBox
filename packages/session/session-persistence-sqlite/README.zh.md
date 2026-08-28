# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

SQLite 持久会话存储后端：第二个 `SessionPersistence` 提供方（见会话持久化），满足与 `worldline-session-persistence-jsonl` 相同的约定（仅追加、连续 seq、延迟实体化、在 load 时关闭中断轮次），但用 `node:sqlite` 行而非文件字节表达。

`locate(meta)` 返回 `undefined`，因为所有会话共享同一个数据库。该提供方不暴露逐会话原始产物。

## 存储模型

每个 `SessionEvent` 1:1 映射到 `events` 表中的一行 `(session_id, seq, type, time, data, source_event_seqs, surface_op)`；`data` 是作为 JSON 文本的事件 payload，因此行结构就是原始事件本身（包括 `assistant/chunk`，保持 `seq` 连续）。两个 `TEXT` 列 `source_event_seqs` 和 `surface_op` 可为空，存储事件可选接口元数据字段（见会话接口）。日志外元数据（`SessionHeader`）、每实体化 incarnation id 和每日志单调修订位于 `sessions` 行；`createdAt` 是存储在 strict `INTEGER` 列中的非负安全整数。单例状态行携带不可变存储 id。`sessions` 行只由第一次 `append` 写入，其存在性是延迟实体化信号（`list` 精确报告有行的会话）。

Schema 17 在本包内拥有 codec，不导入其他持久化格式中可变的实现。只有字段完全匹配、连续且属于同一分片块的文本、推理或工具调用 delta 才会打包。未知字段、surface 元数据、序列缺口、不兼容的块／调用身份以及不安全时间戳仍以标量行存储。一个打包行最多表示 1,024 个事件，未压缩 UTF-8 `data` 最多 1 MiB；更长的连续段会在不改变逻辑事件的前提下分割。读取会在向持久化协调器返回数据前，重建每个原始序列号、时间戳、token 边界、参数片段和 payload。

序列化后的 `data` 小于 4 KiB 时保持为 SQLite `TEXT`。达到或超过该阈值时，写入方会使用 Zstandard level 3，并且只在 frame 小于原文本的情况下存储 `BLOB`；读取方会先解压，再执行 UTF-8 校验和 JSON 解析。`source_event_seqs` 仍是完整且有序的来源数组。第一个序列使用无符号 varint，后续序列使用 ZigZag varint 编码的有符号差值，并存为 `BLOB`；不会省略任何来源，也不会把数组转换成范围。

每次追加持有 `BEGIN IMMEDIATE`，验证有界物理尾部，只打包新的持久批次，插入这些记录，并把会话 revision 递增一次。普通追加绝不删除或替换既有事件行。默认 200 毫秒写后缓冲窗口因此仍能压缩高频流，而物理写入量与新增持久批次成正比，不会反复改写不断增长的打包值。存储层逻辑尾部检查会在陈旧写入方执行变更前拒绝该写入。

- **Append = 事务。**`append` 围绕批次运行 `BEGIN`/`COMMIT`：它实体化 `sessions` 行（如果仍未实体化），并 INSERT 每个事件，首先断言连续 seq 约定（第一个事件 `seq` 必须等于已存储 next-seq）。批次中失败（重复 seq 上的 UNIQUE 违规）会完全回滚，使已存储日志和内存游标保持一致。（`load()` 已平衡已存储日志，因此 `append` 不必修复崩溃尾部。）
- **延迟实体化。**`create()` 只在内存记录意图，第一次 `append` 前不写行。已创建但从未 append 的会话没有 `sessions` 行，因此不在 `list()` 中（它精确报告有行的会话）。
- **在 load 时关闭中断轮次。**`load()` 实现共享崩溃恢复约定：保留有效中断轮次，在一个事务中追加合成关闭事件，并只移除撕裂尾部行。已提交解析错误或序列缺口使会话无法加载。恢复会变更已存储行，因此下一次 append 从平衡日志和准确游标开始。
- **非修改式检查。**`inspect()` 返回不可变、平衡的逻辑视图，并可在内存中合成恢复 closer，但不会删除撕裂尾部行、追加恢复行或更改轻量修订。
- **轻量修订。**`listSnapshots(signal?)` 组合不可变存储与数据库文件身份、每实体化 incarnation id，以及在每个变更事务中递增的每会话计数器。完整前缀读取在同一个读事务中捕获该 revision 及其事件行，`readStoredRevision()` 则只查询 session 行来校验保留的 preparation。它在不解析事件行的情况下保持未变观察稳定，并区分独立存储和重建的同 id 日志。它在共享就绪和同步元数据查询前后检查取消；查询本身不可抢占。

## 配置（schemastery）

```ts
interface Config {
  path: string
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'
  busyTimeoutMs?: number
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
}
```

`journalMode` 默认为 `wal`，`busyTimeoutMs` 默认为 `5,000`，`preparedSessionCacheSize` 默认为 `5`，`writeBatchMaxDelayMs` 默认为 `200`。该超时限制每次同步 SQLite 锁等待的时长。SQLite 在切换 journal mode 时可能立即返回 `SQLITE_BUSY`，因此冷打开会在尝试之间让出执行，并在从打开时开始计算的重试截止点后不再发起新尝试。正在执行的同步 SQLite 调用可能在该截止点之后才完成。提供方会在每个连接上禁用可信 schema 与内存映射 I/O，然后读回这两项设置。提供方还会读回所选 journal mode 并要求它匹配；内存数据库显式接受 SQLite 返回的 `memory`。选择 journal 后，提供方会把 `synchronous` 固定为 `FULL` 并验证该设置，避免 SQLite 构建默认值削弱已提交追加的持久性。在 POSIX 上，数据库父目录和文件必须归当前用户所有，父目录不得允许组或其他用户写入，文件不得授予组或其他用户任何权限。符号链接和非普通文件会被拒绝。Windows 同样拒绝符号链接与非普通文件，但部署方仍负责把目录和文件 ACL 限制给 harness 用户。路径与所有权错误会拒绝插件初始化。Node SQLite 在第一次持久化操作时才加载；导入时只抑制 Node 22 精确的 SQLite `ExperimentalWarning`。存储身份与 schema 错误会在暴露或变更数据前拒绝该操作。

## 模型体验

### 恢复的对话历史

#### 模型看到什么

没有 SQLite 特有内容。恢复得到与 JSONL 相同的逻辑事件和派生消息；物理打包标签绝不会进入 prompt、工具、回放或实时 `session/event` 投递。

#### Token 影响

实时请求增加零 token。恢复只为保留的逻辑历史和当前请求 envelope 付出 token。

#### KV Cache 影响

物理打包不会改变请求前缀。与其他持久化后端相同，提供方 cache 复用取决于重建历史、当前 envelope 和模型路由。

## 已知限制与延期工作

- **过渡性的 SQLite 专用设计**——这一以效率为重点的实现参考了 [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb)。支持多种后端与可配置 schema 的统一关系数据库设计尚待后续完善；预发布开发阶段不保证 schema 稳定性或迁移支持。
- **打包服从持久批次边界**——被写后缓冲窗口或显式 flush 分开的兼容连续段会保留为不同物理记录；这以打包率受时序影响为代价，避免改写既有行。
- **同步压缩**——Node 的 SQLite 与 Zstandard 调用都会阻塞 JavaScript 线程；4 KiB 阈值限制了小型记录的逐 frame 工作。
- **`DatabaseSync` 会阻塞事件循环**——减少物理行不会使 SQLite 操作变为异步。
- **繁忙等待会阻塞事件循环**——SQLite 会在同步 `DatabaseSync` 调用内等待；只有繁忙的 journal-mode 切换会在两次尝试之间让出执行，而且从打开时计算的截止点只阻止新尝试，不会中断正在执行的调用。
- **外部 SQL 读取方必须理解物理标签**——受支持的消费方通过本提供方读取，而不是把每个 `events.type` 都当作逻辑事件类型。
- **没有删除或后台历史压缩**——普通追加只做插入。
