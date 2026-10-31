import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { LibraryService, type AssetObserverEvent, type AssetObserverFactory, type DebounceScheduler } from '../../src/worker/library-service';

const fixtures: Array<{ service: LibraryService; root: string }> = [];
afterEach(() => { for (const { service, root } of fixtures.splice(0)) {
  service.closeAll();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-library-assets-')) throw new Error('Unexpected companion asset fixture root.');
  rmSync(root, { recursive: true, force: true });
} });

class ManualScheduler implements DebounceScheduler {
  private readonly tasks = new Map<number, () => void | Promise<void>>();
  private nextId = 0;
  cancel(handle: unknown): void { this.tasks.delete(handle as number); }
  schedule(callback: () => void | Promise<void>): unknown { const id = ++this.nextId; this.tasks.set(id, callback); return id; }
  pending(): number { return this.tasks.size; }
  async flush(): Promise<void> { const current = [...this.tasks.values()]; this.tasks.clear(); for (const task of current) await task(); }
}
function put(root: string, relative: string, text = relative) {
  const file = path.join(root, ...relative.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file;
}
function observedFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-library-assets-')), callbacks = new Map<string, (event?: AssetObserverEvent) => void>();
  const observerFactory: AssetObserverFactory = (directory, callback) => { callbacks.set(directory, callback); return { close: () => callbacks.delete(directory) }; };
  const scheduler = new ManualScheduler(), changes: unknown[] = [];
  const service = new LibraryService({ observerFactory, scheduler, watcherStableFileWindowMs: 0, onAssetsChanged: event => changes.push(event) });
  fixtures.push({ root, service });
  const library = service.createLibrary({ displayName: '伙伴', selectedParentPath: root }), memoryRoot = path.join(library.libraryPath, '伙伴记忆');
  mkdirSync(memoryRoot);
  return { root, library, memoryRoot, service, scheduler, callbacks, changes };
}
it('maps only the fixed companion text directory into its owning asset library', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-library-assets-')), service = new LibraryService(); fixtures.push({ root, service });
  const library = service.createLibrary({ displayName: '伙伴', selectedParentPath: root });
  const memoryRoot = path.join(library.libraryPath, '伙伴记忆');
  mkdirSync(path.join(memoryRoot, 'alice', '日记'), { recursive: true });
  writeFileSync(path.join(memoryRoot, 'alice', '日记', '一次学习.md'), '我读过了资料，这是一篇有实际来源的学习日记。');
  expect(() => service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: memoryRoot })).toThrow();
  const folder = service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: memoryRoot, companionMemory: true, displayName: '伙伴记忆' });
  expect(folder.assetCount).toBe(1);
  expect(service.listLinkedFolders(library.libraryId)).toEqual(expect.arrayContaining([expect.objectContaining({ folderId: folder.folderId, absoluteRootPath: memoryRoot })]));
  const other = path.join(library.libraryPath, '其他资料'); mkdirSync(other);
  expect(() => service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: other, companionMemory: true })).toThrow();
  expect(() => service.importFolderAsLinked({ libraryId: library.libraryId, sourceRootPath: library.libraryPath, companionMemory: true })).toThrow();
});

