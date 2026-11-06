import { expect, it } from 'vitest';
import { BotDshBrain, BotDshAbortAcknowledgedError, BotDshDeliveryUnknownError, BotDshLaneBusyError, BotDshOutputLimitError, BotDshTurnFailedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { NativeHostClient } from '../../src/main/dsh/native-host-client';
import { DshHostUnavailableError } from '../../src/main/dsh/host-errors';

const input: BotDshRun = { laneId: 'lane', eventId: 'event', cwd: 'C:/bot-test', system: 'Test persona', prompt: 'Test input',
  model: { apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' },
  tools: [], callback: { url: 'http://127.0.0.1/bot/tool', token: 'a'.repeat(64) } };
const succeeded = (eventId: string, sessionId: string) => ({ text: 'done', eventId, sessionId, status: 'succeeded' });

it('holds a private Host lease through native work and releases it on success, attachment failure and inspection failure', async () => {
  let leases = 0, mode: 'success' | 'failure' = 'success';
  const client = { request: async (endpoint: string, body: Record<string, string>) => {
    expect(leases).toBe(1);
    if (mode === 'failure') throw new Error('native unavailable');
    if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
    return { accepted: true, result: succeeded(body.eventId!, 'session') };
  } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client, instance: { id: 'private' } }),
    acquireLease: host => { expect(host.instance?.id).toBe('private'); leases++; return () => { leases--; }; } });
  await brain.run(input); expect(leases).toBe(0);
  mode = 'failure'; await expect(brain.run(input)).rejects.toThrow(); expect(leases).toBe(0);
  await expect(brain.inspectEffects({ laneId: input.laneId, eventId: input.eventId })).rejects.toThrow(); expect(leases).toBe(0);
  await expect(brain.cancelDurable(input)).rejects.toThrow(); expect(leases).toBe(0);
});

it('keeps a guidance lease alive after the native turn completes while its input acknowledgement is still in flight', async () => {
  let leases = 0, ready!: () => void, complete!: () => void, releaseInput!: () => void;
  const running = new Promise<void>(resolve => { ready = resolve; }), terminal = new Promise<void>(resolve => { complete = resolve; }), pendingInput = new Promise<void>(resolve => { releaseInput = resolve; });
  const client = { request: async (endpoint: string, body: Record<string, string>) => {
    if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
    if (endpoint.endsWith('/input')) { await pendingInput; return { accepted: true }; }
    return { accepted: true };
  }, async *events() { ready(); await terminal; yield { type: 'complete', eventId: input.eventId, status: 'succeeded', text: 'done' }; } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client }), acquireLease: () => { leases++; return () => { leases--; }; } });
  const turn = brain.run(input); await running;
  const guidance = brain.send(input.laneId, { messageId: 'new-guidance', text: '已授权的补充', mode: 'steer' });
  expect(leases).toBe(2); complete(); await turn; expect(leases).toBe(1);
  releaseInput(); await guidance; expect(leases).toBe(0);
});

