import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';
import type { CompanionStorageTiming } from '../../src/shared/companion-storage-timing';
import { currentCompanionStorageOperationHash, withCompanionStorageBackgroundPoll, withCompanionStorageBarrier, withCompanionStorageOperation } from '../../src/main/companions/storage-operation-context';

const transport = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: transport.fork } }));
let client: CompanionStorageClient;
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
let report = vi.fn<(error: Error) => void>();
beforeEach(() => {
  vi.useFakeTimers(); report = vi.fn<(error: Error) => void>();
  transport.fork.mockClear();
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), postMessage: vi.fn(), kill: vi.fn() });
  child.postMessage.mockImplementation(message => {
    if (message.type === 'storage.initialize') child.emit('message', { type: 'storage.ready' });
    if (message.type === 'storage.close') { child.emit('message', { type: 'storage.closed' }); Promise.resolve().then(() => child.emit('exit', 0)); }
  });
  transport.fork.mockImplementation(() => { Promise.resolve().then(() => child.emit('message', { type: 'storage.booted' })); return child; });
  client = new CompanionStorageClient('worker.js', 'messages.sqlite', () => undefined, report);
});
afterEach(async () => {
  child.emit('exit', 0);
  // Lifecycle tests assert close failures in their body; teardown only retires
  // the mock process and must also accept that already-rejected close promise.
  await client.close().catch(() => undefined); vi.useRealTimers();
});

function workerTiming(): CompanionStorageTiming {
  return { receivedEpochMs: 1_000, respondedEpochMs: 1_020, parseMs: 1, runMs: 19, segments: {
    captureExpected: 0, dispatch: 7, capture: 0, experienceProjection: 3, experienceArchive: 2, invalidations: 1,
    recoveryReconcile: 1, recoveryBegin: 1, recoveryPrepare: 2, recoveryCommit: 1, recoveryFinish: 1,
  } };
}
function executionTiming(start: number, elapsed: number): CompanionStorageTiming {
  return { ...workerTiming(), receivedEpochMs: performance.timeOrigin + start,
    respondedEpochMs: performance.timeOrigin + start + elapsed, parseMs: 0, runMs: elapsed };
}

