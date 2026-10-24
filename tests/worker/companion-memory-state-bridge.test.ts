import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const opened: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { vi.useRealTimers(); for (const { root, store } of opened.splice(0)) { store.close(); const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-memory-state-')) throw new Error('Unexpected memory-state cleanup.'); removeOwnedDirectorySync(resolved); } });
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-state-')), persona = '温和但独立，有自己的节奏。';
  const store = new CompanionsStore(path.join(root, 'state.db'), [{ id: 'alice', name: '阿澄', description: '', persona, model: '', avatar: 'sister', proactive: false, active: true }]);
  opened.push({ root, store }); return { store, persona, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
it('atomically ties a capture integration to a formal diary and withdraws only that memory version on revision', () => {
  const { store, scope, persona } = fixture();
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '我这次先核验备份，再实际完成了恢复检查。' });
  const before = store.request({ type: 'state.get', ...scope }).runtimeState!;
  const job = store.request({ type: 'memory.jobs.claim', companionId: scope.companionId }).memoryJob!;
  const candidate = { content: '这次先核验备份，再完成恢复检查；下一次仍需要重新核实适用情况。', diaryName: '自我认识', tags: ['恢复检查'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
  const note = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate], expectedStateRevision: before.revision,
    stateProposal: { expression: 'direct', focus: '下次先核验备份的适用范围', reason: '这次整理后形成暂定的下一步关注。', sourceMessageIds: [source.id], evidence: candidate.evidence,
      appraisals: [{ type: 'shared_success', target: 'task', intensity: .4, confidence: 1 }] } }).memories![0]!;
  const changed = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(changed.expression).toBe('direct'); expect(changed.focus).toBe('下次先核验备份的适用范围');
  expect(changed.affect.pleasure).toBeGreaterThan(before.affect.pleasure); expect(changed.relationship).toEqual(before.relationship);
  expect(changed.recentChanges?.some(change => change.kind === 'memory' && change.memoryIds?.includes(note.id))).toBe(true);
  const oldAffect = { ...changed.affect };
  store.request({ type: 'memory.browse', ...scope }); store.request({ type: 'character.development', ...scope });
  expect(store.request({ type: 'state.get', ...scope }).runtimeState!.affect).toEqual(oldAffect);
  expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate] })).toThrow('租约');
  store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: note.version, candidate: { ...candidate, content: candidate.content + '补充：还需核对恢复日志。' } });
  const revised = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(revised.expression).toBe(before.expression); expect(revised.focus).toBeUndefined(); expect(revised.relationship).toEqual(before.relationship);
  expect(revised.recentChanges?.some(change => change.kind === 'memory' && change.memoryIds?.includes(note.id))).toBe(false);
  expect(store.state().companions[0]!.persona).toBe(persona);
});
it('keeps an authored newer state when a slow capture completes, while preserving the committed diary', () => {
  const { store, scope } = fixture();
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '我想稍后整理读书时留下的问题。' });
  const previous = store.request({ type: 'state.get', ...scope }).runtimeState!, job = store.request({ type: 'memory.jobs.claim', companionId: scope.companionId }).memoryJob!;
  const newer = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '现在请先关注这次正在发生的讨论。' });
  store.request({ type: 'state.update', ...scope, proposal: { focus: '眼前讨论', reason: '实际较新来信', sourceMessageIds: [newer.id], evidence: [{ sourceMessageId: newer.id, quote: newer.content }], appraisals: [] } });
  const candidate = { content: '我留下过一个待读问题，尚未实际解决。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
  expect(store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate], expectedStateRevision: previous.revision,
    stateProposal: { focus: '旧的待读问题', reason: '较慢的来源整理', sourceMessageIds: [source.id], evidence: candidate.evidence, appraisals: [] } }).memories).toHaveLength(1);
  expect(store.request({ type: 'state.get', ...scope }).runtimeState!.focus).toBe('眼前讨论');
});
it.each(['A', 'B'] as const)('withdraws only the merged memory impulse while keeping the other source state after forgetting %s', forgottenSide => {
  const { store, scope } = fixture();
  const a = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你，也尊重你。先核验备份再操作，尚未完成。', replyDirective: 'none' });
  const b = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我支持你，也尊重你。恢复后还需核对日志，当前未核实。', replyDirective: 'none' });
  const forgotten = forgottenSide === 'A' ? a : b, survivor = forgottenSide === 'A' ? b : a;
  const proposalFor = (source: typeof a) => ({ content: source.content, tags: ['核验'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] });
  const originals = [a, b].map(source => store.request({ type: 'memory.record', ...scope, candidate: proposalFor(source) }).memories![0]!);
  const index = () => { for (let count = 0; count < 100; count++) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (job) store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  index();
  const mergeCandidate = { content: `${a.content}${b.content}`, tags: ['核验'], sourceMessageIds: [a.id, b.id],
    evidence: [a, b].map(source => ({ sourceMessageId: source.id, quote: source.content })), relatedMemoryIds: originals.map(note => note.id) };
  const merged = store.request({ type: 'memory.consolidate', ...scope, operationId: 'merge_with_state',
    inputs: originals.map(note => ({ id: note.id, version: note.version })), candidate: mergeCandidate }).memories![0]!;
  index();
  const before = store.request({ type: 'state.get', ...scope }).runtimeState!;
  const independentFocus = '仍需保留的来源' + survivor.sequence + '独立关注';
  const independent = store.request({ type: 'state.update', ...scope, proposal: { expression: 'direct', focus: independentFocus,
    reason: '这条仍合法的原消息独立支持当前关注。', sourceMessageIds: [survivor.id], evidence: [{ sourceMessageId: survivor.id, quote: survivor.content }],
    appraisals: [{ type: 'support', target: 'user', intensity: .4, confidence: 1 }] } }).runtimeState!;
  expect(independent.relationship.affinity).toBeGreaterThan(before.relationship.affinity);
  const independentChange = independent.recentChanges!.find(change => change.kind === 'appraisal' && change.sourceMessageIds.length === 1 && change.sourceMessageIds[0] === survivor.id)!;
  expect(independentChange).toBeDefined();
  const capture = store.request({ type: 'memory.jobs.claim', companionId: scope.companionId }).memoryJob!;
  expect([...capture.sourceMessageIds].sort()).toEqual([a.id, b.id].sort());
  const integrated = store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken, notes: [mergeCandidate],
    stateProposal: { expression: 'playful', focus: '依赖两条来源的整合关注', reason: '这次合并记忆带来的暂定状态。',
      sourceMessageIds: [a.id, b.id], evidence: mergeCandidate.evidence, appraisals: [{ type: 'shared_success', target: 'task', intensity: .2, confidence: 1 }] } }).memories![0]!;
  expect(integrated.id).toBe(merged.id);
  const withImpulse = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(withImpulse.focus).toBe('依赖两条来源的整合关注');
  expect(withImpulse.recentChanges?.some(change => change.kind === 'memory' && change.memoryIds?.includes(merged.id))).toBe(true);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [forgotten.id] }); index();
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [survivor.id] }).memorySources).toEqual([survivor]);
  const after = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(after.recentChanges?.some(change => change.kind === 'memory' && change.memoryIds?.includes(merged.id))).toBe(false);
  expect(after.recentChanges?.some(change => change.id === independentChange.id)).toBe(true);
  expect(after.focus).toBe(independentFocus); expect(after.expression).toBe('direct');
  expect(after.relationship).toEqual(independent.relationship); expect(after.affect).toEqual(independent.affect);
  const otherGroup = store.createConversation('另一个群聊', [scope.companionId]);
  const groupState = store.request({ type: 'state.get', companionId: scope.companionId, conversationId: otherGroup.id }).runtimeState!;
  expect(groupState.focus).not.toBe(independentFocus);
  expect(JSON.stringify(groupState)).not.toContain(independentFocus);
  expect(store.request({ type: 'state.get', ...scope }).runtimeState!.focus).toBe(independentFocus);
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [survivor.id] }); index();
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [survivor.id] }).memorySources).toEqual([]);
  const allWithdrawn = store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(allWithdrawn.focus).toBeUndefined(); expect(allWithdrawn.expression).toBe(before.expression);
  expect(allWithdrawn.recentChanges?.some(change => change.id === independentChange.id)).toBe(false);
  expect(allWithdrawn.recentChanges?.some(change => change.kind === 'memory' && change.memoryIds?.includes(merged.id))).toBe(false);
  expect(allWithdrawn.relationship).toEqual(before.relationship);
});
