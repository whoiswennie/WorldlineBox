import { expect, it, vi } from 'vitest';
import { initializeCompanionAgenda, COMPANION_AGENDA_SELF_WAKE_REFERENCE, COMPANION_AGENDA_MEMORY_REFERENCE } from '../../src/main/companions/agenda-bootstrap';
import type { CompanionAgendaCommand, CompanionAgendaResponse, CompanionAgendaRule } from '../../src/shared/companion-agenda';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';

const at = '2026-10-29T01:00:00.000Z';
function fixture() {
  const rules: CompanionAgendaRule[] = [];
  const request = vi.fn(async (command: CompanionAgendaCommand): Promise<CompanionAgendaResponse> => {
    if (command.type === 'agenda.read') return { ok: true, agenda: { companionId: 'alice', rules, occurrences: [], runs: [], goals: [], grants: [], hasMore: false, observedAt: at, revision: 0 } };
    if (command.type === 'agenda.rule.create') {
      const rule = { ...command.rule, category: (['memory', 'growth', 'world', 'reflection'].includes(command.rule.executor) ? 'event' : 'task') as 'event' | 'task',
        id: 'rule_' + rules.length, companionId: 'alice', revision: 1, origin: 'system' as const,
        status: 'active' as const, createdAt: at, updatedAt: at };
      rules.push(rule); return { ok: true, agendaRule: rule };
    }
    throw new Error('Unexpected bootstrap command: ' + command.type);
  });
  const options = { companion: { id: 'alice', createdAt: '2024-01-01T00:00:00.000Z' }, routine: { timeZone: 'Asia/Shanghai' }, request, now: new Date(at) };
  return { request, rules, options };
}

it('seeds a future self-wake and a protected real-source memory event without model or fake physical actions', async () => {
  const f = fixture(); expect((await initializeCompanionAgenda(f.options)).created).toBe(5);
  const wake = f.rules.find(rule => rule.referenceId === COMPANION_AGENDA_SELF_WAKE_REFERENCE)!;
  expect(wake).toMatchObject({ executor: 'brain', flexible: true, protected: false, trigger: { kind: 'interval', anchorAt: '2026-10-29T02:00:00.000Z', everyMinutes: 60, timeZone: 'Asia/Shanghai' } });
  expect(wake.conditions).toEqual(expect.arrayContaining([{ key: 'awake', equals: true, label: '本人当前清醒' }]));
  const memory = f.rules.find(rule => rule.referenceId === COMPANION_AGENDA_MEMORY_REFERENCE)!;
  expect(memory).toMatchObject({ executor: 'memory', protected: true, trigger: { kind: 'event', topic: 'experience.changed', quietSeconds: 60 } });
  expect(memory.conditions.some(condition => condition.key === 'awake')).toBe(false);
  expect(f.rules.map(rule => rule.executor)).toEqual(['brain', 'memory', 'growth', 'world', 'reflection']);
  expect(f.rules.find(rule => rule.executor === 'growth')).toMatchObject({ trigger: { kind: 'event', topic: 'growth.pending' } });
  expect(f.rules.find(rule => rule.executor === 'reflection')!.conditions).toContainEqual({ key: 'awake', equals: false, label: '本人实际处于睡眠' });
});

it('does not restore paused or retired rules when startup or creation initialization repeats', async () => {
  const f = fixture(); await initializeCompanionAgenda(f.options);
  f.rules[0]!.status = 'paused'; f.rules[1]!.status = 'retired';
  const result = await initializeCompanionAgenda({ ...f.options, now: new Date('2026-11-02T00:00:00.000Z'), routine: { timeZone: 'UTC' } });
  expect(result.created).toBe(0); expect(f.rules).toHaveLength(5);
  expect(result.rules.map(rule => rule.status)).toEqual(['paused', 'retired', 'active', 'active', 'active']);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'agenda.rule.create')).toHaveLength(5);
});

it('uses stable owner/reference operation identities and host-only system authority', async () => {
  const first = fixture(), second = fixture();
  await initializeCompanionAgenda(first.options); await initializeCompanionAgenda(second.options);
  const mutations = (f: ReturnType<typeof fixture>) => f.request.mock.calls.flatMap(([command]) => command.type === 'agenda.rule.create' ? [command] : []);
  expect(mutations(first).map(command => command.operationId)).toEqual(mutations(second).map(command => command.operationId));
  expect(new Set(mutations(first).map(command => command.operationId)).size).toBe(5);
  expect(mutations(first).every(command => command.authority.kind === 'system')).toBe(true);
});