it('distinguishes durable terminal failures from an unknown delivery outcome', async () => {
  let replay = false;
  const client = { request: async (endpoint: string, body: Record<string, string>) => endpoint === '/bot/lanes'
    ? { sessionId: body.sessionId, cursor: 0 }
    : replay ? { accepted: true, result: { ...succeeded(body.eventId!, 'session'), status: 'failed', text: 'partial', error: 'HTTP 402' } } : { accepted: true },
  async *events() { yield { type: 'complete', eventId: input.eventId, status: 'failed', error: 'HTTP 402', text: 'partial' }; } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  for (const mode of [false, true]) {
    replay = mode;
    const error = await brain.run(input).catch(value => value);
    expect(error).toBeInstanceOf(BotDshTurnFailedError);
    expect(error).toMatchObject({ code: 'BOT_TERMINAL_FAILED', eventId: input.eventId, partialText: 'partial' });
  }
  const unknown = { ...client, events: async function* () {} } as unknown as NativeHostClient;
  replay = false;
  await expect(new BotDshBrain({ getHost: async () => ({ client: unknown }) }).run(input)).rejects.toBeInstanceOf(BotDshDeliveryUnknownError);
});

it('awaits cancellation acknowledgement only for its own lane', async () => {
  let cancelAck!: () => void, admitted!: () => void;
  const stop = new Promise<void>(resolve => { cancelAck = resolve; });
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  const openings: string[] = [];
  const client = { request: async (endpoint: string, body: Record<string, string>) => {
    if (endpoint === '/bot/lanes') { openings.push(body.laneId!); return { sessionId: body.sessionId, cursor: 0 }; }
    if (endpoint.endsWith('/cancel')) { await stop; return { accepted: true, result: { ...succeeded(body.eventId!, BotDshBrain.sessionId(input.laneId)), status: 'cancelled' } }; }
    if (body.eventId === 'first') { admitted(); return { accepted: true }; }
    return { accepted: true, result: succeeded(body.eventId!, 'session') };
  }, async *events(_sessionId: string, _cursor: number, signal: AbortSignal) {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    yield* [];
    throw signal.reason;
  } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client }) }), abort = new AbortController();
  const first = brain.run({ ...input, eventId: 'first', signal: abort.signal }).catch(error => error);
  await ready; abort.abort(new Error('User stop'));
  const sameLane = brain.run({ ...input, eventId: 'second' });
  expect((await brain.run({ ...input, laneId: 'other', eventId: 'other' })).text).toBe('done');
  expect(openings).toEqual(['lane', 'other']);
  cancelAck(); await first; expect((await sameLane).text).toBe('done'); expect(openings).toEqual(['lane', 'other', 'lane']);
});

it('reports native maintenance contention as retryable lane busy', async () => {
  const client = { request: async () => { throw new Error('The companion lane has an active maintenance admission.'); } } as unknown as NativeHostClient;
  await expect(new BotDshBrain({ getHost: async () => ({ client }) }).run(input)).rejects.toBeInstanceOf(BotDshLaneBusyError);
});

it('retains an unknown attachment outcome instead of treating a potentially resumed native inbox as failed', async () => {
  const client = { request: async () => { throw new Error('Host attachment disconnected'); } } as unknown as NativeHostClient;
  await expect(new BotDshBrain({ getHost: async () => ({ client }) }).run(input)).rejects.toBeInstanceOf(BotDshDeliveryUnknownError);
});

it('retains the failed native admission stage and original cause for recovery diagnostics', async () => {
  const failure = new Error('Native profile could not attach this lane.');
  const client = { request: async () => { throw failure; } } as unknown as NativeHostClient;
  expect(await new BotDshBrain({ getHost: async () => ({ client }) }).run(input).catch(error => error))
    .toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'attach', cause: failure });
  expect(await new BotDshBrain({ getHost: async () => { throw failure; } }).run(input).catch(error => error))
    .toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'startup', cause: failure });
});

it('exposes only a durable exact output checkpoint and forwards its explicit continuation', async () => {
  let streamed = false;
  const client = { request: async (endpoint: string, body: Record<string, unknown>) => {
    if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
    expect(body.continueAfterSeq).toBe(71);
    return streamed ? { accepted: true } : { accepted: true, result: { ...succeeded(input.eventId, 'session'), status: 'failed', outputCheckpoint: 71, text: 'saved progress' } };
  }, async *events() { yield { type: 'complete', eventId: input.eventId, status: 'failed', outputCheckpoint: 71, text: 'saved progress', inputContextCommitted: true }; } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  for (const mode of [false, true]) {
    streamed = mode;
    const error = await brain.run({ ...input, continueAfterSeq: 71 }).catch(value => value);
    expect(error).toBeInstanceOf(BotDshOutputLimitError);
    expect(error).toMatchObject({ code: 'BOT_OUTPUT_LIMIT', checkpoint: 71, partialText: 'saved progress' });
  }
});

it('recovers a durable cancel without submitting the original prompt and requires a terminal or explicit absent proof', async () => {
  const calls: string[] = []; let absent = true;
  const client = { request: async (endpoint: string, body: Record<string, unknown>) => {
    calls.push(endpoint); expect(body).not.toHaveProperty('prompt');
    if (endpoint === '/bot/cancel') return absent ? { accepted: false, absent: true, sessionId: body.sessionId, eventId: body.eventId } : { requiresAttachment: true };
    if (endpoint === '/bot/lanes') { expect(body.cancelIntent).toBe(true); return {}; }
    return absent ? { accepted: false, absent: true } : { accepted: false };
  } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  expect(await brain.cancelDurable(input)).toMatchObject({ accepted: false, absent: true, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) });
  expect(calls).toEqual(['/bot/cancel']);
  expect(calls.some(endpoint => endpoint.endsWith('/turn'))).toBe(false);
  absent = false; await expect(brain.cancelDurable(input)).rejects.toBeInstanceOf(BotDshDeliveryUnknownError);
});

it('does not convert a failed Host lookup during cancellation into a proved worker failure', async () => {
  const error = new Error('Native Host is currently stopped.');
  const brain = new BotDshBrain({ getHost: async () => { throw error; } });
  await expect(brain.cancelDurable(input)).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'startup', cause: error });
});

