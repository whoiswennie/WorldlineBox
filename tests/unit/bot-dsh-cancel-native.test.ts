import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshAbortAcknowledgedError, BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('proves a legacy missing event absent without restoring an Agent and accepts scoped callback tools as local registrations', async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; } requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'SCOPED_CALLBACK_AVAILABLE' }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const client = await native.instances.ensureHost(native.instance.id), brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const input = { laneId: 'legacy-missing-event', eventId: 'legacy-never-admitted', role: 'worker' as const, workerAccess: 'scoped' as const,
    cwd: path.join(native.root, 'legacy'), system: 'Scoped callback and cancellation fixture.',
    model: { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' }, tools: [],
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'c'.repeat(64) },
    workerTools: [{ name: 'worker_chat_send_file', description: 'A scoped callback tool, not a global capability.', parameters: { type: 'object', properties: {} } }] };
  try {
    const before = await client.request<{ botLanes: number }>('/health');
    const absent = await brain.cancelDurable({ ...input, model: { ...input.model, apiKey: '', baseUrl: 'not-a-model-url' } });
    expect(absent).toMatchObject({ absent: true, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) });
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(before.botLanes); expect(requests).toBe(0);
    const runningInput = { ...input, laneId: 'scoped-callback-regression', eventId: 'scoped-callback-event', cwd: path.join(native.root, 'scoped') };
    expect((await brain.run({ ...runningInput, prompt: 'Confirm this scoped fixture.' })).text).toBe('SCOPED_CALLBACK_AVAILABLE');
    expect(requests).toBe(1);
    const direct = await client.request<{ sessionId: string }>('/bot/lanes', { ...input, sessionId: BotDshBrain.sessionId(input.laneId), cancelIntent: true });
    expect(direct.sessionId).toBe(absent.sessionId);
    await expect(client.request(`/bot/lanes/${direct.sessionId}/turn`, { eventId: input.eventId, prompt: 'A delayed original submission must never run.' })).rejects.toThrow('cancelled before admission');
    expect(requests).toBe(1);
  } finally {
    await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 120000);

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('reconciles durable cancellation and cold absence without another model request', async () => {
  const steps: string[] = [], mark = async (step: string) => { steps.push(step); await writeFile(path.resolve('artifacts/superagent-bot-development/native-cancel-recovery-progress.json'), JSON.stringify({ steps })); };
  await mark('starting');
  let requests = 0, notify!: () => void;
  const ready = new Promise<void>(resolve => { notify = resolve; });
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    requests++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); notify();
    // Remain in native inference until its AbortSignal is cancelled.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  await mark('profile-created');
  let client = await native.instances.ensureHost(native.instance.id);
  await mark('host-ready');
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const input = { laneId: 'native-cancel', eventId: 'cancel-proof', cwd: path.join(native.root, 'cancel'), system: 'Native cancellation fixture.',
    model: { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' },
    tools: [], callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'c'.repeat(64) } };
  try {
    const controller = new AbortController(), running = brain.run({ ...input, prompt: 'Wait for a cancellation.', signal: controller.signal }).catch(error => error);
    void running.then(value => mark('initial-run-settled:' + (value instanceof Error ? value.message : value.status)));
    await ready; controller.abort(new Error('User stop'));
    await mark('initial-model-aborted');
    const stopped = await running;
    await mark('initial-stop-acknowledged');
    expect(stopped).toBeInstanceOf(BotDshAbortAcknowledgedError); expect(stopped.result.status).toBe('cancelled');
    expect(stopped.result.inputContextCommitted).toBe(true);
    const beforeRestart = requests;
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    await mark('host-restarted');
    const recovered = await brain.cancelDurable(input);
    await mark('cold-cancel-acknowledged');
    expect(recovered.result?.status).toBe('cancelled'); expect(recovered.result?.inputContextCommitted).toBe(true); expect(requests).toBe(beforeRestart);
    const absent = await brain.cancelDurable({ ...input, laneId: 'never-admitted', eventId: 'absent-proof', cwd: path.join(native.root, 'absent') });
    expect(absent).toMatchObject({ accepted: false, absent: true, eventId: 'absent-proof', sessionId: BotDshBrain.sessionId('never-admitted') }); expect(requests).toBe(beforeRestart);
    expect(await brain.cancelDurable({ ...input, laneId: 'never-admitted', eventId: 'absent-proof', cwd: path.join(native.root, 'absent') })).toEqual(absent);
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-cancel-recovery.json'), JSON.stringify({
      actualNativeHost: true, version: native.runtimeVersion, usesRealModel: false, providerRequests: requests,
      durableAbortReceipt: true, coldReceiptReplayed: true, absentProof: true, recoveryModelRequests: requests - beforeRestart,
      inputContextCommitProofReplayed: true,
    }, null, 2));
  } finally {
    await mark('closing');
    await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await mark('closed');
  }
}, 120000);
