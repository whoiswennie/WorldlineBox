import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { z } from 'zod';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import type { companionMemoryDocumentCommands } from '../../src/shared/companion-memory-documents';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const roots: string[] = [], stores: CompanionsStore[] = [], libraries: CompanionMemoryLibrary[] = [], documents: CompanionMemoryDocuments[] = [];
type CommandInput<T = z.input<(typeof companionMemoryDocumentCommands)[number]>> = T extends unknown ? Omit<T, 'companionId'> & { companionId?: string } : never;
afterEach(async () => {
  for (const item of documents.splice(0)) await item.close();
  for (const library of libraries.splice(0)) await library.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('vcp-memory-documents-')) throw new Error('Invalid fixture cleanup');
    removeOwnedDirectorySync(root);
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'vcp-memory-documents-')); roots.push(root);
  const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: `${id} 的稳定人格。`, description: '', avatar: 'sister', model: '', proactive: false, active: true }));
  const store = new CompanionsStore(path.join(root, 'runtime', 'state.sqlite'), seeds); stores.push(store);
  const directory = path.join(root, 'library', '伙伴记忆'), scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const request = async (command: CompanionStorageCommand) => store.request(command);
  const make = (requestStorage: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse> = request) => {
    const library = new CompanionMemoryLibrary({ libraryDirectory: directory, request: requestStorage, maxFilesPerOwner: 32 }); libraries.push(library);
    const manager = new CompanionMemoryDocuments({ library, libraryDirectory: directory, requestStorage }); documents.push(manager);
    const call = (command: CommandInput) => {
      const parsed = companionWorkspaceRequestSchema.parse({ companionId: 'alice', ...command });
      if (!('companionId' in parsed)) throw new Error('Expected a document command.');
      if (!parsed.type.startsWith('memory.documents.')) throw new Error('Expected a document command.');
      return manager.handle(parsed as Parameters<typeof manager.handle>[0]);
    };
    return { library, manager, call };
  };
  return { root, store, directory, scope, request, make };
}

it('creates a real nested notebook text with authoritative tags, source metadata and the existing outbox', async () => {
  const f = fixture(), { call } = f.make();
  expect(await call({ type: 'memory.documents.mkdir', path: '资料/研究/植物' })).toMatchObject({ ok: true, createdDirectory: '资料/研究/植物' });
  const created = await call({ type: 'memory.documents.create', path: '资料/研究/植物/浇水.md', content: '每周六给阳台植物浇水。', tags: ['植物'], diaryName: '植物资料' });
  expect(created.ok, created.error).toBe(true);
  expect(created.document?.memory).toMatchObject({ companionId: 'alice', content: '每周六给阳台植物浇水。', tags: ['植物'], diaryName: '植物资料', version: 1, sources: [{ sourceType: 'manual_input' }] });
  expect(created.document?.document).toMatchObject({ path: '资料/研究/植物/浇水.md', category: 'material', syncState: 'pending', noteId: created.document?.memory?.id });
  expect(created.document?.document.contentHash).toBe(createHash('sha256').update('每周六给阳台植物浇水。').digest('hex'));
  expect(created.document?.document).toMatchObject({ createdAt: created.document?.memory?.createdAt, createdAtSource: 'memory' });
  expect(readFileSync(path.join(f.directory, 'alice', '资料/研究/植物/浇水.md'), 'utf8')).toBe('每周六给阳台植物浇水。');
  expect(f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox).toMatchObject({ operation: 'remember', noteId: created.document?.memory?.id });
  const page = await call({ type: 'memory.documents.list', directory: '', limit: 64 });
  expect(page.documents?.folders).toContainEqual({ path: '资料/研究/植物', name: '植物', count: 1 });
  await expect.poll(async () => (await call({ type: 'memory.documents.list', directory: '', limit: 64 })).documents?.items.some(item => item.path === 'profile.md' && item.readOnly)).toBe(true);
});

it('opens a cold notebook before file imports or a whole catalogue scan complete', async () => {
  const f = fixture(), folder = path.join(f.directory, 'alice', '资料');
  mkdirSync(folder, { recursive: true });
  for (let n = 0; n < 400; n++) writeFileSync(path.join(folder, `资料-${n}.md`), `真实外部资料 ${n}`);
  let importPages = 0, catalogued = 0, cataloguedAtFirstQuery: number | undefined;
  const { call } = f.make(async command => {
    if (command.type === 'memory.library.page') importPages++;
    if (command.type === 'document.catalog.put') catalogued += command.entries.length;
    if (command.type === 'document.catalog.query' && cataloguedAtFirstQuery === undefined) cataloguedAtFirstQuery = catalogued;
    return f.request(command);
  });
  const started = performance.now();
  const first = await call({ type: 'memory.documents.list', directory: '', limit: 64 });
  const elapsedMs = performance.now() - started;
  expect(first.ok, first.error).toBe(true);
  expect(importPages).toBe(0);
  expect(cataloguedAtFirstQuery).toBeLessThanOrEqual(16);
  expect(first.documents?.index?.state).toBe('building');
  expect(elapsedMs).toBeLessThan(2000);
  await expect.poll(async () => (await call({ type: 'memory.documents.list', directory: '资料', limit: 64 })).documents?.index?.state, { timeout: 15000 }).toBe('ready');
  expect((await call({ type: 'memory.documents.list', directory: '资料', limit: 64 })).documents?.total).toBe(400);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
});

