import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionActivityTaskService } from '../../src/main/companions/activity-task-service';
const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', persona: '尊重实际结果', description: '', model: '', avatar: 'sister', proactive: true }];
let root: string, store: CompanionsStore, service: CompanionActivityTaskService | undefined;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-16T10:00:00Z'); root = mkdtempSync(path.join(tmpdir(), 'companion-agent-service-')); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds); });
afterEach(async () => { await service?.close(); service = undefined; store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-agent-service-')) throw new Error('Invalid cleanup'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function setup(fetchFn: typeof fetch) {
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const world = store.request({ type: 'world.snapshot' }).world!; store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '去自己的沙发坐一会儿，完成后告诉我。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'independent_goal', title: '坐到沙发', goal: source.content }).activityTask!;
  service = new CompanionActivityTaskService({ request: async input => store.request(input),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake-local-key', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn, excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  return { ...scope, task };
}
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
it('runs a native model planning loop, sleeps without model polling, then continues and reports without any new player message', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.purpose).toBe('activity_task_step'); expect(data.originalRequest.authorId).toBe('user');
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '先走到沙发' });
    if (data.task.step === 1) { expect(data.world.actors[0].route).toEqual([]); return response({ status: 'continue', action: { action: 'interact', furnitureId: 'alice_sofa', interaction: 'sit' }, wait: { kind: 'delay', seconds: 2 }, summary: '实际坐一会儿' }); }
    return response({ status: 'complete', action: null, wait: null, summary: '已经走到沙发并坐下休息了。' });
  });
  const scope = setup(fetchFn), get = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await service!.tick(); await vi.waitFor(() => expect(get().status).toBe('waiting'));
  for (let tick = 0; tick < 20; tick++) await service!.tick(); expect(fetchFn).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 20000); store.request({ type: 'world.tick' });
  await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(2)); expect(get().status).toBe('waiting');
  vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' }); await service!.tick();
  await vi.waitFor(() => expect(get().status).toBe('succeeded')); expect(fetchFn).toHaveBeenCalledTimes(3);
  const messages = store.request({ type: 'messages', conversationId: scope.conversationId, limit: 30 }).messages!;
  expect(messages.filter(message => message.content.includes('已经走到沙发并坐下'))).toHaveLength(1);
  expect(messages.filter(message => message.content === '去自己的沙发坐一会儿，完成后告诉我。')).toHaveLength(1);
});
it('rejects an in-flight result after cancellation, rather than dispatching its late movement', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn = vi.fn<typeof fetch>(() => pending), scope = setup(fetchFn);
  await service!.tick(); await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  store.request({ type: 'activity.cancel', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }); service!.cancel(scope.task.id);
  resolve(response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '旧规划' }));
  await service!.close();
  expect(store.request({ type: 'world.observe', companionId: scope.companionId, conversationId: scope.conversationId }).world!.actors[0]!.route).toHaveLength(0);
  expect(store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!.status).toBe('cancelled');
});