it('prunes only the canonical owner cognition tree and host sidecars while retaining real profile, prompt, diary and source assets', () => {
  const f = observedFixture();
  const visible = ['alice/profile.md', 'alice/提示词/manifest.json', 'alice/提示词/对话.md', 'alice/日记/day.md', 'alice/来源/source.md', 'alice/记忆历史/note-one/r1-history.md',
    'alice/日记/.认知索引/user-authored.md', 'alice/日记/同步状态.md', 'alice/日记/.同步状态.json',
    'alice/记忆/经历/published.md', 'alice/记忆/知识/learned.md', 'alice/演化/发布/r1.md',
    'alice/日记/.运行/索引/user-authored.md', 'alice/.运行/我的笔记.md', '.运行/索引/user-authored.md'];
  const technical = ['alice/.认知索引/hot/index.sqlite', 'alice/.认知索引/cold/tmp/chunk.bin', 'alice/.同步状态.json', 'alice/.时间线索引.json',
    'alice/同步状态.md', 'alice/日记/day.md.meta.json', 'alice/来源/source.md.meta.json', 'alice/profile.md.12345678-1234-4234-8234-123456789abc.tmp',
    'alice/.运行/索引/hot/runtime/RiverMemoEngine.js', 'alice/.运行/上下文/ctx_one/request.json', 'alice/.运行/上下文/ctx_one/attempt.json',
    'alice/.运行/视图/persona.json', 'alice/.运行/发布/暂存/operation.bin', 'alice/.运行/观察/contact-sheet.png',
    'alice/.运行/引用/task.json', 'alice/.运行/诊断/run.json', 'alice/.运行/日程职能版本.json'];
  for (const file of [...visible, ...technical]) put(f.memoryRoot, file);
  const linked = f.service.importFolderAsLinked({ libraryId: f.library.libraryId, sourceRootPath: f.memoryRoot, companionMemory: true });
  expect(linked.assetCount).toBe(visible.length);
  expect(f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true }).map(asset => asset.relativeFilePath).sort()).toEqual([...visible].sort());
  expect(f.service.getLinkedFolderRules({ libraryId: f.library.libraryId, folderId: linked.folderId })).toContainEqual(expect.objectContaining({
    target: 'path', pattern: 'alice/.认知索引', action: 'exclude', enabled: true,
  }));

  const externalRoot = path.join(f.root, '普通外部资料');
  const externalFiles = ['alice/.认知索引/user.md', 'alice/日记/day.md.meta.json', 'alice/.运行/索引/runtime/RiverMemoEngine.js', 'alice/.运行/上下文/request.json'];
  for (const file of externalFiles) put(externalRoot, file);
  const external = f.service.importFolderAsLinked({ libraryId: f.library.libraryId, sourceRootPath: externalRoot });
  expect(external.assetCount).toBe(externalFiles.length);
  expect(f.service.listAssets({ libraryId: f.library.libraryId, folderId: external.folderId, recursive: true }).map(asset => asset.relativeFilePath).sort())
    .toEqual([...externalFiles].sort());
  const otherLibrary = f.service.createLibrary({ displayName: '另一个资产库', selectedParentPath: f.root });
  const foreign = f.service.importFolderAsLinked({ libraryId: otherLibrary.libraryId, sourceRootPath: f.memoryRoot });
  expect(f.service.listAssets({ libraryId: otherLibrary.libraryId, folderId: foreign.folderId, recursive: true }).map(asset => asset.relativeFilePath))
    .toEqual(expect.arrayContaining(['alice/.认知索引/hot/index.sqlite', 'alice/日记/day.md.meta.json', 'alice/.运行/索引/hot/runtime/RiverMemoEngine.js']));
});

