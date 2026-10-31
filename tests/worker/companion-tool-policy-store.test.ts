import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { DEFAULT_COMPANION_TOOL_POLICY } from '../../src/shared/companion-tool-policy';

it('freezes selection with message identity and rejects same-client replay with expanded capabilities after reopen', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-tool-policy-'));
  const filename = path.join(root, 'messages.sqlite');
  let store: CompanionsStore | undefined;
  try {
    const seed = [{ id: 'alice', name: '澄澄', persona: '依据真实经历表达。', description: '', model: '', avatar: 'sister' as const, active: true, proactive: false }];
    store = new CompanionsStore(filename, seed); const conversationId = store.openPrivate('alice').id;
    const toolPolicy = { ...DEFAULT_COMPANION_TOOL_POLICY, dsh: false };
    const sent = { conversationId, authorId: 'user', content: '先商量这个任务。', clientId: 'actual_send', toolPolicy };
    const message = store.appendMessage(sent); expect(message.toolPolicy).toEqual(toolPolicy);
    toolPolicy.browser = true;
    expect(store.getMessage(message.id).toolPolicy?.browser).toBe(false);
    expect(() => store!.appendMessage(sent)).toThrow('重试标识');
    store.close(); store = new CompanionsStore(filename, seed);
    expect(store.getMessage(message.id).toolPolicy).toEqual({ ...DEFAULT_COMPANION_TOOL_POLICY, dsh: false });
    expect(() => store!.appendMessage({ ...sent, toolPolicy: { ...DEFAULT_COMPANION_TOOL_POLICY, dsh: true } })).toThrow('重试标识');
    expect(() => store!.appendMessage({ ...sent, authorId: 'alice', clientId: 'fake_owner_policy' })).toThrow('用户原始消息');
  } finally {
    store?.close();
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('companion-tool-policy-')) rmSync(root, { recursive: true, force: true });
  }
});
