import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionJobDisposition, CompanionJobKind, CompanionJobPage } from '../../src/shared/companion-job-control';
import { companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { releaseHeldMemoryFilePublications } from '../../src/main/companions/memory-publication-jobs';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-28T12:00:00Z'); });
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.useRealTimers(); });
const page = (f: ReturnType<typeof fixture>, kind: CompanionJobKind, states?: CompanionJobDisposition['state'][]) => f.store.request({ type: 'jobs.page', ownerId: 'alice', kind, states, limit: 50 }).jobPage!;
const inspect = (f: ReturnType<typeof fixture>, kind: CompanionJobKind, id: string) => f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind, id }).jobDisposition!;
const control = (f: ReturnType<typeof fixture>, current: CompanionJobDisposition, action: 'park' | 'resume' | 'abandon') => {
  const command = { type: 'jobs.control' as const, ownerId: current.ownerId, kind: current.kind, id: current.id, inputVersion: current.inputVersion,
    expectedRevision: current.revision, operationId: randomUUID(), action };
  return { command, result: f.store.request(command).jobDisposition! };
};

it.each(['source_files', 'history_files'] as const)('parks a real corrupt %s target after three failures while fifty new independent files publish and original bytes remain', async kind => {
  const f = fixture(), raw = f.source('POISON_ORIGINAL_EVENT_MUST_REMAIN'), note = f.record('原事件的正式知识或经历正文。', [raw.id]);
  let target: string;
  if (kind === 'source_files') target = f.file(companionMemorySourceFilePath({ sourceId: raw.id, sourceRevision: note.sources[0]!.revision, sourceChecksum: note.sources[0]!.checksum }));
  else {
    await f.sources.flush('alice');
    const job = f.store.request({ type: 'memory.history.outbox.claim', companionId: 'alice' }).memoryHistoryOutbox!; target = f.file(job.relativePath);
    f.store.request({ type: 'memory.history.outbox.fail', id: job.id, leaseToken: job.leaseToken, error: 'Fixture inspection before filesystem conflict.', failureKind: 'waiting', retryAfterMs: 1000 });
    vi.setSystemTime(Date.now() + 1001);
  }
  mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'UNKNOWN_EXTERNAL_BYTES_MUST_NOT_BE_OVERWRITTEN');
  const healthy = Array.from({ length: 50 }, (_, index) => f.record('后续独立真实事件 ' + index));
  if (kind === 'history_files') await f.sources.flush('alice');
  const flush = () => kind === 'source_files' ? f.sources.flush('alice') : f.history.flush('alice');
  expect(await flush()).toMatchObject({ failed: 1, completed: 50 });
  vi.setSystemTime(Date.now() + 30_001); expect(await flush()).toMatchObject({ failed: 1, completed: 0 });
  vi.setSystemTime(Date.now() + 30_001); expect(await flush()).toMatchObject({ failed: 1, completed: 0 });
  const held = page(f, kind, ['parked']).items[0]!;
  expect(held).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3 });
  const before = inspect(f, kind, held.id); f.restart(); expect(inspect(f, kind, held.id)).toEqual(before);
  vi.setSystemTime(Date.now() + 3_600_000); expect(await flush()).toMatchObject({ failed: 0, completed: 0 });
  expect(readFileSync(target, 'utf8')).toBe('UNKNOWN_EXTERNAL_BYTES_MUST_NOT_BE_OVERWRITTEN'); expect(f.store.getMessage(raw.id).content).toBe(raw.content);
  let afterId: string | undefined; const done: string[] = [];
  for (;;) {
    const result: CompanionJobPage = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind, states: ['completed'], afterId, limit: 50 }).jobPage!;
    done.push(...result.items.map(item => item.id)); if (!result.hasMore) break; afterId = result.nextId;
  }
  expect(done).toHaveLength(50);
  if (kind === 'history_files') expect((await f.history.read(f.scope, healthy.at(-1)!.id, 1)).content).toBe(healthy.at(-1)!.content);
  else expect(await f.sources.read(f.scope, healthy.at(-1)!.sources[0]!)).toBe(f.store.getMessage(healthy.at(-1)!.sources[0]!.messageId).content);
}, 120_000);

