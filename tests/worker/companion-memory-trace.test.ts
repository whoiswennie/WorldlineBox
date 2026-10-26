import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionMemoryTracePageSchema, companionMemoryTraceSchema } from '../../src/shared/companion-memory-trace';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真核验资料。', model: '', avatar: 'sister', proactive: false, active: true }));
const fixtures: Array<{ root: string; file: string; store: CompanionsStore; db: CompanionConnection }> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00.000Z'); });
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); f.store.close(); if (path.dirname(f.root) !== tmpdir() || !path.basename(f.root).startsWith('worldlinebox-memory-trace-')) throw new Error('Unexpected fixture.'); removeOwnedDirectorySync(f.root); } vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-trace-')), file = path.join(root, 'messages.sqlite'), store = new CompanionsStore(file, seeds);
  const db = new (Database as { new(file: string): CompanionConnection })(file), result = { root, file, store, db }; fixtures.push(result); return result;
}
function learned(f: ReturnType<typeof fixture>, owner = 'alice') {
  const grant = f.store.request({ type: 'learning.grant', companionId: owner, libraryId: 'library-' + owner, libraryName: '海边书架', libraryPath: f.root, autonomous: true, intervalMinutes: 30 }).learning!.grants[0]!;
  const job = f.store.request({ type: 'learning.claim', excludedOwners: owner === 'bob' ? ['alice'] : [] }).learningJob!;
  const content = '先核对出处，再把结论写成有条件的观察。';
  const read = f.store.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: 'book-' + owner, assetRevisionId: 'revision-one', assetName: '海风与阅读笔记.md', offset: 0, content, more: false }).learning!.reads[0]!;
  return { grant, read, content };
}
const list = (f: ReturnType<typeof fixture>, input: { companionId?: string; kind?: 'all' | 'learning' | 'journal' | 'sleep' | 'dream'; query?: string; cursor?: string; limit?: number } = {}) => f.store.request({ type: 'memory.trace.list', companionId: 'alice', ...input }).memoryTracePage!;

