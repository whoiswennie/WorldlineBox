import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionMemoryLibrary, companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import type { CompanionMemory } from '../../src/shared/companions';
import type { VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

/** Retired 19-case scanner contract -> current authority coverage:
 * - manual save/import/frontmatter/.meta moves -> explicit SQL+Registry publication,
 *   copied-sidecar rejection and moved/missing bytes without implicit forgetting;
 * - imported-save/crash receipts -> cognition-file-admission's durable history/body
 *   checkpoint tests; no obsolete scanner receipts are recreated here;
 * - linked roots/owner rotation -> exact link rejection and bounded rotating audit;
 * - native timeline/legacy author/rename -> typed navigation identity, exact source
 *   revision, retraction and in-flight invalidation; no brand-name authority;
 * - file status polling -> coalesced read-only verification without status sidecars.
 * Real Store/Registry/filesystem only. Original broad failure evidence is retained
 * in companion-worker-broad-discovery.txt; this replacement is tested separately.
 */
const fixtures: ReturnType<typeof managedMemoryFiles>[] = [], auditors: CompanionMemoryLibrary[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
afterEach(async () => { for (const audit of auditors.splice(0)) await audit.close(); for (const f of fixtures.splice(0)) await f.close(); });
const snapshot = (f: ReturnType<typeof managedMemoryFiles>) => f.store.request({ type: 'memory.snapshot', ...f.scope, contentKinds: ['episode_memory'] }).memorySnapshot!;
const revision = (f: ReturnType<typeof managedMemoryFiles>) => { const value = snapshot(f); return value.semanticRevision ?? value.revision; };
function timeline(f: ReturnType<typeof managedMemoryFiles>, sourceRevision: string): VcpMemoryTimelineArtifacts {
  const owner = companionMemoryIdentity(f.store.state().companions.find(item => item.id === 'alice')!);
  return { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision, owner,
    agents: [{ agentName: owner.agentName, months: [{ month: '2026-10', sourceDigest: 'synthetic-native-timeline-fixture',
      content: '十月，用户解释了在疲倦时需要先确认支持方式。', summary: '本月有来源的交流概览。' }] }] };
}
function recordFor(f: ReturnType<typeof managedMemoryFiles>, ownerId: string, content: string): CompanionMemory {
  const raw = f.source(content + ' 的真实原始依据。', ownerId);
  const note = f.store.request({ type: 'memory.record', companionId: ownerId, conversationId: raw.conversationId,
    candidate: f.candidate(content, [raw.id]) }).memories![0]!;
  f.index(); return note;
}

it('requires host Registry authority and publishes only the exact system note without creating legacy sidecars or a second root', async () => {
  const f = fixture();
  expect(() => new CompanionMemoryLibrary({ libraryDirectory: f.directory, request: f.request })).toThrow('注册表');
  expect(() => f.store.saveMemory({ ...f.scope, content: '人工改写认识。' })).toThrow('人工保存接口已经退出');
  const note = f.record('正式系统整理的完整正文。'); await f.publish();
  const registry = await f.artifacts('alice'), artifact = await registry.get('memory:' + note.id);
  expect(artifact).toMatchObject({ kind: 'episode_memory', ownerId: 'alice', relativePath: companionMemoryRegisteredPath(note) });
  expect(readFileSync(f.noteFile(note), 'utf8')).toBe(note.content);
  expect(await registry.get('history:' + note.id + ':r1')).toMatchObject({ kind: 'revision_history' });
  expect(artifact!.sourceRefs).toHaveLength(1);
  expect(existsSync(f.noteFile(note) + '.meta.json')).toBe(false);
  for (const file of ['.同步状态.json', '同步状态.md', '.时间线索引.json', 'profile.md', '伙伴记忆']) expect(existsSync(f.file(file))).toBe(false);
  expect((await f.library.sync())).toMatchObject({ exported: 0, imported: 0, forgotten: 0, conflicts: [] });
  expect(f.store.state().companions.find(owner => owner.id === 'alice')!.persona).toBe('有来源的伙伴。');
});

it('does not authorize copied body, sidecar or legacy manifest prose as memory even with a genuine note identity', async () => {
  const f = fixture(), note = f.record('真实来源产生的认识，仍需保留条件。'); await f.publish();
  const copied = f.file('陌生目录/人格.md'); mkdirSync(path.dirname(copied), { recursive: true });
  writeFileSync(copied, 'FAKE_PERSONALITY_CANARY：我已经改变了全部价值观。');
  writeFileSync(copied + '.meta.json', JSON.stringify({ id: note.id, companionId: 'alice', kind: 'self_understanding', version: 999, sources: note.sources }));
  writeFileSync(f.file('.同步状态.json'), JSON.stringify({ schema: 'legacy-manifest-v1', files: { '陌生目录/人格.md': { noteId: note.id, hash: 'claimed-authority' } } }));
  const before = f.store.listMemory('alice').map(memory => ({ id: memory.id, version: memory.version, content: memory.content }));
  for (let n = 0; n < 3; n++) expect((await f.library.sync()).imported).toBe(0);
  const read = await f.documents.handle({ type: 'memory.documents.read', companionId: 'alice', path: '陌生目录/人格.md', sourceLimit: 1 });
  expect(read.ok).toBe(false); expect(JSON.stringify(read)).not.toContain('FAKE_PERSONALITY_CANARY');
  expect(f.store.listMemory('alice').map(memory => ({ id: memory.id, version: memory.version, content: memory.content }))).toEqual(before);
  await expect((await f.artifacts('alice')).findByPath('陌生目录/人格.md')).resolves.toBeUndefined();
  expect(readFileSync(copied, 'utf8')).toContain('FAKE_PERSONALITY_CANARY');
});

it('treats moved and missing equal-text bodies as conflicts without matching sidecars, implicit forgetting or SQL reconstruction', async () => {
  const f = fixture(), first = f.record('两个记录可以保留相同正文。'), second = f.record('两个记录可以保留相同正文。'); await f.publish();
  const moved = path.join(path.dirname(f.noteFile(first)), '外部重命名.md');
  renameSync(f.noteFile(first), moved); writeFileSync(moved + '.meta.json', JSON.stringify({ id: first.id, version: first.version }));
  unlinkSync(f.noteFile(second)); const report = await f.library.sync();
  expect(report.imported).toBe(0); expect(report.forgotten).toBe(0); expect(report.conflicts.map(item => item.file)).toEqual(expect.arrayContaining([companionMemoryRegisteredPath(first), companionMemoryRegisteredPath(second)]));
  f.restart();
  for (const note of [first, second]) {
    const current = f.store.request({ type: 'memory.library.read', companionId: 'alice', id: note.id }).memoryRead!.memory;
    expect(current).toMatchObject({ id: note.id, version: note.version, contentRevision: note.contentRevision, content: note.content, sources: note.sources });
    expect((await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id })).ok).toBe(false);
    expect(existsSync(f.noteFile(note))).toBe(false);
  }
  expect(readFileSync(moved, 'utf8')).toBe(first.content); expect(f.store.listMemory('alice')).toHaveLength(2);
});