it('opens another owner notebook while one owner is waiting on a background import policy', async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const { library, call } = f.make(async command => {
    if (command.type === 'memory.library.page' && command.companionId === 'alice') { entered(); await gate; }
    return f.request(command);
  });
  const background = library.sync();
  await waiting;
  try {
    const response = await Promise.race([
      call({ type: 'memory.documents.list', companionId: 'bob', directory: '', limit: 64 }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('An unrelated notebook waited for the blocked import')), 1500); timer.unref(); }),
    ]);
    expect(response.ok, response.error).toBe(true);
    expect(response.documents?.items.some(item => item.path === 'profile.md')).toBe(true);
  } finally { release(); await background; }
});

it('keeps catalogue discovery moving while the same owner import writer is blocked', async () => {
  const f = fixture(), folder = path.join(f.directory, 'alice', '资料');
  mkdirSync(folder, { recursive: true });
  for (let n = 0; n < 48; n++) writeFileSync(path.join(folder, `后台-${n}.md`), `仍可阅读的真实文件 ${n}`);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const scanned: string[] = [], dropped: string[] = [];
  const { library, call } = f.make(async command => {
    if (command.type === 'memory.library.page' && command.companionId === 'alice') { entered(); await gate; }
    if (command.type === 'document.catalog.put') scanned.push(...command.entries.map(item => item.document.path));
    if (command.type === 'document.catalog.drop') dropped.push(...command.paths);
    return f.request(command);
  });
  const writer = library.sync(); await waiting;
  try {
    const first = await call({ type: 'memory.documents.list', directory: '资料', limit: 8 });
    expect(first.ok, first.error).toBe(true);
    expect(first.documents?.index?.state).toBe('building');
    await expect.poll(async () => (await call({ type: 'memory.documents.list', directory: '资料', limit: 8 })).documents?.index?.state,
      { timeout: 5000 }).toBe('ready');
    expect((await call({ type: 'memory.documents.list', directory: '资料', limit: 8 })).documents?.total, JSON.stringify({ scanned, dropped })).toBe(48);
  } finally { release(); await writer; }
});

