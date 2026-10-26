import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const roots: string[] = [], stores: CompanionsStore[] = [], libraries: CompanionMemoryLibrary[] = [];
afterEach(async () => {
  for (const library of libraries.splice(0)) await library.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('vcp-readable-library-')) throw new Error('Invalid fixture cleanup');
    removeOwnedDirectorySync(root);
  }
});
function fixture(count = 1) {
  const root = mkdtempSync(path.join(tmpdir(), 'vcp-readable-library-')); roots.push(root);
  const seeds: CompanionSeed[] = Array.from({ length: count }, (_, n) => ({ id: n ? `resident-${n}` : 'alice', name: n ? `伙伴${n}` : 'Alice', persona: '稳定人格不会被资料覆盖。', description: '', avatar: 'sister', model: '', proactive: false, active: false }));
  const store = new CompanionsStore(path.join(root, 'runtime', 'state.sqlite'), seeds); stores.push(store);
  const directory = path.join(root, 'library', '伙伴记忆');
  const request = async (command: CompanionStorageCommand) => store.request(command);
  const make = (custom = request) => {
    const library = new CompanionMemoryLibrary({ libraryDirectory: directory, request: custom, maxOwnersPerSync: 4, maxFilesPerOwner: 32 });
    libraries.push(library); return library;
  };
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  return { root, store, directory, scope, make, request };
}

it('projects authorized full text and provenance into stable per-resident files without a second 伙伴记忆 directory', async () => {
  const f = fixture(), content = '完整日记内容。'.repeat(8000).slice(0, 65536);
  const note = f.store.saveMemory({ ...f.scope, content });
  const library = f.make(); await library.sync();
  const folder = path.join(f.directory, 'alice'), file = path.join(folder, '日记', note.id + '.md');
  for (const category of ['日记', '资料', '自我认识', '时间线']) expect(existsSync(path.join(folder, category))).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(content);
  const metadata = JSON.parse(readFileSync(file + '.meta.json', 'utf8'));
  expect(metadata).toMatchObject({ id: note.id, companionId: 'alice', version: 1, sources: [{ sourceType: 'manual_input' }] });
  expect(readFileSync(path.join(folder, 'profile.md'), 'utf8')).toContain('稳定人格不会被资料覆盖。');
  expect(existsSync(path.join(f.directory, '伙伴记忆'))).toBe(false);
  await library.sync();
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead?.memory.version).toBe(1);
});

it('imports external edits as versioned manual input and preserves a concurrent editor conflict', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '原始日记。' }), library = f.make();
  await library.sync(); const file = path.join(f.directory, 'alice', '日记', note.id + '.md');
  writeFileSync(file, '用户在资产库写下的新版本。');
  expect((await library.sync()).imported).toBe(1);
  const edited = f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead!.memory;
  expect(edited).toMatchObject({ version: 2, content: '用户在资产库写下的新版本。', captureMethod: 'manual' });
  expect(f.store.getMessage(edited.sourceMessageId!).memoryEvidenceOnly).toBe(true);
  await library.sync(); expect(f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead?.memory.version).toBe(2);
  f.store.saveMemory({ ...f.scope, id: note.id, expectedVersion: edited.version, content: 'UI中的并行修订。' });
  writeFileSync(file, '文件中的并行修订。');
  expect((await library.sync()).conflicts.some(item => item.message.includes('均已变化'))).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe('文件中的并行修订。');
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead?.memory.content).toBe('UI中的并行修订。');
});

it('turns deletion into forgetting and never reimports a restored forgotten export', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '需要遗忘的旧日记。' }), library = f.make();
  await library.sync(); const file = path.join(f.directory, 'alice', '日记', note.id + '.md');
  unlinkSync(file); expect((await library.sync()).forgotten).toBe(1);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
  expect(existsSync(file + '.meta.json')).toBe(false);
  writeFileSync(file, note.content); await library.sync();
  expect(existsSync(file)).toBe(false);
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [note.sourceMessageId!] }).memorySources).toEqual([]);
});

