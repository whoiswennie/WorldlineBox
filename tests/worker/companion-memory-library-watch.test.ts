import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { FSWatcher, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionMemory } from '../../src/shared/companions';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

interface Fixture {
  root: string; directory: string; store: CompanionsStore; library: CompanionMemoryLibrary;
  commands: CompanionStorageCommand[]; watcher: FSWatcher;
  file(relative: string, owner?: string): string;
  document(relative: string, content: string, owner?: string): Promise<void>;
  notes(owner?: string): CompanionMemory[];
  notify(event: string, relative: string | null): void;
}
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.library.close(); f.store.close(); await removeOwnedDirectory(f.root); } });

async function fixture(options: { real?: boolean; waitMs?: number; intercept?(command: CompanionStorageCommand, library: CompanionMemoryLibrary): Promise<void> } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-library-watch-')), directory = path.join(root, '伙伴记忆');
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '读真实文件。', description: '', model: '', avatar: 'sister' as const, proactive: false })));
  let notify!: (event: string, filename: string | null) => void;
  const commands: CompanionStorageCommand[] = [];
  const emitter = new EventEmitter();
  const watcher = Object.assign(emitter, { unref() { return emitter; }, close() { queueMicrotask(() => emitter.emit('close')); } }) as unknown as FSWatcher;
  const watchFn = ((_directory: string, _options: unknown, listener: typeof notify) => { notify = listener; return watcher; }) as unknown as typeof watch;
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, maxFilesPerOwner: 2,
    fileNotifications: { ...(options.real ? {} : { watch: watchFn }), waitMs: options.waitMs ?? 10000 },
    request: async command => { commands.push(command); await options.intercept?.(command, library); return store.request(command); } });
  const file = (relative: string, owner = 'alice') => path.join(directory, owner, ...relative.split('/'));
  const document = async (relative: string, content: string, owner = 'alice') => { const target = file(relative, owner); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); };
  const notes = (owner = 'alice') => store.request({ type: 'memory.list', companionId: owner }).memories!;
  const f = { root, directory, store, library, commands, watcher, file, document, notes,
    notify: (event: string, relative: string | null) => notify(event, relative) }; fixtures.push(f); return f;
}

it('autonomously completes an initial multi-batch inventory after its bounded foreground wait expires', async () => {
  let first = true;
  const f = await fixture({ waitMs: 10, intercept: async command => {
    if (command.type === 'memory.save' && first) { first = false; await new Promise(resolve => setTimeout(resolve, 80)); }
  } });
  for (let n = 0; n < 7; n++) await f.document(`自建.专题/下层/资料${n}.md`, `尚未进入任何候选集的新主题资料${n}。`);
  await expect(f.library.prepareOwnerFiles('alice')).rejects.toMatchObject({ code: 'MEMORY_FILES_PENDING' });
  // No second query or sync drives these batches.
  await vi.waitFor(() => expect(f.notes()).toHaveLength(7), { timeout: 10000 });
  await vi.waitFor(() => f.library.prepareOwnerFiles('alice'), { timeout: 10000 });
  expect(f.notes().every(note => note.diaryName === '自建.专题')).toBe(true);
  expect(f.commands.filter(command => command.type === 'state').every(command => command.companionId === 'alice')).toBe(true);
});

it('drains a changed noncandidate custom notebook immediately and ignores technical host writes', async () => {
  const f = await fixture(); await f.library.prepareOwnerFiles('alice');
  await f.document('任意日记本/多层/旧主题.md', '起初关于河流的笔记。'); f.notify('rename', 'alice/任意日记本');
  await f.library.prepareOwnerFiles('alice'); expect(f.notes()).toHaveLength(1);
  const original = f.notes()[0]!; f.commands.length = 0;
  await f.document('任意日记本/多层/旧主题.md', '全新的天文主题必须进入下一次检索。'); f.notify('change', 'alice/任意日记本/多层/旧主题.md');
  await f.library.prepareOwnerFiles('alice');
  expect(f.notes()[0]).toMatchObject({ id: original.id, content: '全新的天文主题必须进入下一次检索。', contentRevision: 2 });
  expect(f.commands.filter(command => command.type === 'memory.save')).toHaveLength(1);
  f.commands.length = 0;
  for (const relative of ['.认知索引/index.bin', '.同步状态.json', '.时间线索引.json', '日记/one.md.meta.json', '日记/one.md.abc.tmp', '提示词/共同.md', '来源/raw.md', '记忆历史/note/r1.md']) f.notify('rename', 'alice/' + relative);
  await f.library.prepareOwnerFiles('alice'); expect(f.commands).toEqual([]);
});