it('returns persisted candidates without waiting for the first background rescan', async () => {
  const f = fixture(), original = f.make();
  for (let n = 0; n < 7; n++) expect((await original.call({ type: 'memory.documents.create', path: `日记/已存-${n}.md`, content: `已有日记 ${n}` })).ok).toBe(true);
  await expect.poll(async () => (await original.call({ type: 'memory.documents.list', directory: '', limit: 64 })).documents?.index?.state).toBe('ready');
  await original.manager.close(); await original.library.close();
  documents.splice(documents.indexOf(original.manager), 1); libraries.splice(libraries.indexOf(original.library), 1);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const reopened = f.make(async command => {
    if (command.type === 'document.catalog.touch') { entered(); await gate; }
    return f.request(command);
  });
  try {
    const first = await Promise.race([reopened.call({ type: 'memory.documents.list', directory: '', limit: 64 }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Persisted page awaited catalogue source work')), 1500); timer.unref(); })]);
    expect(first.ok, first.error).toBe(true);
    expect(first.documents?.items.filter(item => item.noteId)).toHaveLength(7);
    expect(first.documents?.index?.state).toBe('building');
    await waiting;
  } finally { release(); }
});

it('hydrates at most four actual note rows at once and retains the final authorization read', async () => {
  const f = fixture(); let block = false, active = 0, maxActive = 0, reads = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const { call } = f.make(async command => {
    if (block && command.type === 'memory.library.read' && command.sourceLimit === 1) {
      reads++; active++; maxActive = Math.max(maxActive, active);
      if (active === 4) entered();
      try { await gate; return await f.request(command); } finally { active--; }
    }
    return f.request(command);
  });
  for (let n = 0; n < 7; n++) expect((await call({ type: 'memory.documents.create', path: `日记/并行-${n}.md`, content: `并行授权日记 ${n}` })).ok).toBe(true);
  await expect.poll(async () => (await call({ type: 'memory.documents.list', directory: '', limit: 64 })).documents?.index?.state).toBe('ready');
  block = true;
  const reading = call({ type: 'memory.documents.list', directory: '日记', limit: 64 });
  try {
    await waiting; expect(active).toBe(4); expect(reads).toBe(4);
  } finally { release(); }
  const page = await reading;
  expect(page.ok, page.error).toBe(true);
  expect(page.documents?.items).toHaveLength(7);
  expect(maxActive).toBe(4);
  expect(reads).toBe(14); // Every file still has both initial and final SQL authority checks.
});

it('reads the same notebook during a blocked import without granting its snapshot file-write authority', async () => {
  const f = fixture();
  let blocked = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const { library, call } = f.make(async command => {
    if (blocked && command.type === 'memory.library.page' && command.companionId === 'alice') { entered(); await gate; }
    return f.request(command);
  });
  const note = (await call({ type: 'memory.documents.create', path: '日记/安全读取.md', content: '不依赖待审资料的真实已有日记。' })).document!;
  blocked = true;
  const background = library.sync(); await waiting;
  try {
    const response = await Promise.race([
      call({ type: 'memory.documents.list', directory: '', limit: 64 }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Reading waited for the same owner import')), 1500); timer.unref(); }),
    ]);
    expect(response.ok, response.error).toBe(true);
    expect(response.documents?.items.some(item => item.noteId === note.memory!.id)).toBe(true);
    expect((await call({ type: 'memory.documents.read', path: note.document.path })).document?.content).toBe(note.content);
    await expect(library.withDocuments('alice', session => session.atomic('资料/只读不准写.md', '不能写入'), { synchronize: false, readOnly: true })).rejects.toThrow('只读');
    expect(existsSync(path.join(f.directory, 'alice', '资料/只读不准写.md'))).toBe(false);
  } finally { release(); await background; }
});

it('does not return an old exported body after the host has revised that note', async () => {
  const f = fixture(), { library, call } = f.make();
  const original = (await call({ type: 'memory.documents.create', path: '日记/宿主已更新.md', content: '不得从旧导出继续展示的正文。' })).document!;
  f.store.saveMemory({ ...f.scope, id: original.memory!.id, expectedVersion: 1, content: '宿主中当前有效的新正文。' });
  const stale = await call({ type: 'memory.documents.read', path: original.document.path });
  expect(stale).toMatchObject({ ok: false });
  expect(stale.document).toBeUndefined();
  await library.sync();
  expect((await call({ type: 'memory.documents.read', path: original.document.path })).document?.content).toBe('宿主中当前有效的新正文。');
});

it('binds a concurrently read automatic timeline to its published content hash as well as source revision', async () => {
  const f = fixture(); let replace = false;
  const relative = '时间线/VCP-alice-2026-10.md';
  const { library, call } = f.make(async command => {
    const result = await f.request(command);
    if (replace && command.type === 'memory.snapshot') { replace = false; writeFileSync(path.join(f.directory, 'alice', relative), 'UNPUBLISHED_TIMELINE_BODY'); }
    return result;
  });
  await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.revision;
  await library.publishTimelines(f.scope, { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision,
    owner: companionMemoryIdentity(f.store.state().companions.find(owner => owner.id === 'alice')!),
    agents: [{ agentName: 'alice', months: [{ month: '2026-10', sourceDigest: 'digest', content: '实际发布的时间线。' }] }] }, async () => true);
  replace = true;
  const stale = await call({ type: 'memory.documents.read', path: relative });
  expect(stale).toMatchObject({ ok: false });
  expect(stale.document).toBeUndefined();
  expect(existsSync(path.join(f.directory, 'alice', relative))).toBe(false);
});

it('does not publish a body while its new note mapping and post-write authority are still pending', async () => {
  const f = fixture(), publicationGate: { noteId?: string } = {}; let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const { library, call } = f.make(async command => {
    if (publicationGate.noteId && command.type === 'memory.library.read' && command.id === publicationGate.noteId && !('sourceLimit' in command)) { entered(); await gate; }
    return f.request(command);
  });
  const first = (await call({ type: 'memory.documents.create', path: '日记/映射甲.md', content: '已授权的甲正文。' })).document!;
  const second = (await call({ type: 'memory.documents.create', path: '日记/映射乙.md', content: '不得按甲的来源返回的乙正文。' })).document!;
  publicationGate.noteId = second.memory!.id;
  const publication = library.withDocuments('alice', async session => { await session.project(first.document.path, second.memory!); await session.save(); }, { synchronize: false });
  await waiting;
  try {
    const response = await call({ type: 'memory.documents.read', path: first.document.path });
    expect(response).toMatchObject({ ok: false }); expect(response.document).toBeUndefined();
    f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: second.memory!.id, expectedVersion: second.memory!.version });
  } finally { release(); await publication; }
  expect(existsSync(path.join(f.directory, 'alice', first.document.path))).toBe(false);
});

it('rejects a withdrawn candidate promptly while its physical cleanup waits behind an import', async () => {
  const f = fixture(); let blocked = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const { library, call } = f.make(async command => {
    if (blocked && command.type === 'memory.library.page' && command.companionId === 'alice') { entered(); await gate; }
    return f.request(command);
  });
  const note = (await call({ type: 'memory.documents.create', path: '日记/撤回无需等审核.md', content: '已撤回的正文不得出现。' })).document!;
  blocked = true; const background = library.sync(); await waiting;
  f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: note.memory!.id, expectedVersion: note.memory!.version });
  try {
    const result = await Promise.race([
      call({ type: 'memory.documents.read', path: note.document.path }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Withdrawal waited for an unrelated pending import')), 1500); timer.unref(); }),
    ]);
    expect(result).toMatchObject({ ok: false }); expect(result.document).toBeUndefined();
  } finally { release(); await background; }
  await expect.poll(() => existsSync(path.join(f.directory, 'alice', note.document.path))).toBe(false);
});

it('rechecks source authority after an awaited tag-status read', async () => {
  const f = fixture(); let hold = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const { call } = f.make(async command => {
    if (hold && command.type === 'memory.tags.status') { entered(); await gate; }
    return f.request(command);
  });
  const note = (await call({ type: 'memory.documents.create', path: '日记/标签等待期间撤回.md', content: '读取末尾也必须核验来源。' })).document!;
  hold = true; const pending = call({ type: 'memory.documents.read', path: note.document.path });
  await waiting;
  f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: note.memory!.id, expectedVersion: note.memory!.version });
  release();
  const response = await pending;
  expect(response).toMatchObject({ ok: false }); expect(response.document).toBeUndefined();
});

