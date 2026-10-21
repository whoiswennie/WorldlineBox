import { expect, it } from 'vitest';
import type { CompanionMemory } from '../../src/shared/companions';
import { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';

const note: CompanionMemory = { id: 'note_a', companionId: 'alice', scopeId: 'scope_a', content: '真实来源的合成测试日记。', tags: ['测试'], diaryName: '日记',
  sourceConversationId: 'private-alice', sourceMessageId: 'message_a', sourceSequence: 1, createdAt: '2026-10-21', updatedAt: '2026-10-21',
  version: 1, origin: 'user', status: 'indexed', captureMethod: 'automatic', metadata: { source: 'original' },
  sources: [{ messageId: 'message_a', conversationId: 'private-alice', authorId: 'user', sequence: 1, revision: 1, checksum: 'original', createdAt: '2026-10-21', sourceType: 'message' }] };

it('reuses a ready graph for additions while changing notebook classification forces a fresh physical graph', async () => {
  const cache = new CompanionMemoryViewCache();
  const first = await cache.prepare('alice:private-alice', 'global-model', [note]); await first.commit();
  const added = await cache.prepare('alice:private-alice', 'global-model', [note, { ...note, id: 'note_b' }]); await added.commit();
  expect(added.scopeId).toBe(first.scopeId);
  const reclassified = await cache.prepare('alice:private-alice', 'global-model', [{ ...note, diaryName: '资料' }, { ...note, id: 'note_b' }]);
  expect(reclassified.scopeId).not.toBe(first.scopeId); expect(reclassified.replacedScopeId).toBe(first.scopeId);
});

it.each(['metadata', 'source'] as const)('cannot reuse an old graph when authoritative %s changes even if text and note version match', async changed => {
  const cache = new CompanionMemoryViewCache(), first = await cache.prepare('alice:private-alice', 'global-model', [note]); await first.commit();
  const revised = changed === 'metadata' ? { ...note, metadata: { source: 'revised' } } : { ...note, sources: [{ ...note.sources[0]!, checksum: 'revised' }] };
  const next = await cache.prepare('alice:private-alice', 'global-model', [revised]);
  expect(next.scopeId).not.toBe(first.scopeId); expect(next.replacedScopeId).toBe(first.scopeId);
});
