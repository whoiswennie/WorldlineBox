import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLearningGrant, CompanionLearningJob } from '../../src/shared/companion-learning';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-store-')); roots.push(root);
  const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '读到资料不等于认可或掌握。', model: '', avatar: 'sister', proactive: false, active: true }));
  const file = path.join(root, 'state.sqlite'); const store = new CompanionsStore(file, seeds); stores.add(store);
  const grant = (owner = 'alice', libraryId = 'library-one', autonomous = false) => store.request({ type: 'learning.grant', companionId: owner,
    libraryId, libraryName: libraryId, libraryPath: root, autonomous, intervalMinutes: 30 }).learning!.grants.at(-1)!;
  const run = (grant: CompanionLearningGrant) => store.request({ type: 'learning.run', companionId: grant.companionId, id: grant.id, expectedRevision: grant.revision });
  const claim = (excludedOwners: string[] = []) => store.request({ type: 'learning.claim', excludedOwners }).learningJob!;
  return { root, file, seeds, store, grant, run, claim };
}
function commit(store: CompanionsStore, job: CompanionLearningJob, content = '原文提出先核对出处，再记录有条件的结论。', extra: { offset?: number; nextOffset?: number; more?: boolean } = {}) {
  return store.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: 'asset-one', assetRevisionId: 'revision-one_hash',
    assetName: '学习资料.md', offset: extra.offset ?? 0, content, more: extra.more ?? false, nextOffset: extra.nextOffset });
}

it('has no implicit grants, supports many-to-many sources and requires explicit autonomous or manual permission', () => {
  const f = fixture(); expect(f.claim()).toBeUndefined();
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.grants).toEqual([]);
  const a = f.grant(), b = f.grant('bob'), another = f.grant('alice', 'library-two');
  expect(f.claim()).toBeUndefined();
  expect(() => f.grant()).toThrow('已获准');
  f.run(a); f.run(b); f.run(another);
  expect(f.claim(['alice']).grant).toMatchObject({ id: b.id, companionId: 'bob', libraryId: a.libraryId });
  expect(f.claim().grant.id).toBe(a.id);
  expect(f.claim()).toBeUndefined(); // The same owner cannot hold two sources concurrently.
});

it('registers the actual host read as asset_read evidence and a selective capture job, then withdraws only its owner on revoke', () => {
  const f = fixture(), grant = f.grant(); f.run(grant); const job = f.claim(), content = '原文提出先核对出处，再记录有条件的结论。';
  const result = commit(f.store, job, content), receipt = result.learning!.reads[0]!;
  expect(receipt).toMatchObject({ companionId: 'alice', grantId: grant.id, libraryId: grant.libraryId, assetId: 'asset-one', characters: content.length, status: 'read' });
  expect(receipt.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
  const message = f.store.getMessage(receipt.sourceMessageId);
  expect(message).toMatchObject({ authorId: 'system', kind: 'notice', conversationId: 'world_alice' });
  const [header, ...body] = message.content.split('\n\n原文片段：\n');
  expect(JSON.parse(header!)).toMatchObject({ category: 'learning', internalized: false, source: { assetName: '学习资料.md' } });
  expect(body.join('\n\n原文片段：\n')).toBe(content);
  expect(f.store.state().conversations.some(room => room.id === 'world_alice')).toBe(false);
  const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(capture.sourceMessageIds).toEqual([message.id]);
  const note = f.store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken,
    notes: [{ diaryName: '资料', content, tags: ['出处核验'], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: content }] }] }).memories![0]!;
  expect(note.sources[0]).toMatchObject({ sourceType: 'asset_read', messageId: message.id, conversationId: 'world_alice' });
  const bobGrant = f.grant('bob'); f.run(bobGrant); const bobReceipt = commit(f.store, f.claim()).learning!.reads[0]!;
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads[0]!.status).toBe('withdrawn');
  expect(f.store.request({ type: 'memory.browse', companionId: 'alice', conversationId: 'world_alice' }).memoryPage!.items).toEqual([]);
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: 'world_bob', ids: [bobReceipt.sourceMessageId] }).memorySources).toHaveLength(1);
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: 'world_bob', ids: [message.id] }).memorySources).toHaveLength(0);
});