it('repairs a failed publication marker once the persisted mapping and actual body agree again', async () => {
  const f = fixture(); let fail = false;
  const { library, call } = f.make(async command => {
    if (fail && command.type === 'memory.library.read' && !('sourceLimit' in command)) { fail = false; throw new Error('Post-publication transport failure'); }
    return f.request(command);
  });
  const note = (await call({ type: 'memory.documents.create', path: '日记/发布失败后恢复.md', content: '仍然有效的宿主正文。' })).document!;
  fail = true;
  await expect(library.withDocuments('alice', session => session.project(note.document.path, note.memory!), { synchronize: false })).rejects.toThrow('transport failure');
  expect((await call({ type: 'memory.documents.read', path: note.document.path })).ok).toBe(false);
  await library.sync();
  expect((await call({ type: 'memory.documents.read', path: note.document.path })).document?.content).toBe(note.content);
});

it('rechecks a pending message-derived document even before it has a committed diary note', async () => {
  const f = fixture(), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '一条后来明确要求遗忘的原消息。', replyDirective: 'none' });
  let withdraw = false;
  const { library, call } = f.make(async command => {
    const result = await f.request(command);
    if (withdraw && command.type === 'memory.sources.filter') {
      withdraw = false; f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
    }
    return result;
  });
  const relative = '日记/尚未登记的聊天摘记.md', content = '这份摘记必须始终受原消息的可见权限约束。';
  await library.withDocuments('alice', async session => {
    session.manifest.files[relative] = { state: 'tracked', hash: createHash('sha256').update(content).digest('hex'), conversationId: f.scope.conversationId,
      pending: { operationId: 'pending-source-race', hash: createHash('sha256').update(content).digest('hex'), kind: 'record', sourceMessageId: source.id,
        sourceChecksum: createHash('sha256').update(source.content).digest('hex'), tags: [] } };
    await session.atomic(relative, content); await session.save();
  }, { synchronize: false });
  withdraw = true;
  const response = await call({ type: 'memory.documents.read', path: relative });
  expect(response).toMatchObject({ ok: false }); expect(response.document).toBeUndefined();
});

it('locates the exact owned note after a move and refuses another owner or a forgotten note', async () => {
  const f = fixture(), { call } = f.make();
  const first = (await call({ type: 'memory.documents.create', path: '日记/同名.md', content: 'Alice的海边约定。', tags: ['约定'] })).document!;
  const other = (await call({ type: 'memory.documents.create', companionId: 'bob', path: '日记/同名.md', content: 'Bob自己的阅读想法。', tags: ['阅读'] })).document!;
  const moved = await call({ type: 'memory.documents.move', path: first.document.path, targetPath: '资料/重新整理的约定.md', expectedRevision: first.document.revision });
  expect(moved.ok, moved.error).toBe(true);
  const located = await call({ type: 'memory.documents.locate', noteId: first.memory!.id });
  expect(located.document?.memory?.id).toBe(first.memory!.id);
  expect(located.document?.document.path).toBe('资料/重新整理的约定.md');
  expect(located.document?.content).toBe('Alice的海边约定。');
  expect(await call({ type: 'memory.documents.locate', noteId: other.memory!.id })).toMatchObject({ ok: false });
  expect((await call({ type: 'memory.documents.delete', path: located.document!.document.path, expectedRevision: located.document!.document.revision })).ok).toBe(true);
  expect(await call({ type: 'memory.documents.locate', noteId: first.memory!.id })).toMatchObject({ ok: false });
});

