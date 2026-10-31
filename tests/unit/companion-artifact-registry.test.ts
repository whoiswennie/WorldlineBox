import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionArtifactRegistry, companionArtifactHash, companionMemoryArtifactPath, type CompanionArtifactPublish, type CompanionRegistryStorage } from '../../src/main/companions/artifact-registry';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import { CompanionAssetProfileStore, renderCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import type { Companion } from '../../src/shared/companions';
import { companionInstanceSchema } from '../../src/shared/companion-instance';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-registry-')) throw new Error('Unexpected test cleanup target');
  await rm(root, { recursive: true, force: true });
} });
const owner: Companion = { id: 'alice', name: 'Alice', description: '创建起点', persona: '创建时的任意自定义人格章节。',
  model: '', avatar: 'sister', builtin: true, proactive: false, active: true, createdAt: '2026-10-28T10:00:00Z' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-registry-')); roots.push(root);
  const ownerRoot = path.join(root, owner.id); await mkdir(ownerRoot);
  const database = registryStorageFixture(root); databases.push(database);
  let failCommitted = false, failPrepared = false;
  const storage: CompanionRegistryStorage = {
    request: async command => {
      if (failCommitted && command.type === 'cognition.registry.publication.commit') { failCommitted = false; throw new Error('injected host transaction crash'); }
      if (failPrepared && command.type === 'cognition.registry.publication.prepare') {
        failPrepared = false; await database.storage.request(command); throw new Error('injected crash after durable prepare');
      }
      return database.storage.request(command);
    },
  };
  const backend = { registryStorage: storage };
  return { root, ownerRoot, backend, database, failNextCommit: () => { failCommitted = true; }, failNextPrepare: () => { failPrepared = true; },
    registry: new CompanionArtifactRegistry(ownerRoot, owner.id, backend), store: new CompanionAssetProfileStore(root, backend) };
}
const item = (overrides: Partial<CompanionArtifactPublish> = {}): CompanionArtifactPublish => ({ artifactId: 'memory:one', kind: 'episode_memory',
  producer: { kind: 'system', id: 'capture:one' }, relativePath: '记忆/经历/main/one.md', expectedRevision: null, content: '真实事件的有据笔记。',
  sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['episode_recall', 'memory_consolidation', 'audit'], retentionClass: 'current', ...overrides });

it('batches sixteen canonical source reads into metadata/ref gates while reopening every distinct body', async () => {
  const f = await fixture();
  const anchor = await f.registry.publish({ ...item({ artifactId: 'source:anchor', kind: 'source_evidence', relativePath: '证据/来源/anchor.md',
    allowedConsumers: ['source_verification', 'audit'], producer: { kind: 'host', id: 'message:anchor' } }), operationId: 'publish:anchor' });
  const reference = { artifactId: anchor.artifactId, contentRevision: anchor.contentRevision, contentHash: anchor.contentHash };
  const records = await f.registry.publishBatch({ operationId: 'publish:sixteen', items: Array.from({ length: 16 }, (_, index) => item({
    artifactId: 'source:batch_' + index, kind: 'source_evidence', relativePath: `证据/来源/batch_${index}.md`, content: '实际来源 ' + index,
    allowedConsumers: ['source_verification', 'audit'], producer: { kind: 'host', id: 'message:batch_' + index }, sourceRefs: [reference] })) });
  const inputs = [...records, records[0]!].map(record => ({ artifactId: record.artifactId, consumer: 'source_verification' as const }));
  f.database.commands.length = 0;
  const bodies = vi.spyOn(f.registry as unknown as { bytes(relative: string): Promise<Buffer> }, 'bytes');
  const read = await f.registry.readMany(inputs);
  expect(read.map(value => value.text)).toEqual([...Array.from({ length: 16 }, (_, index) => '实际来源 ' + index), '实际来源 0']);
  // Initial body reads and the final finite-gate file fence both open bytes.
  expect(bodies).toHaveBeenCalledTimes(32);
  expect(f.database.commands.map(command => command.type)).toEqual(['cognition.registry.read', 'cognition.registry.refs.validate',
    'cognition.registry.read', 'cognition.registry.refs.validate', 'cognition.registry.read', 'cognition.registry.refs.validate']);
  await f.registry.readMany(inputs); expect(bodies).toHaveBeenCalledTimes(64); bodies.mockRestore();
});