it('treats learning and self-understanding documents as auditable notes without granting frontmatter authority or changing persona', async () => {
  const f = fixture(), library = f.make(); await library.sync();
  writeFileSync(path.join(f.directory, 'alice', '资料', '学习.md'), '---\ncompanionId: bob\nconversationId: secret\n---\n我读到的一份资料。');
  writeFileSync(path.join(f.directory, 'alice', '自我认识', '认识.txt'), '我主观认为自己喜欢安静地思考。');
  for (let n = 0; n < 3; n++) await library.sync();
  const notes = f.store.request({ type: 'memory.list', companionId: 'alice' }).memories!;
  expect(notes).toHaveLength(2);
  expect(notes.map(note => note.diaryName)).toEqual(expect.arrayContaining(['资料', '自我认识']));
  expect(notes.every(note => note.companionId === 'alice' && note.sources[0]?.sourceType === 'manual_input')).toBe(true);
  expect(f.store.state().companions[0]?.persona).toBe('稳定人格不会被资料覆盖。');
  expect(notes.find(note => note.diaryName === '资料')?.content).toContain('companionId: bob');
});

it('recovers a save committed before a transport failure without duplicating a note or revision after restart', async () => {
  const f = fixture(); let fail = true;
  const library = f.make(async command => {
    const response = await f.request(command);
    if (command.type === 'memory.save' && fail) { fail = false; throw new Error('模拟提交后断线'); }
    return response;
  });
  await library.sync(); const file = path.join(f.directory, 'alice', '资料', '新资料.md'); writeFileSync(file, '提交前后的同一份资料。');
  await library.sync(); await library.close();
  const notes = f.store.request({ type: 'memory.list', companionId: 'alice' }).memories!;
  expect(notes).toHaveLength(1);
  const restarted = f.make(); await restarted.sync(); await restarted.sync();
  const recovered = f.store.request({ type: 'memory.list', companionId: 'alice' }).memories!;
  expect(recovered).toHaveLength(1); expect(recovered[0]?.version).toBe(1);
  expect(recovered[0]?.id).toBe(notes[0]?.id);
  expect(JSON.parse(readFileSync(file + '.meta.json', 'utf8')).id).toBe(notes[0]?.id);
});

it('uses a redacted durable receipt to remove a forgotten import after a crash instead of exposing or importing its text again', async () => {
  const f = fixture(); let fail = true;
  const library = f.make(async command => {
    const response = await f.request(command);
    if (command.type === 'memory.save' && fail) { fail = false; throw new Error('提交后断线'); }
    return response;
  });
  await library.sync();
  const file = path.join(f.directory, 'alice', '资料', '应当遗忘.md'); writeFileSync(file, 'REVOKED_PRIVATE_CONTENT');
  await library.sync(); await library.close();
  const note = f.store.request({ type: 'memory.list', companionId: 'alice' }).memories![0]!;
  f.store.request({ type: 'memory.delete', id: note.id });
  const manifest = JSON.parse(readFileSync(path.join(f.directory, 'alice', '.同步状态.json'), 'utf8'));
  const operationId = manifest.files['资料/应当遗忘.md'].pending.operationId;
  const receipt = f.store.request({ type: 'memory.operation.inspect', companionId: 'alice', operationId });
  expect(receipt.memories?.[0]).toMatchObject({ id: note.id, status: 'forgotten', sources: [], tags: [] });
  expect(JSON.stringify(receipt)).not.toContain('REVOKED_PRIVATE_CONTENT');
  const restarted = f.make(); await restarted.sync();
  expect(existsSync(file)).toBe(false);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
});

it('withdraws an existing readable projection after its host source is forgotten', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '不能在撤回后残留的文本。' }), library = f.make();
  await library.sync(); const file = path.join(f.directory, 'alice', '日记', note.id + '.md');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [note.sourceMessageId!] });
  await library.sync();
  expect(existsSync(file)).toBe(false); expect(existsSync(file + '.meta.json')).toBe(false);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
});

