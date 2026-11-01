import { expect, it } from 'vitest';
import { withCompanionArtifactOperation, withCompanionArtifactResources } from '../../src/main/companions/artifact-publication-locks';

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

it('coordinates case aliases across instances without blocking unrelated paths behind a queued conflict', async () => {
  const held = gate(), entered = gate(), order: string[] = [];
  const first = withCompanionArtifactResources('C:/Registry/Owner', { writePaths: ['Evidence/One.md'] }, async () => { entered.release(); await held.promise; });
  await entered.promise;
  const overlap = withCompanionArtifactResources('c:/registry/OWNER', { writePaths: ['evidence/one.MD'] }, async () => { order.push('overlap'); });
  const independent = withCompanionArtifactResources('C:/REGISTRY/owner', { writePaths: ['.runtime/context/attempt.json'] }, async () => { order.push('independent'); });
  try { await independent; expect(order).toEqual(['independent']); } finally { held.release(); }
  await Promise.all([first, overlap]); expect(order).toEqual(['independent', 'overlap']);
});

it('shares dependency reads while conflicting ancestor paths and writers wait', async () => {
  const held = gate(), entered = gate(), events: string[] = [];
  const first = withCompanionArtifactResources('/owner/reads', { readArtifacts: ['source:one'], readPaths: ['Evidence/one.md'] }, async () => { entered.release(); await held.promise; });
  await entered.promise;
  const parent = withCompanionArtifactResources('/owner/reads', { writePaths: ['evidence'] }, async () => { events.push('parent'); });
  const writer = withCompanionArtifactResources('/owner/reads', { writeArtifacts: ['source:one'] }, async () => { events.push('writer'); });
  const reader = withCompanionArtifactResources('/owner/reads', { readArtifacts: ['source:one'], readPaths: ['evidence/one.md'] }, async () => { events.push('reader'); });
  // A conflicting older writer has priority; another independent reader may
  // still run, but cannot repeatedly overtake that exact queued resource.
  const independent = withCompanionArtifactResources('/owner/reads', { writePaths: ['context/new.json'] }, async () => { events.push('independent'); });
  try { await independent; expect(events).toEqual(['independent']); } finally { held.release(); }
  await Promise.all([first, parent, writer, reader]); expect(events).toContain('reader');
});

it('keeps creation exclusive without nesting its operation identity into the owner barrier', async () => {
  const held = gate(), entered = gate(), events: string[] = [];
  const creation = withCompanionArtifactOperation('/owner/creation', 'create:alice', () => withCompanionArtifactResources('/owner/creation', { exclusiveOwner: true }, async () => { entered.release(); await held.promise; }));
  await entered.promise;
  const regular = withCompanionArtifactResources('/owner/creation', { writeArtifacts: ['context:one'] }, async () => { events.push('regular'); });
  const otherRoot = withCompanionArtifactResources('/another-owner/creation', { writeArtifacts: ['context:one'] }, async () => { events.push('other-root'); });
  try { await otherRoot; expect(events).toEqual(['other-root']); } finally { held.release(); }
  await Promise.all([creation, regular]); expect(events).toEqual(['other-root', 'regular']);
});

it('releases every resource and operation identity after failure', async () => {
  const run = () => withCompanionArtifactOperation('/owner/failure', 'operation', () => withCompanionArtifactResources('/owner/failure', { writeArtifacts: ['same'] }, async () => { throw new Error('expected failure'); }));
  await expect(run()).rejects.toThrow('expected failure');
  await expect(withCompanionArtifactOperation('/owner/failure', 'operation', () => withCompanionArtifactResources('/owner/failure', { writeArtifacts: ['same'] }, async () => 'next'))).resolves.toBe('next');
});

it('fails a same-operation nested wait and conflicting resource upgrade without granting reentrant access', async () => {
  await withCompanionArtifactOperation('/owner/nested', 'publication', async () => {
    await expect(withCompanionArtifactOperation('/owner/nested', 'publication', async () => 'must not run')).rejects.toMatchObject({ code: 'CONFLICT' });
    await withCompanionArtifactResources('/owner/nested', { readArtifacts: ['source'] }, async () => {
      await expect(withCompanionArtifactOperation('/owner/nested', 'cleanup', () => withCompanionArtifactResources('/owner/nested', { writeArtifacts: ['source'] }, async () => 'must not run'))).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(withCompanionArtifactOperation('/owner/nested', 'other-output', () => withCompanionArtifactResources('/owner/nested', { writeArtifacts: ['other-output'] }, async () => 'independent'))).resolves.toBe('independent');
    });
  });
});

it('does not mistake an inherited released ticket for an active lock in a later child continuation', async () => {
  const continueChild = gate(); let child: Promise<string> | undefined;
  await withCompanionArtifactOperation('/owner/later-child', 'publication', () => withCompanionArtifactResources('/owner/later-child', { writeArtifacts: ['same'] }, async () => {
    child = continueChild.promise.then(() => withCompanionArtifactOperation('/owner/later-child', 'publication', () => withCompanionArtifactResources('/owner/later-child', { writeArtifacts: ['same'] }, async () => 'fresh')));
  }));
  continueChild.release(); await expect(child).resolves.toBe('fresh');
});
