import type { Companion } from '../../shared/companions';
import type { CompanionMemoryLifePlan, CompanionMemoryLifePlanItem, CompanionWorldSleepPlan } from '../../shared/companion-life-plan';
import { COMPANION_SLEEP_DREAM_PROBABILITY } from '../../shared/companion-sleep';

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
  const captureBlocked = !captureRunning && capture.eligible === 0 && capture.retryExhausted;
  const captureCheck = future(capture?.nextCheckAt, realNow), captureRetry = future(capture?.nextAttemptAt, realNow);
  const captureAt = captureCheck ?? captureRetry;
  items.push({ id: 'journal', kind: 'journal', title: '日记与记忆整理',
    state: blocked ? 'waiting' : captureRunning ? 'running' : capture?.waitingForModel || captureBlocked || capture.expiredLeases ? 'waiting'
      : captureActive ? captureAt ? 'scheduled' : 'eligible' : 'idle',
    timing: captureActive && captureAt ? { kind: captureCheck ? 'next_check' : 'retry', clock: 'real', at: captureAt } : { kind: 'event_driven', clock: 'real' },
    reason: blocked ?? (capture?.waitingForModel ? '等待全局聊天模型恢复后检查来源。'
      : captureBlocked ? '自动重试已达到上限，检查错误后需手动重试。'
      : capture.expiredLeases ? '上次处理的租约已失效，等待后台回收并重新核验来源；没有正在处理的保证。'
      : captureActive ? (capture?.condition ?? capture?.explanation ?? '有真实来源等待整理；检查后也可能无需新增日记。')
        : '新的聊天、伙伴互动、真实阅读或世界经历产生后检查；只收录值得保留的内容，没有每日必写任务。') });

  const job = sleep.job, maintenance = sleep.maintenance;
  const retryAt = future(job?.nextAttemptAt, realNow), notBefore = future(maintenance?.nextDeepEligibleAt, realNow);
  const running = job?.status === 'running' && job.leaseActive;
  const realCompleted = !!maintenance?.realCompletedAt;
  const terminalFailure = job?.terminal === true;
  const realTerminalFailure = terminalFailure && !realCompleted;
  const realRunning = running && !realCompleted;
  items.push({ id: 'sleep-consolidation', kind: 'sleep_consolidation', title: '记忆回顾与整合',
    state: blocked || realTerminalFailure ? 'waiting' : realRunning ? 'running' : !sleep.hasUnconsolidated ? 'idle'
      : retryAt || notBefore ? 'scheduled' : maintenance?.eligible === false ? 'waiting' : 'eligible',
    timing: realTerminalFailure ? realConditional() : retryAt && !realCompleted ? { kind: 'retry', clock: 'real', at: retryAt }
      : notBefore && sleep.hasUnconsolidated ? { kind: 'eligibility', clock: 'real', at: notBefore } : { kind: 'event_driven', clock: 'real' },
    reason: blocked ?? (realTerminalFailure ? (job?.error ?? '本批真实回顾未完成，等待新资料或明确处理后再试。').slice(0, 1000)
      : realRunning ? maintenance?.reflectionCompletedAt ? '真实反思已保存，正在独立整理原始记忆；整合重试不重新生成反思。'
        : '正在独立回顾有来源的真实经历；身体醒来或正在做任务都可以继续。'
        : !sleep.hasUnconsolidated ? '暂无新的真实经历需要深度回顾；已处理来源与标签变动不会反复触发。'
          : retryAt && !realCompleted ? '本批真实回顾等待有界重试；不会重新抽签或换入运行期间的新资料。'
            : notBefore ? '本轮深度回顾已结算，后续新经历等待至少6小时的下一轮资格；即时记录和回忆仍可继续。'
              : maintenance?.eligible === false ? '新经历正在累计；达到3个新事件、最长24小时或重要变更后检查，真实睡眠也可提供一次整理机会。'
                : '已有真实来源满足回顾条件，等待独立后台空位；不会占用普通任务额度，也不要求电脑开到晚上。') });
  let dreamReason = '每轮深度回顾固定评估一次60%联想机会；成功叙述后间隔至少8现实小时，不保证产生梦境。';
  let dreamState: CompanionMemoryLifePlanItem['state'] = 'idle', dreamTiming: Timing = { kind: 'event_driven', clock: 'real' };
  if (terminalFailure) { dreamState = 'waiting'; dreamReason = (job?.error ?? '本轮联想尚未完成，需要新资料或明确处理；不会原样自动重试。').slice(0, 1000); dreamTiming = realConditional(); }
  else if (maintenance?.narrativeStatus === 'failed') { dreamState = 'waiting'; dreamReason = '本轮虚构叙述最多3次尝试已经结束；已完成的真实回顾保持有效。'; }
  else if (maintenance?.narrativeStatus === 'skipped' || sleep.admission === 'not_admitted') dreamReason = '本轮维护未通过联想条件，已持久记录跳过，不会反复抽签；真实回顾仍独立完成。';
  else if (maintenance?.narrativeStatus === 'completed') dreamReason = '本轮联想已经完成；后续整理不会自动增加一个梦境。';
  else if (job?.dreamAllowed) {
    dreamState = running && realCompleted ? 'running' : retryAt ? 'scheduled' : 'waiting';
    dreamReason = running && realCompleted ? '真实回顾已保存，正在尝试独立虚构联想；模型仍可不产出梦境。'
      : realCompleted ? '真实回顾已保存，等待剩余联想阶段；失败最多3次，不重做真实回顾。' : '本轮已获联想机会，先完成真实回顾，再尝试可选虚构叙述。';
    if (retryAt) dreamTiming = { kind: 'retry', clock: 'real', at: retryAt };
  } else if (sleep.admission === 'admitted') dreamReason = '本轮联想机会已经使用；不会把后续整合自动当作新的梦境。';
  else if (sleep.dreamCooldownUntilWorld) {
    dreamReason = '距上次成功叙述尚未满8现实小时；之后仍需新的回顾会话与一次概率判断。';
    dreamTiming = { kind: 'conditional', clock: 'real', at: sleep.dreamCooldownUntilWorld };
  } else if (!sleep.hasUnconsolidated) dreamReason = '暂无新的真实素材需要联想；不会补造离线期间的梦境。';
  else dreamState = 'waiting';
  items.push({ id: 'dream', kind: 'dream', title: '梦境与联想', state: blocked ? 'waiting' : dreamState,
    timing: dreamTiming, reason: blocked ?? dreamReason, probability: COMPANION_SLEEP_DREAM_PROBABILITY });
  return { companionId: companion.id, checkedAt: sleep.checkedAt, items, hasMore: sleep.learningHasMore };
}
