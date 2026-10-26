import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLifeRule } from '../../src/shared/companion-life-event';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';

const stores = new Set<CompanionsStore>(), roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T14:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'life-events-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite');
  const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', description: '', persona: '温柔友善', model: '', avatar: 'sister', proactive: true }];
  const store = new CompanionsStore(file, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } });
  for (const rule of store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeRules!) {
    store.request({ type: 'life-rule.update', companionId: 'alice', id: rule.id, expectedRevision: rule.revision, rule: { ...draft(rule), enabled: false } });
  }
  const rule = store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '问候玩家', action: 'message', targetId: 'user', startMinute: 14 * 60, endMinute: 14 * 60 + 2, probability: 1, checkIntervalMinutes: 1 } }).lifeRule!;
  store.request({ type: 'life-event.claim' });
  return { store, file, seeds, rule };
}
function draft(rule: CompanionLifeRule) {
  return { title: rule.title, startMinute: rule.startMinute, endMinute: rule.endMinute, probability: rule.probability, action: rule.action, targetId: rule.targetId, durationMinutes: rule.durationMinutes };
}
function advance(store: CompanionsStore, milliseconds: number) {
  vi.setSystemTime(Date.now() + milliseconds);
  for (let index = 0; index < 100; index++) { if (!store.request({ type: 'world.clock' }).worldClock!.backlog) break; store.request({ type: 'world.tick' }); }
  store.request({ type: 'world.tick' });
}
function frozenLifeFixture() {
  const f = fixture(); advance(f.store, 90_000);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!, room = f.store.openPrivate('alice');
  const scope = { companionId: 'alice', conversationId: room.id };
  const source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '这是生活发言当时读到的真实资料。', replyDirective: 'none' });
  const note = f.store.request({ type: 'memory.record', ...scope, candidate: { content: '准备发言时记住的原始认识。', tags: ['生活'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const sources = note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum }));
  const proof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', companionId: 'alice', conversationId: 'world_alice',
    complete: true, memories: [], frozenMemories: [{ id: note.id, sources }], sources, contexts: [], knowledgeReads: [], topics: [] };
  return { ...f, claimed, scope, source, note, proof };
}

it('commits a life utterance with its original frozen evidence after ordinary maintenance without a global revision veto', () => {
  const f = frozenLifeFixture();
  f.store.request({ type: 'memory.revise', ...f.scope, id: f.note.id, expectedVersion: f.note.version, candidate: {
    content: '后来的普通整理，只改变现在的笔记。', tags: ['新标签'], sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } });
  const completed = f.store.request({ type: 'life-event.complete', id: f.claimed.id, leaseToken: f.claimed.leaseToken!,
    text: '根据当时真实可见的资料，自然地分享一个想法。', executionReadset: f.proof, expectedMemoryRevision: 'unrelated-global-revision' }).lifeOccurrence!;
  expect(completed.status).toBe('done');
});

