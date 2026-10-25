import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { runCompanionAgentKernel, type CompanionAgentState } from '../../src/main/companions/agent-kernel';
import { companionAgentRunSchema, companionFinalValidationFailures, type CompanionAgentRun } from '../../src/shared/companion-agent-run';
import { companionLoopCheckpointSchema, type CompanionLoopTurn } from '../../src/shared/companion-loop';
import { COMPANION_SUBMIT_RESULT_TOOL, companionFinalProposalBytes, companionFinalProposalResults,
  companionFinalProposalReceiptSchema } from '../../src/shared/companion-final-proposal';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const native = (id = 'exact_provider_call_1'): CompanionLoopTurn => ({ text: 'visible auxiliary prose stays in audit',
  rawText: 'visible auxiliary prose stays in audit\n', calls: [{ id, name: COMPANION_SUBMIT_RESULT_TOOL,
    arguments: '{\n  "answer": "仅为提案，尚未执行 🌍"\n}', thoughtSignature: 'opaque-protocol-signature' }],
  finalProposal: { callId: id, schemaDigest: digest('actual host result schema') } });
const proposalChecksum = (turn: CompanionLoopTurn) => digest(companionFinalProposalBytes(turn));

it('persists the exact native proposal before validation and completes with one paired receipt without executing a tool', async () => {
  const original = native(), state: CompanionAgentState = { status: 'running', turns: [] };
  let durable = structuredClone(state);
  const execute = vi.fn(async () => []);
  const result = await runCompanionAgentKernel({ state, infer: async () => structuredClone(original), execute,
    save: async () => { durable = structuredClone(state); }, finish: async turn => {
      expect(durable.turns).toEqual([original]);
      turn.results = companionFinalProposalResults(turn, proposalChecksum(turn), 'accepted_for_domain_commit');
      return JSON.parse(turn.calls[0]!.arguments);
    } });
  expect(result).toEqual({ answer: '仅为提案，尚未执行 🌍' }); expect(execute).not.toHaveBeenCalled();
  expect(durable.status).toBe('done');
  expect(durable.turns[0]!.calls).toEqual(original.calls); expect(durable.turns[0]!.rawText).toBe(original.rawText);
  expect(durable.turns[0]!.results).toHaveLength(1);
  expect(durable.turns[0]!.results![0]!.callId).toBe(original.calls[0]!.id);
  expect(companionFinalProposalReceiptSchema.parse(JSON.parse(durable.turns[0]!.results![0]!.content)))
    .toMatchObject({ status: 'accepted_for_domain_commit', proposalChecksum: proposalChecksum(original), callId: original.calls[0]!.id });
});

it.each(['legacy', 'native'] as const)('resumes an already saved %s proposal through validation with no reinference or auxiliary execution', async kind => {
  const f = actualActivity(kind);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  const state = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.run.id }).agentRun!;
  const original = structuredClone(state.turns[0]!);
  const infer = vi.fn(async () => { throw new Error('must not infer'); }), execute = vi.fn(async () => []);
  const result = await runCompanionAgentKernel({ state, infer, execute, save: async () => {
    const saved = store.request({ type: 'agent.run.save', expectedRevision: state.revision,
      run: { ...state, revision: state.revision + 1 } }).agentRun!;
    state.revision = saved.revision;
  }, finish: async current => {
    if (current.finalProposal) current.results = companionFinalProposalResults(current, proposalChecksum(current), 'accepted_for_domain_commit');
    return JSON.parse(current.finalProposal ? current.calls[0]!.arguments : current.rawText);
  } });
  expect(result).toHaveProperty('answer'); expect(infer).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  expect(state.turns[0]!.rawText).toBe(original.rawText); expect(state.turns[0]!.calls).toEqual(original.calls);
  const done = store.request({ type: 'agent.run.get', companionId: 'alice', id: state.id }).agentRun!;
  expect(done.status).toBe('done'); expect(done.effects).toEqual([]); expect(done.turns).toEqual(state.turns);
});