it('paginates all real owner documents beyond 256 files without dropping later notes', async () => {
  const f = fixture(), { library, call } = f.make();
  for (let n = 0; n < 270; n++) f.store.saveMemory({ ...f.scope, content: `分页日记 ${n}` });
  for (let n = 0; n < 10; n++) await library.sync();
  // Discovery is incremental; a stable cursor walk starts after its generation completes.
  await expect.poll(async () => (await call({ type: 'memory.documents.list', directory: '日记', limit: 37 })).documents?.index?.state, { timeout: 10000 }).toBe('ready');
  const seen = new Set<string>(); let cursor: string | undefined, pages = 0;
  do {
    const response = await call({ type: 'memory.documents.list', directory: '日记', limit: 37, cursor });
    expect(response.ok, response.error).toBe(true);
    for (const item of response.documents!.items) { expect(seen.has(item.path)).toBe(false); seen.add(item.path); }
    cursor = response.documents?.nextCursor; pages++;
    if (!response.documents?.hasMore) break;
    expect(cursor).toBeTruthy();
  } while (pages < 20);
  expect(seen.size).toBe(270); expect(pages).toBe(8);
});

it('binds semantic continuation to all human filters while preserving relevance order', async () => {
  const f = fixture(), { library, call: create } = f.make();
  const first = (await create({ type: 'memory.documents.create', path: '资料/甲.md', content: '第一份实际资料。', tags: ['成长'] })).document!;
  const second = (await create({ type: 'memory.documents.create', path: '资料/乙.md', content: '第二份实际资料。', tags: ['成长'] })).document!;
  const searchCalls: Array<string | undefined> = [];
  const manager = new CompanionMemoryDocuments({ libraryDirectory: f.directory, library, requestStorage: f.request,
    search: async (_owner, _query, _limit, cursor) => {
      searchCalls.push(cursor);
      return { hits: [{ noteId: (cursor ? first : second).memory!.id, version: 1 }], state: 'ready', indexed: 2, total: 2, ...(cursor ? {} : { nextCursor: 'native-page-2' }) };
    } }); documents.push(manager);
  const call = (options: object) => manager.handle(companionWorkspaceRequestSchema.parse({ type: 'memory.documents.list', companionId: 'alice', directory: '资料', query: '成长', mode: 'semantic', tags: ['成长'], limit: 1, ...options }) as Parameters<typeof manager.handle>[0]);
  const ready = await call({}); expect(ready.ok, ready.error).toBe(true);
  expect(ready.documents?.items.map(item => item.path)).toEqual(['资料/乙.md']);
  const cursor = ready.documents!.nextCursor; expect(cursor).toBeTruthy();
  const next = await call({ cursor }); expect(next.documents?.items.map(item => item.path)).toEqual(['资料/甲.md']);
  expect(searchCalls).toEqual([undefined, 'native-page-2']);
  for (const changed of [{ directory: '日记' }, { tags: [] }, { sort: 'created_asc' }, { from: '2026-10-01T00:00:00Z' }, { dateField: 'createdAt' }]) {
    expect(await call({ cursor, ...changed })).toMatchObject({ ok: false, error: '搜索条件或排序已经变化，请从第一页重新查询。' });
  }
  expect(searchCalls).toHaveLength(2);
});

it('keeps note identity, version, sources and diary metadata unchanged when moving a real file', async () => {
  const f = fixture(), { call, library } = f.make();
  const created = (await call({ type: 'memory.documents.create', path: '日记/原名.md', content: '同一篇真实日记。', tags: ['原标签'], diaryName: '原日记本' })).document!;
  const moved = await call({ type: 'memory.documents.move', path: '日记/原名.md', targetPath: '资料/整理/新名字.md', expectedRevision: created.document.revision });
  expect(moved.ok, moved.error).toBe(true);
  expect(moved.document?.memory).toEqual(created.memory);
  expect(moved.document?.document.revision).not.toBe(created.document.revision);
  for (let n = 0; n < 4; n++) await library.sync();
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toHaveLength(1);
  expect(existsSync(path.join(f.directory, 'alice', '日记/原名.md'))).toBe(false);
  expect(JSON.parse(readFileSync(path.join(f.directory, 'alice', '资料/整理/新名字.md.meta.json'), 'utf8')).id).toBe(created.memory?.id);
});