for (const change of ['forget_note', 'withdraw_source', 'wrong_owner', 'exact_active_revision'] as const) it(`refuses a late life result whose actual evidence is invalid: ${change}`, () => {
  const f = frozenLifeFixture();
  if (change === 'forget_note') f.store.request({ type: 'memory.forget', ...f.scope, id: f.note.id });
  else if (change === 'withdraw_source') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  else if (change === 'wrong_owner') f.proof.companionId = 'another_owner';
  else {
    f.proof.frozenMemories = []; f.proof.memories = [{ id: f.note.id, version: f.note.version }];
    f.store.request({ type: 'memory.revise', ...f.scope, id: f.note.id, expectedVersion: f.note.version, candidate: {
      content: '主动精确版本读取已变化。', tags: [], sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } });
  }
  expect(() => f.store.request({ type: 'life-event.complete', id: f.claimed.id, leaseToken: f.claimed.leaseToken!, text: '不得发布', executionReadset: f.proof })).toThrow('来源');
  expect(f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occ => occ.id === f.claimed.id)?.status).toBe('running');
  expect(f.store.messages({ conversationId: f.scope.conversationId }).messages.some(message => message.content === '不得发布')).toBe(false);
});
it('persists hazard, sends one formal spontaneous player message, and never rerolls on reopening', () => {
  const f = fixture(); advance(f.store, 90_000);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  expect(claimed).toMatchObject({ ruleId: f.rule.id, status: 'running', targetId: 'user' });
  expect(claimed.hazard).toBeGreaterThan(claimed.threshold);
  const completed = f.store.request({ type: 'life-event.complete', id: claimed.id, leaseToken: claimed.leaseToken!, text: '这会儿有点空，来和你打声招呼。' }).lifeOccurrence!;
  expect(completed.status).toBe('done');
  f.store.request({ type: 'life-event.complete', id: claimed.id, leaseToken: claimed.leaseToken!, text: '不应重复发出' });
  const room = f.store.openPrivate('alice'), messages = f.store.request({ type: 'messages', conversationId: room.id }).messages!;
  expect(messages.filter(message => message.authorId === 'alice')).toHaveLength(1);
  f.store.close(); stores.delete(f.store); const reopened = new CompanionsStore(f.file, f.seeds); stores.add(reopened);
  expect(reopened.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  expect(reopened.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occ => occ.id === claimed.id)?.status).toBe('done');
});
it('removes a rule from management while retaining its occurrence and rejects a cancelled late result', () => {
  const f = fixture(); advance(f.store, 90_000);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: f.rule.id, expectedRevision: f.rule.revision });
  const page = f.store.request({ type: 'life-rule.list', companionId: 'alice' });
  expect(page.lifeRules!.some(rule => rule.id === f.rule.id)).toBe(false);
  expect(page.lifeOccurrences!.find(occ => occ.id === claimed.id)?.status).toBe('cancelled');
  expect(() => f.store.request({ type: 'life-event.complete', id: claimed.id, leaseToken: claimed.leaseToken!, text: '不能迟到写回' })).toThrow('失效');
});
it('respects an existing opt-out and never sends a backlog of greetings after a long offline gap', () => {
  const f = fixture(); const role = f.store.state().companions[0]!; f.store.updateCompanion(role.id, { ...role, proactive: false });
  vi.setSystemTime(Date.now() + 800); expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  f.store.updateCompanion(role.id, { ...role, proactive: true });
  vi.setSystemTime(Date.now() + 10 * 86400000);
  // World catch-up is a separate bounded simulation and never invokes the LLM.
  for (let index = 0; index < 100; index++) { if (!f.store.request({ type: 'world.clock' }).worldClock!.backlog) break; f.store.request({ type: 'world.tick' }); }
  expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
});

it('selects only known activated autonomous contacts and reconsiders after an actual introduction', () => {
  const f = fixture();
  f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: f.rule.id, expectedRevision: f.rule.revision });
  const peer = f.store.createCompanion({ name: 'Bob', description: '', persona: '独立伙伴', model: '', avatar: 'sister', proactive: false });
  const rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '与激活的朋友交流', action: 'message', startMinute: 14 * 60, endMinute: 15 * 60, probability: 1, checkIntervalMinutes: 1 } }).lifeRule!;
  f.store.request({ type: 'life-event.tick' }); advance(f.store, 90_000);
  expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  const waiting = f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occ => occ.ruleId === rule.id)!;
  expect(waiting).toMatchObject({ status: 'observing', multiplier: 0 }); expect(waiting.targetId).toBeUndefined();
  expect(f.store.state().companions.find(role => role.id === peer.id)?.active).toBe(false);
  f.store.setCompanionActive(peer.id, true); advance(f.store, 90_000);
  expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  const room = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', peer.id] }).socialConversation!;
  f.store.request({ type: 'social.message.append', conversationId: room.id, authorId: peer.id, content: '你好Alice，我是Bob。', virtualCreatedAt: new Date().toISOString(), clientId: 'actual_life_acquaintance' });
  advance(f.store, 90_000);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  expect(claimed).toMatchObject({ ruleId: rule.id, companionId: 'alice', targetId: peer.id, status: 'running' });
});

it('does not claim a configured dormant contact or submit a late life message after the target is deactivated', () => {
  const f = fixture();
  f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: f.rule.id, expectedRevision: f.rule.revision });
  const peer = f.store.createCompanion({ name: 'Bob', description: '', persona: '独立伙伴', model: '', avatar: 'sister', proactive: false });
  const rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '联系指定朋友', action: 'message', targetId: peer.id, startMinute: 14 * 60, endMinute: 15 * 60, probability: 1, checkIntervalMinutes: 1 } }).lifeRule!;
  f.store.request({ type: 'life-event.tick' }); advance(f.store, 90_000);
  expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  f.store.setCompanionActive(peer.id, true); advance(f.store, 90_000);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  expect(claimed).toMatchObject({ ruleId: rule.id, targetId: peer.id, status: 'running' });
  f.store.setCompanionActive(peer.id, false);
  expect(() => f.store.request({ type: 'life-event.complete', id: claimed.id, leaseToken: claimed.leaseToken!, text: '不能向已休眠的伙伴发起交流。' })).toThrow('激活');
  expect(f.store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items).toEqual([]);
});
