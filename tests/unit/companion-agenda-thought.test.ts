import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeCompanionAgendaThought, type CompanionAgendaThoughtNative } from '../../src/main/companions/agenda-thought';
import { CompanionAgendaDeferred, CompanionAgendaOutcomeUnknown, type CompanionAgendaExecutionContext } from '../../src/main/companions/agenda-service';
import { snapshotDshTaskExecution } from '../../src/main/dsh/task-execution';
import { assertDshResumeScope } from '../../src/main/dsh/task-scope';
import { dshRecordScopeSchema, type DshRecordScope } from '../../src/shared/dsh-task-record';
import type { CompanionAgendaClaim } from '../../src/shared/companion-agenda';
import { boundaryGrant, boundaryNow, boundaryOccurrence, boundaryRule, boundaryRun } from './companion-agenda-boundary-fixtures';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(boundaryNow); });
afterEach(() => vi.useRealTimers());
function fixture() {
  const claim: CompanionAgendaClaim = { rule: boundaryRule(), occurrence: boundaryOccurrence(), run: boundaryRun(), leaseToken: 'lease' };
  const receipts = new Map<string, unknown>(), effectKeys: string[] = [];
  const context: CompanionAgendaExecutionContext = {
    checkpoint: vi.fn(async () => undefined), bindGrant: vi.fn(), effectId: key => 'stable-effect-' + claim.run.id + '-' + key,
    async effect<T>(key: string, _title: string, operation: (effectId: string) => Promise<T>): Promise<T> {
      effectKeys.push(key); if (receipts.has(key)) return receipts.get(key) as T;
      const result = await operation(context.effectId(key)); receipts.set(key, result); return result;
    },
  };
  const state = { grant: { ...boundaryGrant(), capabilities: ['dsh'] as ReturnType<typeof boundaryGrant>['capabilities'] }, scope: undefined as DshRecordScope | undefined };
  const native: CompanionAgendaThoughtNative = {
    start: vi.fn(async (_input, execution) => { state.scope = execution.recordScope; return { taskId: '11111111-1111-4111-8111-111111111111' }; }),
    inspect: vi.fn(async () => ({ record: { status: 'succeeded' as const }, scope: state.scope, text: '依据当前明确提供的材料，仍有一个未解问题。' })),
    terminate: vi.fn(async () => undefined),
  };
  const validate = vi.fn(async () => structuredClone(state.grant)), wait = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => undefined), controller = new AbortController();
  const options = { native, workspaceRoot: 'C:/isolated-fixture-workspaces', validate, wait };
  const input = { title: '想清楚一个问题', prompt: '仅分析这次明确提供的资料，不执行外部操作。', key: 'research-question' };
  const execute = () => executeCompanionAgendaThought(claim, context, controller.signal, input, options);
  return { claim, context, receipts, effectKeys, state, native, validate, wait, controller, options, input, execute };
}