it('silences internal change and rename storms for an existing root even without default rules, while real role edits still refresh', async () => {
  const f = observedFixture(); put(f.memoryRoot, 'alice/profile.md', 'before');
  const linked = f.service.importFolderAsLinked({ libraryId: f.library.libraryId, sourceRootPath: f.memoryRoot, companionMemory: true });
  f.service.setLinkedFolderRules({ libraryId: f.library.libraryId, folderId: linked.folderId, rules: [] });
  const original = f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true })[0]!;
  const callback = f.callbacks.get(f.memoryRoot)!;
  const reconcile = vi.spyOn(f.service as unknown as { runWatcherReconciliation(...args: unknown[]): Promise<void> }, 'runWatcherReconciliation');
  const enumerate = vi.spyOn(f.service as unknown as { enumerateSourcesAsync(...args: unknown[]): Promise<unknown> }, 'enumerateSourcesAsync');
  f.changes.length = 0;
  const generated = ['alice/.认知索引/hot/index.sqlite', 'alice/.认知索引/hot/index.sqlite-wal', 'alice/.认知索引/历史发布/durable-job.tmp', 'alice/.同步状态.json', 'alice/.时间线索引.json',
    'alice/同步状态.md', 'alice/日记/real.md.meta.json', 'alice/来源/original.md.meta.json',
    'alice/.同步状态.json.12345678-1234-4234-8234-123456789abc.tmp', 'alice/提示词/对话.md.12345678-1234-4234-8234-123456789abc.tmp',
    'alice/.运行/索引/hot/runtime/RiverMemoEngine.js', 'alice/.运行/上下文/ctx_one/request.json', 'alice/.运行/上下文/ctx_one/attempt.json',
    'alice/.运行/索引', 'alice/.运行/上下文'];
  for (const relative of generated.filter(relative => !['alice/.运行/索引', 'alice/.运行/上下文'].includes(relative))) put(f.memoryRoot, relative);
  for (let round = 0; round < 50; round++) for (const filename of generated) {
    callback({ eventType: 'change', filename }); callback({ eventType: 'rename', filename });
  }
  expect(f.scheduler.pending()).toBe(0); expect(reconcile).not.toHaveBeenCalled(); expect(f.changes).toEqual([]);

  put(f.memoryRoot, 'alice/profile.md', 'a real new complete role profile body');
  callback({ eventType: 'change', filename: 'alice/profile.md' });
  expect(f.scheduler.pending()).toBe(1); await f.scheduler.flush();
  const current = f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true })[0]!;
  expect(current.currentRevisionId).not.toBe(original.currentRevisionId); expect(current.byteSize).toBe(Buffer.byteLength('a real new complete role profile body'));
  expect(enumerate).not.toHaveBeenCalled();

  // A root imported before these rules existed also protects later owners.
  for (const relative of ['bob/profile.md', 'bob/提示词/manifest.json', 'bob/来源/observed.md', 'bob/.认知索引/new/shard.bin', 'bob/来源/observed.md.meta.json']) put(f.memoryRoot, relative);
  f.service.refreshManagedAssets(f.library.libraryId);
  const expected = ['alice/profile.md', 'bob/profile.md', 'bob/提示词/manifest.json', 'bob/来源/observed.md'];
  expect(f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true }).map(asset => asset.relativeFilePath).sort()).toEqual(expected.sort());
  put(f.memoryRoot, 'bob/日记/new.md'); callback({ eventType: 'rename', filename: 'bob/日记/new.md' });
  await f.scheduler.flush();
  expect(enumerate).toHaveBeenCalled();
  expect(f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true }).map(asset => asset.relativeFilePath).sort())
    .toEqual([...expected, 'bob/日记/new.md'].sort());
  expect(f.scheduler.pending()).toBe(0);
});

it('keeps previously registered runtime files and audit rows but excludes them from asset reconciliation', () => {
  const f = observedFixture(), runtime = 'alice/.运行/索引/hot/runtime/RiverMemoEngine.js';
  put(f.memoryRoot, 'alice/profile.md'); const runtimeFile = put(f.memoryRoot, runtime);
  const linked = f.service.importFolderAsLinked({ libraryId: f.library.libraryId, sourceRootPath: f.memoryRoot, companionMemory: true });
  // Reproduce a row imported by the earlier scanner without touching a user library.
  const legacy = vi.spyOn(f.service as unknown as { isCompanionMemoryTechnicalPath(relative: string): boolean }, 'isCompanionMemoryTechnicalPath').mockReturnValue(false);
  f.service.setLinkedFolderRules({ libraryId: f.library.libraryId, folderId: linked.folderId, rules: [] });
  const old = f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true }).find(asset => asset.relativeFilePath === runtime)!;
  expect(old).toBeDefined(); legacy.mockRestore();
  const resolve = vi.spyOn(f.service as unknown as { linkedAssetPath(...args: unknown[]): string }, 'linkedAssetPath');
  f.service.setLinkedFolderRules({ libraryId: f.library.libraryId, folderId: linked.folderId, rules: [] });
  f.service.refreshManagedAssets(f.library.libraryId);
  expect(resolve.mock.calls.some(args => args[2] === runtime)).toBe(false);
  expect(f.service.listAssets({ libraryId: f.library.libraryId, folderId: linked.folderId, recursive: true }).map(asset => asset.relativeFilePath)).toEqual(['alice/profile.md']);
  expect(existsSync(runtimeFile)).toBe(true);
  expect(f.service.getAssetDisplayName(f.library.libraryId, old.assetId)).toBe('RiverMemoEngine.js');
});
