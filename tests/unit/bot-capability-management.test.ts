import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import type { DshTaskCapabilities } from '../../src/shared/dsh-task-spec';
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
  override async upgradeWorkerAccess(input: Parameters<BotDshBrain['upgradeWorkerAccess']>[0]) {
    return { absent: true as const, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId };
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Capability fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function call(input: BotDshRun, args: object, callId: string, name = 'agent_capabilities') {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  return { status: response.status, body: await response.json() as { result?: Record<string, unknown> } };
}
it('discovers only the current companion through native queries and refreshes revision without changing persona or loading catalogs into prompts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-capabilities-'));
  let revision = 'equipment-1'; const queries: Array<{ owner: string; kind: string }> = [], prompts: Record<string, unknown>[] = [], results: unknown[] = [];
  const brain = new Brain(async input => {
    const body = JSON.parse(input.prompt); prompts.push(body);
    results.push(await call(input, { kind: 'summary' }, 'summary'));
    results.push(await call(input, { kind: 'catalog', category: 'tool', query: 'palette', offset: 0, limit: 2 }, 'catalog'));
    results.push(await call(input, { kind: 'summary', companionId: 'someone-else', instanceId: 'private-other' }, 'forged-scope'));
    return '查询完成';
  });
  const service = new BotService({ root, brain, memory: new Memory(path.join(root, 'memory')), onEvent: () => undefined,
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }),
    capabilityState: owner => ({ mode: 'private', configured: true, instanceId: `host-${owner}`, revision }),
    capabilities: async (owner, query) => {
      queries.push({ owner, kind: query.kind });
      return { instanceId: `host-${owner}`, runtimeId: 'shared-runtime', runtimeVersion: '0.2.2-rc.1', capturedAt: new Date().toISOString(),
        modes: ['native'], preset: 'default', tools: [], skills: [], toolRestrictions: true, skillSelection: true, workspacePath: root,
        effective: { digest: 'a'.repeat(64), mode: 'native', preset: 'default', toolCount: 1500, skillCount: 50 } } satisfies DshTaskCapabilities;
    } });
  cleanups.push(async () => { await service.shutdown(); if (path.dirname(root) !== os.tmpdir()) throw new Error('Unexpected temp root'); await rm(root, { recursive: true, force: true }); });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, room = snapshot.conversations[0]!, owner = room.memberIds.find(id => id !== 'user')!;
  const persona = service.store.getCompanion(owner)!.persona;
  await service.handle({ type: 'message.send', conversationId: room.id, content: '查询当前能力', requestId: 'first' });
  await waitFor(() => results.length === 3);
  revision = 'equipment-2';
  await service.handle({ type: 'message.send', conversationId: room.id, content: '装备变更后再查', requestId: 'second' });
  await waitFor(() => results.length === 6);
  expect(queries).toEqual(Array.from({ length: 2 }, () => [{ owner, kind: 'summary' }, { owner, kind: 'catalog' }]).flat());
  expect(results[2]).toMatchObject({ status: 400 }); expect(results[5]).toMatchObject({ status: 400 });
  expect(prompts.map(prompt => prompt.capabilities)).toEqual([expect.objectContaining({ revision: 'equipment-1', readTool: 'agent_capabilities' }), expect.objectContaining({ revision: 'equipment-2' })]);
  expect(prompts.every(prompt => {
    const capabilities = prompt.capabilities as Record<string, unknown>;
    return !('tools' in capabilities) && !('skills' in capabilities)
      && JSON.stringify({ configured: capabilities.configured, mode: capabilities.mode, revision: capabilities.revision, readTool: capabilities.readTool }).length < 300;
  })).toBe(true);
  expect(service.store.getCompanion(owner)!.persona).toBe(persona);
});

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
  expect(service.store.listTasks(room.id)).toEqual([]);
});

it('closing a companion pauses its actual tasks before stopping native, freezes time and resumes only on explicit task control', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-capabilities-'));
  let workerRuns = 0, nativeStopped = false;
  const brain = new Brain(async input => {
    if (input.role === 'worker') {
      workerRuns++;
      if (workerRuns === 1) await new Promise<void>((resolve, reject) => {
        if (input.signal?.aborted) reject(input.signal.reason);
        else input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
      return '已完成原任务';
    }
    const body = JSON.parse(input.prompt);
    if (body.trigger.content === '执行任务') {
      const response = await call(input, { goal: '保持原目标完成测试', title: '伙伴关闭验收' }, 'task', 'dsh_task');
      expect(response.status).toBe(200);
    }
    return '任务已保存';
  });
  const service = new BotService({ root, brain, memory: new Memory(path.join(root, 'memory')), onEvent: () => undefined,
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }),
    companionRuntime: async (_id, _name, operation) => {
      if (operation === 'stop') { expect(service.store.listTasks()[0]?.status).toBe('paused'); nativeStopped = true; }
    } });
  cleanups.push(async () => { await service.shutdown(); if (path.dirname(root) !== os.tmpdir()) throw new Error('Unexpected temp root'); await rm(root, { recursive: true, force: true }); });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, room = snapshot.conversations[0]!, owner = room.memberIds.find(id => id !== 'user')!;
  await service.handle({ type: 'message.send', conversationId: room.id, content: '执行任务', requestId: 'work' });
  await waitFor(() => workerRuns === 1);
  const id = service.store.listTasks(room.id)[0]!.id;
  await service.handle({ type: 'companion.runtime', companionId: owner, operation: 'stop' });
  const frozen = service.store.getTask(id)!;
  expect(nativeStopped).toBe(true); expect(frozen).toMatchObject({ status: 'paused', extra: { userPaused: true } });
  expect(frozen.extra.timerStartedAt).toBeUndefined();
  await service.handle({ type: 'companion.runtime', companionId: owner, operation: 'start' });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(workerRuns).toBe(1); expect(service.store.getTask(id)?.status).toBe('paused');
  await service.handle({ type: 'task.control', conversationId: room.id, taskId: id, requestId: 'resume-original', operation: 'resume_paused' });
  await waitFor(() => service.store.getTask(id)?.status === 'succeeded');
  expect(workerRuns).toBe(2); expect(service.store.listTasks(room.id)).toHaveLength(1);
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
