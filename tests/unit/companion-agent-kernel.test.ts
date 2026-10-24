import { expect, it, vi } from 'vitest';
import { runCompanionAgentKernel, CompanionAgentNoProgressError, type CompanionAgentState } from '../../src/main/companions/agent-kernel';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';
import { companionExecutionConstraintLedger } from '../../src/main/companions/execution-restrictions';
import { companionAgentNoProgress } from '../../src/main/companions/agent-progress';

const final = (): CompanionLoopTurn => ({ text: 'done', rawText: 'done', calls: [] });
it('recognizes paraphrases only with matched whole-authorized-empty corpus receipts and preserves real revisions, pages and scoped queries', () => {
  const turns: CompanionLoopTurn[] = Array.from({ length: 6 }, (_, index) => ({ text: '', rawText: '', calls: [{ id: `read_${index}`, name: 'memory',
    arguments: JSON.stringify({ action: 'search', query: `换一种措辞${index}`, limit: 10 }) }], results: [{ callId: `read_${index}`,
      content: JSON.stringify({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: { engine: 'none', resultCount: 0,
        authorizedCorpusEmpty: true, authorizedCorpusRevision: 'same-real-empty-ledger' } }) }] }));
  expect(companionAgentNoProgress(turns)).toMatchObject({ kind: 'empty_authorized_memory', repetitions: 6 });
  for (const change of ['missingProof', 'newRevision', 'pageAvailable', 'unmatchedReceipt'] as const) {
    const changed = structuredClone(turns), last = changed.at(-1)!, result = JSON.parse(last.results![0]!.content);
    if (change === 'missingProof') delete result.memoryRetrieval.authorizedCorpusEmpty;
    if (change === 'newRevision') result.memoryRetrieval.authorizedCorpusRevision = 'new-real-ledger';
    if (change === 'pageAvailable') result.memoryPage.hasMore = true;
    if (change === 'unmatchedReceipt') last.results![0]!.callId = 'foreign';
    last.results![0]!.content = JSON.stringify(result);
    expect(companionAgentNoProgress(changed), change).toBeUndefined();
  }
});
it('persists a decision before effects and resumes the pending native turn without reinference', async () => {
  const state: CompanionAgentState = { status: 'running', turns: [] };
  let durable = structuredClone(state), saveFailed = true;
  const infer = vi.fn(async () => ({ ...final(), calls: [{ id: 'a', name: 'world', arguments: '{}' }] }));
  const execute = vi.fn(async () => [{ callId: 'a', content: 'actual receipt' }]);
  await expect(runCompanionAgentKernel({ state, infer, execute, save: async () => {
    if (saveFailed) { saveFailed = false; throw new Error('disk full'); } durable = structuredClone(state);
  }, finish: async () => 'done' })).rejects.toThrow('disk full');
  expect(execute).not.toHaveBeenCalled(); expect(durable.turns).toEqual([]);
  durable = structuredClone(state);
  const resumed = structuredClone(durable);
  const nextInference = vi.fn(async () => final());
  const events: string[] = [];
  await expect(runCompanionAgentKernel({ state: resumed, infer: nextInference, execute: async () => {
    expect(durable.turns[0]?.calls[0]?.id).toBe('a'); events.push('effect');
    return execute();
  }, save: async () => { durable = structuredClone(resumed); events.push('saved'); }, finish: async () => 'done' })).resolves.toBe('done');
  expect(nextInference).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
  expect(durable.status).toBe('done'); expect(events[0]).toBe('effect');
});
it('keeps matched tool pairs through more than 64 scheduling steps without a lifetime cap', async () => {
  const state: CompanionAgentState = { status: 'running', turns: [] };
  const receipts: string[] = [];
  const result = await runCompanionAgentKernel({ state, save: async () => {},
    infer: async step => step === 75 ? final() : ({ ...final(), calls: [{ id: `step_${step}`, name: 'memory', arguments: '{}' }] }),
    execute: async turn => { receipts.push(turn.calls[0]!.id); return [{ callId: turn.calls[0]!.id, content: 'ok' }]; }, finish: async () => 'complete' });
  expect(result).toBe('complete'); expect(receipts).toHaveLength(75); expect(state.turns).toHaveLength(76);
  expect(state.turns.slice(0, 75).every(turn => turn.results?.[0]?.callId === turn.calls[0]?.id)).toBe(true);
});
it('rejects incomplete native results and never marks a failed delivery complete', async () => {
  const state: CompanionAgentState = { status: 'running', turns: [{ ...final(), calls: [{ id: 'a', name: 'memory', arguments: '{}' }] }] };
  await expect(runCompanionAgentKernel({ state, save: async () => {}, infer: async () => final(), execute: async () => [], finish: async () => 'done' })).rejects.toThrow('不完整匹配');
  expect(state.turns[0]?.results).toBeUndefined(); expect(state.status).toBe('running');
  state.turns = [final()];
  await expect(runCompanionAgentKernel({ state, save: async () => {}, infer: async () => final(), execute: async () => [],
    finish: async () => { throw new Error('incorrect file content'); } })).rejects.toThrow('incorrect file content');
  expect(state.status).toBe('running');
});
it('retains complete original positive and conditional requirements, including long Unicode sources', () => {
  const content = '请保留原文件名。仅当核验通过才发布；输出必须含来源。' + '记忆🌍'.repeat(6000);
  const entries = companionExecutionConstraintLedger([{ id: 'source', revision: 3, content }]);
  expect(entries.map(entry => entry.text).join('')).toBe(content);
  expect(entries.every(entry => entry.text.length <= 16000 && entry.revision === 3)).toBe(true);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
  expect(entries).toEqual(companionExecutionConstraintLedger([{ id: 'source', revision: 3, content }]));
});

