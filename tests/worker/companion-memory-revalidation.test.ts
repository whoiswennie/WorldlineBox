import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionArtifactPublish } from '../../src/main/companions/artifact-registry';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
it('requires a newer formal automatic capture and live original sources before revalidating a retired memory identity', async () => {
  const f = managedMemoryFiles(); fixtures.push(f);
  const b = f.source('B independent lawful source'), original = f.record(b.content, [b.id]); await f.publish();
  const a = f.source('A PRIVATE_MUST_NOT_RETURN');
  f.store.request({ type: 'memory.revise', ...f.scope, id: original.id, expectedVersion: original.version,
    candidate: f.candidate(b.content + a.content, [b.id, a.id]) }); await f.publish();
  const registry = await f.artifacts('alice'), previous = (await registry.get(`memory:${original.id}`))!;
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [a.id] }); await f.publish(); await f.library.purgeRevoked('alice');
  const input: CompanionArtifactPublish = { artifactId: previous.artifactId, kind: previous.kind, expectedRevision: previous.contentRevision,
    relativePath: previous.relativePath, content: b.content, producer: { kind: 'system', id: 'memory-commit' },
    sourceRefs: previous.sourceRefs.filter(reference => reference.artifactId.startsWith(`source:${b.id}:`)), dependencyRefs: [],
    allowedConsumers: previous.allowedConsumers, retentionClass: 'current', visibility: { scope: 'owner' } };
  await expect(registry.publish({ ...input, operationId: 'ordinary-revive-' + randomUUID() })).rejects.toThrow('撤回');
  await expect(registry.publishRevalidatedMemory({ ...input, operationId: `memory:${original.id}:r4:0000000000000000` }, async () => undefined))
    .rejects.toThrow('新捕获版本');
  const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  expect(job.sourceMessageIds).toEqual([b.id]);
  const restored = f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken,
    notes: [f.candidate(b.content, [b.id])] }).memories![0]!;
  expect(restored.id).toBe(original.id);
  let rejectedCyclePackages = 0;
  f.intercept(async command => {
    if (command.type !== 'cognition.registry.publication.prepare' || command.publication.authorization !== 'memory_revalidation') return;
    const match = /^memory-file:([a-zA-Z0-9_-]+):cycle:(\d+)$/u.exec(command.publication.operationId);
    if (!match) throw new Error('Actual file publisher did not bind its durable history job and retry cycle');
    for (const operationId of [`memory-file:${match[1]}:cycle:${Number(match[2]) + 1}`, `memory-file:${randomUUID()}:cycle:${match[2]}`]) {
      const forged = structuredClone(command.publication); forged.operationId = operationId;
      for (const item of forged.items) item.next.operationId = operationId;
      const before=await registry.get(previous.artifactId,true);
      expect(before?.publicationState).toBe('revoked');
      expect(() => f.store.request({ type: 'cognition.registry.publication.prepare', ownerId: 'alice', publication: forged })).toThrow(Error);
      expect(await registry.get(previous.artifactId,true)).toEqual(before);
      rejectedCyclePackages++;
    }
  });
  await f.publish(); f.intercept();
  const publicationJobs=(['source_files','history_files'] as const).map(kind=>f.store.request({type:'jobs.page',ownerId:'alice',kind,limit:50}).jobPage);
  expect(rejectedCyclePackages,JSON.stringify(publicationJobs)).toBe(2);
  const current = await registry.read({ artifactId: previous.artifactId, consumer: 'episode_recall' });
  expect(current.text).toBe(b.content); expect(current.artifact.contentRevision).toBeGreaterThan(previous.contentRevision);
  expect(current.text).not.toContain(a.content);
  await expect(f.history.read(f.scope, original.id, 2)).rejects.toThrow();
  expect(f.store.getMessage(a.id).content).toBe(a.content);
  f.store.request({ type: 'memory.forget', ...f.scope, id: original.id }); await f.publish(); await f.library.purgeRevoked('alice');
  await expect(f.history.read(f.scope, original.id, 1)).rejects.toThrow();
  await expect(registry.publishRevalidatedMemory({ ...input, expectedRevision: current.artifact.contentRevision,
    operationId: `memory:${original.id}:r6:0000000000000000` }, async () => undefined)).rejects.toThrow('新捕获版本');
});