it.each(['artifact-parent', 'owner-root'] as const)('rejects a %s junction without following or overwriting external bytes', async location => {
  const f = fixture(), note = f.record('正式路径必须仍在当前资产库中。'); await f.publish();
  const external = path.join(f.root, 'external-' + location); mkdirSync(external);
  let linked: string;
  if (location === 'artifact-parent') {
    linked = path.dirname(f.noteFile(note));
    writeFileSync(path.join(external, path.basename(f.noteFile(note))), 'EXTERNAL_LINK_CANARY');
  } else {
    linked = f.directory;
    const relative = path.relative(f.directory, f.noteFile(note)); mkdirSync(path.dirname(path.join(external, relative)), { recursive: true });
    writeFileSync(path.join(external, relative), 'EXTERNAL_LINK_CANARY');
  }
  renameSync(linked, linked + '-original'); symlinkSync(external, linked, 'junction');
  const report = await f.library.sync(); expect(report.conflicts.length).toBeGreaterThan(0);
  const result = await f.documents.handle({ type: 'memory.documents.locate', companionId: 'alice', noteId: note.id });
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('EXTERNAL_LINK_CANARY');
  expect(readFileSync(location === 'artifact-parent' ? path.join(external, path.basename(f.noteFile(note))) : path.join(external, path.relative(f.directory, f.noteFile(note))), 'utf8')).toBe('EXTERNAL_LINK_CANARY');
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: note.id }).memoryRead!.memory.version).toBe(note.version);
});