it('does not dispatch mixed terminal and auxiliary calls, and keeps a rejection receipt for each real provider call', async () => {
  const turn = native(); turn.calls.push({ id: 'aux_not_dispatched', name: 'world', arguments: '{"action":"message"}' });
  const state: CompanionAgentState = { status: 'running', turns: [turn] }, execute = vi.fn(async () => []);
  await expect(runCompanionAgentKernel({ state, infer: async () => { throw new Error('must not infer'); }, execute, save: async () => {},
    finish: async () => { throw new Error('终结提案不能与辅助调用混发。'); }, recoverFinal: async rejected => {
      rejected.results = companionFinalProposalResults(rejected, proposalChecksum(rejected), 'rejected_before_execution', '终结提案不能与辅助调用混发。');
      return false;
    } })).rejects.toThrow('不能与辅助调用混发');
  expect(execute).not.toHaveBeenCalled(); expect(state.status).toBe('running');
  expect(turn.results?.map(result => result.callId)).toEqual(turn.calls.map(call => call.id));
  for (const result of turn.results!) expect(JSON.parse(result.content)).toMatchObject({ status: 'rejected_before_execution',
    proposalChecksum: proposalChecksum(turn), callId: result.callId, finalCallId: turn.finalProposal!.callId });
});

let root: string, store: CompanionsStore;
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '依据真实资料独立决定', model: '',
  avatar: 'sister' as const, active: true, proactive: false }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-25T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-final-proposal-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
});
afterEach(() => {
  store.close(); const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('companion-final-proposal-')) throw new Error('Invalid fixture cleanup');
  rmSync(target, { recursive: true, force: true }); vi.useRealTimers();
});
function actualActivity(kind: 'legacy' | 'native' = 'native', finalJson?: string) {
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
    patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '只按本人当前资料形成下一步提案。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id,
    clientId: 'actual_terminal_goal', title: '实际持续目标', goal: source.content }).activityTask!;
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  const leased = store.request({ type: 'activity.claim' }).activityTask!; expect(leased.id).toBe(task.id);
  store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
  const invocationId = `${leased.id}_${leased.step}`;
  const proposal: CompanionLoopTurn = kind === 'native' ? native() : { text: '', rawText: ' {"answer":"old plain JSON"} ', calls: [] };
  if (finalJson !== undefined) {
    if (kind === 'native') { proposal.calls[0]!.arguments = finalJson; proposal.rawText = ''; proposal.text = ''; }
    else proposal.rawText = finalJson;
  }
  const run: CompanionAgentRun = { ...scope, id: digest(JSON.stringify([scope.companionId, scope.conversationId, invocationId])), invocationId,
    requestDigest: digest('actual request contract'), revision: 1, status: 'running',
    turns: [proposal],
    sources: [{ id: source.id, conversationId: scope.conversationId, checksum: digest(source.content) }], memories: [], effects: [] };
  const saved = store.request({ type: 'agent.run.save', run, expectedRevision: 0 }).agentRun!;
  const rejection = () => ({ type: 'agent.run.revise_final' as const, companionId: scope.companionId, id: run.id,
    expectedRevision: saved.revision, activityTaskId: leased.id, leaseToken: leased.leaseToken!, expectedStep: leased.step,
    turnStep: 0, proposalChecksum: proposalChecksum(run.turns[0]!), reason: '提案未通过原领域校验，没有执行任何作用。' });
  return { scope, source, task: leased, run: saved, rejection };
}