it.each(['source_files', 'history_files'] as const)('releases an interrupted %s Registry package after durable parking, publishes later real files, then explicitly resumes the same original input', async kind => {
  const f = fixture(), poison = f.record('中断的原始版本仍须完整保留，等待明确恢复。');
  if (kind === 'history_files') await f.sources.flush('alice');
  const initial = page(f, kind, ['pending']).items[0]!;
  const prefix = kind === 'source_files' ? 'source' : 'history', operationId = `${prefix}-file:${initial.id}:cycle:0`;
  f.intercept(command => {
    if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'file_published')
      throw new Error('Simulated interruption after exact file bytes were published.');
  });
  const flush = () => kind === 'source_files' ? f.sources.flush('alice') : f.history.flush('alice');
  expect(await flush()).toMatchObject({ completed: 0, failed: 1 });
  const registry = await f.artifacts('alice'); expect((await registry.pendingPublications()).map(item => item.operationId)).toContain(operationId);
  const good = f.record('同一伙伴后续独立的新资料不得被坏项永久挡住。');
  if (kind === 'history_files') {
    // The later source has a disjoint reserved footprint and can publish
    // while the original fixed history package retains its failed attempt.
    expect(await f.sources.flush('alice')).toMatchObject({ completed: 1, waiting: 0, failed: 0 });
  }
  for (let count = 0; count < 2; count++) { vi.setSystemTime(Date.now() + 30_001); expect(await flush()).toMatchObject({ failed: 1 }); }
  const held = inspect(f, kind, initial.id);
  expect(held).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3, retryCycle: 0, inputVersion: initial.inputVersion });
  expect((await registry.publication(operationId))?.state).toBe('cancelled'); expect(await registry.pendingPublications()).toHaveLength(0);
  f.intercept(); vi.setSystemTime(Date.now() + 30_001); await f.sources.flush('alice'); await f.history.flush('alice');
  expect((await f.history.read(f.scope, good.id, 1)).content).toBe(good.content);
  expect(await f.sources.read(f.scope, good.sources[0]!)).toBe(f.store.getMessage(good.sources[0]!.messageId).content);
  expect(inspect(f, kind, initial.id)).toMatchObject({ state: 'parked', failureCount: 3 });
  const resumed = control(f, inspect(f, kind, initial.id), 'resume');
  expect(resumed.result).toMatchObject({ retryCycle: 1, inputVersion: initial.inputVersion, failureCount: 3, cycleFailureCount: 0 });
  expect(f.store.request(resumed.command).jobDisposition).toEqual(resumed.result);
  await f.sources.flush('alice'); vi.setSystemTime(Date.now() + 30_001); await f.history.flush('alice');
  expect(inspect(f, kind, initial.id)).toMatchObject({ state: 'completed', retryCycle: 1, failureCount: 3 });
  expect((await registry.publication(operationId))?.state).toBe('cancelled');
  expect((await registry.publication(`${prefix}-file:${initial.id}:cycle:1`))?.state).toBe('committed');
  expect((await f.history.read(f.scope, poison.id, 1)).content).toBe(poison.content);
  expect(f.store.getMessage(poison.sources[0]!.messageId).content).toContain('中断的原始版本');
}, 120_000);