it.each(['update', 'revoke', 'dormant'] as const)('rejects an old lease after %s without creating hidden evidence or capture', kind => {
  const f = fixture(), grant = f.grant(); f.run(grant); const job = f.claim();
  if (kind === 'revoke') f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  else if (kind === 'update') f.store.request({ type: 'learning.update', companionId: 'alice', id: grant.id, expectedRevision: grant.revision, autonomous: true, intervalMinutes: 15 });
  else f.store.setCompanionActive('alice', false);
  expect(() => commit(f.store, job)).toThrow(/权限|取消/u);
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
  expect(f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
});

it('isolates management ownership and rejects invented or skipped chunk offsets', () => {
  const f = fixture(), grant = f.grant();
  expect(() => f.store.request({ type: 'learning.run', companionId: 'bob', id: grant.id, expectedRevision: grant.revision })).toThrow('权限');
  f.run(grant); const job = f.claim();
  expect(() => commit(f.store, job, 'abc', { offset: 9 })).toThrow('顺序');
  expect(() => commit(f.store, job, 'abc', { nextOffset: 9 })).toThrow('顺序');
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(0);
  commit(f.store, job, 'abc', { nextOffset: 3, more: true });
  vi.setSystemTime(Date.now() + 1001); const next = f.claim();
  expect(next).toMatchObject({ offset: 3, assetId: 'asset-one', assetRevisionId: 'revision-one_hash' });
  expect(() => commit(f.store, next, 'def', { offset: 0 })).toThrow('顺序');
  commit(f.store, next, 'def', { offset: 3 });
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(2);
});

it('restores only a fresh lease after restart, keeps the cursor and never duplicates a recorded read', () => {
  const f = fixture(), grant = f.grant(); f.run(grant); const first = f.claim();
  commit(f.store, first, 'abc', { nextOffset: 3, more: true });
  vi.setSystemTime(Date.now() + 1001); const stopped = f.claim();
  f.store.close(); stores.delete(f.store); const reopened = new CompanionsStore(f.file, f.seeds); stores.add(reopened);
  const resumed = reopened.request({ type: 'learning.claim', excludedOwners: [] }).learningJob!;
  expect(resumed.offset).toBe(3); expect(resumed.leaseToken).not.toBe(stopped.leaseToken);
  expect(() => commit(reopened, stopped, 'def', { offset: 3 })).toThrow(/取消|过期/u);
  commit(reopened, resumed, 'def', { offset: 3 });
  expect(reopened.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(2);
  reopened.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const rescan = reopened.request({ type: 'learning.claim', excludedOwners: [] }).learningJob!; commit(reopened, rescan, 'abc');
  expect(reopened.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(2);
});

it('admits actual reading only with its owner world-domain grant lease and keeps ordinary actions source-bound', () => {
  const f = fixture(), grant = f.grant(); f.run(grant); const job = f.claim();
  f.store.request({ type: 'world.snapshot' });
  const scope = { companionId: 'alice', conversationId: 'world_alice' };
  const proof = { learningGrantId: job.id, learningLeaseToken: job.leaseToken };
  const begin = { type: 'world.work.begin' as const, ...scope, workId: 'real_reading', kind: 'learning' as const, ...proof };
  expect(() => f.store.request({ ...begin, learningLeaseToken: 'invented' })).toThrow('授权');
  expect(() => f.store.request({ ...begin, companionId: 'bob', conversationId: 'world_bob' })).toThrow('授权');
  expect(() => f.store.request({ ...begin, conversationId: f.store.openPrivate('alice').id })).toThrow('世界域');
  expect(() => f.store.request({ ...begin, kind: 'action' })).toThrow('其它行动');
  expect(() => f.store.request({ type: 'world.work.begin', ...scope, workId: 'unsourced_action', kind: 'action' })).toThrow('用户来源');
  expect(() => f.store.request({ ...begin, fixed: true })).toThrow('授权');
  expect(f.store.request(begin).worldWork).toMatchObject({ kind: 'learning', companionId: 'alice' });
  let work = f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: begin.workId }).worldWork!;
  for (let index = 0; index < 100 && work.status !== 'ready'; index++) {
    vi.setSystemTime(Date.now() + 250); f.store.request({ type: 'world.tick' });
    work = f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: begin.workId }).worldWork!;
  }
  expect(work.status).toBe('ready');
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
  commit(f.store, job, '第一行真实原文。\n\n“嵌套引号”和第二段保留。');
  expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: begin.workId }).worldWork!.status).toBe('ended');
});

it.each(['revoke', 'update', 'expire'] as const)('ends a persistent learning reservation on %s, without granting a late read', kind => {
  const f = fixture(), grant = f.grant(); f.run(grant); const job = f.claim(); f.store.request({ type: 'world.snapshot' });
  const begin = { type: 'world.work.begin' as const, companionId: 'alice', conversationId: 'world_alice', workId: 'revocable_reading', kind: 'learning' as const,
    learningGrantId: job.id, learningLeaseToken: job.leaseToken };
  f.store.request(begin);
  if (kind === 'revoke') f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  else if (kind === 'update') f.store.request({ type: 'learning.update', companionId: 'alice', id: grant.id, expectedRevision: grant.revision, autonomous: true, intervalMinutes: 60 });
  else vi.setSystemTime(Date.now() + 120001);
  f.store.request({ type: 'world.tick' });
  expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: begin.workId }).worldWork).toMatchObject({ status: 'ended' });
  expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy === 'alice')).toBe(false);
  expect(() => f.store.request(begin)).toThrow('授权'); expect(() => commit(f.store, job)).toThrow(/权限|取消|过期/u);
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
});

it('ends a prior-process reading pose and requires a fresh grant lease after restart', () => {
  const f = fixture(), grant = f.grant(); f.run(grant); const old = f.claim(); f.store.request({ type: 'world.snapshot' });
  const begin = { type: 'world.work.begin' as const, companionId: 'alice', conversationId: 'world_alice', workId: 'old_process_reading', kind: 'learning' as const,
    learningGrantId: old.id, learningLeaseToken: old.leaseToken };
  f.store.request(begin); f.store.close(); stores.delete(f.store);
  const reopened = new CompanionsStore(f.file, f.seeds); stores.add(reopened);
  expect(reopened.request({ type: 'world.work.ready', companionId: 'alice', workId: begin.workId }).worldWork!.status).toBe('ended');
  expect(() => reopened.request(begin)).toThrow('授权');
  const fresh = reopened.request({ type: 'learning.claim', excludedOwners: [] }).learningJob!;
  expect(fresh.id).toBe(old.id); expect(fresh.leaseToken).not.toBe(old.leaseToken);
  expect(reopened.request({ ...begin, workId: 'new_process_reading', learningLeaseToken: fresh.leaseToken }).worldWork!.kind).toBe('learning');
  expect(() => commit(reopened, old)).toThrow(/取消|过期/u);
});