describe('bounded persistent memory provenance', () => {
  it('traces a real authorized read through shared source capture, exact journal evidence and index confirmation without inventing mastery', () => {
    const f = fixture(), { read, content } = learned(f), capture = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    const journalContent = content + '\n\n' + '这份学习仍然只是参考，之后还要核验它适用的条件。'.repeat(20);
    const note = f.store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken, notes: [{ content: journalContent, diaryName: '核对出处的阅读观察', tags: ['出处'], sourceMessageIds: [read.sourceMessageId], evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] }] }).memories![0]!;
    const outbox = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
    const before = f.db.prepare('PRAGMA data_version').get();
    expect(companionMemoryTracePageSchema.parse(list(f))).toEqual(list(f));
    const report = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'learning', id: read.id }).memoryTrace!;
    expect(companionMemoryTraceSchema.parse(report)).toEqual(report);
    expect(report.root).toMatchObject({ kind: 'learning', id: read.id, redacted: false, title: '海风与阅读笔记.md' });
    expect(report.root.asset).toMatchObject({ assetId: 'book-alice', assetRevisionId: 'revision-one', offset: 0, characters: content.length, contentHash: read.contentHash });
    expect(report.stages.find(stage => stage.kind === 'memory')!.records).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: note.id, relation: 'exact_source', confidence: 'exact' })]));
    expect(report.stages.find(stage => stage.kind === 'capture')!.records).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'batch_output', confidence: 'exact',
      captureBatchId: capture.id, outputCount: 1, outputs: [{ noteId: note.id, version: 1 }] })]));
    expect(report.stages.find(stage => stage.kind === 'index')!.records).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'done', noteId: note.id, version: 1, relation: 'delivery' })]));
    expect(JSON.stringify(report)).not.toContain(journalContent); expect(JSON.stringify(report)).not.toContain('之后还要核验它适用的条件');
    expect(report.limitations.join('')).toContain('不等于');
    expect(f.db.prepare('PRAGMA data_version').get()).toEqual(before);
    expect(() => f.store.request({ type: 'memory.trace.inspect', companionId: 'bob', kind: 'learning', id: read.id })).toThrow('不属于当前伙伴');
    const peer = learned(f, 'bob'), empty = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'bob' }).memoryJob!;
    f.store.request({ type: 'memory.jobs.complete', id: empty.id, leaseToken: empty.leaseToken, notes: [] });
    const checked = f.store.request({ type: 'memory.trace.inspect', companionId: 'bob', kind: 'learning', id: peer.read.id, stage: 'capture' }).memoryTrace!.stages[0]!.records[0]!;
    expect(checked).toMatchObject({ outputCount: 0, outputs: [], captureBatchId: empty.id, relation: 'shared_source' });
    expect(checked.detail).toContain('没有提交任何日记');
  });
  it('independently pages more than twenty exact-source journals and rejects reused root/stage cursors', () => {
    const f = fixture(), { read, content } = learned(f), job = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: Array.from({ length: 37 }, (_, n) => ({ content: content + ' 观察编号 ' + n, diaryName: '读书札记 ' + n, sourceMessageIds: [read.sourceMessageId], evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] })) });
    const seen: string[] = []; let cursor: string | undefined;
    for (let n = 0; n < 10; n++) {
      const page = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'learning', id: read.id, stage: 'memory', cursor, limit: 8 }).memoryTrace!;
      expect(page.stages).toHaveLength(1); const stage = page.stages[0]!; expect(stage.records.length).toBeLessThanOrEqual(8); seen.push(...stage.records.map(record => record.noteId!));
      if (!stage.hasMore) break; cursor = stage.nextCursor!;
      expect(() => f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'learning', id: read.id, stage: 'index', cursor, limit: 8 })).toThrow('分页不属于');
    }
    expect(seen).toHaveLength(37); expect(new Set(seen).size).toBe(37);
  });
  it('atomically records bounded batch results, deduplication and empty acknowledgements while keeping legacy, stale and foreign results uncertain', () => {
    const f = fixture(), room = f.store.openPrivate('alice').id, scope = { companionId: 'alice', conversationId: room };
    const first = f.store.appendMessage({ conversationId: room, authorId: 'user', content: '前一条消息先登记在这个批次里。' });
    const source = f.store.appendMessage({ conversationId: room, authorId: 'user', content: '海边约好带上书签。' });
    const claim = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    expect(claim.sourceMessageIds).toEqual([first.id, source.id]);
    const candidate = { content: '海边约好带上书签。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
    const notes = f.store.request({ type: 'memory.jobs.complete', id: claim.id, leaseToken: claim.leaseToken, notes: [candidate, candidate] }).memories!;
    expect(notes[0]!.id).toBe(notes[1]!.id); // A repeated candidate reuses the existing confirmed version.
    const note = notes[0]!, ack = f.db.prepare('SELECT completed_batch_id,output_note_versions FROM vcp_capture_jobs WHERE companion_id=? ORDER BY ordinal').all('alice') as Array<{ completed_batch_id: string; output_note_versions: string }>;
    expect(ack).toHaveLength(2); expect(ack.every(row => row.completed_batch_id === claim.id)).toBe(true);
    expect(ack.map(row => JSON.parse(row.output_note_versions))).toEqual([[{ id: note.id, version: 1 }], [{ id: note.id, version: 1 }]]);
    expect(ack.every(row => !row.output_note_versions.includes('海边'))).toBe(true);
    const inspect = () => f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'journal', id: note.id, stage: 'capture' }).memoryTrace!.stages[0]!.records[0]!;
    expect(inspect()).toMatchObject({ relation: 'batch_output', confidence: 'exact', outputCount: 1, captureBatchId: claim.id, outputs: [{ noteId: note.id, version: 1 }] });
    expect(inspect().detail).toContain('不代表新创');
    const later = f.store.appendMessage({ conversationId: room, authorId: 'user', content: '这次只是随便聊聊，不一定要留下日记。' });
    const failed = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    const countBefore = f.db.prepare('SELECT COUNT(*) AS n FROM vcp_memory_notes').get(), deliveryBefore = f.db.prepare('SELECT COUNT(*) AS n FROM vcp_memory_outbox').get();
    const valid = { content: '本次应当随着整个失败事务回滚。', sourceMessageIds: [later.id], evidence: [{ sourceMessageId: later.id, quote: later.content }] };
    expect(() => f.store.request({ type: 'memory.jobs.complete', id: failed.id, leaseToken: failed.leaseToken, notes: [valid, { ...valid, content: '另一条失败候选。', evidence: [{ sourceMessageId: later.id, quote: '这不是真实来源的原文。' }] }] })).toThrow();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM vcp_memory_notes').get()).toEqual(countBefore); expect(f.db.prepare('SELECT COUNT(*) AS n FROM vcp_memory_outbox').get()).toEqual(deliveryBefore);
    expect(f.db.prepare('SELECT status,completed_batch_id,output_note_versions FROM vcp_capture_jobs WHERE id=?').get(failed.id)).toEqual({ status: 'running', completed_batch_id: null, output_note_versions: null });
    f.store.request({ type: 'memory.jobs.complete', id: failed.id, leaseToken: failed.leaseToken, notes: [] });
    expect(f.db.prepare('SELECT status,completed_batch_id,output_note_versions FROM vcp_capture_jobs WHERE id=?').get(failed.id)).toEqual({ status: 'done', completed_batch_id: failed.id, output_note_versions: '[]' });
    f.store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: 1, candidate: { ...candidate, content: '后来重新核对了海边的约定。' } });
    expect(inspect()).toMatchObject({ relation: 'shared_source', confidence: 'shared_source', outputCount: 1, outputs: [] });
    f.db.prepare('UPDATE vcp_capture_jobs SET completed_batch_id=NULL,output_note_versions=NULL WHERE id=? OR message_id=?').run(claim.id, source.id);
    expect(inspect()).toMatchObject({ relation: 'shared_source', confidence: 'shared_source' }); expect(inspect().outputCount).toBeUndefined();
    const peerRoom = f.store.openPrivate('bob').id, peer = f.store.saveMemory({ companionId: 'bob', conversationId: peerRoom, content: '大肥鱼的私人书签约定。' });
    f.db.prepare('UPDATE vcp_capture_jobs SET completed_batch_id=?,output_note_versions=? WHERE message_id=?').run(claim.id, JSON.stringify([{ id: peer.id, version: peer.version }]), source.id);
    expect(inspect()).toMatchObject({ relation: 'shared_source', confidence: 'shared_source', outputs: [] }); expect(JSON.stringify(inspect())).not.toContain(peer.id);
    f.store.request({ type: 'memory.forget', ...scope, id: note.id });
    const withdrawn = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'journal', id: note.id }).memoryTrace!;
    expect(withdrawn.root.redacted).toBe(true); expect(withdrawn.stages).toEqual([]); expect(JSON.stringify(withdrawn)).not.toContain('海边约好');
  });
  it('removes withdrawn titles from search and never returns old note/source content through inspect or cached metadata', () => {
    const f = fixture(), { read, grant, content } = learned(f), job = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    const note = f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ content, diaryName: '只有这一次的海风暗号', sourceMessageIds: [read.sourceMessageId], evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] }] }).memories![0]!;
    expect(list(f, { query: '海风暗号' }).entries.map(entry => entry.id)).toContain(note.id);
    f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
    expect(list(f, { query: '海风暗号' }).entries).toEqual([]);
    const forgotten = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'journal', id: note.id }).memoryTrace!;
    expect(forgotten.root.redacted).toBe(true); expect(forgotten.stages).toEqual([]); expect(JSON.stringify(forgotten)).not.toMatch(/海风暗号|先核对出处/u);
    const withdrawn = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'learning', id: read.id }).memoryTrace!;
    expect(withdrawn.root.redacted).toBe(true); expect(withdrawn.root.sourceMessageId).toBeUndefined();
    expect(JSON.stringify(withdrawn)).not.toContain('海风与阅读笔记.md');
  });
  it('uses bounded natural opening titles consistently and upgrades an old diary-only cache in maintenance batches', () => {
    const f = fixture(), { read, content, grant } = learned(f), scope = { companionId: 'alice', conversationId: 'world_alice' };
    const candidate = { sourceMessageIds: [read.sourceMessageId], evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }], diaryName: '日记' };
    const plain = f.store.request({ type: 'memory.record', ...scope, candidate: { ...candidate,
      content: '# 海边约定\n今天约好在旧灯塔前见面。' + '慢慢走，留一点空白。'.repeat(30) + '这是正文后面的独特暗号。' } }).memories![0]!;
    const named = f.store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: '这段开头不应覆盖用户命名。',
      metadata: { title: '书签与旧灯塔', documentName: '文档命名.md' } } }).memories![0]!;
    const document = f.store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: '另一个正文开头。', metadata: { documentName: '海边手记.md' } } }).memories![0]!;
    const sentence = f.store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: '今天约好去海边散步。第二句不应该进入标题。' } }).memories![0]!;
    const long = f.store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: '海'.repeat(150) } }).memories![0]!;
    const inspect = (id: string) => f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'journal', id }).memoryTrace!;
    expect(inspect(plain.id).root.title).toBe('海边约定');
    expect(inspect(plain.id).stages.find(stage => stage.kind === 'memory')!.records.find(record => record.noteId === plain.id)?.title).toBe('海边约定');
    expect(inspect(named.id).root.title).toBe('书签与旧灯塔'); expect(inspect(document.id).root.title).toBe('海边手记.md');
    expect(inspect(sentence.id).root.title).toBe('今天约好去海边散步。'); expect([...inspect(long.id).root.title]).toHaveLength(120);
    expect(list(f, { query: '海边约定' }).entries.find(entry => entry.id === plain.id)?.title).toBe(inspect(plain.id).root.title);
    expect(list(f, { query: '正文后面的独特暗号' }).entries).toEqual([]);
    // The prior installed metadata cache has only a notebook/category name.
    f.db.prepare("UPDATE companion_memory_trace_catalog SET title='日记',search=entity_id||' 日记' WHERE kind='journal'").run();
    f.db.prepare("UPDATE metadata SET value='1' WHERE key='memory-trace-metadata-version'").run();
    f.store.close(); f.store = new CompanionsStore(f.file, seeds);
    expect(list(f, { query: '海边约定' })).toMatchObject({ entries: [], index: { state: 'indexing' } });
    const versionBeforeRead = f.db.prepare('PRAGMA data_version').get();
    expect(inspect(plain.id).root.title).toBe('海边约定'); expect(f.db.prepare('PRAGMA data_version').get()).toEqual(versionBeforeRead);
    for (let batch = 0; batch < 20 && !f.store.backfillTraceIndex(1); batch++) { /* A one-row bounded migration. */ }
    expect(list(f, { query: '海边约定' })).toMatchObject({ index: { state: 'ready' }, entries: [expect.objectContaining({ id: plain.id, title: '海边约定' })] });
    // New trigger definitions must also apply after upgrading an already installed database.
    f.store.request({ type: 'memory.revise', ...scope, id: plain.id, expectedVersion: plain.version, candidate: { ...candidate, content: '沿着海岸慢慢走。第二句属于正文。' } });
    expect(list(f, { query: '海边约定' }).entries).toEqual([]); expect(list(f, { query: '沿着海岸' }).entries[0]?.title).toBe('沿着海岸慢慢走。');
    f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
    expect(list(f, { query: '沿着海岸' }).entries).toEqual([]); expect(inspect(plain.id).root.redacted).toBe(true);
    expect(JSON.stringify(inspect(plain.id))).not.toMatch(/沿着海岸|海边约定/u);
  });
  it('distinguishes version dependencies, successful review watermarks and persisted dream task links without claiming ordinary reflection has a job ID', () => {
    const f = fixture(), { read, content } = learned(f), capture = f.store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    const note = f.store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken, notes: [{ content, diaryName: '查证资料', sourceMessageIds: [read.sourceMessageId], evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] }] }).memories![0]!;
    const scope = { companionId: 'alice', conversationId: 'world_alice' };
    const outbox = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
    // Trace exact host receipts from the actual sleeping actor and current
    // lease. Ordinary metadata must never manufacture a link to some job.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const world = f.store.request({ type: 'world.snapshot' }).world!;
    f.store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routineScope = { companionId: 'alice', conversationId: f.store.openPrivate('alice').id };
    const routine = f.store.request({ type: 'routine.get', ...routineScope }).routine!;
    f.store.request({ type: 'routine.configure', ...routineScope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '09:00', wakeAt: '11:00', meals: [], habits: [] } });
    vi.setSystemTime(Date.now() + 16000); f.store.request({ type: 'world.tick' });
    const job = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    random.mockRestore(); expect(job.dreamAllowed).toBe(true);
    const sleepId = job.id, episode = job.sleepEpisodeId!;
    f.store.request({ type: 'world.job.complete', stage: 'real', id: sleepId, leaseToken: job.leaseToken!, sourceMemoryIds: [note.id],
      memoryCandidates: [{ content: '资料中的结论应当保留出处与适用条件。', diaryName: '睡眠反思', sourceMessageIds: [read.sourceMessageId], relatedMemoryIds: [note.id],
        evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] }] });
    f.store.request({ type: 'world.job.narrative.begin', id: sleepId, leaseToken: job.leaseToken! });
    f.store.request({ type: 'world.job.complete', stage: 'dream', id: sleepId, leaseToken: job.leaseToken!, sourceMemoryIds: [note.id],
      dream: { text: '梦境里的书签像海风一样轻。这是虚拟联想。', sourceMessageIds: [read.sourceMessageId], relatedMemoryIds: [note.id],
        evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] } });
    for (;;) {
      const pending = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox;
      if (!pending) break;
      f.store.request({ type: 'memory.outbox.complete', id: pending.id, leaseToken: pending.leaseToken, indexed: true });
    }
    const saved = f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes;
    const reflection = saved.find(note => note.diaryName === '睡眠反思')!, dream = saved.find(note => note.metadata?.dream === true)!;
    expect(reflection).toBeDefined(); expect(dream).toBeDefined();
    const trace = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'journal', id: note.id }).memoryTrace!;
    expect(companionMemoryTraceSchema.parse(trace)).toEqual(trace);
    expect(trace.stages.find(stage => stage.kind === 'sleep')?.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'review', relation: 'reviewed_version', version: 1 }), expect.objectContaining({ kind: 'sleep', relation: 'bound_version' })]));
    expect(trace.stages.find(stage => stage.kind === 'memory')?.records.find(item => item.noteId === reflection.id)).toMatchObject({ relation: 'dependency' });
    expect(trace.stages.find(stage => stage.kind === 'memory')?.records.find(item => item.noteId === reflection.id)?.worldJobId).toBeUndefined();
    expect(trace.stages.find(stage => stage.kind === 'dream')?.records.find(item => item.noteId === dream.id)).toMatchObject({ worldJobId: sleepId, sleepEpisodeId: episode, relation: 'dependency' });
    f.store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: 1, candidate: { content: content + ' 这里补充了新的条件。', sourceMessageIds: [read.sourceMessageId], evidence: [{ sourceMessageId: read.sourceMessageId, quote: content }] } });
    const oldSleep = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'sleep', id: sleepId }).memoryTrace!;
    expect(oldSleep.stages.find(stage => stage.kind === 'memory')!.records).toEqual([]);
    const oldDream = f.store.request({ type: 'memory.trace.inspect', companionId: 'alice', kind: 'dream', id: dream.id }).memoryTrace!;
    expect(oldDream.root.redacted).toBe(true); expect(oldDream.stages).toEqual([]);
  });
  it('exposes bounded resumable metadata backfill and searches ten thousand historical notes without JSON-body scans', () => {
    const f = fixture(), room = f.store.openPrivate('alice').id, base = f.store.saveMemory({ companionId: 'alice', conversationId: room, content: '普通的可读文本。', diaryName: '札记' });
    const insert = f.db.prepare('INSERT INTO vcp_memory_notes(id,companion_id,conversation_id,scope_id,identity_key,data) VALUES(?,?,?,?,?,?)');
    const start = performance.now();
    f.db.transaction(() => { for (let n = 0; n < 10000; n++) {
      const id = 'history_' + String(n).padStart(5, '0'), note = { ...base, id, diaryName: '日记',
        content: '# ' + (n === 9999 ? '海边书签观测笔记' : '阅读札记 ' + n) + '\n' + '绝不索引进足迹搜索的原文内容。'.repeat(50) };
      insert.run(id, 'alice', room, base.scopeId, id, JSON.stringify(note));
    } }).immediate();
    // A legacy-install fixture: drop only this rebuildable index and reopen its owned database.
    const names = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'companion_trace_*'").all() as Array<{ name: string }>;
    for (const row of names) { if (!/^companion_trace_[a-z_]+$/u.test(row.name)) throw new Error('Unexpected index trigger.'); f.db.exec('DROP TRIGGER ' + row.name); }
    f.db.exec('DROP TABLE companion_memory_trace_search; DROP TABLE companion_memory_trace_catalog; DROP TABLE companion_memory_trace_backfill');
    f.store.close(); f.store = new CompanionsStore(f.file, seeds);
    const initial = list(f, { query: '海边书签' }); expect(initial.index.state).toBe('indexing'); expect(initial.entries).toEqual([]);
    const before = f.db.prepare('PRAGMA data_version').get(); list(f); expect(f.db.prepare('PRAGMA data_version').get()).toEqual(before);
    f.store.backfillTraceIndex(200); expect(list(f).index.indexed).toBeLessThanOrEqual(200);
    for (let batch = 0; batch < 80 && !f.store.backfillTraceIndex(200); batch++) { /* Explicit worker maintenance batches. */ }
    const searchAt = performance.now(), result = list(f, { query: '海边书签' }), searchMs = performance.now() - searchAt;
    expect(result.index.state).toBe('ready'); expect(result.entries).toHaveLength(1); expect(result.entries[0]!.id).toBe('history_09999');
    expect(list(f, { query: '绝不索引进足迹搜索' }).entries).toEqual([]);
    const shortAt = performance.now(); expect(list(f, { query: '书签' }).entries).toHaveLength(1); const shortMs = performance.now() - shortAt;
    expect(searchMs).toBeLessThan(3000); expect(shortMs).toBeLessThan(3000);
    const dir = path.resolve('artifacts/vcp-validation'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'memory-trace-metadata-10000.json'), JSON.stringify({ notes: 10001, initialBatchLimit: 200, searchMs, shortMetadataSearchMs: shortMs, totalFixtureMs: performance.now() - start, fullBodyIndexed: false }, null, 2));
  });
});
