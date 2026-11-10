import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, BotDshOutputLimitError, BotDshPauseAcknowledgedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('durably pauses and cold-resumes one native task without replaying the original input or cancelling a never-admitted pause', async () => {
  let held = true, notify!: () => void;
  const entered = new Promise<void>(resolve => { notify = resolve; });
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const steps: Array<{ step: string; time: string; requests: number }> = [];
  const mark = async (step: string) => { steps.push({ step, time: new Date().toISOString(), requests: requests.length }); await writeFile(path.resolve('artifacts/superagent-bot-development/native-pause-progress.json'), JSON.stringify({ steps }, null, 2)); };
  await mark('starting');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
    if (held) { notify(); return; }
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'RESUMED_ORIGINAL_TASK' }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No native pause fixture port.');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  await mark('profile-created');
  let client = await native.instances.ensureHost(native.instance.id);
  await mark('host-ready');
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const parent = path.join(native.root, '大肥鱼'), cwd = path.join(parent, 'pause-task');
  const input: BotDshRun = { role: 'worker', workerAccess: 'scoped', laneId: 'worker-pause-true', eventId: 'original-pause-event', cwd,
    workspaceTitle: '大肥鱼', workspaceParent: { path: parent, title: '大肥鱼' }, sessionTitle: '暂停并继续',
    system: 'Use only this isolated task. Never create another copy of its input.', prompt: 'ORIGINAL_PAUSE_TASK_INPUT', tools: [],
    model: { apiFormat: 'openai_chat', model: 'native-pause-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', contextWindow: 32768, maxTokens: 512 },
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'e'.repeat(64) } };
  try {
    const controller = new AbortController(), running = brain.run({ ...input, signal: controller.signal }).catch(error => error);
    const admitted = Promise.race([entered, running.then(value => { if (value instanceof Error) throw value; })]);
    await admitted; await mark('initial-inference'); controller.abort(Object.assign(new Error('Pause this exact task.'), { code: 'BOT_SUSPEND' }));
    expect(await running).toBeInstanceOf(BotDshPauseAcknowledgedError); expect(requests).toHaveLength(1);
    await mark('initial-pause-confirmed');
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    await mark('host-restarted');
    const paused = await brain.cancelDurable(input, true);
    await mark('cold-pause-returned');
    expect(paused).toMatchObject({ paused: true, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId });
    expect(requests).toHaveLength(1);
    held = false;
    const result = await brain.run(input);
    await mark('original-resumed');
    expect(result).toMatchObject({ status: 'succeeded', text: 'RESUMED_ORIGINAL_TASK', sessionId: paused.sessionId, eventId: input.eventId });
    expect(requests).toHaveLength(2);
    for (const frame of requests) expect(frame.messages.filter(message => message.role === 'user' && message.content === input.prompt)).toHaveLength(1);
    const fresh = { ...input, laneId: 'worker-pause-before-admission', eventId: 'pause-before-admission', cwd: path.join(parent, 'not-admitted'), sessionTitle: '投递前暂停' };
    expect(await brain.cancelDurable(fresh, true)).toMatchObject({ paused: true, eventId: fresh.eventId, sessionId: BotDshBrain.sessionId(fresh.laneId) });
    await mark('unadmitted-paused');
    expect(requests).toHaveLength(2);
    expect((await brain.run(fresh)).status).toBe('succeeded'); expect(requests).toHaveLength(3);
    await mark('unadmitted-resumed');
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-pause-recovery.json'), JSON.stringify({ actualNativeHost: true,
      version: native.runtimeVersion, paidCalls: 0, providerRequests: requests.length, pausePreservesOriginalEvent: true,
      coldPauseDoesNotInvokeModel: true, resumeUsesSameSession: true, originalInputInsertedOnce: true, neverAdmittedPauseRemainsResumable: true }, null, 2));
  } finally {
    await mark('closing');
    server.closeAllConnections(); await brain.close().catch(() => undefined); await native.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await mark('closed');
  }
}, 120000);

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('resumes an exact output checkpoint after a cold native pause while rejecting stale checkpoint ids', async () => {
  let finish = false;
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: finish ? 'CHECKPOINT_RESUMED_ONCE' : 'CHECKPOINT_PARTIAL' }, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish ? 'stop' : 'length' }], usage: { prompt_tokens: 30, completion_tokens: finish ? 5 : 512 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No checkpoint fixture port.');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) }), parent = path.join(native.root, '大肥鱼');
  const input: BotDshRun = { role: 'worker', laneId: 'worker-checkpoint-pause', eventId: 'checkpoint-original', cwd: path.join(parent, 'checkpoint'),
    workspaceTitle: '大肥鱼', workspaceParent: { path: parent, title: '大肥鱼' }, sessionTitle: '继续保存的进展',
    system: 'Finish this isolated task without replaying its original input.', prompt: 'ORIGINAL_CHECKPOINT_INPUT', tools: [],
    model: { apiFormat: 'openai_chat', model: 'native-checkpoint-pause-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', contextWindow: 32768, maxTokens: 512 },
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'd'.repeat(64) } };
  try {
    const limit = await brain.run(input).catch(error => error);
    expect(limit).toBeInstanceOf(BotDshOutputLimitError);
    const limitedRequests = requests.length; expect(limitedRequests).toBeGreaterThanOrEqual(1);
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    const proof = await brain.cancelDurable(input, true);
    expect(proof.result).toMatchObject({ eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), outputCheckpoint: limit.checkpoint });
    expect(requests).toHaveLength(limitedRequests);
    // Merely attaching or supplying a stale checkpoint cannot resume work.
    await expect(brain.run({ ...input, continueAfterSeq: limit.checkpoint + 1 })).rejects.toThrow('continuation checkpoint is stale');
    expect(requests).toHaveLength(limitedRequests);
    finish = true;
    const result = await brain.run({ ...input, continueAfterSeq: limit.checkpoint });
    expect(result).toMatchObject({ status: 'succeeded', eventId: input.eventId, sessionId: proof.result!.sessionId });
    expect(result.text).toContain('CHECKPOINT_PARTIAL'); expect(result.text.endsWith('CHECKPOINT_RESUMED_ONCE')).toBe(true);
    expect(result.outputs?.filter(output => output.text).at(-1)?.text).toBe('CHECKPOINT_RESUMED_ONCE');
    expect(requests).toHaveLength(limitedRequests + 1);
    for (const frame of requests) expect(frame.messages.filter(message => message.role === 'user' && message.content === input.prompt)).toHaveLength(1);
    expect(await brain.run({ ...input, continueAfterSeq: limit.checkpoint })).toEqual(result); expect(requests).toHaveLength(limitedRequests + 1);
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-pause-checkpoint-recovery.json'), JSON.stringify({ actualNativeHost: true,
      version: native.runtimeVersion, paidCalls: 0, providerRequests: requests.length, coldPauseUsesNoModel: true, exactCheckpointResumesSameEvent: true,
      staleCheckpointCannotResume: true, originalInputInsertedOnce: true, duplicateResumeUsesReceipt: true }, null, 2));
  } finally { await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);
