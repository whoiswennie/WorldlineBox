import { linkSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
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
  const sourceFiles = new CompanionMemorySourceFiles({ library }), historyFiles = new CompanionMemoryHistoryFiles({ library });
  const live = new CompanionMemoryLiveFiles({ library, maxFilesPerFlush: 2, history: historyFiles }), publish = live.flush.bind(live);
  const initialized = new Set<string>();
  live.flush = async (owner, input) => {
    if (!initialized.has(owner)) { const current = store.state(false).companions.find(companion => companion.id === owner);
      if (!current) throw new Error('Unknown synthetic owner.'); await profiles.bootstrap(current); initialized.add(owner); }
    while ((await sourceFiles.flush(owner)).pending) { /* Complete the canonical fixture publication boundary. */ }
    while ((await historyFiles.flush(owner)).pending) { /* Same publication chain as Main's source-file flush. */ }
    return publish(owner, input);
  };
  fixtures.push({ root, store, library });
  const message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '这是有正式来源、必须保留的真实材料。', replyDirective: 'none' });
  const candidate = (content: string) => ({ content, tags: [], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] });
  const record = (content = '第一版有据记忆。') => store.request({ type: 'memory.record', ...scope, candidate: candidate(content) }).memories![0]!;
  const read = (id: string) => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory;
  const file = (relative: string) => path.join(directory, 'alice', ...relative.split('/'));
  return { root, store, library, live, historyFiles, scope, message, candidate, record, read, file, directory, profiles, commands };
}

it('reads a complete native input set from real historical files through one directory session and rejects edited published history', async () => {
  const f = fixture(), notes = [f.record('候选一的原始正文。'), f.record('候选二的原始正文。')];
  await f.live.flush('alice', { noteIds: notes.map(note => note.id), reconcile: false });
  for (;;) { const job = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
    f.store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); }
  const state = f.store.request({ type: 'memory.projection.state', ...f.scope }).memoryProjectionState!;
  const descriptors = f.store.request({ type: 'memory.projection.page', ...f.scope, expected: state }).memoryProjectionPage!.notes;
  const session = vi.spyOn(f.library, 'withDocuments');
  expect((await canonicalProjectionInputs(f.historyFiles, f.scope, descriptors, f.library)).map(note => note.content)).toEqual(
    descriptors.map(note => notes.find(expected => expected.id === note.id)!.content));
  expect(session).toHaveBeenCalledTimes(1); session.mockRestore();
  const descriptor = f.store.request({ type: 'memory.revision.describe', ...f.scope, id: notes[0]!.id, contentRevision: 1 }).memoryHistoryDescriptor!;
  writeFileSync(f.file(descriptor.relativePath), '外部更改历史文件，不能从SQL覆盖。');
  await expect(canonicalProjectionInputs(f.historyFiles, f.scope, descriptors, f.library)).rejects.toThrow();
  expect(readFileSync(f.file(descriptor.relativePath), 'utf8')).toBe('外部更改历史文件，不能从SQL覆盖。');
});

it('preserves a captured body across a host-committed move while unregistered moves and edits remain unavailable', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const original = await f.live.materialize('alice', [note]), receipt = original.receipts[0]!;
  const manager = new CompanionMemoryDocuments({ library: f.library, libraryDirectory: f.directory, requestStorage: async command => f.store.request(command) });
  try {
    const read = await manager.handle({ type: 'memory.documents.read', companionId: 'alice', path: receipt.path, sourceLimit: 30 });
    expect(read.ok, read.error).toBe(true);
    const target = '资料/完成整理后的原记忆.md';
    const moved = await manager.handle({ type: 'memory.documents.move', companionId: 'alice', path: receipt.path, targetPath: target,
      expectedRevision: read.document!.document.revision });
    expect(moved.ok, moved.error).toBe(true);
    expect(await f.live.validate('alice', original.receipts)).toBe(true);
    expect(await f.live.validate('bob', original.receipts)).toBe(false);
    const current = f.file(target), external = f.file('资料/未登记移动.md'); renameSync(current, external);
    expect(await f.live.validate('alice', original.receipts)).toBe(false);
    renameSync(external, current); writeFileSync(current, '未登记改写不能借旧历史通过。');
    expect(await f.live.validate('alice', original.receipts)).toBe(false);
  } finally { await manager.close(); }
});

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