it('keeps one posted background request and correlates timings without exposing its arguments or lane', async () => {
  const onTiming = vi.fn();
  client = new CompanionStorageClient('worker.js', 'messages.sqlite', () => undefined, report, undefined, onTiming);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    await client.start();
    const first = client.request({ type: 'action.get', id: 'private_action' }); await vi.advanceTimersByTimeAsync(0);
    const firstSent = child.postMessage.mock.calls.at(-1)![0];
    clock.mockReturnValue(110);
    const second = client.request({ type: 'message.get', id: 'private_message' }); await vi.advanceTimersByTimeAsync(0);
    expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
    const timing = workerTiming();
    clock.mockReturnValue(140);
    child.emit('message', { requestId: firstSent.requestId, response: { ok: true }, timing });
    await vi.advanceTimersByTimeAsync(0);
    const secondSent = child.postMessage.mock.calls.at(-1)![0];
    child.emit('message', { requestId: firstSent.requestId, response: { ok: true }, timing });
    clock.mockReturnValue(150);
    child.emit('message', { requestId: secondSent.requestId, response: { ok: true }, timing });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(onTiming.mock.calls.map(([event]) => event)).toEqual([
      { commandType: 'action.get', roundTripMs: 40, queueMs: 0, priority: 'background', timing },
      { commandType: 'message.get', roundTripMs: 10, queueMs: 30, priority: 'background', timing },
    ]);
    child.emit('message', { requestId: firstSent.requestId, response: { ok: true }, timing });
    expect(onTiming).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it('settles failed responses despite a throwing timing observer and accepts legacy replies without timing', async () => {
  const onTiming = vi.fn(() => { throw new Error('observer failed'); });
  client = new CompanionStorageClient('worker.js', 'messages.sqlite', () => undefined, report, undefined, onTiming);
  await client.start();
  const failed = client.request({ type: 'action.get', id: 'action_one' }); await vi.advanceTimersByTimeAsync(0);
  const failedSent = child.postMessage.mock.calls.at(-1)![0];
  child.emit('message', { requestId: failedSent.requestId, response: { ok: false, error: 'actual worker failure' }, timing: workerTiming() });
  await expect(failed).resolves.toEqual({ ok: false, error: 'actual worker failure' });
  const legacy = client.request({ type: 'action.get', id: 'action_two' }); await vi.advanceTimersByTimeAsync(0);
  const legacySent = child.postMessage.mock.calls.at(-1)![0];
  child.emit('message', { requestId: legacySent.requestId, response: { ok: true } });
  await expect(legacy).resolves.toEqual({ ok: true });
  expect(onTiming).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
});

it('keeps enqueue operation hashes through out-of-context replies without sending lanes or hashes over IPC', async () => {
  const onTiming = vi.fn();
  client = new CompanionStorageClient('worker.js', 'messages.sqlite', () => undefined, report, undefined, onTiming);
  await client.start();
  let foregroundHash: string | undefined, backgroundHash: string | undefined;
  const foreground = withCompanionStorageOperation({ priority: 'interactive', lane: 'PRIVATE_FOREGROUND_LANE' }, () => {
    foregroundHash = currentCompanionStorageOperationHash(); return client.request({ type: 'message.get', id: 'private_source' });
  });
  const background = withCompanionStorageOperation({ priority: 'background', lane: 'PRIVATE_BACKGROUND_LANE' }, () => {
    backgroundHash = currentCompanionStorageOperationHash(); return client.request({ type: 'action.get', id: 'private_action' });
  });
  await vi.advanceTimersByTimeAsync(1); expect(currentCompanionStorageOperationHash()).toBeUndefined();
  const sent = child.postMessage.mock.calls.filter(([message]) => message.command).map(([message]) => message);
  expect(sent).toHaveLength(2); expect(foregroundHash).not.toBe(backgroundHash);
  for (const message of sent) {
    expect(Object.keys(message).sort()).toEqual(['command', 'requestId']);
    expect(JSON.stringify(message)).not.toMatch(/PRIVATE_FOREGROUND_LANE|PRIVATE_BACKGROUND_LANE|storageOperationHash/u);
    expect(JSON.stringify(message)).not.toContain(foregroundHash!); expect(JSON.stringify(message)).not.toContain(backgroundHash!);
    child.emit('message', { requestId: message.requestId, response: { ok: true }, timing: workerTiming() });
  }
  await expect(Promise.all([foreground, background])).resolves.toEqual([{ ok: true }, { ok: true }]);
  expect(onTiming.mock.calls.map(([event]) => [event.commandType, event.storageOperationHash])).toEqual([
    ['message.get', foregroundHash], ['action.get', backgroundHash],
  ]);
  expect(JSON.stringify(onTiming.mock.calls)).not.toMatch(/PRIVATE_FOREGROUND_LANE|PRIVATE_BACKGROUND_LANE|private_source|private_action/u);
});

it('forwards validated queued-publication owners separately from hard source-change flags', async () => {
  const changed = vi.fn();
  client = new CompanionStorageClient('worker.js', 'messages.sqlite', changed, report);
  await client.start();
  child.emit('message', { type: 'storage.retire-changed', memorySourcePublicationQueuedCompanionIds: ['alice', 'alice', '../private', 'bob'],
    memorySourceChangedCompanionIds: ['bob'] });
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ memorySourcePublicationQueuedCompanionIds: ['alice', 'bob'], memorySourceChangedCompanionIds: ['bob'] }));
});

