import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { buildCompanionContext } from '../../src/main/companions/context';
import { parseCompanionReplyObservation, withdrawCompanionReplyObservation } from '../../src/shared/companion-reply-observation-content';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { Companion } from '../../src/shared/companions';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));
let root: string, file: string, store: CompanionsStore;
const owner = { id: 'alice', name: 'Alice', description: '', persona: '认真处理每条独立任务。', model: '', avatar: 'sister', active: true, proactive: false } as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-30T00:40:00.000Z');
  root = mkdtempSync(path.join(tmpdir(), 'reply-observation-')); file = path.join(root, 'state.sqlite');
  store = new CompanionsStore(file, [owner]);
});
afterEach(() => { store.close(); vi.useRealTimers(); removeOwnedDirectorySync(root); });
function received(content = '早上好') {
  const room = store.openPrivate(owner.id), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content, replyDirective: 'queue' });
  const checkpoint = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: owner.id }).loop!;
  return { room, source, checkpoint, scope: { companionId: owner.id, conversationId: room.id, beforeSequence: source.sequence } };
}
function host() {
  const call = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command));
  const observe = vi.fn(async () => { throw new Error('A task must not observe the live world again'); });
  const configFor = vi.fn(async (configOwner: Companion) => { void configOwner;
    return { apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fixture' }; });
  const service = Object.assign(Object.create(CompanionService.prototype), { call, storage: { request: call }, world: { observe },
    requireCurrentAssets: async () => undefined, memory: { contextValid: async () => true }, options: { report: () => undefined },
    configFor,
    sourceValidationRevision: 0, evidenceRevision: 0, taskEvidenceCurrent: async () => true }) as {
      replyTaskState(checkpoint: CompanionLoopCheckpoint, scope: { companionId: string; conversationId: string; beforeSequence?: number }): Promise<ReturnType<typeof parseCompanionReplyObservation>>;
      memoryInference(checkpoint: CompanionLoopCheckpoint, owner: string, room: string, sequence: number): Promise<{ context: { system: string; user: string }; turns: unknown[]; topicReviewFrame?: { topicState?: CompanionStorageResponse['topicState'] } }>;
    };
  return { service, call, observe, configFor };
}

it('captures state atomically with receipt, survives restart, and a new task observes its own receipt', () => {
  const first = received(), fixed = first.checkpoint.receivedState!;
  expect(fixed.kind).toBe('received'); expect(fixed.capturedAt).toBe(first.source.createdAt);
  vi.setSystemTime('2026-10-30T00:41:00.000Z'); store.request({ type: 'world.status', companionIds: [owner.id] });
  store.close(); store = new CompanionsStore(file, [owner]);
  const restored = store.request({ type: 'loop.get', sourceMessageId: first.source.id, companionId: owner.id }).loop!;
  expect(restored.receivedState).toEqual(fixed);
  const second = received('新的独立消息');
  expect(Date.parse(second.checkpoint.receivedState!.capturedAt)).toBeGreaterThan(Date.parse(fixed.capturedAt));
  expect(store.request({ type: 'loop.get', sourceMessageId: first.source.id, companionId: owner.id }).loop?.receivedState).toEqual(fixed);
});

it('keeps the same task state after completed tools and rejects stale progress replacing its sealed snapshot', async () => {
  const f = received(), fixed = f.checkpoint.receivedState!, h = host();
  const first = await h.service.replyTaskState(f.checkpoint, f.scope);
  vi.setSystemTime('2026-10-30T01:40:00.000Z');
  f.checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'history_call', name: 'history', arguments: '{}' }], results: [{ callId: 'history_call', content: '{"ok":true,"messages":[]}' }] });
  const second = await h.service.replyTaskState(f.checkpoint, f.scope);
  expect(second.world.clock).toEqual(first.world.clock); expect(second.runtimeState).toEqual(first.runtimeState); expect(h.observe).not.toHaveBeenCalled();
  f.checkpoint.preparedTask = '{"sealed":"initial task"}'; expect(store.request({ type: 'loop.save', checkpoint: f.checkpoint }).ok).toBe(true);
  const stale = structuredClone(f.checkpoint); delete stale.receivedState; delete stale.preparedTask;
  expect(store.request({ type: 'loop.save', checkpoint: stale }).ok).toBe(true);
  const restored = store.request({ type: 'loop.get', sourceMessageId: f.source.id, companionId: owner.id }).loop!;
  expect(restored.receivedState).toEqual(fixed); expect(restored.preparedTask).toBe(f.checkpoint.preparedTask);
  expect(() => store.request({ type: 'loop.save', checkpoint: { ...restored, preparedTask: '{"replaced":true}' } })).toThrow('任务初始上下文已封存');
});

