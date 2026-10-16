import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: id === 'alice' ? '安静友好，喜欢阅读。' : '坦率，尊重彼此边界。', description: '', model: '', avatar: 'sister', proactive: true }));
const stores = new Set<CompanionsStore>(), services = new Set<CompanionWorldService>(), roots: string[] = [];
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-14T02:00:00Z'); });
afterEach(async () => {
  for (const service of services) await service.close(); services.clear();
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture(fetchFn: typeof fetch, asleep = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-service-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds); stores.add(store);
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const scope of [alice, bob]) {
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: asleep ? '01:00' : '23:00', wakeAt: asleep ? '03:00' : '01:00', meals: [], habits: [] } });
  }
  const request = vi.fn(async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command));
  const service = new CompanionWorldService({ request, fetchFn, configFor: async () => ({ apiFormat: 'openai_chat', model: 'test-model', apiKey: 'private-key', baseUrl: 'https://provider.invalid' }),
    changed: vi.fn(), wakeWaiting: vi.fn(), report: vi.fn() }); services.add(service);
  return { store, service, alice, bob, request };
}
function advance(store: CompanionsStore, milliseconds: number) { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick' }).world!; }
function prepareDream(f: ReturnType<typeof fixture>) {
  const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: '这次先备份再修改，实际修复了聊天保存问题。', replyDirective: 'none' });
  const atom = f.store.request({ type: 'memory.record', ...f.alice, candidate: { kind: 'task', content: source.content, subject: 'alice', factKey: 'chat.fix',
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  advance(f.store, 10000); advance(f.store, 6000);
  return { source, atom };
}
function dreamResult(data: { messages: Array<{ id: string; content: string }>; relevantMemories: Array<{ id: string; kind: string }> }) {
  const source = data.messages.find(message => message.content.includes('实际修复了聊天保存问题'))!, atom = data.relevantMemories.find(memory => memory.kind === 'task')!;
  const common = { sourceMessageIds: [source.id], relatedMemoryIds: [atom.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
  const candidate: CompanionMemoryCandidate = { ...common, kind: 'knowledge', subject: 'alice', factKey: 'lesson.chat.backup', content: '这次聊天保存修复中先备份再修改保留了恢复入口；仅是本次实际经历的经验。' };
  return { candidates: [candidate], dream: { ...common, text: '梦中，我把聊天纸片整理好；这是实际修复经历的主观联想。' } };
}

describe('semantic world background service with actual SQLite sources', () => {
  it('automatically returns a committed delegated peer answer to its real human requester with proactive disabled', async () => {
    const purposes: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content); purposes.push(data.purpose);
      if (data.purpose === 'world_social') {
        expect(data.origin).toMatchObject({ initiatorId: 'user', initiatorKind: 'human_player', ownerId: 'alice' });
        expect(JSON.stringify(data)).not.toContain('PRIVATE_REQUEST_DETAIL'); expect(data.identity.currentReply.author.id).toBe(data.identity.self.id);
        return response({ text: data.identity.self.id === 'bob' ? '可以，等你一起看书。' : null, reason: '依据原玩家委托和实际来信。' });
      }
      if (data.purpose === 'world_social_notification') {
        expect(data.identity.currentReply.speaker.id).toBe('user'); expect(data.identity.currentReply.author.id).toBe('alice');
        expect(data.origin.initiatorId).toBe('user'); expect(data.confirmedEvent.evidence).toMatchObject({ authorId: 'bob', text: '可以，等你一起看书。' });
        expect(request.tools).toBeUndefined(); expect(JSON.stringify(data)).not.toContain('PRIVATE_REQUEST_DETAIL');
        return response({ text: 'Bob 回复说可以一起看书，我还没到他那里。', eventId: data.confirmedEvent.eventId, initiatorId: 'user' });
      }
      return response({ action: null, reason: '没有新的世界事项。', appraisals: [] });
    });
    const f = fixture(fetchFn, false); advance(f.store, 30000);
    f.store.updateCompanion('alice', { ...seeds[0]!, proactive: false });
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '去问Bob要不要一起看书。PRIVATE_REQUEST_DETAIL', replyDirective: 'none' });
    const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    f.store.request({ type: 'social.send', companionId: 'alice', conversationId: peer.id, authorizationMessageId: source.id, content: 'Bob，一起看书吗？', channel: 'phone', clientId: 'event_driven_delegation' });
    advance(f.store, 1300); await f.service.tick(); await vi.advanceTimersByTimeAsync(1300);
    await vi.waitFor(() => expect(f.store.request({ type: 'social.messages', conversationId: peer.id }).socialMessagePage!.items.some(item => item.message.authorId === 'bob'), JSON.stringify({ purposes, lastRequests: f.request.mock.calls.slice(-5).map(([command]) => command.type) })).toBe(true));
    await f.service.tick();
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.alice.conversationId }).messages.some(message => message.content === 'Bob 回复说可以一起看书，我还没到他那里。')).toBe(true));
    const result = f.store.messages({ conversationId: f.alice.conversationId }).messages.find(message => message.content === 'Bob 回复说可以一起看书，我还没到他那里。')!;
    expect(result).toMatchObject({ authorId: 'alice', replyToId: source.id }); expect(purposes).toContain('world_social_notification');
    expect(f.store.request({ type: 'actions' }).actions).toEqual([]);
  });
  it('lets a resident make a real semantic visit response without granting player tools or leaking private chat', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
      expect(data.purpose).toBe('world_decision'); expect(request.tools).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('PRIVATE_PLAYER_ADDRESS');
      expect(data.routine.config.habits[0]).toMatchObject({ kind: 'study', title: '学习活动' });
      expect(data.routine.habitProgress[0].id).toBe(data.routine.config.habits[0].id);
      expect(data.selfState.energy).toBeTypeOf('number'); expect(data.selfState.relationship).toBeUndefined(); expect(data.selfState.familiarity).toBeUndefined();
      const pending = data.world.visits.find((visit: { hostId: string; status: string }) => visit.hostId === data.companion.id && visit.status === 'requested');
      return response({ action: pending ? { action: 'respond', requestId: pending.id, decision: 'deny', reason: '今天想安静阅读，明天再聊。' } : null,
        reason: '根据自己当前需要表达真实边界。', appraisals: [] });
    });
    const f = fixture(fetchFn, false);
    f.store.appendMessage({ conversationId: f.bob.conversationId, authorId: 'user', content: 'PRIVATE_PLAYER_ADDRESS', replyDirective: 'none' });
    const routine = f.store.request({ type: 'routine.get', ...f.bob }).routine!;
    f.store.request({ type: 'routine.configure', ...f.bob, expectedRevision: routine.revision,
      patch: { habits: [{ id: 'private_interest', kind: 'study', title: 'PRIVATE_PLAYER_ADDRESS 的研究', at: '12:00', durationMinutes: 30 }] } });
    f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '想一起聊聊书。' } });
    await f.service.tick();
    await vi.waitFor(() => expect(f.store.request({ type: 'world.snapshot' }).world!.visits[0]?.status).toBe('denied'));
    expect(f.store.request({ type: 'world.snapshot' }).world!.visits[0]?.response).toBe('今天想安静阅读，明天再聊。');
    expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete' && command.action?.action === 'respond')).toBe(true);
  });

  it('commits a sleeping dream and conditional learned experience atomically, then withdraws both with the actual source', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => response(dreamResult(JSON.parse(JSON.parse(String(init?.body)).messages[1].content))));
    const f = fixture(fetchFn), { source } = prepareDream(f);
    await f.service.tick();
    await vi.waitFor(() => expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.kind === 'knowledge')).toBe(true));
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.record')).toBe(false);
    const completion = f.request.mock.calls.find(([command]) => command.type === 'world.job.complete' && command.memoryCandidates?.length)?.[0];
    expect(completion?.type === 'world.job.complete' && completion.memoryCandidates?.[0]?.sourceChecksums?.[source.id]).toMatch(/^[a-f0-9]{64}$/);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(true);
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.kind === 'knowledge')).toBe(false);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
  });

  it.each(['wake', 'forget'])('does not leave a learned fragment when %s invalidates a pending dream before its final commit', async invalidation => {
    let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); let output: ReturnType<typeof dreamResult> | undefined;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { output = dreamResult(JSON.parse(JSON.parse(String(init?.body)).messages[1].content)); return pending; });
    const f = fixture(fetchFn), { source } = prepareDream(f);
    await f.service.tick(); await vi.waitFor(() => expect(output).toBeDefined());
    if (invalidation === 'forget') f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
    else {
      const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
      f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision, patch: { sleepAt: '23:00', wakeAt: '01:00' } });
      f.store.request({ type: 'world.tick' });
    }
    resolve(response(output));
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.fail')).toBe(true));
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.kind === 'knowledge')).toBe(false);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
  });
});