it('persists one complete bounded publication intent before bodies and recovers an interrupted batch without losing order', async () => {
  const f = fixture(), notes = [f.record('批量原文一。'), f.record('批量原文二。'), f.record('批量原文三。')];
  const original = f.library.withDocuments.bind(f.library); let projects = 0, saves = 0;
  const intercepted = vi.spyOn(f.library, 'withDocuments').mockImplementation((owner, work, options) => original(owner, async session => {
    const project = session.project, save = session.save;
    session.save = async () => { saves++; await save(); };
    session.project = async (relative, note) => {
      const manifest = JSON.parse(readFileSync(f.file('.同步状态.json'), 'utf8'));
      expect(notes.every(item => manifest.files['日记/' + item.id + '.md']?.state === 'projecting')).toBe(true);
      if (++projects === 2) throw new Error('Synthetic interruption between committed batch bodies.');
      await project(relative, note);
    };
    return work(session);
  }, options));
  await expect(f.live.flush('alice', { noteIds: notes.map(note => note.id), limit: 3, reconcile: false })).rejects.toThrow('Synthetic interruption');
  expect(saves).toBe(1); intercepted.mockRestore();
  expect(await f.live.flush('alice', { noteIds: notes.map(note => note.id), limit: 3, reconcile: false })).toMatchObject({ checked: 3, pending: false });
  const actual = await f.live.materialize('alice', notes);
  expect(actual.notes.map(note => note.id)).toEqual(notes.map(note => note.id));
  expect(actual.notes.map(note => note.content)).toEqual(notes.map(note => note.content));
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

it('rechecks real file identity and ctime within the same admission memo even after a same-size edit restores mtime', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const initial = await f.live.materialize('alice', [note]), window = {}, file = f.file(initial.receipts[0]!.path);
  expect(await f.live.validate('alice', initial.receipts, window)).toBe(true);
  expect(await f.live.validate('alice', initial.receipts, window)).toBe(true);
  const before = statSync(file), edited = note.content.replace('第', '新'); expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(note.content));
  writeFileSync(file, edited); utimesSync(file, before.atime, before.mtime);
  expect(await f.live.validate('alice', initial.receipts, window)).toBe(false);
});

it('opens role modules once within an owner operation while fresh contexts still reject a missing current role', async () => {
  const f = fixture(), note = f.record(); await f.live.flush('alice', { noteIds: [note.id], reconcile: false });
  const receipts = (await f.live.materialize('alice', [note])).receipts, window = {}, roles = vi.spyOn(f.profiles, 'load');
  expect(await f.live.validate('alice', receipts, window)).toBe(true); expect(roles).toHaveBeenCalledTimes(1);
  expect(await f.live.validate('alice', receipts, window)).toBe(true); expect(roles).toHaveBeenCalledTimes(1);
  expect(await f.live.validate('bob', receipts, window)).toBe(false);
  unlinkSync(f.file('提示词/共同.md'));
  expect(await f.live.validate('alice', receipts, {})).toBe(false);
  expect(await f.live.validate('alice', receipts)).toBe(false);
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

it('keeps a real old B-only file receipt after host withdrawal of a later A+B body, then rejects explicit whole-note forgetting', async () => {
  const f = fixture(), original = f.record('仅有B真实来源的第一版。'); await f.live.flush('alice', { noteIds: [original.id], reconcile: false });
  const receipt = (await f.live.materialize('alice', [original])).receipts;
  const a = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '后来新增的真实证据A。', replyDirective: 'none' });
  const revised = f.store.request({ type: 'memory.revise', ...f.scope, id: original.id, expectedVersion: original.version, candidate: {
    content: '后来综合A与B的第二版。', sourceMessageIds: [a.id, f.message.id], evidence: [{ sourceMessageId: a.id, quote: a.content },
      { sourceMessageId: f.message.id, quote: f.message.content }] } }).memories![0]!;
  await f.live.flush('alice', { noteIds: [revised.id], reconcile: false });
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [a.id] });
  expect(await f.live.validate('alice', receipt)).toBe(true); // Registered r2 can retire before its host file withdrawal finishes.
  await f.live.flush('alice', { reconcile: false }); await f.library.sync();
  expect(await f.live.validate('alice', receipt)).toBe(true);
  f.store.request({ type: 'memory.forget', ...f.scope, id: original.id }); await f.live.flush('alice', { reconcile: false });
  expect(await f.live.validate('alice', receipt)).toBe(false);
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