it('uses one exact owner path batch for body admission and preserves caller order, duplicate paths and consumer checks', async () => {
  const f = await fixture();
  await f.registry.publishBatch({ operationId: 'publish:path_batch', items: [item(), item({ artifactId: 'memory:two',
    relativePath: '记忆/经历/main/two.md', content: '第二条正式正文。' })] });
  f.database.commands.length = 0;
  const bodies = vi.spyOn(f.registry as unknown as { bytes(relative: string): Promise<Buffer> }, 'bytes');
  const values = await f.registry.readManyByPaths(['记忆/经历/main/two.md', '记忆/经历/main/one.md', '记忆/经历/main/two.md'], () => 'audit');
  expect(values.map(value => value.text)).toEqual(['第二条正式正文。', '真实事件的有据笔记。', '第二条正式正文。']);
  expect(bodies).toHaveBeenCalledTimes(4);
  const reads = f.database.commands.filter(command => command.type === 'cognition.registry.read');
  expect(reads).toHaveLength(3); expect(reads[0]).toMatchObject({ ownerId: owner.id, relativePaths: ['记忆/经历/main/two.md', '记忆/经历/main/one.md'] });
  await expect(f.registry.readManyByPaths(['记忆/经历/main/one.md'], () => 'identity')).rejects.toMatchObject({ code: 'DENIED' });
  await expect(f.registry.readManyByPaths(['记忆/经历/main/not_registered.md'], () => 'audit')).rejects.toMatchObject({ code: 'UNREGISTERED' });
  bodies.mockRestore();
});

it.each(['same_stat_edit', 'withdrawal', 'wrong_consumer', 'wrong_audience', 'during_read'] as const)('rejects %s through the batched canonical gate', async change => {
  const f = await fixture();
  const source = await f.registry.publish({ ...item({ artifactId: 'source:gate', kind: 'source_evidence', relativePath: '证据/来源/gate.md', content: '真实来源正文。',
    allowedConsumers: ['source_verification', 'audit'], visibility: { scope: 'audience', audienceIds: ['room_private'] }, producer: { kind: 'host', id: 'message:gate' } }), operationId: 'publish:gate' });
  const input = { artifactId: source.artifactId, consumer: change === 'wrong_consumer' ? 'identity' as const : 'source_verification' as const,
    audienceIds: [change === 'wrong_audience' ? 'room_other' : 'room_private'] };
  if (change === 'same_stat_edit') {
    const file = path.join(f.ownerRoot, ...source.relativePath.split('/')), before = await stat(file);
    await writeFile(file, '外改来源正文。'); await utimes(file, before.atime, before.mtime);
  } else if (change === 'withdrawal') await f.registry.revoke(source.artifactId);
  const currentBytes = (f.registry as unknown as { bytes(relative: string): Promise<Buffer> }).bytes.bind(f.registry);
  const bytes = change === 'during_read' ? vi.spyOn(f.registry as unknown as { bytes(relative: string): Promise<Buffer> }, 'bytes').mockImplementation(async relative => {
    const value = await currentBytes(relative); await f.registry.revoke(source.artifactId); return value;
  }) : undefined;
  try { await expect(f.registry.readMany([input])).rejects.toMatchObject({ code: ['same_stat_edit', 'during_read'].includes(change) ? 'CHANGED' : 'DENIED' }); }
  finally { bytes?.mockRestore(); }
});

