import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { CompanionMemoryFileReadiness } from '../../src/main/companions/memory-file-readiness';
import { CompanionMemoryFilesPending } from '../../src/main/companions/memory-files-pending';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  return { ...f, readiness: new CompanionMemoryFileReadiness({ request: f.request, library: f.library, sources: f.sources, history: f.history }) };
}
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('publishes only an exact revision and its real sources, leaving earlier unrelated work untouched', async () => {
  const f = fixture(), unrelated = f.record('无关的旧欠账，不能被本次准备领取。'), target = f.record('本次明确请求的准确修订。');
  const before = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'source_files', limit: 50 }).jobPage!.items
    .find(job => job.sourceMessageId === unrelated.sources[0]!.messageId)!;
  expect((await f.readiness.ensure(f.scope, target.id, target.contentRevision!)).content).toBe(target.content);
  expect((await f.history.read(f.scope, target.id, target.contentRevision!)).content).toBe(target.content);
  const after = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'source_files', id: before.id }).jobDisposition!;
  expect(after).toEqual(before); expect(after.attemptCount).toBe(0);
  const history = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'history_files', states: ['pending'], limit: 50 }).jobPage!.items;
  expect(history.some(job => job.memoryId === unrelated.id && job.attemptCount === 0)).toBe(true);
  expect(f.store.getMessage(unrelated.sources[0]!.messageId).content).toContain('无关的旧欠账');
});

it('reports a held exact publication as trusted waiting without claiming it or replacing the stored memory', async () => {
  const f = fixture(), note = f.record('明确搁置发布，原始资料与存储修订均须保留。'); await f.sources.flush('alice');
  const job = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'history_files', limit: 50 }).jobPage!.items[0]!;
  const held = f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'history_files', id: job.id, inputVersion: job.inputVersion,
    expectedRevision: job.revision, operationId: randomUUID(), action: 'park' }).jobDisposition!;
  await expect(f.readiness.ensure(f.scope, note.id, note.contentRevision!)).rejects.toMatchObject({ name: 'CompanionMemoryFilesPending', reason: 'files_pending' });
  expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'history_files', id: job.id }).jobDisposition).toEqual(held);
  expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories?.[0]).toMatchObject({ id: note.id, version: note.version, contentRevision: note.contentRevision });
});

it('does not queue an exact publisher behind an unrelated active owner writer', async () => {
  const f = fixture(), note = f.record('当前准确请求，不能加入无关writer尾部。'), entered = deferred(), release = deferred();
  const writer = f.library.withDocuments('alice', async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    await expect(f.readiness.ensure(f.scope, note.id, note.contentRevision!)).rejects.toBeInstanceOf(CompanionMemoryFilesPending);
    const jobs = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'source_files', limit: 50 }).jobPage!.items;
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ state: 'pending', attemptCount: 0, failureCount: 0 });
  } finally { release.resolve(); await writer; }
});

it('rejects changed committed bytes even if their final outbox acknowledgement is still pending', async () => {
  const f = fixture(), note = f.record('提交已完成但最终SQL确认被中断的真实资料。'); await f.sources.flush('alice');
  f.intercept(command => { if (command.type === 'memory.history.outbox.complete') throw new Error('Controlled interruption after formal Registry commit.'); });
  expect(await f.history.flush('alice')).toMatchObject({ failed: 1, completed: 0 }); f.intercept();
  const state = f.store.request({ type: 'memory.files.inspect', ...f.scope, id: note.id, contentRevision: note.contentRevision! }).memoryFileReadiness!;
  expect(state.state).toBe('pending');
  writeFileSync(f.noteFile(note), 'EXTERNAL_CHANGED_COMMITTED_BYTES');
  await expect(f.readiness.ensure(f.scope, note.id, note.contentRevision!)).rejects.not.toBeInstanceOf(CompanionMemoryFilesPending);
  expect(readFileSync(f.noteFile(note), 'utf8')).toBe('EXTERNAL_CHANGED_COMMITTED_BYTES');
  const job = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'history_files', id: state.historyJob!.id }).jobDisposition!;
  expect(job).toMatchObject({ state: 'failed', failureCount: 1, attemptCount: 1 });
});

it('does not disclose another owner revision through the metadata preparation port', async () => {
  const f = fixture(), note = f.record('Alice 的准确受权资料。');
  const bob = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
  expect(() => f.store.request({ type: 'memory.files.inspect', ...bob, id: note.id, contentRevision: note.contentRevision! })).toThrow();
  await expect(f.readiness.ensure(bob, note.id, note.contentRevision!)).rejects.toThrow();
  expect(f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'source_files', limit: 50 }).jobPage!.items[0]).toMatchObject({ state: 'pending', attemptCount: 0 });
});

