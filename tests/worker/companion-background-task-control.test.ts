import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionStorageCommandSchema, companionStorageResponseSchema } from '../../src/shared/companion-storage';
import type { CompanionWorldJob } from '../../src/shared/companion-world';
import { CompanionWorldStore } from '../../src/companions/world-store';
import { defaultCompanionRoutineConfig } from '../../src/shared/companion-routine-time';
import { createHash } from 'node:crypto';

const Database = BetterSqlite3 as { new(file: string): CompanionConnection };
const at = '2026-10-26T08:00:00.000Z', stop = { actor: 'user' as const, reason: 'user_requested' as const, requestedAt: at };
let root: string, file: string, store: CompanionsStore;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  root = mkdtempSync(path.join(tmpdir(), 'companion-background-control-')); file = path.join(root, 'messages.sqlite');
  store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真友好', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
});
afterEach(() => { store.close(); const owned = path.resolve(root); if (path.dirname(owned) !== path.resolve(tmpdir()) || !path.basename(owned).startsWith('companion-background-control-')) throw Error('Unexpected fixture cleanup'); rmSync(owned, { recursive: true, force: true }); vi.useRealTimers(); });
function db<T>(operation: (connection: CompanionConnection) => T): T { const connection = new Database(file); try { return operation(connection); } finally { connection.close(); } }
function data(table: string, id: string) { return db(connection => JSON.parse((connection.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string }).data)); }

it('stops only the owned world job, releases its meeting, revokes the lease and cannot reclaim or complete it', () => {
  const room = store.openPrivate('alice').id;
  const job: CompanionWorldJob = { id: 'world_selected', kind: 'decision', companionId: 'alice', conversationId: room, status: 'running', leaseToken: 'old_world_lease', createdAt: at, throughEventSequence: 0, attempts: 1, sourceMemoryIds: [] };
  db(connection => {
    for (const entry of [job, { ...job, id: 'world_other', companionId: 'bob', conversationId: store.openPrivate('bob').id, leaseToken: 'other_lease' }]) connection.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,lease_until,data) VALUES(?,?,?,?,?,?)').run(entry.id, entry.companionId, entry.kind, entry.status, '2026-10-26T08:10:00.000Z', JSON.stringify(entry));
    const state = JSON.parse((connection.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data);
    state.actors.find((actor: { companionId: string }) => actor.companionId === 'alice').meetingHold = { jobId: job.id, memberIds: ['alice', 'bob'], untilReal: Date.now() + 60000 };
    connection.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(state));
  });
  expect(() => store.request({ type: 'task-control.stop', companionId: 'bob', kind: 'world', id: job.id, stop })).toThrow('不属于');
  const response = store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'world', id: job.id, stop });
  expect(companionStorageResponseSchema.safeParse(response).success).toBe(true);
  expect(response.taskControl).toMatchObject({ stopped: true, companionId: 'alice', kind: 'world', id: job.id });
  expect(data('companion_world_jobs', job.id)).toMatchObject({ status: 'done', terminal: true, stop, finishedAt: at });
  expect(data('companion_world_jobs', job.id).leaseToken).toBeUndefined(); expect(data('companion_world_jobs', 'world_other').status).toBe('running');
  const state = db(connection => JSON.parse((connection.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data));
  expect(state.actors.find((actor: { companionId: string }) => actor.companionId === 'alice').meetingHold).toBeUndefined();
  expect(() => store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken! })).toThrow('租约');
  expect(store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: 'late abort' }).ok).toBe(true);
  expect(data('companion_world_jobs', job.id).error).toBeUndefined();
  vi.setSystemTime('2026-10-26T08:11:00Z');
  expect(store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob?.id).not.toBe(job.id);
});

it('does not relabel a completed world job as manually stopped', () => {
  const room = store.openPrivate('alice').id;
  db(connection => connection.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,lease_until,data) VALUES(?,?,?,?,?,?)').run('already_done', 'alice', 'decision', 'done', null,
    JSON.stringify({ id: 'already_done', companionId: 'alice', conversationId: room, kind: 'decision', status: 'done', throughEventSequence: 0, createdAt: at, attempts: 1, sourceMemoryIds: [] })));
  expect(store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'world', id: 'already_done', stop }).taskControl?.stopped).toBe(false);
  expect(data('companion_world_jobs', 'already_done').stop).toBeUndefined();
});

