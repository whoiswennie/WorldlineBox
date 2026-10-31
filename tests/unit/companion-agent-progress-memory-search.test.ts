import { expect, it, vi } from 'vitest';
import { companionAgentNoProgress } from '../../src/main/companions/agent-progress';
import { runCompanionAgentKernel, CompanionAgentNoProgressError, type CompanionAgentState } from '../../src/main/companions/agent-kernel';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';

function receipt(step: number) {
  return { ok: true, memorySearchTimings: { queue: step * 7, sources: step * 11, projection: step * 13, retrieval: step * 17, focus: step * 19, verification: step * 23 },
    memoryPage: { items: [{ memory: { id: 'known_note', companionId: 'alice', artifactKind: 'episode_memory', contentRevision: 1,
      content: '周三归还雨伞。', metadata: { capturedAt: '2026-10-01T00:00:00Z' }, sources: [{ messageId: 'original_source', revision: 1, checksum: 'source_hash' }] }, score: .9 }], hasMore: false },
    memoryRetrieval: { mode: 'active', observedAt: new Date(step * 1000).toISOString(), resultCount: 1 },
    memorySelection: { scope: { companionId: 'alice', conversationId: 'private_alice' } },
    memoryContext: { text: '周三归还雨伞。', revision: 'stable_snapshot', profileKey: 'stable_encoder', typeScope: { consumer: 'facts' },
      evidence: { capturedAt: new Date(step * 1000).toISOString(), queryClock: { now: new Date(step * 1000).toISOString(), timeZone: 'Asia/Shanghai', domain: 'world' },
        corpusHash: 'stable_corpus', references: [{ id: 'known_note', version: 1, textHash: 'same_body_hash',
          sources: [{ messageId: 'original_source', revision: 1, checksum: 'source_hash' }] }] },
      fileReceipts: [{ companionId: 'alice', noteId: 'known_note', contentRevision: 1, contentHash: 'same_file_hash', path: '/owned/note.md' }] } };
}
function turn(step: number, value = receipt(step)): CompanionLoopTurn {
  const call = { id: 'lookup_' + step, name: 'memory', arguments: JSON.stringify({ action: 'search', query: '雨伞约定', limit: 8 }) };
  return { text: '', rawText: '', calls: [call], results: [{ callId: call.id, content: JSON.stringify(value) }] };
}

it('persists six matched unchanged search receipts and stops despite changing measured stage/queue durations and capture clocks', async () => {
  const state: CompanionAgentState = { status: 'running', turns: [] }, saved: CompanionAgentState[] = [];
  const infer = vi.fn(async (step: number) => ({ ...turn(step), results: undefined }));
  const execute = vi.fn(async (current: CompanionLoopTurn, step: number) => [{ callId: current.calls[0]!.id, content: JSON.stringify(receipt(step)) }]);
  await expect(runCompanionAgentKernel({ state, progressFingerprint: () => 'same_sealed_task_input', infer, execute,
    save: async () => { saved.push(structuredClone(state)); }, finish: async () => 'must_not_claim_complete' })).rejects.toBeInstanceOf(CompanionAgentNoProgressError);
  expect(infer).toHaveBeenCalledTimes(6); expect(execute).toHaveBeenCalledTimes(6);
  expect(state.status).toBe('running'); expect(saved.at(-1)).toEqual(state);
  expect(state.turns.every(item => item.results?.[0]?.callId === item.calls[0]!.id)).toBe(true);
  expect(JSON.parse(state.turns[5]!.results![0]!.content)).toEqual(receipt(5)); // Diagnostics remain in the actual durable receipt.
  const next: CompanionAgentState = { status: 'running', turns: [] };
  await expect(runCompanionAgentKernel({ state: next, progressFingerprint: () => 'different_task',
    infer: async step => step < 2 ? { ...turn(step), results: undefined } : { text: '按已知事实回答', rawText: '', calls: [] }, execute,
    save: async () => undefined, finish: async () => 'completed_new_task' })).resolves.toBe('completed_new_task');
  expect(next.turns).toHaveLength(3); // A completed task's observation history is never global state.
});

it.each(['note', 'source', 'hash', 'type', 'scope', 'corpus', 'owner', 'revision', 'text', 'query', 'cursor', 'timeZone', 'sourceCaptureTime'] as const)(
  'preserves genuine %s changes while excluding only search receipt diagnostics', change => {
    const turns = Array.from({ length: 6 }, (_, step) => turn(step)), latest = receipt(5);
    if (change === 'note') latest.memoryPage.items[0]!.memory.id = 'new_note';
    if (change === 'source') latest.memoryContext.evidence.references[0]!.sources[0]!.messageId = 'new_source';
    if (change === 'hash') latest.memoryContext.evidence.references[0]!.textHash = 'new_actual_body_hash';
    if (change === 'type') latest.memoryPage.items[0]!.memory.artifactKind = 'knowledge';
    if (change === 'scope') latest.memorySelection.scope.conversationId = 'other_room';
    if (change === 'corpus') latest.memoryContext.evidence.corpusHash = 'new_corpus';
    if (change === 'owner') latest.memoryContext.fileReceipts[0]!.companionId = 'bob';
    if (change === 'revision') latest.memoryContext.fileReceipts[0]!.contentRevision = 2;
    if (change === 'text') latest.memoryContext.text = '有真实新来源的更正：周四归还雨伞。';
    if (change === 'timeZone') latest.memoryContext.evidence.queryClock.timeZone = 'UTC';
    if (change === 'sourceCaptureTime') latest.memoryPage.items[0]!.memory.metadata.capturedAt = '2026-10-02T00:00:00Z';
    turns[5]!.results![0]!.content = JSON.stringify(latest);
    if (change === 'query' || change === 'cursor') turns[5]!.calls[0]!.arguments = JSON.stringify({ action: 'search', query: change === 'query' ? '新的具体查询' : '雨伞约定', limit: 8, ...(change === 'cursor' ? { cursor: 8 } : {}) });
    expect(companionAgentNoProgress(turns)).toBeUndefined();
  });

it('does not turn unknown failures or unmatched receipts into successful repeated observations', () => {
  const turns = Array.from({ length: 6 }, (_, step) => turn(step));
  expect(companionAgentNoProgress(turns)).toMatchObject({ repetitions: 6 });
  const failures = turns.map(item => ({ ...item, results: item.results!.map(result => ({ ...result, content: JSON.stringify({ ok: false, error: 'transport unavailable' }) })) }));
  expect(companionAgentNoProgress(failures)).toBeUndefined();
  turns[5]!.results![0]!.callId = 'foreign_result'; expect(companionAgentNoProgress(turns)).toBeUndefined();
});
