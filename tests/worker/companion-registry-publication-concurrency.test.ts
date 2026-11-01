import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionArtifactRegistry, type CompanionArtifactPublish, type CompanionRegistryStorage } from '../../src/main/companions/artifact-registry';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const closers: Array<() => Promise<void>> = [];
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0)) await close(); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-concurrency-')), ownerRoot = path.join(root, 'alice'); await mkdir(ownerRoot);
  const database = registryStorageFixture(root);
  let intercept: ((command: Parameters<CompanionRegistryStorage['request']>[0]) => Promise<void>) | undefined;
  const storage: CompanionRegistryStorage = { request: async command => { await intercept?.(command); return database.storage.request(command); } };
  const registry = () => new CompanionArtifactRegistry(ownerRoot, 'alice', { registryStorage: storage });
  closers.push(async () => { database.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('registry-concurrency-')) throw new Error('Unexpected cleanup path'); await rm(root, { recursive: true, force: true }); });
  return { ownerRoot, registry, database, intercept: (next?: typeof intercept) => { intercept = next; } };
}
const item = (id: string, overrides: Partial<CompanionArtifactPublish> = {}): CompanionArtifactPublish => ({ artifactId: id, kind: 'episode_memory',
  producer: { kind: 'system', id: 'capture:fixture' }, relativePath: '记忆/经历/' + id.replaceAll(':', '_') + '.md', expectedRevision: null,
  content: '实际正式正文。', sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['episode_recall', 'audit'], retentionClass: 'current', ...overrides });
