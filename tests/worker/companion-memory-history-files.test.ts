import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const fixtures: Array<{ root: string; close(): Promise<void> }> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T10:00:00Z'); });
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.close(); removeOwnedDirectorySync(f.root); } vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-history-files-')), filename = path.join(root, 'state.sqlite');
  const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '真实历史正文必须属于本人文件。', avatar: 'sister' as const, model: '', active: true, proactive: false }));
  let store = new CompanionsStore(filename, seeds), beforeComplete: (() => void) | undefined;
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, commands: CompanionStorageCommand[] = [], historyPaths: Array<{ id: string; path: string }> = [];
  const request = async (command: CompanionStorageCommand) => { commands.push(command);
    if (command.type === 'memory.history.outbox.complete' && beforeComplete) { const hook = beforeComplete; beforeComplete = undefined; hook(); }
    const result = store.request(command); if (result.memoryHistoryOutbox) historyPaths.push({ id: result.memoryHistoryOutbox.memoryId, path: result.memoryHistoryOutbox.relativePath }); return result; };
  const directory = path.join(root, '伙伴记忆'), library = new CompanionMemoryLibrary({ libraryDirectory: directory, request });
  const sources = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library });
  const initialOwnerReady = library.withDocuments(scope.companionId, async () => undefined, { readOnly: true });
  const sourceFlush = sources.flush.bind(sources); sources.flush = async (owner, options) => { await initialOwnerReady; return sourceFlush(owner, options); };
  const index = () => { for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  const source = (content: string) => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
  const record = (content: string, sourceMessageIds: string[], relatedMemoryIds: string[] = []) => {
    const note = store.request({ type: 'memory.record', ...scope, candidate: { content, tags: [], sourceMessageIds, relatedMemoryIds,
      evidence: sourceMessageIds.map(id => ({ sourceMessageId: id, quote: store.getMessage(id).content })) } }).memories![0]!; index(); return note;
  };
  const publish = async () => { while ((await sources.flush('alice')).pending) { /* Real original material before history admission. */ }
    while ((await history.flush('alice')).pending) { /* Durable history publication. */ } };
  const file = (id: string, contentRevision: number) => path.join(directory, 'alice', ...store.request({ type: 'memory.revision.describe', ...scope, id, contentRevision }).memoryHistoryDescriptor!.relativePath.split('/'));
  fixtures.push({ root, close: async () => { await library.close(); store.close(); } });
  return { root, library, history, sources, scope, commands, historyPaths, source, record, index, publish, file, get store() { return store; },
    beforeComplete: (hook: () => void) => { beforeComplete = hook; },
    restart: () => { store.close(); store = new CompanionsStore(filename, seeds); } };
}

it('reads real immutable r1 metadata/body while current r2 differs and does not ingest history into new memory', async () => {
  const f = fixture(), raw = f.source('正式原始证据。'), first = f.record('任务最初实际读到的旧正文。', [raw.id]); await f.publish();
  f.store.request({ type: 'memory.revise', ...f.scope, id: first.id, expectedVersion: first.version, candidate: { content: '后来独立修订的当前正文。', tags: [],
    sourceMessageIds: [raw.id], evidence: [{ sourceMessageId: raw.id, quote: raw.content }] } }); f.index(); await f.publish();
  const wholeReadCommand = { type: 'memory.revision.read' as const, ...f.scope, id: first.id, contentRevision: 1 };
  expect((await f.history.read(wholeReadCommand, first.id, 1)).content).toBe('任务最初实际读到的旧正文。');
  expect((await f.history.read(f.scope, first.id, 2)).content).toBe('后来独立修订的当前正文。');
  expect(readFileSync(f.file(first.id, 1), 'utf8')).toContain('worldlinebox.companion-memory-history-v1');
  expect(readFileSync(f.file(first.id, 1), 'utf8')).toContain('"dependencies"');
  const manager = new CompanionMemoryDocuments({ library: f.library, libraryDirectory: path.dirname(path.dirname(path.dirname(f.file(first.id, 1)))), requestStorage: async command => f.store.request(command) });
  try {
    const relative = f.store.request({ type: 'memory.revision.describe', ...f.scope, id: first.id, contentRevision: 1 }).memoryHistoryDescriptor!.relativePath;
    const read = await manager.handle({ type: 'memory.documents.read', companionId: 'alice', path: relative, sourceLimit: 30 });
    expect(read.ok, read.error).toBe(true); expect(read.document?.content).toBe(first.content);
    expect(read.document?.document.title).toContain('任务最初实际读到的旧正文'); expect(read.document?.document.title).toContain('第 1 版');
    expect(read.document?.document.excerpt).not.toContain('schema');
  } finally { await manager.close(); }
  const before = f.store.listMemory('alice').length; await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(before);
  await expect(f.history.read({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id }, first.id, 1)).rejects.toThrow();
  expect(() => f.store.request({ type: 'memory.revision.read', ...f.scope, id: first.id, contentRevision: 1 })).toThrow('文件');
});

