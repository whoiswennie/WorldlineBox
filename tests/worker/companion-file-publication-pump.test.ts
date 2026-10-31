import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: {}, utilityProcess: { fork: vi.fn() } }));
type Pump = { closed: boolean; filePublicationPolling?: Promise<void>; filePublicationPumps: Map<string, Promise<void>>;
  resettingCompanions: Set<string>; pumpPendingMemoryFiles(): Promise<void> };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(ownerCount = 6, backloggedOwners = 4) {
  const root = mkdtempSync(path.join(tmpdir(), 'wlbox-file-pump-'));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlbox-file-pump-')) throw new Error('Unexpected fixture');
  const ownerIds = Array.from({ length: ownerCount }, (_, index) => 'owner' + (ownerCount > 6 ? String(index + 1).padStart(3, '0') : index + 1));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ownerIds.map(id => ({ id, name: id, description: '', persona: '保存有出处的经历。',
    avatar: 'sister', model: '', active: true, proactive: false })));
  const commands: CompanionStorageCommand[] = [], reports: unknown[] = [], releases: Array<() => void> = [];
  let intercept: ((command: CompanionStorageCommand, response: CompanionStorageResponse) => Promise<void>) | undefined;
  const request = async (command: CompanionStorageCommand) => { commands.push(command); const response = store.request(command); await intercept?.(command, response); return response; };
  for (const owner of ownerIds) mkdirSync(path.join(root, 'owners', owner), { recursive: true });
  const library = new CompanionMemoryLibrary({ libraryDirectory: path.join(root, 'owners'), artifacts: async owner => new CompanionArtifactRegistry(path.join(root, 'owners', owner), owner,
    { registryStorage: { request } }), request });
  const sources = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library }), io = new CompanionAssetIo();
  // Exercise the production Main pump methods with actual producer/storage
  // ports. Constructing the unrelated UI/model services adds no evidence to
  // this scheduling test; there is no Native/model transport in this fixture.
  const host = Object.assign(Object.create(CompanionService.prototype) as Pump, { closed: false, sourceFiles: sources, historyFiles: history,
    filePublicationPumps: new Map<string, Promise<void>>(), resettingCompanions: new Set<string>(), assetIo: io,
    storage: { request }, memory: { schedule: vi.fn() }, options: { report: (error: unknown) => reports.push(error) } });
  const notes = ownerIds.map(owner => {
    const conversationId = store.openPrivate(owner).id, source = store.appendMessage({ conversationId, authorId: 'user', content: owner + ' 的原始经历。', replyDirective: 'none' });
    const note = store.request({ type: 'memory.record', companionId: owner, conversationId, candidate: { artifactKind: 'episode_memory', content: owner + ' 的有出处记忆。',
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
    if (ownerIds.indexOf(owner) < backloggedOwners) {
      // A live lease alone is excluded by SQL already. The real starvation
      // case has additional older due work behind each blocked publisher.
      const queued = store.appendMessage({ conversationId, authorId: 'user', content: owner + ' 仍有连续到来的后续原事件。', replyDirective: 'none' });
      store.request({ type: 'memory.record', companionId: owner, conversationId, candidate: { artifactKind: 'episode_memory', content: queued.content,
        sourceMessageIds: [queued.id], evidence: [{ sourceMessageId: queued.id, quote: queued.content }] } });
    }
    return { owner, conversationId, source, note };
  });
  cleanup.push(async () => { host.closed = true; for (const release of releases) release(); await io.close(); await library.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { host, notes, store, sources, history, io, reports, commands, releases,
    intercept: (callback: NonNullable<typeof intercept>) => { intercept = callback; } };
}

it('starts later real owners while the first four actual publishers remain blocked, without duplicate claims', async () => {
  const f = fixture(), blocked = deferred(), release = deferred(); f.releases.push(release.resolve);
  const claims = new Map<string, number>();
  f.intercept(async (command, response) => {
    if (command.type !== 'memory.sources.outbox.claim' || !response.memorySourceOutbox) return;
    const owner = response.memorySourceOutbox.companionId; claims.set(owner, (claims.get(owner) ?? 0) + 1);
    if (f.notes.slice(0, 4).some(note => note.owner === owner)) {
      if (f.notes.slice(0, 4).every(note => claims.has(note.owner))) blocked.resolve();
      await release.promise;
    }
  });
  await f.host.pumpPendingMemoryFiles(); await blocked.promise;
  expect([...f.host.filePublicationPumps.keys()]).toEqual(['owner1', 'owner2', 'owner3', 'owner4']);
  await f.host.pumpPendingMemoryFiles();
  const later = ['owner5', 'owner6'].map(owner => f.host.filePublicationPumps.get(owner));
  expect(later.every(Boolean)).toBe(true); // Deterministic before releasing 1–4.
  await Promise.all(later);
  for (const { owner, conversationId, note } of f.notes.slice(4)) {
    expect((await f.history.read({ companionId: owner, conversationId }, note.id, note.contentRevision!)).content).toBe(note.content);
  }
  for (const { owner } of f.notes.slice(0, 4)) expect(claims.get(owner)).toBe(1);
  const polls = f.commands.filter(command => command.type === 'memory.sources.outbox.owners' || command.type === 'memory.history.outbox.owners');
  expect(polls.slice(2).every(command => 'excludedOwners' in command && f.notes.slice(0, 4).every(note => command.excludedOwners?.includes(note.owner)))).toBe(true);
  expect(f.reports).toEqual([]);
});

it('coalesces blocked metadata polls, permits the next poll, and drains an in-flight poll on close without starting publishers', async () => {
  const f = fixture(), firstEntered = deferred(), firstRelease = deferred(); f.releases.push(firstRelease.resolve);
  let metadataCalls = 0;
  f.intercept(async command => {
    if (command.type !== 'memory.sources.outbox.owners' && command.type !== 'memory.history.outbox.owners') return;
    metadataCalls++; if (metadataCalls === 2) firstEntered.resolve(); await firstRelease.promise;
  });
  const first = f.host.pumpPendingMemoryFiles(), repeated = f.host.pumpPendingMemoryFiles();
  expect(repeated).toBe(first); await firstEntered.promise;
  expect(metadataCalls).toBe(2);
  firstRelease.resolve(); await first;
  const secondEntered = deferred(), secondRelease = deferred(); f.releases.push(secondRelease.resolve);
  f.intercept(async command => {
    if (command.type !== 'memory.sources.outbox.owners' && command.type !== 'memory.history.outbox.owners') return;
    metadataCalls++; if (metadataCalls === 4) secondEntered.resolve(); await secondRelease.promise;
  });
  const second = f.host.pumpPendingMemoryFiles(); await secondEntered.promise;
  expect(metadataCalls).toBe(4); expect(f.host.pumpPendingMemoryFiles()).toBe(second);
  f.host.closed = true; let closed = false;
  const closing = f.io.close().then(() => { closed = true; });
  await f.host.pumpPendingMemoryFiles(); await Promise.resolve(); expect(metadataCalls).toBe(4); expect(closed).toBe(false);
  secondRelease.resolve(); await second; await closing;
  expect(closed).toBe(true); expect(f.reports).toEqual([]);
});

it('rotates beyond a truncated 128-owner exclusion list while 132 real leases retain older due work', async () => {
  const f = fixture(134, 132), held = deferred(); f.releases.push(held.resolve);
  const active = f.notes.slice(0, 132).map(({ owner }) => {
    const job = f.store.request({ type: 'memory.sources.outbox.claim', companionId: owner }).memorySourceOutbox!;
    expect(job).toBeDefined();
    // Controlled live Main tasks paired to the actual fixed SQL leases. No
    // model, 132-way filesystem stress or pretend completion is involved.
    f.host.filePublicationPumps.set(owner, held.promise); return job;
  });
  await f.host.pumpPendingMemoryFiles();
  expect(f.host.filePublicationPumps.has('owner133')).toBe(false);
  expect(f.commands.filter(command => command.type === 'memory.sources.outbox.owners').at(-1)).toMatchObject({ excludedOwners: expect.not.arrayContaining(['owner001']) });
  await f.host.pumpPendingMemoryFiles();
  const later = ['owner133', 'owner134'].map(owner => f.host.filePublicationPumps.get(owner));
  expect(later.every(Boolean)).toBe(true); await Promise.all(later);
  for (const { owner, conversationId, note } of f.notes.slice(132)) expect((await f.history.read({ companionId: owner, conversationId }, note.id, note.contentRevision!)).content).toBe(note.content);
  for (const job of active) expect(f.store.request({ type: 'memory.sources.outbox.check', id: job.id, leaseToken: job.leaseToken }).memorySourceOutboxAccepted).toBe(true);
  expect(f.reports).toEqual([]);
}, 30000);
