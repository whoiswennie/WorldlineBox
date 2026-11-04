import { expect, it } from 'vitest';
import { BotDshBrain, BotDshAbortAcknowledgedError, BotDshDeliveryUnknownError, BotDshLaneBusyError, BotDshOutputLimitError, BotDshTurnFailedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { NativeHostClient } from '../../src/main/dsh/native-host-client';

const input: BotDshRun = { laneId: 'lane', eventId: 'event', cwd: 'C:/bot-test', system: 'Test persona', prompt: 'Test input',
  model: { apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' },
  tools: [], callback: { url: 'http://127.0.0.1/bot/tool', token: 'a'.repeat(64) } };
const succeeded = (eventId: string, sessionId: string) => ({ text: 'done', eventId, sessionId, status: 'succeeded' });

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
    if (endpoint.endsWith('/cancel')) { await stop; return { accepted: true }; }
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
    .toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'host', cause: failure });
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
  await expect(brain.cancelDurable(input)).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN', stage: 'host', cause: error });
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
