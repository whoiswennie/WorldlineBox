import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { buildCompanionContext } from '../../src/main/companions/context';
import { generateCompanionReply } from '../../src/main/companions/model';
import { companionPerceivedToolTurns } from '../../src/main/companions/world-perception-context';
import { sampleCompanionWorldPerception } from '../../src/shared/companion-world-perception';

const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined,
  fetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (...args: Parameters<typeof fetch>) => transport.fetch(...args) }, dialog: {}, ipcMain: { handle: () => undefined },
  protocol: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (value: Buffer) => value.toString() } }));
const response = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });

it('continues past 64 saved brain steps, restarts the real service/store and finishes the same goal with bounded provider history', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-long-goal-')), file = path.join(root, 'companions/messages.sqlite');
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-long-goal-')) throw new Error('Unexpected fixture');
  let store = new CompanionsStore(file, [{ id: 'alice', name: 'Alice', description: '', persona: '认真核验自己的目标，不冒充他人。', model: '', avatar: 'sister', active: true, proactive: false }]);
  let service: CompanionService | undefined, issued = 0, blocked = false, restarted = false, summaries = 0;
  let lastSlot: string | undefined;
  const historySizes: number[] = [], calls: string[] = [], errors: string[] = [];
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  vi.spyOn(CompanionMemoryService.prototype, 'recall').mockResolvedValue({ memories: [], sources: [], reasons: [], pending: false, degraded: false });
  vi.spyOn(CompanionMemoryService.prototype, 'contextValid').mockResolvedValue(true);
  vi.spyOn(CompanionMemoryService.prototype, 'schedule').mockImplementation(() => undefined);
  vi.spyOn(CompanionWorldService.prototype, 'ready').mockResolvedValue();
  vi.spyOn(CompanionWorldService.prototype, 'end').mockResolvedValue();
  transport.request = async command => {
    if (command.type === 'loop.save' && command.checkpoint.invocationKey) lastSlot = command.checkpoint.invocationKey;
    return store.request(command);
  };
  transport.fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), context = JSON.parse(body.messages[1].content);
    if (context.purpose === 'companion_loop_compaction') { summaries++; return response({ summary: `已完成至真实步骤${context.throughTurn}，继续同一目标，未完成剩余检查。`, stage: '逐步核验' }); }
    if (context.purpose === 'world_attention') return response({ urgency: 'ordinary', confidence: .95, evidence: [context.source.content], reason: '按明确当前委托处理。' });
    if (context.purpose === 'world_decision') return response({ action: null, reason: '没有需要打扰的事件。', appraisals: [] });
    if (context.purpose === 'vcp_experience_journal') return response({ notes: [] });
    if (context.invocation?.kind !== 'work') return response({ text: '本次没有其他任务。' });
    historySizes.push(body.messages.filter((message: { role: string }) => message.role === 'assistant').length);
    expect(context.invocation.companionId).toBe('alice'); expect(context.invocation.conversationId).toBe(scope.conversationId);
    if (!restarted && issued === 70) {
      blocked = true;
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('test provider request aborted')), { once: true }));
    }
    if (issued >= 85) return response({ text: '已完成本次85个真实主脑检查步骤，没有执行其他聊天的目标。' });
    const id = 'check_' + issued++; calls.push(id);
    return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: {
      name: 'world', arguments: JSON.stringify({ action: 'state', parameters: { action: 'inspect' } }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const open = () => new CompanionService({ userData: root, workerPath: 'in-process-test-port', window: () => undefined, hasConfig: () => true,
    getConfig: () => ({ apiFormat: 'openai_chat', model: 'fixture-model', baseUrl: 'https://provider.invalid', apiKey: 'synthetic-test-key' }),
    dsh: () => undefined, report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) {
    if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));
  } throw new Error('Long goal did not reach expected checkpoint: ' + JSON.stringify({ issued, errors })); };
  try {
    service = open();
    const order = (await service.handle({ type: 'work-order.create', ...scope, title: '长目标持续核验',
      instruction: '请连续推进本次85个检查步骤，自行调用世界状态核验；只完成本工作，不添加其他任务。', clientId: 'long_goal' })).workOrder!;
    await until(() => blocked);
    expect(issued).toBe(70); expect(lastSlot).toBeTruthy();
    const before = store.request({ type: 'loop.get', sourceMessageId: order.sourceMessageId, companionId: 'alice', invocationKey: lastSlot }).loop!;
    expect(before.turns).toHaveLength(70); expect(before.workingState?.throughTurn).toBeGreaterThan(0);
    await service.shutdown(); service = undefined; store.close();
    store = new CompanionsStore(file, []); restarted = true; service = open();
    await until(() => store.request({ type: 'work-order.list', ...scope, includeHistory: true }).workOrderPage?.items[0]?.status === 'completed');
    const after = store.request({ type: 'loop.get', sourceMessageId: order.sourceMessageId, companionId: 'alice', invocationKey: lastSlot }).loop!;
    expect(after.status).toBe('done'); expect(after.turns).toHaveLength(86); expect(after.turns.slice(0, 70)).toEqual(before.turns);
    expect(after.turns.flatMap(turn => turn.calls.map(call => call.id))).toEqual(Array.from({ length: 85 }, (_, index) => 'check_' + index));
    expect(new Set(calls).size).toBe(85); expect(summaries).toBeGreaterThan(1); expect(Math.max(...historySizes)).toBeLessThanOrEqual(32);
    expect(errors).toEqual([]);
  } finally { await service?.shutdown(); store.close(); vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true }); }
}, 60000);