it('does not recreate a manually stopped sleep episode or decision from an automatic tick', () => {
  const room = store.openPrivate('alice').id;
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '保存这段真实经历作为睡眠整理来源。', replyDirective: 'none' });
  store.request({ type: 'memory.record', companionId: 'alice', conversationId: room, candidate: { artifactKind: 'episode_memory' as const, content: source.content, tags: ['经历'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  const indexing = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  store.request({ type: 'memory.outbox.complete', id: indexing.id, leaseToken: indexing.leaseToken, indexed: true });
  db(connection => {
    const state = JSON.parse((connection.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }).data);
    const actor = state.actors.find((value: { companionId: string }) => value.companionId === 'alice');
    const episode = createHash('sha256').update('alice\n' + actor.activityStartedAtReal).digest('hex').slice(0, 48);
    const through = Number((connection.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM companion_world_events').get() as { n: number }).n);
    for (const kind of ['decision', 'dream'] as const) {
      const job = { id: 'stopped_' + kind, kind, companionId: 'alice', conversationId: room, status: 'done', terminal: true, stop,
        throughEventSequence: through, createdAt: at, attempts: 1, sourceMemoryIds: [], ...(kind === 'dream' ? { sleepEpisodeId: episode } : {}) };
      connection.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,lease_until,data) VALUES(?,?,?,?,?,?)').run(job.id, 'alice', kind, 'done', null, JSON.stringify(job));
    }
    const world = new CompanionWorldStore(connection, () => defaultCompanionRoutineConfig(), () => [], () => undefined as never,
      () => undefined, () => undefined, () => '', () => '');
    const authority = world as unknown as { queueJob(state: unknown, owner: string, kind: 'decision' | 'dream'): unknown };
    expect(authority.queueJob(state, 'alice', 'decision')).toBeUndefined();
    expect(authority.queueJob(state, 'alice', 'dream')).toBeUndefined();
    expect(Number((connection.prepare("SELECT count(*) AS n FROM companion_world_jobs WHERE companion_id='alice'").get() as { n: number }).n)).toBe(2);
  });
});

it('cancels one social reply and its attention receipt without cancelling another participant or accepting a late message', () => {
  const room = store.createConversation('真实社交端口', ['alice', 'bob']);
  const source = store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '讨论当前真实话题', replyDirective: 'none' });
  const job = { id: 'social_selected', companionId: 'bob', conversationId: room.id, sourceMessageId: source.id, throughSequence: source.sequence,
    chainId: 'shared_chain', remainingTurns: 2, memberIds: ['alice', 'bob'], channel: 'phone', status: 'running', attempts: 1, leaseToken: 'old_social_lease', typingNotBefore: at, createdAt: at, round: 'first' };
  db(connection => {
    connection.prepare('INSERT INTO companion_social_chains VALUES(?,?,?,?)').run('shared_chain', 0, 'active', JSON.stringify({ kind: 'group', maxMessages: 4, phase: 'first', initiatorId: 'alice' }));
    for (const entry of [job, { ...job, id: 'social_other', companionId: 'alice', status: 'pending', leaseToken: undefined }]) connection.prepare('INSERT INTO companion_social_jobs VALUES(?,?,?,?,?,?,?)').run(entry.id, entry.companionId, room.id, entry.status, '2026-10-26T08:10:00Z', at, JSON.stringify(entry));
    for (const [owner, lease] of [['bob', 'job:' + job.id], ['alice', 'job:social_other']]) connection.prepare('INSERT INTO companion_social_communication VALUES(?,?,?)').run(owner, '2026-10-26T08:10:00Z', JSON.stringify({ leaseId: lease, channel: 'phone', phase: 'typing', conversationId: room.id, recipientIds: [owner === 'bob' ? 'alice' : 'bob'], untilReal: '2026-10-26T08:10:00Z' }));
  });
  expect(() => store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'social', id: job.id, stop })).toThrow('不属于');
  expect(store.request({ type: 'task-control.stop', companionId: 'bob', kind: 'social', id: job.id, stop }).taskControl?.stopped).toBe(true);
  expect(data('companion_social_jobs', job.id)).toMatchObject({ status: 'cancelled', terminal: true, stop });
  expect(data('companion_social_jobs', 'social_other').status).toBe('pending');
  expect(db(connection => connection.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id='bob'").get())).toBeUndefined();
  expect(db(connection => connection.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id='alice'").get())).toBeTruthy();
  expect(() => store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken, text: '不应发送的迟到回复' })).toThrow('租约');
  expect(data('companion_social_jobs', job.id).error).toBeUndefined();
});