it('budgets actual background execution through preparation RPC gaps and wakes it without disabling its work', async () => {
  const epoch = Date.now(), clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
  try {
    await client.start(); const release = client.acquireForegroundPreparation();
    const first = client.request({ type: 'action.get', id: 'background_one' }); await vi.advanceTimersByTimeAsync(1);
    const sent = child.postMessage.mock.calls.at(-1)![0];
    const second = client.request({ type: 'action.get', id: 'background_two' });
    await vi.advanceTimersByTimeAsync(100);
    child.emit('message', { requestId: sent.requestId, response: { ok: true }, timing: executionTiming(1, 100) }); await first;
    const foreground = withCompanionStorageOperation({ priority: 'interactive' }, () => client.request({ type: 'message.get', id: 'foreground' }));
    await vi.advanceTimersByTimeAsync(1); const interactive = child.postMessage.mock.calls.at(-1)![0];
    expect(interactive.command.id).toBe('foreground');
    child.emit('message', { requestId: interactive.requestId, response: { ok: true }, timing: executionTiming(102, 0) }); await foreground;
    await vi.advanceTimersByTimeAsync(500);
    expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(400);
    const resumed = child.postMessage.mock.calls.at(-1)![0]; expect(resumed.command.id).toBe('background_two');
    child.emit('message', { requestId: resumed.requestId, response: { ok: true }, timing: executionTiming(900, 0) }); await second;
    release();
  } finally { clock.mockRestore(); }
});

it('keeps independent recipient scopes until their own idempotent release and resets debt after the last scope', async () => {
  const epoch = Date.now(), clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
  try {
    await client.start(); const releaseFirst = client.acquireForegroundPreparation();
    const first = client.request({ type: 'action.get', id: 'first' }); await vi.advanceTimersByTimeAsync(1);
    const sent = child.postMessage.mock.calls.at(-1)![0]; await vi.advanceTimersByTimeAsync(200);
    child.emit('message', { requestId: sent.requestId, response: { ok: true }, timing: executionTiming(1, 200) }); await first;
    const releaseSecond = client.acquireForegroundPreparation(), second = client.request({ type: 'action.get', id: 'second' });
    releaseFirst(); releaseFirst(); await vi.advanceTimersByTimeAsync(1);
    expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
    releaseSecond(); await vi.advanceTimersByTimeAsync(1);
    const resumed = child.postMessage.mock.calls.at(-1)![0]; expect(resumed.command.id).toBe('second');
    child.emit('message', { requestId: resumed.requestId, response: { ok: true }, timing: executionTiming(202, 0) }); await second;
    const freshRelease = client.acquireForegroundPreparation(), third = client.request({ type: 'action.get', id: 'fresh' });
    await vi.advanceTimersByTimeAsync(1); const fresh = child.postMessage.mock.calls.at(-1)![0]; expect(fresh.command.id).toBe('fresh');
    child.emit('message', { requestId: fresh.requestId, response: { ok: true }, timing: executionTiming(203, 0) }); await third; freshRelease();
  } finally { clock.mockRestore(); }
});

it('keeps a timed-out background credit until its real reply and charges that actual execution', async () => {
  const epoch = Date.now(), clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
  try {
    await client.start(); const release = client.acquireForegroundPreparation();
    const first = client.request({ type: 'action.get', id: 'unknown' }), rejected = expect(first).rejects.toThrow('执行状态尚未确认');
    await vi.advanceTimersByTimeAsync(1); const sent = child.postMessage.mock.calls.at(-1)![0];
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    const second = client.request({ type: 'action.get', id: 'waiting' }); await vi.advanceTimersByTimeAsync(1);
    expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
    child.emit('message', { requestId: sent.requestId, response: { ok: true }, timing: executionTiming(29_902, 100) });
    await vi.advanceTimersByTimeAsync(1); expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
    release(); await vi.advanceTimersByTimeAsync(1); const resumed = child.postMessage.mock.calls.at(-1)![0];
    expect(resumed.command.id).toBe('waiting'); child.emit('message', { requestId: resumed.requestId, response: { ok: true } }); await second;
  } finally { clock.mockRestore(); }
});

