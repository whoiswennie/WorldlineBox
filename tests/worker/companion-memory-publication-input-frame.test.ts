import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionArtifactPublish } from '../../src/main/companions/artifact-registry';
import { createMemoryPublicationValidation } from '../../src/main/companions/memory-publication-jobs';
import { companionMemorySourceArtifactId } from '../../src/main/companions/memory-source-files';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); });
const output = (id: string, overrides: Partial<CompanionArtifactPublish> = {}): CompanionArtifactPublish => ({ artifactId: id,
  kind: 'context_snapshot', producer: { kind: 'host', id: 'publication-input-test' }, relativePath: '.运行/上下文/' + id + '/request.json',
  expectedRevision: null, content: '正式输出第一版。', sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' },
  allowedConsumers: ['audit'], retentionClass: 'ephemeral', ...overrides });

async function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const source = f.source('真实不可随意修改的输入依据。'), note = f.record('由真实依据形成的正式记忆。', [source.id]); await f.publish();
  const registry = await f.artifacts('alice'), sourceId = companionMemorySourceArtifactId(source.id, 1), artifact = (await registry.get(sourceId))!;
  const reference = { artifactId: artifact.artifactId, contentRevision: artifact.contentRevision, contentHash: artifact.contentHash };
  return { f, source, note, registry, sourceId, artifact, reference };
}

it('shares only immutable input bytes across all five callbacks, keeps live SQL checks, and never witnesses the old output as its own input', async () => {
  const t = await fixture(), initial = await t.registry.publish({ ...output('frame-output'), operationId: 'frame-output:initial' });
  await t.registry.read({ artifactId: initial.artifactId, consumer: 'audit' });
  const bytes = vi.spyOn(t.registry as unknown as { bytes(relative: string): Promise<Buffer> }, 'bytes'); let checks = 0;
  const validation = createMemoryPublicationValidation(async () => {
    checks++;
    const current = t.f.store.request({ type: 'memory.sources.filter', ...t.f.scope, ids: [t.source.id] }).memorySources;
    expect(current?.some(source => source.id === t.source.id && source.content === t.source.content)).toBe(true);
    await t.registry.read({ artifactId: t.sourceId, consumer: 'source_verification', audienceIds: [t.f.scope.conversationId] });
  });
  try {
    const next = await t.registry.publish({ ...output('frame-output', { expectedRevision: initial.contentRevision, content: '正式输出第二版。', sourceRefs: [t.reference] }), operationId: 'frame-output:next' }, validation.validate);
    expect(next.contentRevision).toBe(2); expect(checks).toBe(5);
    expect(bytes.mock.calls.filter(([relative]) => relative === t.artifact.relativePath)).toHaveLength(2);
    expect((await t.registry.read({ artifactId: next.artifactId, consumer: 'audit' })).text).toBe('正式输出第二版。');
  } finally { validation.close(); }
  const again = createMemoryPublicationValidation(async () => { await t.registry.read({ artifactId: t.sourceId, consumer: 'audit' }); });
  try { await t.registry.publish({ ...output('separate-output', { sourceRefs: [t.reference] }), operationId: 'separate-output:publish' }, again.validate); }
  finally { again.close(); }
  expect(bytes.mock.calls.filter(([relative]) => relative === t.artifact.relativePath)).toHaveLength(4);
});

it('rejects a same-mtime input byte edit at the commit phase before any formal output becomes visible', async () => {
  const t = await fixture(), operationId = 'frame:byte-change'; let changed = false;
  t.f.intercept(command => {
    if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'file_published' && !changed) {
      changed = true; const file = t.f.file(t.artifact.relativePath), stamp = statSync(file);
      writeFileSync(file, t.source.content.replace('真', '伪')); utimesSync(file, stamp.atime, stamp.mtime);
    }
  });
  const validation = createMemoryPublicationValidation(async () => { await t.registry.read({ artifactId: t.sourceId, consumer: 'audit' }); });
  try { await expect(t.registry.publish({ ...output('byte-change', { sourceRefs: [t.reference] }), operationId }, validation.validate)).rejects.toMatchObject({ code: 'CHANGED' }); }
  finally { validation.close(); }
  expect(changed).toBe(true); expect((await t.registry.publication(operationId))?.state).toBe('file_published');
  expect(await t.registry.get('byte-change')).toBeUndefined();
  expect(t.f.commands.some(command => command.type === 'cognition.registry.publication.commit' && command.operationId === operationId)).toBe(false);
  await expect(t.registry.read({ artifactId: 'byte-change', consumer: 'audit' })).rejects.toMatchObject({ code: 'UNREGISTERED' });
});