it('uses explicit source withdrawal for current/history cleanup while retaining the original human event, unknown copy and peer knowledge', async () => {
  const f = fixture(), raw = f.source('本来允许作为记忆依据的人类事件。'), note = f.record('现在撤回这次经历的记忆用途。', [raw.id]), peer = recordFor(f, 'bob', '另一伙伴的合法记录。');
  await f.publish(); await f.publish('bob');
  const unknown = f.file('用户另存/副本.md'); mkdirSync(path.dirname(unknown)); writeFileSync(unknown, note.content);
  const registry = await f.artifacts('alice'), history = await registry.get('history:' + note.id + ':r1'); expect(history).toBeDefined();
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [raw.id] }); await f.publish(); await f.library.purgeRevoked('alice');
  expect(await registry.get('memory:' + note.id)).toBeUndefined(); expect(await registry.get('history:' + note.id + ':r1')).toBeUndefined();
  expect(existsSync(f.noteFile(note))).toBe(false); expect(existsSync(f.file(history!.relativePath))).toBe(false);
  expect(readFileSync(unknown, 'utf8')).toBe(note.content); expect(f.store.getMessage(raw.id).content).toBe(raw.content);
  expect((await f.documents.handle({ type: 'memory.documents.locate', companionId: 'bob', noteId: peer.id })).document?.content).toBe(peer.content);
  expect((await f.library.sync()).imported).toBe(0); expect(f.store.listMemory('alice')).toEqual([]);
});

it('rotates bounded verification over owners and artifact pages without discovering missing profiles or unknown files', async () => {
  const f = fixture(), owners = ['alice', 'bob'];
  for (let n = 0; n < 6; n++) {
    const owner = f.store.createCompanion({ name: '审计伙伴' + n, description: '', persona: '独立的起点。', model: '', avatar: 'custom', proactive: false });
    owners.push(owner.id); mkdirSync(path.join(f.directory, owner.id));
  }
  const notes: CompanionMemory[] = [];
  for (const owner of owners) { notes.push(recordFor(f, owner, '属于' + owner + '的正式记录。')); await f.publish(owner); }
  const last = notes.at(-1)!; writeFileSync(f.noteFile(last), 'LATE_OWNER_EXTERNAL_EDIT');
  const auditor = new CompanionMemoryLibrary({ libraryDirectory: f.directory, request: f.request, artifacts: f.artifacts, maxOwnersPerSync: 2, maxFilesPerOwner: 1 }); auditors.push(auditor);
  let found = false; const from = f.commands.length;
  for (let n = 0; n < 16 && !found; n++) found = (await auditor.sync()).conflicts.some(conflict => conflict.companionId === last.companionId && conflict.file === companionMemoryRegisteredPath(last));
  expect(found).toBe(true);
  const pageCalls = f.commands.slice(from).filter(command => command.type === 'cognition.registry.page');
  expect(pageCalls.length).toBeGreaterThan(0); expect(pageCalls.every(command => command.limit !== undefined && command.limit <= 1)).toBe(true);
  for (const owner of owners) expect(existsSync(f.file('profile.md', owner))).toBe(false);
  expect(readFileSync(f.noteFile(last), 'utf8')).toBe('LATE_OWNER_EXTERNAL_EDIT');
});

it('publishes explicit navigation with exact episode revision and owner identity, then invalidates it without recapturing or deleting unknown text', async () => {
  const f = fixture(), note = f.record('用户讲述了一次实际经历。'); await f.publish(); const sourceRevision = revision(f);
  const wrong = timeline(f, sourceRevision); wrong.owner = companionMemoryIdentity({ id: 'other-owner', name: 'alice' });
  await expect(f.library.publishTimelines(f.scope, wrong, async () => true)).rejects.toThrow('身份');
  const legacy = timeline(f, sourceRevision); delete legacy.owner;
  await expect(f.library.publishTimelines(f.scope, legacy, async () => true)).rejects.toThrow('身份');
  await f.library.publishTimelines(f.scope, timeline(f, sourceRevision), async () => revision(f) === sourceRevision);
  const registry = await f.artifacts('alice'), navigation = (await registry.page({ kind: 'navigation', limit: 8 })).items;
  expect(navigation).toHaveLength(2); expect(navigation.every(item => item.allowedConsumers.join(',') === 'navigation,audit')).toBe(true);
  for (const item of navigation) expect(await f.library.withDocuments('alice', session => session.timelineValid(item.relativePath), { readOnly: true })).toBe(true);
  expect(f.store.listMemory('alice')).toHaveLength(1);
  const unknown = f.file('记忆/导航/用户另存.md'); writeFileSync(unknown, '自留文本，不是登记的导航。');
  f.record('之后发生了另一件有来源的经历。');
  for (const item of navigation) expect(await f.library.withDocuments('alice', session => session.timelineValid(item.relativePath), { readOnly: true })).toBe(false);
  await f.library.invalidate('alice'); await f.library.purgeRevoked('alice');
  expect((await registry.page({ kind: 'navigation', limit: 8 })).items).toEqual([]);
  expect(navigation.every(item => !existsSync(f.file(item.relativePath)))).toBe(true);
  expect(readFileSync(unknown, 'utf8')).toBe('自留文本，不是登记的导航。'); expect(readFileSync(f.noteFile(note), 'utf8')).toBe(note.content);
});

