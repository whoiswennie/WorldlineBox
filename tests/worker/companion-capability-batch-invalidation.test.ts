import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

it('preserves a pending real withdrawal until the outer capability batch response rather than draining it inside a shared read', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cap-batch-invalidation-'));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'alice', description: '', persona: '核对实际依据',
    model: '', avatar: 'sister', active: true, proactive: false }]);
  try {
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请查看实际安排。', replyDirective: 'none' });
    const reply = store.appendMessage({ conversationId: scope.conversationId, authorId: scope.companionId, content: '', replyToId: source.id, loopStep: 0 });
    const calls = Array.from({ length: 3 }, (_, i) => ({ id: 'call_' + i, name: 'agenda', arguments: '{"action":"tasks.read"}' }));
    store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: source.id, messageId: reply.id,
      status: 'running', turns: [{ text: '', rawText: '', calls }], supplements: [] } });
    const actions = calls.map(call => store.request({ type: 'capability.begin', ...scope, title: '核对日程', name: call.name,
      callId: call.id, invocationId: source.id + ':alice', input: call.arguments, sourceMessageId: source.id, parentMessageId: reply.id, loopStep: 0 }).action!);
    const unrelated = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '另一条可单独撤回的记录。', replyDirective: 'none' });
    const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: '用户提供了可单独撤回的另一条记录。', tags: [],
      sourceMessageIds: [unrelated.id], relatedMemoryIds: [], evidence: [{ sourceMessageId: unrelated.id, quote: unrelated.content }] } }).memories![0]!;
    store.takeMemoryInvalidations();
    // The public synchronous deletion creates real pending notifications. No
    // request envelope drains them before the capability batch begins.
    store.deleteMemory(note.id);
    const result = store.request({ type: 'execution.capabilities.validate', actions: actions.map(({ id, companionId, conversationId, capability }) => ({ id, companionId, conversationId, capability })) });
    expect(result.capabilityAuthorityResults?.map(item => item.valid)).toEqual([true, true, true]);
    expect(result.memoryInvalidatedCompanionIds).toContain(scope.companionId);
    expect(store.takeMemoryInvalidations()).toEqual({});
  } finally { store.close(); removeOwnedDirectorySync(root); }
});