it.each(['remove', 'edit', 'hardlink'] as const)('never reconstructs a published historical file after %s, including after restart', async mode => {
  const f = fixture(), raw = f.source('历史源保持合法。'), note = f.record('历史正文不从SQL兜底。', [raw.id]); await f.publish(); const file = f.file(note.id, 1);
  if (mode === 'remove') unlinkSync(file); else if (mode === 'edit') writeFileSync(file, '外部改动不应被旧SQL覆盖。'); else linkSync(file, path.join(f.root, 'foreign-link.md'));
  f.restart(); expect(await f.history.flush('alice')).toMatchObject({ completed: 0 }); await expect(f.history.read(f.scope, note.id, 1)).rejects.toThrow();
  if (mode === 'remove') expect(existsSync(file)).toBe(false);
  if (mode === 'edit') expect(readFileSync(file, 'utf8')).toBe('外部改动不应被旧SQL覆盖。');
});

it('recovers link-success/unlink-temp crash only through the exact durable job, inode and full hash', async () => {
  const f = fixture(), raw = f.source('支持链接窗口恢复的真实源。'), note = f.record('宿主崩溃不能永久留下双链接坏档。', [raw.id]); await f.sources.flush('alice');
  let target = '', temporary = '';
  const crashing = new CompanionMemoryHistoryFiles({ library: f.library, afterLink: async job => {
    target = path.join(f.root, '伙伴记忆', 'alice', ...job.relativePath.split('/'));
    temporary = path.join(f.root, '伙伴记忆', 'alice', '.认知索引', '历史发布', job.id + '.tmp'); throw new Error('ACTUAL_FS_FAULT_AFTER_LINK'); } });
  await expect(crashing.flush('alice')).rejects.toThrow('ACTUAL_FS_FAULT_AFTER_LINK');
  expect(lstatSync(target).ino).toBe(lstatSync(temporary).ino); expect(lstatSync(target).nlink).toBe(2);
  await expect(f.history.read(f.scope, note.id, 1)).rejects.toThrow();
  f.restart(); vi.setSystemTime(Date.now() + 31_000); await f.history.flush('alice');
  expect(existsSync(temporary)).toBe(false); expect(lstatSync(target).nlink).toBe(1);
  expect((await f.history.read(f.scope, note.id, 1)).content).toBe(note.content);
});

it('keeps a legal r1 when only r2 uses a withdrawn source and retracts late publications after the durable barrier', async () => {
  const f = fixture(), b = f.source('B仍可用于旧任务。'), a = f.source('A后来补充且可能撤回。'), first = f.record('旧r1仅依据B。', [b.id]); await f.publish();
  const r1 = f.file(first.id, 1);
  f.store.request({ type: 'memory.revise', ...f.scope, id: first.id, expectedVersion: first.version, candidate: { content: '新r2同时依据A和B。', tags: [],
    sourceMessageIds: [a.id, b.id], evidence: [a, b].map(source => ({ sourceMessageId: source.id, quote: source.content })) } }); f.index(); await f.publish(); const r2 = f.file(first.id, 2);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [a.id] }); await f.history.flush('alice');
  expect(existsSync(r1)).toBe(true); expect(existsSync(r2)).toBe(false); expect((await f.history.read(f.scope, first.id, 1)).content).toBe(first.content);
  const c = f.source('写入期间会撤回C。'), late = f.record('不允许迟到正文复活。', [c.id]); await f.sources.flush('alice');
  f.beforeComplete(() => f.store.request({ type: 'memory.forget', ...f.scope, id: late.id }));
  await f.history.flush('alice'); await expect(f.history.read(f.scope, late.id, 1)).rejects.toThrow();
  const latePath = f.historyPaths.find(entry => entry.id === late.id)!.path;
  expect(existsSync(path.join(f.root, '伙伴记忆', 'alice', ...latePath.split('/')))).toBe(false);
});

it('drains a real file publication at shutdown and memoizes a shared historical dependency once per read', async () => {
  const f = fixture(), raw = f.source('共享依赖的原始资料。'), base = f.record('共同历史基础。', [raw.id]);
  const left = f.record('左分支。', [f.source('左资料。').id], [base.id]), right = f.record('右分支。', [f.source('右资料。').id], [base.id]);
  const top = f.record('共享DAG入口。', [f.source('顶层资料。').id], [left.id, right.id]); await f.publish(); f.commands.length = 0;
  await f.history.read(f.scope, top.id, 1);
  expect(f.commands.filter(command => command.type === 'memory.revision.describe' && command.id === base.id)).toHaveLength(2);
  const next = f.record('关机需drain的实际文件。', [f.source('关机写入材料。').id]); await f.sources.flush('alice');
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { reached = resolve; });
  const files = new CompanionMemoryHistoryFiles({ library: f.library, afterLink: async () => { reached(); await gate; } }), io = new CompanionAssetIo();
  const publication = io.run(() => files.flush('alice')); await arrived; let closed = false;
  const closing = io.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  release(); await publication; await closing; expect(closed).toBe(true); expect(lstatSync(f.file(next.id, 1)).nlink).toBe(1);
});