it('revises only the actual receiver accepted peer activity and rejects a forged owner or withdrawn source', () => {
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const companion = seeds.find(seed => seed.id === companionId)!;
    store.request({ type: 'companion.update', id: companionId, companion: { ...companion, proactive: true } });
    const conversationId = store.openPrivate(companionId).id;
    const routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  const room = store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['bob', 'alice'], title: '伙伴共同讨论' }).socialConversation!;
  const instruction = '请你接下本次读书讨论的持续整理，逐步核实大家提出的问题，最后向我汇报真实结果。';
  const sending = { type: 'social.send' as const, companionId: 'bob', conversationId: room.id,
    channel: 'phone' as const, content: instruction, clientId: 'actual_peer_responsibility_source' };
  expect(store.request(sending).socialPending).toBe(true);
  vi.setSystemTime(Date.now() + 1300); store.request({ type: 'world.tick' });
  const source = store.request(sending).socialMessage!.message;
  const scope = { companionId: 'alice', conversationId: room.id };
  expect(() => store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id,
    title: '不能借普通入口接受伙伴责任', goal: instruction, clientId: 'peer_cannot_forge_human' })).toThrow();
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job).toMatchObject({ companionId: 'alice', conversationId: room.id, sourceMessageId: source.id });
  vi.setSystemTime(Math.max(Date.now() + 1, Date.parse(job.typingNotBefore) + 1)); store.request({ type: 'world.tick' });
  store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '我愿意接下这份持续整理责任，再按实际进展向你汇报。',
    workOffer: { mode: 'activity', sourceMessageId: source.id, title: '整理共同讨论的问题', instruction, evidence: [instruction], accept: true } });
  const task = store.request({ type: 'activity.list', ...scope }).activityTasks!.find(item => item.sourceMessageId === source.id)!;
  expect(task).toMatchObject({ companionId: 'alice', peerResponsibility: { jobId: job.id, publisherId: 'bob' }, status: 'queued' });
  const leased = store.request({ type: 'activity.claim' }).activityTask!; expect(leased.id).toBe(task.id);
  const invocationId = `${task.id}_${leased.step}`, proposal = native('actual_peer_final');
  const run: CompanionAgentRun = { ...scope, id: digest(JSON.stringify([scope.companionId, scope.conversationId, invocationId])),
    invocationId, requestDigest: digest('actual accepted peer responsibility'), revision: 1, status: 'running', turns: [proposal],
    sources: [{ id: source.id, conversationId: source.conversationId, checksum: digest(source.content) }], memories: [], effects: [] };
  const saved = store.request({ type: 'agent.run.save', run, expectedRevision: 0 }).agentRun!;
  const revise = { type: 'agent.run.revise_final' as const, ...scope, id: run.id, expectedRevision: saved.revision,
    activityTaskId: task.id, leaseToken: leased.leaseToken!, expectedStep: leased.step, turnStep: 0,
    proposalChecksum: proposalChecksum(proposal), reason: '原提案不符合本人的实际持续责任，需要重新选择下一步。' };
  // The internal command takes its room from the persisted run, never a caller field.
  const { conversationId: _room, ...command } = revise; void _room;
  expect(() => store.request({ ...command, companionId: 'bob' })).toThrow();
  const repaired = store.request(command).agentRun!;
  expect(repaired).toMatchObject({ companionId: 'alice', status: 'running', revision: saved.revision + 1 });
  expect(repaired.turns[0]!.calls).toEqual(proposal.calls); expect(repaired.turns[0]!.rawText).toBe(proposal.rawText);
  expect(repaired.effects).toEqual([]); expect(companionFinalValidationFailures(repaired)).toBe(1);
  const next = native('next_actual_peer_final');
  const pending = store.request({ type: 'agent.run.save', expectedRevision: repaired.revision,
    run: { ...repaired, turns: [...repaired.turns, next], revision: repaired.revision + 1 } }).agentRun!;
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
  expect(() => store.request({ ...command, expectedRevision: pending.revision, turnStep: 1,
    proposalChecksum: proposalChecksum(next) })).toThrow('来源');
});

