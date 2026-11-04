import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BotDshBrain, BotDshDeliveryUnknownError } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('answers native worker questions and detects a real effect-before-result crash without restoring an Agent', async () => {
  const effects = new Map<string, { argsHash: string; state: string }>(); let requests = 0, answer = false, questionSeen!: () => void;
  const questionReady = new Promise<void>(resolve => { questionSeen = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/bot/tool') {
      const { name, args } = data; let result: unknown;
      if (name === 'worker_question') { questionSeen(); result = { state: 'queued', questionId: args.questionId }; }
      else if (name === 'worker_question_result') result = answer ? { state: 'answered', questionId: args.questionId, answers: [{ id: 'choice', selected: ['Beta'], custom: 'ACTUAL_USER_ANSWER' }] } : { state: 'queued', questionId: args.questionId };
      else if (name === 'worker_effect_start') { effects.set(args.callId, { argsHash: args.argsHash, state: 'pending' }); result = { state: 'admitted', callId: args.callId }; }
      else if (name === 'worker_effect_commit') { effects.get(args.callId)!.state = args.isError ? 'unknown' : 'committed'; result = { recorded: true }; }
      else throw Error('Unexpected worker callback');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, result })); return;
    }
    requests++; const text = JSON.stringify(data.messages), tools = data.messages.filter((message: { role: string }) => message.role === 'tool');
    let call: { name: string; arguments: object; id: string } | undefined;
    if (text.includes('crash-after-effect') && tools.length === 0) call = { name: 'pwsh', id: 'crash-effect', arguments: {
      description: 'Write the fixture proof then wait for interruption', command: 'Set-Content -LiteralPath crash-proof.txt -Value EFFECT_OCCURRED; Start-Sleep -Seconds 60', timeoutMs: 120000 } };
    else if (!text.includes('crash-after-effect') && tools.length === 0) call = { name: 'ask_user_question', id: 'native-question', arguments: { questions: [{ id: 'choice', question: 'Choose the fixture value.', options: [{ label: 'Alpha', description: 'First value.' }, { label: 'Beta', description: 'Second value.' }] }] } };
    else if (!text.includes('crash-after-effect') && tools.length === 1) {
      expect(text).toContain('ACTUAL_USER_ANSWER'); call = { name: 'write', id: 'answered-write', arguments: { file_path: 'answer-proof.txt', content: 'ACTUAL_USER_ANSWER' } };
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: 'Worker finished with actual evidence.' };
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 30 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const base = { role: 'worker' as const, laneId: 'question-lane', eventId: 'question-work', cwd: path.join(native.root, 'question'), system: 'Native worker IO fixture.',
    model: { apiFormat: 'openai_chat' as const, model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture' },
    tools: [], callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'd'.repeat(64) } };
  try {
    const working = brain.run({ ...base, prompt: 'Ask for the missing fixture value, then write it.' });
    await questionReady; expect(requests).toBe(1); answer = true;
    expect((await working).status).toBe('succeeded'); expect(await readFile(path.join(base.cwd, 'answer-proof.txt'), 'utf8')).toBe('ACTUAL_USER_ANSWER');
    await brain.archive(base.laneId); const beforeInspect = requests;
    const confirmed = await brain.inspectEffects({ laneId: base.laneId, eventId: base.eventId, callIds: ['answered-write'] });
    expect(confirmed[0]).toMatchObject({ callId: 'answered-write', state: 'committed', argsHash: effects.get('answered-write')!.argsHash });
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(0); expect(requests).toBe(beforeInspect);
    const questionId = 'question-' + createHash('sha256').update(base.eventId + ':native-question').digest('hex').slice(0, 48);
    const answersHash = createHash('sha256').update(JSON.stringify([{ id: 'choice', selected: ['Beta'], custom: 'ACTUAL_USER_ANSWER' }])).digest('hex');
    const questionProof = await brain.inspectQuestionAnswers({ laneId: base.laneId, eventId: base.eventId, questions: [{ questionId, callId: 'native-question', answersHash }] });
    expect(questionProof[0]).toMatchObject({ questionId, state: 'committed' }); expect(questionProof[0]!.observedThrough).toBeGreaterThan(0);
    const crash = { ...base, workerAccess: 'full' as const, laneId: 'effect-crash', eventId: 'crash-work', cwd: path.join(native.root, 'crash'), prompt: 'crash-after-effect' };
    const interrupted = brain.run(crash).catch(error => error), deadline = Date.now() + 20000;
    while (!await access(path.join(crash.cwd, 'crash-proof.txt')).then(() => true, () => false)) {
      if (Date.now() > deadline) throw Error('Physical effect did not occur'); await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(effects.get('crash-effect')?.state).toBe('pending');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${client.pid} } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`], { windowsHide: true });
    const children = JSON.parse(stdout || '[]');
    // Kill the writer Host first so a child-shell abort cannot publish a
    // synthetic failed result before the intended crash boundary.
    process.kill(client.pid, 'SIGKILL');
    await Promise.allSettled((Array.isArray(children) ? children : [children]).map(pid => promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })));
    expect(await interrupted).toBeInstanceOf(BotDshDeliveryUnknownError);
    await native.instances.stop(native.instance.id).catch(() => undefined); client = await native.instances.ensureHost(native.instance.id);
    const beforeRecovery = requests;
    const unknown = await brain.inspectEffects({ laneId: crash.laneId, eventId: crash.eventId, callIds: ['crash-effect'] });
    expect(unknown[0]?.state).toBe('unknown'); expect(requests).toBe(beforeRecovery);
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(0);
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-worker-io.json'), JSON.stringify({ version: native.runtimeVersion,
      actualNativeHost: true, usesRealModel: false, questionAnswered: true, writtenAnswerVerified: true,
      questionAnswerRetiredFromNativeProof: true,
      committedEffectReadWithoutAgentRestore: true, effectBeforeResultCrash: true, unresolvedEffectRemainsUnknown: true, recoveryModelRequests: requests - beforeRecovery }, null, 2));
  } finally { await brain.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);