function observation(step: number): CompanionLoopTurn {
  return { text: '继续检查', rawText: '', calls: [{ id: 'read_' + step, name: 'world',
    arguments: JSON.stringify({ action: 'query', category: 'people', query: 'Alice', limit: 2 }) }] };
}
function receipt(turn: CompanionLoopTurn, step: number, revision = 1, name = 'Alice') {
  return [{ callId: turn.calls[0]!.id, content: JSON.stringify({ ok: true, operationId: 'operation_' + step,
    worldKnowledge: { category: 'people', observedAt: new Date(step * 1000).toISOString(), observedAtVirtual: new Date(step * 100000).toISOString(),
      evidenceMessageId: 'new_receipt_' + step, internalized: false, items: [{ id: 'alice', name, revision }] },
    memorySources: [{ id: 'generated_source_' + step, content: 'same observation, new transport receipt' }] }) }];
}
it('persists all six real observation results and raises typed needs-attention instead of an infinite paid loop', async () => {
  const state: CompanionAgentState = { status: 'running', turns: [] }, saved: CompanionAgentState[] = [];
  const infer = vi.fn(async step => observation(step)), execute = vi.fn(async (turn, step) => receipt(turn, step));
  const error = await runCompanionAgentKernel({ state, infer, execute, save: async () => { saved.push(structuredClone(state)); }, finish: async () => 'incorrect' }).catch(error => error);
  expect(error).toBeInstanceOf(CompanionAgentNoProgressError);
  expect(error).toMatchObject({ code: 'COMPANION_AGENT_NEEDS_ATTENTION', proof: { fromStep: 0, throughStep: 5, repetitions: 6 } });
  expect(infer).toHaveBeenCalledTimes(6); expect(execute).toHaveBeenCalledTimes(6); expect(state.status).toBe('running');
  expect(state.turns).toHaveLength(6); expect(saved.at(-1)).toEqual(state);
  expect(state.turns.every(turn => turn.results?.[0]?.callId === turn.calls[0]?.id)).toBe(true);
  const repeated = vi.fn(async () => receipt(observation(6), 6));
  await expect(runCompanionAgentKernel({ state: structuredClone(state), infer: async step => observation(step), execute: repeated,
    save: async () => {}, finish: async () => 'incorrect' })).rejects.toBeInstanceOf(CompanionAgentNoProgressError);
  expect(repeated).not.toHaveBeenCalled(); // A restart cannot dispatch the same seventh observation.
});
it('compares persisted host source epochs on resume and permits changed real input to finish without replaying effects', async () => {
  const state: CompanionAgentState = { status: 'running', turns: [] };
  await expect(runCompanionAgentKernel({ state, progressFingerprint: () => 'source:version:1', infer: async step => observation(step),
    execute: async (turn, step) => receipt(turn, step), save: async () => {}, finish: async () => 'incorrect' })).rejects.toBeInstanceOf(CompanionAgentNoProgressError);
  const infer = vi.fn(async () => final());
  await expect(runCompanionAgentKernel({ state: structuredClone(state), progressFingerprint: () => 'source:version:1', infer,
    execute: async () => [], save: async () => {}, finish: async () => 'incorrect' })).rejects.toBeInstanceOf(CompanionAgentNoProgressError);
  expect(infer).not.toHaveBeenCalled();
  await expect(runCompanionAgentKernel({ state: structuredClone(state), progressFingerprint: () => 'source:version:2', infer,
    execute: async () => [], save: async () => {}, finish: async () => 'new input resolved the issue' })).resolves.toBe('new input resolved the issue');
  expect(infer).toHaveBeenCalledOnce();
});
it.each(['cursor', 'version', 'content', 'effect', 'await', 'host-source'] as const)('resets unchanged-read protection for genuine %s progress without a lifetime turn cap', async mode => {
  const state: CompanionAgentState = { status: 'running', turns: [] }; let current = 0;
  await expect(runCompanionAgentKernel({ state, beforeStep: async step => { current = step; },
    progressFingerprint: mode === 'host-source' ? () => 'source_' + Math.floor(current / 4) : undefined,
    infer: async step => {
      if (step === 20) return final();
      const turn = observation(step);
      if (mode === 'cursor') turn.calls[0]!.arguments = JSON.stringify({ action: 'query', category: 'people', query: 'Alice', before: Math.floor(step / 4) });
      if (mode === 'effect' && step % 4 === 3) turn.calls[0] = { id: 'write_' + step, name: 'world', arguments: '{"action":"message","text":"actual contact"}' };
      if (mode === 'await') turn.calls[0] = { id: 'await_' + step, name: 'dsh', arguments: '{"operation":"record","query":{"kind":"summary","recordId":"actual"}}' };
      return turn;
    }, execute: async (turn, step) => receipt(turn, step, mode === 'version' ? Math.floor(step / 4) : 1,
      mode === 'content' ? 'Alice_' + Math.floor(step / 4) : 'Alice'), save: async () => {}, finish: async () => 'done' })).resolves.toBe('done');
  expect(state.status).toBe('done'); expect(state.turns).toHaveLength(21);
});
