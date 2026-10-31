import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import { companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import type { CompanionMemoryDocumentCommand } from '../../src/shared/companion-memory-documents';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };

it('keeps valid diaries visible when one derived navigation is waiting for a new source revision', async () => {
  const f = fixture(), note = f.record('刚打开页面也应该能看见的正式日记。'); await f.publish();
  const registry = await f.artifacts('alice');
  const relative = '记忆/导航/outdated.md';
  await registry.publish({ artifactId: 'navigation:outdated', kind: 'navigation', producer: { kind: 'system', id: 'vcp-navigation' },
    relativePath: relative, expectedRevision: null,
    content: '---\n' + JSON.stringify({ schema: 'worldlinebox.companion-navigation-v2', scope: f.scope, sourceRevision: 'older-source-revision' }) + '\n---\n旧导航',
    sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['navigation', 'audit'], retentionClass: 'current', operationId: 'fixture:old-navigation' });
  const page = await f.documents.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '', recordsOnly: true, limit: 64 });
  expect(page.ok, page.error).toBe(true);
  expect(page.documents?.items.some(item => item.noteId === note.id)).toBe(true);
  expect(page.documents?.items.some(item => item.path === relative)).toBe(false);
  const stale = await f.documents.handle({ type: 'memory.documents.read', companionId: 'alice', path: relative, sourceLimit: 1 });
  expect(stale.ok).toBe(false); expect(stale.document).toBeUndefined();
});
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