it.each(['source_files', 'history_files'] as const)('keeps an independent ready %s file at zero failures while an earlier package is still inside its automatic failure cycle', async kind => {
  const f = fixture(), poison = f.record('前序真正发布故障的原事件。'), healthy = f.record('在前序仅失败一次时即可等待，不能替它累计失败。');
  if (kind === 'history_files') await f.sources.flush('alice');
  const jobs = page(f, kind, ['pending']).items, bad = jobs.find(item => kind === 'source_files' ? item.sourceMessageId === poison.sources[0]!.messageId : item.memoryId === poison.id)!;
  const good = jobs.find(item => item.id !== bad.id)!, operationId = `${kind === 'source_files' ? 'source' : 'history'}-file:${bad.id}:cycle:0`;
  f.intercept(command => { if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'file_published') throw new Error('Actual fixed bad publication I/O failure.'); });
  const flush = (limit?: number) => kind === 'source_files' ? f.sources.flush('alice', { limit }) : f.history.flush('alice', { limit });
  expect(await flush(1)).toMatchObject({ failed: 1, completed: 0 });
  expect(await flush()).toMatchObject({ waiting: 0, failed: 0, completed: 1 });
  expect(inspect(f, kind, good.id)).toMatchObject({ state: 'completed', failureCount: 0, cycleFailureCount: 0 });
  if (kind === 'source_files') expect(await f.sources.read(f.scope, healthy.sources[0]!)).toBe(f.store.getMessage(healthy.sources[0]!.messageId).content);
  else expect((await f.history.read(f.scope, healthy.id, 1)).content).toBe(healthy.content);
  vi.setSystemTime(Date.now() + 30_001); expect(await flush()).toMatchObject({ failed: 1, waiting: 0, completed: 0 });
  expect(inspect(f, kind, bad.id)).toMatchObject({ state: 'failed', failureCount: 2 });
  expect(inspect(f, kind, good.id)).toMatchObject({ state: 'completed', failureCount: 0, cycleFailureCount: 0 });
  vi.setSystemTime(Date.now() + 30_001); expect(await flush()).toMatchObject({ failed: 1, completed: 0 });
  expect(inspect(f, kind, bad.id)).toMatchObject({ state: 'parked', failureCount: 3 });
  expect(inspect(f, kind, good.id)).toMatchObject({ state: 'completed', failureCount: 0, cycleFailureCount: 0 });
  f.intercept(); await f.history.flush('alice'); expect((await f.history.read(f.scope, healthy.id, 1)).content).toBe(healthy.content);
  expect(f.store.getMessage(poison.sources[0]!.messageId).content).toContain('前序真正发布故障');
});

it.each(['source_files', 'history_files'] as const)('keeps a conflicting %s publication terminal and uses a fresh explicit cycle only after the external bytes are deliberately removed', async kind => {
  const f = fixture(), note = f.record('外改冲突不准自动覆盖，显式修复后恢复同一输入。');
  if (kind === 'history_files') await f.sources.flush('alice');
  const job = kind === 'source_files' ? f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox!
    : f.store.request({ type: 'memory.history.outbox.claim', companionId: 'alice' }).memoryHistoryOutbox!;
  const target = f.file('sourceId' in job ? companionMemorySourceFilePath(job) : job.relativePath);
  mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'UNKNOWN_CONFLICT_BYTES');
  if (kind === 'source_files') f.store.request({ type: 'memory.sources.outbox.fail', id: job.id, leaseToken: job.leaseToken, failureKind: 'waiting', error: 'Fixture setup.', retryAfterMs: 1000 });
  else f.store.request({ type: 'memory.history.outbox.fail', id: job.id, leaseToken: job.leaseToken, failureKind: 'waiting', error: 'Fixture setup.', retryAfterMs: 1000 });
  vi.setSystemTime(Date.now() + 1001);
  const flush = () => kind === 'source_files' ? f.sources.flush('alice') : f.history.flush('alice');
  for (let count = 0; count < 3; count++) { expect(await flush()).toMatchObject({ failed: 1 }); vi.setSystemTime(Date.now() + 30_001); }
  expect(readFileSync(target, 'utf8')).toBe('UNKNOWN_CONFLICT_BYTES');
  const registry = await f.artifacts('alice'), prefix = kind === 'source_files' ? 'source' : 'history';
  expect((await registry.publication(`${prefix}-file:${job.id}:cycle:0`))?.state).toBe('conflict');
  // This is the operator's deliberate isolated-fixture repair, never publisher
  // cleanup: the publisher itself must preserve these unknown external bytes.
  unlinkSync(target); control(f, inspect(f, kind, job.id), 'resume');
  await f.sources.flush('alice'); await f.history.flush('alice');
  expect((await f.history.read(f.scope, note.id, 1)).content).toBe(note.content);
  expect((await registry.publication(`${prefix}-file:${job.id}:cycle:0`))?.state).toBe('conflict');
  expect((await registry.publication(`${prefix}-file:${job.id}:cycle:0`))?.stagesCleanedAt).toBeDefined();
  expect(inspect(f, kind, job.id)).toMatchObject({ state: 'completed', retryCycle: 1, failureCount: 3 });
}, 120_000);