it('preserves Host unavailability before native admission and never reclassifies it as unknown delivery', async () => {
  for (const reason of ['configuration', 'stopped', 'startup', 'closing'] as const) {
    const failure = new DshHostUnavailableError(reason, 'Host unavailable', 'private-host');
    const brain = new BotDshBrain({ getHost: async () => { throw failure; } });
    await expect(brain.run(input)).rejects.toBe(failure);
    await expect(brain.cancelDurable(input)).rejects.toBe(failure);
    await expect(brain.inspectEffects(input)).rejects.toBe(failure);
    await expect(brain.inspectQuestionAnswers({ ...input, questions: [] })).rejects.toBe(failure);
    await expect(brain.upgradeWorkerAccess(input)).rejects.toBe(failure);
    await expect(brain.archive(input.laneId)).rejects.toBe(failure);
  }
});

it('grants explicit Host startup only to a resumed turn, keeping archive and control requests automatic', async () => {
  const options: Array<{ explicit?: boolean } | undefined> = [];
  const client = { request: async (endpoint: string, body: Record<string, string>) => endpoint === '/bot/lanes'
    ? { sessionId: body.sessionId, cursor: 0 } : { accepted: true, result: succeeded(body.eventId!, BotDshBrain.sessionId(input.laneId)) } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async (_instance, _signal, _lane, value) => { options.push(value); return { client }; } });
  await brain.run(input); await brain.run({ ...input, resumeHost: true }); await brain.archive(input.laneId);
  expect(options).toEqual([{ explicit: false }, { explicit: true }, undefined]);
});

