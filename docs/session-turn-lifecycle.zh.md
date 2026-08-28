# Session、Turn 与工具生命周期

[English](session-turn-lifecycle.md) | 中文

## 持久事实

Session Event Log 是模型历史、恢复、Fork、UI、查询和 Telemetry 的共同来源。任何进入模型请求的信息都必须能从日志重建；纯 UI 临时状态不进入日志。

## Turn 流程

```text
turn/start
  -> claim inbox input
  -> agent/pre-step
  -> step/start
  -> user/message
  -> derive model history + assemble prompt/tools
  -> agent/request -> llm stream -> assistant events
  -> tool/call -> tools/pre-execute -> execute -> post-execute -> tool/result
  -> step/end
  -> continue when work is owed, otherwise agent/turn-stopping
turn/end
```

一个 Turn 可以包含多个 Step。Step 是一次模型请求及其工具批次。拒绝或空输入仍必须形成可解释的 durable Turn 结束，而不能留下半开状态。

## 工具执行

工具 schema、presentation、执行和输出投影属于同一个 `ToolDefinition`。参数在模型/JSON 边界验证；执行结果规范化为成功或失败判别联合；Post-execute policy 可以替换投影、增加下一轮上下文或阻止结果。

工具取消信号覆盖调用、Provider 和底层资源。Fiber 卸载时，未完成调用必须停止，且不能在取消后写入成功事件。

## 恢复和派生

- Persist backend 保存日志，不拥有 Agent 语义。
- Projection 从日志派生列表、统计和 UI 数据。
- Compaction 生成新的 durable 上下文事实，不可偷偷修改内存历史。
- Fork 复制明确边界之前的 durable 事件，不复制活跃进程资源。
