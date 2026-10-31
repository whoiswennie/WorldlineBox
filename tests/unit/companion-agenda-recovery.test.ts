import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pauseNativeAgendaChildren, restoreNativeAgendaChildren } from '../../src/main/companions/agenda-recovery';
import type { CompanionAgendaRun } from '../../src/shared/companion-agenda';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const at = '2026-10-29T02:00:00.000Z';
function fixture() {
  const jobs = new Map<string, CompanionJobDisposition>(['capture', 'tags', 'timeline'].map(kind => [kind + '_1', {
    kind: kind as CompanionJobDisposition['kind'], id: kind + '_1', ownerId: 'alice', inputVersion: kind[0]!.repeat(64).replace(/[^a-f0-9]/gu, 'a'),
    state: 'parked', revision: 3, failureCount: 7, cycleFailureCount: 3,
  }]));
  const run: CompanionAgendaRun = { id: 'run_1', companionId: 'alice', ruleId: 'rule_1', occurrenceId: 'occurrence_1', revision: 5,
    status: 'parked', stage: '子阶段已搁置', failureCount: 7, cycleFailureCount: 3, retryCycle: 1, attemptCount: 7,
    createdAt: at, updatedAt: at, notBefore: at, checkpoint: JSON.stringify({ nativeJobs: [...jobs.values()].map(job => ({ kind: job.kind, id: job.id, stage: '真实领取阶段' })) }) };
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'jobs.inspect') return { ok: true, jobDisposition: jobs.has(command.id) ? structuredClone(jobs.get(command.id)) : undefined };
    if (command.type === 'jobs.control') {
      const previous = jobs.get(command.id)!;
      if (previous.inputVersion !== command.inputVersion || previous.revision !== command.expectedRevision) return { ok: false, error: '版本已变化' };
      const next: CompanionJobDisposition = { ...previous, revision: previous.revision + 1,
        state: command.action === 'resume' ? 'pending' : command.action === 'park' ? 'parked' : 'abandoned',
        cycleFailureCount: command.action === 'resume' ? 0 : previous.cycleFailureCount };
      jobs.set(command.id, next); return { ok: true, jobDisposition: structuredClone(next) };
    }
    throw new Error('Recovery must not invoke a processor or create jobs');
  });
  return { run, jobs, request };
}
const controls = (f: ReturnType<typeof fixture>) => f.request.mock.calls.flatMap(([command]) => command.type === 'jobs.control' ? [command] : []);

it('restores only actual held native IDs with exact versions and stable operation UUIDs', async () => {
  const f = fixture(), other = fixture();
  const result = await restoreNativeAgendaChildren(f.run, 'parent_resume_1', f);
  await restoreNativeAgendaChildren(other.run, 'parent_resume_1', other);
  expect(result.canResume).toBe(true); expect(result.children.every(child => child.action === 'resumed')).toBe(true);
  expect(controls(f)).toHaveLength(3);
  expect(controls(f).map(command => command.operationId)).toEqual(controls(other).map(command => command.operationId));
  for (const command of controls(f)) {
    expect(z.uuid().safeParse(command.operationId).success).toBe(true);
    expect(command).toMatchObject({ ownerId: 'alice', expectedRevision: 3, action: 'resume' });
    expect(f.jobs.get(command.id)).toMatchObject({ state: 'pending', failureCount: 7, cycleFailureCount: 0 });
  }
  await restoreNativeAgendaChildren(f.run, 'parent_resume_1', f);
  expect(controls(f)).toHaveLength(3); // A retry of parent CAS does not restart ready children.
});

it('validates checkpointed immutable native input versions while using the current legitimate control revision', async () => {
  const f = fixture();
  f.run.checkpoint = JSON.stringify({ nativeJobs: [...f.jobs.values()].map(job => ({ kind: job.kind, id: job.id,
    inputVersion: job.inputVersion, revision: job.revision - 1, stage: '本批真实输入' })) });
  const result = await restoreNativeAgendaChildren(f.run, 'resume_original_versions', f);
  expect(result.canResume).toBe(true); expect(controls(f)).toHaveLength(3);
  expect(controls(f).every(command => command.expectedRevision === 3)).toBe(true);
});

it.each(['resume', 'hold'] as const)('refuses %s when a recorded native identity now represents different input bytes', async operation => {
  const f = fixture();
  f.run.checkpoint = JSON.stringify({ nativeJobs: [...f.jobs.values()].map(job => ({ kind: job.kind, id: job.id, inputVersion: job.inputVersion, revision: job.revision })) });
  f.jobs.get('tags_1')!.inputVersion = 'f'.repeat(64);
  if (operation === 'resume') await expect(restoreNativeAgendaChildren(f.run, 'reject_changed_input', f)).rejects.toThrow('输入');
  else await expect(pauseNativeAgendaChildren(f.run, 'reject_changed_input', { ...f, action: 'park' })).rejects.toThrow('输入');
  expect(controls(f)).toHaveLength(0); expect(f.jobs.get('capture_1')!.state).toBe('parked');
});

