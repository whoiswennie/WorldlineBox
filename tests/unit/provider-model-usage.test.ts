import { expect, it, vi } from 'vitest';
import { providerUsage, estimateProviderInput, mergeProviderUsage } from '../../src/main/llm/model-usage';
import { companionModelUsageView, companionUsageCacheHitPercent, updateCompanionModelUsage, type CompanionModelUsageCurrent } from '../../src/shared/companion-model-usage';
import { readProviderStream } from '../../src/main/llm/provider-stream';

const estimate = estimateProviderInput('openai_chat', { messages: [{ role: 'system', content: '角色' }, { role: 'user', content: '问题' }] });
const current = (overrides: Partial<CompanionModelUsageCurrent> = {}): CompanionModelUsageCurrent => ({ attemptId: 'a661eb22-b9eb-49c7-b1ac-b4770902b835', model: 'fixture', providerFormat: 'openai_chat',
  phase: 'finished', updatedAt: '2026-10-29T14:00:00.000Z', estimate, ...overrides });
it('normalizes real provider buckets without inventing cache writes from misses or absent fields', () => {
  expect(providerUsage('openai_chat', { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } }))
    .toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80 });
  expect(providerUsage('openai_responses', { response: { usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } } } }))
    .toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 10, reasoningTokens: 2 });
  expect(providerUsage('anthropic', { message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } } }))
    .toEqual({ inputTokens: 49, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 7 });
  expect(providerUsage('gemini_native', { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 37, cachedContentTokenCount: 10 } }))
    .toEqual({ inputTokens: 30, outputTokens: 7, totalTokens: 37, cacheReadTokens: 10, reasoningTokens: 2 });
  expect(providerUsage('dashscope_native', { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } })).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  expect(providerUsage('openai_chat', {})).toBeUndefined();
  expect(companionUsageCacheHitPercent({ inputTokens: 100, cacheReadTokens: 80 })).toBe(80);
  expect(companionUsageCacheHitPercent({ inputTokens: 100 })).toBeUndefined();
});
it('replaces cumulative samples for one attempt and counts later HTTP attempts exactly once, keeping missing totals unknown', () => {
  let state = updateCompanionModelUsage(undefined, current({ phase: 'prepared' })); expect(state.totals.requests).toBe(0);
  state = updateCompanionModelUsage(state, current({ phase: 'dispatched' })); expect(state.totals).toEqual({ requests: 1, reportedRequests: 0, complete: false });
  const start = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 60 };
  state = updateCompanionModelUsage(state, current({ phase: 'streaming', actual: start }));
  state = updateCompanionModelUsage(state, current({ actual: mergeProviderUsage(start, { outputTokens: 10 }) }));
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
  const measured = estimateProviderInput('openai_chat', body);
  expect(measured.hasUnmeteredImages).toBe(true); expect(measured.inputTokens).toBeLessThan(500);
  expect(measured.breakdown.system).toBeGreaterThan(0); expect(measured.breakdown.dialogue).toBeGreaterThan(0);
  expect(measured.breakdown.toolHistory).toBeGreaterThan(0); expect(measured.breakdown.toolDefinitions).toBeGreaterThan(0);
});
it('reads native usage arriving after the Chat finish_reason instead of cancelling the stream early', async () => {
  const encoder = new TextEncoder();
  const frames = [{ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 70 } }];
  const response = new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n')); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const usage = vi.fn(); await readProviderStream(response, 'openai_chat', { signal: new AbortController().signal, onUsage: usage });
  expect(usage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 70 });
});
