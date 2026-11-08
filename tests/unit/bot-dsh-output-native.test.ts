import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, BotDshOutputLimitError, BotDshTurnFailedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

// Actual installed DSH Agent/LLM serializer/Session/Workspace and real scoped
// writes. Only the provider responses are deterministic localhost fixtures.
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('continues truncated worker output in its original native Session and exposes exact resumable checkpoints', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; max_tokens: number }> = [];
  const effectStarts: string[] = [];
  let mode: 'truncate-tool' | 'pause' | 'finish' | 'failed-commit' | 'progress' = 'truncate-tool';
  let modeCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/bot/tool') {
      if (data.name === 'worker_effect_start') effectStarts.push(data.callId);
      if (mode === 'failed-commit' && data.name === 'worker_effect_commit') { response.writeHead(503); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: data.name === 'worker_effect_start' ? { state: 'admitted', callId: data.callId } : { recorded: true } })); return;
    }
    requests.push(data); modeCalls++;
    const tool = (name: string, args: string) => ({ tool_calls: [{ index: 0, id: `fixture-call-${requests.length}`, type: 'function', function: { name, arguments: args } }] });
    const hasTool = data.messages.some((message: { role: string }) => message.role === 'tool');
    const delta = mode === 'truncate-tool' && modeCalls === 1 ? tool('write', '{"file_path":"must-not-exist.txt","content":"TRUNCATED')
      : mode === 'truncate-tool' && !hasTool ? tool('write', JSON.stringify({ file_path: 'verified.txt', content: 'ONE_REAL_WRITE' }))
        : mode === 'failed-commit' && !hasTool ? tool('write', JSON.stringify({ file_path: 'committed.txt', content: 'REAL_EFFECT' }))
          : mode === 'progress' && modeCalls < 16 && modeCalls % 3 === 2 ? tool('write', JSON.stringify({ file_path: `progress-${Math.floor(modeCalls / 3)}.txt`, content: 'VERIFIED_STEP' }))
          : { content: mode === 'finish' ? 'COMPLETE_FROM_CHECKPOINT' : 'PARTIAL_SEGMENT' };
    const truncated = mode === 'pause' || mode === 'truncate-tool' && modeCalls === 1 || mode === 'failed-commit' && hasTool
      || mode === 'progress' && modeCalls < 16 && modeCalls % 3 !== 2;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: truncated ? 512 : 5 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No protocol fixture port.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const parent = path.join(native.root, '大肥鱼'); await mkdir(parent);
  const input: BotDshRun = { laneId: 'worker-truncated', eventId: 'stable-worker-event', cwd: path.join(parent, 'first-task'), role: 'worker',
    system: 'Do this isolated test task using real tools.', prompt: 'ORIGINAL_TASK_REQUEST', tools: [],
    workspaceTitle: '大肥鱼 · 输出续写', workspaceParent: { path: parent, title: '大肥鱼' },
    model: { apiFormat: 'openai_chat', model: 'native-fixture', baseUrl, apiKey: 'not-a-real-secret', contextWindow: 32768, maxTokens: 512, maxOutputTokens: 8192 },
    callback: { url: baseUrl + '/bot/tool', token: 'f'.repeat(64) } };
  try {
    const progress: string[] = [];
    const first = await brain.run({ ...input, onEvent: event => progress.push(event.stage ?? '') });
    expect(first.status).toBe('succeeded'); expect(modeCalls).toBe(3); expect(effectStarts).toHaveLength(1);
    expect(progress).toContain('output_continuation');
    expect(await access(path.join(input.cwd, 'must-not-exist.txt')).then(() => true, () => false)).toBe(false);
    expect(await readFile(path.join(input.cwd, 'verified.txt'), 'utf8')).toBe('ONE_REAL_WRITE');
    for (const req of requests) expect(req.messages.filter(message => message.role === 'user' && message.content === input.prompt)).toHaveLength(1);
    const nativeLane = await client.request<{ workspace: { title: string; path: string; sessionIds: string[] } }>('/bot/lanes',
      { ...input, sessionId: BotDshBrain.sessionId(input.laneId), workerTools: [], workerAccess: 'scoped' });
    expect(nativeLane.workspace.title).toBe(input.workspaceParent!.title); expect(path.resolve(nativeLane.workspace.path)).toBe(path.resolve(input.workspaceParent!.path));
    expect(nativeLane.workspace.sessionIds).toContain(first.sessionId);
    const beforeReplay = requests.length; expect(await brain.run(input)).toEqual(first); expect(requests).toHaveLength(beforeReplay);

    mode = 'pause'; modeCalls = 0;
    const pausedInput = { ...input, laneId: 'worker-pause', eventId: 'paused-original', cwd: path.join(parent, 'paused-task'), workspaceTitle: '大肥鱼 · 等待继续' };
    const paused = await brain.run(pausedInput).catch(error => error);
    expect(paused).toBeInstanceOf(BotDshOutputLimitError); expect(modeCalls).toBe(5);
    const beforePausedReplay = requests.length;
    expect(await brain.run(pausedInput).catch(error => error)).toMatchObject({ code: 'BOT_OUTPUT_LIMIT', checkpoint: paused.checkpoint });
    expect(requests).toHaveLength(beforePausedReplay);
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    expect(await brain.run(pausedInput).catch(error => error)).toMatchObject({ code: 'BOT_OUTPUT_LIMIT', checkpoint: paused.checkpoint });
    expect(requests).toHaveLength(beforePausedReplay);
    modeCalls = 0;
    const secondPause = await brain.run({ ...pausedInput, continueAfterSeq: paused.checkpoint }).catch(error => error);
    expect(secondPause).toBeInstanceOf(BotDshOutputLimitError); expect(modeCalls).toBe(5); expect(secondPause.checkpoint).not.toBe(paused.checkpoint);
    const beforeStaleCheckpoint = requests.length;
    expect(await brain.run({ ...pausedInput, continueAfterSeq: paused.checkpoint }).catch(error => error)).toMatchObject({ checkpoint: secondPause.checkpoint });
    expect(requests).toHaveLength(beforeStaleCheckpoint);
    mode = 'finish'; modeCalls = 0;
    const continued = await brain.run({ ...pausedInput, continueAfterSeq: secondPause.checkpoint });
    expect(continued).toMatchObject({ status: 'succeeded', sessionId: BotDshBrain.sessionId(pausedInput.laneId) });
    expect(continued.text).toContain('PARTIAL_SEGMENT'); expect(continued.text).toContain('COMPLETE_FROM_CHECKPOINT');
    expect(modeCalls).toBe(1);
    const beforeContinuedReplay = requests.length;
    expect(await brain.run({ ...pausedInput, continueAfterSeq: paused.checkpoint })).toEqual(continued); expect(requests).toHaveLength(beforeContinuedReplay);

    mode = 'progress'; modeCalls = 0;
    const progressing = await brain.run({ ...input, laneId: 'worker-progress', eventId: 'progress-original', cwd: path.join(parent, 'progress-task') });
    expect(progressing.status).toBe('succeeded'); expect(modeCalls).toBe(16);
    for (let step = 0; step < 5; step++) expect(await readFile(path.join(parent, 'progress-task', `progress-${step}.txt`), 'utf8')).toBe('VERIFIED_STEP');

    mode = 'pause'; modeCalls = 0;
    const cancelledInput = { ...input, laneId: 'worker-pause-cancel', eventId: 'pause-cancel-event', cwd: path.join(parent, 'cancel-task') };
    const cancellable = await brain.run(cancelledInput).catch(error => error); expect(cancellable).toBeInstanceOf(BotDshOutputLimitError);
    const cancelled = await brain.cancelDurable(cancelledInput); expect(cancelled.result?.status).toBe('cancelled');
    const beforeCancelledReplay = requests.length;
    expect((await brain.run({ ...cancelledInput, continueAfterSeq: cancellable.checkpoint })).status).toBe('cancelled'); expect(requests).toHaveLength(beforeCancelledReplay);

    mode = 'failed-commit'; modeCalls = 0;
    const unsafe = await brain.run({ ...input, laneId: 'worker-unknown-commit', eventId: 'unknown-commit-event', cwd: path.join(parent, 'unknown-commit-task') }).catch(error => error);
    expect(unsafe).toBeInstanceOf(BotDshTurnFailedError); expect(unsafe.message).toContain('需要核实'); expect(modeCalls).toBe(2);
  } finally { await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 180000);