const source = (id: string) => item(id, { kind: 'source_evidence', producer: { kind: 'host', id: 'message:fixture' }, relativePath: '证据/来源/' + id.replaceAll(':', '_') + '.md', allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence' });
const context = (id: string) => item(id, { kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: '.运行/上下文/' + id.replaceAll(':', '_') + '/attempt.json', allowedConsumers: ['audit'], retentionClass: 'ephemeral' });

it('lets a real disjoint context commit while source validation is blocked and serializes the exact overlapping source', async () => {
  const f = await fixture(), a = f.registry(), b = f.registry(), entered = gate(), release = gate(); let checks = 0, overlapDone = false;
  const publishing = a.publish({ ...source('source:one'), operationId: 'publish:source' }, async () => { if (++checks === 2) { entered.release(); await release.promise; } });
  await entered.promise;
  const overlap = b.publish({ ...source('source:one'), content: '准确第二版。', expectedRevision: 1, operationId: 'publish:source-next' }).then(value => { overlapDone = true; return value; });
  try {
    expect((await b.publish({ ...context('context:independent'), operationId: 'publish:context' })).publicationState).toBe('committed');
    expect(overlapDone).toBe(false); expect((await a.publication('publish:source'))?.state).toBe('prepared');
  } finally { release.release(); }
  await publishing; expect((await overlap).contentRevision).toBe(2);
  expect((await a.read({ artifactId: 'source:one', consumer: 'audit' })).text).toBe('准确第二版。');
});

it('allows two real publications sharing one read-only source to validate concurrently', async () => {
  const f = await fixture(), a = f.registry(), anchor = await a.publish({ ...source('source:anchor'), operationId: 'publish:anchor' });
  const ref = { artifactId: anchor.artifactId, contentRevision: anchor.contentRevision, contentHash: anchor.contentHash }, release = gate(); let entered = 0;
  const publish = (id: string) => { let first = true; return f.registry().publish({ ...item(id, { sourceRefs: [ref] }), operationId: 'publish:' + id }, async () => { if (first) { first = false; entered++; await release.promise; } }); };
  const left = publish('memory:left'), right = publish('memory:right');
  try { await vi.waitFor(() => expect(entered).toBe(2), { timeout: 2000 }); } finally { release.release(); }
  expect((await Promise.all([left, right])).map(value => value.publicationState)).toEqual(['committed', 'committed']);
});

it('keeps same-operation idempotence isolated even when a second caller proposes other targets', async () => {
  const f = await fixture(), entered = gate(), release = gate(); let first = true, secondDone = false;
  const publishing = f.registry().publish({ ...item('memory:one'), operationId: 'same:operation' }, async () => { if (first) { first = false; entered.release(); await release.promise; } });
  await entered.promise;
  const second = f.registry().publish({ ...item('memory:other'), operationId: 'same:operation' }).catch(error => { secondDone = true; return error; });
  try { await f.registry().publish({ ...context('context:other'), operationId: 'disjoint:operation' }); expect(secondDone).toBe(false); } finally { release.release(); }
  await publishing; expect(await second).toMatchObject({ code: 'CONFLICT' }); expect(await f.registry().get('memory:other')).toBeUndefined();
});

it('coordinates the same durable operation across Registry instances with Windows root-case aliases', async () => {
  const f = await fixture(), a = f.registry(), alias = new CompanionArtifactRegistry(f.ownerRoot.toUpperCase(), 'alice', { registryStorage: f.database.storage });
  const entered = gate(), release = gate(); let first = true, duplicateDone = false;
  const input = { ...item('memory:alias'), operationId: 'publish:alias' };
  const publishing = a.publish(input, async () => { if (first) { first = false; entered.release(); await release.promise; } }); await entered.promise;
  const duplicate = alias.publish(input).then(value => { duplicateDone = true; return value; });
  try { await a.publish({ ...context('context:alias-independent'), operationId: 'context:alias-independent' }); expect(duplicateDone).toBe(false); } finally { release.release(); }
  expect(await duplicate).toEqual(await publishing);
});

it('cancels a durable publication immediately without waiting for its blocked file resource', async () => {
  const f = await fixture(), a = f.registry(), entered = gate(), release = gate(); let checks = 0;
  const publishing = a.publish({ ...source('source:cancelled'), operationId: 'publish:cancelled' }, async () => { if (++checks === 2) { entered.release(); await release.promise; } }).catch(error => error);
  await entered.promise;
  try { await f.registry().cancelPublication('publish:cancelled'); expect((await a.publication('publish:cancelled'))?.state).toBe('cancelled'); } finally { release.release(); }
  expect(await publishing).toMatchObject({ code: 'CONFLICT' });
  await f.registry().purgePublicationStages('publish:cancelled');
  await expect(readFile(path.join(f.ownerRoot, source('source:cancelled').relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps source withdrawal immediate and rejects a blocked dependent publication after its authority is revoked', async () => {
  const f = await fixture(), a = f.registry(), anchor = await a.publish({ ...source('source:withdrawn'), operationId: 'source:withdrawn' });
  const ref = { artifactId: anchor.artifactId, contentRevision: anchor.contentRevision, contentHash: anchor.contentHash }, entered = gate(), release = gate(); let checks = 0;
  const publishing = a.publish({ ...item('memory:withdrawn', { sourceRefs: [ref] }), operationId: 'memory:withdrawn' }, async () => { if (++checks === 2) { entered.release(); await release.promise; } }).catch(error => error);
  await entered.promise;
  try {
    expect(await f.registry().revoke(anchor.artifactId)).toContain(anchor.artifactId);
    expect((await a.publication('memory:withdrawn'))?.state).toBe('revoked');
  } finally { release.release(); }
  expect(await publishing).toMatchObject({ code: 'CONFLICT' });
  await expect(readFile(path.join(f.ownerRoot, item('memory:withdrawn').relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('serializes recovery and stage cleanup for the same durable operation while disjoint receipts still commit', async () => {
  const f = await fixture(), a = f.registry(); let fail = true;
  f.intercept(async command => { if (command.type === 'cognition.registry.publication.commit' && fail) { fail = false; throw new Error('durable commit interrupted'); } });
  await expect(a.publish({ ...item('memory:recover'), operationId: 'publish:recover' })).rejects.toThrow('interrupted'); f.intercept();
  const entered = gate(), release = gate(); let first = true, cleaned = false;
  const recovery = f.registry().recover('publish:recover', async () => { if (first) { first = false; entered.release(); await release.promise; } }); await entered.promise;
  const cleanup = f.registry().purgePublicationStages('publish:recover').then(() => { cleaned = true; });
  try { await a.publish({ ...context('context:during-recovery'), operationId: 'context:during-recovery' }); expect(cleaned).toBe(false); } finally { release.release(); }
  await Promise.all([recovery, cleanup]); expect((await a.read({ artifactId: 'memory:recover', consumer: 'audit' })).text).toBe(item('memory:recover').content);
});

it('preserves external-byte conflict detection when a disjoint writer is concurrently active', async () => {
  const f = await fixture(), a = f.registry(); await a.publish({ ...item('memory:edited'), operationId: 'edited:initial' });
  const entered = gate(), release = gate(); let first = true;
  const publishing = a.publish({ ...source('source:background'), operationId: 'background:source' }, async () => { if (first) { first = false; entered.release(); await release.promise; } }); await entered.promise;
  try {
    await writeFile(path.join(f.ownerRoot, item('memory:edited').relativePath), '外部未知字节。');
    await expect(f.registry().publish({ ...item('memory:edited', { expectedRevision: 1, content: '不得覆盖外改。' }), operationId: 'edited:next' })).rejects.toMatchObject({ code: 'CHANGED' });
    expect(await readFile(path.join(f.ownerRoot, item('memory:edited').relativePath), 'utf8')).toBe('外部未知字节。');
  } finally { release.release(); }
  await publishing;
});

it('does not let an old revoked-body cleanup delete a newly revalidated formal body at the same path', async () => {
  const f = managedMemoryFiles(); closers.push(f.close);
  const lawful = f.source('可以继续使用的真实依据。'), original = f.record(lawful.content, [lawful.id]); await f.publish();
  const withdrawn = f.source('随后明确撤回的私人依据。');
  f.store.request({ type: 'memory.revise', ...f.scope, id: original.id, expectedVersion: original.version, candidate: f.candidate(lawful.content + withdrawn.content, [lawful.id, withdrawn.id]) }); await f.publish();
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [withdrawn.id] }); await f.publish();
  const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  const restored = f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [f.candidate(lawful.content, [lawful.id])] }).memories![0]!;
  expect(restored.id).toBe(original.id);
  const entered = gate(), release = gate(); let first = true, cleaned = false;
  f.intercept(async command => { if (command.type === 'cognition.registry.publication.prepare' && command.publication.authorization === 'memory_revalidation' && first) { first = false; entered.release(); await release.promise; } });
  const publishing = f.publish(); await entered.promise;
  const cleanup = (await f.artifacts('alice')).purgeRevokedBody('memory:' + original.id).then(value => { cleaned = true; return value; }, error => { cleaned = true; return error; });
  try { expect(cleaned).toBe(false); } finally { release.release(); }
  await publishing; expect(await cleanup).toMatchObject({ code: 'DENIED' });
  expect((await (await f.artifacts('alice')).read({ artifactId: 'memory:' + original.id, consumer: 'audit' })).text).toBe(lawful.content);
});
