# 派生来源撤回同步（2026-11-03）

原消息 A 的文件经后续任务 B 产生通知 C 和自动回复 D。即使宿主 SQL 已把 A 的派生关系过滤掉，先前进入 VCP 原文 episode / CDS 的 C、D 仍可能被 TopicMemo / DeepMemo 独立检索。这是两个耐久投影之间的撤回缺口，单独过滤 UI 或下次主脑上下文不足以解决。

宿主先把明确的消息 / 事件来源闭包持久化至 SQL 撤回 outbox，再逐页调用：

```ts
await memory.withdrawSources(scope, { sourceEventIds, sourceMessageIds }, signal);
// { withdrawn: true, revision, sourceEventIds, sourceMessageIds }
```

VCP 的 `bot.sources.withdraw` 在原生运行时初始化之前，先事务写入 tombstones、受影响 episode 的 pending 意图及相关 note 的 withdrawing 状态。新增受管 `mutation_sources` 反向索引查找源消息 / 事件相交的衍生日记，并继续扩展其来源；旧 ledger 仅一次回填索引。该适配不修改原始 405 个检索、评分或原生实现文件。

处理依次完成原日记删除及精确路径的原生“不存在”回执、受影响 episode 的过滤重写、OneRing 派生表与 prepared 旧材料清理、RAG 缓存清理，以及活动 CDS 的实际增量同步。每个确认删除的 note 立即记录进度；每个已重写 episode 记录 done，避免中途退出后从头做完整大批次。CDS 同步完成后才能清除总 pending 标志，宿主才确认 outbox 游标。宿主将回执扩展出的新来源重新并入 SQL 闭包，继续冲刷新增 outbox 项。

pending 存在时，托管 search、DeepMemo / TopicMemo、preprocess、response 和 prepared 读取显式返回 `MEMORY_SOURCE_WITHDRAWAL_PENDING`。失败或取消会保留已提交的撤回意图并退休旧 Worker；新 Worker 激活先执行 bot.repair，完成前不放行记忆查询。修复阶段不用聊天 LLM；已有图片 / 文件原始媒体也不因撤回而删除。DSH 原始日志与原始消息不宣称物理擦除，仍由宿主来源屏蔽及 epoch 轮换约束。

来源分页是 append-only 撤回 outbox 的序号，而不是 UI 原消息 sequence；每页只有实际 VCP 回执后才推进耐久游标。这可以覆盖“较早的消息在后来才被撤回”，也可以在 native 成功、SQL ack 前退出后安全重放。重复撤回不增加 revision，不跨 companion / security domain 删除。

专门实际原生测试验证了 202 条原话的跨 episode C/D、独立衍生日记、三种检索、冷重启、拒绝重投影 / 重新捕获，以及其他域与合法原文保留。另一个实际子进程在提交来源意图后以 exit 74 退出：原 episode 在修复前仍确有 C/D，但原始 VCP 查询被阻止；冷修复后文件和检索均不再包含 C/D。这些使用明确的本地 embedding 协议向量及拒绝聊天端点，属于生命周期 / 存储验收，不是记忆语义质量测评。

空或错误路径的删除探针不能作为成功回执；对应故障测试检查 pending 仍在、note 仍为 withdrawing、查询继续关闭。已有 DailyNote 创建后 / ledger 未确认的恢复测试继续保留内容冲突拒绝错删的边界。原始 DSH / SQL / 媒体源文件不由这个 VCP 接口物理清理。