it('clears preparation budget wakes on close without late posting or cross-recipient releases', async () => {
  const epoch = Date.now(), clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
  try {
    await client.start(); const release = client.acquireForegroundPreparation();
    const first = client.request({ type: 'action.get', id: 'first' }); await vi.advanceTimersByTimeAsync(1);
    const sent = child.postMessage.mock.calls.at(-1)![0]; await vi.advanceTimersByTimeAsync(100);
    child.emit('message', { requestId: sent.requestId, response: { ok: true }, timing: executionTiming(1, 100) }); await first;
    const second = client.request({ type: 'action.get', id: 'never_posted' }), rejected = expect(second).rejects.toThrow('尚未派发、未执行');
    await vi.advanceTimersByTimeAsync(1); await client.close(); await rejected;
    release(); release(); await vi.advanceTimersByTimeAsync(5000);
    expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  } finally { clock.mockRestore(); }
});

it('settles a lost request after 30 seconds without replaying a mutation or killing its still-running worker', async () => {
  await client.start();
  const pending = client.request({ type: 'action.update', id: 'action_one', patch: { stage: '正在准备' } });
  const rejected = expect(pending).rejects.toThrow('action.update 等待超过 30 秒');
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  expect(report).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled();
  const sent = child.postMessage.mock.calls.find(([message]) => message.command)?.[0];
  child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
  const next = client.request({ type: 'action.get', id: 'action_one' }); await vi.advanceTimersByTimeAsync(0);
  const latest = child.postMessage.mock.calls.at(-1)![0];
  child.emit('message', { requestId: latest.requestId, response: { ok: true } });
  await expect(next).resolves.toEqual({ ok: true });
});

it('clears completed and closed request timers', async () => {
  await client.start();
  const completed = client.request({ type: 'action.get', id: 'action_one' }); await vi.advanceTimersByTimeAsync(0);
  const sent = child.postMessage.mock.calls.at(-1)![0];
  child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  await expect(completed).resolves.toEqual({ ok: true });
  const pending = client.request({ type: 'action.get', id: 'action_two' });
  const rejected = expect(pending).rejects.toThrow('尚未派发、未执行'); await Promise.resolve();
  await client.close(); await rejected;
  await vi.advanceTimersByTimeAsync(60_000); expect(report).not.toHaveBeenCalled();
});

it('lets resolved foreground microtasks enqueue their next read before selecting a queued background read', async () => {
  await client.start();
  const first = withCompanionStorageOperation({ priority: 'interactive', lane: 'foreground' }, () => client.request({ type: 'message.get', id: 'one' }));
  await vi.advanceTimersByTimeAsync(0); const firstSent = child.postMessage.mock.calls.at(-1)![0];
  const background = withCompanionStorageOperation({ priority: 'background', lane: 'background' }, () => client.request({ type: 'message.get', id: 'background' }));
  const continued = first.then(() => withCompanionStorageOperation({ priority: 'interactive', lane: 'foreground' }, () => client.request({ type: 'message.get', id: 'two' })));
  child.emit('message', { requestId: firstSent.requestId, response: { ok: true } }); await vi.advanceTimersByTimeAsync(1);
  const next = child.postMessage.mock.calls.filter(([message]) => message.command).slice(1).map(([message]) => message);
  expect(next.map(message => message.command.id)).toEqual(['two', 'background']);
  for (const sent of next) child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  await continued; await background;
});

it('does not let a control cancellation or later query overtake its earlier action creation', async () => {
  await client.start();
  const create = withCompanionStorageOperation({ priority: 'background', lane: 'task' }, () => client.request({ type: 'action.create',
    action: { companionId: 'alice', conversationId: 'room', sourceMessageId: 'source', title: 'actual task', status: 'queued' }, checkpoint: { prompt: 'actual task' } }));
  const cancel = withCompanionStorageOperation({ priority: 'control', lane: 'task' }, () => client.request({ type: 'action.update', id: 'actual_action', patch: { status: 'cancelled' } }));
  const query = withCompanionStorageOperation({ priority: 'interactive' }, () => client.request({ type: 'message.get', id: 'later' }));
  for (const expected of ['action.create', 'action.update', 'message.get']) {
    await vi.advanceTimersByTimeAsync(1);
    const sent = child.postMessage.mock.calls.at(-1)![0]; expect(sent.command.type).toBe(expected);
    child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  }
  await Promise.all([create, cancel, query]);
});