it('reads every rule page before deciding a rule is missing', async () => {
  const f = fixture(); await initializeCompanionAgenda(f.options);
  const existing = [...f.rules], original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => {
    if (command.type !== 'agenda.read') return original(command);
    return { ok: true, agenda: { companionId: 'alice', rules: command.afterId ? existing : [], occurrences: [], runs: [], goals: [], grants: [],
      hasMore: !command.afterId, ...(command.afterId ? {} : { nextId: 'page_1' }), observedAt: at, revision: 1 } };
  });
  const before = f.request.mock.calls.length;
  expect((await initializeCompanionAgenda(f.options)).created).toBe(0);
  expect(f.request.mock.calls.slice(before).map(([command]) => command.type)).toEqual(['agenda.read', 'agenda.read']);
});

it('refuses an unreadable or wrong-owner rule list instead of inventing missing defaults', async () => {
  const f = fixture();
  f.request.mockResolvedValue({ ok: true });
  await expect(initializeCompanionAgenda(f.options)).rejects.toThrow('当前伙伴');
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('adds optional body rules and adopts them only after every seed has a real receipt', async () => {
  const f = fixture(), adoptRoutine = vi.fn(async (ids: string[]) => {
    expect(ids).toEqual(f.rules.filter(rule => rule.executor === 'routine').map(rule => rule.id));
    expect(f.rules).toHaveLength(8);
  });
  const routineConfig = companionRoutineConfigSchema.parse({ timeZone: 'Asia/Shanghai', meals: [{ name: '午餐', at: '12:00', durationMinutes: 30 }],
    habits: [{ id: 'reading', title: '阅读', at: '15:00', durationMinutes: 20, kind: 'study' }] });
  expect((await initializeCompanionAgenda({ ...f.options, routineConfig, adoptRoutine })).created).toBe(8);
  expect(adoptRoutine).toHaveBeenCalledTimes(1);
  const sleep = f.rules.find(rule => rule.referenceId === 'routine_sleep')!; sleep.status = 'paused';
  const firstIds = f.rules.map(rule => rule.id);
  expect((await initializeCompanionAgenda({ ...f.options, routineConfig, adoptRoutine, now: new Date('2026-11-01T00:00:00.000Z') })).created).toBe(0);
  expect(f.rules.map(rule => rule.id)).toEqual(firstIds); expect(sleep.status).toBe('paused');
  expect(adoptRoutine).toHaveBeenCalledTimes(2); // Native adoption itself is idempotent; no page read calls this initializer.
});

it('fills only the two missing infrastructure seeds when three existing rules have already been maintained', async () => {
  const f = fixture(); await initializeCompanionAgenda(f.options);
  const retained = f.rules.splice(0, 3); retained[0]!.status = 'paused'; retained[1]!.status = 'retired';
  f.rules.splice(0, f.rules.length, ...retained); f.request.mockClear();
  const result = await initializeCompanionAgenda({ ...f.options, now: new Date('2026-11-01T00:00:00.000Z') });
  expect(result.created).toBe(2); expect(result.rules.slice(0, 3)).toEqual(retained);
  expect(f.request.mock.calls.flatMap(([command]) => command.type === 'agenda.rule.create' ? [command.rule.referenceId] : [])).toEqual(['system_world_v1', 'system_dream_v1']);
});

it('does not adopt partial body initialization when one durable creation fails', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!, adoptRoutine = vi.fn(async () => undefined);
  f.request.mockImplementation(async command => command.type === 'agenda.rule.create' && command.rule.executor === 'routine'
    ? { ok: false, error: 'native durable seed failure' } : original(command));
  const routineConfig = companionRoutineConfigSchema.parse({ timeZone: 'Asia/Shanghai', meals: [], habits: [] });
  await expect(initializeCompanionAgenda({ ...f.options, routineConfig, adoptRoutine })).rejects.toThrow('durable seed failure');
  expect(adoptRoutine).not.toHaveBeenCalled(); expect(f.rules).toHaveLength(5);
});