it.each(['automatic', 'explicit'] as const)('recovers an interrupted update of an existing current body through its exact %s cycle without unnecessary committed revisions', async mode => {
  const f = fixture(), raw = f.source('仍有权读取的准确真实依据。'), first = f.record('原来正式提交的正文。', [raw.id]); await f.publish();
  const registry = await f.artifacts('alice'), original = (await registry.get(`memory:${first.id}`))!;
  const next = f.store.request({ type: 'memory.revise', ...f.scope, id: first.id, expectedVersion: first.version, candidate: f.candidate('系统新修订的正式正文。', [raw.id]) }).memories![0]!;
  const job = page(f, 'history_files', ['pending']).items.find(item => item.contentRevision === 2)!, operationId = `memory-file:${job.id}:cycle:0`;
  f.intercept(command => { if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'file_published') throw new Error('Interrupted current-body replacement.'); });
  expect(await f.history.flush('alice')).toMatchObject({ failed: 1, completed: 0 }); expect(readFileSync(f.noteFile(first), 'utf8')).toBe(next.content);
  if (mode === 'explicit') {
    for (let count = 0; count < 2; count++) { vi.setSystemTime(Date.now() + 30_001); expect(await f.history.flush('alice')).toMatchObject({ failed: 1 }); }
    expect(inspect(f, 'history_files', job.id).state).toBe('parked');
    expect(readFileSync(f.noteFile(first), 'utf8')).toBe(first.content);
    expect((await registry.get(`memory:${first.id}`))?.contentRevision).toBe(original.contentRevision);
    expect((await registry.publication(operationId))?.state).toBe('cancelled');
    const healthy = f.record('坏项搁置后仍能落盘的新事件。'); f.intercept(); await f.publish(); expect((await f.history.read(f.scope, healthy.id, 1)).content).toBe(healthy.content);
    control(f, inspect(f, 'history_files', job.id), 'resume');
  } else vi.setSystemTime(Date.now() + 30_001);
  f.intercept(); await f.history.flush('alice');
  expect((await f.history.read(f.scope, first.id, 2)).content).toBe(next.content); expect((await f.live.materialize('alice', [next])).notes[0]!.content).toBe(next.content);
  const committed = (await registry.get(`memory:${first.id}`))!; expect(committed.contentRevision).toBe(original.contentRevision + 1);
  // Replaying the already committed exact body consumes no new Registry
  // revision even through a new host projection call.
  await f.library.withDocuments('alice', session => session.project(committed.relativePath, next));
  expect(await registry.get(`memory:${first.id}`)).toEqual(committed);
});

