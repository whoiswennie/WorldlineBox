import { mkdtemp, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

it('runs the real-model probe through current, historical and source owner files with no SQL-body fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-canonical-probe-'));
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), [{ id: 'alice', name: 'alice', description: 'Synthetic probe owner', persona: '按实际文件。',
    model: '', avatar: 'sister', active: true, proactive: false }]);
  let files: Awaited<ReturnType<typeof canonicalMemoryFiles>> | undefined;
  try {
    const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
    const message = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '合成物品的蓝色资料袋放在书房东侧书柜最下层，事情尚未完成。', replyDirective: 'none' });
    const original = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: message.content,
      diaryName: '资料', sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }] } }).memories![0]!;
    const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
    store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
    files = await canonicalMemoryFiles(root, store, { apiFormat: 'openai_chat', model: 'unused-synthetic-model', apiKey: 'synthetic' });
    const snapshot = (await files.request({ type: 'memory.snapshot', ...scope })).memorySnapshot!;
    expect(snapshot.fileReceipts).toHaveLength(1); expect(snapshot.notes[0]?.content).toBe(original.content);
    const receipt = snapshot.fileReceipts![0]!;
    expect(await readFile(path.join(root, 'owner-assets', 'alice', ...receipt.path.split('/')), 'utf8')).toBe(original.content);
    const raw = store.getMessage(original.sources[0]!.messageId);
    const revised = store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version,
      candidate: { artifactKind: 'episode_memory' as const, content: original.content + ' 这仍只是一条合成资料记录。', sourceMessageIds: [raw.id], evidence: [{ sourceMessageId: raw.id, quote: raw.content }], tags: ['合成'] } });
    expect(revised.memories![0]!.diaryName).toBe(original.diaryName);
    await files.publish('alice');
    expect(() => store.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: original.contentRevision! })).toThrow('SQL');
    expect((await files.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: original.contentRevision! })).memories![0]!.content).toBe(original.content);
    const descriptor = store.request({ type: 'memory.revision.describe', ...scope, id: original.id, contentRevision: original.contentRevision! }).memoryHistoryDescriptor!;
    await unlink(path.join(root, 'owner-assets', 'alice', ...descriptor.relativePath.split('/')));
    await expect(files.request({ type: 'memory.revision.read', ...scope, id: original.id, contentRevision: original.contentRevision! })).rejects.toThrow();
  } finally { await files?.close(); store.close(); await removeOwnedDirectory(root); }
});
