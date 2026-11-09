import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import type { BotEvent } from '../../src/main/companion-bot/types';

class Memory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('fixture boundary'); }, embedding: async () => { throw Error('fixture boundary'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, inputHash: 'fixture', scope: input.scope, messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async close() {}
}
class Brain extends BotDshBrain {
  handler: (input: BotDshRun) => Promise<string> = async () => '已收到';
  constructor() { super({ getHost: async () => { throw Error('fixture boundary'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    const text = input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : await this.handler(input);
    return { text, status: 'succeeded', eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) };
  }
  override async archive() {}
  override async close() {}
}
const owned: Array<{ root: string; service: BotService }> = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.service.shutdown();
    if (path.dirname(path.resolve(item.root)) !== path.resolve(tmpdir()) || !path.basename(item.root).startsWith('wlb-causal-')) throw Error('Invalid test cleanup');
    await rm(item.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-causal-')), brain = new Brain(), memory = new Memory(root);
  const service = new BotService({ root, brain, memory, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }), onEvent: () => undefined });
  owned.push({ root, service });
  return { root, service, brain };
}
async function waitFor(check: () => boolean, timeout = 5000) {
  const start = performance.now(); while (!check()) { if (performance.now() - start > timeout) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function tool(input: BotDshRun, name: string, args: object) {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'causal-fixture', name, args }) });
  const value = await response.json() as { ok: boolean; result: { status?: string; accepted?: boolean } };
  expect(value.ok).toBe(true); return value.result;
}
async function initial(service: BotService) { const state = (await service.handle({ type: 'state' })).snapshot!; return { conversationId: state.conversations[0]!.id, companionId: state.companions[0]!.id }; }
const send = (service: BotService, conversationId: string, requestId: string, content = '你好') => service.handle({ type: 'message.send', conversationId, requestId, content });

it('bounds world-action feedback separately for two actors without copying private trigger content into world events', async () => {
  const f = await fixture(), origin = await initial(f.service), blocked = new Map<string, number>(), events: BotEvent[] = [];
  f.brain.handler = async input => {
    const event = f.service.store.getEvent(input.eventId)!; events.push(event);
    if ((await tool(input, 'world', { operation: 'interact', action: 'stand' })).status === 'blocked') blocked.set(event.companionId, (blocked.get(event.companionId) ?? 0) + 1);
    return '观察并完成本轮';
  };
  await send(f.service, origin.conversationId, 'world-root-1', '私聊内容 PRIVATE_TRIGGER_ONLY');
  await waitFor(() => blocked.get(origin.companionId) === 1);
  const second = await f.service.handle({ type: 'companion.create', name: '第二位', persona: '独立伙伴' });
  const secondConversation = f.service.store.getConversation(second.conversationId!)!, secondId = secondConversation.memberIds.find(id => id !== 'user')!;
  await send(f.service, secondConversation.id, 'world-root-2'); await waitFor(() => blocked.get(secondId) === 1);
  for (const id of [origin.companionId, secondId]) expect(events.filter(event => event.companionId === id).map(event => Number(event.payload.hop ?? 0))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(events.filter(event => event.source === 'world').every(event => !event.content.includes('PRIVATE_TRIGGER_ONLY'))).toBe(true);
  expect(events.filter(event => event.source === 'world').every(event => Object.keys(event.payload).sort().join(',') === 'hop,worldEventId')).toBe(true);
});

it('keeps arrival causation after a failed manual action and clears it after a successful new manual action', async () => {
  let time = 1000; vi.spyOn(Date, 'now').mockImplementation(() => time);
  const f = await fixture(), origin = await initial(f.service), events: BotEvent[] = [];
  f.brain.handler = async input => {
    const event = f.service.store.getEvent(input.eventId)!; events.push(event);
    if (event.source === 'user') await tool(input, 'world', { operation: 'move', sceneId: `home_${origin.companionId}`, x: 10, y: 13 });
    return '已观察';
  };
  await send(f.service, origin.conversationId, 'arrival-root'); await waitFor(() => events.length === 2);
  const root = events[0]!;
  await expect(f.service.handle({ type: 'world.act', ...origin, effectId: 'blocked-manual', command: { operation: 'move', sceneId: `home_${origin.companionId}`, x: 14, y: 2 } })).rejects.toThrow('不可到达');
  time += 1000; await f.service.handle({ type: 'world.observe', ...origin }); await waitFor(() => events.length === 3);
  expect(events[2]).toMatchObject({ correlationId: root.correlationId, causationId: root.id, payload: { hop: 1 } });
  await f.service.handle({ type: 'world.act', ...origin, effectId: 'new-manual', command: { operation: 'move', sceneId: `home_${origin.companionId}`, x: 10, y: 15 } });
  await waitFor(() => events.length === 4); time += 1000; await f.service.handle({ type: 'world.observe', ...origin }); await waitFor(() => events.length === 5);
  expect(events[4]!.correlationId).not.toBe(root.correlationId); expect(events[4]!.payload.hop).toBe(0);
  expect(f.service.store.getMetadata(`world:causal-actor:${origin.companionId}`)).toBe('');
});

it('can shut down immediately before asynchronous startup settles', async () => {
  const f = await fixture(); await f.service.shutdown();
  expect(await f.service.handle({ type: 'state' })).toEqual({ ok: false, error: '伙伴正在关闭。' });
  await new Promise(resolve => setTimeout(resolve, 10)); await f.service.shutdown();
});