it('never leaves a restored previous body when its real source is withdrawn during the cancellation I/O window', async () => {
  const f = fixture(), raw = f.source('敏感旧来源，在恢复过程中被撤回。'), first = f.record('旧私密正式正文。', [raw.id]); await f.publish();
  f.store.request({ type: 'memory.revise', ...f.scope, id: first.id, expectedVersion: first.version, candidate: f.candidate('尚未提交的新私密正文。', [raw.id]) });
  const job = page(f, 'history_files', ['pending']).items.find(item => item.contentRevision === 2)!, operationId = `memory-file:${job.id}:cycle:0`;
  f.intercept(command => { if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'file_published') throw new Error('Interrupted update.'); });
  await f.history.flush('alice'); control(f, inspect(f, 'history_files', job.id), 'park');
  let lifecycleReads = 0;
  f.intercept(command => {
    if (command.type === 'memory.lifecycle.state' && ++lifecycleReads === 5) f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [raw.id] });
  });
  const failures: unknown[] = []; await f.library.withDocuments('alice', session => releaseHeldMemoryFilePublications(session, cause => failures.push(cause)));
  expect(lifecycleReads).toBeGreaterThanOrEqual(5); expect(failures.length).toBeGreaterThan(0); expect(existsSync(f.noteFile(first))).toBe(false);
  const registry = await f.artifacts('alice'); await expect(registry.read({ artifactId: `memory:${first.id}`, consumer: 'audit' })).rejects.toThrow();
  expect(f.store.getMessage(raw.id).content).toBe(raw.content);
});

it.each(['source', 'history', 'memory'] as const)('rejects a late %s SQL commit after the final Main check, explicit park and resume, then permits the fresh exact lease', async prefix => {
  const f = fixture(), note = f.record('最后宿主检查之后也不能借新租约提交旧结果。');
  if (prefix !== 'source') await f.sources.flush('alice');
  const kind = prefix === 'source' ? 'source_files' : 'history_files', job = page(f, kind, ['pending']).items[0]!;
  const operationId = `${prefix}-file:${job.id}:cycle:0`;
  let intercepted = false;
  f.intercept(command => {
    if (command.type !== 'cognition.registry.publication.commit' || command.operationId !== operationId || intercepted) return;
    intercepted = true;
    expect(command.fileJobGuard).toMatchObject({ id: job.id, retryCycle: 0 });
    const parked = control(f, inspect(f, kind, job.id), 'park').result;
    control(f, parked, 'resume');
    // The real original RPC continues below with its old token. Its failure
    // must come from the worker transaction, not another Main preflight.
  });
  await (prefix === 'source' ? f.sources.flush('alice', { limit: 1 }) : f.history.flush('alice', { limit: 1 }));
  expect(intercepted).toBe(true);
  const registry = await f.artifacts('alice');
  expect((await registry.publication(operationId))?.state).not.toBe('committed');
  expect(inspect(f, kind, job.id)).toMatchObject({ state: 'pending', retryCycle: 1, failureCount: 0 });
  f.intercept(); await f.sources.flush('alice'); await f.history.flush('alice');
  expect((await f.history.read(f.scope, note.id, 1)).content).toBe(note.content);
  expect((await registry.publication(operationId))?.state).toBe('cancelled');
  expect(inspect(f, kind, job.id)).toMatchObject({ state: 'completed', retryCycle: 1, failureCount: 0 });
});

it('rejects an old token after same-cycle lease takeover and refuses an old cancellation of the new active claim', async () => {
  const f = fixture(), note = f.record('同周期租约接管不能借给旧调用。'), job = page(f, 'source_files', ['pending']).items[0]!;
  const operationId = `source-file:${job.id}:cycle:0`;
  let fresh: ReturnType<typeof f.store.request>['memorySourceOutbox'];
  f.intercept(command => {
    if (command.type !== 'cognition.registry.publication.commit' || command.operationId !== operationId || fresh) return;
    vi.setSystemTime(Date.now() + 120_001);
    fresh = f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox!;
    expect(fresh.leaseToken).not.toBe(command.fileJobGuard?.leaseToken);
    const previous = f.store.request({ type: 'cognition.registry.publication.read', ownerId: 'alice', operationId }).registryPublication!;
    expect(() => f.store.request({ type: 'cognition.registry.publication.transition', ownerId: 'alice', operationId, expectedState: previous.state, nextState: 'cancelled' })).toThrow();
  });
  await f.sources.flush('alice', { limit: 1 }); expect(fresh).toBeDefined();
  const registry = await f.artifacts('alice'); expect((await registry.publication(operationId))?.state).not.toBe('committed');
  f.intercept(); await registry.recover(operationId, async () => {
    expect(f.store.request({ type: 'memory.sources.outbox.check', id: fresh!.id, leaseToken: fresh!.leaseToken }).memorySourceOutboxAccepted).toBe(true);
  }, { kind: 'source_files', id: fresh!.id, leaseToken: fresh!.leaseToken, retryCycle: fresh!.retryCycle });
  expect(f.store.request({ type: 'memory.sources.outbox.complete', id: fresh!.id, leaseToken: fresh!.leaseToken }).memorySourceOutboxAccepted).toBe(true);
  await f.history.flush('alice'); expect((await f.history.read(f.scope, note.id, 1)).content).toBe(note.content);
});

