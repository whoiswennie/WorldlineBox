import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { initializeCompanionAgenda } from '../../src/main/companions/agenda-bootstrap';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { parseCompanionReplyObservation } from '../../src/shared/companion-reply-observation-content';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { executeAgendaWorld } from '../../src/main/companions/agenda-world';
import { CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
import type { CompanionSocialJob } from '../../src/shared/companion-social';

let store: CompanionsStore, db: CompanionConnection, root: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-30T10:00:00.000Z');
  root = mkdtempSync(path.join(tmpdir(), 'social-agenda-receipt-')); const filename = path.join(root, 'state.sqlite');
  store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '根据实际来信回应。', model: '', avatar: 'sister', active: true, proactive: false })));
  db = new (Database as { new(filename: string): CompanionConnection })(filename);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
    store.request({ type: 'tasks.concurrency.set', companionId, limit: 1 });
  }
  advance(10000);
});
afterEach(() => {
  db.close(); store.close(); vi.useRealTimers();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('social-agenda-receipt-')) throw new Error('Invalid fixture cleanup');
  removeOwnedDirectorySync(root);
});
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function send(clientId = 'actual_incoming') {
  const room = store.openPrivate('bob'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请联系alice核对真实读书安排。', replyDirective: 'none' });
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['alice', 'bob'] }).socialConversation!;
  const command = { type: 'social.send' as const, companionId: 'bob', conversationId: peer.id, channel: 'phone' as const,
    content: '可以一起核对读书安排吗？', clientId, authorizationMessageId: source.id, agentSource: { conversationId: room.id, messageId: source.id } };
  expect(store.request(command).socialPending).toBe(true); advance(1300);
  return { command, peer };
}
const agenda = (owner = 'alice') => store.request({ type: 'agenda.read', companionId: owner, limit: 100 }).agenda!;
function claimIncoming() {
  const rule = agenda().rules.find(item => item.referenceVersion === 'world-native-v1')!;
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  const parent = { companionId: 'alice', agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken, id: rule.referenceId! };
  return { parent, job: store.request({ type: 'social.job.claim', ...parent }).socialJob! };
}

it('admits the exact incoming social job immediately through the real agenda claim while the minute poll is still in the future', async () => {
  const owner = store.request({ type: 'state', companionId: 'alice', includeConversations: false }).state!.companions[0]!;
  await initializeCompanionAgenda({ companion: owner, routine: { timeZone: 'UTC' }, request: async command => store.request(command), now: new Date() });
  const fallback = agenda().rules.find(rule => rule.referenceId === 'system_world_v1')!;
  expect(fallback.trigger).toMatchObject({ kind: 'interval', anchorAt: new Date(Date.now() + 60000).toISOString() });
  const { command } = send(); const delivered = store.request(command).socialMessage!;
  expect(delivered.message.authorId).toBe('bob');
  const registered = agenda().rules.filter(rule => rule.referenceVersion === 'world-native-v1');
  expect(registered).toHaveLength(1);
  const rule = registered[0]!;
  expect(rule).toMatchObject({ companionId: 'alice', sourceMessageId: delivered.message.id, protected: true, flexible: false,
    executor: 'world', conversationId: delivered.message.conversationId, trigger: { kind: 'at', at: new Date().toISOString(), repeat: 'once' } });
  const job = store.request({ type: 'social.job.read', companionId: 'alice', id: rule.referenceId! }).socialJob!;
  expect(job).toMatchObject({ status: 'pending', sourceMessageId: delivered.message.id, createdAt: rule.trigger.kind === 'at' ? rule.trigger.at : '' });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(claim.rule.id).toBe(rule.id); expect(claim.rule.id).not.toBe(fallback.id);
  expect(agenda().rules.find(item => item.id === rule.id)?.nextAt).toBeUndefined();
  const parent = { companionId: 'alice', agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken };
  expect(() => store.request({ type: 'social.job.claim', ...parent, id: 'another_job' })).toThrow('准确事件');
  const native = store.request({ type: 'social.job.claim', ...parent, id: job.id }).socialJob!;
  expect(native).toMatchObject({ id: job.id, sourceMessageId: delivered.message.id, status: 'running', agendaParentRunId: claim.run.id });
  expect(native.agendaInputVersion).toHaveLength(64);
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]!.active).toBe(1);
  expect(Date.now()).toBeLessThan(Date.parse(fallback.trigger.kind === 'interval' ? fallback.trigger.anchorAt : ''));
});

it('creates one once-only rule per actual delivery and does not create another task when the send receipt is reread', () => {
  const { command } = send(); const message = store.request(command).socialMessage!;
  const original = agenda().rules;
  expect(original).toHaveLength(1);
  expect(store.request(command).socialMessage?.message.id).toBe(message.message.id);
  expect(agenda().rules).toEqual(original);
  expect(agenda('bob').rules).toEqual([]);
  expect((db.prepare('SELECT count(*) AS n FROM companion_social_jobs').get() as { n: number }).n).toBe(1);
});