it.each([
  { kind: 'source_files' as const, skipCycle: false }, { kind: 'source_files' as const, skipCycle: true },
  { kind: 'history_files' as const, skipCycle: false }, { kind: 'history_files' as const, skipCycle: true },
])('recovers only its exact old $kind cycle behind seventeen unrelated active packages (unused intermediate cycle $skipCycle)', async ({ kind, skipCycle }) => {
  const f = fixture(), note = f.record('明确恢复原有准确输入，不能被无关发布包的首页遮挡。');
  if (kind === 'history_files') await f.sources.flush('alice');
  const registry = await f.artifacts('alice');
  const pendingPublications = async () => {
    const result: Awaited<ReturnType<typeof registry.pendingPublications>> = []; let afterOperationId: string | undefined;
    for (;;) {
      const page = await registry.pendingPublications({ limit: 16, afterOperationId }); result.push(...page);
      if (page.length < 16) return result; afterOperationId = page.at(-1)!.operationId;
    }
  };
  f.intercept(command => {
    if (command.type === 'cognition.registry.publication.transition' && command.operationId.startsWith('aaa_unrelated_') && command.nextState === 'validated')
      throw new Error('Controlled unrelated active package after durable prepare.');
  });
  for (let index = 0; index < 17; index++) {
    const id = String(index).padStart(2, '0');
    await expect(registry.publish({ artifactId: `unrelated:${id}`, kind: 'runtime_index', producer: { kind: 'host', id: 'independent-background' },
      relativePath: `.运行/索引/unrelated-${id}.json`, expectedRevision: null, content: JSON.stringify({ unrelated: index }), sourceRefs: [], dependencyRefs: [],
      visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime', operationId: `aaa_unrelated_${id}` })).rejects.toThrow();
  }
  const unrelated = await pendingPublications(); expect(unrelated).toHaveLength(17);
  const current = () => f.store.request({ type: 'jobs.page', ownerId: 'alice', kind, limit: 50 }).jobPage!.items.find(job =>
    kind === 'source_files' ? job.sourceMessageId === note.sources[0]!.messageId : job.memoryId === note.id)!;
  const job = current(), prefix = kind === 'source_files' ? 'source' : 'history', oldOperation = `${prefix}-file:${job.id}:cycle:0`;
  f.intercept(command => {
    if (command.type === 'cognition.registry.publication.transition' && command.operationId === oldOperation && command.nextState === 'validated')
      throw new Error('Controlled exact package interruption after durable prepare.');
  });
  const flush = () => kind === 'source_files' ? f.sources.flush('alice', { jobId: job.id, limit: 1 }) : f.history.flush('alice', { memoryId: note.id, contentRevision: note.contentRevision, limit: 1 });
  expect(await flush()).toMatchObject({ failed: 1, completed: 0 }); f.intercept();
  expect((await registry.publication(oldOperation))?.state).toBe('prepared');
  expect((await registry.pendingPublications({ limit: 16 })).some(publication => publication.operationId === oldOperation)).toBe(false);
  const control = (action: 'park' | 'resume') => {
    const actual = current(); return f.store.request({ type: 'jobs.control', ownerId: 'alice', kind, id: job.id, inputVersion: actual.inputVersion,
      expectedRevision: actual.revision, operationId: randomUUID(), action }).jobDisposition!;
  };
  control('park'); control('resume');
  if (skipCycle) { control('park'); control('resume'); }
  expect(await flush()).toMatchObject({ failed: 0, completed: 1 });
  expect(current()).toMatchObject({ state: 'completed', failureCount: 1, cycleFailureCount: 0, retryCycle: skipCycle ? 2 : 1, attemptCount: 2 });
  expect(await registry.publication(oldOperation)).toMatchObject({ state: 'cancelled', stagesCleanedAt: expect.any(String) });
  expect((await registry.publication(`${prefix}-file:${job.id}:cycle:${skipCycle ? 2 : 1}`))?.state).toBe('committed');
  expect(await pendingPublications()).toEqual(unrelated);
  if (kind === 'source_files') await f.history.flush('alice');
  expect((await f.history.read(f.scope, note.id, note.contentRevision!)).content).toBe(note.content);
  expect(f.store.getMessage(note.sources[0]!.messageId).content).toContain('原始依据');
}, 30000);