it.each([false, true])('keeps paid world checks as barriers and lets only marked polls yield (poll=%s)', async poll => {
  await client.start();
  const world = withCompanionStorageOperation({ priority: 'background', lane: 'world' }, () => {
    const request = () => client.request({ type: 'world.job.check', id: 'job', leaseToken: 'lease' });
    return poll ? withCompanionStorageBackgroundPoll(request) : request();
  });
  const foreground = withCompanionStorageOperation({ priority: 'interactive' }, () => client.request({ type: 'message.get', id: 'foreground' }));
  for (const type of poll ? ['message.get', 'world.job.check'] : ['world.job.check', 'message.get']) {
    await vi.advanceTimersByTimeAsync(1); const sent = child.postMessage.mock.calls.at(-1)![0]; expect(sent.command.type).toBe(type);
    child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  }
  await Promise.all([world, foreground]);
});

it('never posts expired queued work and keeps a posted timeout unknown until its real reply', async () => {
  await client.start();
  const posted = client.request({ type: 'action.update', id: 'one', patch: { stage: 'running' } });
  const postedRejected = expect(posted).rejects.toThrow('执行状态尚未确认'); await vi.advanceTimersByTimeAsync(0);
  const sent = child.postMessage.mock.calls.at(-1)![0];
  const queued = client.request({ type: 'message.get', id: 'expired' });
  const queuedRejected = expect(queued).rejects.toMatchObject({ notDispatched: true });
  await vi.advanceTimersByTimeAsync(30_000); await postedRejected; await queuedRejected;
  const next = client.request({ type: 'message.get', id: 'next' }); await vi.advanceTimersByTimeAsync(0);
  expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
  child.emit('message', { requestId: sent.requestId, response: { ok: true } }); await vi.advanceTimersByTimeAsync(0);
  const latest = child.postMessage.mock.calls.at(-1)![0]; expect(latest.command.id).toBe('next');
  child.emit('message', { requestId: latest.requestId, response: { ok: true } }); await next;
  expect(child.postMessage.mock.calls.some(([message]) => message.command?.id === 'expired')).toBe(false);
});

it('waits for the posted operation to settle before close and rejects only the unposted queue', async () => {
  await client.start();
  const active = client.request({ type: 'message.get', id: 'active' }); await vi.advanceTimersByTimeAsync(0);
  const sent = child.postMessage.mock.calls.at(-1)![0];
  const queued = client.request({ type: 'message.get', id: 'queued' }); const rejected = expect(queued).rejects.toMatchObject({ notDispatched: true });
  await Promise.resolve(); const closing = client.close(); await rejected;
  expect(child.postMessage.mock.calls.some(([message]) => message.type === 'storage.close')).toBe(false);
  child.emit('message', { requestId: sent.requestId, response: { ok: true } }); await active; await closing;
  expect(child.postMessage.mock.calls.at(-1)![0]).toEqual({ type: 'storage.close' }); expect(child.kill).not.toHaveBeenCalled();
});

it('requires a real exit after a forced shutdown and never treats kill as completed SQL', async () => {
  await client.start();
  const active = client.request({ type: 'message.get', id: 'unknown' }); const rejected = expect(active).rejects.toThrow('执行状态尚未确认');
  await vi.advanceTimersByTimeAsync(0);
  let closed = false; const closing = client.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  expect(child.kill).toHaveBeenCalledOnce(); expect(closed).toBe(false);
  expect(child.postMessage.mock.calls.some(([message]) => message.type === 'storage.close')).toBe(false);
  child.emit('exit', 0); await closing; expect(closed).toBe(true);
});

it('refuses a replacement worker after a fatal reply until the old worker actually exits', async () => {
  await client.start();
  const active = client.request({ type: 'message.get', id: 'unknown' }); const rejected = expect(active).rejects.toThrow('无效响应');
  await vi.advanceTimersByTimeAsync(0); child.emit('message', { unexpected: true }); await rejected;
  await expect(client.start()).rejects.toThrow('尚未确认退出'); expect(transport.fork).toHaveBeenCalledTimes(1);
  child.emit('exit', 1);
});

