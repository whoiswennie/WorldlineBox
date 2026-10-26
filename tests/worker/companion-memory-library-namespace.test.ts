import { EventEmitter } from 'node:events';
import type { FSWatcher, watch } from 'node:fs';
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles, companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const fixtures: Array<{ root: string; store: CompanionsStore; libraries: CompanionMemoryLibrary[] }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { for (const library of f.libraries) await library.close(); f.store.close(); await removeOwnedDirectory(f.root); } });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-library-namespace-')), directory = path.join(root, '伙伴记忆');
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '文件是我的当前设定。', model: '', avatar: 'custom' as const, proactive: false })));
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command);
  const profiles = new CompanionAssetProfileStore(directory, {
    initialized: async companionId => store.request({ type: 'companion.assets.initialized', companionId }).assetProfileInitialized === true,
    markInitialized: async companionId => { store.request({ type: 'companion.assets.mark-initialized', companionId }); },
  });
  const libraries: CompanionMemoryLibrary[] = [];
  const create = () => {
    const emitter = new EventEmitter(), watcher = Object.assign(emitter, { unref() { return emitter; }, close() { queueMicrotask(() => emitter.emit('close')); } }) as unknown as FSWatcher;
    const library = new CompanionMemoryLibrary({ libraryDirectory: directory, profileStore: profiles, request,
      fileNotifications: { watch: (() => watcher) as unknown as typeof watch } });
    libraries.push(library); return library;
  };
  fixtures.push({ root, store, libraries }); return { directory, store, create, file: (owner: string, relative = '') => path.join(directory, owner, relative) };
}

it('does not recreate an initialized owner namespace through periodic status, reader, dirty gate, source delivery or timeline cleanup after restart', async () => {
  const f = await fixture(), initial = f.create(); await initial.sync(); await initial.close();
  const original = await readFile(f.file('bob', 'profile.md'), 'utf8');
  expect(f.store.request({ type: 'companion.assets.initialized', companionId: 'alice' }).assetProfileInitialized).toBe(true);
  await rm(f.file('alice'), { recursive: true });
  const restarted = f.create(), report = await restarted.sync();
  expect(report.conflicts.some(conflict => conflict.companionId === 'alice')).toBe(true);
  await expect(restarted.withDocuments('alice', async () => true, { readOnly: true })).rejects.toMatchObject({ code: 'MISSING' });
  await expect(restarted.withDocuments('alice', async () => true, { sourceDelivery: true })).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(restarted.prepareOwnerFiles('alice')).rejects.toMatchObject({ code: 'MISSING' });
  await restarted.invalidate('alice');
  await expect(access(f.file('alice'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(f.file('bob', 'profile.md'), 'utf8')).toBe(original);
  await writeFile(f.file('bob', '资料/new.md'), '健康伙伴可以继续登记自己的真实资料。'); await restarted.sync();
  expect(f.store.request({ type: 'memory.list', companionId: 'bob' }).memories!.some(note => note.content.includes('健康伙伴'))).toBe(true);
});

it('recreates an empty category layout but never restores a deleted body, and source revocation still removes files when prompts are damaged', async () => {
  const f = await fixture(), library = f.create(); await library.sync();
  await rm(f.file('alice', '资料'), { recursive: true }); await library.sync(); await access(f.file('alice', '资料'));
  await writeFile(f.file('alice', '日记/physical.md'), '这篇正文删除后不能从SQL自动恢复。'); await library.sync();
  const note = f.store.request({ type: 'memory.list', companionId: 'alice' }).memories!.find(note => note.content.includes('这篇正文'))!;
  expect(note).toBeDefined(); await unlink(f.file('alice', '日记/physical.md')); await library.sync();
  await expect(access(f.file('alice', '日记/physical.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  const scope = { companionId: 'alice', conversationId: f.store.openPrivate('alice').id }, raw = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '稍后明确撤回的实际来源。', replyDirective: 'none' });
  const memory = f.store.request({ type: 'memory.record', ...scope, candidate: { content: '以真实来源为据。', sourceMessageIds: [raw.id], evidence: [{ sourceMessageId: raw.id, quote: raw.content }] } }).memories![0]!;
  const sourceFiles = new CompanionMemorySourceFiles({ library }); await sourceFiles.flush('alice');
  const source = memory.sources[0]!, copy = f.file('alice', companionMemorySourceFilePath({ sourceId: source.messageId, sourceRevision: source.revision, sourceChecksum: source.checksum })); await access(copy);
  await unlink(f.file('alice', '提示词/共同.md'));
  f.store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] }); await sourceFiles.flush('alice');
  await expect(access(copy)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(f.file('alice', '提示词/共同.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});