it('keeps an aborted final input fence uncommitted and retains its durable recovery intent', async () => {
  const t = await fixture(), controller = new AbortController(), operationId = 'frame:cancel'; let actual: Promise<unknown> | undefined;
  t.f.intercept(command => { if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'file_published') controller.abort(); });
  const host = withCompanionExecutionValidation(() => {
    const validation = createMemoryPublicationValidation(async () => { await t.registry.read({ artifactId: t.sourceId, consumer: 'audit' }); });
    actual = t.registry.publish({ ...output('cancelled-output', { sourceRefs: [t.reference] }), operationId }, validation.validate).finally(() => validation.close());
    return actual;
  }, controller.signal);
  await expect(host).rejects.toBeDefined(); await expect(actual).rejects.toBeDefined();
  expect((await t.registry.publication(operationId))?.state).toBe('file_published'); expect(await t.registry.get('cancelled-output')).toBeUndefined();
  expect(t.f.commands.some(command => command.type === 'cognition.registry.publication.commit' && command.operationId === operationId)).toBe(false);
});

it('keeps the real source lease and source withdrawal check authoritative after the input window has sealed', async () => {
  const f = managedMemoryFiles(); fixtures.push(f); const source = f.source('随后撤回的真实输入。'); f.record('不能脱离来源发布。', [source.id]); let withdrawn = false;
  const execute = f.store.request.bind(f.store), outcomes: string[] = [];
  vi.spyOn(f.store, 'request').mockImplementation(command => {
    const sourceCommit = command.type === 'cognition.registry.publication.commit' && command.operationId.startsWith('source-file:');
    try { const response = execute(command); if (sourceCommit) outcomes.push(response.registryPublication?.state ?? 'missing'); return response; }
    catch (error) { if (sourceCommit) outcomes.push('rejected'); throw error; }
  });
  f.intercept(command => {
    if (command.type === 'cognition.registry.publication.commit' && command.operationId.startsWith('source-file:') && !withdrawn) {
      withdrawn = true; expect(f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] }).ok).toBe(true);
    }
  });
  await f.sources.flush('alice'); expect(withdrawn).toBe(true); expect(outcomes).toEqual(['rejected']);
  const registry = await f.artifacts('alice'); expect(await registry.get(companionMemorySourceArtifactId(source.id, 1))).toBeUndefined();
  await expect(registry.read({ artifactId: companionMemorySourceArtifactId(source.id, 1), consumer: 'audit' })).rejects.toBeDefined();
  const packages = await registry.pendingPublications({ operationPrefix: 'source-file:', includeRevoked: true });
  expect(packages.every(publication => publication.state !== 'committed')).toBe(true);
});

it('does not commit a history file after its official durable job is abandoned before the final phase', async () => {
  const f = managedMemoryFiles(); fixtures.push(f); const source = f.source('有真实租约的历史输入。'), note = f.record('将停止发布的历史修订。', [source.id]); await f.sources.flush('alice'); let stopped = false;
  f.intercept(command => {
    if (command.type !== 'cognition.registry.publication.transition' || !command.operationId.startsWith('history-file:') || command.nextState !== 'file_published' || stopped) return;
    stopped = true; const jobId = /^history-file:([^:]+):cycle:/u.exec(command.operationId)![1]!;
    const job = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'history_files', id: jobId }).jobDisposition!;
    expect(f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'history_files', id: jobId, inputVersion: job.inputVersion,
      expectedRevision: job.revision, operationId: randomUUID(), action: 'abandon' }).jobDisposition?.state).toBe('abandoned');
  });
  const result = await f.history.flush('alice'); expect(stopped).toBe(true); expect(result.completed).toBe(0);
  const registry = await f.artifacts('alice'); expect(await registry.get(`history:${note.id}:r${note.contentRevision}`)).toBeUndefined();
  expect(await registry.get(`memory:${note.id}`)).toBeUndefined();
});

it('keeps current-memory replacement successful without sharing its old output body in the input window', async () => {
  const t = await fixture();
  const next = t.f.store.request({ type: 'memory.revise', ...t.f.scope, id: t.note.id, expectedVersion: t.note.version,
    candidate: t.f.candidate('由同一真实依据合法形成的新正文。', [t.source.id]) }).memories![0]!;
  await t.f.publish();
  const current = await (await t.f.artifacts('alice')).read({ artifactId: 'memory:' + t.note.id, consumer: 'audit' });
  expect(current.text).toBe(next.content); expect(readFileSync(t.f.noteFile(next), 'utf8')).toBe(next.content);
});

it('fails a nested final withdrawal cleanup instead of waiting on its own read lock, then permits fresh cleanup after release', async () => {
  const t = await fixture(), validation = createMemoryPublicationValidation(async () => {
    await t.registry.read({ artifactId: t.sourceId, consumer: 'audit' });
  });
  try {
    await expect(t.registry.publish({ ...output('nested-withdrawal', { sourceRefs: [t.reference] }), operationId: 'nested:withdrawal' }, async phase => {
      await validation.validate(phase);
      if (phase === 'commit') {
        await t.registry.revoke(t.sourceId);
        await (await t.f.artifacts('alice')).purgeRevokedBody(t.sourceId);
      }
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally { validation.close(); }
  expect(await t.registry.get('nested-withdrawal')).toBeUndefined();
  expect((await t.registry.publication('nested:withdrawal'))?.state).toBe('revoked');
  await expect((await t.f.artifacts('alice')).purgeRevokedBody(t.sourceId)).resolves.toEqual({ removed: true });
});