it.each(['legacy', 'native'] as const)('saves the actual completed %s run proposal into the same activity plan with its original source and lease', async kind => {
  const plan = { summary: '先核实当前场景，再依据真实回执继续原目标。', nextSteps: ['读取本人当前场景'], constraints: ['不把提案当作已执行'] };
  const decision = { status: 'continue', action: { action: 'query', category: 'scenes', limit: 1 }, wait: null,
    planningState: plan, summary: '当前仅形成计划，尚未查询或执行。' };
  const json = ' \n' + JSON.stringify(decision) + '\n', f = actualActivity(kind, json), state = f.run;
  const execute = vi.fn(async () => []);
  await expect(runCompanionAgentKernel({ state, execute, infer: async () => { throw new Error('saved final must not be inferred again'); },
    save: async () => {
      const saved = store.request({ type: 'agent.run.save', expectedRevision: state.revision,
        run: { ...state, revision: state.revision + 1 } }).agentRun!;
      state.revision = saved.revision;
    }, finish: async turn => {
      if (turn.finalProposal) turn.results = companionFinalProposalResults(turn, proposalChecksum(turn), 'accepted_for_domain_commit');
      return JSON.parse(kind === 'native' ? turn.calls[0]!.arguments : turn.rawText);
    } })).resolves.toEqual(decision);
  expect(execute).not.toHaveBeenCalled();
  const completed = store.request({ type: 'agent.run.get', companionId: 'alice', id: state.id }).agentRun!;
  expect(completed.status).toBe('done'); expect(completed.effects).toEqual([]);
  expect(completed.turns[0]!.rawText).toBe(kind === 'native' ? '' : json);
  if (kind === 'native') expect(completed.turns[0]!.calls[0]!.arguments).toBe(json);
  const command = { type: 'activity.plan.save' as const, id: f.task.id, leaseToken: f.task.leaseToken!, expectedStep: f.task.step,
    sourceDigest: digest(f.source.content) };
  for (const invalid of [{ ...command, leaseToken: 'different_lease' }, { ...command, expectedStep: f.task.step + 1 },
    { ...command, sourceDigest: digest('different original request') }]) expect(() => store.request(invalid)).toThrow();
  const bobRoom = store.openPrivate('bob').id;
  const bobSource = store.appendMessage({ conversationId: bobRoom, authorId: 'user', content: '本人独立决定', replyDirective: 'none' });
  const foreign = store.request({ type: 'activity.start', companionId: 'bob', conversationId: bobRoom, sourceMessageId: bobSource.id,
    title: '另一位伙伴的独立目标', goal: bobSource.content, clientId: 'foreign_goal_cannot_borrow_plan' }).activityTask!;
  expect(() => store.request({ ...command, id: foreign.id })).toThrow();
  const saved = store.request(command).activityPlanningState!;
  expect(saved).toMatchObject({ taskId: f.task.id, companionId: 'alice', conversationId: f.scope.conversationId,
    sourceDigest: digest(f.source.content), throughStep: f.task.step, trust: 'model_plan_not_execution_fact_or_authority', plan });
  expect(store.request({ type: 'activity.observe', id: f.task.id, leaseToken: f.task.leaseToken! }).activityPlanningState).toEqual(saved);
  expect(store.request({ type: 'activity.get', ...f.scope, id: f.task.id }).activityTask).toMatchObject({ step: f.task.step, history: [] });
  store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(() => store.request(command)).toThrow();
});

it('admits a native done checkpoint only with accurate accepted receipts and no effect, without admitting its marker to player chat checkpoints', () => {
  const f = actualActivity(), accepted = structuredClone(f.run), turn = accepted.turns[0]!;
  accepted.revision++; accepted.status = 'done';
  expect(companionAgentRunSchema.safeParse(accepted).success).toBe(false);
  turn.results = companionFinalProposalResults(turn, proposalChecksum(turn), 'accepted_for_domain_commit');
  const done = store.request({ type: 'agent.run.save', run: accepted, expectedRevision: f.run.revision }).agentRun!;
  expect(done.status).toBe('done'); expect(done.effects).toEqual([]); expect(done.turns[0]!.calls).toEqual(f.run.turns[0]!.calls);
  expect(companionLoopCheckpointSchema.safeParse({ ...f.scope, sourceMessageId: f.source.id, status: 'running', turns: [turn], supplements: [] }).success).toBe(false);
  const withEffect = { ...done, effects: [{ step: 0, callId: turn.calls[0]!.id, state: 'confirmed' as const, result: 'not a real domain effect' }] };
  expect(companionAgentRunSchema.safeParse(withEffect).success).toBe(false);
  const wrongPair = structuredClone(done); wrongPair.turns[0]!.results![0]!.callId = 'different_native_id';
  expect(companionAgentRunSchema.safeParse(wrongPair).success).toBe(false);
});

