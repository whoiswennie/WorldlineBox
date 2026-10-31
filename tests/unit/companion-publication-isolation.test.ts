import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionArtifactRegistry, CompanionPublicationBusyError, companionArtifactHash, type CompanionArtifactPublish } from '../../src/main/companions/artifact-registry';
import { CompanionContextSnapshots } from '../../src/main/companions/context-snapshots';
import { CompanionArtifactRegistryStore } from '../../src/companions/artifact-registry-store';
import { CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
import { companionModelAdmissionRetryAfter, generateCompanionText } from '../../src/main/companions/model';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlbox-publication-isolation-')), ownerRoot = path.join(root, 'alice'); await mkdir(ownerRoot);
  const database = registryStorageFixture(root); let interrupt: string | undefined, point: 'prepare' | 'commit' = 'prepare';
  const storage = { request: async (command: Parameters<typeof database.storage.request>[0]) => {
    if (point === 'commit' && command.type === 'cognition.registry.publication.commit' && command.operationId === interrupt) { interrupt = undefined; throw new Error('fixture crash before final commit'); }
    const result = await database.storage.request(command);
    if (point === 'prepare' && command.type === 'cognition.registry.publication.prepare' && command.publication.operationId === interrupt) { interrupt = undefined; throw new Error('fixture crash after durable prepare'); }
    return result;
  } };
  const registry = new CompanionArtifactRegistry(ownerRoot, 'alice', { registryStorage: storage });
  cleanup.push(async () => { database.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlbox-publication-isolation-')) throw new Error('Unexpected fixture root'); await rm(root, { recursive: true, force: true }); });
  return { root, ownerRoot, database, registry, storage, interrupt: (operation: string, at: typeof point = 'prepare') => { interrupt = operation; point = at; } };
}
const source = (id: string): CompanionArtifactPublish => ({ artifactId: `source:${id}:r1`, kind: 'source_evidence', producer: { kind: 'host', id: 'source-host' },
  relativePath: `证据/来源/${id}.md`, expectedRevision: null, content: `original event ${id}`, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' },
  allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence' });
const ref = (artifact: { artifactId: string; contentRevision: number; contentHash: string }) => ({ artifactId: artifact.artifactId, contentRevision: artifact.contentRevision, contentHash: artifact.contentHash });
const note = (id: string, dependencies: ReturnType<typeof ref>[] = []): CompanionArtifactPublish => ({ artifactId: `memory:${id}`, kind: 'episode_memory', producer: { kind: 'system', id: 'fixture-capture' },
  relativePath: `记忆/经历/${id}.md`, expectedRevision: null, content: `fact ${id}`, sourceRefs: [], dependencyRefs: dependencies, visibility: { scope: 'owner' }, allowedConsumers: ['episode_recall', 'audit'], retentionClass: 'current' });

it('a failed durable source package B does not prevent an unrelated real transport snapshot A or independent fact publication', async () => {
  const f = await fixture(), a = await f.registry.publish({ ...source('a'), operationId: 'source:a' });
  f.interrupt('source:b'); await expect(f.registry.publish({ ...source('b'), operationId: 'source:b' })).rejects.toThrow('durable prepare');
  const pending = (await f.registry.publication('source:b'))!; expect(pending.state).toBe('prepared');
  const reference = { artifactId: a.artifactId, contentRevision: a.contentRevision, contentHash: a.contentHash };
  const snapshots = new CompanionContextSnapshots({ artifacts: async () => f.registry, currentRevocationEpoch: async () => 0, validateRead: async () => undefined });
  const attempt = await snapshots.prepareAttempt({ frame: { schema: 'worldlinebox.companion-context-v2', companionId: 'alice', purpose: 'foreground', invocationId: 'alice:room:a',
    profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), conversationId: 'room', revocationEpoch: 0, identity: 'fixture identity', roleGuidance: '', processorContract: 'reply', input: 'a', sourceRefs: [reference] },
    providerFormat: 'openai_chat', model: 'fixture', providerBody: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'a' }] }), imageFallback: false });
  await attempt.complete('cancelled_before_send');
  expect((await snapshots.list('alice')).items[0]?.status).toBe('cancelled_before_send');
  await f.registry.publish({ artifactId: 'memory:a', kind: 'episode_memory', producer: { kind: 'system', id: 'fixture-capture' }, relativePath: '记忆/经历/a.md', expectedRevision: null,
    content: 'fact A', sourceRefs: [reference], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['episode_recall', 'audit'], retentionClass: 'current', operationId: 'fact:a' });
  expect((await f.registry.read({ artifactId: 'memory:a', consumer: 'episode_recall' })).text).toBe('fact A');
  expect(await f.registry.publication('source:b')).toEqual(pending);
  expect((await f.registry.read({ artifactId: a.artifactId, consumer: 'audit' })).text).toBe('original event a');
  await expect(readFile(path.join(f.ownerRoot, ...pending.items[0]!.stage.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('permits independent readers of the same exact source but symmetrically excludes a writer until the reader package terminates', async () => {
  const f = await fixture(), original = await f.registry.publish({ ...source('shared'), operationId: 'source:shared' });
  f.interrupt('reader:one'); await expect(f.registry.publish({ ...note('one', [ref(original)]), operationId: 'reader:one' })).rejects.toThrow('durable prepare');
  await f.registry.publish({ ...note('two', [ref(original)]), operationId: 'reader:two' });
  const input = { ...source('shared'), expectedRevision: 1, content: 'new source', operationId: 'source:next' };
  const blocked = await f.registry.publish(input).catch(error => error);
  expect(blocked).toBeInstanceOf(CompanionPublicationBusyError); expect(blocked).toBeInstanceOf(CompanionModelAdmissionError);
  expect(companionModelAdmissionRetryAfter(blocked)).toBeGreaterThan(0); expect(blocked.publicationBusy.reason).toBe('artifact');
  expect(await f.registry.publication('source:next')).toBeUndefined();
  await f.registry.cancelPublication('reader:one'); await f.registry.publish(input);
  expect((await f.registry.read({ artifactId: original.artifactId, consumer: 'audit' })).text).toBe('new source');
  // The historical ref path is resolved from its exact registered revision,
  // while the current committed identity remains the authorization gate.
  await f.registry.publish({ ...note('old-version', [ref(original)]), operationId: 'reader:historical' });
});

it('returns typed busy before previous-byte validation for file-published writes, with final worker admission independently enforcing the same read/write footprint', async () => {
  const f = await fixture(), original = await f.registry.publish({ ...source('shared'), operationId: 'source:shared' });
  f.interrupt('writer:pending', 'commit'); await expect(f.registry.publish({ ...source('shared'), expectedRevision: 1, content: 'uncommitted source', operationId: 'writer:pending' })).rejects.toThrow('final commit');
  expect((await f.registry.publication('writer:pending'))?.state).toBe('file_published');
  await expect(f.registry.publish({ ...source('shared'), expectedRevision: 1, operationId: 'writer:overlap' })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  await expect(f.registry.publish({ ...note('reader', [ref(original)]), operationId: 'reader:overlap' })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  await f.registry.publish({ ...source('independent'), operationId: 'source:independent' });
  // Bypass Main's early query: Worker prepare still owns the atomic decision.
  const writer = (await f.registry.publication('writer:pending'))!, next = { ...writer.items[0]!.next, artifactId: 'memory:direct', kind: 'episode_memory' as const,
    producer: { kind: 'system' as const, id: 'fixture' }, relativePath: '记忆/经历/direct.md', contentRevision: 1, dependencyRefs: [ref(original)], operationId: 'direct:reader', allowedConsumers: ['audit' as const] };
  const direct = await f.database.storage.request({ type: 'cognition.registry.publication.prepare', ownerId: 'alice', publication: { ...writer, operationId: 'direct:reader', state: 'prepared', items: [{ next, stage: '.运行/发布/暂存/direct.bin' }] } });
  expect(direct.ok).toBe(true); expect(direct.registryPublicationBusy?.blockingOperationId).toBe('writer:pending');
  expect(await f.registry.publication('direct:reader')).toBeUndefined();
  await f.registry.recover('writer:pending'); expect((await f.registry.get(original.artifactId))?.contentRevision).toBe(2);
});

it('reserves case-folded target paths and file ancestors without locking siblings, and rejects non-atomic ancestor paths within one batch', async () => {
  const f = await fixture(), index = (id: string, relativePath: string): CompanionArtifactPublish => ({ ...note(id), kind: 'runtime_index', relativePath, allowedConsumers: ['host'], retentionClass: 'runtime' });
  f.interrupt('path:pending'); await expect(f.registry.publish({ ...index('path', '.运行/索引/A'), operationId: 'path:pending' })).rejects.toThrow('durable prepare');
  for (const [id, target] of [['same', '.运行/索引/a'], ['child', '.运行/索引/a/child'], ['parent', '.运行/索引']] as const) {
    if (id === 'parent') { // A valid file target under the kind's root.
      await expect(f.registry.publish({ ...index(id, '.运行/索引/A/child'), operationId: `path:${id}` })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
    } else await expect(f.registry.publish({ ...index(id, target), operationId: `path:${id}` })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  }
  await f.registry.publish({ ...index('sibling', '.运行/索引/AB'), operationId: 'path:sibling' });
  f.interrupt('path:descendant'); await expect(f.registry.publish({ ...index('descendant', '.运行/索引/Q/child'), operationId: 'path:descendant' })).rejects.toThrow('durable prepare');
  await expect(f.registry.publish({ ...index('ancestor', '.运行/索引/q'), operationId: 'path:ancestor' })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  await expect(f.registry.publishBatch({ operationId: 'batch:invalid', items: [index('x', '.运行/索引/X'), index('xc', '.运行/索引/x/child')] })).rejects.toThrow('父子');
  expect(await f.registry.publication('batch:invalid')).toBeUndefined();
});

it('rebuilds all pending reservations before reopening admission and releases only the cancelled operation', async () => {
  const f = await fixture();
  for (const id of ['b', 'c']) { f.interrupt(`source:${id}`); await expect(f.registry.publish({ ...source(id), operationId: `source:${id}` })).rejects.toThrow('durable prepare'); }
  f.database.sqlite.exec('DROP TABLE companion_artifact_publication_reservations');
  new CompanionArtifactRegistryStore(f.database.sqlite).initialize();
  await expect(f.registry.publish({ ...source('b'), operationId: 'other:b' })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  await f.registry.cancelPublication('source:b'); await f.registry.publish({ ...source('b'), operationId: 'other:b' });
  await expect(f.registry.publish({ ...source('c'), operationId: 'other:c' })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  expect((await f.registry.publication('source:c'))?.state).toBe('prepared');
});

it('keeps creation owner-wide sealed, then admits unrelated objects only after the fixed creation transaction commits', async () => {
  const f = await fixture(), creation = { ...source('origin'), producer: { kind: 'creation' as const, id: 'creation-host' }, kind: 'origin_snapshot' as const,
    relativePath: '演化/起点/creation.md', allowedConsumers: ['audit' as const], operationId: 'create:alice' };
  f.interrupt(creation.operationId); await expect(f.registry.publish(creation)).rejects.toThrow('durable prepare');
  await expect(f.registry.publish({ ...source('other'), operationId: 'source:other' })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  await f.registry.publish(creation); await f.registry.publish({ ...source('other'), operationId: 'source:other' });
  await expect(f.registry.publish({ ...creation, content: 'replacement origin' })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('source withdrawal cancels its pending readers without blocking an unrelated source and rejects late commits without reviving private packages', async () => {
  const f = await fixture(), original = await f.registry.publish({ ...source('a'), operationId: 'source:a' });
  f.interrupt('memory:pending'); await expect(f.registry.publish({ ...note('a', [ref(original)]), operationId: 'memory:pending' })).rejects.toThrow('durable prepare');
  await f.registry.revoke(original.artifactId); expect((await f.registry.publication('memory:pending'))?.state).toBe('revoked');
  await expect(f.database.storage.request({ type: 'cognition.registry.publication.commit', ownerId: 'alice', operationId: 'memory:pending' })).rejects.toThrow('有效提议');
  await f.registry.publish({ ...source('unrelated'), operationId: 'source:unrelated' });
  await expect(f.registry.publish({ ...note('a', [ref(original)]), operationId: 'memory:new' })).rejects.toThrow('来源或依赖版本');
  expect(await f.registry.get('memory:a')).toBeUndefined();
});

it('rejects a whole overlapping batch before writing any disjoint member and preserves real external corruption as a hard error', async () => {
  const f = await fixture(), original = await f.registry.publish({ ...source('a'), operationId: 'source:a' });
  f.interrupt('memory:held'); await expect(f.registry.publish({ ...note('held', [ref(original)]), operationId: 'memory:held' })).rejects.toThrow('durable prepare');
  await expect(f.registry.publishBatch({ operationId: 'batch:overlap', items: [source('independent'), { ...source('a'), expectedRevision: 1 }] })).rejects.toBeInstanceOf(CompanionPublicationBusyError);
  expect(await f.registry.publication('batch:overlap')).toBeUndefined(); expect(await f.registry.get('source:independent:r1')).toBeUndefined();
  await expect(readFile(path.join(f.ownerRoot, '证据/来源/independent.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await f.registry.cancelPublication('memory:held');
  await writeFile(path.join(f.ownerRoot, original.relativePath), 'unknown external bytes');
  const corrupt = await f.registry.publish({ ...source('a'), expectedRevision: 1, operationId: 'source:changed' }).catch(error => error);
  expect(corrupt).toMatchObject({ code: 'CHANGED' }); expect(corrupt).not.toBeInstanceOf(CompanionPublicationBusyError);
  expect(await f.registry.publication('source:changed')).toBeUndefined();
  expect(await readFile(path.join(f.ownerRoot, original.relativePath), 'utf8')).toBe('unknown external bytes');
});

it('finds the exact interrupted previous target before the page limit even with seventeen unrelated readers of the same identity', async () => {
  const f = await fixture(), profile = await f.registry.publish({ ...note('profile'), artifactId: 'persona:current', kind: 'persona_current', relativePath: 'profile.md',
    content: 'exact previous identity', producer: { kind: 'system', id: 'persona-publisher' }, allowedConsumers: ['identity', 'audit'], operationId: 'persona:initial' }, async () => undefined);
  const evidence = await f.registry.publish({ ...source('private'), operationId: 'source:private' });
  f.interrupt('zzz:persona:pending', 'commit');
  await expect(f.registry.publish({ ...note('profile'), artifactId: profile.artifactId, kind: 'persona_current', relativePath: profile.relativePath, expectedRevision: 1,
    content: 'uncommitted private identity', sourceRefs: [ref(evidence)], producer: { kind: 'system', id: 'persona-publisher' }, allowedConsumers: ['identity', 'audit'], operationId: 'zzz:persona:pending' }, async () => undefined)).rejects.toThrow('final commit');
  await f.registry.revoke(evidence.artifactId);
  for (let index = 0; index < 17; index++) {
    const operationId = `aaa:reader:${String(index).padStart(2, '0')}`; f.interrupt(operationId);
    await expect(f.registry.publish({ ...note(`reader${index}`, [ref(profile)]), operationId })).rejects.toThrow('durable prepare');
  }
  expect((await f.registry.pendingPublications({ artifactId: profile.artifactId, baseRevision: 1, includeRevoked: true, limit: 16 })).every(item => item.operationId.startsWith('aaa:'))).toBe(true);
  expect(await f.registry.hasInterruptedPersonaRetraction()).toBe(true);
  expect((await f.registry.readForRetraction(profile.artifactId)).text).toBe('exact previous identity');
});

it('preserves typed publication admission through the actual model boundary without calling the provider or counting it as a network failure', async () => {
  const f = await fixture(), a = await f.registry.publish({ ...source('a'), operationId: 'source:a' });
  f.interrupt('writer:pending'); await expect(f.registry.publish({ ...source('a'), expectedRevision: 1, content: 'next A', operationId: 'writer:pending' })).rejects.toThrow('durable prepare');
  const snapshots = new CompanionContextSnapshots({ artifacts: async () => f.registry, currentRevocationEpoch: async () => 0, validateRead: async () => undefined });
  const fetchFn = vi.fn<typeof fetch>();
  const result = await generateCompanionText({ system: 'fixture contract', user: 'fixture input' }, { ownerId: 'alice', apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'https://fixture.invalid', apiKey: 'NEVER_SENT',
    transportObserver: snapshots, resolveAssetContext: async context => ({ ...context, frame: { schema: 'worldlinebox.companion-context-v2', companionId: 'alice', purpose: 'foreground', invocationId: 'alice:room:blocked',
      profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), conversationId: 'room', revocationEpoch: 0, identity: '', roleGuidance: '', processorContract: context.system, input: context.user, sourceRefs: [ref(a)] } }) }, undefined, { fetchFn }).catch(error => error);
  expect(result).toMatchObject({ code: 'RATE_LIMIT', admission: { reason: 'files_pending' } }); expect(companionModelAdmissionRetryAfter(result)).toBeGreaterThan(0);
  expect(fetchFn).not.toHaveBeenCalled(); expect((await f.registry.publication('writer:pending'))?.state).toBe('prepared');
});

it('admits exact source and dependency references to other next objects in one atomic batch', async () => {
  const f = await fixture(), raw = source('same-batch'), first = note('same-first'), second = note('same-second');
  first.sourceRefs = [{ artifactId: raw.artifactId, contentRevision: 1, contentHash: companionArtifactHash(raw.content) }];
  second.dependencyRefs = [{ artifactId: first.artifactId, contentRevision: 1, contentHash: companionArtifactHash(first.content) }];
  const committed = await f.registry.publishBatch({ operationId: 'batch:exact-next', items: [raw, first, second] });
  expect(committed).toHaveLength(3); expect((await f.registry.read({ artifactId: first.artifactId, consumer: 'episode_recall' })).text).toBe(first.content);
  expect((await f.registry.read({ artifactId: second.artifactId, consumer: 'episode_recall' })).text).toBe(second.content);
  expect(f.database.sqlite.prepare('SELECT COUNT(*) AS n FROM companion_artifact_publication_reservations WHERE owner_id=?').get('alice')).toEqual({ n: 0 });
});
