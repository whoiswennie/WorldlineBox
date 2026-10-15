import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
const ids = ['alice', 'bob', 'carol'];
const seeds: CompanionSeed[] = ids.map(id => ({ id, name: id, persona: '友好且尊重他人的边界。', description: '', model: '', avatar: 'sister', proactive: false }));
const stores = new Set<CompanionsStore>(), roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-social-review-')) throw new Error('Unexpected social review cleanup.'); rmSync(root, { recursive: true, force: true }); } vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-social-review-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const id of ids) { const scope = { companionId: id, conversationId: store.openPrivate(id).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } }); }
  advance(store, 10000); return store;
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function room(store: CompanionsStore, members = ['alice', 'bob']) { return store.request({ type: 'social.conversation.ensure', companionId: members[0]!, memberIds: members }).socialConversation!; }
function send(store: CompanionsStore, conversationId: string, clientId = 'initial') {
  const command = { type: 'social.send', companionId: 'alice', conversationId, content: '想听听你今天自己的生活安排，不需要操作玩家文件。', channel: 'phone', clientId } as const;
  let result = store.request(command); if (result.socialPending) { advance(store, 1300); result = store.request(command); }
  return result.socialMessage!;
}
function complete(store: CompanionsStore, job: CompanionSocialJob, text: string | null) { const due = Date.parse(job.typingNotBefore) - Date.now(); if (due >= 0) advance(store, due + 100); return store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text }); }
it('uses one unordered room per peer member set, separate from player rooms and private data', () => {
  const store = fixture(), pair = room(store), pairAgain = room(store, ['bob', 'alice']);
  expect(pair.id).toBe(pairAgain.id); expect(pair.id).not.toBe(store.openPrivate('alice').id);
  const group = room(store, ['alice', 'bob', 'carol']); expect(group.id).toBe(room(store, ['carol', 'alice', 'bob']).id); expect(group.id).not.toBe(pair.id);
  const privateSource = store.appendMessage({ conversationId: store.openPrivate('alice').id, authorId: 'user', content: 'PRIVATE_PLAYER_FACT', replyDirective: 'none' });
  const speech = send(store, pair.id); expect(speech.message.authorId).toBe('alice'); expect(speech.recipientIds).toEqual(['bob']);
  const visible = store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: pair.id, ids: [privateSource.id, speech.message.id] }).memorySources!;
  expect(visible.map(message => message.id)).toEqual([speech.message.id]);
  expect(JSON.stringify(store.request({ type: 'social.messages', conversationId: pair.id }))).not.toContain('PRIVATE_PLAYER_FACT');
  expect(store.request({ type: 'work.list' }).works).toEqual([]); expect(store.request({ type: 'actions' }).actions).toEqual([]);
});
it('defers a sleeping recipient without waking or creating computer work, then responds after real wakefulness', () => {
  const store = fixture(), pair = room(store), scope = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { wakeAt: '11:00', sleepAt: '09:00' } }); advance(store, 12000);
  expect(store.request({ type: 'state.get', ...scope }).runtimeState!.routine!.phase).toBe('sleeping');
  send(store, pair.id); expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  expect(store.request({ type: 'state.get', ...scope }).runtimeState!.routine!.phase).toBe('sleeping');
  const latest = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: latest.revision, patch: { wakeAt: '07:00', sleepAt: '23:00' } }); advance(store, 12000);
  const job = store.request({ type: 'social.job.claim' }).socialJob!; expect(job.companionId).toBe('bob');
  const result = complete(store, job, '刚醒来看到你的消息，我今天想去读书。'); expect(result.socialMessage!.message.authorId).toBe('bob');
  expect(store.request({ type: 'world.snapshot' }).world!.works.filter(work => work.status !== 'ended')).toEqual([]);
});
it('keeps phone replies behind real work and rejects stale source leases after withdrawal', () => {
  const store = fixture(), pair = room(store), userRoom = store.openPrivate('bob');
  const user = store.appendMessage({ conversationId: userRoom.id, authorId: 'user', content: '解释这段代码', replyDirective: 'none' });
  store.request({ type: 'world.work.begin', companionId: 'bob', conversationId: userRoom.id, workId: 'real_work', kind: 'chat', sourceMessageId: user.id });
  const sent = send(store, pair.id); expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  store.request({ type: 'world.work.end', companionId: 'bob', workId: 'real_work' }); advance(store, 10000);
  const job = store.request({ type: 'social.job.claim' }).socialJob!; expect(job.sourceMessageId).toBe(sent.message.id);
  expect(() => companionStorageResponseSchema.parse({ ok: true, socialJob: job })).not.toThrow();
  store.request({ type: 'memory.forget', companionId: 'bob', conversationId: pair.id, sourceMessageIds: [sent.message.id] });
  expect(() => complete(store, job, '这条引用已被撤回，不得发送。')).toThrow();
  expect(store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!.items.some(item => item.message.authorId === 'bob')).toBe(false);
});
it('bounds a group chain to four total messages without fan-out, duplicate complete or user queue execution', () => {
  const store = fixture(), group = room(store, ids), first = send(store, group.id);
  expect(new Set(first.recipientIds)).toEqual(new Set(['bob', 'carol']));
  const jobs: CompanionSocialJob[] = [];
  for (let index = 0; index < 8; index++) { const job = store.request({ type: 'social.job.claim' }).socialJob; if (!job) break; jobs.push(job); complete(store, job, '这是伙伴自己的第' + index + '条回应。'); advance(store, 3000); }
  expect(jobs.length).toBe(3); expect(jobs.every(job => job.chainId === jobs[0]!.chainId)).toBe(true);
  expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  const messages = store.request({ type: 'social.messages', conversationId: group.id }).socialMessagePage!.items;
  const count = messages.length;
  expect(count).toBe(4);
  expect(() => complete(store, jobs[0]!, '重复末端提交不可重发。')).toThrow();
  expect(store.request({ type: 'social.messages', conversationId: group.id }).socialMessagePage!.items).toHaveLength(count);
  expect(messages.every(item => ids.includes(item.message.authorId) && item.recipientIds.every(id => id !== item.message.authorId && ids.includes(id)))).toBe(true);
  expect(store.request({ type: 'work.list' }).works).toEqual([]); expect(store.request({ type: 'actions' }).actions).toEqual([]);
});
