import type { Companion } from '../../shared/companions';
import type { CompanionMemoryLifePlan, CompanionMemoryLifePlanItem, CompanionWorldSleepPlan } from '../../shared/companion-life-plan';
import { companionCivilInstantInZone, companionTimeInZone, resolveCompanionScheduleTimeZone } from '../../shared/companion-schedule-time';
import { COMPANION_SLEEP_DREAM_PROBABILITY, COMPANION_SLEEP_MINIMUM_REAL_MS } from '../../shared/companion-sleep';

export interface CompanionMemoryCapturePlan {
  pending: number; running: number; failed: number;
  liveRunning?: number; expiredLeases?: number;
  held?: number; retryExhausted?: number; eligible?: number;
  nextCheckAt?: string; nextAttemptAt?: string; waitingForModel?: boolean; condition?: string; explanation?: string;
}
export interface CompanionMemoryLifePlanInput {
  companion: Pick<Companion, 'id' | 'name' | 'active'>;
  sleep: CompanionWorldSleepPlan;
  chatModelConfigured: boolean;
  companionChatModelConfigured?: boolean;
  capture?: CompanionMemoryCapturePlan;
}
type Timing = CompanionMemoryLifePlanItem['timing'];
const realConditional = (): Timing => ({ kind: 'conditional', clock: 'real' });
const future = (value: string | undefined, now: number): string | undefined => {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > now ? new Date(at).toISOString() : undefined;
};

/** Civil sleep window, matching routine evaluation across midnight and DST. */
function sleepWindow(sleep: CompanionWorldSleepPlan): Timing {
  const zone = resolveCompanionScheduleTimeZone(sleep.clock.timeZone), now = Date.parse(sleep.clock.virtualNow);
  const local = companionTimeInZone(now, zone), day = Date.UTC(local.year, local.month - 1, local.day), windows: Array<{ start: number; end: number }> = [];
  const atClock = (civilDay: number, clock: string) => {
    const date = new Date(civilDay), [hour, minute] = clock.split(':').map(Number);
    return companionCivilInstantInZone({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      hour: hour!, minute: minute!, second: 0, millisecond: 0 }, zone, 'next_valid');
  };
  for (let offset = -1; offset <= 2; offset++) {
    const civilDay = day + offset * 86400000, start = atClock(civilDay, sleep.routine.sleepAt),
      end = atClock(civilDay + (sleep.routine.wakeAt <= sleep.routine.sleepAt ? 86400000 : 0), sleep.routine.wakeAt);
    if (start !== undefined && end !== undefined && end > now && end > start) windows.push({ start, end });
  }
  windows.sort((a, b) => a.start - b.start);
  const window = windows[0];
  return { kind: window ? 'window' : 'conditional', clock: 'world', timeZone: zone,
    ...(window ? { windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString() } : {}) };
}