it('reconnects a failed cancel using its original event proof before admitting the same or a later event', async () => {
  for (const nextEventId of [input.eventId, 'later-event']) {
    const original = { ...input, instanceId: 'original-host', cwd: 'C:/original-task' }, abort = new AbortController();
    let ready!: () => void;
    const admitted = new Promise<void>(resolve => { ready = resolve; });
    const firstClient = { request: async (endpoint: string, body: Record<string, string>) => {
      if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
      if (endpoint.endsWith('/cancel')) throw Error('cancel response was lost');
      ready(); return { accepted: true };
    }, async *events(_session: string, _cursor: number, signal: AbortSignal) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      yield* []; throw signal.reason;
    } } as unknown as NativeHostClient;
    const recoveredCalls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    let lookup = 0, unavailable = true, hostStopped = false;
    const explicitStartups: Array<boolean | undefined> = [];
    const sessionId = BotDshBrain.sessionId(input.laneId), receipt = { ...succeeded(original.eventId, sessionId), status: 'cancelled', text: 'original stopped' };
    const recoveredClient = { request: async (endpoint: string, body: Record<string, unknown>) => {
      recoveredCalls.push({ endpoint, body });
      if (endpoint === '/bot/cancel') {
        expect(body).toMatchObject({ eventId: original.eventId, cwd: original.cwd }); expect(body).not.toHaveProperty('prompt');
        if (unavailable) throw Error('inspection temporarily disconnected');
        return { requiresAttachment: true };
      }
      if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
      if (endpoint.endsWith('/cancel')) { expect(body.eventId).toBe(original.eventId); return { accepted: true, result: receipt }; }
      return { accepted: true, result: body.eventId === original.eventId ? receipt : succeeded(String(body.eventId), sessionId) };
    } } as unknown as NativeHostClient;
    const brain = new BotDshBrain({ getHost: async (instanceId, _signal, _laneId, options) => {
      expect(instanceId).toBe(original.instanceId); explicitStartups.push(options?.explicit);
      if (hostStopped && !options?.explicit) throw new DshHostUnavailableError('stopped', 'Explicitly stopped Host', original.instanceId);
      if (options?.explicit) hostStopped = false;
      return { client: ++lookup === 1 ? firstClient : recoveredClient };
    } });
    const first = brain.run({ ...original, signal: abort.signal }).catch(error => error);
    await admitted; abort.abort(new Error('stop interrupted native stream'));
    expect(await first).toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'cancel' });
    const next = { ...original, eventId: nextEventId, cwd: 'C:/current-task', prompt: 'current user request' };
    await expect(brain.run(next)).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'cancel' });
    expect(recoveredCalls.some(call => call.endpoint.endsWith('/turn'))).toBe(false);
    unavailable = false; hostStopped = true;
    await expect(brain.run(next)).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'stopped' });
    expect(recoveredCalls.some(call => call.endpoint.endsWith('/turn'))).toBe(false);
    const completed = await brain.run({ ...next, resumeHost: true });
    expect(completed).toMatchObject({ eventId: nextEventId, status: nextEventId === original.eventId ? 'cancelled' : 'succeeded' });
    const turn = recoveredCalls.findIndex(call => call.endpoint.endsWith('/turn')), cancel = recoveredCalls.findIndex(call => call.endpoint.startsWith('/bot/lanes/') && call.endpoint.endsWith('/cancel'));
    expect(turn).toBeGreaterThan(cancel); expect(cancel).toBeGreaterThan(0);
    expect(recoveredCalls.filter(call => call.endpoint.endsWith('/turn'))).toHaveLength(1);
    expect(recoveredCalls[turn]!.body).toMatchObject({ eventId: nextEventId, prompt: next.prompt });
    expect(explicitStartups.slice(-3)).toEqual([true, undefined, true]);
  }
});

it('keeps accepted-only or contradictory abort acknowledgements gated until fresh native reconciliation proves the old event stopped', async () => {
  const sessionId = BotDshBrain.sessionId(input.laneId);
  for (const unproved of [
    { accepted: true },
    { accepted: true, paused: true },
    { absent: true, sessionId, eventId: 'different-event' },
    { accepted: true, result: { ...succeeded('different-event', sessionId), status: 'cancelled' } },
    { accepted: true, result: { ...succeeded(input.eventId, sessionId), status: 'running' } },
  ]) {
    let ready!: () => void, hosts = 0, confirmed = false;
    const admitted = new Promise<void>(resolve => { ready = resolve; }), abort = new AbortController();
    const initial = { request: async (endpoint: string, body: Record<string, unknown>) => {
      if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
      if (endpoint.endsWith('/cancel')) return unproved;
      ready(); return { accepted: true };
    }, async *events(_session: string, _cursor: number, signal: AbortSignal) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      yield* []; throw signal.reason;
    } } as unknown as NativeHostClient;
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const recovered = { request: async (endpoint: string, body: Record<string, unknown>) => {
      calls.push({ endpoint, body });
      if (endpoint === '/bot/cancel') { expect(body).toMatchObject({ sessionId, eventId: input.eventId, cwd: input.cwd }); return { requiresAttachment: true }; }
      if (endpoint === '/bot/lanes') {
        if (body.cancelIntent) { expect(body).toMatchObject({ eventId: input.eventId, cancelIntent: true }); expect(body).not.toHaveProperty('prompt'); }
        else { expect(confirmed).toBe(true); expect(body.eventId).toBe('new-event'); }
        return { sessionId, cursor: 0 };
      }
      if (endpoint.endsWith('/cancel')) return confirmed ? { accepted: true, result: { ...succeeded(input.eventId, sessionId), status: 'cancelled' } } : { accepted: true };
      expect(confirmed).toBe(true); return { accepted: true, result: succeeded(String(body.eventId), sessionId) };
    } } as unknown as NativeHostClient;
    const brain = new BotDshBrain({ getHost: async () => ({ client: ++hosts === 1 ? initial : recovered }) });
    const first = brain.run({ ...input, signal: abort.signal }).catch(error => error);
    await admitted; abort.abort(Error('stop old execution'));
    expect(await first).toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'cancel' });
    const next = { ...input, eventId: 'new-event', prompt: 'new user request' };
    await expect(brain.run(next)).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'cancel' });
    expect(calls.some(call => call.endpoint.endsWith('/turn'))).toBe(false);
    confirmed = true;
    // A real current-event attach follows the confirmed old-event stop. Keep
    // the two identities separate; the old terminal cannot settle this turn.
    expect(await brain.run(next)).toMatchObject({ eventId: next.eventId, status: 'succeeded', text: 'done' });
    expect(calls.filter(call => call.endpoint.endsWith('/turn'))).toHaveLength(1);
    expect(calls.filter(call => call.endpoint === '/bot/cancel')).toHaveLength(2);
  }
});