it('rejects a directory junction and reports it without importing files outside the selected library', async () => {
  const f = fixture(), library = f.make(); await library.sync();
  const outside = path.join(f.root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, '外部.md'), '不可自动导入的外部资料。');
  const folder = path.join(f.directory, 'alice', '资料'); renameSync(folder, folder + '-original'); symlinkSync(outside, folder, 'junction');
  expect((await library.sync()).conflicts.length).toBeGreaterThan(0);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
  expect(readFileSync(path.join(outside, '外部.md'), 'utf8')).toBe('不可自动导入的外部资料。');
});

it('rejects a pre-existing top-level memory-root junction before treating its target as an authorized library', async () => {
  const f = fixture(), outside = path.join(f.root, 'outside-root');
  mkdirSync(path.join(outside, 'alice', '资料'), { recursive: true });
  const external = path.join(outside, 'alice', '资料', '外部.md'); writeFileSync(external, '不属于已选择目录的资料。');
  mkdirSync(path.dirname(f.directory), { recursive: true }); symlinkSync(outside, f.directory, 'junction');
  const library = f.make();
  await expect(library.sync()).rejects.toThrow('根目录不能是链接');
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
  expect(readFileSync(external, 'utf8')).toBe('不属于已选择目录的资料。');
  expect(existsSync(path.join(outside, 'alice', 'profile.md'))).toBe(false);
});

it('rotates through more than thirty-two residents instead of starving later directories', async () => {
  const f = fixture(40), library = f.make();
  for (let n = 0; n < 10; n++) await library.sync();
  for (let n = 1; n < 40; n++) expect(existsSync(path.join(f.directory, `resident-${n}`, 'profile.md'))).toBe(true);
});

function timeline(revision: string): VcpMemoryTimelineArtifacts {
  return { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision, owner: companionMemoryIdentity({ id: 'alice', name: 'Alice' }),
    agents: [{ agentName: 'Alice', months: [{ month: '2026-10', sourceDigest: 'real-source-digest', content: '# 十月\n\n基于真实日记的完整时间线。', summary: '十月的真实经历。' }] }] };
}
it('publishes original native timelines as readable revision-bound projections without recapturing its own output', async () => {
  const f = fixture(), library = f.make(); await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.semanticRevision!;
  await library.publishTimelines(f.scope, timeline(revision), async () => true);
  const file = path.join(f.directory, 'alice', '时间线', `VCP-${f.scope.companionId}-2026-10.md`);
  expect(readFileSync(file, 'utf8')).toBe(timeline(revision).agents[0]!.months[0]!.content);
  expect(JSON.parse(readFileSync(file + '.meta.json', 'utf8')).sourceRevision).toBe(revision);
  for (let n = 0; n < 3; n++) await library.sync();
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toEqual([]);
  const own = path.join(f.directory, 'alice', '时间线', '用户另存的想法.md'); writeFileSync(own, '这是用户自己保留的文本。');
  await library.invalidate('alice');
  expect(existsSync(file)).toBe(false); expect(existsSync(file + '.meta.json')).toBe(false);
  expect(readFileSync(own, 'utf8')).toBe('这是用户自己保留的文本。');
});
it('removes an in-flight timeline projection if its authorization changes before publication finishes', async () => {
  const f = fixture(), library = f.make(); let checks = 0;
  await library.publishTimelines(f.scope, timeline('revision'), async () => ++checks < 3);
  const file = path.join(f.directory, 'alice', '时间线', `VCP-${f.scope.companionId}-2026-10.md`);
  expect(checks).toBe(3); expect(existsSync(file)).toBe(false); expect(existsSync(file + '.meta.json')).toBe(false);
});
it('publishes one owner monthly timeline across entrances and replaces only its managed legacy copies', async () => {
  const f = fixture(), library = f.make(); await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.semanticRevision!;
  await library.publishTimelines(f.scope, timeline(revision), async () => true);
  const folder = path.join(f.directory, 'alice', '时间线'), stable = 'VCP-alice-2026-10.md';
  const legacy = `VCP-${f.scope.conversationId}-2026-10.md`, manifestFile = path.join(f.directory, 'alice', '.时间线索引.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.files[legacy] = manifest.files[stable]; delete manifest.files[stable];
  renameSync(path.join(folder, stable), path.join(folder, legacy));
  renameSync(path.join(folder, stable + '.meta.json'), path.join(folder, legacy + '.meta.json'));
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const unmanaged = path.join(folder, '用户自己留存的旧日记.md'); writeFileSync(unmanaged, '用户自留文本');
  const group = f.store.createConversation('另一个入口', ['alice']), second = { companionId: 'alice', conversationId: group.id };
  expect(f.store.request({ type: 'memory.snapshot', ...second }).memorySnapshot!.semanticRevision!).toBe(revision);
  await library.publishTimelines(second, timeline(revision), async () => true);
  expect(readdirSync(folder).filter(name => /^VCP-.*\.md$/u.test(name)).sort()).toEqual(['VCP-alice-2026-10.md', 'VCP-alice-2026-10.summary.md']);
  expect(existsSync(path.join(folder, legacy))).toBe(false);
  expect(existsSync(path.join(folder, legacy + '.meta.json'))).toBe(false);
  expect(readFileSync(unmanaged, 'utf8')).toBe('用户自留文本');
  expect(JSON.parse(readFileSync(path.join(folder, stable + '.meta.json'), 'utf8')).scope).toEqual(second);
  expect(await library.withDocuments('alice', session => session.timelineValid('时间线/' + stable), { synchronize: false })).toBe(true);
  expect(f.store.listMemory('alice')).toEqual([]);
});
it('cleans stale automatic timelines from their source revision after restart', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '真实时间线来源。' });
  const delivery = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  f.store.request({ type: 'memory.outbox.complete', id: delivery.id, leaseToken: delivery.leaseToken, indexed: true });
  const library = f.make(), revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.semanticRevision!;
  await library.publishTimelines(f.scope, timeline(revision), async () => true); await library.close();
  f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
  const restarted = f.make(); await restarted.sync();
  const file = path.join(f.directory, 'alice', '时间线', `VCP-${f.scope.companionId}-2026-10.md`);
  expect(existsSync(file)).toBe(false); expect(existsSync(file + '.meta.json')).toBe(false);
});

