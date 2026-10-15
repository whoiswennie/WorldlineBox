import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import type { CompanionWorldJob } from '../../src/shared/companion-world';

const Sqlite = BetterSqlite3 as { new(filename: string): CompanionConnection }, stores = new Set<CompanionsStore>(), roots: string[] = [];
const seeds: CompanionSeed[] = ['alice', 'bob', 'carol'].map(id => ({ id, name: id, persona: '喜欢自然交流', description: '', model: '', avatar: 'sister', proactive: true }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture(positions = [{ x: 106, y: 62 }, { x: 108, y: 62 }, { x: 107, y: 64 }]) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-encounter-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  let store = new CompanionsStore(filename, seeds); stores.add(store);
  const first = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: first.settings.revision, patch: { mode: 'compressed', timeZone: 'UTC' } });
  for (const role of seeds) {
    const scope = { companionId: role.id, conversationId: store.openPrivate(role.id).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
  store.close(); stores.delete(store); const db = new Sqlite(filename);
  try {
    const saved = db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string }, data = JSON.parse(saved.data) as { actors: Array<Record<string, unknown>> };
    for (let index = 0; index < data.actors.length; index++) Object.assign(data.actors[index]!, { sceneId: 'commons', position: positions[index], route: [], activity: 'idle' });
    db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(data));
  } finally { db.close(); }
  store = new CompanionsStore(filename, seeds); stores.add(store); return store;
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function encounter(store: CompanionsStore): CompanionWorldJob {
  let job: CompanionWorldJob | undefined;
  for (let index = 0; index < 40 && !job; index++) { advance(store, 500); job = store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob; }
  expect(job?.encounterMemberIds).toHaveLength(3); return job!;
}
function audit(filename: string) {
  const db = new Sqlite(filename);
  try {
    return { world: db.prepare('SELECT * FROM companion_world').all(),
      events: db.prepare('SELECT * FROM companion_world_events ORDER BY sequence').all(),
      worldJobs: db.prepare('SELECT * FROM companion_world_jobs ORDER BY id').all(),
      socialJobs: db.prepare('SELECT * FROM companion_social_jobs ORDER BY id').all(),
      communication: db.prepare('SELECT * FROM companion_social_communication ORDER BY companion_id').all(),
      messages: db.prepare('SELECT * FROM companion_social_messages ORDER BY sequence').all() };
  } finally { db.close(); }
}

