# Run 诊断顺序

1. 校验 Run/分支/Blueprint 摘要与当前序列。
2. 查看 future queue、活动/等待进程、预约和最长等待。
3. 定位目标 world-event，再追踪 decision-trace、process、reservation、telemetry。
4. 检查 deadlocksResolved、livelocksResolved、fairnessInterventions 和 noProgressSteps。
5. 检查 AI invocation/intent 的上下文来源、实际用量和预算。
6. 只在明确检查点上建立反事实分支，保持原 Run 不变。