it('cancels exactly one occurrence, preserves its recurring plan and rejects the old dispatch result', () => {
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const schedule = store.request({ type: 'schedule.create', ...scope, entries: [{ title: '每日检查', prompt: '检查当前目标', kind: 'task', runAt: '2026-10-27T08:00:00Z', timeZone: 'UTC', recurrence: 'daily' }] }).schedules![0]!;
  const occurrence = store.request({ type: 'schedule.run-now', ...scope, id: schedule.id, expectedRevision: schedule.revision }).scheduleOccurrence!;
  const current = store.request({ type: 'schedule.get', ...scope, id: schedule.id }).schedule!;
  const other = store.request({ type: 'schedule.run-now', ...scope, id: schedule.id, expectedRevision: current.revision }).scheduleOccurrence!;
  db(connection => {
    const value = data('companion_schedule_occurrences', occurrence.id); value.status = 'running'; value.leaseToken = 'old_occurrence_lease'; value.activityTaskId = 'bound_activity';
    connection.prepare("UPDATE companion_schedule_occurrences SET status='running',lease_until=?,data=? WHERE id=?").run('2026-10-26T08:10:00Z', JSON.stringify(value), occurrence.id);
  });
  expect(() => store.request({ type: 'task-control.stop', companionId: 'bob', kind: 'schedule_occurrence', id: occurrence.id, stop })).toThrow('不属于');
  const result = store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'schedule_occurrence', id: occurrence.id, stop });
  expect(result.taskControl).toMatchObject({ stopped: true, activityTaskIds: ['bound_activity'] });
  expect(result.scheduleOccurrence).toMatchObject({ status: 'cancelled', stop, finishedAt: at });
  expect(store.request({ type: 'schedule.get', ...scope, id: schedule.id }).schedule?.status).toBe('active');
  expect(data('companion_schedule_occurrences', other.id).status).toBe('pending');
  expect(() => store.request({ type: 'schedule.occurrence.update', id: occurrence.id, leaseToken: 'old_occurrence_lease', status: 'failed', error: 'late abort' })).toThrow('用户停止');
  expect(store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'schedule_occurrence', id: occurrence.id, stop }).scheduleOccurrence).toEqual(result.scheduleOccurrence);
});

it('accepts only the trusted stop receipt shape', () => {
  expect(companionStorageCommandSchema.safeParse({ type: 'task-control.stop', companionId: 'alice', kind: 'world', id: 'job', stop }).success).toBe(true);
  expect(companionStorageCommandSchema.safeParse({ type: 'task-control.stop', companionId: 'alice', kind: 'world', id: 'job', stop: { ...stop, actor: 'model' } }).success).toBe(false);
});

it('stops one batched notification, requeues its other members without errors and identifies the actual runtime job', () => {
  const room = store.openPrivate('alice').id;
  const origin = { id: 'real_goal', initiatorId: 'user', initiatorKind: 'human_player', ownerId: 'alice', sharedText: '目标', provenance: 'current_player_request' };
  db(connection => {
    for (const [id, originId, token] of [['primary_notice', origin.id, 'shared_notice_lease'], ['selected_notice', origin.id, 'shared_notice_lease'], ['unrelated_notice', 'other_goal', 'other_notice_lease']]) {
      const notice = { id, companionId: 'alice', conversationId: room, sourceMessageId: 'source_goal', origin: { ...origin, id: originId }, status: 'running', attempts: 1, leaseToken: token, createdAt: at,
        ...(id === 'primary_notice' ? { batchIds: ['primary_notice', 'selected_notice'] } : {}) };
      connection.prepare('INSERT INTO companion_social_notifications VALUES(?,?,?,?,?,?,?,?,?)').run(id, 'alice', originId, 'event_' + id, 'running', '2026-10-26T08:10:00Z', 1, at, JSON.stringify(notice));
    }
  });
  expect(() => store.request({ type: 'task-control.stop', companionId: 'bob', kind: 'social_notification', id: 'selected_notice', stop })).toThrow('不属于');
  const stopped = store.request({ type: 'task-control.stop', companionId: 'alice', kind: 'social_notification', id: 'selected_notice', stop });
  expect(stopped.taskControl?.runtimeTaskIds).toEqual(expect.arrayContaining(['selected_notice', 'primary_notice']));
  expect(data('companion_social_notifications', 'selected_notice')).toMatchObject({ status: 'cancelled', stop, terminal: true });
  expect(data('companion_social_notifications', 'primary_notice')).toMatchObject({ status: 'pending', attempts: 0 });
  expect(data('companion_social_notifications', 'primary_notice').stop).toBeUndefined();
  expect(data('companion_social_notifications', 'primary_notice').error).toBeUndefined();
  expect(data('companion_social_notifications', 'unrelated_notice').status).toBe('running');
  expect(() => store.request({ type: 'social.notification.complete', id: 'primary_notice', leaseToken: 'shared_notice_lease', text: '不应发布的旧批次结果' })).toThrow('租约');
});