it('T-001/T-002 seals one origin and exposes only v2 typed files with no seeded memories', async () => {
  const f = await fixture(), created = await f.store.bootstrap(owner);
  const instance = await f.store.readInstance(owner.id);
  expect(instance.schema).toBe('worldlinebox.companion-instance-v2');
  expect(instance.files.index).toBe('.运行/索引');
  expect(await readdir(path.join(f.ownerRoot, '记忆/经历'))).toEqual([]);
  expect(await readdir(path.join(f.ownerRoot, '记忆/知识'))).toEqual([]);
  expect(await readdir(path.join(f.ownerRoot, '记忆/自我认识'))).toEqual([]);
  const origin = await f.registry.read({ artifactId: 'origin:creation', consumer: 'audit' });
  expect(origin.text).toBe(renderCompanionAssetProfile(owner.id, created.profile));
  expect((await f.store.bootstrap({ ...owner, persona: '不应重置' })).profile.persona).toBe(owner.persona);
  expect((await f.registry.list('episode_recall'))).toEqual([]);
  await expect(f.store.writeProfile({ companionId: owner.id, expectedRevision: created.profileRevision, profile: { name: '改名', description: '', persona: '直接替换' } }))
    .rejects.toMatchObject({ code: 'READ_ONLY' });
  await expect(f.store.writePrompt({ companionId: owner.id, expectedRevision: created.promptRevision, relativePath: created.modules[0]!.path, content: '直接替换' }))
    .rejects.toMatchObject({ code: 'READ_ONLY' });
  expect(companionInstanceSchema.safeParse({ ...instance, schema: 'worldlinebox.companion-instance-v1' }).success).toBe(false);
});