it('revises explicit content through manual evidence and changes only metadata without manufacturing another source', async () => {
  const f = fixture(), { call } = f.make();
  const created = (await call({ type: 'memory.documents.create', path: '日记/编辑.md', content: '原始正文。', tags: ['旧'] })).document!;
  const edited = (await call({ type: 'memory.documents.save', path: created.document.path, content: '用户明确编辑的新正文。', expectedRevision: created.document.revision })).document!;
  expect(edited.memory).toMatchObject({ id: created.memory!.id, version: 2, content: '用户明确编辑的新正文。' });
  expect(edited.document.createdAt).toBe(created.document.createdAt);
  expect(Date.parse(edited.document.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.document.updatedAt));
  const previousSources = edited.memory!.sources;
  const metadata = await call({ type: 'memory.documents.save', path: edited.document.path, content: edited.content, expectedRevision: edited.document.revision, tags: ['新'], diaryName: '学习' });
  expect(metadata.ok, metadata.error).toBe(true);
  expect(metadata.document?.memory).toMatchObject({ version: 3, tags: ['新'], diaryName: '学习' });
  expect(metadata.document?.memory?.sources).toEqual(previousSources);
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: created.memory!.id }).memoryRead?.memory).toEqual(metadata.document?.memory);
});

it('rejects stale physical content and stale ledger revisions even when the displayed text did not change', async () => {
  const f = fixture(), { call } = f.make();
  const created = (await call({ type: 'memory.documents.create', path: '日记/冲突.md', content: '版本一。' })).document!;
  f.store.saveMemory({ ...f.scope, id: created.memory!.id, expectedVersion: 1, content: '版本一。' });
  const stale = await call({ type: 'memory.documents.save', path: created.document.path, content: '不得覆盖。', expectedRevision: created.document.revision });
  expect(stale).toMatchObject({ ok: false }); expect(stale.error).toContain('发生变化');
  const current = (await call({ type: 'memory.documents.read', path: created.document.path, sourceLimit: 30 })).document!;
  writeFileSync(path.join(f.directory, 'alice', created.document.path), '外部编辑器的内容。');
  const external = await call({ type: 'memory.documents.save', path: created.document.path, content: '不得覆盖外部内容。', expectedRevision: current.document.revision });
  expect(external.ok).toBe(false);
  expect(readFileSync(path.join(f.directory, 'alice', created.document.path), 'utf8')).toBe('外部编辑器的内容。');
});

it('preserves a real message source when the human creates a diary from it, and rejects an unwitnessed group source', async () => {
  const f = fixture(), { call } = f.make();
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '我把蓝色雨伞借给了Alice。', replyDirective: 'none' });
  const created = await call({ type: 'memory.documents.create', path: '日记/借伞.md', content: '借了用户的蓝色雨伞。', sourceMessageId: source.id, tags: ['雨伞'] });
  expect(created.ok, created.error).toBe(true);
  expect(created.document?.memory?.sources).toMatchObject([{ sourceType: 'message', messageId: source.id }]);
  expect(created.document?.memory?.captureMethod).toBe('automatic');
  const group = f.store.createConversation('先前的群聊', ['alice']);
  const unseen = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: 'Bob当时不在场。', replyDirective: 'none' });
  f.store.updateConversation(group.id, { memberIds: ['alice', 'bob'] });
  const denied = await call({ type: 'memory.documents.create', companionId: 'bob', path: '日记/未见证.md', content: unseen.content, sourceMessageId: unseen.id });
  expect(denied.ok).toBe(false);
  expect(f.store.request({ type: 'memory.list', companionId: 'bob' }).memories).toEqual([]);
});

it('forgets every historical source on delete and never resurrects the restored file after restart', async () => {
  const f = fixture(), first = f.make();
  const created = (await first.call({ type: 'memory.documents.create', path: '资料/删除.md', content: '旧的私密资料。' })).document!;
  const revised = (await first.call({ type: 'memory.documents.save', path: created.document.path, content: '修订后的私密资料。', expectedRevision: created.document.revision })).document!;
  expect((await first.call({ type: 'memory.documents.delete', path: revised.document.path, expectedRevision: revised.document.revision })).ok).toBe(true);
  const allSources = [...new Set([...created.memory!.sources, ...revised.memory!.sources].map(source => source.messageId))];
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: allSources }).memorySources).toEqual([]);
  await first.manager.close(); await first.library.close();
  writeFileSync(path.join(f.directory, 'alice', revised.document.path), revised.content);
  const restarted = f.make(); await restarted.library.sync();
  expect(existsSync(path.join(f.directory, 'alice', revised.document.path))).toBe(false);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
});

it('enforces the host expected version atomically if a note changes between file read and delete', async () => {
  const f = fixture(); let race = false;
  const { call } = f.make(async command => {
    if (command.type === 'memory.library.delete' && race) {
      race = false; f.store.saveMemory({ ...f.scope, id: command.id, expectedVersion: command.expectedVersion, content: '删除前的真实并发修订。' });
    }
    return f.request(command);
  });
  const created = (await call({ type: 'memory.documents.create', path: '日记/删除竞争.md', content: '必须保存。' })).document!; race = true;
  const deleted = await call({ type: 'memory.documents.delete', path: created.document.path, expectedRevision: created.document.revision });
  expect(deleted.ok).toBe(false);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories?.[0]?.content).toBe('删除前的真实并发修订。');
  expect(existsSync(path.join(f.directory, 'alice', created.document.path))).toBe(true);
});