it('retains an exact once-only social opportunity when real FIFO defers it, then reclaims that same task promptly after the earlier user is admitted', async () => {
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 2 });
  const room = store.openPrivate('alice');
  const earlier = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '先处理这条更早到达的独立用户消息。', replyDirective: 'auto' });
  const user = store.request({ type: 'work.list', sourceMessageId: earlier.id }).works![0]!;
  expect(user.status).toBe('queued');
  const { command } = send(); store.request(command);
  const rule = agenda().rules.find(item => item.referenceVersion === 'world-native-v1')!;
  const original = store.request({ type: 'social.job.read', companionId: 'alice', id: rule.referenceId! }).socialJob!;
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  expect(claim.rule.id).toBe(rule.id);
  const request = vi.fn(async (input: Parameters<CompanionsStore['request']>[0]) => store.request(input)), fetchFn = vi.fn<typeof fetch>();
  const world = new CompanionWorldService({ request, fetchFn, configFor: vi.fn(), changed: () => undefined, wakeWaiting: () => undefined, report: vi.fn() });
  world.setAgendaDriven();
  try {
    const waiting = await executeAgendaWorld(claim, { checkpoint: async (stage, value) => {
      store.request({ type: 'agenda.run.checkpoint', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken,
        now: new Date().toISOString(), checkpoint: JSON.stringify(value), stage });
    }, effect: async (_key, _title, operation) => operation('unused_effect'), effectId: () => 'unused_effect', bindGrant: () => undefined },
    new AbortController().signal, { world });
    expect(waiting.outcome).toBe('waiting'); expect(Date.parse(waiting.notBefore!) - Date.now()).toBe(1000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.request({ type: 'social.job.read', companionId: 'alice', id: original.id }).socialJob).toMatchObject({ status: 'pending', attempts: 0, receivedState: original.receivedState });
    store.request({ type: 'agenda.run.settle', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken,
      now: new Date().toISOString(), ...waiting });
    expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('waiting');
    const admittedUser = store.request({ type: 'work.claim', companionId: 'alice', id: user.id }).work!;
    expect(admittedUser.status).toBe('running');
    advance(1100);
    const resumed = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
    expect(resumed.run.id).toBe(claim.run.id); expect(resumed.rule.id).toBe(rule.id);
    const actual = store.request({ type: 'social.job.claim', companionId: 'alice', id: original.id,
      agendaRunId: resumed.run.id, agendaLeaseToken: resumed.leaseToken }).socialJob!;
    expect(actual).toMatchObject({ id: original.id, sourceMessageId: original.sourceMessageId, status: 'running', attempts: 1, receivedState: original.receivedState });
    expect(store.request({ type: 'work.get', companionId: 'alice', id: user.id }).work!.status).toBe('running');
  } finally { await world.close(); }
});

it('rolls back delivery and the incoming job if its exact agenda event cannot be registered in the same receipt transaction', () => {
  const { command, peer } = send();
  db.exec("CREATE TRIGGER fixture_reject_social_agenda BEFORE INSERT ON companion_agenda_rules WHEN json_extract(NEW.data,'$.referenceVersion')='world-native-v1' BEGIN SELECT RAISE(ABORT,'fixture_agenda_unavailable'); END");
  expect(() => store.request(command)).toThrow('fixture_agenda_unavailable');
  expect((db.prepare('SELECT count(*) AS n FROM companion_social_jobs').get() as { n: number }).n).toBe(0);
  expect(agenda().rules).toEqual([]);
  expect(store.request({ type: 'social.messages', conversationId: peer.id }).socialMessagePage?.items).toEqual([]);
  db.exec('DROP TRIGGER fixture_reject_social_agenda');
  expect(store.request(command).socialMessage?.message.content).toBe(command.content);
  expect(agenda().rules).toHaveLength(1);
  expect((db.prepare('SELECT count(*) AS n FROM companion_social_jobs').get() as { n: number }).n).toBe(1);
});

it('keeps the receipt world/runtime byte-identical across clock ticks, retries and restart', () => {
  const { command } = send(); store.request(command);
  const rule = agenda().rules[0]!, received = store.request({ type: 'social.job.read', companionId: 'alice', id: rule.referenceId! }).socialJob!.receivedState!;
  expect(received.kind).toBe('received'); expect(received.capturedAt).toBe(new Date().toISOString());
  const fixed = parseCompanionReplyObservation(received, 'alice');
  advance(30000);
  expect(store.request({ type: 'world.observe', companionId: 'alice', conversationId: rule.conversationId! }).world!.clock.realNow).not.toBe(fixed.world.clock.realNow);
  const { parent, job } = claimIncoming(); expect(job.receivedState).toEqual(received);
  store.request({ type: 'social.job.defer', companionId: 'alice', id: job.id, leaseToken: job.leaseToken!, retryAfterMs: 1000, error: '发送前等待资源' });
  advance(1100);
  expect(store.request({ type: 'social.job.claim', ...parent }).socialJob!.receivedState).toEqual(received);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), []);
  expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.receivedState).toEqual(received);
});

