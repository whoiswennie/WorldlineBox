import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

it.each([false, true].flatMap(derived => [false, true].map(split => ({ derived, split }))))('rechecks an action collaboration grant after cancellation even with an attested cached parent (%j)', async ({ derived, split }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'authority-review-'));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['a', 'b'].map(id => ({ id, name: id, description: '', persona: 'fixture', model: '', avatar: 'sister', active: true, proactive: false })));
  try {
    const origin = store.openPrivate('a'), child = store.openPrivate('b');
    const source = store.appendMessage({ conversationId: origin.id, authorId: 'user', content: '请b独立核验结果。' });
    const grant = store.request({ type: 'collaboration.create', companionId: 'a', conversationId: origin.id, sourceMessageId: source.id,
      title: '核验', goal: source.content, parentInvocationId: 'parent', evidence: ['请b独立核验结果'],
      participants: [{ companionId: 'b', goal: '独立核验结果。' }], clientId: 'collaboration' }).collaboration!;
    store.request({ type: 'collaboration.respond', id: grant.id, companionId: 'b', decision: 'accept', reason: '接受。' });
    store.request({ type: 'collaboration.start', id: grant.id, companionId: 'b', invocationId: 'child', conversationId: child.id });
    const action = store.createAction({ companionId: 'b', conversationId: child.id, sourceMessageId: source.id,
      authorizationGrantId: grant.id, title: '已核验结果', status: 'queued' });
    store.saveCheckpoint(action.id, { prompt: '独立核验结果。', waitForActionIds: [], supplements: [],
      executionReadset: captureCompanionExecutionReadset({ companionId: 'b', conversationId: child.id }) });
    store.updateAction(action.id, { status: 'succeeded', result: '实际完成结果' });
    const bubble = store.appendMessage({ conversationId: child.id, authorId: 'b', kind: 'action', actionId: action.id, content: '已完成核验。' });
    let target = bubble;
    if (derived) {
      const prompt = store.appendMessage({ conversationId: child.id, authorId: 'user', content: '根据实际核验结果答复。' });
      const parent = store.appendMessage({ conversationId: child.id, authorId: 'b', content: '', loopStep: 0 });
      store.request({ type: 'loop.save', checkpoint: { companionId: 'b', conversationId: child.id, sourceMessageId: prompt.id,
        invocationKey: 'derived-parent', messageId: parent.id, status: 'done', turns: [{ text: '实际核验结果可用。', rawText: '实际核验结果可用。', calls: [] }], supplements: [] },
        executionReadset: captureCompanionExecutionReadset({ companionId: 'b', conversationId: child.id }, { sources: [{ id: bubble.id,
          conversationId: child.id, checksum: createHash('sha256').update(bubble.content).digest('hex') }] }) });
      target = store.getMessage(parent.id);
    }
    let revision = 0, actionChecks = 0, messageChecks = 0, authorityChecks = 0;
    const authority = async () => {
      authorityChecks++;
      try { return store.request({ type: 'collaboration.read', companionId: 'b', id: grant.id }).collaboration?.status !== 'cancelled'; } catch { return false; }
    };
    const read = async (id: string): Promise<ReturnType<CompanionsStore['request']>> => guardCompanionExecutionSources({ type: 'message.get', id }, store.request({ type: 'message.get', id }), {
      storage: async command => store.request(command), revision: () => revision,
      ...(split ? { actionAuthority: authority } : {}),
      valid: async proof => {
        if (proof.kind === 'message') { messageChecks++; return (await read(bubble.id)).message?.content === bubble.content; }
        actionChecks++;
        return split || await authority();
      },
    });
    await withCompanionExecutionValidation(async () => {
      expect((await read(target.id)).message?.content).toBe(target.content);
      const before = store.request({ type: 'execution.sources', sourceMessageIds: [target.id], memoryIds: [] }).executionSources!;
      expect(before.find(proof => proof.kind === 'action')?.storageValidatedAuthorityEpoch).toBeTypeOf('number');
      if (derived) expect(before.find(proof => proof.kind === 'message')?.storageValidatedAuthorityEpoch).toBeTypeOf('number');
      revision++; store.request({ type: 'collaboration.cancel', companionId: 'a', id: grant.id, reason: '撤回本次授权。' }); revision++;
      const result = await read(target.id);
      expect(actionChecks).toBe(split ? 1 : 2);
      expect(authorityChecks).toBeGreaterThanOrEqual(2);
      expect(messageChecks).toBe(derived ? 1 : 0);
      expect(result.message?.content).not.toBe(target.content);
      expect(result.message?.sourceUnavailable).toBe('execution_source_changed');
    });
  } finally { store.close(); removeOwnedDirectorySync(root); }
});