it('reuses prepared messages and state after a tool without rereading the sliding window or background state', async () => {
  const f = received(), h = host(), companion = store.request({ type: 'state' }).state!.companions.find(role => role.id === owner.id)!;
  f.checkpoint.context = buildCompanionContext({ companion, conversation: f.room, messages: [f.source], sourceMessage: f.source, memories: [], agentLoop: true,
    taskRequest: { sourceMessageId: f.source.id, prompt: f.source.content } });
  f.checkpoint.preparedTask = JSON.stringify({ companion: { ...companion,
    llm: { apiFormat: 'openai_chat', model: 'old_model', baseUrl: 'https://old-provider.invalid' } }, conversation: f.room, members: [] });
  expect(store.request({ type: 'loop.save', checkpoint: f.checkpoint }).ok).toBe(true);
  vi.setSystemTime('2026-10-30T00:42:00.000Z');
  store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: 'LATER_TASK_MUST_STAY_OUT', replyDirective: 'none' });
  store.updateCompanion(owner.id, { ...owner, llm: { apiFormat: 'openai_chat', model: 'current_model', baseUrl: 'https://current-provider.invalid' } });
  f.checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'history_call', name: 'history', arguments: '{}' }], results: [{ callId: 'history_call', content: '{"ok":true,"messages":[]}' }] });
  const inference = await h.service.memoryInference(f.checkpoint, owner.id, f.room.id, f.source.sequence);
  expect(inference.turns).toHaveLength(1); expect(inference.context.user).toContain(f.source.content);
  expect(inference.context.user).not.toContain('LATER_TASK_MUST_STAY_OUT');
  expect(JSON.parse(inference.context.user).world.clock.virtualNow).toBe(parseCompanionReplyObservation(f.checkpoint.receivedState!, owner.id).world.clock.virtualNow);
  expect(h.call.mock.calls.map(([command]) => command.type)).not.toEqual(expect.arrayContaining(['messages', 'state.get', 'character.development', 'actions.ongoing']));
  expect(h.observe).not.toHaveBeenCalled();
  expect(h.configFor.mock.calls[0]?.[0].llm?.baseUrl).toBe('https://current-provider.invalid');
});

it('stops a sealed story task after a newer formal publication instead of repeatedly reviewing its stale final', async () => {
  const f = received(), h = host(), companion = store.request({ type: 'state' }).state!.companions.find(role => role.id === owner.id)!;
  const topic = store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'user', title: '测试故事', kind: 'story' }).topic!;
  store.request({ type: 'topic.join', conversationId: f.room.id, topicId: topic.id, readerId: owner.id });
  const view = store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: owner.id });
  f.checkpoint.context = buildCompanionContext({ companion, conversation: f.room, messages: [f.source], sourceMessage: f.source, memories: [], agentLoop: true });
  f.checkpoint.preparedTask = JSON.stringify({ companion, conversation: f.room, members: [],
    topicReviewFrame: { companion, conversation: f.room, topic: view.topic, topicState: view.topicState, messages: [f.source], sourceMessage: f.source } });
  expect(store.request({ type: 'loop.save', checkpoint: f.checkpoint }).ok).toBe(true);
  store.appendMessage({ conversationId: f.room.id, topicId: topic.id, authorId: 'user', content: '新的正式故事输入', replyDirective: 'none' });
  await expect(h.service.memoryInference(f.checkpoint, owner.id, f.room.id, f.source.sequence)).rejects.toThrow('旧任务停止复审');
  expect(h.call.mock.calls.filter(([command]) => command.type === 'topic.read')).toHaveLength(1);
  expect(h.configFor).not.toHaveBeenCalled();
});