it('backfills a legacy job once at its first preparation and keeps that observation during retries', () => {
  const { command } = send(); store.request(command); const rule = agenda().rules[0]!;
  db.prepare("UPDATE companion_social_jobs SET data=json_remove(data,'$.receivedState') WHERE id=?").run(rule.referenceId);
  advance(30000);
  const { parent, job } = claimIncoming();
  expect(job.receivedState).toMatchObject({ kind: 'preparation', capturedAt: new Date().toISOString() });
  store.request({ type: 'social.job.defer', companionId: 'alice', id: job.id, leaseToken: job.leaseToken!, retryAfterMs: 1000, error: '等待原任务资源' });
  advance(1100);
  expect(store.request({ type: 'social.job.claim', ...parent }).socialJob!.receivedState).toEqual(job.receivedState);
});

it('redacts source-backed receipt text monotonically after hard withdrawal without changing its original clock', () => {
  const ownerRoom = store.openPrivate('alice'), source = store.appendMessage({ conversationId: ownerRoom.id, authorId: 'user', content: '稍后将撤回的本人旧资料。', replyDirective: 'none' });
  const { command } = send(); store.request(command); const rule = agenda().rules[0]!;
  const job = store.request({ type: 'social.job.read', companionId: 'alice', id: rule.referenceId! }).socialJob!, snapshot = job.receivedState!;
  const parsed = parseCompanionReplyObservation(snapshot, 'alice'), secret = 'WITHDRAWN_SOCIAL_RECEIPT_419';
  parsed.world.actors.find(actor => actor.companionId === 'alice')!.activityLabel = secret;
  parsed.runtimeState.focus = secret;
  const seeded = { ...snapshot, worldJson: JSON.stringify(parsed.world), runtimeStateJson: JSON.stringify(parsed.runtimeState) };
  db.prepare("UPDATE companion_social_jobs SET data=json_set(data,'$.receivedState',json(?)) WHERE id=?").run(JSON.stringify(seeded), job.id);
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: ownerRoom.id, sourceMessageIds: [source.id] });
  const redacted = store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.receivedState!;
  expect(redacted.revocationEpoch).toBeGreaterThan(snapshot.revocationEpoch); expect(JSON.stringify(redacted)).not.toContain(secret);
  expect(parseCompanionReplyObservation(redacted, 'alice').world.clock).toEqual(parsed.world.clock);
  expect(redacted.capturedAt).toBe(snapshot.capturedAt);
  advance(2000);
  expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.receivedState).toEqual(redacted);
  const saved = JSON.parse((db.prepare('SELECT data FROM companion_social_jobs WHERE id=?').get(job.id) as { data: string }).data) as typeof job;
  expect(saved.receivedState).toEqual(redacted);
});

it('sends the receipt state through the actual agenda quantum and social processor even when recall advances the world clock', async () => {
  const { command } = send(); store.request(command); const rule = agenda().rules[0]!;
  const job = store.request({ type: 'social.job.read', companionId: 'alice', id: rule.referenceId! }).socialJob!;
  const received = parseCompanionReplyObservation(job.receivedState!, 'alice');
  advance(30000);
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 120000, limit: 1, excludedOwners: [] }).agendaClaim!;
  const request = vi.fn(async (input: Parameters<CompanionsStore['request']>[0]) => store.request(input)), report = vi.fn();
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data.purpose).toBe('world_social'); expect(data.world.clock.virtualNow).toBe(received.world.clock.virtualNow);
    expect(data.selfState.energy).toBe(received.runtimeState.energy);
    expect(data.routine.runtime.phase).toBe(received.runtimeState.routine!.phase);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: null, reason: '根据本条来信决定保持安静。' }) } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const recall = vi.fn(async (input: { queryClock?: { virtualNow: string } }) => {
    expect(input.queryClock?.virtualNow).toBe(received.world.clock.virtualNow); advance(12000);
    return { memories: [], sources: [], reasons: [], pending: false, degraded: false };
  });
  const world = new CompanionWorldService({ request, fetchFn, recall, configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'synthetic' }),
    changed: () => undefined, wakeWaiting: () => undefined, report });
  world.setAgendaDriven();
  try {
    const result = await executeAgendaWorld(claim, { checkpoint: async (stage, value) => {
      store.request({ type: 'agenda.run.checkpoint', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken,
        now: new Date().toISOString(), checkpoint: JSON.stringify(value), stage });
    }, effect: async (_key, _title, operation) => operation('fixture_effect'), effectId: () => 'fixture_effect', bindGrant: () => undefined },
    new AbortController().signal, { world });
    expect(result.outcome, JSON.stringify(report.mock.calls.map(([error]) => String(error)))).toBe('completed');
    expect(fetchFn).toHaveBeenCalledOnce(); expect(recall).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([input]) => input.type === 'world.observe' || input.type === 'state.get')).toBe(false);
    expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.receivedState).toEqual(job.receivedState);
  } finally { await world.close(); }
});

