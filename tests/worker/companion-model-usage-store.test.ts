import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { updateCompanionModelUsage } from '../../src/shared/companion-model-usage';
import { CompanionReplyStream } from '../../src/main/companions/reply-stream';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionReplyStreamEvent } from '../../src/shared/companions';

it('streams usage independently of text and retains actual cumulative counts when the message is reopened', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-model-usage-')); const filename = path.join(root, 'messages.sqlite');
  const seed = [{ id: 'alice', name: '澄澄', persona: '依据真实记录表达。', description: '', model: '', avatar: 'sister' as const, proactive: false }];
  let store: CompanionsStore | undefined;
  try {
    store = new CompanionsStore(filename, seed); const room = store.openPrivate('alice');
    const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '核对一下这个目标。' });
    const message = store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '', replyToId: source.id, loopStep: 0 });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: room.id, sourceMessageId: source.id, messageId: message.id, status: 'running', turns: [], supplements: [] };
    const events: CompanionReplyStreamEvent[] = [];
    const stream = new CompanionReplyStream({ checkpoint, step: 0, publish: event => events.push(event), save: async () => store!.request({ type: 'loop.save', checkpoint }) });
    const current = { attemptId: 'a661eb22-b9eb-49c7-b1ac-b4770902b835', model: 'fixture', providerFormat: 'openai_chat', phase: 'dispatched' as const,
      updatedAt: new Date().toISOString(), estimate: { inputTokens: 120, method: 'utf8_bytes_div_3' as const, hasUnmeteredImages: false, breakdown: { system: 30, dialogue: 40, toolDefinitions: 50, toolHistory: 0, other: 0 } } };
    stream.onUsage(current); stream.onTextDelta('真实输出');
    stream.onUsage({ ...current, phase: 'finished', actual: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 80 } });
    await stream.complete(); await store.request({ type: 'loop.save', checkpoint });
    expect(events.filter(event => event.phase === 'usage')).toHaveLength(2);
    expect(events.at(-1)?.modelUsage?.totals).toMatchObject({ requests: 1, reportedRequests: 1, inputTokens: 100, outputTokens: 5 });
    expect(checkpoint.draft?.text).toBe('真实输出'); expect(store.getMessage(message.id).modelUsage?.current.actual?.cacheReadTokens).toBe(80);
    store.close(); store = new CompanionsStore(filename, seed);
    expect(store.getMessage(message.id).modelUsage?.totals).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 5, totalTokens: 105 });
    expect(store.getMessage(message.id).modelUsage).not.toHaveProperty('prior');
    expect(updateCompanionModelUsage(checkpoint.usage, { ...current, phase: 'finished', actual: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } }).totals.requests).toBe(1);
  } finally {
    store?.close();
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('companion-model-usage-')) rmSync(root, { recursive: true, force: true });
  }
});
