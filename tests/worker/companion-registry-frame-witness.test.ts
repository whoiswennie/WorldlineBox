import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionArtifact } from '../../src/shared/companion-artifact';
import { companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import { createCompanionExecutionValidationSession, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.close(); });

async function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const source = f.source('同一条真实原始来源，分别支持两条正式笔记。');
  const notes = [f.record('第一条有据的正式笔记。', [source.id]), f.record('第二条有据的正式笔记。', [source.id])];
  await f.publish();
  const registry = await f.artifacts('alice');
  const records = await Promise.all(notes.map(note => registry.findByPath(companionMemoryRegisteredPath(note))));
  if (records.some(record => !record)) throw new Error('Canonical fixture did not publish both formal notes.');
  const artifacts = records as CompanionArtifact[];
  expect(artifacts[0]!.sourceRefs.some(ref => artifacts[1]!.sourceRefs.some(other => JSON.stringify(ref) === JSON.stringify(other)))).toBe(true);
  const inputs = artifacts.map(artifact => ({ artifactId: artifact.artifactId, consumer: 'episode_recall' as const }));
  const bytes = vi.spyOn(registry as unknown as { bytes(relative: string): Promise<Buffer> }, 'bytes');
  f.commands.length = 0;
  const mutate = (artifact: CompanionArtifact, operation: (current: CompanionArtifact) => CompanionArtifact) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    try {
      const found = db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get('alice', artifact.artifactId) as { metadata: string };
      const next = operation(JSON.parse(found.metadata) as CompanionArtifact);
      db.prepare('UPDATE companion_artifacts SET metadata=? WHERE owner_id=? AND artifact_id=?').run(JSON.stringify(next), 'alice', artifact.artifactId);
    } finally { db.close(); }
  };
  return { f, registry, artifacts, inputs, bytes, mutate };
}

it('admits shared canonical metadata and refs once per finite frame, reopens every body, and finishes with fresh batch fences', async () => {
  const { f, registry, inputs, bytes } = await fixture();
  await withCompanionExecutionValidation(async () => {
    const first = await registry.readMany(inputs);
    for (let i = 0; i < 6; i++) expect((await registry.readMany(inputs)).map(item => item.text)).toEqual(first.map(item => item.text));
    expect(bytes).toHaveBeenCalledTimes(14);
    expect(f.commands.filter(command => command.type === 'cognition.registry.read')).toHaveLength(1);
    expect(f.commands.filter(command => command.type === 'cognition.registry.refs.validate')).toHaveLength(1);
  });
  expect(bytes).toHaveBeenCalledTimes(16); // Two fresh final file witnesses.
  expect(f.commands.filter(command => command.type === 'cognition.registry.read')).toHaveLength(3);
  expect(f.commands.filter(command => command.type === 'cognition.registry.refs.validate')).toHaveLength(3);
  // The next independent gate does not retain the previous admission ledger.
  f.commands.length = 0;
  await registry.readMany(inputs);
  expect(f.commands.filter(command => command.type === 'cognition.registry.read')).toHaveLength(3);
  expect(f.commands.filter(command => command.type === 'cognition.registry.refs.validate')).toHaveLength(3);
});

it('keeps the first semantic admission across an unrelated real audit publication in the same gate', async () => {
  const { f, registry, artifacts, inputs, bytes } = await fixture();
  const ids = new Set(artifacts.map(artifact => artifact.artifactId)), paths = new Set(artifacts.map(artifact => artifact.relativePath));
  const metadataReads = () => f.commands.filter(command => command.type === 'cognition.registry.read'
    && command.artifactIds?.length === ids.size && command.artifactIds.every(id => ids.has(id)));
  const referenceReads = () => f.commands.filter(command => command.type === 'cognition.registry.refs.validate');
  const bodyReads = () => bytes.mock.calls.filter(([relative]) => paths.has(relative));
  await withCompanionExecutionValidation(async () => {
    const first = await registry.readMany(inputs);
    await registry.publish({ artifactId: 'context:audit_unrelated', kind: 'context_snapshot', relativePath: '.运行/上下文/unrelated/attempt.json',
      producer: { kind: 'host', id: 'provider-transport' }, expectedRevision: null, content: '{"status":"prepared"}',
      sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral',
      operationId: 'context:prepare:unrelated' });
    expect((await registry.readMany(inputs)).map(item => item.text)).toEqual(first.map(item => item.text));
    expect(metadataReads()).toHaveLength(1); expect(referenceReads()).toHaveLength(1);
    expect(bodyReads()).toHaveLength(4); // Both semantic bodies are reopened.
  });
  expect(metadataReads()).toHaveLength(3); expect(referenceReads()).toHaveLength(3);
  expect(bodyReads()).toHaveLength(6); // Both final canonical file witnesses.
});