it('withdraws legacy brand-authored projections without modifying their authoritative diaries', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '我想起和伙伴一起看海的经历。' }), library = f.make();
  await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.semanticRevision!;
  await library.publishTimelines(f.scope, timeline(revision), async () => true);
  const root = path.join(f.directory, 'alice'), file = path.join(root, '时间线', `VCP-${f.scope.companionId}-2026-10.md`);
  const manifestPath = path.join(root, '.时间线索引.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const entry of Object.values(manifest.files) as Array<{ ownerIdentity?: unknown }>) delete entry.ownerIdentity;
  writeFileSync(manifestPath, JSON.stringify(manifest)); writeFileSync(file, 'WorldlineBox 与伙伴一起看海。');
  expect(await library.withDocuments('alice', session => session.timelineValid('时间线/' + path.basename(file)), { synchronize: false })).toBe(false);
  await library.close(); const restarted = f.make(); await restarted.sync();
  expect(existsSync(file)).toBe(false); expect(existsSync(file + '.meta.json')).toBe(false);
  expect(readFileSync(path.join(root, '日记', note.id + '.md'), 'utf8')).toBe(note.content);
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead!.memory).toMatchObject({ id: note.id, version: note.version, content: note.content });
});

it('rejects another resident identity even if its display name matches, and invalidates renamed derived timelines', async () => {
  const f = fixture(), library = f.make(); await library.sync();
  const revision = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!.semanticRevision!;
  const wrong = timeline(revision); wrong.owner = companionMemoryIdentity({ id: 'other', name: 'Alice' });
  await expect(library.publishTimelines(f.scope, wrong, async () => true)).rejects.toThrow('归属身份');
  const legacy = timeline(revision); delete legacy.owner;
  await expect(library.publishTimelines(f.scope, legacy, async () => true)).rejects.toThrow('归属身份');
  await library.publishTimelines(f.scope, timeline(revision), async () => true);
  const file = path.join(f.directory, 'alice', '时间线', `VCP-${f.scope.companionId}-2026-10.md`);
  const owner = f.store.state().companions.find(role => role.id === 'alice')!;
  f.store.updateCompanion(owner.id, { ...owner, name: 'Alice 新名字' }, owner.revision);
  expect(await library.withDocuments('alice', session => session.timelineValid('时间线/' + path.basename(file)), { synchronize: false })).toBe(false);
  await library.sync(); expect(existsSync(file)).toBe(false);
});