it.each(['abandoned', 'cancelled', 'stale', 'missing'] as const)('preflights all children and refuses to recreate a %s input', async state => {
  const f = fixture();
  if (state === 'missing') f.jobs.delete('tags_1'); else f.jobs.get('tags_1')!.state = state;
  const result = await restoreNativeAgendaChildren(f.run, 'resume_held', f);
  expect(result.canResume).toBe(false); expect(controls(f)).toHaveLength(0);
  expect(f.jobs.get('capture_1')).toMatchObject({ state: 'parked', failureCount: 7, cycleFailureCount: 3 });
});

it('keeps completed and already ready child receipts untouched', async () => {
  const f = fixture(); f.jobs.get('capture_1')!.state = 'completed'; f.jobs.get('tags_1')!.state = 'pending';
  const result = await restoreNativeAgendaChildren(f.run, 'resume_held', f);
  expect(result.canResume).toBe(true); expect(controls(f).map(command => command.id)).toEqual(['timeline_1']);
});

it('does not infer native work from prose when a checkpoint has no exact native references', async () => {
  const f = fixture(); f.run.checkpoint = JSON.stringify({ summary: '请恢复capture_1和tags_1', stage: '标签已搁置' });
  expect(await restoreNativeAgendaChildren(f.run, 'resume_held', f)).toEqual({ children: [], canResume: true });
  expect(f.request).not.toHaveBeenCalled();
});

it('rejects wrong owner, corrupted checkpoints and unknown parent outcomes before making control writes', async () => {
  const f = fixture(); f.jobs.get('tags_1')!.ownerId = 'bob';
  await expect(restoreNativeAgendaChildren(f.run, 'resume_held', f)).rejects.toThrow('不属于'); expect(controls(f)).toHaveLength(0);
  f.run.checkpoint = '{broken'; await expect(restoreNativeAgendaChildren(f.run, 'resume_held', f)).rejects.toThrow('不可读取');
  f.run.status = 'unknown'; await expect(restoreNativeAgendaChildren(f.run, 'resume_held', f)).rejects.toThrow('只有');
});

it('does not guess a new revision after a native CAS conflict', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => command.type === 'jobs.control' ? { ok: false, error: '真实输入已经变化' } : original(command));
  await expect(restoreNativeAgendaChildren(f.run, 'resume_held', f)).rejects.toThrow('真实输入');
  expect(controls(f)).toHaveLength(1);
});

it('parks active native children without resetting lifetime or current-cycle processing errors', async () => {
  const f = fixture(); f.jobs.get('capture_1')!.state = 'running'; f.jobs.get('tags_1')!.state = 'pending'; f.jobs.get('timeline_1')!.state = 'failed';
  const result = await pauseNativeAgendaChildren(f.run, 'parent_pause', { request: f.request, action: 'park' });
  expect(result.children.every(child => child.state === 'parked')).toBe(true);
  expect([...f.jobs.values()].every(child => child.failureCount === 7 && child.cycleFailureCount === 3)).toBe(true);
  await pauseNativeAgendaChildren(f.run, 'parent_pause', { request: f.request, action: 'park' }); expect(controls(f)).toHaveLength(3);
});

it('rechecks the actual cohort follower revision after holding its shared-lease leader', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.run.checkpoint = JSON.stringify({ nativeJobs: [{ kind: 'capture', id: 'capture_1' }, { kind: 'capture', id: 'capture_follower' }] });
  f.jobs.get('capture_1')!.state = 'running';
  f.jobs.set('capture_follower', { ...f.jobs.get('capture_1')!, id: 'capture_follower' });
  f.request.mockImplementation(async command => {
    const response = await original(command);
    if (command.type === 'jobs.control' && command.id === 'capture_1') {
      const follower = f.jobs.get('capture_follower')!; follower.state = 'pending'; follower.revision++;
    }
    return response;
  });
  const result = await pauseNativeAgendaChildren(f.run, 'pause_cohort', { request: f.request, action: 'park' });
  expect(result.children.every(child => child.state === 'parked')).toBe(true);
  expect(controls(f).find(command => command.id === 'capture_follower')!.expectedRevision).toBe(4);
});

it('abandons recorded children while leaving completed and withdrawn inputs intact', async () => {
  const f = fixture(); f.jobs.get('capture_1')!.state = 'completed'; f.jobs.get('tags_1')!.state = 'stale';
  const result = await pauseNativeAgendaChildren(f.run, 'parent_abandon', { request: f.request, action: 'abandon' });
  expect(controls(f).map(command => command.id)).toEqual(['timeline_1']); expect(result.canResume).toBe(false);
  expect((await restoreNativeAgendaChildren(f.run, 'must_not_restore', f)).canResume).toBe(false);
  expect(controls(f)).toHaveLength(1);
});

it('deduplicates exact child references and refuses an acknowledgement that erased failure history', async () => {
  const f = fixture(); f.run.checkpoint = JSON.stringify({ nativeJobs: [{ kind: 'tags', id: 'tags_1' }, { kind: 'tags', id: 'tags_1' }] });
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async command => {
    const result = await original(command);
    if (command.type === 'jobs.control' && result.jobDisposition) result.jobDisposition.failureCount = 0;
    return result;
  });
  await expect(restoreNativeAgendaChildren(f.run, 'resume_held', f)).rejects.toThrow('版本与状态');
  expect(controls(f)).toHaveLength(1);
});
