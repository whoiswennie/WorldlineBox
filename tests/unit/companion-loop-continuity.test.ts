import { expect, it, vi } from 'vitest';
import { ensureCompanionLoopContinuity, LOOP_CONTINUITY_POLICY } from '../../src/main/companions/loop-continuity';
import type { CompanionLoopCheckpoint, CompanionLoopTurn } from '../../src/shared/companion-loop';
import { projectCompanionEvidenceHistory } from '../../src/main/companions/context-tool-history';

function fixture(count = 80) {
  const turns: CompanionLoopTurn[] = Array.from({ length: count }, (_, index) => ({ text: '', rawText: '',
    calls: [{ id: 'step_' + index, name: 'dsh', arguments: JSON.stringify({ operation: 'run', tasks: [{ title: '实际步骤', prompt: 'step ' + index }] }), thoughtSignature: 'opaque_' + index }],
    results: [{ callId: 'step_' + index, content: JSON.stringify({ status: 'succeeded', recordId: 'record_' + index, output: 'value_' + index }) }] }));
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: 'room', sourceMessageId: 'source',
    invocationKey: 'goal', status: 'running', turns, supplements: [] };
  const context = { system: '稳定身份与当前权限', user: JSON.stringify({ invocation: { id: 'same_goal', topicId: 'topic', goal: '完成真实目标' } }) };
  const save = vi.fn(async () => undefined), summarize = vi.fn<(_context: { system: string; user: string }) => Promise<{ summary: string; stage: string }>>(async () => ({ summary: '已执行步骤与真实产物，后续继续未完成部分。', stage: '继续核验' }));
  const input = { checkpoint, turns, context, config: { apiFormat: 'openai_chat' as const, model: 'configured', apiKey: 'synthetic-key' }, save, summarize };
  return { ...input, input };
}

it('projects a bounded recent window with a cumulative durable summary while preserving all absolute action slots', async () => {
  const f = fixture(), original = JSON.stringify(f.turns);
  const result = await ensureCompanionLoopContinuity(f.input);
  expect(f.checkpoint.turns).toHaveLength(80); expect(JSON.stringify(f.turns)).toBe(original);
  expect(result.turns.length).toBeLessThanOrEqual(LOOP_CONTINUITY_POLICY.maxTurns);
  expect(result.turns.at(-1)?.calls[0]?.thoughtSignature).toBe('opaque_79');
  expect(f.checkpoint.workingState?.throughTurn).toBe(64); expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.summarize).toHaveBeenCalledTimes(2);
  const first = JSON.parse(f.summarize.mock.calls[0]![0]!.user), second = JSON.parse(f.summarize.mock.calls[1]![0]!.user);
  expect(first.steps[0].step).toBe(0); expect(second.steps[0].step).toBe(32); expect(second.priorCheckpoint.throughTurn).toBe(32);
  expect(JSON.parse(result.context.user).loopContinuity).toMatchObject({ throughTurn: 64, rawTurnsPersisted: true, trust: 'same_invocation_working_summary_not_authorization' });
});

it('resumes a saved summary without replaying its old prefix or summarizing it again', async () => {
  const f = fixture(); await ensureCompanionLoopContinuity(f.input);
  const restored = structuredClone(f.checkpoint), summarize = vi.fn(async () => ({ summary: '不应再次调用', stage: '' }));
  const result = await ensureCompanionLoopContinuity({ ...f.input, checkpoint: restored, turns: restored.turns, summarize });
  expect(summarize).not.toHaveBeenCalled(); expect(result.turns[0]?.calls[0]?.id).toBe('step_64');
});

it('keeps an unfinished signed native call and its absolute position outside the compacted prefix', async () => {
  const f = fixture(50); delete f.turns[49]!.results;
  const result = await ensureCompanionLoopContinuity(f.input);
  expect(result.turns.at(-1)).toBe(f.turns[49]); expect(result.turns.at(-1)?.calls[0]?.thoughtSignature).toBe('opaque_49');
  expect(f.checkpoint.workingState!.throughTurn).toBeLessThan(49);
});

it('does not publish or advance a checkpoint after invalid summaries or failed persistence', async () => {
  const f = fixture(40), invalid = vi.fn(async () => ({ summary: '' }));
  await expect(ensureCompanionLoopContinuity({ ...f.input, summarize: invalid })).rejects.toThrow();
  expect(invalid).toHaveBeenCalledTimes(3); expect(f.checkpoint.workingState).toBeUndefined(); expect(f.save).not.toHaveBeenCalled();
  await expect(ensureCompanionLoopContinuity({ ...f.input, save: async () => { throw new Error('write failed'); } })).rejects.toThrow('write failed');
  expect(f.checkpoint.workingState).toBeUndefined(); expect(f.turns).toHaveLength(40);
});

it('refuses a stale summary when source validity changes during the model request', async () => {
  const f = fixture(40);
  await expect(ensureCompanionLoopContinuity({ ...f.input, valid: async () => false })).rejects.toThrow(/未推进水位/);
  expect(f.checkpoint.workingState).toBeUndefined(); expect(f.save).not.toHaveBeenCalled();
});

it('invalidates old private summary text after evidence withdrawal and rebuilds only from the legal projection', async () => {
  const f = fixture(50); await ensureCompanionLoopContinuity({ ...f.input, summarize: async () => ({ summary: 'PRIVATE_OLD_MEMORY', stage: '' }) });
  f.turns[0]!.calls = [{ id: 'old_memory', name: 'memory', arguments: '{"action":"search","query":"private"}' }];
  f.turns[0]!.results = [{ callId: 'old_memory', content: 'PRIVATE_OLD_MEMORY' }];
  const projected = projectCompanionEvidenceHistory(f.turns, { memoryThroughStep: 50, withdrawnThroughStep: 50 });
  const summarize = vi.fn(async () => ({ summary: '仅保留当前合法执行状态。', stage: '' }));
  const result = await ensureCompanionLoopContinuity({ ...f.input, turns: projected, context: { ...f.context,
    user: JSON.stringify({ invocation: { id: 'same_goal', topicId: 'topic' }, memoryEvidenceThroughStep: 50, withdrawnEvidenceThroughStep: 50 }) }, summarize });
  expect(JSON.stringify(summarize.mock.calls)).not.toContain('PRIVATE_OLD_MEMORY'); expect(result.context.user).not.toContain('PRIVATE_OLD_MEMORY');
  expect(f.turns[0]!.results![0]!.content).toBe('PRIVATE_OLD_MEMORY');
});
