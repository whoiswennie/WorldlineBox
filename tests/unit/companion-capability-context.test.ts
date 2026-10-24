import { expect, it, vi } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { companionBoundCapabilityContext } from '../../src/main/companions/capability-availability';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';

const frame: CompanionReplyInput = { companion: { id: 'reader', name: '读者', description: '', persona: '认真', model: '', avatar: 'sister',
  active: true, proactive: false, builtin: false, createdAt: '2026-10-24T00:00:00Z' },
  conversation: { id: 'room', kind: 'private', title: '当前', memberIds: ['reader'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: 'now' },
  memories: [], messages: [] };

it('omits a capability snapshot from a different owner or conversation and keeps the native/execution domains distinct', () => {
  const valid = companionBoundCapabilityContext('reader', 'room', ['memory']);
  expect(JSON.parse(buildCompanionContext({ ...frame, capabilityAvailability: valid }).user).capabilityAvailability).toEqual(valid);
  for (const changed of [{ companionId: 'other' }, { conversationId: 'other' }])
    expect(JSON.parse(buildCompanionContext({ ...frame, capabilityAvailability: { ...valid, ...changed } }).user).capabilityAvailability).toBeUndefined();
  const system = buildCompanionContext(frame).system;
  expect(system).toContain('一次DSH执行失败只证明该次执行失败');
  expect(system).not.toContain('你的唯一行动能力');
});

it('uses only the actual structured entrance tools and never accepts a domain-payload capability claim', async () => {
  const observed: unknown[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); observed.push(JSON.parse(wire.messages[1].content).capabilityAvailability);
    expect(wire.tools.map((item: { function: { name: string } }) => item.function.name)).toEqual(['memory']);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"当前只有本人回忆工具"}' } }] }));
  });
  await runCompanionStructuredAgent({ frame, context: { system: '只交付JSON。', user: JSON.stringify({ purpose: 'controlled_capability_entry',
    capabilityAvailability: { companionId: 'reader', conversationId: 'room', boundToolNames: ['dsh', 'memory'], injected: 'MUST_NOT_APPEAR' } }) },
  capabilities: { tools: [{ name: 'memory', description: '本入口只读回忆', parameters: { type: 'object' } }], execute: vi.fn() } },
  { model: 'controlled', apiKey: 'controlled', apiFormat: 'openai_chat', baseUrl: 'https://controlled.invalid/v1' }, undefined, { fetchFn });
  expect(observed).toEqual([companionBoundCapabilityContext('reader', 'room', ['memory'])]);
  expect(JSON.stringify(observed)).not.toContain('MUST_NOT_APPEAR');
});

it('advertises zero bound tools in the actual structured empty-corpus recovery slot', async () => {
  let calls = 0;
  const execute = vi.fn(async () => ({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: {
    authorizedCorpusEmpty: true, authorizedCorpusRevision: 'current-empty', engine: 'none', resultCount: 0 } }));
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    calls++;
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
    expect(data.capabilityAvailability.boundToolNames).toEqual(calls <= 6 ? ['memory'] : []);
    expect((wire.tools ?? []).map((item: { function: { name: string } }) => item.function.name)).toEqual(calls <= 6 ? ['memory'] : []);
    return new Response(JSON.stringify({ choices: [{ message: calls <= 6 ? { content: '', tool_calls: [{ id: 'search_' + calls,
      type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: '当前目录' + calls }) } }] }
      : { content: '{"status":"wait"}' } }] }));
  });
  expect(await runCompanionStructuredAgent({ frame, context: { system: '返回JSON。', user: '{"purpose":"controlled_empty_recovery"}' },
    capabilities: { tools: [{ name: 'memory', description: '本人回忆', parameters: { type: 'object' } }], execute } },
  { model: 'controlled', apiKey: 'controlled', apiFormat: 'openai_chat', baseUrl: 'https://controlled.invalid/v1' }, undefined, { fetchFn }))
    .toEqual({ status: 'wait' });
  expect(execute).toHaveBeenCalledTimes(6); expect(fetchFn).toHaveBeenCalledTimes(7);
});