it.each(['topic', 'world'] as const)('allows this task own confirmed %s topic update to advance review state while keeping its initial model input sealed', async tool => {
  const f = received(), h = host(), companion = store.request({ type: 'state' }).state!.companions.find(role => role.id === owner.id)!;
  const topic = store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'user', title: '本任务故事', kind: 'story' }).topic!;
  store.request({ type: 'topic.join', conversationId: f.room.id, topicId: topic.id, readerId: owner.id });
  const input = store.appendMessage({ conversationId: f.room.id, topicId: topic.id, authorId: 'user', content: '记录已完成第一步。', replyDirective: 'none' });
  const view = store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: owner.id });
  f.checkpoint.context = buildCompanionContext({ companion, conversation: f.room, messages: [f.source], sourceMessage: f.source, memories: [], agentLoop: true });
  f.checkpoint.preparedTask = JSON.stringify({ companion, conversation: f.room, members: [],
    topicReviewFrame: { companion, conversation: f.room, topic: view.topic, topicState: view.topicState, messages: [input], sourceMessage: input } });
  const patch = { workingState: { state: { step: 'done' }, sourceMessageIds: [input.id] } };
  const updated = store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: owner.id, expectedRevision: view.topic!.revision, patch });
  expect(updated.ok).toBe(true);
  const parameters = { action: 'update', topicId: topic.id, expectedRevision: view.topic!.revision, patch };
  f.checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'own_update', name: tool,
    arguments: JSON.stringify(tool === 'world' ? { action: 'topic', parameters } : parameters) }],
    results: [{ callId: 'own_update', content: JSON.stringify(updated) }] });
  expect(store.request({ type: 'loop.save', checkpoint: f.checkpoint }).ok).toBe(true);
  const inference = await h.service.memoryInference(f.checkpoint, owner.id, f.room.id, f.source.sequence);
  expect(inference.turns).toHaveLength(1);
  expect(inference.topicReviewFrame?.topicState?.workingState?.state).toEqual({ step: 'done' });
  expect(JSON.parse(inference.context.user).topicState).toBeUndefined();
  expect(JSON.parse(f.checkpoint.preparedTask).topicReviewFrame.topicState.workingState).toBeUndefined();
});

it('allows only source-withdrawal redaction and an old callback cannot restore removed snapshot text', () => {
  const f = received(), snapshot = f.checkpoint.receivedState!, parsed = parseCompanionReplyObservation(snapshot, owner.id);
  const secret = 'WITHDRAWN_TASK_LABEL_479';
  parsed.world.actors.find(actor => actor.companionId === owner.id)!.activityLabel = secret;
  parsed.runtimeState.focus = secret;
  // Use a separate unqueued host checkpoint to model a receipt carrying claims.
  const source = store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: secret, replyDirective: 'none' });
  const checkpoint: CompanionLoopCheckpoint = { companionId: owner.id, conversationId: f.room.id, sourceMessageId: source.id, status: 'running', turns: [], supplements: [],
    receivedState: { ...snapshot, worldJson: JSON.stringify(parsed.world), runtimeStateJson: JSON.stringify(parsed.runtimeState) } };
  expect(store.request({ type: 'loop.save', checkpoint }).ok).toBe(true);
  const original = structuredClone(checkpoint);
  expect(store.request({ type: 'memory.forget', companionId: owner.id, conversationId: f.room.id, sourceMessageIds: [source.id] }).ok).toBe(true);
  const epoch = store.request({ type: 'memory.lifecycle.state', companionId: owner.id }).memoryLifecycleState!.revocationEpoch;
  const redacted = withdrawCompanionReplyObservation(checkpoint.receivedState!, owner.id, epoch);
  expect(JSON.stringify(redacted)).not.toContain(secret);
  expect(store.request({ type: 'loop.save', checkpoint: { ...checkpoint, receivedState: redacted } }).ok).toBe(true);
  expect(store.request({ type: 'loop.save', checkpoint: original }).ok).toBe(true);
  const restored = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: owner.id }).loop!;
  expect(restored.receivedState).toEqual(redacted);
  expect(parseCompanionReplyObservation(redacted, owner.id).world.clock).toEqual(parsed.world.clock);
});
