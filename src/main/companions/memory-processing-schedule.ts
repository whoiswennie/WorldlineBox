import { MEMORY_PROCESSING_TRIGGERS, MEMORY_SCHEDULE_EXPLANATION,
  type CompanionMemoryJobSchedule, type CompanionMemoryOwnerSchedule, type CompanionMemoryProcessingJob } from '../../shared/companion-memory-processing';

export function memorySchedule(kind: CompanionMemoryProcessingJob['kind'], patch: Partial<CompanionMemoryJobSchedule> = {}): CompanionMemoryJobSchedule {
  return { scheduleKind: 'condition', timeBasis: 'real', observedAt: new Date().toISOString(), waitingReason: 'queue',
    condition: '等待后台下一轮检查执行条件。', triggerRule: MEMORY_PROCESSING_TRIGGERS[kind], explanation: MEMORY_SCHEDULE_EXPLANATION, ...patch };
}

export function memoryOwnerSchedule(schedulers: CompanionMemoryOwnerSchedule['schedulers']): CompanionMemoryOwnerSchedule {
  const now = Date.now(), checks = schedulers.map(item => item.nextCheckAt).filter((value): value is string => !!value && Date.parse(value) > now).sort();
  return { observedAt: new Date(now).toISOString(), timeBasis: 'real', ...(checks[0] ? { nextCheckAt: checks[0] } : {}),
    condition: schedulers.some(item => item.scheduleKind === 'running') ? '有实际整理任务正在处理；其他任务按各自条件等待。'
      : '按来源、模型和公平资源准入条件推进；各流水线的后续安排见下方。',
    explanation: MEMORY_SCHEDULE_EXPLANATION, schedulers };
}

/** Combine durable eligibility with the real host scheduler; never turn a retry floor into an execution ETA. */
export function memoryProcessingJobSchedule(job: CompanionMemoryProcessingJob, host: CompanionMemoryJobSchedule): CompanionMemoryProcessingJob {
  host = { ...host, nextCheckAt: host.nextCheckAt && Date.parse(host.nextCheckAt) > Date.now() ? host.nextCheckAt : undefined };
  const stored = { ...(job.schedule ?? memorySchedule(job.kind)), nextCheckAt: undefined };
  if (['completed', 'cancelled', 'stale', 'abandoned'].includes(job.status)) return { ...job, nextAttemptAt: undefined, schedule: memorySchedule(job.kind, {
    scheduleKind: 'finished', waitingReason: undefined, condition: job.status === 'completed' ? '本次整理已完成；内容再次变化后才会产生新的任务。'
      : job.status === 'abandoned' ? '本项处理已明确放弃，原始事件和处理历史保留；不会自动重试。' : '此任务已停止或被新版本取代，不会自动继续旧版本。' }) };
  if (job.status === 'parked') return { ...job, nextAttemptAt: undefined, schedule: memorySchedule(job.kind, {
    scheduleKind: 'manual', waitingReason: 'parked', condition: '本项处理已搁置，原始事件和处理历史保留；核对后可明确恢复或放弃，其他独立作业继续处理。' }) };
  if (job.status === 'running' && ['device_testing', 'embedding_unavailable'].includes(host.waitingReason ?? '')) return { ...job, nextAttemptAt: undefined,
    schedule: { ...host, condition: `任务已领取，但当前等待本地向量条件。${host.condition}` } };
  if (job.status === 'running' && stored.waitingReason !== 'lease_expired' && stored.scheduleKind !== 'manual') return { ...job, nextAttemptAt: undefined,
    schedule: memorySchedule(job.kind, { scheduleKind: 'running', waitingReason: undefined, condition: `实际任务正在处理：${job.stage}。完成时间由模型与实际内容决定。` }) };
  const nextAttemptAt = stored.nextAttemptAt ?? job.nextAttemptAt;
  const strongCondition = ['retry_limit', 'reset_in_progress', 'companion_inactive', 'scope_busy', 'lease_expired'].includes(stored.waitingReason ?? '');
  if (strongCondition) return { ...job, schedule: { ...stored, observedAt: host.observedAt,
    ...(stored.scheduleKind !== 'manual' && !['reset_in_progress', 'companion_inactive'].includes(stored.waitingReason ?? '') && host.nextCheckAt ? { nextCheckAt: host.nextCheckAt } : {}),
    explanation: MEMORY_SCHEDULE_EXPLANATION } };
  if (host.scheduleKind === 'condition' || host.scheduleKind === 'manual' || host.scheduleKind === 'unknown') return { ...job,
    schedule: { ...host, ...(nextAttemptAt ? { nextAttemptAt } : {}),
      condition: nextAttemptAt && Date.parse(nextAttemptAt) > Date.now() ? `${host.condition} 同时仍需等到任务记录的最早重试下限。` : host.condition } };
  if (job.status === 'waiting_model') return { ...job, schedule: { ...stored, observedAt: host.observedAt,
    ...(host.nextCheckAt ? { nextCheckAt: host.nextCheckAt } : {}), explanation: MEMORY_SCHEDULE_EXPLANATION } };
  if (nextAttemptAt && Date.parse(nextAttemptAt) > Date.now()) return { ...job,
    schedule: { ...stored, observedAt: host.observedAt, scheduleKind: 'retry', waitingReason: stored.waitingReason === 'cooldown' ? 'cooldown' : 'retry_backoff', nextAttemptAt,
      condition: '最早重试下限尚未到达；冷却结束后仍需等待后台检查、资源准入和模型条件。', ...(host.nextCheckAt ? { nextCheckAt: host.nextCheckAt } : {}) } };
  // A running host may still be handling another owner or earlier item; it is not proof this queued job started.
  return { ...job, schedule: { ...host, ...(nextAttemptAt ? { nextAttemptAt } : {}),
    ...(host.scheduleKind === 'running' ? { scheduleKind: 'condition' as const, waitingReason: 'worker_busy',
      condition: '本轮后台正在处理已领取任务，当前任务继续排队；会在空出资源后再次核验。' } : {}) } };
}
