import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { companionRecallCapabilities, companionTaskInvocation, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import { companionAgentRunIdentity } from '../../src/main/companions/agent-journal';
import { COMPANION_SUBMIT_RESULT_TOOL } from '../../src/shared/companion-final-proposal';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

it('offers no autonomous recall and rejects memory or personal-experience calls before any storage request', async () => {
  const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true }));
  const caps = companionRecallCapabilities(request, { companionId: 'alice', conversationId: 'owned_room' });
  expect(caps.tools).toEqual([]);
  for (const [name, args] of [['memory', '{broken'], ['memory', '{"action":"search","query":"same facts"}'],
    ['memory', '{"action":"record","candidate":{}}'], ['memory.search', '{"query":"same facts"}'], ['memory.read', '{"id":"known"}'],
    ['world', '{"action":"experience","parameters":{"action":"list"}}'], ['world.experience', '{"action":"list"}'], ['experience.read', '{"id":"known"}']] as const) {
    expect(await caps.execute({ id: 'unoffered', name, arguments: args })).toMatchObject({ ok: false, code: 'MEMORY_TOOL_DISABLED' });
  }
  expect(request).not.toHaveBeenCalled();
});

it('keeps real SQL passive and confirmed legacy receipts through continuation/restart with zero active recall execution', async () => {
  const f = managedMemoryFiles();
  try {
    const conversation = f.store.createConversation('实际同伴对话', ['alice', 'bob']);
    const source = f.store.appendMessage({ conversationId: conversation.id, authorId: 'bob', content: '请回答当前问候。', replyDirective: 'none' });
    const companion = f.store.state().companions.find(item => item.id === 'alice')!;
    const scope = { companionId: companion.id, conversationId: conversation.id, beforeSequence: source.sequence };
    const invocation = companionTaskInvocation({ companion, conversationId: conversation.id, id: 'actual_host_recall_peer', kind: 'peer', goal: source.content,
      createdAt: source.createdAt, source, messageIds: [source.id] });
    const base = companionRecallCapabilities(f.request, scope), shape = z.object({ answer: z.string() });
    const snapshot = { text: '任务开始时由系统准备的固定回忆。', revision: 'initial_snapshot', profileKey: 'initial_encoder' };
    const frame = { companion, conversation, messages: [source], sourceMessage: source, memories: [], audience: 'peers' as const, invocation,
      memoryRecall: { memories: [], sources: [], reasons: [], pending: false, degraded: false, context: snapshot } };
    const context = { system: '按原领域合同回答。', user: '{"purpose":"world_social"}' };
    let existing = await base.journal.load(frame, context);
    existing.turns.push({ text: '', rawText: '', calls: [{ id: 'legacy_read', name: 'memory', arguments: '{"action":"read","id":"legacy_note"}' }],
      results: [{ callId: 'legacy_read', content: '{"ok":true,"legacyAudit":"actual_old_confirmed_receipt"}' }] });
    existing.effects.push({ step: 0, callId: 'legacy_read', state: 'confirmed', result: existing.turns[0]!.results![0]!.content });
    await base.journal.save(existing);
    const execute = vi.fn(async () => { throw new Error('Retired recall must never dispatch'); });
    const capabilities = { ...base, continuityRequest: undefined, tools: [
      { name: 'memory', description: 'adapter injection', parameters: { type: 'object' } },
      { name: 'memory.read', description: 'dotted injection', parameters: { type: 'object' } },
    ], execute };
    let unavailable = true, calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)), names = body.tools.map((entry: { function: { name: string } }) => entry.function.name);
      expect(names).toContain(COMPANION_SUBMIT_RESULT_TOOL); expect(names.some((name: string) => name === 'memory' || name.startsWith('memory.'))).toBe(false);
      expect(JSON.parse(body.messages[1].content).memoryRecall.context.text).toBe(snapshot.text);
      expect(body.messages.some((row: { role: string; content?: string }) => row.role === 'tool' && row.content?.includes('actual_old_confirmed_receipt'))).toBe(true);
      if (++calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
        { id: 'hallucinated_search', type: 'function', function: { name: 'memory', arguments: '{"action":"search","query":"unoffered"}' } },
        { id: 'hallucinated_read', type: 'function', function: { name: 'memory.read', arguments: '{"id":"unoffered"}' } },
      ] } }] }));
      expect(body.messages.filter((row: { role: string; content?: string }) => row.role === 'tool' && row.content?.includes('MEMORY_TOOL_DISABLED'))).toHaveLength(2);
      if (unavailable) throw new Error('Actual provider transport temporarily unavailable');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"已按本轮上下文回答。"}' } }] }));
    });
    const input = { context, frame, capabilities, finalSchema: z.toJSONSchema(shape), responseSchema: shape, validateOutput: (value: unknown) => shape.parse(value) };
    const config = { apiFormat: 'openai_chat' as const, model: 'contract-provider', baseUrl: 'https://unused.invalid/v1', apiKey: 'synthetic-only' };
    await expect(runCompanionStructuredAgent(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'NETWORK' });
    f.restart(); unavailable = false;
    await expect(runCompanionStructuredAgent({ ...input, frame: { ...frame, memoryRecall: { ...frame.memoryRecall, context: {
      ...snapshot, text: 'A continuation cannot replace the initial snapshot.' } } } }, config, undefined, { fetchFn })).resolves.toEqual({ answer: '已按本轮上下文回答。' });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(execute).not.toHaveBeenCalled();
    existing = f.store.request({ type: 'agent.run.get', companionId: companion.id, id: companionAgentRunIdentity(companion.id, conversation.id, invocation.id) }).agentRun!;
    expect(existing.status).toBe('done'); expect(existing.passiveRecall?.context?.text).toBe(snapshot.text);
    expect(existing.effects.find(effect => effect.callId === 'legacy_read')?.result).toContain('actual_old_confirmed_receipt');
    expect(f.commands.some(command => command.type === 'memory.search' || command.type === 'memory.read' || command.type === 'memory.record' || command.type.startsWith('experience.'))).toBe(false);
  } finally { await f.close(); }
});
