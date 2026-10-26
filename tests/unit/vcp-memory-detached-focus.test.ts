import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VcpMemoryFocusOptions, VcpMemoryPluginConfiguration, VcpMemoryPreparedPayload, VcpMemoryPreprocessResult } from '../../src/main/vcp-memory/contracts';

const load = createRequire(path.resolve('package.json'));
const { focusPreparedRecall, modelIdentity } = load(path.resolve('src/main/vcp-memory/prepared-focus.cjs')) as {
  focusPreparedRecall(payload: VcpMemoryPreparedPayload, configuration: { vendorRoot: string; chat: VcpMemoryPluginConfiguration['chat'] }, options?: VcpMemoryFocusOptions): Promise<VcpMemoryPreprocessResult>;
  modelIdentity(chat: VcpMemoryPluginConfiguration['chat']): string;
};
const { createRagQueryClock } = load(path.resolve('src/main/vcp-memory/peripherals.cjs')) as {
  createRagQueryClock(overrides: Record<string, unknown>): { load(file: string): new (plugin: unknown, cache: unknown) => Handler; run<T>(clock: unknown, operation: () => Promise<T>): Promise<T> };
};
interface Handler {
  config: unknown; promptTemplate: string;
  processAIMemoPlusAggregated(...args: unknown[]): Promise<string>;
}
const chat = { baseUrl: 'http://127.0.0.1/not-used', apiKey: 'fixture', model: 'controlled-focus', sourceSignature: 'route-one' };
const clock = { now: '2026-10-26T03:04:05Z', timeZone: 'Asia/Shanghai' };
function fixture(batched = false): VcpMemoryPreparedPayload {
  return { schema: 'worldlinebox.prepared-recall-payload', modelIdentity: modelIdentity(chat),
    receipt: { messages: [{ role: 'system', content: '资料：WORLDLINE_PREPARED_FOCUS_' + 'a'.repeat(32) }], events: [], queryClock: clock, contextReferences: [], contextReferenceCoverage: 'observed' },
    groups: [{ token: 'WORLDLINE_PREPARED_FOCUS_' + 'a'.repeat(32), dbNames: ['alice', 'alice-notes'],
      userContent: '这次约定有什么条件？', aiContent: null, combinedQueryForDisplay: 'test-query',
      promptTemplate: '时间{{Date}} {{Time}}\n资料{{knowledge_base}}\n问题{{current_user_prompt}}\n前文{{last_assistant_response}}',
      config: { model: chat.model, batchSize: 2, maxTokensPerBatch: batched ? 10030 : 18000, promptFile: 'AIMemoPrompt.txt' },
      options: { baseK: 5, tagWeight: .6, cacheSalt: 'same-source', sourceFiles: [
        { name: 'one', dbName: 'alice', source: 'suffix_pipeline', content: '原始条件：下雨时不出门。', tokens: 25, score: .8 },
        { name: 'two', dbName: 'alice-notes', source: 'suffix_pipeline', content: '补充：约定尚未完成。', tokens: 25, score: .9 },
        { name: 'duplicate', dbName: 'alice', source: 'suffix_pipeline', content: '原始条件：下雨时不出门。', tokens: 25, score: .7 },
      ] } }] };
}
function response(prompt: string): string { return `这是我获取的所有相关知识/记忆[[核验 ${createHash('sha256').update(prompt).digest('hex')}]]`; }
it.each([false, true])('keeps exact upstream sourceFiles prompt, ordering, batching and output with detached=%s', async batched => {
  const payload = fixture(batched), prompts: unknown[] = [];
  const result = await focusPreparedRecall(payload, { vendorRoot: path.resolve('vendor/vcp-memory'), chat }, {
    fetchFn: async (_url, init) => { const body = JSON.parse(String(init?.body)); prompts.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: response(body.messages[0].content) } }] }), { status: 200 }); },
  });
  const directPrompts: unknown[] = [], events: unknown[] = [];
  const queryClock = createRagQueryClock({ axios: { post: async (_url: string, body: { messages: Array<{ content: string }> }) => {
    directPrompts.push(body); return { data: { choices: [{ message: { content: response(body.messages[0]!.content) } }] } };
  } } });
  const Handler = queryClock.load(path.resolve('vendor/vcp-memory/Plugin/RAGDiaryPlugin/AIMemoHandler.js'));
  const handler = new Handler({ pushVcpInfo: (event: unknown) => events.push(event) }, { generateKey: () => 'test', get: () => undefined, set: () => undefined });
  const group = payload.groups[0]!;
  handler.config = { ...group.config, url: 'http://127.0.0.1/not-used/', apiKey: chat.apiKey }; handler.promptTemplate = group.promptTemplate;
  const original = await queryClock.run(clock, () => handler.processAIMemoPlusAggregated(group.dbNames, group.userContent,
    group.aiContent, group.combinedQueryForDisplay, null, group.options));
  expect(prompts).toEqual(directPrompts);
  expect(result.messages[0]!.content).toBe('资料：' + original);
  expect(result.events).toEqual(events);
  expect(String((prompts[0] as { messages: Array<{ content: string }> }).messages[0]!.content)).toContain('2026-10-26 11:04:05');
});
it('checks revocation before every actual request and refuses late publication', async () => {
  let valid = true, requests = 0;
  const payload = fixture(true);
  payload.groups[0]!.options.sourceFiles.push({ name: 'three', dbName: 'alice', source: 'suffix_pipeline', content: '第三批必须在撤销后阻断。', tokens: 25, score: .6 });
  await expect(focusPreparedRecall(payload, { vendorRoot: path.resolve('vendor/vcp-memory'), chat }, {
    validate: async () => { if (!valid) throw new Error('source revoked'); },
    fetchFn: async () => { requests++; valid = false; return new Response(JSON.stringify({ choices: [{ message: { content: '这是我获取的所有相关知识/记忆[[old]]' } }] })); },
  })).rejects.toThrow('source revoked');
  // The first two requests are an upstream concurrent batch; the following
  // group cannot send, and no already-in-flight answer may be published.
  expect(requests).toBe(2);
});
it('does not reuse prepared inputs across a changed model route', async () => {
  await expect(focusPreparedRecall(fixture(), { vendorRoot: path.resolve('vendor/vcp-memory'), chat: { ...chat, sourceSignature: 'different' } })).rejects.toThrow('model route');
  await expect(focusPreparedRecall(fixture(), { vendorRoot: path.resolve('vendor/vcp-memory'), chat: { ...chat, baseUrl: 'https://another-provider.invalid' } })).rejects.toThrow('model route');
});
it('retains the upstream retry policy for a non-JSON HTTP 503 response', async () => {
  const requests: string[] = [];
  const result = await focusPreparedRecall(fixture(), { vendorRoot: path.resolve('vendor/vcp-memory'), chat }, {
    fetchFn: async (_url, init) => {
      requests.push(String(init?.body));
      return requests.length === 1 ? new Response('temporarily unavailable', { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '这是我获取的所有相关知识/记忆[[重试后完成。]]' } }] }));
    },
  });
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]);
  expect(String(result.messages[0]!.content)).toContain('重试后完成。');
});
it('retains the upstream timeout retry when headers arrive before a stalled response body', async () => {
  const timeout = new AbortController();
  const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout.signal);
  let requests = 0;
  try {
    const result = await focusPreparedRecall(fixture(), { vendorRoot: path.resolve('vendor/vcp-memory'), chat }, {
      fetchFn: async () => {
        if (++requests > 1) return new Response(JSON.stringify({ choices: [{ message: { content: '这是我获取的所有相关知识/记忆[[完整响应重试成功。]]' } }] }));
        return new Response(new ReadableStream({ start(controller) { queueMicrotask(() => {
          timeout.abort(new Error('fixture response body timed out')); controller.error(timeout.signal.reason);
        }); } }));
      },
    });
    expect(requests).toBe(2); expect(String(result.messages[0]!.content)).toContain('完整响应重试成功。');
  } finally { timer.mockRestore(); }
});
