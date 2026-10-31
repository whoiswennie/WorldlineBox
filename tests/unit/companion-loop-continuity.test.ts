import { expect, it, vi } from 'vitest';
import { ensureCompanionLoopContinuity, LOOP_CONTINUITY_POLICY } from '../../src/main/companions/loop-continuity';
import type { CompanionLoopCheckpoint, CompanionLoopTurn } from '../../src/shared/companion-loop';
import { projectCompanionEvidenceHistory } from '../../src/main/companions/context-tool-history';
import { CompanionModelError } from '../../src/main/companions/model';
import { createHash } from 'node:crypto';

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

it('does not compact host-only search manifests and duplicate candidates absent from the actual provider view', async () => {
  const f = fixture(4), manifest = Array.from({ length: 1500 }, (_, index) => ({ id: 'HOST_ONLY_DEPENDENCY_' + index, version: 1 }));
  for (const [index, turn] of f.turns.entries()) {
    turn.calls = [{ id: 'memory_' + index, name: 'memory', arguments: '{"action":"search","query":"本条约定"}' }];
    turn.results = [{ callId: 'memory_' + index, content: JSON.stringify({ ok: true,
      memoryContext: { text: '本次实际相关约定。', revision: 'current', profileKey: 'encoder', evidence: { dependencies: manifest } },
      memoryPage: { items: [{ memory: { id: 'note_' + index, version: 1, artifactKind: 'episode_memory',
        content: 'HOST_ONLY_DUPLICATE_CANDIDATE'.repeat(4000) }, score: .9 }], hasMore: false },
      memoryRetrieval: { stages: [{ explanation: 'INSPECTION_ONLY_EXCERPT'.repeat(4000) }] } }) }];
  }
  const original = JSON.stringify(f.turns);
  expect(original.length).toBeGreaterThan(LOOP_CONTINUITY_POLICY.maxChars);
  const result = await ensureCompanionLoopContinuity(f.input);
  expect(f.summarize).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  expect(f.checkpoint.workingState).toBeUndefined(); expect(result.turns).toEqual(f.turns);
  expect(JSON.stringify(f.turns)).toBe(original);
});

it('compacts genuinely large explicit memory reads using the provider view while sealing the raw source digest', async () => {
  const f = fixture(3), fullBody = '完整实际阅读正文，不删除限定与否定。'.repeat(6000);
  for (const [index, turn] of f.turns.entries()) {
    turn.calls = [{ id: 'read_' + index, name: 'memory', arguments: JSON.stringify({ action: 'read', id: 'note_' + index }) }];
    turn.results = [{ callId: 'read_' + index, content: JSON.stringify({ ok: true, memoryRead: {
      memory: { id: 'note_' + index, version: 1, artifactKind: 'procedure', content: fullBody, sources: [] }, related: [] } }) }];
  }
  const original = JSON.stringify(f.turns), summarize = vi.fn(async (context: { system: string; user: string }) => {
    const prompt = JSON.parse(context.user);
    for (const step of prompt.steps) {
      const result = JSON.parse(step.results[0].content);
      expect(result.memoryRead.memory.content).toBe(fullBody);
      expect(result.memoryRead.memory.typeMeaning).toContain('方法与适用条件');
      expect(step.step).toBeGreaterThanOrEqual(prompt.fromTurn);
    }
    return { summary: '已真实阅读方法原文；适用条件和验证范围仍须保留。', stage: '继续当前任务' };
  });
  const result = await ensureCompanionLoopContinuity({ ...f.input, summarize });
  expect(summarize).toHaveBeenCalled(); expect(f.save).toHaveBeenCalled();
  const state = f.checkpoint.workingState!;
  expect(state.sourceDigest).toBe(createHash('sha256').update(JSON.stringify(f.turns.slice(0, state.throughTurn))).digest('hex'));
  expect(result.turns[0]).toBe(f.turns[state.throughTurn]);
  expect(JSON.stringify(f.turns)).toBe(original); expect(f.checkpoint.turns).toHaveLength(3);
});

it('preserves the central exhausted repair budget without starting an outer format retry', async () => {
  const f = fixture(), exhausted = new CompanionModelError('INVALID_RESPONSE', '格式修复已耗尽。', 'structured_repair_exhausted');
  const summarize = vi.fn(async () => { throw exhausted; });
  await expect(ensureCompanionLoopContinuity({ ...f.input, summarize })).rejects.toBe(exhausted);
  expect(summarize).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled();
});

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
