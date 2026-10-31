import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';

const folders: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', persona: '尊重真实互动', description: '', model: '', avatar: 'sister', proactive: false, active: true }];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-28T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) { if (path.dirname(path.resolve(folder)) !== path.resolve(tmpdir()) || !path.basename(folder).startsWith('companion-state-clock-')) throw new Error('Unexpected fixture'); rmSync(folder, { recursive: true, force: true }); } vi.useRealTimers(); });
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'companion-state-clock-')); folders.push(folder);
  const filename = path.join(folder, 'messages.sqlite'), store = new CompanionsStore(filename, seeds); stores.add(store);
  return { store, filename, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function source(f: ReturnType<typeof fixture>) { return f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '我先核实这次安排，暂时不确定。', replyDirective: 'none' }); }
function evaluate(f: ReturnType<typeof fixture>, message: CompanionMessage, validUntil?: string) {
  return f.store.request({ type: 'state.update', ...f.scope, proposal: { reason: '本人对当前安排的实际表达。', sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }],
    experience: { situation: '正在核对安排。', statement: message.content, reassessWhen: ['核对结果后。'], validUntil }, relationshipUpdates: [] } }).runtimeState!;
}
function state(f: ReturnType<typeof fixture>) { return f.store.request({ type: 'state.get', ...f.scope }).runtimeState!; }

it('does not decay a subjective statement into a score or change its authored revision during energy polling', () => {
  const f = fixture(), initial = evaluate(f, source(f));
  vi.setSystemTime(Date.now() + 60000);
  const later = state(f); expect(later.experience).toEqual(initial.experience); expect(later.revision).toBe(initial.revision);
  expect(later).not.toHaveProperty('affect'); expect(later).not.toHaveProperty('relationship');
});
it('expires temporary experience at its explicit deadline without creating a new emotional event or reviving an older statement', () => {
  const f = fixture(); evaluate(f, source(f));
  vi.setSystemTime(Date.now() + 1000); const message = source(f), deadline = new Date(Date.now() + 60000).toISOString();
  const authored = evaluate(f, message, deadline); expect(authored.experience?.validUntil).toBe(deadline);
  vi.setSystemTime(Date.parse(deadline) + 1); const expired = state(f);
  expect(expired.experience).toBeUndefined(); expect(expired.revision).toBe(authored.revision);
  expect(expired.recentChanges).toEqual(authored.recentChanges);
});
it('keeps the committed source version across restart and never restores a withdrawn experience', () => {
  const f = fixture(), message = source(f), initial = evaluate(f, message);
  f.store.close(); stores.delete(f.store);
  const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened);
  expect(reopened.request({ type: 'state.get', ...f.scope }).runtimeState?.experience).toEqual(initial.experience);
  reopened.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [message.id] });
  reopened.close(); stores.delete(reopened);
  const next = new CompanionsStore(f.filename, seeds); stores.add(next);
  expect(next.request({ type: 'state.get', ...f.scope }).runtimeState?.experience).toBeUndefined();
});