it('rejects forced close as unknown if a killed worker never confirms exit', async () => {
  await client.start();
  const active = client.request({ type: 'message.get', id: 'unknown' }); const requestRejected = expect(active).rejects.toThrow('执行状态尚未确认');
  await vi.advanceTimersByTimeAsync(0);
  const closing = client.close(); const closeRejected = expect(closing).rejects.toThrow('尚未确认退出');
  await vi.advanceTimersByTimeAsync(35_000); await requestRejected; await closeRejected;
  await expect(client.start()).rejects.toThrow('正在关闭'); expect(transport.fork).toHaveBeenCalledOnce();
  expect(child.postMessage.mock.calls.some(([message]) => message.type === 'storage.close')).toBe(false);
});

it('keeps a throwing post transport unknown instead of dispatching another request behind it', async () => {
  await client.start(); const original = child.postMessage.getMockImplementation() as (message: unknown) => void;
  child.postMessage.mockImplementation(message => { if (message.command?.id === 'uncertain') throw new Error('transport uncertain'); original(message); });
  const uncertain = client.request({ type: 'message.get', id: 'uncertain' }); const rejected = expect(uncertain).rejects.toThrow('派发状态无法确认');
  await vi.advanceTimersByTimeAsync(0); await rejected; const sent = child.postMessage.mock.calls.at(-1)![0];
  const next = client.request({ type: 'message.get', id: 'next' }); await vi.advanceTimersByTimeAsync(0);
  expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
  child.emit('message', { requestId: sent.requestId, response: { ok: true } }); await vi.advanceTimersByTimeAsync(0);
  const latest = child.postMessage.mock.calls.at(-1)![0]; expect(latest.command.id).toBe('next');
  child.emit('message', { requestId: latest.requestId, response: { ok: true } }); await next;
});

it('refuses over-capacity unposted requests without leaving hidden work to dispatch later', async () => {
  await client.start();
  const queued = Array.from({ length: 256 }, (_, n) => client.request({ type: 'message.get', id: 'queued_' + n }));
  const settled = Promise.allSettled(queued); await Promise.resolve();
  await expect(client.request({ type: 'message.get', id: 'capacity_excess' })).rejects.toMatchObject({ notDispatched: true });
  await client.close(); expect((await settled).every(result => result.status === 'rejected' && result.reason.notDispatched === true)).toBe(true);
  await vi.advanceTimersByTimeAsync(0); expect(child.postMessage.mock.calls.some(([message]) => message.command)).toBe(false);
});

it('can post two strict foreground queries and drains both actual replies before closing', async () => {
  await client.start();
  const first = withCompanionStorageOperation({ priority: 'interactive', lane: 'first' }, () => client.request({ type: 'message.get', id: 'first' }));
  const second = withCompanionStorageOperation({ priority: 'interactive', lane: 'second' }, () => client.request({ type: 'message.get', id: 'second' }));
  await vi.advanceTimersByTimeAsync(1);
  const sent = child.postMessage.mock.calls.filter(([message]) => message.command).map(([message]) => message); expect(sent).toHaveLength(2);
  const unposted = client.request({ type: 'message.get', id: 'unposted' }); const rejected = expect(unposted).rejects.toMatchObject({ notDispatched: true });
  await Promise.resolve(); const closing = client.close(); await rejected;
  child.emit('message', { requestId: sent[1].requestId, response: { ok: true } }); await second;
  expect(child.postMessage.mock.calls.some(([message]) => message.type === 'storage.close')).toBe(false);
  child.emit('message', { requestId: sent[0].requestId, response: { ok: true } }); await first; await closing;
  expect(child.postMessage.mock.calls.at(-1)![0]).toEqual({ type: 'storage.close' });
});