it('reuses the sealed social window, state, recall and profiles through a real tool step, admission retry and restart', async () => {
  const { command } = send(); store.request(command);
  const { parent, job } = claimIncoming();
  const received = parseCompanionReplyObservation(job.receivedState!, 'alice');
  const request = vi.fn(async (input: Parameters<CompanionsStore['request']>[0]) => store.request(input)), report = vi.fn();
  const recall = vi.fn(async () => ({ memories: [], sources: [], reasons: [], pending: false, degraded: false }));
  const profiles = vi.fn(async () => ({ publicProfiles: [], visualInputs: [] }));
  let dispatched = 0, admitted = 0, initialMessages = '';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(data.purpose).toBe('world_social');
    expect(data.world.clock.virtualNow).toBe(received.world.clock.virtualNow);
    expect(data.selfState.energy).toBe(received.runtimeState.energy);
    if (!dispatched++) {
      initialMessages = JSON.stringify(data.messages);
      store.appendMessage({ conversationId: job.conversationId, authorId: 'bob', content: 'NEW_MESSAGE_MUST_BE_ANOTHER_TASK', replyDirective: 'none' });
      advance(1500);
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'list_current_topics', type: 'function',
        function: { name: 'world', arguments: JSON.stringify({ action: 'topic', parameters: { action: 'list' } }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
    }
    expect(JSON.stringify(data.messages)).toBe(initialMessages);
    expect(String(init?.body)).not.toContain('NEW_MESSAGE_MUST_BE_ANOTHER_TASK');
    expect(body.messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'list_current_topics')).toBe(true);
    advance(20000); // Date is fake; finish the real typing gate before committing.
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: null, reason: '已读取真实工具回执，本条来信无需再回复。' }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const make = (first: boolean) => {
    const service = new CompanionWorldService({ request, fetchFn, recall, profiles, report,
      configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: first ? 'first-key' : 'new-live-key',
        providerLifecycle: { beforeDispatch: async () => {
          if (first && ++admitted === 2) throw new CompanionModelAdmissionError('configuration_unavailable', '等待真实模型资源恢复。', new Date(Date.now() + 1000).toISOString());
          return async () => undefined;
        } } }), changed: () => undefined, wakeWaiting: () => undefined });
    service.setAgendaDriven(); return service;
  };
  const process = (world: CompanionWorldService, input: CompanionSocialJob) => (world as unknown as {
    processSocial(job: CompanionSocialJob, signal: AbortSignal): Promise<void> }).processSocial(input, new AbortController().signal);
  const first = make(true);
  await process(first, job); await first.close();
  const pending = store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!;
  expect(pending.status, JSON.stringify(report.mock.calls.map(([error]) => String(error)))).toBe('pending');
  expect(pending.preparation).toBeDefined(); expect(pending.preparation).not.toContain('first-key');
  expect(dispatched).toBe(1); expect(recall).toHaveBeenCalledOnce(); expect(profiles).toHaveBeenCalledOnce();
  const initialReads = request.mock.calls.filter(([input]) => ['messages', 'routine.get', 'character.development', 'state.get', 'world.observe'].includes(input.type)).length;
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '新任务的新人格', model: '', avatar: 'sister', active: true, proactive: false })));
  advance(1100);
  const resumed = store.request({ type: 'social.job.claim', ...parent }).socialJob!;
  expect(resumed.preparation).toBe(pending.preparation);
  const second = make(false);
  try {
    await process(second, resumed);
    expect(store.request({ type: 'social.job.read', companionId: 'alice', id: job.id }).socialJob!.status,
      JSON.stringify(report.mock.calls.map(([error]) => String(error)))).toBe('done');
    expect(dispatched).toBe(2); expect(recall).toHaveBeenCalledOnce(); expect(profiles).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([input]) => ['messages', 'routine.get', 'character.development', 'state.get', 'world.observe'].includes(input.type))).toHaveLength(initialReads);
    expect(request.mock.calls.filter(([input]) => input.type === 'topic.list')).toHaveLength(1);
  } finally { await second.close(); }
});