it('binds rejection to the exact native arguments, marker and raw bytes while keeping owner, lease, step and revision CAS strict', () => {
  const f = actualActivity(), command = f.rejection(), original = structuredClone(f.run);
  const bad = [
    { ...command, companionId: 'bob' }, { ...command, leaseToken: 'wrong_lease' }, { ...command, expectedStep: command.expectedStep + 1 },
    { ...command, expectedRevision: command.expectedRevision + 1 }, { ...command, proposalChecksum: digest(f.run.turns[0]!.rawText) },
  ];
  for (const request of bad) expect(() => store.request(request)).toThrow();
  expect(store.request({ type: 'agent.run.get', companionId: 'alice', id: f.run.id }).agentRun).toEqual(original);
  const bytes = companionFinalProposalBytes(f.run.turns[0]!);
  for (const alteration of ['arguments', 'rawText', 'schemaDigest'] as const) {
    const changed = structuredClone(f.run.turns[0]!);
    if (alteration === 'arguments') changed.calls[0]!.arguments += ' ';
    if (alteration === 'rawText') changed.rawText += ' ';
    if (alteration === 'schemaDigest') changed.finalProposal!.schemaDigest = digest('different schema');
    expect(companionFinalProposalBytes(changed), alteration).not.toBe(bytes);
  }
  const revised = store.request(command).agentRun!;
  expect(revised.turns[0]!.rawText).toBe(original.turns[0]!.rawText); expect(revised.turns[0]!.calls).toEqual(original.turns[0]!.calls);
  expect(revised.effects).toEqual([]); expect(revised.rejectedFinals).toHaveLength(1);
  expect(JSON.parse(revised.turns[0]!.results![0]!.content)).toMatchObject({ status: 'rejected_before_execution',
    proposalChecksum: command.proposalChecksum, callId: original.turns[0]!.calls[0]!.id });
});

it('persists all three native rejection receipts and does not reset their count on restart or by clearing history', () => {
  const f = actualActivity(); let run = f.run;
  for (let slot = 0; slot < 3; slot++) {
    if (slot) run = store.request({ type: 'agent.run.save', expectedRevision: run.revision,
      run: { ...run, revision: run.revision + 1, turns: [...run.turns, native(`provider_slot_${slot + 1}`)] } }).agentRun!;
    run = store.request({ ...f.rejection(), expectedRevision: run.revision, turnStep: slot,
      proposalChecksum: proposalChecksum(run.turns[slot]!) }).agentRun!;
  }
  expect(companionFinalValidationFailures(run)).toBe(3); expect(run.turns).toHaveLength(3); expect(run.effects).toEqual([]);
  expect(run.turns.every(turn => turn.results?.length === turn.calls.length && JSON.parse(turn.results[0]!.content).status === 'rejected_before_execution')).toBe(true);
  expect(() => store.request({ ...f.rejection(), expectedRevision: run.revision, turnStep: 2, proposalChecksum: proposalChecksum(run.turns[2]!) })).toThrow();
  expect(() => store.request({ type: 'agent.run.save', expectedRevision: run.revision, run: { ...run, revision: run.revision + 1, rejectedFinals: [] } })).toThrow();
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  const restored = store.request({ type: 'agent.run.get', companionId: 'alice', id: run.id }).agentRun!;
  expect(companionFinalValidationFailures(restored)).toBe(3); expect(restored.turns).toEqual(run.turns);
});

it.each(['source-withdrawn', 'task-cancelled', 'old-lease'] as const)('does not reopen a native proposal after %s', invalid => {
  const f = actualActivity();
  if (invalid === 'source-withdrawn') store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  if (invalid === 'task-cancelled') store.request({ type: 'activity.cancel', ...f.scope, id: f.task.id });
  if (invalid === 'old-lease') {
    store.request({ type: 'activity.recover' }); vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' });
    expect(store.request({ type: 'activity.claim' }).activityTask?.leaseToken).not.toBe(f.task.leaseToken);
  }
  expect(() => store.request(f.rejection())).toThrow();
  expect(store.request({ type: 'actions' }).actions).toEqual([]);
});
