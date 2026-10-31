import { expect, it, vi } from 'vitest';
import { generateCompanionReply } from '../../src/main/companions/model';
import { COMPANION_OBSERVE_TOOL } from '../../src/shared/companion-observe-tool';
import { COMPANION_AGENDA_THOUGHT_TOOL } from '../../src/shared/companion-agenda-thought-tool';
import type { CompanionReplyInput } from '../../src/main/companions/context';

it('carries host-selected observation and visual thought tools through the real ordinary-chat provider request', async () => {
  const input: CompanionReplyInput = {
    companion: { id: 'alice', name: '澄澄', description: '', persona: '依据真实观察交流。', model: 'mock', avatar: 'sister', builtin: false, proactive: false, createdAt: '2026-10-29T08:00:00.000Z' },
    conversation: { id: 'private_alice', kind: 'private', title: '澄澄', memberIds: ['alice'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-29T08:00:00.000Z', lastMessage: '' },
    messages: [{ id: 'source', conversationId: 'private_alice', sequence: 1, authorId: 'user', kind: 'text', content: '看看我现在在做什么。', createdAt: '2026-10-29T08:00:00.000Z', status: 'sent', attachments: [] }], memories: [],
  };
  const fetchFn = vi.fn<typeof fetch>(async (_url, request) => {
    const payload = JSON.parse(String(request!.body)) as { tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> };
    expect(payload.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['agenda', 'memory', 'world', 'dsh', 'observe', 'think']));
    for (const name of ['observe', 'think']) {
      const schema = payload.tools.find(tool => tool.function.name === name)!.function.parameters;
      expect(schema.type).toBe('object'); expect(schema.anyOf).toBeUndefined(); expect(schema.oneOf).toBeUndefined();
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'watch_call', type: 'function',
      function: { name: 'observe', arguments: JSON.stringify({ action: 'watch', sourceId: 'window:allowed:0', seconds: 2, frameCount: 2 }) } }] } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const reply = await generateCompanionReply(input, { apiFormat: 'openai_chat', baseUrl: 'https://not-contacted.invalid/v1', model: 'mock', apiKey: 'synthetic' }, undefined,
    { loop: true, additionalTools: [COMPANION_OBSERVE_TOOL, COMPANION_AGENDA_THOUGHT_TOOL], fetchFn });
  expect(reply.turn?.calls).toHaveLength(1); expect(reply.turn?.calls[0]).toMatchObject({ id: 'watch_call', name: 'observe' }); expect(fetchFn).toHaveBeenCalledOnce();
});
