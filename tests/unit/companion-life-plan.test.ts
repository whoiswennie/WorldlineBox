import { describe, expect, it } from 'vitest';
import { companionMemoryLifePlanSchema, type CompanionWorldSleepPlan } from '../../src/shared/companion-life-plan';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';
import type { CompanionLearningGrant } from '../../src/shared/companion-learning';
import { projectCompanionMemoryLifePlan } from '../../src/main/companions/life-plan-projection';

const checkedAt = '2026-10-22T10:00:00.000Z';
function context(patch: Partial<CompanionWorldSleepPlan> = {}): CompanionWorldSleepPlan {
  return { companionId: 'alice', checkedAt, active: true, resetting: false,
    clock: { realNow: checkedAt, virtualNow: '2026-10-22T14:00:00.000Z', observedRealAt: checkedAt, timeZone: 'Asia/Shanghai', speed: 72 },
    routine: companionRoutineConfigSchema.parse({ timeZone: 'Asia/Shanghai', sleepAt: '23:00', wakeAt: '07:00' }),
    actor: { activity: 'idle', routinePhase: 'awake', activityStartedAtReal: checkedAt, moving: false, working: false },
    hasUnconsolidated: false, admission: 'unchecked', learning: [], learningHasMore: false,
    captureQueue: { pending: 0, running: 0, failed: 0, liveRunning: 0, expiredLeases: 0, held: 0, retryExhausted: 0, eligible: 0 }, ...patch };
}
function grant(patch: Partial<CompanionLearningGrant> = {}): CompanionLearningGrant {
  return { id: 'grant_alice', companionId: 'alice', libraryId: 'library', libraryName: '海边书架', libraryPath: 'D:/资料', enabled: true, autonomous: true,
    intervalMinutes: 30, revision: 1, createdAt: checkedAt, updatedAt: checkedAt, nextAt: '1970-01-01T00:00:00.000Z', status: 'idle', reads: 0, ...patch };
}
const project = (sleep = context(), chatModelConfigured = true) => projectCompanionMemoryLifePlan({ companion: { id: 'alice', name: '小肥鱼', active: true }, sleep, chatModelConfigured });
const row = (sleep: CompanionWorldSleepPlan, kind: string) => project(sleep).items.find(item => item.kind === kind)!;

