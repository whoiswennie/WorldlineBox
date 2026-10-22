import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLifeRule } from '../../src/shared/companion-life-event';

const stores = new Set<CompanionsStore>(), roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T14:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'life-events-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite');
  const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', description: '', persona: '温柔友善', model: '', avatar: 'sister', proactive: true }];
  const store = new CompanionsStore(file, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed', timeZone: 'UTC' } });
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
it('persists hazard, sends one formal spontaneous player message, and never rerolls on reopening', () => {
  const f = fixture(); vi.setSystemTime(Date.now() + 900);
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
  const f = fixture(); vi.setSystemTime(Date.now() + 900);
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

it('selects only activated autonomous contacts and can reconsider after the player activates the first peer', () => {
  const f = fixture();
  f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: f.rule.id, expectedRevision: f.rule.revision });
  const peer = f.store.createCompanion({ name: 'Bob', description: '', persona: '独立伙伴', model: '', avatar: 'sister', proactive: false });
  const rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '与激活的朋友交流', action: 'message', startMinute: 14 * 60, endMinute: 15 * 60, probability: 1, checkIntervalMinutes: 1 } }).lifeRule!;
  f.store.request({ type: 'life-event.tick' }); vi.setSystemTime(Date.now() + 900);
  expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  const waiting = f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.find(occ => occ.ruleId === rule.id)!;
  expect(waiting).toMatchObject({ status: 'observing', multiplier: 0 }); expect(waiting.targetId).toBeUndefined();
  expect(f.store.state().companions.find(role => role.id === peer.id)?.active).toBe(false);
  f.store.setCompanionActive(peer.id, true); vi.setSystemTime(Date.now() + 900);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  expect(claimed).toMatchObject({ ruleId: rule.id, companionId: 'alice', targetId: peer.id, status: 'running' });
});

it('does not claim a configured dormant contact or submit a late life message after the target is deactivated', () => {
  const f = fixture();
  f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: f.rule.id, expectedRevision: f.rule.revision });
  const peer = f.store.createCompanion({ name: 'Bob', description: '', persona: '独立伙伴', model: '', avatar: 'sister', proactive: false });
  const rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '联系指定朋友', action: 'message', targetId: peer.id, startMinute: 14 * 60, endMinute: 15 * 60, probability: 1, checkIntervalMinutes: 1 } }).lifeRule!;
  f.store.request({ type: 'life-event.tick' }); vi.setSystemTime(Date.now() + 900);
  expect(f.store.request({ type: 'life-event.claim' }).lifeOccurrence).toBeUndefined();
  f.store.setCompanionActive(peer.id, true); vi.setSystemTime(Date.now() + 900);
  const claimed = f.store.request({ type: 'life-event.claim' }).lifeOccurrence!;
  expect(claimed).toMatchObject({ ruleId: rule.id, targetId: peer.id, status: 'running' });
  f.store.setCompanionActive(peer.id, false);
  expect(() => f.store.request({ type: 'life-event.complete', id: claimed.id, leaseToken: claimed.leaseToken!, text: '不能向已休眠的伙伴发起交流。' })).toThrow('激活');
  expect(f.store.request({ type: 'social.conversations', companionId: 'alice' }).socialConversationPage!.items).toEqual([]);
});