it.each(['consumer', 'audience', 'references'] as const)('rejects a second SQLite writer changing %s before the finite frame returns', async change => {
  const { registry, artifacts, inputs, mutate } = await fixture();
  await expect(withCompanionExecutionValidation(async () => {
    await registry.readMany(inputs);
    mutate(artifacts[0]!, current => change === 'consumer' ? { ...current, allowedConsumers: ['audit'] }
      : change === 'audience' ? { ...current, visibility: { scope: 'audience', audienceIds: ['another_room'] } }
        : { ...current, sourceRefs: [] });
  })).rejects.toMatchObject({ code: 'CHANGED' });
  if (change !== 'references') await expect(registry.readMany(inputs)).rejects.toMatchObject({ code: 'DENIED' });
});

it('rejects a shared source withdrawn by another SQLite connection before the final reference fence', async () => {
  const { f, registry, artifacts, inputs } = await fixture();
  const reference = artifacts[0]!.sourceRefs.find(ref => artifacts[1]!.sourceRefs.some(other => JSON.stringify(ref) === JSON.stringify(other)))!;
  await expect(withCompanionExecutionValidation(async () => {
    await registry.readMany(inputs);
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    try {
      db.prepare("UPDATE companion_artifacts SET state='revoked',metadata=json_set(metadata,'$.publicationState','revoked') WHERE owner_id=? AND artifact_id=?")
        .run('alice', reference.artifactId);
    } finally { db.close(); }
  })).rejects.toMatchObject({ code: 'DENIED' });
  await expect(registry.readMany(inputs)).rejects.toMatchObject({ code: 'DENIED' });
});

it.each([false, true])('rejects an external same-size and same-mtime canonical edit at the final fence (reread=%s)', async reread => {
  const { f, registry, artifacts, inputs } = await fixture(), file = f.file(artifacts[0]!.relativePath);
  await expect(withCompanionExecutionValidation(async () => {
    await registry.readMany(inputs);
    const original = await readFile(file), stamp = await stat(file), replacement = Buffer.from(original);
    replacement[replacement.length - 1] = replacement[replacement.length - 1] === 10 ? 32 : 10;
    expect(replacement.length).toBe(original.length); await writeFile(file, replacement); await utimes(file, stamp.atime, stamp.mtime);
    if (reread) await registry.readMany(inputs);
  })).rejects.toMatchObject({ code: 'CHANGED' });
  await expect(registry.readMany(inputs)).rejects.toMatchObject({ code: 'CHANGED' });
});

it('does not reuse or start body work after cancellation or closing an explicit finite session', async () => {
  const { registry, inputs, bytes } = await fixture(), controller = new AbortController();
  const session = createCompanionExecutionValidationSession(controller.signal);
  try {
    await session.run(() => registry.readMany(inputs)); expect(bytes).toHaveBeenCalledTimes(2);
    const reason = new Error('stop_registry_witness_task'); controller.abort(reason);
    await expect(session.run(() => registry.readMany(inputs))).rejects.toBe(reason);
    expect(() => session.validate()).toThrow(reason); expect(bytes).toHaveBeenCalledTimes(2);
  } finally { session.close(); }
  const closed = createCompanionExecutionValidationSession(); closed.close();
  await expect(closed.run(() => registry.readMany(inputs))).rejects.toMatchObject({ name: 'AbortError' });
  await expect(closed.validate()).rejects.toMatchObject({ name: 'AbortError' });
  expect(bytes).toHaveBeenCalledTimes(2);
});
