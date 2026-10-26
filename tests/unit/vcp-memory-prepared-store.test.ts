import { mkdir, mkdtemp, readdir, readFile, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { VcpPreparedRecallStore } from '../../src/main/vcp-memory/prepared-recall-store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryPreparedPayload } from '../../src/main/vcp-memory/contracts';
const payload: VcpMemoryPreparedPayload = { schema: 'worldlinebox.prepared-recall-payload', groups: [], modelIdentity: 'fixture',
  receipt: { messages: [{ role: 'system', content: '仅本人实际记忆' }], events: [], contextReferences: [], contextReferenceCoverage: 'observed' } };
it('joins concurrent and late hard-scope cleanup after the owner closes its workspace budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-close-withdraw-'));
  const store = new VcpPreparedRecallStore(root);
  try {
    const packet = await store.save('owner-scope', payload);
    const folder = path.join(root, createHash('sha256').update(packet.scopeId).digest('hex'), 'prepared-recalls');
    await Promise.all([store.purgeScope(packet.scopeId), store.close(), store.purgeScope(packet.scopeId)]);
    await store.purgeScope(packet.scopeId);
    expect(await readdir(folder)).toEqual([]); expect(store.snapshot().workspacePackages).toBe(0);
    await expect(store.acquire(packet)).rejects.toThrow('closed');
  } finally { await store.close(); await removeOwnedDirectory(root); }
});
it('shares workspace disk capacity and TTL collection across owners without deleting active packets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-workspace-'));
  const ownerRoot = (owner: string) => path.join(root, owner, '.认知索引', 'generation', 'a'.repeat(64));
  const limits = { workspaceRoot: root, maxPackages: 2, maxBytes: 4096 };
  const alice = new VcpPreparedRecallStore(ownerRoot('alice'), limits), bob = new VcpPreparedRecallStore(ownerRoot('bob'), limits);
  let active: Awaited<ReturnType<VcpPreparedRecallStore['acquire']>> | undefined;
  try {
    const first = await alice.save('alice', payload), second = await bob.save('bob', payload);
    await expect(bob.save('bob', payload)).rejects.toThrow('workspace disk capacity');
    expect(alice.snapshot().workspacePackages).toBe(2); expect(bob.snapshot().workspacePackages).toBe(2);
    active = await alice.acquire(first);
    for (const [folder, handle] of [[ownerRoot('alice'), first], [ownerRoot('bob'), second]] as const) {
      const file = path.join(folder, createHash('sha256').update(handle.scopeId).digest('hex'), 'prepared-recalls', handle.id + '.json');
      const expired = new Date(Date.now() - 11 * 60 * 1000); await utimes(file, expired, expired);
    }
    await bob.prune('bob');
    expect(alice.snapshot().workspacePackages).toBe(1); expect(active.payload).toEqual(payload);
    await bob.save('bob', payload); expect(bob.snapshot().workspacePackages).toBe(2);
    active.release(); active = undefined; await alice.prune('alice'); expect(alice.snapshot().workspacePackages).toBe(1);
  } finally { active?.release(); await alice.close(); await bob.close(); await removeOwnedDirectory(root); }
});
it('reconstructs a workspace byte budget from pre-existing packets after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-disk-restart-'));
  const dataRoot = path.join(root, 'alice', '.认知索引', 'generation', 'a'.repeat(64));
  let store = new VcpPreparedRecallStore(dataRoot, { workspaceRoot: root });
  try {
    const first = await store.save('alice', payload);
    const file = path.join(dataRoot, createHash('sha256').update('alice').digest('hex'), 'prepared-recalls', first.id + '.json');
    const bytes = await readFile(file), measuredBytes = store.snapshot().workspaceBytes;
    await store.close(); await writeFile(file, bytes);
    store = new VcpPreparedRecallStore(dataRoot, { workspaceRoot: root, maxPackages: 8, maxBytes: measuredBytes * 2 - 1 });
    await expect(store.save('alice', payload)).rejects.toThrow('workspace disk capacity');
    expect(store.snapshot().workspaceBytes).toBe(measuredBytes);
    await store.remove(first); await store.save('alice', payload);
    expect(store.snapshot().workspacePackages).toBe(1); expect(store.snapshot().workspaceBytes).toBeLessThan(measuredBytes * 2);
  } finally { await store.close(); await removeOwnedDirectory(root); }
});
it('quarantines an owner directory replaced by a junction without unlinking its external target or blocking a peer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-owner-link-'));
  const external = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-owner-external-'));
  const ownerRoot = (owner: string) => path.join(root, owner, '.认知索引', 'generation', 'a'.repeat(64));
  const alice = new VcpPreparedRecallStore(ownerRoot('alice'), { workspaceRoot: root }), bob = new VcpPreparedRecallStore(ownerRoot('bob'), { workspaceRoot: root });
  let moved = false;
  try {
    const packet = await alice.save('alice', payload), suffix = path.join('.认知索引', 'generation', 'a'.repeat(64), createHash('sha256').update('alice').digest('hex'), 'prepared-recalls', packet.id + '.json');
    const bytes = await readFile(path.join(root, 'alice', suffix));
    const externalFile = path.join(external, suffix); await mkdir(path.dirname(externalFile), { recursive: true }); await writeFile(externalFile, bytes);
    const expired = new Date(Date.now() - 11 * 60 * 1000); await utimes(externalFile, expired, expired);
    await rename(path.join(root, 'alice'), path.join(root, 'saved-alice')); moved = true;
    await symlink(external, path.join(root, 'alice'), process.platform === 'win32' ? 'junction' : 'dir');
    await bob.save('bob', payload);
    expect(await readFile(externalFile)).toEqual(bytes); expect(bob.snapshot().workspaceQuarantinedPackages).toBe(1);
    expect(bob.snapshot().workspacePackages).toBe(2);
  } finally {
    if (moved) { await unlink(path.join(root, 'alice')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await rename(path.join(root, 'saved-alice'), path.join(root, 'alice')); }
    await alice.close(); await bob.close(); await removeOwnedDirectory(root); await removeOwnedDirectory(external);
  }
});
it('persists detached bytes under the real workspace/scope and validates fingerprints after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-store-'));
  try {
    const first = new VcpPreparedRecallStore(root), handle = await first.save('alice:scope', payload);
    const recovered = new VcpPreparedRecallStore(root), lease = await recovered.acquire(handle);
    expect(lease.payload).toEqual(payload); lease.release();
    await expect(recovered.acquire({ ...handle, scopeId: 'bob:scope' })).rejects.toThrow();
    const folder = path.join(root, createHash('sha256').update('alice:scope').digest('hex'), 'prepared-recalls');
    const file = path.join(folder, (await readdir(folder))[0]!);
    const changed = JSON.parse(await readFile(file, 'utf8')); changed.serialized += ' ';
    await writeFile(file, JSON.stringify(changed));
    await expect(recovered.acquire(handle)).rejects.toThrow('fingerprint');
    await recovered.close(); expect(await readdir(folder)).toEqual([]);
  } finally { await removeOwnedDirectory(root); }
});
it('persists a strict credential-free owner/revocation/source-closure manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-owner-'));
  try {
    const store = new VcpPreparedRecallStore(root), hostEvidence = { schema: 'worldlinebox.prepared-recall-host-evidence' as const,
      ownerId: 'alice', revocationEpoch: 3, capturedAt: '2026-10-26T03:04:05Z', sourceClosureDigest: 'a'.repeat(64) };
    const handle = await store.save('alice-view', { ...payload, hostEvidence });
    expect(handle.hostEvidence).toEqual(hostEvidence);
    const restored = await new VcpPreparedRecallStore(root).acquire(handle);
    expect(restored.payload.hostEvidence).toEqual(hostEvidence); restored.release();
    await expect(store.save('alice-view', { ...payload, hostEvidence: { ...hostEvidence, apiKey: 'must-not-persist' } } as never)).rejects.toThrow();
    await expect(store.acquire({ ...handle, hostEvidence: { ...hostEvidence, ownerId: 'bob' } })).rejects.toThrow('fingerprint');
    await store.close();
  } finally { await removeOwnedDirectory(root); }
});
it('keeps focus claims exclusive and asset closure purges all owned packages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-claims-'));
  try {
    const store = new VcpPreparedRecallStore(root), handle = await store.save('alice', payload);
    const lease = await store.acquire(handle);
    await expect(store.acquire(handle)).rejects.toThrow('already'); lease.release();
    const other = new VcpPreparedRecallStore(root), crossInstance = await store.acquire(handle);
    await expect(other.acquire(handle)).rejects.toThrow('already');
    await other.remove(handle); crossInstance.release();
    const preserved = await other.acquire(handle); preserved.release();
    await store.close(); await expect(store.acquire(handle)).rejects.toThrow();
    expect(store.snapshot().residentBytes).toBeLessThanOrEqual(store.snapshot().maxResidentBytes);
  } finally { await removeOwnedDirectory(root); }
});
it('rejects an ancestor junction before creating anything in its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-link-'));
  const external = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-link-target-'));
  try {
    await symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const store = new VcpPreparedRecallStore(path.join(root, 'linked', 'not-created'));
    await expect(store.save('alice', payload)).rejects.toThrow('unlinked');
    expect(await readdir(external)).toEqual([]);
  } finally { await removeOwnedDirectory(root); await removeOwnedDirectory(external); }
});
it('charges active serialized bodies globally while queued candidates remain on disk and can be cancelled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-budget-'));
  try {
    const store = new VcpPreparedRecallStore(root), other = new VcpPreparedRecallStore(root);
    const large = { ...payload, receipt: { ...payload.receipt, messages: [{ role: 'system', content: 'x'.repeat(18 * 1024 * 1024) }] } };
    const first = await store.save('alice', large), second = await other.save('bob', large);
    const lease = await store.acquire(first);
    const controller = new AbortController();
    const waiting = other.acquire(second, controller.signal);
    const rejected = expect(waiting).rejects.toThrow('cancelled');
    for (let attempt = 0; attempt < 100 && !store.snapshot().bodyWaiters; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(store.snapshot().activeBodies).toBe(1); expect(store.snapshot().bodyWaiters).toBe(1);
    expect(store.snapshot().residentBytes + store.snapshot().activeBodyBytes).toBeLessThanOrEqual(store.snapshot().maxResidentBytes);
    controller.abort(new Error('cancelled')); await rejected;
    lease.release();
    const resumed = await other.acquire(second); expect(resumed.payload).toEqual(large); resumed.release();
    expect(store.snapshot().activeBodies).toBe(0);
    await store.close(); await other.close();
  } finally { await removeOwnedDirectory(root); }
});
it('admits an oversized legal body alone and advances the queue after its reference releases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-prepared-oversized-'));
  try {
    const store = new VcpPreparedRecallStore(root);
    const first = await store.save('small-first', payload), last = await store.save('small-last', payload);
    const large = await store.save('large', { ...payload, receipt: { ...payload.receipt,
      messages: [{ role: 'system', content: 'x'.repeat(33 * 1024 * 1024) }] } });
    const initial = await store.acquire(first);
    const awaitingLarge = store.acquire(large);
    for (let attempt = 0; attempt < 100 && !store.snapshot().bodyWaiters; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    let lastReady = false;
    const awaitingLast = store.acquire(last).then(lease => { lastReady = true; return lease; });
    expect(store.snapshot().activeBodies).toBe(1); initial.release();
    const oversized = await awaitingLarge;
    expect(store.snapshot().oversizedBody).toBe(true); expect(store.snapshot().activeBodies).toBe(1); expect(lastReady).toBe(false);
    expect(String(oversized.payload.receipt.messages[0]!.content)).toHaveLength(33 * 1024 * 1024);
    oversized.release(); const final = await awaitingLast;
    expect(store.snapshot().oversizedBody).toBe(false); expect(lastReady).toBe(true); final.release();
    await store.close();
  } finally { await removeOwnedDirectory(root); }
});