it('keeps stable persona and generated native timeline files read-only while allowing an explicit material copy', async () => {
  const f = fixture(), { call, library } = f.make(); await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.revision;
  await library.publishTimelines(f.scope, { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision,
    owner: companionMemoryIdentity({ id: 'alice', name: 'alice' }),
    agents: [{ agentName: 'alice', months: [{ month: '2026-10', sourceDigest: 'digest', content: '原版生成的时间线正文。' }] }] }, async () => true);
  const file = `时间线/VCP-${f.scope.companionId}-2026-10.md`;
  for (const relative of ['profile.md', file]) {
    const read = (await call({ type: 'memory.documents.read', path: relative, sourceLimit: 30 })).document!;
    expect(read.document.readOnly).toBe(true);
    expect((await call({ type: 'memory.documents.save', path: relative, content: '不可覆盖。', expectedRevision: read.document.revision })).ok).toBe(false);
    expect((await call({ type: 'memory.documents.delete', path: relative, expectedRevision: read.document.revision })).ok).toBe(false);
  }
  expect((await call({ type: 'memory.documents.create', path: '资料/时间线摘录.md', content: '原版生成的时间线正文。' })).ok).toBe(true);
  expect(f.store.state().companions.find(owner => owner.id === 'alice')?.persona).toBe('alice 的稳定人格。');
});

it('never trusts a copied sidecar for source authority and rejects owner crossings, links and Windows path aliases', async () => {
  const f = fixture(), { call, library } = f.make(); await library.sync();
  const other = f.store.saveMemory({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id, content: 'Bob的来源。' });
  const local = path.join(f.directory, 'alice', '资料/伪说明.md'); writeFileSync(local, '普通本地文本。');
  writeFileSync(local + '.meta.json', JSON.stringify({ id: other.id, conversationId: other.sourceConversationId, authority: 'forged' }));
  const read = await call({ type: 'memory.documents.read', path: '资料/伪说明.md', sourceLimit: 30 });
  expect(read.ok, read.error).toBe(true); expect(read.document?.memory).toBeUndefined(); expect(read.document?.sources).toEqual([]);
  for (const relative of ['../bob/profile.md', '资料/../别处.md', '资料/NUL.md', '资料/a.md:stream', '资料/末尾 .', '/绝对.md']) {
    expect((await call({ type: 'memory.documents.create', path: relative, content: '不可越界。' })).ok).toBe(false);
  }
  const outside = path.join(f.root, 'outside'); mkdirSync(outside); const external = path.join(outside, '外部.md'); writeFileSync(external, '外部原文。');
  linkSync(external, path.join(f.directory, 'alice', '资料/硬链接.md'));
  expect((await call({ type: 'memory.documents.read', path: '资料/硬链接.md', sourceLimit: 30 })).ok).toBe(false);
  symlinkSync(outside, path.join(f.directory, 'alice', '资料/目录联接'), 'junction');
  expect((await call({ type: 'memory.documents.create', path: '资料/目录联接/新文档.md', content: '不得写外部。' })).ok).toBe(false);
  expect(readFileSync(external, 'utf8')).toBe('外部原文。'); expect(existsSync(path.join(outside, '新文档.md'))).toBe(false);
});

it('recovers a committed save receipt and an interrupted physical move without duplicate manual records', async () => {
  const f = fixture(); let fail = true;
  const first = f.make(async command => {
    const response = await f.request(command);
    if (command.type === 'memory.save' && fail) { fail = false; throw new Error('提交后运输中断。'); }
    return response;
  });
  expect((await first.call({ type: 'memory.documents.create', path: '资料/恢复.md', content: '同一次真实输入。' })).ok).toBe(false);
  await first.manager.close(); await first.library.close();
  const next = f.make(); await next.library.sync();
  const read = (await next.call({ type: 'memory.documents.read', path: '资料/恢复.md', sourceLimit: 30 })).document!;
  expect(read.memory?.version).toBe(1);
  await next.manager.close(); await next.library.close();
  const ownerRoot = path.join(f.directory, 'alice'), manifestFile = path.join(ownerRoot, '.同步状态.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.move = { from: '资料/恢复.md', to: '资料/崩溃后名字.md', hash: createHash('sha256').update(read.content).digest('hex') };
  writeFileSync(manifestFile, JSON.stringify(manifest)); renameSync(path.join(ownerRoot, manifest.move.from), path.join(ownerRoot, manifest.move.to));
  const final = f.make(); await final.library.sync();
  const moved = await final.call({ type: 'memory.documents.read', path: manifest.move.to, sourceLimit: 30 });
  expect(moved.ok, moved.error).toBe(true); expect(moved.document?.memory).toEqual(read.memory);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toHaveLength(1);
});

it('withdraws a full-text read when its real source is forgotten while the file is being loaded', async () => {
  const f = fixture(); let withdraw = false;
  const { call } = f.make(async command => {
    const response = await f.request(command);
    if (withdraw && command.type === 'memory.library.read' && 'sourceLimit' in command) {
      withdraw = false; f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: command.id, expectedVersion: response.memoryRead!.memory.version });
    }
    return response;
  });
  const created = (await call({ type: 'memory.documents.create', path: '日记/撤回竞争.md', content: 'REVOKED_WHILE_READING' })).document!;
  withdraw = true;
  const result = await call({ type: 'memory.documents.read', path: created.document.path, sourceLimit: 30 });
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('REVOKED_WHILE_READING');
  expect(existsSync(path.join(f.directory, 'alice', created.document.path))).toBe(false);
});

