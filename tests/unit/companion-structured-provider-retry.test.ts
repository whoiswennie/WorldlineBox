import { expect, it, vi } from 'vitest';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { CompanionReplyInput } from '../../src/main/companions/context';

const frame: CompanionReplyInput = {
  companion: { id: 'alice', name: '林澄', description: '', persona: '本人稳定身份，核验真实回执。', model: '', avatar: 'sister', builtin: false,
    active: true, proactive: false, createdAt: '2026-10-23T00:00:00.000Z' },
  conversation: { id: 'fixture_room', kind: 'private', title: '合成测试', memberIds: ['alice'], pinned: false, muted: false, unread: 0,
    updatedAt: '2026-10-23T00:00:00.000Z', lastMessage: '' }, messages: [], memories: [],
};
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic' };
const partial = () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"answer":"UNCOMMITTED_PARTIAL' }, finish_reason: null }] }) + '\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
const json = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

it('retries two unfinished native envelopes in the same inference slot, keeping a confirmed prior effect exactly once', async () => {
  const execute = vi.fn(async () => ({ ok: true, actualReceipt: 'receipt_701' }));
  const wires: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let requests = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    wires.push(JSON.parse(String(init?.body))); requests++;
    if (requests === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'original_provider_call', type: 'function',
      function: { name: 'world', arguments: '{"action":"fixture_effect"}' } }] } }] }));
    if (requests < 4) return partial();
    return json('{"answer":"依据receipt_701确认，不重执行。"}');
  };
  expect(await runCompanionStructuredAgent({ frame, context: { system: '返回JSON answer。', user: '{"purpose":"provider_retry_fixture"}' },
    capabilities: { tools: [{ name: 'world', description: '真实合成作用', parameters: { type: 'object' } }], execute, replaySafe: true } }, config, undefined, { fetchFn }))
    .toEqual({ answer: '依据receipt_701确认，不重执行。' });
  expect(requests).toBe(4); expect(execute).toHaveBeenCalledOnce();
  const retained = wires.slice(1).map(wire => wire.messages.filter(message => ['assistant', 'tool'].includes(message.role)));
  expect(retained[0]).toEqual(retained[1]); expect(retained[1]).toEqual(retained[2]);
  expect(JSON.stringify(retained)).toContain('receipt_701'); expect(JSON.stringify(wires)).not.toContain('UNCOMMITTED_PARTIAL');
});

it('stops after the original native request plus two retries and retains a payload-free stream diagnostic', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => partial());
  const error = await runCompanionStructuredAgent({ frame, context: { system: '返回JSON answer。', user: '{}' } }, config, undefined, { fetchFn }).catch(error => error);
  expect(error).toMatchObject({ code: 'INVALID_RESPONSE', diagnostic: 'uncompleted_stream' });
  expect(fetchFn).toHaveBeenCalledTimes(3); expect(JSON.stringify(error)).not.toContain('UNCOMMITTED_PARTIAL');
});

it('does not reset the native retry budget when a transported proposal is rejected inside the same stable decision slot', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(async () => partial()).mockImplementationOnce(async () => partial())
    .mockImplementationOnce(async () => json('not valid final JSON')).mockImplementation(async () => partial());
  const error = await runCompanionStructuredAgent({ frame, context: { system: '返回JSON answer。', user: '{}' } }, config, undefined, { fetchFn }).catch(error => error);
  expect(error).toMatchObject({ code: 'INVALID_RESPONSE', cause: { code: 'INVALID_RESPONSE' } });
  expect(JSON.stringify(error)).not.toContain('UNCOMMITTED_PARTIAL');
  expect(fetchFn).toHaveBeenCalledTimes(4);
  const repair = JSON.parse(String(fetchFn.mock.calls[3]![1]?.body));
  expect(JSON.parse(repair.messages.find((message: { role: string }) => message.role === 'user').content).purpose).toBe('companion_structured_repair');
});