it('summarizes only legal world history and leaves the retained provider tail for exactly one visibility projection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-long-goal-'));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-long-goal-')) throw new Error('Unexpected fixture');
  const store = new CompanionsStore(path.join(root, 'companions/messages.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '认真核验自己的目标。', model: '', avatar: 'sister', active: true, proactive: false }]);
  let service: CompanionService | undefined;
  vi.spyOn(CompanionMemoryService.prototype, 'contextValid').mockResolvedValue(true);
  vi.spyOn(CompanionMemoryService.prototype, 'schedule').mockImplementation(() => undefined);
  transport.request = async command => store.request(command);
  try {
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '核对本次世界观察，不执行其他任务。', replyDirective: 'none' });
    const companion = store.request({ type: 'state' }).state!.companions.find(role => role.id === 'alice')!;
    const world = store.request({ type: 'world.snapshot' }).world!;
    const home = world.scenes.find(scene => scene.ownerId === 'alice')!, object = home.objects[0]!;
    const self = world.actors.find(actor => actor.companionId === 'alice')!;
    self.activity = 'idle'; self.routinePhase = 'awake'; self.position = { ...object.position }; self.sceneId = home.id;
    world.perception = sampleCompanionWorldPerception({ self, actors: world.actors, scenes: world.scenes,
      environment: { weather: 'clear', light: 1, outdoorTemperature: 20, indoorTemperature: 21, daylight: true },
      virtualAt: world.clock.virtualNow, realAt: world.clock.realNow });
    expect(world.perception.visibleObjectIds).toContain(object.id);
    const rawWorld = { ...world, globalSecretNeverVisible: 'GLOBAL_RAW_SECRET_440' };
    const turns = Array.from({ length: 40 }, (_, index) => ({ text: '', rawText: '', calls: [{ id: 'world_' + index, name: 'world', arguments: '{"action":"inspect"}' }],
      results: [{ callId: 'world_' + index, content: JSON.stringify({ ok: true, world: rawWorld }) }] }));
    const once = companionPerceivedToolTurns(turns, 'alice'), twice = companionPerceivedToolTurns(once, 'alice');
    expect(JSON.parse(once[0]!.results![0]!.content).world.perception.objects.some((value: { id: string }) => value.id === object.id)).toBe(true);
    expect(JSON.parse(twice[0]!.results![0]!.content).world.perception.objects).toEqual([]);
    const frame = { companion, conversation, messages: [source], sourceMessage: source, memories: [], world, agentLoop: true,
      taskRequest: { sourceMessageId: source.id, prompt: source.content } };
    const bubble = store.appendMessage({ conversationId: conversation.id, authorId: 'alice', content: '', loopStep: 0 });
    const checkpoint: CompanionLoopCheckpoint = { ...scope, sourceMessageId: source.id, messageId: bubble.id, status: 'running', turns, supplements: [], context: buildCompanionContext(frame) };
    store.request({ type: 'loop.save', checkpoint });
    const summarized: string[] = [];
    transport.fetch.mockImplementation(async (_url, init) => {
      const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (context.purpose === 'companion_loop_compaction') { summarized.push(JSON.stringify(context)); return response({ summary: '过去观察到本人的家具；不表示当前仍如此。', stage: '历史核验' }); }
      return response({ action: null, reason: '没有其他事件。', appraisals: [] });
    });
    const config = { apiFormat: 'openai_chat' as const, model: 'fixture-model', baseUrl: 'https://provider.invalid', apiKey: 'synthetic-test-key' };
    service = new CompanionService({ userData: root, workerPath: 'in-process-test-port', window: () => undefined, hasConfig: () => true, getConfig: () => config, dsh: () => undefined, report: () => undefined });
    const inference = await (service as unknown as { memoryInference(checkpoint: CompanionLoopCheckpoint, owner: string, room: string, sequence: number): Promise<{ context: { system: string; user: string }; turns: typeof turns }> }).memoryInference(checkpoint, 'alice', conversation.id, source.sequence);
    expect(summarized.length).toBeGreaterThan(0); expect(summarized.join('\n')).not.toContain('GLOBAL_RAW_SECRET_440');
    expect(summarized.join('\n')).toContain(object.id);
    expect(inference.turns[0]!.results[0]!.content).toContain('GLOBAL_RAW_SECRET_440');
    let captured = '';
    await generateCompanionReply(frame, config, undefined, { loop: true, context: inference.context, turns: inference.turns,
      fetchFn: async (_url, init) => { captured = String(init?.body); return response({ text: '旧记录属于历史，需要时重新观察。' }); } });
    expect(captured).not.toContain('GLOBAL_RAW_SECRET_440');
    const tool = JSON.parse(captured).messages.findLast((message: { role: string; content: string }) => message.role === 'tool' && JSON.parse(message.content).world);
    expect(JSON.parse(tool.content).world.perception.objects.some((value: { id: string }) => value.id === object.id)).toBe(true);
  } finally { await service?.shutdown(); store.close(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
