import { expect, it, vi } from 'vitest';
import { companionProviderUsage, estimateCompanionProviderInput, mergeCompanionProviderUsage } from '../../src/main/companions/model-usage';
import { companionModelUsageView, companionUsageCacheHitPercent, updateCompanionModelUsage, type CompanionModelUsageCurrent } from '../../src/shared/companion-model-usage';
import { generateCompanionReply } from '../../src/main/companions/model';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { readCompanionProviderStream } from '../../src/main/companions/provider-stream';

const estimate = estimateCompanionProviderInput('openai_chat', { messages: [{ role: 'system', content: '角色' }, { role: 'user', content: '问题' }] });
const current = (overrides: Partial<CompanionModelUsageCurrent> = {}): CompanionModelUsageCurrent => ({ attemptId: 'a661eb22-b9eb-49c7-b1ac-b4770902b835', model: 'fixture', providerFormat: 'openai_chat',
  phase: 'finished', updatedAt: '2026-10-29T14:00:00.000Z', estimate, ...overrides });
it('normalizes real provider buckets without inventing cache writes from misses or absent fields', () => {
  expect(companionProviderUsage('openai_chat', { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } }))
    .toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 });
  expect(companionProviderUsage('openai_responses', { response: { usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } } } }))
    .toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 10, reasoningTokens: 2 });
  expect(companionProviderUsage('anthropic', { message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } } }))
    .toEqual({ inputTokens: 49, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 7 });
  expect(companionProviderUsage('gemini_native', { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 37, cachedContentTokenCount: 10 } }))
    .toEqual({ inputTokens: 30, outputTokens: 7, totalTokens: 37, cacheReadTokens: 10, reasoningTokens: 2 });
  expect(companionProviderUsage('dashscope_native', { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } })).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  expect(companionProviderUsage('openai_chat', {})).toBeUndefined();
  expect(companionUsageCacheHitPercent({ inputTokens: 100, cacheReadTokens: 80 })).toBe(80);
  expect(companionUsageCacheHitPercent({ inputTokens: 100 })).toBeUndefined();
});
it('replaces cumulative samples for one attempt and counts later HTTP attempts exactly once, keeping missing totals unknown', () => {
  let state = updateCompanionModelUsage(undefined, current({ phase: 'prepared' })); expect(state.totals.requests).toBe(0);
  state = updateCompanionModelUsage(state, current({ phase: 'dispatched' })); expect(state.totals).toEqual({ requests: 1, reportedRequests: 0, complete: false });
  const start = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 60 };
  state = updateCompanionModelUsage(state, current({ phase: 'streaming', actual: start }));
  state = updateCompanionModelUsage(state, current({ actual: mergeCompanionProviderUsage(start, { outputTokens: 10 }) }));
  expect(state.totals).toMatchObject({ requests: 1, reportedRequests: 1, inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60, complete: true });
  const oldRevision = state.revision;
  state = updateCompanionModelUsage(state, current({ attemptId: 'a661eb22-b9eb-49c7-b1ac-b4770902b836', actual: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } }));
  expect(state.totals).toMatchObject({ requests: 2, reportedRequests: 2, inputTokens: 150, outputTokens: 15, totalTokens: 165, complete: true });
  expect(state.totals.cacheReadTokens).toBeUndefined(); expect(state.revision).toBe(oldRevision + 1);
  expect(companionModelUsageView(state)).not.toHaveProperty('prior');
});
it('estimates the actual projected text and tool declarations, excluding base64 image bytes and host-only fields', () => {
  const body = { messages: [{ role: 'system', content: '角色规则' }, { role: 'user', content: [{ type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200000) } }] }, { role: 'tool', content: '实际工具结果' }], tools: [{ type: 'function', function: { name: 'memory', description: '回忆', parameters: { type: 'object' } } }] };
  const measured = estimateCompanionProviderInput('openai_chat', body);
  expect(measured.hasUnmeteredImages).toBe(true); expect(measured.inputTokens).toBeLessThan(500);
  expect(measured.breakdown.system).toBeGreaterThan(0); expect(measured.breakdown.dialogue).toBeGreaterThan(0);
  expect(measured.breakdown.toolHistory).toBeGreaterThan(0); expect(measured.breakdown.toolDefinitions).toBeGreaterThan(0);
});
it('reads native usage arriving after the Chat finish_reason instead of cancelling the stream early', async () => {
  const encoder = new TextEncoder();
  const frames = [{ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 70 } }];
  const response = new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n')); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const usage = vi.fn(); await readCompanionProviderStream(response, 'openai_chat', { signal: new AbortController().signal, onUsage: usage });
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 70 });
});
it('emits actual API counts and explicitly estimated prepared input from a real mocked provider invocation without disclosing prompt content', async () => {
  const input: CompanionReplyInput = { companion: { id: 'alice', name: '澄澄', persona: '保留自己的判断。', description: '', model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: '2026-10-29T14:00:00.000Z' },
    conversation: { id: 'private_alice', kind: 'private', title: '本人', memberIds: ['alice'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-29T14:00:00.000Z', lastMessage: '' }, messages: [], memories: [] };
  const samples: CompanionModelUsageCurrent[] = [], fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '我来核对。' } }],
    usage: { prompt_tokens: 123, completion_tokens: 4, total_tokens: 127 } }), { headers: { 'content-type': 'application/json' } }));
  await generateCompanionReply(input, { apiFormat: 'openai_chat', model: 'fixture-model', baseUrl: 'https://fixture.invalid', apiKey: 'NEVER_EXPOSE_KEY', contextWindowTokens: 10000 }, undefined,
    { loop: true, fetchFn, onUsage: value => samples.push(value) });
  expect(samples.map(sample => sample.phase)).toEqual(['prepared', 'dispatched', 'streaming', 'finished']);
  expect(samples.at(-1)).toMatchObject({ actual: { inputTokens: 123, outputTokens: 4, totalTokens: 127 }, contextLimit: 10000 });
  expect(samples.at(-1)?.actual?.cacheReadTokens).toBeUndefined(); expect(JSON.stringify(samples)).not.toContain('NEVER_EXPOSE_KEY');
});
