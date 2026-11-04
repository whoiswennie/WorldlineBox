import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotDshBrain, type BotDshRun, type BotDshCancelAck } from '../../src/main/companion-bot/dsh-brain';
import { botLaneWorkdir } from '../../src/main/companion-bot/retention';
import { removeManagedChild } from '../../src/main/companion-bot/development-cleanup';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
class Memory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No actual VCP process in migration test'); }, embedding: async () => { throw Error('No encoder'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, inputHash: 'fixture', status: 'ready', messages: input.messages, metadata: {}, events: [], evidence: '', omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async withdrawnSources() { return { revision: '0', sourceMessageIds: [], sourceEventIds: [] }; }
}
class Brain extends BotDshBrain {
  stops: string[] = [];
  runs: string[] = [];
  constructor(private readonly absent: boolean) { super({ getHost: async () => { throw Error('No actual native Host or model in migration test'); } }); }
  override async run(input: BotDshRun) { this.runs.push(input.laneId); return { eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), status: 'succeeded' as const,
    text: input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : '已收到', inputContextCommitted: true }; }
  override async cancelDurable(input: Omit<BotDshRun, 'prompt' | 'onEvent'>): Promise<BotDshCancelAck> { this.stops.push(input.laneId); return { accepted: true, ...(this.absent ? { absent: true } : {}) }; }
  override async close() {}
}
const fixtures: Array<{ root: string; services: BotService[] }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const service of fixture.services) await service.shutdown();
    if (path.dirname(path.resolve(fixture.root)) !== path.resolve(tmpdir()) || !path.basename(fixture.root).startsWith('wlb-default-cleanup-')) throw Error('Invalid fixture cleanup path');
    await rm(fixture.root, { recursive: true, force: true });
  }
});
async function waitFor(check: () => boolean, timeout = 7000) {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw Error('Cleanup condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function marked(directory: string) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'owned.txt'), directory); return directory; }

it('keeps an unknown retired native lane quarantined across restart and erases only its own development data after proof', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-default-cleanup-')), owner = { root, services: [] as BotService[] }; fixtures.push(owner);
  const store = new BotStore(path.join(root, 'bot.sqlite'));
  store.createCompanion({ id: 'default-companion', name: '小伴', persona: '要移除的开发默认' });
  store.createCompanion({ id: 'custom', name: '用户自建', persona: '必须保留' });
  const old = store.openDirect('default-companion'), custom = store.openDirect('custom');
  const mixed = store.createGroup({ title: '保留的混合群', memberIds: ['default-companion', 'custom'] });
  const oldEvent = store.enqueue({ conversationId: old.id, senderId: 'user', sourceMessageId: 'unknown-old', content: '旧开发数据' }).events[0]!;
  const claim = store.claim({ workerId: 'previous-process' })!;
  store.bindEventNativeEpoch(oldEvent.id, 1);
  store.trackNativeAdmission({ eventId: oldEvent.id, epoch: 1, nativeLaneId: oldEvent.laneId, system: '旧身份', cwd: botLaneWorkdir(root, oldEvent.laneId), inputBytes: 12 });
  store.markDispatched(oldEvent.id, claim.leaseToken, oldEvent.id); store.requeue(oldEvent.id, claim.leaseToken);
  const oldTask = store.createTask({ conversationId: old.id, companionId: 'default-companion', sourceEventId: oldEvent.id, goal: '旧native任务', extra: { nativeAttempted: true, workerAccess: 'full' } });
  const customSource = store.enqueue({ conversationId: mixed.id, senderId: 'user', sourceMessageId: 'keep-mixed', recipientIds: ['custom'], content: '混合群用户原文必须保留' }).events[0]!;
  const customTask = store.createTask({ conversationId: mixed.id, companionId: 'custom', sourceEventId: customSource.id, goal: '保留的用户任务' });
  store.updateTask(customTask.id, { status: 'waiting' });
  const oldLaneDir = await marked(botLaneWorkdir(root, oldEvent.laneId));
  const oldTaskDir = await marked(path.join(root, 'workspaces', sha(old.securityDomainId), oldTask.id));
  const keepTaskDir = await marked(path.join(root, 'workspaces', sha(mixed.securityDomainId), customTask.id));
  const memoryRoot = path.join(root, 'memory');
  const oldMemory = await marked(path.join(memoryRoot, sha(JSON.stringify(['default-companion', old.securityDomainId]))));
  const oldMixedMemory = await marked(path.join(memoryRoot, sha(JSON.stringify(['default-companion', mixed.securityDomainId]))));
  const customMemory = await marked(path.join(memoryRoot, sha(JSON.stringify(['custom', mixed.securityDomainId]))));
  const customBefore = store.getTask(customTask.id), mixedBefore = store.getConversation(mixed.id)!;
  store.close();
  const open = (brain: Brain) => {
    const service = new BotService({ root, brain, memory: new Memory(memoryRoot), model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1', model: 'fixture', apiKey: 'fixture' }), onEvent: () => undefined });
    owner.services.push(service); return service;
  };
  const uncertain = new Brain(false), first = open(uncertain);
  const initial = (await first.handle({ type: 'state' })).snapshot!;
  await waitFor(() => uncertain.stops.length >= 2);
  expect(initial.companions.some(companion => companion.id === 'default-companion')).toBe(false);
  expect(initial.conversations.some(conversation => conversation.id === old.id)).toBe(false);
  expect(initial.companions.some(companion => companion.id === DEFAULT_BOT_COMPANION_ID)).toBe(true);
  expect(first.store.developmentDefaultCleanup()?.phase).toBe('retiring'); expect(existsSync(oldTaskDir)).toBe(true); expect(existsSync(oldMemory)).toBe(true);
  expect(uncertain.runs.some(laneId => laneId === oldEvent.laneId || laneId === `worker-${oldTask.id}`)).toBe(false);
  await first.shutdown();
  const proven = new Brain(true), resumed = open(proven); await resumed.handle({ type: 'state' });
  await waitFor(() => resumed.store.developmentDefaultCleanup()?.phase === 'complete');
  expect(resumed.store.getCompanion('default-companion')).toBeUndefined(); expect(resumed.store.getEvent(oldEvent.id)).toBeUndefined(); expect(resumed.store.getTask(oldTask.id)).toBeUndefined();
  for (const target of [oldLaneDir, oldTaskDir, oldMemory, oldMixedMemory]) expect(existsSync(target)).toBe(false);
  expect(existsSync(keepTaskDir)).toBe(true); expect(existsSync(customMemory)).toBe(true);
  expect(resumed.store.getCompanion('custom')).toMatchObject({ name: '用户自建', persona: '必须保留' });
  expect(resumed.store.getConversation(custom.id)).toBeDefined();
  expect(resumed.store.getConversation(mixed.id)).toMatchObject({ revision: mixedBefore.revision, securityDomainId: mixedBefore.securityDomainId, memberIds: ['custom', 'user'] });
  expect(resumed.store.getTask(customTask.id)).toEqual(customBefore);
  expect(resumed.store.getMessage(customSource.sourceMessageRecordId)?.content).toBe('混合群用户原文必须保留');
}, 15000);

it('rejects recursive deletion outside the named managed root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-default-cleanup-')); fixtures.push({ root, services: [] });
  const keep = await marked(path.join(root, 'keep'));
  await expect(removeManagedChild(path.join(root, 'owned'), keep)).rejects.toThrow('不在指定资料目录');
  await expect(removeManagedChild(root, root)).rejects.toThrow('不在指定资料目录'); expect(existsSync(keep)).toBe(true);
});