it('allows only the descended same-owner validator to reenter while an external query waits and another owner progresses', async () => {
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let nested = false;
  let releaseDescendant!: () => void, descendant!: Promise<boolean>;
  const late = new Promise<void>(resolve => { releaseDescendant = resolve; });
  const f = await fixture({ intercept: async (command, library) => {
    if (command.type !== 'memory.save') return;
    expect(library.isPreparingOwnerFiles('alice')).toBe(true); expect(library.isPreparingOwnerFiles('bob')).toBe(false);
    descendant = late.then(() => library.isPreparingOwnerFiles('alice'));
    await library.prepareOwnerFiles('alice'); nested = true; entered(); await gate;
  } });
  try {
    await f.library.prepareOwnerFiles('alice'); await f.document('项目/新增.md', '内部写入会调用模型语义验证。'); f.notify('change', 'alice/项目/新增.md');
    await inside; expect(nested).toBe(true); expect(f.library.isPreparingOwnerFiles('alice')).toBe(false);
    let completed = false; const external = f.library.prepareOwnerFiles('alice').then(() => { completed = true; });
    await f.library.prepareOwnerFiles('bob'); await new Promise(resolve => setTimeout(resolve, 20)); expect(completed).toBe(false);
    release(); await external; expect(f.notes()).toHaveLength(1);
    releaseDescendant(); expect(await descendant).toBe(false);
  } finally { release(); releaseDescendant(); }
});

it('uses an overflow inventory to preserve a real moved note identity and then commits a confirmed deletion', async () => {
  const f = await fixture(); await f.library.prepareOwnerFiles('alice');
  await f.document('资料/原文件.md', '移动时原文与来源必须保留。'); f.notify('rename', 'alice/资料/原文件.md'); await f.library.prepareOwnerFiles('alice');
  const original = f.notes()[0]!;
  await mkdir(path.dirname(f.file('自建.专题/新文件.md')), { recursive: true });
  await rename(f.file('资料/原文件.md'), f.file('自建.专题/新文件.md'));
  f.notify('rename', null); await f.library.prepareOwnerFiles('alice');
  expect(f.notes()).toHaveLength(1); expect(f.notes()[0]!.id).toBe(original.id);
  expect(JSON.parse(await readFile(f.file('.同步状态.json'), 'utf8')).files['自建.专题/新文件.md'].noteId).toBe(original.id);
  await unlink(f.file('自建.专题/新文件.md')); f.notify('rename', null); await f.library.prepareOwnerFiles('alice');
  expect(f.notes()).toEqual([]);
});

it('receives real recursive OS notifications and imports a new notebook without polling or another query', async () => {
  const f = await fixture({ real: true }); await f.library.prepareOwnerFiles('alice');
  await f.document('新建.日记本/内层/即时.md', 'OS通知触发的新资料。');
  await vi.waitFor(() => expect(f.notes()[0]?.content).toBe('OS通知触发的新资料。'), { timeout: 10000 });
  await f.library.prepareOwnerFiles('alice');
  await f.document('新建.日记本/内层/即时.md', '外部编辑的新主题。');
  await vi.waitFor(() => expect(f.notes()[0]?.content).toBe('外部编辑的新主题。'), { timeout: 10000 });
  await f.library.prepareOwnerFiles('alice'); expect(f.notes()).toHaveLength(1);
});

it('fully reconciles offline edits on a fresh process before allowing its first recall', async () => {
  const f = await fixture(); await f.library.prepareOwnerFiles('alice');
  await f.document('长期笔记/旧主题.md', '离线前的内容。'); f.notify('rename', 'alice/长期笔记'); await f.library.prepareOwnerFiles('alice');
  await f.library.close();
  await f.document('长期笔记/旧主题.md', '软件关闭期间实际改成了新主题。');
  await f.document('新建.离线日记本/内层/补充.md', '软件关闭期间新建的独立材料。');
  const restarted = new CompanionMemoryLibrary({ libraryDirectory: f.directory, request: async command => f.store.request(command), maxFilesPerOwner: 2 });
  try {
    await restarted.prepareOwnerFiles('alice');
    expect(f.notes().map(note => note.content)).toEqual(expect.arrayContaining(['软件关闭期间实际改成了新主题。', '软件关闭期间新建的独立材料。']));
  } finally { await restarted.close(); }
});

it('blocks a real file/host conflict, isolates its peer, and clears the blocking error only after an actual repair', async () => {
  const f = await fixture(); await f.library.prepareOwnerFiles('alice');
  await f.document('项目/冲突.md', '共同原版本。'); f.notify('rename', 'alice/项目'); await f.library.prepareOwnerFiles('alice');
  const original = f.notes()[0]!;
  f.store.saveMemory({ companionId: 'alice', conversationId: original.sourceConversationId, id: original.id, expectedVersion: original.version, content: '同时由软件写入的新版本。' });
  await f.document('项目/冲突.md', '外部编辑器写入的不同版本。'); f.notify('change', 'alice/项目/冲突.md');
  await expect(f.library.prepareOwnerFiles('alice')).rejects.toMatchObject({ code: 'MEMORY_FILES_CONFLICT' });
  expect(await readFile(f.file('项目/冲突.md'), 'utf8')).toBe('外部编辑器写入的不同版本。');
  await f.library.prepareOwnerFiles('bob'); expect(f.notes('bob')).toEqual([]);
  await f.document('项目/冲突.md', '同时由软件写入的新版本。'); f.notify('change', 'alice/项目/冲突.md');
  await f.library.prepareOwnerFiles('alice'); await f.library.prepareOwnerFiles('alice');
  expect(f.notes()[0]!.content).toBe('同时由软件写入的新版本。');
});
