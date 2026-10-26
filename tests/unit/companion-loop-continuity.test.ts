import { expect, it, vi } from 'vitest';
import { ensureCompanionLoopContinuity, LOOP_CONTINUITY_POLICY } from '../../src/main/companions/loop-continuity';
import type { CompanionLoopCheckpoint, CompanionLoopTurn } from '../../src/shared/companion-loop';
import { projectCompanionEvidenceHistory } from '../../src/main/companions/context-tool-history';
import { CompanionModelError } from '../../src/main/companions/model';

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

it('keeps role and passive memory outside the temporary step window and clears another task\'s working summary', async () => {
  const f = fixture(), persona = '本任务当前角色与稳定人格', passive = '本任务开始时独立被动回忆得到的资料';
  const context = { system: persona, user: JSON.stringify({ invocation: { id: 'same_goal', goal: '完成真实目标' },
    memoryRecall: { context: { text: passive, revision: 'current-corpus' } }, messages: [{ id: 'current-source', content: '本轮新任务' }] }) };
  const compacted = await ensureCompanionLoopContinuity({ ...f.input, context });
  expect(compacted.context.system).toBe(persona);
  expect(JSON.parse(compacted.context.user)).toMatchObject({ memoryRecall: { context: { text: passive } },
    messages: [{ id: 'current-source', content: '本轮新任务' }], loopContinuity: { sourceMessageId: f.checkpoint.sourceMessageId } });
  expect(compacted.turns.length).toBeLessThanOrEqual(LOOP_CONTINUITY_POLICY.maxTurns);
  expect(f.checkpoint.turns).toHaveLength(80);

  // Even a stale caller-supplied summary cannot attach to a different source.
  // A new invocation begins with no native append history of the previous one.
  const next = { ...structuredClone(f.checkpoint), sourceMessageId: 'next-source', invocationKey: 'next-goal', turns: [] };
  const nextContext = { system: '下一任务重新读取的角色', user: JSON.stringify({ invocation: { id: 'next-goal', goal: '新的独立目标' },
    memoryRecall: { context: { text: '下一任务重新被动回忆' } }, loopContinuity: f.checkpoint.workingState }) };
  const summarize = vi.fn(async () => ({ summary: '不应为了新任务空历史而压缩', stage: '' }));
  const rebuilt = await ensureCompanionLoopContinuity({ ...f.input, checkpoint: next, turns: next.turns, context: nextContext, summarize });
  expect(summarize).not.toHaveBeenCalled(); expect(rebuilt.turns).toEqual([]);
  expect(next.workingState).toBeUndefined(); expect(JSON.parse(rebuilt.context.user).loopContinuity).toBeUndefined();
  expect(rebuilt.context.system).toBe(nextContext.system);
  expect(JSON.parse(rebuilt.context.user).memoryRecall.context.text).toBe('下一任务重新被动回忆');
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

it('uses explicit capacity feedback below normal thresholds while keeping full signed call-result pairs and the same absolute slots', async () => {
  const f = fixture(12), original = JSON.stringify(f.turns);
  const result = await ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true });
  expect(result.capacityReduced).toBe(true); expect(f.checkpoint.workingState!.throughTurn).toBe(6);
  expect(result.context.system).toBe(f.context.system); expect(JSON.parse(result.context.user).invocation.goal).toBe('完成真实目标');
  expect(result.turns[0]!.calls[0]!.id).toBe('step_6'); expect(result.turns[0]!.results![0]!.callId).toBe('step_6');
  expect(result.turns[0]!.calls[0]!.thoughtSignature).toBe('opaque_6'); expect(JSON.stringify(f.turns)).toBe(original);
  expect(f.save).toHaveBeenCalledOnce();
});
it('halves a rejected summarization batch and advances only the exact successfully read prefix', async () => {
  const f = fixture(12), sizes: number[] = [];
  const result = await ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true, summarize: async context => {
    const steps = JSON.parse(context.user).steps; sizes.push(steps.length);
    if (steps.length > 2) throw new CompanionModelError('CONTEXT_CAPACITY', 'synthetic explicit provider rejection');
    return { summary: '真实执行记录，仍待继续。', stage: '' };
  } });
  expect(sizes).toEqual([6, 3, 2]); expect(result.capacityReduced).toBe(true);
  expect(f.checkpoint.workingState!.throughTurn).toBe(2); expect(result.turns[0]!.calls[0]!.id).toBe('step_2');
});
it('retains indivisible work and its watermark when a single complete step still exceeds actual capacity', async () => {
  const f = fixture(4), sizes: number[] = [];
  await expect(ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true, summarize: async context => {
    sizes.push(JSON.parse(context.user).steps.length); throw new CompanionModelError('CONTEXT_CAPACITY', 'synthetic capacity');
  } })).rejects.toMatchObject({ code: 'CONTEXT_CAPACITY' });
  expect(sizes).toEqual([2, 1]); expect(f.save).not.toHaveBeenCalled(); expect(f.checkpoint.workingState).toBeUndefined();
});
it('reports no safe reduction for an unfinished single call instead of detaching or truncating its signature', async () => {
  const f = fixture(1); delete f.turns[0]!.results;
  const original = JSON.stringify(f.turns), result = await ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true });
  expect(result.capacityReduced).toBe(false); expect(f.summarize).not.toHaveBeenCalled(); expect(JSON.stringify(f.turns)).toBe(original);
});
it('rejects changed source turns during adaptive summary retries before saving a new checkpoint', async () => {
  const f = fixture(12);
  await expect(ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true, summarize: async () => {
    f.checkpoint.turns[0]!.results![0]!.content = 'CHANGED_RESULT';
    return { summary: '不可提交旧结果摘要', stage: '' };
  } })).rejects.toThrow('未推进水位');
  expect(f.save).not.toHaveBeenCalled(); expect(f.checkpoint.workingState).toBeUndefined();
});
it('can reduce an existing working summary after all complete turns were covered without changing its source range', async () => {
  const f = fixture(12);
  await ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true });
  for (let attempt = 0; attempt < 3; attempt++) await ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true });
  expect(f.checkpoint.workingState!.throughTurn).toBe(12);
  f.checkpoint.workingState!.summary = '已核验record_701。'.repeat(100);
  const through = f.checkpoint.workingState!.throughTurn;
  const result = await ensureCompanionLoopContinuity({ ...f.input, capacityFeedback: true, summarize: async context => {
    expect(JSON.parse(context.user).steps).toEqual([]);
    return { summary: '已核验record_701；仍待交付。', stage: '交付' };
  } });
  expect(result.capacityReduced).toBe(true); expect(f.checkpoint.workingState!.throughTurn).toBe(through);
  expect(f.checkpoint.turns).toHaveLength(12);
});

it('enforces the same bounded summary replacement during ordinary pressure and leaves raw steps and goal untouched', async () => {
  const f = fixture(40), original = JSON.stringify(f.checkpoint), prompts: string[] = [];
  await expect(ensureCompanionLoopContinuity({ ...f.input, summarize: async context => {
    prompts.push(context.user); return { summary: 'REJECTED_LOOP_DRAFT_9823'.repeat(1000), stage: '旧过程' };
  } })).rejects.toThrow();
  expect(prompts).toHaveLength(3); expect(prompts[2]!.length).toBe(prompts[1]!.length);
  for (const prompt of prompts) {
    const input = JSON.parse(prompt); expect(input.workingSummaryBudget.maxCombinedChars).toBe(3000);
    expect(input.currentGoal).toBe('完成真实目标'); expect(prompt).not.toContain('REJECTED_LOOP_DRAFT_9823');
  }
  expect(f.save).not.toHaveBeenCalled(); expect(JSON.stringify(f.checkpoint)).toBe(original);
});
