import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { botRequestSchema } from '../../src/shared/companion-bot';

class Memory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw new Error('unused'); }, embedding: async () => { throw new Error('unused'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'fixture', status: 'ready', evidence: '', metadata: {}, events: [], omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async close() {}
}
class Brain extends BotDshBrain {
  constructor(private readonly runTurn: (input: BotDshRun) => Promise<string>) { super({ getHost: async () => { throw new Error('unused'); } }); }
  override async run(input: BotDshRun) {
    const text = input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : await this.runTurn(input);
    return { status: 'succeeded' as const, text, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, inputContextCommitted: true };
  }
  override async close() {}
  override async cancelDurable(input: Omit<BotDshRun, 'prompt' | 'onEvent'>, suspend = false) {
    return { accepted: true, paused: suspend, absent: !suspend, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId };
  }

}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Capability fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
it('persists companion stop, blocks new turns, starts only the selected companion and does not implicitly resume user-paused tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-capabilities-')), transitions: string[] = [];
  let turns = 0;
  const service = new BotService({ root, brain: new Brain(async () => { turns++; return '在这里'; }), memory: new Memory(path.join(root, 'memory')), onEvent: () => undefined,
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }),
    companionRuntime: async (id, _name, operation) => { transitions.push(`${id}:${operation}`); } });
  cleanups.push(async () => { await service.shutdown(); if (path.dirname(root) !== os.tmpdir()) throw new Error('Unexpected temp root'); await rm(root, { recursive: true, force: true }); });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, room = snapshot.conversations[0]!, owner = room.memberIds.find(id => id !== 'user')!;
  expect(botRequestSchema.parse({ type: 'companion.runtime', companionId: owner, operation: 'stop' })).toBeTruthy();
  expect((await service.handle({ type: 'companion.runtime', companionId: owner, operation: 'stop' })).snapshot?.companions.find(companion => companion.id === owner)?.enabled).toBe(false);
  await expect(service.handle({ type: 'message.send', conversationId: room.id, content: '关闭期间', requestId: 'stopped' })).rejects.toThrow('伙伴已关闭');
  expect(turns).toBe(0); expect(service.store.getMetadata(`companion-enabled:${owner}`)).toBe('0');
  expect((await service.handle({ type: 'companion.runtime', companionId: owner, operation: 'start' })).snapshot?.companions.find(companion => companion.id === owner)?.enabled).toBe(true);
  await service.handle({ type: 'message.send', conversationId: room.id, content: '重新启用', requestId: 'enabled' });
  await waitFor(() => turns === 1);
  expect(transitions).toEqual([`${owner}:stop`, `${owner}:start`]);
});

it('a stop interrupts a cold startup waiter immediately and cannot be undone by its late completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-capabilities-'));
  let entered!: () => void, starts = 0, stopped = false, startupSignal: AbortSignal | undefined;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const service = new BotService({ root, brain: new Brain(async () => '在这里'), memory: new Memory(path.join(root, 'memory')), onEvent: () => undefined,
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }),
    companionRuntime: async (_id, _name, operation, signal) => {
      if (operation === 'stop') { stopped = true; return; }
      starts++;
      if (starts === 1) {
        startupSignal = signal; entered();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    } });
  cleanups.push(async () => { await service.shutdown(); if (path.dirname(root) !== os.tmpdir()) throw new Error('Unexpected temp root'); await rm(root, { recursive: true, force: true }); });
  const owner = (await service.handle({ type: 'state' })).snapshot!.companions[0]!.id;
  const first = service.handle({ type: 'companion.runtime', companionId: owner, operation: 'start' }).catch(error => error);
  await starting;
  await service.handle({ type: 'companion.runtime', companionId: owner, operation: 'stop' });
  expect(startupSignal?.aborted).toBe(true); expect(await first).toBeInstanceOf(Error);
  expect(stopped).toBe(true); expect(service.store.getCompanion(owner)?.enabled).toBe(false);
  await service.handle({ type: 'companion.runtime', companionId: owner, operation: 'start' });
  expect(starts).toBe(2); expect(service.store.getCompanion(owner)?.enabled).toBe(true);
});
