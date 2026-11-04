import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { LibraryWorkerClient } from '../../../src/main/worker-client';
import { AppLogger } from '../../../src/main/app-logger';
import { resetLegacyBotData } from '../../../src/main/companion-bot/legacy-reset';

interface Plan {
  userData: string; library: string; newRoot: string;
  targets: Array<{ path: string; kind: 'file' | 'directory' }>;
  linkedFolders: Array<{ folderId: string; libraryId: string; absoluteRootPath: string }>;
  locator: { path: string; sha256: string };
}
const output = process.env.WORLDLINEBOX_LEGACY_RESET_OUTPUT!;
const planFile = process.env.WORLDLINEBOX_LEGACY_RESET_PLAN!;
assert(output && planFile && process.env.WORLDLINEBOX_LEGACY_RESET_APPLY === '1', 'Explicit --apply launcher is required');
mkdirSync(path.join(output, 'profile'), { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => undefined);
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
app.whenReady().then(async () => {
  let worker: LibraryWorkerClient | undefined;
  try {
    const plan = JSON.parse(await readFile(planFile, 'utf8')) as Plan;
    const oldMemoryRoot = path.join(plan.library, '伙伴记忆');
    const indexReceipt: { matched: string[]; removed: Array<{ id: string; assets: number }>; alreadyAbsentApprovedRoots: string[]; after: string[] } = {
      matched: [], removed: [], alreadyAbsentApprovedRoots: [], after: [],
    };
    const result = await resetLegacyBotData(plan.userData, plan.newRoot, {
      expectedLibrary: plan.library, expectedLocatorSha256: plan.locator.sha256, removeLocator: true,
      beforeDelete: async manifest => {
        assert(manifest.libraryPath && same(manifest.libraryPath, plan.library));
        assert(manifest.oldMemoryRoot && same(manifest.oldMemoryRoot, oldMemoryRoot));
        // The official Worker owns all index mutation and closes its watchers
        // and database before the cleaner removes any original files.
        worker = new LibraryWorkerClient(path.join(__dirname, 'library_worker.js'), new AppLogger(path.join(output, 'worker.log')));
        await worker.start();
        const opened = await worker.request({ type: 'library.open', selectedLibraryPath: plan.library });
        assert(opened.ok && opened.type === 'library.opened', JSON.stringify(opened));
        const libraryId = opened.library.libraryId;
        assert(plan.linkedFolders.every(folder => folder.libraryId === libraryId), 'Library identity changed after inspection');
        const list = await worker.request({ type: 'linked-folder.list', libraryId });
        assert(list.ok && list.type === 'linked-folder.list', JSON.stringify(list));
        const matched = list.folders.filter(folder => same(folder.absoluteRootPath, oldMemoryRoot) && folder.relativePath === '');
        const keep = list.folders.filter(folder => !same(folder.absoluteRootPath, oldMemoryRoot)).map(folder => folder.folderId).sort();
        indexReceipt.alreadyAbsentApprovedRoots = plan.linkedFolders.filter(folder => !matched.some(actual => actual.folderId === folder.folderId)).map(folder => folder.folderId);
        for (const folder of matched) {
          assert(plan.linkedFolders.some(expected => expected.folderId === folder.folderId && same(expected.absoluteRootPath, oldMemoryRoot)), 'Linked folder identity changed after inspection');
          indexReceipt.matched.push(folder.folderId);
          const removed = await worker.request({ type: 'linked-folder.delete-subtree', libraryId, linkedFolderId: folder.folderId,
            relativePath: '', deleteFromDisk: false, includeDeleted: true });
          assert(removed.ok && removed.type === 'linked-folder.subtree-deleted' && removed.failedCount === 0, JSON.stringify(removed));
          indexReceipt.removed.push({ id: folder.folderId, assets: removed.deletedAssetCount });
          await writeFile(path.join(output, 'index-receipt.json'), JSON.stringify(indexReceipt, null, 2) + '\n');
        }
        const after = await worker.request({ type: 'linked-folder.list', libraryId });
        assert(after.ok && after.type === 'linked-folder.list', JSON.stringify(after));
        assert(!after.folders.some(folder => same(folder.absoluteRootPath, oldMemoryRoot)), 'Retired memory root remains indexed');
        assert.deepEqual(after.folders.map(folder => folder.folderId).sort(), keep, 'Unrelated linked roots changed');
        indexReceipt.after = after.folders.map(folder => folder.folderId);
        const closed = await worker.request({ type: 'library.close', libraryId }); assert(closed.ok);
        await worker.shutdown(); worker = undefined;
        await writeFile(path.join(output, 'index-receipt.json'), JSON.stringify(indexReceipt, null, 2) + '\n');
      },
    });
    const absent: string[] = [];
    for (const target of plan.targets) {
      try { await lstat(target.path); throw new Error('Legacy target still exists: ' + target.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; absent.push(target.path); }
    }
    try { await lstat(plan.locator.path); throw new Error('Retired locator still exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const preserved = [path.join(plan.library, '.worldlinebox', 'library.db'), path.join(plan.library, 'Assets'), plan.newRoot];
    for (const file of preserved) await lstat(file);
    const report = { completed: result.completed, manifest: result, indexReceipt, absent, locatorAbsent: true, preserved,
      usesModel: false, usesEmbedding: false, usesDsh: false };
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('LEGACY_BOT_RESET_RESULT ' + JSON.stringify(report)); app.exit(0);
  } catch (error) {
    console.error(error); await worker?.shutdown().catch(() => undefined);
    await writeFile(path.join(output, 'failure.txt'), error instanceof Error ? error.stack || error.message : String(error)); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