it('keeps unpublished upstream sources waiting without processing failures and allows a later independent ready history to publish', async () => {
  const f = fixture(), first = f.record('等待准确上游来源的版本。'), second = f.record('另一个来源已准备好的独立版本。');
  const source = f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox!;
  f.store.request({ type: 'memory.sources.outbox.fail', id: source.id, leaseToken: source.leaseToken, error: 'Upstream publication has not run yet.', failureKind: 'waiting', retryAfterMs: 60_000 });
  expect(await f.sources.flush('alice')).toMatchObject({ completed: 1 });
  expect(await f.history.flush('alice')).toMatchObject({ waiting: 1, failed: 0, completed: 1 });
  expect((await f.history.read(f.scope, second.id, 1)).content).toBe(second.content);
  const pending = page(f, 'history_files', ['pending']).items.find(item => item.memoryId === first.id)!;
  expect(pending).toMatchObject({ failureCount: 0, cycleFailureCount: 0, memoryId: first.id, contentRevision: 1 });
  vi.setSystemTime(Date.now() + 30_001); expect(await f.history.flush('alice')).toMatchObject({ waiting: 1, failed: 0 });
  expect(inspect(f, 'history_files', pending.id)).toMatchObject({ failureCount: 0, cycleFailureCount: 0 });
  vi.setSystemTime(Date.now() + 30_001); await f.sources.flush('alice'); await f.history.flush('alice');
  expect((await f.history.read(f.scope, first.id, 1)).content).toBe(first.content);
});

it.each(['source_files', 'history_files'] as const)('fences a late %s lease through explicit park, resume, receipt replay and abandonment without deleting the raw event', async kind => {
  const f = fixture(), note = f.record('被明确搁置和放弃的出版仍保留原事件。');
  const job = kind === 'source_files' ? f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice' }).memorySourceOutbox!
    : f.store.request({ type: 'memory.history.outbox.claim', companionId: 'alice' }).memoryHistoryOutbox!;
  const parked = control(f, inspect(f, kind, job.id), 'park'); expect(f.store.request(parked.command).jobDisposition).toEqual(parked.result);
  if (kind === 'source_files') {
    expect(f.store.request({ type: 'memory.sources.outbox.check', id: job.id, leaseToken: job.leaseToken }).memorySourceOutboxAccepted).toBe(false);
    f.store.request({ type: 'memory.sources.outbox.fail', id: job.id, leaseToken: job.leaseToken, error: 'Late failure must not count.' });
  } else {
    expect(f.store.request({ type: 'memory.history.outbox.check', id: job.id, leaseToken: job.leaseToken }).memoryHistoryOutboxAccepted).toBe(false);
    f.store.request({ type: 'memory.history.outbox.fail', id: job.id, leaseToken: job.leaseToken, error: 'Late failure must not count.' });
  }
  expect(inspect(f, kind, job.id)).toEqual(parked.result);
  const resumed = control(f, parked.result, 'resume').result; expect(resumed).toMatchObject({ state: 'pending', failureCount: 0 });
  const abandoned = control(f, resumed, 'abandon').result; expect(abandoned.state).toBe('abandoned');
  expect(() => control(f, abandoned, 'resume')).toThrow('终结');
  expect(f.store.getMessage(note.sources[0]!.messageId).content).toContain('原始依据');
});