it('maps genuine world-observation evidence into the world notebook rather than guessing from note text', async () => {
  const f = fixture(), { library, call } = f.make();
  const observation = f.store.request({ type: 'memory.world_query', ...f.scope, category: 'contacts', query: 'bob' }).memorySources![0]!;
  const note = f.store.request({ type: 'memory.record', ...f.scope, candidate: { content: '真正观察到的联系人信息。', tags: [], diaryName: '经历',
    sourceMessageIds: [observation.id], evidence: [{ sourceMessageId: observation.id, quote: observation.content.slice(0, 100) }] } }).memories![0]!;
  await library.sync();
  const result = await call({ type: 'memory.documents.read', path: `世界经历/${note.id}.md`, sourceLimit: 30 });
  expect(result.ok, result.error).toBe(true);
  expect(result.document?.document.category).toBe('world');
  expect(result.document?.memory?.sources[0]?.sourceType).toBe('world_observation');
  expect(result.document?.sources[0]?.worldObservation).toBeDefined();
  for (const diaryName of ['自我认识', '资料']) {
    const classified = f.store.request({ type: 'memory.record', ...f.scope, candidate: { content: `基于真实世界来源的${diaryName}。`, tags: [], diaryName,
      sourceMessageIds: [observation.id], evidence: [{ sourceMessageId: observation.id, quote: observation.content.slice(0, 100) }] } }).memories![0]!;
    await library.sync();
    const explicit = await call({ type: 'memory.documents.read', path: `${diaryName}/${classified.id}.md`, sourceLimit: 30 });
    expect(explicit.ok, explicit.error).toBe(true);
    expect(explicit.document?.document.category).toBe(diaryName === '资料' ? 'material' : 'self');
    expect(explicit.document?.memory?.sources[0]?.sourceType).toBe('world_observation');
  }
});

it('reports physical edits as pending until their content really reaches the existing host ledger and native outbox', async () => {
  const f = fixture(); let edit = false;
  const { call } = f.make(async command => {
    const response = await f.request(command);
    if (edit && command.type === 'memory.library.read' && 'sourceLimit' in command) {
      edit = false; writeFileSync(path.join(f.directory, 'alice', '资料/磁盘状态.md'), '尚未收录的磁盘新正文。');
    }
    return response;
  });
  const created = (await call({ type: 'memory.documents.create', path: '资料/磁盘状态.md', content: '已入库的旧正文。' })).document!;
  const outbox = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  edit = true;
  const result = await call({ type: 'memory.documents.read', path: created.document.path, sourceLimit: 30 });
  expect(result.ok, result.error).toBe(true);
  expect(result.document?.content).toBe('尚未收录的磁盘新正文。');
  expect(result.document?.memory).toMatchObject({ content: '已入库的旧正文。', status: 'indexed', version: 1 });
  expect(result.document?.document.syncState).toBe('pending');
});

it('reads long automatic timeline text and rejects a restored stale automatic export without recapturing it', async () => {
  const f = fixture(), { library, call } = f.make(); await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.revision;
  const content = '原版时间线完整正文。'.repeat(10000), relative = `时间线/VCP-${f.scope.companionId}-2026-10.md`;
  await library.publishTimelines(f.scope, { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision,
    owner: companionMemoryIdentity({ id: 'alice', name: 'alice' }),
    agents: [{ agentName: 'alice', months: [{ month: '2026-10', sourceDigest: 'digest', content }] }] }, async () => true);
  const long = await call({ type: 'memory.documents.read', path: relative, sourceLimit: 30 });
  expect(long.ok, long.error).toBe(true); expect(long.document?.content).toBe(content); expect(content.length).toBeGreaterThan(65536);
  await library.invalidate('alice'); writeFileSync(path.join(f.directory, 'alice', relative), 'STALE_TIMELINE_COPY');
  const stale = await call({ type: 'memory.documents.read', path: relative, sourceLimit: 30 });
  expect(stale.ok).toBe(false); expect(JSON.stringify(stale)).not.toContain('STALE_TIMELINE_COPY');
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
});