describe('truthful owner memory and learning plans', () => {
  it('keeps event-driven diaries distinct from fixed daily tasks and probability dreams', () => {
    const plan = project();
    expect(companionMemoryLifePlanSchema.parse(plan)).toEqual(plan);
    expect(plan.items).toHaveLength(4);
    expect(plan.items[0]).toMatchObject({ kind: 'learning', state: 'unconfigured' });
    expect(plan.items[1]).toMatchObject({ kind: 'journal', state: 'idle', timing: { kind: 'event_driven', clock: 'real' } });
    expect(plan.items[1]!.reason).toContain('没有每日必写任务');
    expect(plan.items[3]).toMatchObject({ kind: 'dream', state: 'idle', probability: .6 });
    expect(plan.items.every(item => !item.timing.at)).toBe(true);
  });
  it('uses world civil sleep windows without turning a compressed world hour into a real appointment', () => {
    const sleep = context({ hasUnconsolidated: true }), item = row(sleep, 'sleep_consolidation');
    expect(item).toMatchObject({ state: 'scheduled', timing: { kind: 'window', clock: 'world', timeZone: 'Asia/Shanghai',
      windowStart: '2026-10-22T15:00:00.000Z', windowEnd: '2026-10-22T23:00:00.000Z' } });
    expect(item.reason).toContain('真正躺下入睡');
  });
  it('keeps a currently open midnight/DST sleep window and the actual future wake boundary', () => {
    const sleep = context({ clock: { ...context().clock, virtualNow: '2026-11-01T06:30:00.000Z', timeZone: 'America/New_York' } });
    expect(row(sleep, 'sleep_consolidation').timing).toMatchObject({ windowStart: '2026-11-01T03:00:00.000Z', windowEnd: '2026-11-01T12:00:00.000Z' });
  });
  it('does not publish the 1970 immediate sentinel and distinguishes manual grants from real manual runs', () => {
    let sleep = context({ learning: [{ grant: grant(), manualPending: false }] });
    expect(row(sleep, 'learning')).toMatchObject({ state: 'eligible', timing: { kind: 'conditional', clock: 'real' } });
    expect(JSON.stringify(project(sleep))).not.toContain('1970');
    sleep = context({ learning: [{ grant: grant({ autonomous: false }), manualPending: false }] });
    expect(row(sleep, 'learning')).toMatchObject({ state: 'idle' });
    sleep.learning[0]!.manualPending = true;
    expect(row(sleep, 'learning')).toMatchObject({ state: 'eligible' });
    sleep.learning[0]!.grant.nextAt = '2026-10-22T10:30:00.000Z';
    expect(row(sleep, 'learning')).toMatchObject({ state: 'scheduled', timing: { kind: 'eligibility', clock: 'real', at: '2026-10-22T10:30:00.000Z' } });
  });
  it('requires actual sleep duration and unprocessed indexed evidence instead of a document count', () => {
    const sleep = context({ hasUnconsolidated: true, actor: { activity: 'sleeping', routinePhase: 'sleeping', activityStartedAtReal: '2026-10-22T09:59:57.000Z', moving: false, working: false } });
    expect(row(sleep, 'sleep_consolidation')).toMatchObject({ state: 'waiting', timing: { kind: 'eligibility', clock: 'real', at: '2026-10-22T10:00:02.000Z' } });
    sleep.actor!.activityStartedAtReal = '2026-10-22T09:59:50.000Z';
    expect(row(sleep, 'sleep_consolidation').state).toBe('eligible');
    sleep.actor!.working = true;
    expect(row(sleep, 'sleep_consolidation').state).toBe('scheduled');
    sleep.hasUnconsolidated = false;
    expect(row(sleep, 'sleep_consolidation').state).toBe('idle');
  });
  it('never rerolls or promises a dream in a rejected or already consumed sleep episode', () => {
    expect(row(context({ hasUnconsolidated: true, admission: 'not_admitted' }), 'dream')).toMatchObject({ state: 'idle', probability: .6 });
    expect(row(context({ hasUnconsolidated: true, admission: 'not_admitted' }), 'dream').reason).toContain('不会反复抽签');
    expect(row(context({ hasUnconsolidated: true, admission: 'admitted' }), 'dream').reason).toContain('机会已经使用');
    expect(row(context({ dreamCooldownUntilWorld: '2026-10-22T20:00:00.000Z' }), 'dream')).toMatchObject({ timing: { kind: 'conditional', clock: 'world', at: '2026-10-22T20:00:00.000Z' } });
  });
  it('separates retry eligibility from an actual registered main-process check and keeps a dream output optional', () => {
    const sleep = context({ hasUnconsolidated: true, admission: 'admitted', actor: { activity: 'sleeping', routinePhase: 'sleeping', activityStartedAtReal: '2026-10-22T09:00:00.000Z', moving: false, working: false },
      job: { status: 'failed', attempts: 1, leaseActive: false, dreamAllowed: true, nextAttemptAt: '2026-10-22T10:00:30.000Z' },
      captureQueue: { pending: 0, running: 0, failed: 2, liveRunning: 0, expiredLeases: 0, held: 0, retryExhausted: 0, eligible: 0, nextAttemptAt: '2026-10-22T10:00:30.000Z' } });
    expect(row(sleep, 'sleep_consolidation').timing).toMatchObject({ kind: 'retry', clock: 'real' });
    expect(row(sleep, 'journal').timing).toMatchObject({ kind: 'retry', clock: 'real' });
    const plan = projectCompanionMemoryLifePlan({ companion: { id: 'alice', name: '小肥鱼' }, sleep, chatModelConfigured: true,
      capture: { ...sleep.captureQueue, nextCheckAt: '2026-10-22T10:00:02.000Z', condition: '等待当前来源允许被收录' } });
    expect(plan.items.find(item => item.kind === 'journal')).toMatchObject({ timing: { kind: 'next_check', at: '2026-10-22T10:00:02.000Z' }, reason: '等待当前来源允许被收录' });
    sleep.job!.status = 'running'; sleep.job!.leaseActive = true;
    expect(row(sleep, 'dream')).toMatchObject({ state: 'running' });
    expect(row(sleep, 'dream').reason).toContain('仍可不产出');
  });
  it('gives inactive/reset/model and real policy blocks priority without pretending they are runnable', () => {
    const sleep = context({ hasUnconsolidated: true, learning: [{ grant: grant(), manualPending: true }] });
    expect(project(sleep, false).items.filter(item => item.state !== 'unconfigured').every(item => item.state === 'waiting')).toBe(true);
    sleep.active = false;
    expect(row(sleep, 'journal').reason).toContain('未启用');
    sleep.resetting = true;
    expect(row(sleep, 'journal').reason).toContain('重建');
    sleep.active = true; sleep.resetting = false;
    sleep.captureQueue = { pending: 3, running: 0, failed: 0, liveRunning: 0, expiredLeases: 0, eligible: 0, held: 3, retryExhausted: 0 };
    expect(row(sleep, 'journal')).toMatchObject({ state: 'waiting' });
    expect(row(sleep, 'journal').reason).toContain('收录规则暂停');
    sleep.captureQueue = { ...sleep.captureQueue, pending: 0, failed: 3, held: 0, retryExhausted: 3 };
    expect(row(sleep, 'journal').reason).toContain('手动重试');
    sleep.captureQueue = { ...sleep.captureQueue, running: 3, failed: 0, retryExhausted: 0, expiredLeases: 3 };
    expect(row(sleep, 'journal')).toMatchObject({ state: 'waiting' });
    expect(row(sleep, 'journal').reason).toContain('租约已失效');
  });
  it('rejects a mismatched owner and returns at most fifty small rows without foreign grants', () => {
    expect(() => project(context({ companionId: 'bob' }))).toThrow('不属于当前伙伴');
    const sleep = context({ learning: Array.from({ length: 47 }, (_, index) => ({ grant: grant({ id: 'grant_' + index }), manualPending: false })), learningHasMore: true });
    const plan = project(sleep); expect(plan.items).toHaveLength(50); expect(plan.hasMore).toBe(true);
    sleep.learning = [{ grant: grant({ companionId: 'bob', libraryName: '别人的私密书架' }), manualPending: true }];
    expect(JSON.stringify(project(sleep))).not.toContain('别人的私密书架');
    expect(JSON.stringify(plan)).not.toContain('D:/资料');
  });
  it('uses the global connection only for learning and the actual companion connection for journals and sleep', () => {
    const sleep = context({ learning: [{ grant: grant(), manualPending: true }], hasUnconsolidated: true });
    const dedicated = projectCompanionMemoryLifePlan({ companion: { id: 'alice', name: '小肥鱼' }, sleep, chatModelConfigured: false, companionChatModelConfigured: true });
    expect(dedicated.items.find(item => item.kind === 'learning')).toMatchObject({ state: 'waiting' });
    expect(dedicated.items.find(item => item.kind === 'learning')?.reason).toContain('全局聊天模型');
    expect(dedicated.items.find(item => item.kind === 'journal')?.reason).not.toContain('尚未配置');
    expect(dedicated.items.find(item => item.kind === 'sleep_consolidation')?.state).toBe('scheduled');
    const missing = projectCompanionMemoryLifePlan({ companion: { id: 'alice', name: '小肥鱼' }, sleep, chatModelConfigured: true, companionChatModelConfigured: false });
    expect(missing.items.find(item => item.kind === 'learning')?.state).toBe('eligible');
    expect(missing.items.find(item => item.kind === 'journal')).toMatchObject({ state: 'waiting' });
    expect(missing.items.find(item => item.kind === 'journal')?.reason).toContain('此伙伴可用的聊天模型');
  });
});