it('rejects every manual cognition-writing command without creating memory, directories or outbox work', async () => {
  const f = fixture(), commands: CompanionMemoryDocumentCommand[] = [
    { type: 'memory.documents.create', companionId: 'alice', path: '记忆/知识/人工.md', content: '伪造认识。', tags: [] },
    { type: 'memory.documents.save', companionId: 'alice', path: 'profile.md', expectedRevision: 'old', content: '重写人格。' },
    { type: 'memory.documents.move', companionId: 'alice', path: 'profile.md', targetPath: '记忆/知识/复制.md', expectedRevision: 'old' },
    { type: 'memory.documents.mkdir', companionId: 'alice', path: '记忆/知识/手动目录' },
  ];
  for (const command of commands) expect(await f.documents.handle(command)).toMatchObject({ ok: false, error: expect.stringContaining('只读') });
  expect(f.store.listMemory('alice')).toEqual([]); expect(existsSync(f.file('记忆/知识/手动目录'))).toBe(false); expect(f.commands.some(command => command.type === 'memory.record')).toBe(false);
});
it('reads and locates the exact registered system note with source metadata and a read-only revision', async () => {
  const f = fixture(), raw = f.source('周六给植物浇水。'), note = f.record('和用户约好周六照顾植物。', [raw.id]); await f.publish();
  const read = await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id });
  expect(read.ok, read.error).toBe(true); expect(read.document?.content).toBe(note.content); expect(read.document?.document).toMatchObject({ path: companionMemoryRegisteredPath(note), readOnly: true, noteId: note.id, version: note.version, sourceCount: 1 });
  expect(read.document?.sources[0]?.id).toBe(raw.id); expect(read.document?.memory?.artifactKind).toBe('episode_memory');
  expect(await f.documents.handle({ type: 'memory.documents.locate', companionId: 'bob', noteId: note.id })).toMatchObject({ ok: false });
});
it('ignores unknown visible directories and copied sidecars rather than importing or indexing their prose', async () => {
  const f = fixture(); mkdirSync(f.file('未知/人格'), { recursive: true }); writeFileSync(f.file('未知/人格/我.md'), '我已经掌握新的价值观。'); writeFileSync(f.file('未知/人格/我.md.meta.json'), '{"kind":"self_understanding"}');
  expect(await f.documents.handle({ type: 'memory.documents.read', companionId: 'alice', path: '未知/人格/我.md', sourceLimit: 30 })).toMatchObject({ ok: false });
  const page = await f.documents.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '', limit: 64 }); expect(page.ok, page.error).toBe(true); expect(page.documents?.items).toEqual([]); expect(f.store.listMemory('alice')).toEqual([]);
});
it.each(['missing', 'edit', 'hardlink'] as const)('does not use SQL to serve or repair a %s registered body after restart', async mode => {
  const f = fixture(), note = f.record('真实正式正文。'); await f.publish(); const target = f.noteFile(note);
  if (mode === 'missing') unlinkSync(target); else if (mode === 'edit') writeFileSync(target, '外部改动应保留。'); else linkSync(target, path.join(f.root, 'alias.md'));
  f.restart(); const read = await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id }); expect(read.ok).toBe(false); expect(read.document).toBeUndefined();
  if (mode === 'missing') expect(existsSync(target)).toBe(false); if (mode === 'edit') expect(readFileSync(target, 'utf8')).toBe('外部改动应保留。');
});
it('rejects stale SQL current content even when the old registered file is intact', async () => {
  const f = fixture(), raw = f.source('真实来源。'), note = f.record('旧正文。', [raw.id]); await f.publish();
  f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('新正文尚未出版。', [raw.id]) });
  const result = await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id }); expect(result.ok).toBe(false); expect(readFileSync(f.noteFile(note), 'utf8')).toBe(note.content);
});
it('rechecks source authority after the awaited tag-status read instead of exposing a withdrawn body', async () => {
  const f = fixture(), raw = f.source('会撤回的真实来源。'), note = f.record('不能在竞态中泄漏。', [raw.id]); await f.publish();
  f.intercept(command => { if (command.type === 'memory.tags.status') { f.intercept(); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [raw.id] }); } });
  expect(await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id })).toMatchObject({ ok: false });
});
it('enforces exact document revision and SQL CAS when withdrawing a published note', async () => {
  const f = fixture(), raw = f.source('真实可撤回来源。'), note = f.record('只接受准确版本撤回。', [raw.id]); await f.publish();
  const read = (await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id })).document!;
  expect(await f.documents.handle({ type: 'memory.documents.delete', companionId: 'alice', path: read.document.path, expectedRevision: 'stale' })).toMatchObject({ ok: false });
  f.intercept(command => { if (command.type === 'memory.library.delete') { f.intercept(); f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('撤回前出现新正式版本。', [raw.id]) }); } });
  expect(await f.documents.handle({ type: 'memory.documents.delete', companionId: 'alice', path: read.document.path, expectedRevision: read.document.revision })).toMatchObject({ ok: false });
  await f.publish(); const next = (await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id })).document!;
  expect(await f.documents.handle({ type: 'memory.documents.delete', companionId: 'alice', path: next.document.path, expectedRevision: next.document.revision })).toMatchObject({ ok: true });
  f.restart(); expect(await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id })).toMatchObject({ ok: false }); expect(f.store.listMemory('alice')).toEqual([]);
});
it('does not accept another owner, a traversal or Windows path aliases as an owned document', async () => {
  const f = fixture(), note = f.record('仅Alice可读。'); await f.publish();
  for (const relative of ['../bob/profile.md', 'C:/secret.md', '记忆/CON.txt', '记忆/经历/../内容.md', companionMemoryRegisteredPath(note).replaceAll('/', '\\')]) {
    expect(await f.documents.handle({ type: 'memory.documents.read', companionId: 'alice', path: relative, sourceLimit: 30 })).toMatchObject({ ok: false });
  }
  expect(await f.documents.handle({ type: 'memory.documents.read', companionId: 'bob', path: companionMemoryRegisteredPath(note), sourceLimit: 30 })).toMatchObject({ ok: false });
});
it('paginates registered management documents beyond both bounded registry pages without discovering unknown files', async () => {
  const f = fixture(), registry = await f.artifacts('alice');
  for (let offset = 0; offset < 270; offset += 30) await registry.publishBatch({ operationId: 'fixture:catalog:' + offset, items: Array.from({ length: Math.min(30, 270 - offset) }, (_, index) => {
    const key = String(offset + index).padStart(4, '0'); return { artifactId: 'fixture-knowledge:' + key, kind: 'knowledge' as const, producer: { kind: 'system' as const, id: 'fixture-publisher' }, relativePath: '记忆/知识/研究/' + key + '.md', expectedRevision: null, content: '已登记知识 ' + key, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' as const }, allowedConsumers: ['audit' as const], retentionClass: 'current' as const };
  }) });
  let cursor: string | undefined; const seen = new Set<string>();
  for (let iteration = 0; iteration < 12; iteration++) {
    const result = await f.documents.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '记忆/知识/研究', limit: 64, ...(cursor ? { cursor } : {}) }); expect(result.ok, result.error).toBe(true);
    if (result.documents?.index?.state !== 'ready') { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
    for (const item of result.documents.items) { expect(item.readOnly).toBe(true); seen.add(item.path); }
    if (!result.documents.hasMore) break; cursor = result.documents.nextCursor;
  }
  expect(seen.size).toBe(270); expect(seen.has('记忆/知识/研究/0269.md')).toBe(true);
}, 30000);
it('preserves full long text and evidence while keeping revision history out of new memory capture', async () => {
  const f = fixture(), note = f.record('很长的正文。'.repeat(4000), [f.source('此条沟通是这次长文整理的正式入口。').id]); await f.publish();
  const result = await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id }); expect(result.document?.content).toBe(note.content);
  const history = (await f.artifacts('alice')).get(`history:${note.id}:r1`); const relative = (await history)!.relativePath;
  const historical = await f.documents.handle({ type: 'memory.documents.read', companionId: 'alice', path: relative, sourceLimit: 30 }); expect(historical.ok, historical.error).toBe(true); expect(historical.document?.document.title).toContain('第 1 版');
  const before = f.store.listMemory('alice').length; await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(before);
});
it('allows another owner read while an unrelated writer is waiting without granting either write authority', async () => {
  const f = fixture(); let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { reached = resolve; });
  const writer = f.library.withDocuments('alice', async () => { reached(); await gate; }); await arrived;
  try { const other = await f.documents.handle({ type: 'memory.documents.list', companionId: 'bob', directory: '', limit: 64 }); expect(other.ok, other.error).toBe(true); }
  finally { release(); await writer; }
});
it('binds semantic hits to actual note version and all human filters', async () => {
  const f = fixture(), first = f.record('苹果研究。'), second = f.record('橙子研究。'); await f.publish();
  const manager = new CompanionMemoryDocuments({ library: f.library, libraryDirectory: f.directory, requestStorage: f.request, search: async () => ({ hits: [{ noteId: second.id, version: second.version }, { noteId: first.id, version: first.version + 1 }], state: 'ready', indexed: 2, total: 2 }) });
  try { const result = await manager.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '', query: '研究', mode: 'semantic', limit: 64 }); expect(result.ok, result.error).toBe(true); expect(result.documents?.items.map(item => item.noteId)).toEqual([second.id]); }
  finally { await manager.close(); }
});