it('keeps the note identity, version and evidence when only its readable filename changes', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '仍然是同一份日记。' }), library = f.make();
  await library.sync();
  const previous = path.join(f.directory, 'alice', '日记', note.id + '.md'), renamed = path.join(f.directory, 'alice', '日记', '我的日记.md');
  renameSync(previous, renamed);
  for (let n = 0; n < 2; n++) await library.sync();
  const current = f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead!.memory;
  expect(current.version).toBe(note.version); expect(current.sources).toEqual(note.sources);
  expect(JSON.parse(readFileSync(renamed + '.meta.json', 'utf8')).id).toBe(note.id);
  expect(existsSync(previous + '.meta.json')).toBe(false);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toHaveLength(1);
});

it('uses the accompanying sidecar to distinguish equal-text moves and reports ambiguous moves instead of forgetting them', async () => {
  const f = fixture(), first = f.store.saveMemory({ ...f.scope, content: '相同的原文。' }), second = f.store.saveMemory({ ...f.scope, content: '相同的原文。' }), library = f.make();
  await library.sync();
  const folder = path.join(f.directory, 'alice', '日记');
  renameSync(path.join(folder, first.id + '.md'), path.join(folder, '第一份.md'));
  renameSync(path.join(folder, second.id + '.md'), path.join(folder, '第二份.md'));
  const ambiguous = await library.sync();
  expect(ambiguous.conflicts.some(item => item.message.includes('无法安全判断'))).toBe(true);
  expect(f.store.request({ type: 'memory.list', companionId: 'alice' }).memories).toHaveLength(2);
  expect(readFileSync(path.join(f.directory, 'alice', '同步状态.md'), 'utf8')).toContain('需要核对');
  renameSync(path.join(folder, first.id + '.md.meta.json'), path.join(folder, '第一份.md.meta.json'));
  renameSync(path.join(folder, second.id + '.md.meta.json'), path.join(folder, '第二份.md.meta.json'));
  for (let n = 0; n < 3; n++) await library.sync();
  expect(JSON.parse(readFileSync(path.join(folder, '第一份.md.meta.json'), 'utf8')).id).toBe(first.id);
  expect(JSON.parse(readFileSync(path.join(folder, '第二份.md.meta.json'), 'utf8')).id).toBe(second.id);
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: first.id }).memoryRead?.memory.version).toBe(1);
});

it('writes discoverable status changes without rewriting an unchanged status every polling cycle', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '宿主原文。' }), library = f.make();
  await library.sync();
  const status = path.join(f.directory, 'alice', '同步状态.md'), previousTime = statSync(status).mtimeMs;
  const manifest = path.join(f.directory, 'alice', '.同步状态.json'), previousManifest = statSync(manifest).mtimeMs;
  await library.sync(); expect(statSync(status).mtimeMs).toBe(previousTime);
  expect(statSync(manifest).mtimeMs).toBe(previousManifest);
  f.store.saveMemory({ ...f.scope, id: note.id, expectedVersion: 1, content: '宿主并行改动。' });
  const file = path.join(f.directory, 'alice', '日记', note.id + '.md'); writeFileSync(file, '文件并行改动。');
  await library.sync(); expect(readFileSync(status, 'utf8')).toContain('需要核对');
  writeFileSync(file, '宿主并行改动。'); await library.sync();
  expect(readFileSync(status, 'utf8')).toContain('状态：已同步');
});
