import { expect, it, vi } from 'vitest';
import { BotBrainRouter, type BotBrain } from '../../src/main/companion-bot/brain-router';
import type { BotDshHandoff, BotDshRun } from '../../src/main/companion-bot/dsh-brain';

const handoff: BotDshHandoff = { format: 'worldlinebox-bot-handoff-v1', laneId: 'lane-one', sessionId: 'fixture', throughEventId: 'event-one', nativeCursor: 1,
  summaryText: '已确认的事实', summarySeq: 1, compactionId: 'compact-one', coveredEventSeqs: [1], tail: [] };
function engine() {
  return {
    run: vi.fn<BotBrain['run']>(async () => ({ text: 'reply', eventId: 'event-one', sessionId: 'fixture', status: 'succeeded' })),
    cancel: vi.fn<BotBrain['cancel']>(async () => undefined), cancelDurable: vi.fn<BotBrain['cancelDurable']>(async () => ({ accepted: true, absent: true })),
    send: vi.fn<BotBrain['send']>(async () => undefined), inspectEffects: vi.fn<BotBrain['inspectEffects']>(async () => []),
    upgradeWorkerAccess: vi.fn<NonNullable<BotBrain['upgradeWorkerAccess']>>(async input => ({ workerAccess: 'full', sessionId: 'same-session', eventId: input.eventId })),
    inspectQuestionAnswers: vi.fn<BotBrain['inspectQuestionAnswers']>(async () => []), handoff: vi.fn<BotBrain['handoff']>(async () => handoff),
    archive: vi.fn<BotBrain['archive']>(async () => undefined), close: vi.fn<BotBrain['close']>(async () => undefined),
  };
}
function fixture(isLegacyNativeLane?: (id: string) => boolean) {
  const app = engine(), worker = engine(); return { app, worker, router: new BotBrainRouter({ app, worker, isLegacyNativeLane }) };
}
const run = (extra: Partial<BotDshRun> = {}): BotDshRun => ({ laneId: 'lane-one', eventId: 'event-one', cwd: 'C:/owned/workspace', system: '伙伴人格', prompt: '你好',
  model: { apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://unused.invalid', apiKey: 'fixture-no-request' }, tools: [], callback: { url: 'http://unused.invalid', token: 'fixture' }, ...extra });
const untouched = (value: ReturnType<typeof engine>) => { for (const mock of Object.values(value)) expect(mock).not.toHaveBeenCalled(); };

it('keeps default conversation, explicit brain and memory encoding off the native worker engine', async () => {
  const f = fixture();
  for (const input of [run(), run({ role: 'brain' }), run({ role: 'brain', laneId: 'memory-encoder-scope-epoch-2-job-one', eventId: 'capture-one', tools: [] })]) {
    await f.router.run(input); expect(f.app.run).toHaveBeenLastCalledWith(input);
  }
  await f.router.archive('memory-encoder-scope-epoch-2-job-one');
  expect(f.app.archive).toHaveBeenCalledWith('memory-encoder-scope-epoch-2-job-one', undefined); untouched(f.worker);
});
it('passes worker execution and host identity through unchanged, independent of the brain binding', async () => {
  const f = fixture(() => true), input = run({ role: 'worker', laneId: 'worker-task-one', eventId: 'work-task-one', instanceId: 'task-owned-host',
    workerAccess: 'full', workerTools: [{ name: 'worker_chat_send_file', description: 'actual files', parameters: {} }], signal: new AbortController().signal });
  await f.router.run(input); expect(f.worker.run.mock.calls[0]?.[0]).toBe(input);
  const implicit = run({ laneId: 'worker-task-two', instanceId: 'another-host' }); await f.router.run(implicit);
  expect(f.worker.run).toHaveBeenLastCalledWith(implicit); untouched(f.app);
});
it('routes roleless durable retirement and handoff to App, but all worker controls remain native', async () => {
  const f = fixture(), brain = run();
  await f.router.cancel('lane-one'); await f.router.cancelDurable(brain); await f.router.handoff(brain); await f.router.archive('lane-one');
  expect(f.app.cancelDurable).toHaveBeenCalledWith(brain, false); expect(f.app.handoff).toHaveBeenCalledWith(brain); untouched(f.worker);
  const worker = run({ laneId: 'worker-task-one', instanceId: 'existing-host' });
  await f.router.cancel(worker.laneId); await f.router.cancelDurable(worker); await f.router.handoff(worker); await f.router.archive(worker.laneId, worker.instanceId);
  expect(f.worker.cancelDurable).toHaveBeenCalledWith(worker, false); expect(f.worker.archive).toHaveBeenCalledWith(worker.laneId, 'existing-host');
  await f.router.cancelDurable(worker, true);
  expect(f.worker.cancelDurable).toHaveBeenLastCalledWith(worker, true);
  expect(f.app.cancelDurable).toHaveBeenCalledTimes(1);
});
it('forwards worker effects, descendant answer proofs and steering without rewriting IDs or cursors', async () => {
  const f = fixture(), effects = { laneId: 'worker-task-one', eventId: 'work-task-one', instanceId: 'bound-host', callIds: ['effect-one'],
    effects: [{ callId: 'effect-one', nativeSessionId: 'child-session', nativeCallId: 'native-one' }] };
  const answers = { laneId: 'worker-task-one', eventId: 'work-task-one', instanceId: 'bound-host', afterOffset: 12, afterOffsets: { 'child-session': 30 },
    questions: [{ questionId: 'question-one', callId: 'call-one', answersHash: 'answer-hash', nativeSessionId: 'child-session', nativeCallId: 'native-question' }] };
  const guidance = { messageId: 'guide-one', text: '依据原输入继续', mode: 'steer' as const };
  await f.router.inspectEffects(effects); await f.router.inspectQuestionAnswers(answers); await f.router.send('worker-task-one', guidance);
  const access = { laneId: effects.laneId, eventId: effects.eventId, cwd: 'C:/owned/workspace', system: 'Original target and restrictions retained.' };
  await f.router.upgradeWorkerAccess(access); expect(f.worker.upgradeWorkerAccess).toHaveBeenCalledWith(access);
  expect(f.worker.inspectEffects.mock.calls[0]?.[0]).toBe(effects); expect(f.worker.inspectQuestionAnswers.mock.calls[0]?.[0]).toBe(answers);
  expect(f.worker.send).toHaveBeenCalledWith('worker-task-one', guidance); untouched(f.app);
});
it('blocks old native brain admissions before App can falsely prove absence, with no automatic Host fallback', async () => {
  const f = fixture(id => id === 'old-native-lane'), input = run({ laneId: 'old-native-lane', instanceId: 'retired-host' });
  for (const operation of [() => f.router.run(input), () => f.router.cancel(input.laneId), () => f.router.cancelDurable(input),
    () => f.router.handoff(input), () => f.router.archive(input.laneId, input.instanceId)]) await expect(operation()).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  untouched(f.app); untouched(f.worker);
});
it('rejects worker inspection on conversation lanes instead of starting native execution', async () => {
  const f = fixture();
  await expect(f.router.inspectEffects({ laneId: 'lane-one', eventId: 'event-one' })).rejects.toMatchObject({ code: 'BOT_BRAIN_ROUTE_INVALID' });
  await expect(f.router.inspectQuestionAnswers({ laneId: 'lane-one', eventId: 'event-one', questions: [] })).rejects.toMatchObject({ code: 'BOT_BRAIN_ROUTE_INVALID' });
  await expect(f.router.send('lane-one', { messageId: 'new', text: 'hello', mode: 'steer' })).rejects.toMatchObject({ code: 'BOT_BRAIN_ROUTE_INVALID' });
  await expect(f.router.upgradeWorkerAccess({ laneId: 'lane-one', eventId: 'event-one', cwd: 'C:/owned/workspace', system: 'not a worker' })).rejects.toMatchObject({ code: 'BOT_BRAIN_ROUTE_INVALID' });
  await expect(f.router.run(run({ role: 'brain', laneId: 'worker-task-one' }))).rejects.toMatchObject({ code: 'BOT_BRAIN_ROUTE_INVALID' });
  untouched(f.app); untouched(f.worker);
});
it('never retries a failed App request on DSH or a failed worker on App', async () => {
  const f = fixture(), appError = new Error('App stream outcome unknown'); f.app.run.mockRejectedValueOnce(appError);
  await expect(f.router.run(run())).rejects.toBe(appError); untouched(f.worker);
  const nativeError = Object.assign(new Error('unknown native effect'), { code: 'BOT_EFFECT_UNKNOWN' }); f.worker.run.mockRejectedValueOnce(nativeError);
  await expect(f.router.run(run({ role: 'worker', laneId: 'worker-task-one' }))).rejects.toBe(nativeError);
  expect(f.app.run).toHaveBeenCalledTimes(1);
});
it('closes both engines once even if one throws synchronously, exposes failures, and fences late calls', async () => {
  const f = fixture(), failure = new Error('App close failed'); f.app.close.mockImplementationOnce(() => { throw failure; });
  await expect(f.router.close()).rejects.toBeInstanceOf(AggregateError);
  expect(f.app.close).toHaveBeenCalledTimes(1); expect(f.worker.close).toHaveBeenCalledTimes(1);
  await expect(f.router.close()).rejects.toBeInstanceOf(AggregateError);
  expect(f.app.close).toHaveBeenCalledTimes(1); expect(f.worker.close).toHaveBeenCalledTimes(1);
  await expect(f.router.run(run())).rejects.toMatchObject({ code: 'BOT_BRAIN_CLOSED' });
});
it('does not start either backend for an already aborted request', async () => {
  const f = fixture(), controller = new AbortController(), reason = new Error('cancel before dispatch'); controller.abort(reason);
  await expect(f.router.run(run({ signal: controller.signal }))).rejects.toBe(reason);
  await expect(f.router.cancelDurable(run({ signal: controller.signal }))).rejects.toBe(reason); untouched(f.app); untouched(f.worker);
});
