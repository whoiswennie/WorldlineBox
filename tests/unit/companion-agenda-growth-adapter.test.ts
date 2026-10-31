import { expect, it, vi } from 'vitest';
import { companionAgendaClaimSchema, companionAgendaGoalSchema } from '../../src/shared/companion-agenda';
import { executeAgendaGrowth } from '../../src/main/companions/agenda-growth';
import type { CompanionGrowthService } from '../../src/main/companions/growth-service';
import type { CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionAgendaPersonaGoalDefinitionHash } from '../../src/main/companions/agenda-persona-goals';

const at = '2026-10-29T10:00:00.000Z';
const original = { kind: 'growth' as const, id: 'a'.repeat(64), inputVersion: 'b'.repeat(64), revision: 4, stage: '已保存前一批真实依据' };
function fixture() {
  const claim = companionAgendaClaimSchema.parse({ rule: { id: 'rule', companionId: 'alice', revision: 1, title: '回顾认识变化', intent: '核验本人实际依据', kind: 'growth', executor: 'growth',
    reason: '有正式自我认识', origin: 'system', status: 'active', createdAt: at, updatedAt: at, trigger: { kind: 'event', topic: 'growth.pending' } },
  occurrence: { id: 'occ', companionId: 'alice', ruleId: 'rule', ruleRevision: 1, scheduledAt: at, lastEvaluatedAt: at, state: 'running', reason: '真实来源' },
  run: { id: 'run', companionId: 'alice', ruleId: 'rule', occurrenceId: 'occ', revision: 3, status: 'running', stage: '继续原处理', createdAt: at, updatedAt: at, notBefore: at,
    failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 2, leaseToken: 'lease', checkpoint: JSON.stringify({ nativeJobs: [original] }) }, leaseToken: 'lease' });
  const context: CompanionAgendaExecutionContext = { checkpoint: vi.fn(async () => undefined), effect: vi.fn(), effectId: vi.fn(), bindGrant: vi.fn() };
  const runAgendaQuantum = vi.fn<CompanionGrowthService['runAgendaQuantum']>();
  const wake = vi.fn(), request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>().mockResolvedValue({ ok: true });
  return { claim, context, runAgendaQuantum, wake, request, growth: { runAgendaQuantum, wake } as unknown as CompanionGrowthService };
}

it('retains earlier fixed growth stages across waiting and resume while recording the latest real native revision', async () => {
  const f = fixture(), next = { kind: 'growth' as const, id: 'c'.repeat(64), inputVersion: 'd'.repeat(64), revision: 1 };
  f.runAgendaQuantum.mockImplementation(async (owner, _signal, progress) => {
    await progress?.('正在核验下一批'); await progress?.('下一批输入已固定', next);
    await progress?.('下一批已经发布', { ...next, revision: 4 });
    return { outcome: 'published', companionId: owner, reason: '真实发布', hasMore: true, nativeJob: { ...next, revision: 4 } };
  });
  const result = await executeAgendaGrowth(f.claim, f.context, new AbortController().signal, { growth: f.growth, request: f.request });
  expect(result.outcome).toBe('waiting'); expect(JSON.parse(result.result!)).toMatchObject({ jobId: next.id, nativeJobCount: 2 }); expect(JSON.parse(result.result!).nativeJobs).toBeUndefined();
  expect(vi.mocked(f.context.checkpoint).mock.calls.at(-1)?.[1]).toMatchObject({ nativeJobs: [original, { ...next, revision: 4, stage: '真实发布' }] });
  for (const [, value] of vi.mocked(f.context.checkpoint).mock.calls) expect((value as { nativeJobs: unknown[] }).nativeJobs).toContainEqual(original);
});

it('does not replace the original native identity with a changed input or rewound revision', async () => {
  const f = fixture();
  f.runAgendaQuantum.mockImplementation(async (_owner, _signal, progress) => {
    await progress?.('试图覆盖旧输入', { ...original, inputVersion: 'e'.repeat(64) }); throw new Error('must not dispatch');
  });
  await expect(executeAgendaGrowth(f.claim, f.context, new AbortController().signal, { growth: f.growth, request: f.request })).rejects.toThrow('准确输入');
  expect(f.context.checkpoint).not.toHaveBeenCalled();
});

function persistedDirection() {
  const f = fixture();
  const goal = companionAgendaGoalSchema.parse({ id: 'actual_goal', companionId: 'alice', revision: 1, origin: 'user', domain: 'persona', status: 'active', title: '有条件地表达',
    intent: '在真实机会里练习，不要求改变人格。', successCriteria: ['保留自己的判断'], conversationId: 'actual_private_port', createdAt: at, updatedAt: at });
  f.claim.occurrence.input = JSON.stringify({ kind: 'persona-direction-changed-v1', companionId: 'alice', conversationId: goal.conversationId, goalId: goal.id,
    definitionHash: companionAgendaPersonaGoalDefinitionHash(goal) });
  f.request.mockResolvedValue({ ok: true, agendaGoal: goal });
  f.runAgendaQuantum.mockResolvedValue({ outcome: 'no_change', companionId: 'alice', reason: '没有新的有据变化。', hasMore: false });
  return { ...f, goal };
}

it('restores a persisted direction source port after restart only after checking the actual current goal', async () => {
  const f = persistedDirection();
  await executeAgendaGrowth(f.claim, f.context, new AbortController().signal, { growth: f.growth, request: f.request });
  expect(f.request).toHaveBeenCalledWith({ type: 'agenda.goal.read', companionId: 'alice', id: f.goal.id });
  expect(f.wake).toHaveBeenCalledWith({ companionId: 'alice', conversationId: 'actual_private_port' });
  expect(f.wake.mock.invocationCallOrder[0]!).toBeLessThan(f.runAgendaQuantum.mock.invocationCallOrder[0]!);
});

it.each(['definition', 'port', 'missing'] as const)('does not wake stale %s direction events but still processes ordinary real source debt', async change => {
  const f = persistedDirection();
  if (change === 'definition') f.request.mockResolvedValue({ ok: true, agendaGoal: { ...f.goal, intent: '已经修改的未来方向。', revision: 2 } });
  else if (change === 'port') f.request.mockResolvedValue({ ok: true, agendaGoal: { ...f.goal, conversationId: 'other_actual_port', revision: 2 } });
  else f.request.mockResolvedValue({ ok: false, error: '原目标已经不可读取。' });
  expect((await executeAgendaGrowth(f.claim, f.context, new AbortController().signal, { growth: f.growth, request: f.request })).outcome).toBe('silent');
  expect(f.wake).not.toHaveBeenCalled(); expect(f.runAgendaQuantum).toHaveBeenCalledTimes(1);
});

it('rejects a foreign-owner or malformed typed direction event without guessing a source conversation', async () => {
  const f = persistedDirection();
  f.claim.occurrence.input = JSON.stringify({ kind: 'persona-direction-changed-v1', companionId: 'bob', conversationId: 'bob_private', goalId: f.goal.id, definitionHash: companionAgendaPersonaGoalDefinitionHash(f.goal) });
  await expect(executeAgendaGrowth(f.claim, f.context, new AbortController().signal, { growth: f.growth, request: f.request })).rejects.toThrow('不属于本次伙伴');
  f.claim.occurrence.input = '{"kind":"persona-direction-changed-v1"';
  await expect(executeAgendaGrowth(f.claim, f.context, new AbortController().signal, { growth: f.growth, request: f.request })).rejects.toThrow('来源端口记录无效');
  expect(f.wake).not.toHaveBeenCalled(); expect(f.runAgendaQuantum).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});