it('accepts a route-bound absence or exact durable pause proof without probing or submitting the old event again', async () => {
  const sessionId = BotDshBrain.sessionId(input.laneId);
  for (const suspend of [false, true]) {
    const proof = suspend ? { accepted: true, paused: true, sessionId, eventId: input.eventId } : { absent: true };
    let ready!: () => void;
    const admitted = new Promise<void>(resolve => { ready = resolve; }), abort = new AbortController(), calls: string[] = [];
    const client = { request: async (endpoint: string, body: Record<string, unknown>) => {
      calls.push(endpoint);
      if (endpoint === '/bot/lanes') return { sessionId, cursor: 0 };
      if (endpoint === '/bot/cancel') throw Error('Already-proved cancellation must not require reconciliation.');
      if (endpoint.endsWith('/cancel')) { expect(body).toMatchObject({ eventId: input.eventId, suspend }); return proof; }
      if (body.eventId !== input.eventId) return { accepted: true, result: succeeded(String(body.eventId), sessionId) };
      ready(); return { accepted: true };
    }, async *events(_session: string, _cursor: number, signal: AbortSignal) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      yield* []; throw signal.reason;
    } } as unknown as NativeHostClient;
    const brain = new BotDshBrain({ getHost: async () => ({ client }) }), reason = Object.assign(Error('stop current event'), suspend ? { code: 'BOT_SUSPEND' } : {});
    const first = brain.run({ ...input, signal: abort.signal }).catch(error => error);
    await admitted; abort.abort(reason);
    if (suspend) expect(await first).toMatchObject({ code: 'BOT_PAUSE_ACKNOWLEDGED' }); else expect(await first).toBe(reason);
    expect(await brain.run({ ...input, eventId: 'after-proof' })).toMatchObject({ eventId: 'after-proof', status: 'succeeded' });
    expect(calls.filter(endpoint => endpoint.endsWith('/cancel'))).toHaveLength(1);
    expect(calls.filter(endpoint => endpoint.endsWith('/turn'))).toHaveLength(2);
  }
});

it('exposes a durable cancellation receipt after the input signal aborts', async () => {
  let ready!: () => void;
  const accepted = new Promise<void>(resolve => { ready = resolve; }), abort = new AbortController();
  const receipt = { ...succeeded(input.eventId, BotDshBrain.sessionId(input.laneId)), status: 'cancelled' };
  const client = { request: async (endpoint: string, body: Record<string, string>) => {
    if (endpoint === '/bot/lanes') return { sessionId: body.sessionId, cursor: 0 };
    if (endpoint.endsWith('/cancel')) return { accepted: true, result: receipt };
    ready(); return { accepted: true };
  }, async *events(_session: string, _cursor: number, signal: AbortSignal) {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    yield* []; throw signal.reason;
  } } as unknown as NativeHostClient;
  const brain = new BotDshBrain({ getHost: async () => ({ client }) }), result = brain.run({ ...input, signal: abort.signal }).catch(error => error);
  await accepted; abort.abort(new Error('User stop'));
  expect(await result).toBeInstanceOf(BotDshAbortAcknowledgedError); expect(await result).toMatchObject({ result: receipt });
});
