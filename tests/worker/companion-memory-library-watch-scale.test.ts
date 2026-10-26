import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

/** Isolates real Windows notification/publication behavior from native math. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_WATCH_SCALE !== '1')('does not turn a committed host publication into an unbounded owner rescan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-watch-scale-'));
  const output = path.resolve('artifacts/vcp-validation/memory-watch-host-publication.json');
  const receiptPath = output.replace(/\.json$/u, '-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + process.pid + '.json');
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '只读取真实授权资料。', model: '', avatar: 'sister', proactive: false }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const library = new CompanionMemoryLibrary({ libraryDirectory: path.join(root, '伙伴记忆'), request: async command => store.request(command) });
  const history = new CompanionMemoryHistoryFiles({ library }), sources = new CompanionMemorySourceFiles({ library }), live = new CompanionMemoryLiveFiles({ library, history });
  let failure: unknown, details: Record<string, unknown> = {};
  try {
    const notes = Array.from({ length: 1000 }, (_, n) => store.saveMemory({ ...scope, diaryName: '资料', autoTags: false, content: `真实合成原文编号${n}。` + '保留独立来源和完整上下文。'.repeat(30) }));
    for (let cursor = 0;;) { const result = await live.flush('alice', { noteIds: notes.map(note => note.id), cursor, limit: 64, reconcile: false }); if (!result.pending) break; cursor = result.nextCursor!; }
    while ((await sources.flush('alice')).pending) { /* Actual canonical outbox publication. */ }
    while ((await history.flush('alice')).pending) { /* Actual immutable history files. */ }
    for (;;) { const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!outbox) break;
      store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }
    const coldStarted = performance.now();
    for (let retry = 0;; retry++) {
      try { await library.prepareOwnerFiles('alice'); break; }
      catch (error) { if (retry >= 12 || (error as { code?: string }).code !== 'MEMORY_FILES_PENDING') throw error; }
    }
    const coldMs = performance.now() - coldStarted, publishedAt = performance.now();
    const added = store.saveMemory({ ...scope, content: '在原任务聚焦期间正式增加的全新有据材料。', diaryName: '资料', autoTags: false });
    await sources.flush('alice'); await history.flush('alice'); await live.flush('alice', { noteIds: [added.id] });
    const published = library.ownerFilePreparationStatus('alice'), queryAt = performance.now();
    try { await library.prepareOwnerFiles('alice'); }
    catch (error) { details = { coldMs, publicationMs: queryAt - publishedAt, published, failurePreparation: (error as { memoryFilePreparation?: unknown }).memoryFilePreparation }; throw error; }
    details = { coldMs, publicationMs: queryAt - publishedAt, preparationMs: performance.now() - queryAt,
      published, settled: library.ownerFilePreparationStatus('alice'), native: false, encoder: false, actualSQLiteAndCanonicalFiles: true };
    expect(published.recent.some(event => event.full)).toBe(false);
    expect(store.request({ type: 'memory.list', companionId: 'alice' }).memories).toHaveLength(1001);
  } catch (error) { failure = error; }
  finally {
    await library.close(); store.close(); await mkdir(path.dirname(output), { recursive: true });
    const receipt = JSON.stringify({ status: failure ? 'failed' : 'passed', receiptPath, ...details, error: failure ? String(failure) : undefined }, null, 2);
    await writeFile(receiptPath, receipt, { flag: 'wx' }); await writeFile(output, receipt);
    await removeOwnedDirectory(root);
  }
  if (failure) throw failure;
}, 180000);