it('T-003 rejects external profile/prompt/sidecar edits and missing files without template fallback', async () => {
  const f = await fixture(), created = await f.store.bootstrap(owner);
  const profile = path.join(f.ownerRoot, 'profile.md');
  await writeFile(profile, renderCompanionAssetProfile(owner.id, { ...created.profile, persona: 'EXTERNAL_CANARY' }));
  await writeFile(profile + '.meta.json', JSON.stringify({ contentHash: 'forged', kind: 'persona_current' }));
  await expect(f.store.loadProfile(owner.id)).rejects.toMatchObject({ code: 'CHANGED' });
  await writeFile(profile, renderCompanionAssetProfile(owner.id, created.profile));
  await writeFile(path.join(f.ownerRoot, ...created.modules[0]!.path.split('/')), 'PROMPT_CANARY');
  await expect(f.store.load(owner.id)).rejects.toMatchObject({ code: 'CHANGED' });
  await unlink(profile);
  await expect(f.store.bootstrap(owner)).rejects.toBeDefined();
  await expect(readFile(profile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('T-005/T-007/T-008 denies unknown files, cross-kind consumers and derived independent sources', async () => {
  const f = await fixture();
  await mkdir(path.join(f.ownerRoot, '未知')); await writeFile(path.join(f.ownerRoot, '未知/first-person.md'), '我是一份自动人格 CANARY');
  expect(await f.registry.list()).toEqual([]);
  await expect(f.registry.read({ artifactId: 'unknown', consumer: 'episode_recall' })).rejects.toMatchObject({ code: 'UNREGISTERED' });
  await expect(f.registry.publish({ ...item(), relativePath: '未知/one.md', operationId: 'invalid:path' })).rejects.toMatchObject({ code: 'INVALID' });
  await expect(f.registry.publish({ ...item({ kind: 'dream_fiction', relativePath: '演化/联想/one.md' }), operationId: 'invalid:dream' })).rejects.toBeDefined();
  const memory = await f.registry.publish({ ...item(), operationId: 'valid:memory' });
  await expect(f.registry.read({ artifactId: memory.artifactId, consumer: 'knowledge_recall' })).rejects.toMatchObject({ code: 'DENIED' });
  await expect(f.registry.publish({ ...item({ artifactId: 'memory:two', relativePath: '记忆/经历/main/two.md', sourceRefs: [{ artifactId: memory.artifactId,
    contentRevision: memory.contentRevision, contentHash: memory.contentHash }] }), operationId: 'invalid:source' })).rejects.toThrow('派生正文');
  await writeFile(path.join(f.ownerRoot, '记忆/经历/main/one.md'), '外部更改');
  await expect(f.registry.read({ artifactId: memory.artifactId, consumer: 'episode_recall' })).rejects.toMatchObject({ code: 'CHANGED' });
});

it('T-014/T-031 checks source versions and audience and propagates revocation without revival', async () => {
  const f = await fixture();
  const source = await f.registry.publish({ ...item({ artifactId: 'source:one', kind: 'source_evidence', producer: { kind: 'host', id: 'message:one' },
    relativePath: '证据/来源/one.md', allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence' }), operationId: 'publish:source' });
  const ref = { artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash };
  const memory = await f.registry.publish({ ...item({ sourceRefs: [ref], visibility: { scope: 'audience', audienceIds: ['room:private'] } }), operationId: 'publish:memory' });
  await expect(f.registry.read({ artifactId: memory.artifactId, consumer: 'episode_recall', audienceIds: ['room:other'] })).rejects.toMatchObject({ code: 'DENIED' });
  expect((await f.registry.read({ artifactId: memory.artifactId, consumer: 'episode_recall', audienceIds: ['room:private'] })).text).toContain('真实事件');
  expect(await f.registry.revoke(source.artifactId)).toEqual(expect.arrayContaining([source.artifactId, memory.artifactId]));
  await expect(f.registry.read({ artifactId: memory.artifactId, consumer: 'episode_recall', audienceIds: ['room:private'] })).rejects.toMatchObject({ code: 'DENIED' });
  await expect(f.registry.publish({ ...item({ expectedRevision: 1 }), operationId: 'replay:memory' })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('T-028/T-029 recovers only the anchored unfinished transaction and never admits file-published bytes early', async () => {
  const f = await fixture();
  await f.registry.publish({ ...item(), operationId: 'memory:initial' });
  f.failNextCommit();
  // Fail at the final durable receipt after replacing the body.
  await expect(f.registry.publish({ ...item({ expectedRevision: 1, content: '合法第二版' }), operationId: 'memory:next' })).rejects.toThrow('injected');
  expect((await f.registry.publication('memory:next'))?.state).toBe('file_published');
  await expect(f.registry.read({ artifactId: 'memory:one', consumer: 'episode_recall' })).rejects.toMatchObject({ code: 'CHANGED' });
  const reopened = new CompanionArtifactRegistry(f.ownerRoot, owner.id, f.backend);
  await reopened.recover('memory:next');
  expect((await reopened.read({ artifactId: 'memory:one', consumer: 'episode_recall' })).text).toBe('合法第二版');
  expect((await reopened.publication('memory:next'))?.state).toBe('committed');
});

it('T-028 persists intent before stage bytes and fills missing stages only from the same fixed caller input', async () => {
  const f = await fixture(), input = { ...item({ content: 'PREPARED_PRIVATE_CANARY' }), operationId: 'memory:prepare-only' };
  f.failNextPrepare(); await expect(f.registry.publish(input)).rejects.toThrow('durable prepare');
  const prepared = (await f.registry.publication(input.operationId))!; expect(prepared.state).toBe('prepared');
  await expect(readFile(path.join(f.ownerRoot, prepared.items[0]!.stage))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.stringify(prepared)).not.toContain('PREPARED_PRIVATE_CANARY');
  // Metadata alone cannot recreate body bytes or make this object readable.
  await expect(f.registry.recover(input.operationId)).rejects.toBeDefined();
  await expect(f.registry.read({ artifactId: 'memory:one', consumer: 'episode_recall' })).rejects.toBeDefined();
  await f.registry.publish(input);
  expect((await f.registry.read({ artifactId: 'memory:one', consumer: 'episode_recall' })).text).toBe('PREPARED_PRIVATE_CANARY');
});

it('T-031 cancels a source-revoked prepare-only intent without creating private files during cleanup or replay', async () => {
  const f = await fixture();
  const source = await f.registry.publish({ ...item({ artifactId: 'source:raw', kind: 'source_evidence', relativePath: '证据/来源/raw.md',
    producer: { kind: 'host', id: 'message:raw' }, allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence' }), operationId: 'source:raw' });
  const input = { ...item({ sourceRefs: [{ artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash }],
    content: 'NEVER_STAGE_PRIVATE_CANARY' }), operationId: 'memory:revoked-prepare' };
  f.failNextPrepare(); await expect(f.registry.publish(input)).rejects.toThrow('durable prepare');
  await f.registry.revoke(source.artifactId); await f.registry.discardPublishedFiles(input.operationId); await f.registry.purgePublicationStages(input.operationId);
  await expect(f.registry.publish(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(readFile(path.join(f.ownerRoot, '记忆/经历/main/one.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.registry.pendingPublications({ includeRevoked: true, operationPrefix: 'memory:' })).length).toBe(0);
});

it('T-029/T-030 rejects unknown hashes during recovery and anchored ledger tampering', async () => {
  const f = await fixture();
  await f.registry.publish({ ...item(), operationId: 'memory:initial' }); f.failNextCommit();
  await expect(f.registry.publish({ ...item({ expectedRevision: 1, content: '合法第二版' }), operationId: 'memory:next' })).rejects.toThrow();
  await writeFile(path.join(f.ownerRoot, '记忆/经历/main/one.md'), '未知第三版');
  await expect(f.registry.recover('memory:next')).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(path.join(f.ownerRoot, '记忆/经历/main/one.md'), 'utf8')).toBe('未知第三版');
  await writeFile(path.join(f.ownerRoot, '.运行/registry.json'), JSON.stringify({ artifactId: 'forged:persona', kind: 'persona_current', contentHash: 'a'.repeat(64) }));
  expect((await new CompanionArtifactRegistry(f.ownerRoot, owner.id, f.backend).list()).some(artifact => artifact.artifactId === 'forged:persona')).toBe(false);
});

it('T-018 publishes current persona and same-version role guidance with a mandatory host validation fence', async () => {
  const f = await fixture(), created = await f.store.bootstrap(owner);
  const source = await f.registry.publish({ ...item({ artifactId: 'source:feedback', kind: 'source_evidence', producer: { kind: 'host', id: 'message:feedback' },
    relativePath: '证据/来源/feedback.md', allowedConsumers: ['source_verification', 'audit'] }), operationId: 'source:feedback' });
  const validate = vi.fn(async () => undefined), store = new CompanionAssetProfileStore(f.root, { ...f.backend, validatePersonaPublication: validate });
  const next = await store.publishPersona({ companionId: owner.id, conversationId: 'room', operationId: 'persona:second', jobId: 'integration:one', expectedRevision: created.profileRevision,
    profile: { ...created.profile, persona: '经过实践，表达开始更清楚，遇到未知会说明条件。' }, goalRevision: 'goal-v1', promptPolicyRevision: created.promptRevision,
    sourceReadset: [{ artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash }], dependencyVersions: [],
    revocationEpoch: 0, semanticChanges: [{ fragmentId: 'expression', beforeHash: null, afterHash: null, reason: '真实反馈与后续实践' }],
    reason: '真实反馈与后续实践', coverage: ['message:feedback'], visibility: { scope: 'owner' }, noteReadset: [],
    fragments: [{ fragmentId: 'expression', start: 0, end: '经过实践，表达开始更清楚，遇到未知会说明条件。'.length,
      contentHash: companionArtifactHash('经过实践，表达开始更清楚，遇到未知会说明条件。'), sourceRefs: [{ artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash }],
      dependencyRefs: [], visibility: { scope: 'owner' }, disclosure: 'identity_content' }] });
  expect(validate).toHaveBeenCalled(); expect(next.profileRevision).not.toBe(created.profileRevision);
  expect(next.profile.persona).toContain('经过实践');
  expect((await f.registry.read({ artifactId: 'origin:creation', consumer: 'audit' })).text).toContain(owner.persona);
  for (const artifact of (await f.registry.list()).filter(value => value.kind === 'role_guidance'))
    expect((await f.registry.read({ artifactId: artifact.artifactId, consumer: 'role' })).artifact.dependencyRefs)
      .toContainEqual({ artifactId: 'persona:current', contentRevision: 2, contentHash: next.profileRevision });
});

it('T-029/T-031 repairs a revoked file-published proposal using the exact still-current receipt rather than a retired template', async () => {
  const f = await fixture(), initial = await f.store.bootstrap(owner), store = new CompanionAssetProfileStore(f.root,
    { ...f.backend, validatePersonaPublication: async () => undefined });
  const source = await f.registry.publish({ ...item({ artifactId: 'source:pending', kind: 'source_evidence', relativePath: '证据/来源/pending.md',
    producer: { kind: 'host', id: 'message:pending' }, allowedConsumers: ['source_verification', 'audit'] }), operationId: 'source:pending' });
  const sourceRef = { artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash }, persona = 'UNCOMMITTED_PRIVATE_CANARY';
  f.failNextCommit();
  await expect(store.publishPersona({ companionId: owner.id, conversationId: 'room', operationId: 'persona:pending', jobId: 'job:pending',
    expectedRevision: initial.profileRevision, profile: { ...initial.profile, persona }, goalRevision: 'goal', promptPolicyRevision: initial.promptRevision,
    sourceReadset: [sourceRef], dependencyVersions: [], revocationEpoch: 0, semanticChanges: [{ fragmentId: 'change', beforeHash: null, afterHash: companionArtifactHash(persona), reason: '测试未完成发布。' }],
    reason: '测试未完成发布。', coverage: ['pending'], visibility: { scope: 'owner' }, noteReadset: [],
    fragments: [{ fragmentId: 'change', start: 0, end: persona.length, contentHash: companionArtifactHash(persona), sourceRefs: [sourceRef], dependencyRefs: [],
      visibility: { scope: 'audience', audienceIds: ['room'] }, disclosure: 'identity_content' }] })).rejects.toThrow('injected');
  expect((await f.registry.publication('persona:pending'))?.state).toBe('file_published');
  await f.registry.revoke(source.artifactId);
  const repaired = await store.load(owner.id);
  expect(repaired.profile.persona).toBe(initial.profile.persona); expect(repaired.profile.persona).not.toContain('UNCOMMITTED_PRIVATE_CANARY');
  expect((await store.load(owner.id)).profileRevision).toBe(repaired.profileRevision);
  expect(await readdir(path.join(f.ownerRoot, '.运行/发布/暂存'))).toEqual([]);
});

it('requires a real host metadata port and safely locates each memory lane', async () => {
  const f = await fixture();
  await expect(new CompanionArtifactRegistry(f.ownerRoot, owner.id).list()).rejects.toMatchObject({ code: 'BACKEND_REQUIRED' });
  expect(companionMemoryArtifactPath('knowledge', '方法/待验证', 'note:one')).toBe('记忆/知识/note%3Aone.md');
  expect(companionMemoryArtifactPath('self_understanding', 'main', 'one')).toBe('记忆/自我认识/one.md');
  expect(companionMemoryArtifactPath('episode_memory', '原分类', 'one')).toBe(companionMemoryArtifactPath('episode_memory', '新分类', 'one'));
  expect(companionMemoryArtifactPath('episode_memory', 'PRIVATE_NOTEBOOK_CANARY', 'one')).not.toContain('PRIVATE_NOTEBOOK_CANARY');
});
