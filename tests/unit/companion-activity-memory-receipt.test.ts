import { expect, it } from 'vitest';
import { activityMemoryReceipt } from '../../src/main/companions/activity-task-service';
import { companionMemorySchema } from '../../src/shared/companion-memory';

function note(id: string, sourceIds: string[], content = '有来源的认识') {
  return companionMemorySchema.parse({ id, companionId: 'alice', scopeId: 'alice_private', content, tags: ['学习'],
    sourceConversationId: 'private', sourceSequence: 1, sourceThroughSequence: 1, status: 'indexed', version: 1,
    captureMethod: 'manual', origin: 'user', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
    sources: sourceIds.map(messageId => ({ messageId, conversationId: 'private', sequence: 1, authorId: 'user', revision: 1, checksum: 'fixture', createdAt: '2026-10-21T00:00:00Z' })) });
}
it('keeps long diary history valid JSON and excludes untracked revision-bound RAG context', () => {
  const receipt = activityMemoryReceipt({ ok: true, memories: [note('one', ['source'], '中'.repeat(65536))],
    memoryContext: { text: 'PRIVATE_UNTRACKED_CONTEXT', revision: 'old', profileKey: 'gemma' } });
  expect(receipt.result.length).toBeLessThanOrEqual(16000);
  const parsed = JSON.parse(receipt.result);
  expect(parsed.memories[0].contentTruncated).toBe(true); expect(parsed.truncated).toBe(true);
  expect(receipt.result).not.toContain('PRIVATE_UNTRACKED_CONTEXT');
  expect(receipt.sourceMessageIds).toEqual(['source']); expect(receipt.noteVersions).toEqual([{ id: 'one', version: 1 }]);
});
it('never drops source provenance while retaining the associated diary in durable task history', () => {
  const receipt = activityMemoryReceipt({ ok: true, memories: [note('one', Array.from({ length: 100 }, (_, index) => `source${index}`)), note('two', ['extra'])] });
  expect(receipt.sourceMessageIds).toHaveLength(100);
  expect(JSON.parse(receipt.result).memories.map((entry: { id: string }) => entry.id)).toEqual(['one']);
  expect(receipt.result).not.toContain('extra'); expect(receipt.noteVersions).toEqual([{ id: 'one', version: 1 }]);
});