it('retains both timed-out pure credits and never posts a later write before both real settlements', async () => {
  await client.start();
  const first = withCompanionStorageOperation({ priority: 'interactive' }, () => client.request({ type: 'message.get', id: 'first' }));
  const second = withCompanionStorageOperation({ priority: 'interactive' }, () => client.request({ type: 'message.get', id: 'second' }));
  const firstRejected = expect(first).rejects.toThrow('执行状态尚未确认'), secondRejected = expect(second).rejects.toThrow('执行状态尚未确认');
  await vi.advanceTimersByTimeAsync(1); const sent = child.postMessage.mock.calls.filter(([message]) => message.command).map(([message]) => message);
  expect(sent).toHaveLength(2); await vi.advanceTimersByTimeAsync(30_000); await firstRejected; await secondRejected;
  const write = withCompanionStorageOperation({ priority: 'control' }, () => client.request({ type: 'action.update', id: 'action', patch: { status: 'cancelled' } }));
  const later = withCompanionStorageOperation({ priority: 'interactive' }, () => client.request({ type: 'message.get', id: 'later' }));
  child.emit('message', { requestId: sent[0].requestId, response: { ok: true } }); await vi.advanceTimersByTimeAsync(1);
  expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(2);
  child.emit('message', { requestId: sent[1].requestId, response: { ok: true } }); await vi.advanceTimersByTimeAsync(1);
  let current = child.postMessage.mock.calls.at(-1)![0]; expect(current.command.type).toBe('action.update');
  child.emit('message', { requestId: current.requestId, response: { ok: true } }); await write; await vi.advanceTimersByTimeAsync(1);
  current = child.postMessage.mock.calls.at(-1)![0]; expect(current.command.id).toBe('later');
  child.emit('message', { requestId: current.requestId, response: { ok: true } }); await later;
});

it('prioritizes a final pure read over old independent background reads without crossing a prior write', async () => {
  await client.start();
  const background = withCompanionStorageOperation({ priority: 'background' }, () => client.request({ type: 'message.get', id: 'background' }));
  const final = withCompanionStorageOperation({ priority: 'interactive' }, () => withCompanionStorageBarrier(() => client.request({ type: 'message.get', id: 'final' })));
  await vi.advanceTimersByTimeAsync(1); let sent = child.postMessage.mock.calls.filter(([message]) => message.command).map(([message]) => message);
  expect(sent.map(message => message.command.id)).toEqual(['final', 'background']);
  for (const message of sent) child.emit('message', { requestId: message.requestId, response: { ok: true } }); await Promise.all([background, final]);
  const write = withCompanionStorageOperation({ priority: 'background' }, () => client.request({ type: 'action.update', id: 'action', patch: { status: 'cancelled' } }));
  const after = withCompanionStorageOperation({ priority: 'control' }, () => withCompanionStorageBarrier(() => client.request({ type: 'message.get', id: 'after' })));
  await vi.advanceTimersByTimeAsync(1); let current = child.postMessage.mock.calls.at(-1)![0]; expect(current.command.type).toBe('action.update');
  sent = child.postMessage.mock.calls.filter(([message]) => message.command).map(([message]) => message); expect(sent).toHaveLength(3);
  child.emit('message', { requestId: current.requestId, response: { ok: true } }); await write; await vi.advanceTimersByTimeAsync(1);
  current = child.postMessage.mock.calls.at(-1)![0]; expect(current.command.id).toBe('after');
  child.emit('message', { requestId: current.requestId, response: { ok: true } }); await after;
});

it('does not treat a normal close ACK as process exit before a replacement or recovery may start', async () => {
  await client.start();
  child.postMessage.mockImplementation(message => { if (message.type === 'storage.close') child.emit('message', { type: 'storage.closed' }); });
  let closed = false; const closing = client.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false); expect(child.kill).not.toHaveBeenCalled();
  child.emit('exit', 0); await closing; expect(closed).toBe(true);
});

it('keeps an ACKed but unexited process retired and reports unknown instead of safe close', async () => {
  await client.start();
  child.postMessage.mockImplementation(message => { if (message.type === 'storage.close') child.emit('message', { type: 'storage.closed' }); });
  const closing = client.close(), rejected = expect(closing).rejects.toThrow('尚未确认退出');
  await vi.advanceTimersByTimeAsync(5_000); await rejected;
  await expect(client.start()).rejects.toThrow('正在关闭'); expect(transport.fork).toHaveBeenCalledOnce();
});