it('dispatches a genuinely isolated cognitive native task with an empty tool/skill policy and exact scope', async () => {
  const f = fixture(), result = await f.execute();
  expect(result.outcome).toBe('completed'); expect(JSON.parse(result.result!)).toMatchObject({ taskId: '11111111-1111-4111-8111-111111111111', trust: 'reasoning_result_not_external_action_evidence' });
  expect(f.native.start).toHaveBeenCalledExactlyOnceWith({ title: f.input.title, prompt: f.input.prompt }, expect.objectContaining({ cognitiveOnly: true,
    toolkit: true, interactive: true, access: { mode: 'read-only' }, allowedWorkspaceRoots: [], workspaceRootPath: f.options.workspaceRoot,
    task: { mode: 'native', tools: [], skills: [], session: { mode: 'new' }, workspace: { mode: 'managed' } } }));
  const execution = vi.mocked(f.native.start).mock.calls[0]![1], scope = dshRecordScopeSchema.parse(execution.recordScope);
  expect(scope).toMatchObject({ companionId: 'alice', conversationId: 'own-room', invocationId: f.claim.run.id,
    agendaOrigin: { ruleId: f.claim.rule.id, runId: f.claim.run.id, occurrenceId: f.claim.occurrence.id, grantId: 'grant', grantRevision: 1 } });
  expect(scope.sourceMessageId).toBeUndefined(); expect(scope.activityThought).toBeUndefined();
  expect(snapshotDshTaskExecution(execution).task).toMatchObject({ tools: [], skills: [], session: { mode: 'new' }, workspace: { mode: 'managed' } });
  expect(f.context.bindGrant).toHaveBeenCalledExactlyOnceWith('grant'); expect(f.native.terminate).not.toHaveBeenCalled();
});
it('waits without starting a fake task when the native environment is unavailable', async () => {
  const f = fixture(); await expect(executeCompanionAgendaThought(f.claim, f.context, f.controller.signal, f.input, { ...f.options, native: undefined })).rejects.toBeInstanceOf(CompanionAgendaDeferred);
  expect(f.validate).not.toHaveBeenCalled(); expect(f.effectKeys).toEqual([]);
});
it('binds the native record to the real owner chat used for its visible capability process', async () => {
  const f = fixture();
  const result = await executeCompanionAgendaThought(f.claim, f.context, f.controller.signal, f.input, { ...f.options, presentationConversationId: 'actual-owner-private-room', presentationTopicId: 'actual-current-topic' });
  expect(result.outcome).toBe('completed');
  expect(f.state.scope).toMatchObject({ conversationId: 'actual-owner-private-room', topicId: 'actual-current-topic', companionId: f.claim.rule.companionId,
    invocationId: f.claim.run.id, agendaOrigin: { runId: f.claim.run.id, occurrenceId: f.claim.occurrence.id, grantId: 'grant', grantRevision: 1 } });
  expect(f.state.scope!.sourceMessageId).toBeUndefined();
  expect(f.native.start).toHaveBeenCalledOnce(); expect(f.native.terminate).not.toHaveBeenCalled();
});
it('retains native archive truncation instead of claiming a partial reply is complete', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementation(async () => ({ record: { status: 'succeeded' }, scope: f.state.scope,
    text: '这是原始归档保留的部分内容。', textTruncated: true }));
  const result = await f.execute(); expect(JSON.parse(result.result!)).toMatchObject({ textTruncated: true });
});
it('bounds the serialized receipt even when reasoning text needs extensive JSON escaping', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementation(async () => ({ record: { status: 'succeeded' }, scope: f.state.scope, text: '\u0001'.repeat(26000) }));
  const result = await f.execute(); expect(result.result!.length).toBeLessThanOrEqual(32000);
  expect(JSON.parse(result.result!)).toMatchObject({ textTruncated: true }); expect(JSON.parse(result.result!).text.length).toBeGreaterThan(0);
});
it.each(['revoked', 'expired', 'wrong-owner', 'wrong-goal', 'no-dsh'] as const)('denies %s grant before native launch', async change => {
  const f = fixture();
  if (change === 'revoked') f.state.grant.status = 'revoked';
  if (change === 'expired') f.state.grant.expiresAt = boundaryNow;
  if (change === 'wrong-owner') f.state.grant.companionId = 'bob';
  if (change === 'wrong-goal') f.state.grant.goalId = 'other-goal';
  if (change === 'no-dsh') f.state.grant.capabilities = ['observe'];
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaDeferred); expect(f.native.start).not.toHaveBeenCalled();
});
it('revalidates the current grant after queuing but before native dispatch', async () => {
  const f = fixture(); f.validate.mockResolvedValueOnce(structuredClone(f.state.grant)).mockResolvedValueOnce({ ...f.state.grant, revision: 2 });
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaDeferred); expect(f.native.start).not.toHaveBeenCalled();
});
it.each(['revoke', 'revise'] as const)('stops an already running child on %s without starting a replacement', async change => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementation(async () => ({ record: { status: 'running' }, scope: f.state.scope }));
  f.wait.mockImplementationOnce(async () => { if (change === 'revoke') f.state.grant.status = 'revoked'; else f.state.grant.revision++; });
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaDeferred); expect(f.native.start).toHaveBeenCalledOnce(); expect(f.native.inspect).toHaveBeenCalledOnce();
  expect(f.native.terminate).toHaveBeenCalledExactlyOnceWith('11111111-1111-4111-8111-111111111111');
});
it('withholds a native result when permission changes while inspect is awaiting', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementationOnce(async () => { f.state.grant.status = 'revoked'; return { record: { status: 'succeeded' }, scope: f.state.scope, text: '不得返回的思考内容' }; });
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaDeferred); expect(f.native.terminate).toHaveBeenCalledOnce();
});
it('cancels a wait and terminates the actual native child without a wall-clock sleep', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementation(async () => ({ record: { status: 'running' }, scope: f.state.scope }));
  f.wait.mockImplementationOnce(async signal => { f.controller.abort(); signal.throwIfAborted(); });
  await expect(f.execute()).rejects.toMatchObject({ name: 'AbortError' }); expect(f.wait).toHaveBeenCalledExactlyOnceWith(f.controller.signal);
  expect(f.native.start).toHaveBeenCalledOnce(); expect(f.native.terminate).toHaveBeenCalledOnce();
});
it('keeps an interrupted native receipt unknown and does not blindly launch a second task', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementation(async () => ({ record: { status: 'interrupted' }, scope: f.state.scope }));
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaOutcomeUnknown);
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaOutcomeUnknown);
  expect(f.native.start).toHaveBeenCalledOnce(); expect(f.effectKeys[0]).toBe(f.effectKeys[1]); expect(f.receipts.size).toBe(1);
});
it('preserves an uncertain interrupted outcome when termination itself has no reliable receipt', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementationOnce(async () => ({ record: { status: 'interrupted' }, scope: f.state.scope }));
  vi.mocked(f.native.terminate).mockRejectedValueOnce(new Error('停止通道断开'));
  await expect(f.execute()).rejects.toMatchObject({ name: 'CompanionAgendaOutcomeUnknown', message: expect.stringContaining('思考执行中断') });
  expect(f.native.start).toHaveBeenCalledOnce(); expect(f.native.terminate).toHaveBeenCalledOnce(); expect(f.receipts.size).toBe(1);
});
it.each(['companion', 'action', 'conversation', 'invocation', 'rule', 'occurrence', 'grant', 'revision', 'mixed-user'] as const)('rejects native %s scope mismatch without touching the foreign task', async mismatch => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementationOnce(async () => {
    const scope = structuredClone(f.state.scope!);
    if (mismatch === 'companion') scope.companionId = 'bob';
    if (mismatch === 'action') scope.actionId = '22222222-2222-4222-8222-222222222222';
    if (mismatch === 'conversation') scope.conversationId = 'other-room';
    if (mismatch === 'invocation') scope.invocationId = 'other-run';
    if (mismatch === 'rule') scope.agendaOrigin!.ruleId = 'other-rule';
    if (mismatch === 'occurrence') scope.agendaOrigin!.occurrenceId = 'other-occurrence';
    if (mismatch === 'grant') scope.agendaOrigin!.grantId = 'other-grant';
    if (mismatch === 'revision') scope.agendaOrigin!.grantRevision = 9;
    if (mismatch === 'mixed-user') scope.sourceMessageId = 'other-user-source';
    return { record: { status: 'succeeded' }, scope, text: '另一个来源的私人内容' };
  });
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaOutcomeUnknown); expect(f.native.terminate).not.toHaveBeenCalled();
});
it.each(['scope', 'text'] as const)('does not invent success when the completed native record has no %s', async missing => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementationOnce(async () => ({ record: { status: 'succeeded' },
    ...(missing === 'scope' ? {} : { scope: f.state.scope }), ...(missing === 'text' ? {} : { text: '无完整来源' }) }));
  await expect(f.execute()).rejects.toBeInstanceOf(CompanionAgendaOutcomeUnknown); expect(f.native.start).toHaveBeenCalledOnce();
});
it.each(['failed', 'cancelled'] as const)('preserves native %s evidence instead of claiming a successful reasoning result', async status => {
  const f = fixture(); vi.mocked(f.native.inspect).mockImplementationOnce(async () => ({ record: { status, error: '真实原生失败记录' }, scope: f.state.scope }));
  const result = await f.execute(); expect(result.outcome).toBe(status); expect(result.error).toBe('真实原生失败记录'); expect(JSON.parse(result.result!)).toMatchObject({ status });
  expect(f.native.terminate).not.toHaveBeenCalled(); expect(f.native.start).toHaveBeenCalledOnce();
});
it('reports an actual native operation failure that arrived before a task report or scope was written', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockResolvedValueOnce({ record: { status: 'failed', error: '原生操作启动失败，尚无任务报告。' } });
  const result = await f.execute(); expect(result.outcome).toBe('failed'); expect(result.error).toContain('原生操作启动失败');
  expect(f.native.start).toHaveBeenCalledOnce(); expect(f.native.terminate).not.toHaveBeenCalled();
});
it('waits for missing native metadata and then reads the same actual task rather than replacing it', async () => {
  const f = fixture(); vi.mocked(f.native.inspect).mockResolvedValueOnce({});
  expect((await f.execute()).outcome).toBe('completed'); expect(f.wait).toHaveBeenCalledOnce(); expect(f.native.start).toHaveBeenCalledOnce();
  expect(vi.mocked(f.native.inspect).mock.calls.map(([id]) => id)).toEqual(['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111']);
});
it('makes agenda thought provenance valid but categorically ineligible for session resume/handoff reuse', async () => {
  const f = fixture(); await f.execute(); const thought = dshRecordScopeSchema.parse(f.state.scope);
  const ordinary: DshRecordScope = { actionId: thought.actionId, companionId: 'alice', conversationId: 'own-room', sourceMessageId: 'source' };
  for (const [before, after] of [[thought, thought], [thought, ordinary], [ordinary, thought]] as const)
    expect(() => assertDshResumeScope(before, after, before)).toThrow('new isolated session');
  expect(() => snapshotDshTaskExecution({ ...vi.mocked(f.native.start).mock.calls[0]![1], resumeScope: thought })).toThrow('new session');
  expect(() => assertDshResumeScope(ordinary, ordinary)).not.toThrow();
});