/** Read model only: future times describe checks or eligibility, never promised execution. */
export function projectCompanionMemoryLifePlan(input: CompanionMemoryLifePlanInput): CompanionMemoryLifePlan {
  const { companion, sleep, chatModelConfigured } = input;
  const capture: CompanionMemoryCapturePlan = { ...sleep.captureQueue, ...input.capture };
  if (sleep.companionId !== companion.id) throw new Error('生活安排不属于当前伙伴。');
  const realNow = Date.parse(sleep.checkedAt), items: CompanionMemoryLifePlanItem[] = [];
  const commonBlocked = sleep.resetting ? '正在重建此伙伴的记忆，完成后再检查。'
    : companion.active === false || !sleep.active ? '此伙伴未启用，启用后才继续检查。' : undefined;
  const learningBlocked = commonBlocked ?? (!chatModelConfigured ? '尚未配置全局聊天模型，等待模型配置后检查。' : undefined);
  const blocked = commonBlocked ?? (!(input.companionChatModelConfigured ?? chatModelConfigured) ? '尚未配置此伙伴可用的聊天模型，等待模型配置后检查。' : undefined);
  const learning = sleep.learning.filter(item => item.grant.companionId === companion.id && item.grant.enabled);
  if (!learning.length) items.push({ id: 'learning-unconfigured', kind: 'learning', title: '资料学习', state: 'unconfigured',
    timing: realConditional(), reason: '尚未授权学习来源；可在学习来源中安排，伙伴不会自行读取资产库。' });
  for (const { grant, manualPending } of learning.slice(0, 47)) {
    const arranged = grant.autonomous || manualPending, next = arranged ? future(grant.nextAt, realNow) : undefined;
    const noActor = !sleep.actor;
    const resting = sleep.actor && (['sleeping', 'eating'].includes(sleep.actor.routinePhase)
      || ['sleeping', 'eating', 'working', 'lyingDown', 'waking'].includes(sleep.actor.activity));
    const state = learningBlocked ? 'waiting' : grant.status === 'reading' ? 'running' : !arranged ? 'idle'
      : grant.error || resting || noActor ? 'waiting' : next ? 'scheduled' : 'eligible';
    items.push({ id: 'learning-' + grant.id, kind: 'learning', title: '资料学习', state,
      sourceTitle: [grant.libraryName, grant.folderName].filter(Boolean).join(' / ').slice(0, 512),
      timing: next ? { kind: 'eligibility', clock: 'real', at: next } : realConditional(),
      reason: learningBlocked ?? (grant.status === 'reading' ? '学习任务已领取，正在准备或读取授权资料；实际阅读后仍需筛选收录。'
        : !arranged ? '已授权，等待手动开始；未开启自主学习。'
          : grant.error ? grant.error.slice(0, 1000)
            : noActor ? '等待伙伴进入持续生活并可使用电脑后检查。'
            : resting ? '正在休息或用餐；到检查时间后仍需等伙伴可用。'
              : next ? '到时可再次检查此来源；仍需模型与电脑座位可用。'
                : '已到检查条件，等待后台轮询与可用电脑座位；不会据此认定已经学会。') });
  }
  const captureActive = Boolean(capture && (capture.pending || capture.running || capture.failed));
  const captureRunning = (capture.liveRunning ?? capture.running) > 0;
  const captureBlocked = !captureRunning && capture.eligible === 0 && (capture.held || capture.retryExhausted);
  const captureCheck = future(capture?.nextCheckAt, realNow), captureRetry = future(capture?.nextAttemptAt, realNow);
  const captureAt = captureCheck ?? captureRetry;
  items.push({ id: 'journal', kind: 'journal', title: '日记与记忆整理',
    state: blocked ? 'waiting' : captureRunning ? 'running' : capture?.waitingForModel || captureBlocked || capture.expiredLeases ? 'waiting'
      : captureActive ? captureAt ? 'scheduled' : 'eligible' : 'idle',
    timing: captureActive && captureAt ? { kind: captureCheck ? 'next_check' : 'retry', clock: 'real', at: captureAt } : { kind: 'event_driven', clock: 'real' },
    reason: blocked ?? (capture?.waitingForModel ? '等待全局聊天模型恢复后检查来源。'
      : captureBlocked ? capture.held ? '当前来源被收录规则暂停保护；解除对应限制后才会继续检查。' : '自动重试已达到上限，检查错误后需手动重试。'
      : capture.expiredLeases ? '上次处理的租约已失效，等待后台回收并重新核验来源；没有正在处理的保证。'
      : captureActive ? (capture?.condition ?? capture?.explanation ?? '有真实来源等待整理；检查后也可能无需新增日记。')
        : '新的聊天、伙伴互动、真实阅读或世界经历产生后检查；只收录值得保留的内容，没有每日必写任务。') });

  const window = sleepWindow(sleep), actor = sleep.actor, job = sleep.job;
  const actuallySleeping = actor?.activity === 'sleeping' && !actor.moving && !actor.working;
  const minimumAt = actuallySleeping ? Date.parse(actor.activityStartedAtReal) + COMPANION_SLEEP_MINIMUM_REAL_MS : undefined;
  const sleepReady = minimumAt !== undefined && Date.parse(sleep.clock.observedRealAt) >= minimumAt;
  const minTiming: Timing = minimumAt !== undefined && minimumAt > realNow
    ? { kind: 'eligibility', clock: 'real', at: new Date(minimumAt).toISOString() } : realConditional();
  const retryAt = future(job?.nextAttemptAt, realNow);
  const running = job?.status === 'running' && job.leaseActive;
  items.push({ id: 'sleep-consolidation', kind: 'sleep_consolidation', title: '睡眠记忆整合',
    state: blocked ? 'waiting' : running ? 'running' : !sleep.hasUnconsolidated ? 'idle'
      : actuallySleeping ? sleepReady && !retryAt ? 'eligible' : 'waiting' : 'scheduled',
    timing: retryAt ? { kind: 'retry', clock: 'real', at: retryAt } : actuallySleeping ? minTiming : window,
    reason: blocked ?? (running ? '正在本次真实睡眠中回顾有来源的记忆；醒来会停止。'
      : !sleep.hasUnconsolidated ? '暂无待整合的已收录记忆；有新记忆并真正入睡后才检查。'
        : retryAt ? '本次整合失败后等待重试资格；仍须保持实际睡眠。'
          : actuallySleeping ? sleepReady ? '已达到实际睡眠与记忆条件，等待后台空位检查。' : '真正入睡满5秒后才可检查；醒来或占用工作会停止。'
            : '作息窗口是可检查时间；还须真正躺下入睡、拥有待整合记忆，并且没有工作占用。') });
  let dreamReason = '有待整合记忆并真正入睡后才评估；每段睡眠一次60%准入，且相隔至少8世界小时，不保证产生梦境。';
  let dreamState: CompanionMemoryLifePlanItem['state'] = 'idle', dreamTiming: Timing = actuallySleeping ? minTiming : window;
  if (sleep.admission === 'not_admitted') dreamReason = '本次睡眠未通过入梦条件，不会反复抽签；仍可进行记忆整合。';
  else if (job?.dreamAllowed) {
    dreamState = running ? 'running' : sleepReady && !retryAt ? 'eligible' : 'waiting';
    dreamReason = running ? '本次已获入梦资格，正在尝试联想；模型仍可不产出梦境。' : '本次已获入梦资格，等待睡眠整合执行；不保证梦境产出。';
    if (retryAt) dreamTiming = { kind: 'retry', clock: 'real', at: retryAt };
  } else if (sleep.admission === 'admitted') dreamReason = '本次入梦机会已经使用；不会把后续整合自动当作新的梦境。';
  else if (sleep.dreamCooldownUntilWorld) {
    dreamReason = '仍在8世界小时入梦冷却内；冷却后还需新的实际睡眠段与概率判断。';
    dreamTiming = { kind: 'conditional', clock: 'world', timeZone: sleep.clock.timeZone, at: sleep.dreamCooldownUntilWorld };
  } else if (!sleep.hasUnconsolidated) dreamReason = '暂无可供联想的待整合记忆；入梦还需实际睡眠与概率条件。';
  else dreamState = 'waiting';
  items.push({ id: 'dream', kind: 'dream', title: '概率梦境', state: blocked ? 'waiting' : dreamState,
    timing: dreamTiming, reason: blocked ?? dreamReason, probability: COMPANION_SLEEP_DREAM_PROBABILITY });
  return { companionId: companion.id, checkedAt: sleep.checkedAt, items, hasMore: sleep.learningHasMore };
}
