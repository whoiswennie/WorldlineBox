import { linkSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const fixtures: Array<{ root: string; library: CompanionMemoryLibrary; store: CompanionsStore }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.library.close(); f.store.close(); removeOwnedDirectorySync(f.root); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-memory-live-files-'));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '原文与已核验来源共同构成记忆。',
    avatar: 'sister' as const, model: '', active: true, proactive: false })));
  const directory = path.join(root, '伙伴记忆'), scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const profiles = new CompanionAssetProfileStore(directory), commands: CompanionStorageCommand[] = [];
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, profileStore: profiles,
    request: async command => { commands.push(command); return store.request(command); }, maxFilesPerOwner: 2 });
  const live = new CompanionMemoryLiveFiles({ library, maxFilesPerFlush: 2 }); fixtures.push({ root, store, library });
  const message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '这是有正式来源、必须保留的真实材料。', replyDirective: 'none' });
  const candidate = (content: string) => ({ content, tags: [], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] });
  const record = (content = '第一版有据记忆。') => store.request({ type: 'memory.record', ...scope, candidate: candidate(content) }).memories![0]!;
  const read = (id: string) => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory;
  const file = (relative: string) => path.join(directory, 'alice', ...relative.split('/'));
  return { root, store, library, live, scope, message, candidate, record, read, file, directory, profiles, commands };
}

it('bounds foreground reconciliation to its owner and prepares the role once per writer operation', async () => {
  const f = fixture(), note = f.record();
  await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const preparation = vi.spyOn(f.profiles, 'bootstrap'); f.commands.length = 0;
  await f.live.flush('alice', { reconcile: true });
  expect(preparation.mock.calls.map(([owner]) => owner.id)).toEqual(['alice']);
  const states = f.commands.filter(command => command.type === 'state');
  expect(states.length).toBeGreaterThan(0);
  expect(states.every(command => command.companionId === 'alice')).toBe(true);
  expect((await f.live.materialize('alice', [note])).notes[0]!.content).toBe(note.content);
});

it('keeps live role-file admission after bounded reconciliation and does not reseed a missing initialized prompt', async () => {
  const f = fixture(), note = f.record();
  await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const initial = await f.live.materialize('alice', [note]);
  writeFileSync(f.file(initial.receipts[0]!.path), '来自文件的新事实，必须在下一次上下文前登记。');
  await f.live.flush('alice', { reconcile: true });
  expect((await f.live.materialize('alice', [f.read(note.id)])).notes[0]!.content).toBe('来自文件的新事实，必须在下一次上下文前登记。');
  const prompt = f.file('提示词/共同.md'); unlinkSync(prompt);
  await expect(f.live.flush('alice', { reconcile: true })).rejects.toMatchObject({ code: 'MISSING' });
  await expect(f.live.materialize('alice', [f.read(note.id)])).rejects.toMatchObject({ code: 'MISSING' });
  expect(await f.live.validate('alice', initial.receipts)).toBe(false);
  expect(() => readFileSync(prompt, 'utf8')).toThrow();
});

it('publishes specified host writes immediately and materializes actual canonical text under the correct owner', async () => {
  const f = fixture(), note = f.record();
  expect(await f.live.flush('alice', { noteIds: [note.id], reconcile: false })).toMatchObject({ checked: 1, published: 1, pending: false });
  const result = await f.live.materialize('alice', [note]);
  expect(result.notes[0]!.content).toBe(readFileSync(f.file(result.receipts[0]!.path), 'utf8'));
  expect(result.receipts[0]).toMatchObject({ companionId: 'alice', noteId: note.id, contentRevision: 1 });
  expect(await f.live.validate('alice', result.receipts)).toBe(true);
  expect(await f.live.validate('bob', result.receipts)).toBe(false);
  await expect(f.live.materialize('bob', [note])).rejects.toThrow('伙伴');
});

it('fails closed on unregistered external edits and imports current text before preparing another context', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const initial = await f.live.materialize('alice', [note]), receipt = initial.receipts[0]!;
  writeFileSync(f.file(receipt.path), '用户在资产目录即时改写的完整正文。');
  expect(await f.live.validate('alice', initial.receipts)).toBe(false);
  await expect(f.live.materialize('alice', [note])).rejects.toThrow('登记外部编辑');
  await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const current = f.read(note.id), materialized = await f.live.materialize('alice', [current]);
  expect(current.contentRevision).toBe(2); expect(materialized.notes[0]!.content).toBe('用户在资产目录即时改写的完整正文。');
  expect(await f.live.validate('alice', materialized.receipts)).toBe(true);
});

it('keeps legitimate frozen tasks valid during and after a newer background body publication', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const original = await f.live.materialize('alice', [note]);
  const next = f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('后台基于相同真实来源改进的新正文。') }).memories![0]!;
  expect(await f.live.validate('alice', original.receipts)).toBe(true);
  await expect(f.live.materialize('alice', [next])).rejects.toThrow();
  await f.live.flush('alice', { noteIds: [next.id], reconcile: false });
  expect(await f.live.validate('alice', original.receipts)).toBe(true);
  expect((await f.live.materialize('alice', [f.read(note.id)])).notes[0]!.content).toBe(next.content);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.message.id] });
  expect(await f.live.validate('alice', original.receipts)).toBe(false);
});

it('does not overwrite concurrent external text with a newer SQL projection', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const result = await f.live.materialize('alice', [note]), file = f.file(result.receipts[0]!.path);
  writeFileSync(file, '外部编辑必须保留，不能被后台覆盖。');
  f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('同时发生的后台改进。') });
  await expect(f.live.flush('alice', { noteIds: [note.id], reconcile: false })).rejects.toThrow('保留文件并停止自动覆盖');
  expect(readFileSync(file, 'utf8')).toBe('外部编辑必须保留，不能被后台覆盖。');
  expect(await f.live.validate('alice', result.receipts)).toBe(false);
});

it('treats removed or multiply linked files as unavailable instead of trusting SQLite or following aliases', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const result = await f.live.materialize('alice', [note]), file = f.file(result.receipts[0]!.path), alias = path.join(f.root, 'outside-copy.md');
  linkSync(file, alias); expect(await f.live.validate('alice', result.receipts)).toBe(false);
  await expect(f.live.materialize('alice', [note])).rejects.toThrow('普通文本'); unlinkSync(alias);
  unlinkSync(file); expect(await f.live.validate('alice', result.receipts)).toBe(false);
  await expect(f.live.materialize('alice', [note])).rejects.toThrow();
});

it('offers bounded resumable write-through for explicit batches without another owner scan', async () => {
  const f = fixture(), notes = Array.from({ length: 5 }, (_, index) => f.record('第' + index + '篇有据记忆。')), ids = notes.map(note => note.id);
  const first = await f.live.flush('alice', { noteIds: ids, limit: 2, reconcile: false }); expect(first).toMatchObject({ checked: 2, pending: true, nextCursor: 2 });
  const second = await f.live.flush('alice', { noteIds: ids, limit: 2, cursor: first.nextCursor, reconcile: false }); expect(second.nextCursor).toBe(4);
  const final = await f.live.flush('alice', { noteIds: ids, limit: 2, cursor: second.nextCursor, reconcile: false }); expect(final).toMatchObject({ checked: 1, pending: false });
  expect((await f.live.materialize('alice', notes)).receipts).toHaveLength(5);
});
