import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-creation-')) throw new Error('Unexpected creation fixture cleanup.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-creation-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'); let store = new CompanionsStore(file); stores.add(store);
  const profiles = () => new CompanionAssetProfileStore(path.join(root, 'owner-files'), { registryStorage: { request: async command => store.request(command) } });
  const input = { type: 'companion.creation.prepare' as const, operationId: randomUUID(), companionId: randomUUID(),
    request: { kind: 'custom' as const, companion: { name: '海岚', description: '只能创建时写入', persona: '先理解对方，再表达有依据的不同意见。', model: '', avatar: 'custom' as const, proactive: false } } };
  return { root, file, input, profiles, get store() { return store; },
    reopen() { store.close(); stores.delete(store); store = new CompanionsStore(file); stores.add(store); } };
}
it('keeps pending identities unavailable, publishes real origin files, and exposes exactly one committed identity', async () => {
  const f = fixture(), prepared = f.store.request(f.input);
  expect(prepared.creation?.state).toBe('prepared'); expect(f.store.state().companions).toEqual([]);
  expect(() => f.store.openPrivate(f.input.companionId)).toThrow('尚未提交');
  expect(() => f.store.request({ type: 'companion.creation.commit', operationId: f.input.operationId })).toThrow('尚未正式发布');
  const profiles = f.profiles(), snapshot = await profiles.bootstrap(prepared.companion!);
  const committed = f.store.request({ type: 'companion.creation.commit', operationId: f.input.operationId });
  expect(committed.creation?.state).toBe('committed'); expect(f.store.state().companions.map(owner => owner.id)).toEqual([f.input.companionId]);
  expect(snapshot.profile.persona).toBe(f.input.request.companion.persona);
  const origin = readFileSync(path.join(snapshot.root, '演化', '起点', 'creation.md'), 'utf8'); expect(origin).toContain(f.input.request.companion.persona);
  expect(f.store.request(f.input).creation).toEqual(committed.creation);
  expect((await profiles.bootstrap(committed.companion!)).profileRevision).toBe(snapshot.profileRevision);
  expect(f.store.request({ type: 'companion.creation.pending', limit: 20 }).pendingCreations).toEqual([]);
  expect(() => f.store.request({ ...f.input, request: { kind: 'custom', companion: { ...f.input.request.companion, persona: '重试时偷换人设' } } })).toThrow('不能修改');
});
it('resumes a prepared SQL identity after restart without changing its ID or frozen starting profile', async () => {
  const f = fixture(), prepared = f.store.request(f.input); f.store.request({ type: 'companion.creation.fail', operationId: f.input.operationId, error: '文件发布中断' });
  f.reopen();
  const pending = f.store.request({ type: 'companion.creation.pending', limit: 20 }).pendingCreations!;
  expect(pending).toHaveLength(1); expect(pending[0]?.companion).toEqual(prepared.companion);
  expect(pending[0]!.creation.state).toBe('failed');
  await f.profiles().bootstrap(pending[0]!.companion);
  const committed = f.store.request({ type: 'companion.creation.commit', operationId: f.input.operationId });
  f.reopen(); expect(f.store.state().companions.map(owner => owner.id)).toEqual([f.input.companionId]);
  expect(f.store.request({ type: 'companion.creation.status', operationId: f.input.operationId }).creation).toEqual(committed.creation);
});
it('rejects the removed unreceipted worker creation and template restoration commands', () => {
  const f = fixture();
  for (const command of [{ type: 'companion.create', companion: f.input.request.companion }, { type: 'companion.restore-builtin', id: 'deepseek-sister' }]) {
    expect(() => f.store.request(command as CompanionStorageCommand)).toThrow();
  }
  expect(f.store.state().companions).toEqual([]);
});