describe('durable real face-to-face encounters', () => {
  it('initiates no fake message, then uses one formal group room, speaking/listening animation and a four-message bounded chain', () => {
    const store = fixture(), job = encounter(store), owner = job.companionId, recipients = job.encounterMemberIds!.filter(id => id !== owner);
    expect(store.request({ type: 'social.conversations' }).socialConversationPage!.total).toBe(0);
    store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, action: { action: 'social', recipientIds: recipients, kind: 'greet', text: '今天天气很好，你们也来花园散步了吗？' } });
    const rooms = store.request({ type: 'social.conversations' }).socialConversationPage!;
    expect(rooms.total).toBe(1); const room = rooms.items[0]!; expect(room.kind).toBe('group'); expect(room.memberIds).toEqual(['alice', 'bob', 'carol']); expect(room.lastMessage?.channel).toBe('face_to_face');
    const same = store.request({ type: 'social.conversation.ensure', companionId: owner, memberIds: ['carol', 'alice', 'bob'] }).socialConversation!;
    expect(same.id).toBe(room.id);
    const world = store.request({ type: 'world.snapshot' }).world!;
    expect(world.actors.find(actor => actor.companionId === owner)).toMatchObject({ artAction: 'communicate', communication: { channel: 'face_to_face', phase: 'speaking' } });
    for (const id of recipients) expect(world.actors.find(actor => actor.companionId === id)?.communication).toMatchObject({ channel: 'face_to_face', phase: 'listening' });
    for (let count = 0; count < 3; count++) {
      const reply = store.request({ type: 'social.job.claim' }).socialJob!; expect(reply.channel).toBe('face_to_face'); advance(store, 1300);
      const sent = store.request({ type: 'social.job.complete', id: reply.id, leaseToken: reply.leaseToken!, text: '我也刚好在这边散步，停下来聊一会儿吧。' }).socialMessage!;
      expect(sent.channel).toBe('face_to_face');
    }
    expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
    expect(store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.total).toBe(4);
    for (let tick = 0; tick < 20; tick++) { advance(store, 500); expect(store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob).toBeUndefined(); }
  });

  it('validates every group pair, never turns separated or busy actors into a face-to-face conversation, and rejects late speech after work starts', () => {
    const store = fixture([{ x: 107, y: 62 }, { x: 103, y: 62 }, { x: 111, y: 62 }]), scope = { companionId: 'alice', conversationId: 'world_alice' };
    expect(() => store.request({ type: 'world.tool', ...scope, arguments: { action: 'social', recipientIds: ['bob', 'carol'], kind: 'talk', text: '我们一起聊聊吧。' } })).toThrow('5格');
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const sent = store.request({ type: 'social.send', companionId: 'alice', conversationId: room.id, channel: 'phone', content: '碰巧遇到你，聊一会儿吧。', clientId: 'auto-promote-face' }).socialMessage!;
    expect(sent.channel).toBe('face_to_face');
    const reply = store.request({ type: 'social.job.claim' }).socialJob!; expect(reply.companionId).toBe('bob');
    const player = store.openPrivate('bob'), source = store.appendMessage({ conversationId: player.id, authorId: 'user', content: '请开始集中处理工作。' });
    store.request({ type: 'world.work.begin', companionId: 'bob', conversationId: player.id, workId: 'real_work_interrupt', kind: 'action', sourceMessageId: source.id }); advance(store, 1500);
    const result = store.request({ type: 'social.job.complete', id: reply.id, leaseToken: reply.leaseToken!, text: '这条已经过时的现场发言绝不能被写入。' });
    expect(result.socialMessage).toBeUndefined(); expect(result.socialPending).toBeUndefined();
    expect(store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.total).toBe(1);
    expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'bob')?.communication?.channel).not.toBe('face_to_face');
  });

  it('releases a declined or failed encounter without manufacturing greetings or immediately rerolling', () => {
    const store = fixture(), job = encounter(store);
    // A slow provider can outlive the sixty-second physical pause. Every member,
    // including a listener, still belongs to only this one pending encounter.
    advance(store, 65000);
    expect(store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob).toBeUndefined();
    store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '本次认知没有完成。' });
    for (let tick = 0; tick < 20; tick++) { advance(store, 1000); expect(store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob).toBeUndefined(); }
    expect(store.request({ type: 'social.conversations' }).socialConversationPage!.total).toBe(0);
  });

  it('rolls back physical encounter release when the final failed-job write is rejected, then retries the same lease cleanly', () => {
    const store = fixture(), job = encounter(store), filename = path.join(roots.at(-1)!, 'messages.sqlite'), before = audit(filename);
    const fault = new Sqlite(filename);
    try { fault.exec(`CREATE TRIGGER fail_encounter_termination BEFORE UPDATE ON companion_world_jobs WHEN OLD.id='${job.id}' BEGIN SELECT RAISE(ABORT,'injected final encounter job failure'); END`); }
    finally { fault.close(); }
    expect(() => store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '本次提供方没有返回。' })).toThrow('injected final encounter');
    expect(audit(filename)).toEqual(before);
    const repair = new Sqlite(filename); try { repair.exec('DROP TRIGGER fail_encounter_termination'); } finally { repair.close(); }
    store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '本次提供方没有返回。' });
    const committed = audit(filename), saved = committed.worldJobs.find(value => (value as { id: string }).id === job.id) as { status: string };
    expect(saved.status).toBe('done');
    const state = JSON.parse((committed.world[0] as { data: string }).data) as { actors: Array<{ meetingHold?: unknown; meetingResume?: unknown }> };
    expect(state.actors.every(actor => !actor.meetingHold && !actor.meetingResume)).toBe(true);
    expect(committed.messages).toHaveLength(0);
  });

  it('rolls back a failed face-to-face job and the whole group communication lease when cleanup is rejected', () => {
    const store = fixture(), job = encounter(store);
    store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, action: { action: 'social',
      recipientIds: job.encounterMemberIds!.filter(id => id !== job.companionId), kind: 'talk', text: '碰巧遇到你们，要聊一会儿吗？' } });
    const reply = store.request({ type: 'social.job.claim' }).socialJob!, filename = path.join(roots.at(-1)!, 'messages.sqlite'), before = audit(filename);
    expect(before.communication).toHaveLength(3);
    const fault = new Sqlite(filename);
    try { fault.exec("CREATE TRIGGER fail_face_cleanup BEFORE DELETE ON companion_social_communication WHEN OLD.companion_id='bob' BEGIN SELECT RAISE(ABORT,'injected group lease cleanup failure'); END"); }
    finally { fault.close(); }
    expect(() => store.request({ type: 'social.job.fail', id: reply.id, leaseToken: reply.leaseToken!, error: '提供方暂时不可用。' })).toThrow('injected group lease');
    expect(audit(filename)).toEqual(before);
    const repair = new Sqlite(filename); try { repair.exec('DROP TRIGGER fail_face_cleanup'); } finally { repair.close(); }
    store.request({ type: 'social.job.fail', id: reply.id, leaseToken: reply.leaseToken!, error: '提供方暂时不可用。' });
    const committed = audit(filename), saved = committed.socialJobs.find(value => (value as { id: string }).id === reply.id) as { status: string };
    expect(saved.status).toBe('failed'); expect(committed.communication).toEqual([]); expect(committed.messages).toHaveLength(1);
  });
});