it('does not commit an in-flight navigation after its exact source set is withdrawn', async () => {
  const f = fixture(), raw = f.source('即将撤回的真实依据。'); f.record('不能发布成导航的旧经历。', [raw.id]); await f.publish();
  const sourceRevision = revision(f); let checks = 0;
  await expect(f.library.publishTimelines(f.scope, timeline(f, sourceRevision), async () => {
    if (++checks === 2) f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [raw.id] });
    return revision(f) === sourceRevision;
  })).rejects.toThrow('导航来源已变化');
  expect(checks).toBeGreaterThanOrEqual(2);
  expect((await (await f.artifacts('alice')).page({ kind: 'navigation', limit: 8 })).items).toEqual([]);
  expect(f.store.listMemory('alice')).toEqual([]);
});

it('keeps concurrent paginated audit reads owner-bound while every result is an exact read-only registered body', async () => {
  const f = fixture(), notes = Array.from({ length: 9 }, (_, n) => f.record('Alice独立分页记录 ' + n)); const peer = recordFor(f, 'bob', 'Bob独立分页记录。');
  await f.publish(); await f.publish('bob');
  const query = { type: 'memory.documents.list' as const, companionId: 'alice', directory: '', recordsOnly: true, limit: 3 };
  const first = await f.documents.handle(query); expect(first.ok, first.error).toBe(true); expect(first.documents!.items).toHaveLength(3);
  const paths = new Set(first.documents!.items.map(item => item.path)), seen = new Set(first.documents!.items.flatMap(item => item.noteId ? [item.noteId] : [])); let cursor = first.documents!.nextCursor;
  while (cursor) {
    const [left, right] = await Promise.all([f.documents.handle({ ...query, cursor }), f.documents.handle({ ...query, cursor })]);
    expect(left.ok, left.error).toBe(true); expect(right.ok, right.error).toBe(true); expect(left.documents).toEqual(right.documents);
    for (const item of left.documents!.items) { expect(item.readOnly).toBe(true); expect(item.noteId).not.toBe(peer.id); expect(paths.has(item.path)).toBe(false); paths.add(item.path);
      if (item.noteId) { expect(seen.has(item.noteId)).toBe(false); seen.add(item.noteId); } }
    cursor = left.documents!.hasMore ? left.documents!.nextCursor : undefined;
  }
  expect([...seen].sort()).toEqual(notes.map(note => note.id).sort());
  expect([...paths].sort()).toEqual((await (await f.artifacts('alice')).page({ consumer: 'audit', limit: 64 })).items.map(item => item.relativePath).sort());
  const foreign = await f.documents.handle({ ...query, companionId: 'bob', cursor: first.documents!.nextCursor }); expect(foreign.ok).toBe(false); expect(JSON.stringify(foreign)).not.toContain('Alice独立分页记录');
  const other = await f.documents.handle({ ...query, companionId: 'bob' }); expect(other.documents?.items.flatMap(item => item.noteId ? [item.noteId] : [])).toEqual([peer.id]);
});

it('coalesces verification and preserves unchanged body/version timestamps without writing legacy status documents', async () => {
  const f = fixture(), note = f.record('轮询只核验，不构造新的记忆。'); await f.publish(); await f.library.sync();
  const before = { bytes: readFileSync(f.noteFile(note)), mtime: statSync(f.noteFile(note)).mtimeMs, artifact: await (await f.artifacts('alice')).get('memory:' + note.id) };
  const operations = Array.from({ length: 12 }, () => f.library.sync()); expect(operations.every(operation => operation === operations[0])).toBe(true);
  for (const report of await Promise.all(operations)) expect(report).toMatchObject({ imported: 0, exported: 0, forgotten: 0, conflicts: [] });
  expect(readFileSync(f.noteFile(note))).toEqual(before.bytes); expect(statSync(f.noteFile(note)).mtimeMs).toBe(before.mtime);
  expect(await (await f.artifacts('alice')).get('memory:' + note.id)).toEqual(before.artifact);
  expect(f.store.listMemory('alice')).toHaveLength(1);
  for (const relative of ['同步状态.md', '.同步状态.json', companionMemoryRegisteredPath(note) + '.meta.json']) expect(existsSync(f.file(relative))).toBe(false);
});
