import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, BotDshDeliveryUnknownError, BotDshAbortAcknowledgedError } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('keeps descendant questions/effects in one task and waits for native background work before completion', async () => {
  const callbacks: Array<{ name: string; callId: string; args: Record<string, unknown> }> = [];
  const requests: unknown[] = [];
  let allowWaitAnswer = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); const data = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/bot/tool') {
      callbacks.push(data); let result;
      if (data.name === 'worker_question' || data.name === 'worker_question_result') {
        const isWait = data.eventId === 'work-child-wait';
        result = isWait && !allowWaitAnswer ? { state: 'queued', questionId: data.args.questionId }
          : { state: 'answered', questionId: data.args.questionId, answers: [{ id: 'child-choice', selected: [], custom: isWait ? 'SAVED_WAIT_CHILD_ANSWER' : 'SAVED_CHILD_ANSWER' }] };
      }
      else if (data.name === 'worker_effect_start') result = { state: 'admitted', callId: data.callId };
      else if (data.name === 'worker_effect_commit') result = { recorded: true };
      else if (data.name === 'worker_chat_send_file') result = { sent: true, messageId: 'fixture-sent-file', attachmentIds: ['fixture-file'] };
      else throw Error('Unexpected callback');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, result })); return;
    }
    requests.push(data);
    const users = data.messages.filter((message: { role: string }) => message.role === 'user'), lastUser = JSON.stringify(users.map((message: { content: unknown }) => message.content));
    const tools = data.messages.filter((message: { role: string }) => message.role === 'tool').map((message: { tool_call_id: string }) => message.tool_call_id);
    let call: { name: string; id: string; args: object } | undefined;
    if (lastUser.includes('INTERMEDIATE_FLOW_FIXTURE') && !tools.includes('intermediate-spawn')) call = { name: 'subagent', id: 'intermediate-spawn', args: { description: 'Nested leaf fixture', prompt: 'CHILD_FLOW_FIXTURE' } };
    else if (lastUser.includes('INTERMEDIATE_WAIT_FIXTURE') && !tools.includes('intermediate-wait-spawn')) call = { name: 'subagent', id: 'intermediate-wait-spawn', args: { description: 'Nested waiting leaf', prompt: 'CHILD_WAIT_FIXTURE' } };
    else if (lastUser.includes('CHILD_WAIT_FIXTURE')) {
      if (!JSON.stringify(data.messages).includes('SAVED_WAIT_CHILD_ANSWER')) call = { name: 'ask_user_question', id: 'child-wait-question', args: { questions: [{ id: 'child-choice', question: 'Save the durable user answer after restart.' }] } };
      else if (!tools.includes('child-wait-write')) call = { name: 'write', id: 'child-wait-write', args: { file_path: 'child-wait-proof.txt', content: 'SAVED_WAIT_CHILD_ANSWER' } };
    }
    else if (lastUser.includes('ROOT_WAIT_FIXTURE') && !tools.includes('wait-parent-spawn')) call = { name: 'subagent', id: 'wait-parent-spawn', args: { description: 'Waiting child fixture', prompt: 'CHILD_WAIT_FIXTURE' } };
    else if (lastUser.includes('CHILD_CRASH_FIXTURE') && !tools.includes('child-crash-effect')) call = { name: 'pwsh', id: 'child-crash-effect', args: {
      description: 'Child interrupted external work', command: "Set-Content -LiteralPath child-crash-pid.txt -Value $PID; Set-Content -LiteralPath child-crash-proof.txt -Value EFFECT_STARTED; Start-Sleep -Seconds 60", run_in_background: true } };
    else if (lastUser.includes('ROOT_CRASH_FIXTURE') && !tools.includes('crash-parent-spawn')) call = { name: 'subagent', id: 'crash-parent-spawn', args: { description: 'Crashing child fixture', prompt: 'CHILD_CRASH_FIXTURE' } };
    else if (lastUser.includes('CHILD_FLOW_FIXTURE')) {
      if (!tools.includes('child-local-question')) call = { name: 'ask_user_question', id: 'child-local-question', args: { questions: [{ id: 'child-choice', question: 'What value should the child save?' }] } };
      else if (!tools.includes('child-local-write')) call = { name: 'write', id: 'child-local-write', args: { file_path: 'child-proof.txt', content: 'SAVED_CHILD_ANSWER' } };
      else if (!tools.includes('child-local-send')) call = { name: 'worker_chat_send_file', id: 'child-local-send', args: { path: 'child-proof.txt', caption: 'Actual native child output.' } };
    } else if (lastUser.includes('ROOT_DELEGATE_FIXTURE') && !tools.includes('parent-spawn')) call = { name: 'subagent', id: 'parent-spawn', args: { description: 'Native child fixture', prompt: 'CHILD_FLOW_FIXTURE' } };
    else if (lastUser.includes('ROOT_DEPTH_FIXTURE') && !tools.includes('depth-parent-spawn')) call = { name: 'subagent', id: 'depth-parent-spawn', args: { description: 'Native depth boundary', prompt: 'INTERMEDIATE_FLOW_FIXTURE' } };
    else if (lastUser.includes('ROOT_CANCEL_CHILD_FIXTURE') && !tools.includes('cancel-child-spawn')) call = { name: 'subagent', id: 'cancel-child-spawn', args: { description: 'Background child fixture', prompt: 'CANCEL_JOB_FIXTURE' } };
    else if (lastUser.includes('CANCEL_JOB_FIXTURE') && !tools.includes('cancel-background-shell')) call = { name: 'pwsh', id: 'cancel-background-shell', args: {
      description: 'Cancellable background process', command: "Set-Content -LiteralPath owned-job-pid.txt -Value $PID; Start-Sleep -Seconds 60; Set-Content -LiteralPath unwanted-completion.txt -Value LEAK", run_in_background: true } };
    else if (lastUser.includes('BACKGROUND_FIXTURE') && !tools.includes('background-shell')) call = { name: 'pwsh', id: 'background-shell', args: {
      description: 'Delayed background artifact', command: "Start-Sleep -Milliseconds 1700; Set-Content -LiteralPath background-proof.txt -Value JOB_FINISHED", run_in_background: true } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Native work observed.' }, finish_reason: null }] }) + '\n\n');
    if (lastUser.includes('CANCEL_JOB_FIXTURE') && lastUser.includes('Your parent agent id') && tools.includes('cancel-background-shell')) return;
    if (lastUser.includes('CHILD_CRASH_FIXTURE') && tools.includes('child-crash-effect')) return;
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\n\n'); response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('No local fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!); let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const base = { role: 'worker' as const, workerAccess: 'full' as const, laneId: 'worker-with-children', eventId: 'work-with-children', cwd: path.join(native.root, 'child-work'), system: 'Native task authority fixture.', tools: [],
    workerTools: [{ name: 'worker_chat_send_file', description: 'Publish one actual file from this task to its source conversation.', parameters: { type: 'object', properties: { path: { type: 'string' }, caption: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'e'.repeat(64) }, model: { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}` } };
  try {
    expect((await brain.run({ ...base, prompt: 'ROOT_DELEGATE_FIXTURE' })).status).toBe('succeeded');
    expect(await readFile(path.join(base.cwd, 'child-proof.txt'), 'utf8')).toBe('SAVED_CHILD_ANSWER');
    const question = callbacks.find(call => call.name === 'worker_question')!, written = callbacks.find(call => call.name === 'worker_effect_start' && call.args.toolName === 'write')!;
    expect(question).toBeTruthy(); expect(written).toBeTruthy();
    expect(callbacks.find(call => call.name === 'worker_chat_send_file')).toMatchObject({ args: { path: 'child-proof.txt', nativeSessionId: written.args.nativeSessionId, nativeCallId: 'child-local-send' } });
    expect(question.args.nativeSessionId).not.toBe(BotDshBrain.sessionId(base.laneId));
    expect(question.callId).toBe('child-' + createHash('sha256').update(String(question.args.nativeSessionId) + ':child-local-question').digest('hex').slice(0, 48));
    const beforeInspect = requests.length;
    const effect = await brain.inspectEffects({ laneId: base.laneId, eventId: base.eventId, effects: [{ callId: written.callId,
      nativeSessionId: String(written.args.nativeSessionId), nativeCallId: 'child-local-write' }] });
    expect(effect[0]).toMatchObject({ state: 'committed', nativeSessionId: written.args.nativeSessionId, nativeCallId: 'child-local-write' });
    const proof = await brain.inspectQuestionAnswers({ laneId: base.laneId, eventId: base.eventId, questions: [{ questionId: String(question.args.questionId), callId: question.callId,
      nativeSessionId: String(question.args.nativeSessionId), nativeCallId: 'child-local-question', answersHash: createHash('sha256').update(JSON.stringify([{ id: 'child-choice', selected: [], custom: 'SAVED_CHILD_ANSWER' }])).digest('hex') }] });
    expect(proof[0]).toMatchObject({ state: 'committed', nativeSessionId: question.args.nativeSessionId }); expect(requests).toHaveLength(beforeInspect);
    expect((await brain.run({ ...base, laneId: 'worker-native-depth', eventId: 'work-native-depth', cwd: path.join(native.root, 'depth'), prompt: 'ROOT_DEPTH_FIXTURE' })).status).toBe('succeeded');
    expect(callbacks.some(call => call.name === 'worker_effect_commit' && call.args.nativeCallId === 'intermediate-spawn' && call.args.isError === true)).toBe(true);
    const job = { ...base, laneId: 'worker-with-background', eventId: 'work-with-background', cwd: path.join(native.root, 'background-work') };
    let settled = false; const running = brain.run({ ...job, prompt: 'BACKGROUND_FIXTURE' }).then(result => { settled = true; return result; });
    const deadline = Date.now() + 12000;
    while (!callbacks.some(call => call.name === 'worker_effect_start' && call.args.nativeCallId === 'background-shell')) { if (Date.now() > deadline) throw Error('No background admission'); await new Promise(resolve => setTimeout(resolve, 20)); }
    await new Promise(resolve => setTimeout(resolve, 300)); expect(settled).toBe(false); expect(await access(path.join(job.cwd, 'background-proof.txt')).then(() => true, () => false)).toBe(false);
    expect((await running).status).toBe('succeeded'); expect((await readFile(path.join(job.cwd, 'background-proof.txt'), 'utf8')).trim()).toBe('JOB_FINISHED');
    expect(callbacks.some(call => call.name === 'worker_effect_commit' && call.args.nativeCallId === 'background-shell')).toBe(true);
    const waiting = { ...base, laneId: 'worker-child-wait', eventId: 'work-child-wait', cwd: path.join(native.root, 'child-wait'), prompt: 'ROOT_WAIT_FIXTURE' }, pause = new AbortController();
    const paused = brain.run({ ...waiting, signal: pause.signal }).catch(error => error), waitUntil = Date.now() + 15000;
    while (!callbacks.some(call => call.name === 'worker_question' && call.args.nativeCallId === 'child-wait-question')) { if (Date.now() > waitUntil) throw Error('No waiting child question'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const waitingQuestion = callbacks.find(call => call.name === 'worker_question' && call.args.nativeCallId === 'child-wait-question')!;
    pause.abort(Object.assign(new Error('Application stopped; retain the pending user question.'), { code: 'BOT_SUSPEND' })); await paused;
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id); allowWaitAnswer = true;
    const savedAnswer = { questionId: String(waitingQuestion.args.questionId), callId: waitingQuestion.callId, nativeSessionId: String(waitingQuestion.args.nativeSessionId), nativeCallId: 'child-wait-question',
      questions: [{ id: 'child-choice', question: 'Save the durable user answer after restart.' }], answers: [{ id: 'child-choice', selected: [], custom: 'SAVED_WAIT_CHILD_ANSWER' }] };
    expect((await brain.run({ ...waiting, answeredQuestions: [savedAnswer] })).status).toBe('succeeded');
    expect(await readFile(path.join(waiting.cwd, 'child-wait-proof.txt'), 'utf8')).toBe('SAVED_WAIT_CHILD_ANSWER');
    const beforeAnswerProof = requests.length;
    expect((await brain.inspectQuestionAnswers({ laneId: waiting.laneId, eventId: waiting.eventId, questions: [{ ...savedAnswer,
      answersHash: createHash('sha256').update(JSON.stringify(savedAnswer.answers)).digest('hex') }] }))[0]).toMatchObject({ state: 'committed', nativeSessionId: savedAnswer.nativeSessionId });
    expect(requests).toHaveLength(beforeAnswerProof);
    const crash = { ...base, laneId: 'worker-child-crash', eventId: 'work-child-crash', cwd: path.join(native.root, 'child-crash') };
    const crashing = brain.run({ ...crash, prompt: 'ROOT_CRASH_FIXTURE' }).catch(error => error);
    const fileReady = async (filename: string) => { const until = Date.now() + 15000; while (!await access(filename).then(() => true, () => false)) {
      if (Date.now() > until) throw Error('Native artifact was not written: ' + path.basename(filename)); await new Promise(resolve => setTimeout(resolve, 20));
    } };
    await fileReady(path.join(crash.cwd, 'child-crash-proof.txt'));
    const handleDeadline = Date.now() + 10000;
    while (!requests.some(raw => (raw as { messages: Array<{ role: string; tool_call_id?: string }> }).messages.some(message => message.role === 'tool' && message.tool_call_id === 'child-crash-effect'))) {
      if (Date.now() > handleDeadline) throw Error('Native background handle did not commit'); await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(callbacks.some(call => call.name === 'worker_effect_commit' && call.args.nativeCallId === 'child-crash-effect')).toBe(false);
    const physicalPid = Number((await readFile(path.join(crash.cwd, 'child-crash-pid.txt'), 'utf8')).trim());
    const childPending = callbacks.find(call => call.name === 'worker_effect_start' && call.args.nativeCallId === 'child-crash-effect')!;
    expect(childPending).toBeTruthy(); process.kill(client.pid, 'SIGKILL'); try { process.kill(physicalPid, 'SIGKILL'); } catch { /* already exited */ }
    expect(await crashing).toBeInstanceOf(BotDshDeliveryUnknownError);
    await native.instances.stop(native.instance.id).catch(() => undefined); client = await native.instances.ensureHost(native.instance.id);
    const beforeCrashInspection = requests.length;
    expect((await brain.inspectEffects({ laneId: crash.laneId, eventId: crash.eventId, effects: [{ callId: childPending.callId,
      nativeSessionId: String(childPending.args.nativeSessionId), nativeCallId: 'child-crash-effect' }] }))[0]).toMatchObject({ state: 'unknown', nativeSessionId: childPending.args.nativeSessionId });
    expect(requests).toHaveLength(beforeCrashInspection); expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(0);
    await expect(brain.cancelDurable({ ...crash })).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
    expect(requests).toHaveLength(beforeCrashInspection);
    await brain.archive(crash.laneId);
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(0);
    expect((await brain.inspectEffects({ laneId: crash.laneId, eventId: crash.eventId, effects: [{ callId: childPending.callId,
      nativeSessionId: String(childPending.args.nativeSessionId), nativeCallId: 'child-crash-effect' }] }))[0]?.state).toBe('unknown');
    await expect(brain.cancelDurable({ ...crash })).rejects.toMatchObject({ code: 'BOT_DELIVERY_UNKNOWN' });
    expect(requests).toHaveLength(beforeCrashInspection);
    const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const { operation, child } of [{ operation: 'cancel', child: false }, { operation: 'close', child: false }, { operation: 'cancel', child: true }, { operation: 'close', child: true }] as const) {
      const suffix = operation + (child ? '-child' : '-root');
      const input = { ...base, laneId: `worker-job-${suffix}`, eventId: `work-job-${suffix}`, cwd: path.join(native.root, `job-${suffix}`) }, controller = new AbortController();
      const work = brain.run({ ...input, prompt: child ? 'ROOT_CANCEL_CHILD_FIXTURE' : 'CANCEL_JOB_FIXTURE', signal: controller.signal }).catch(error => error);
      await fileReady(path.join(input.cwd, 'owned-job-pid.txt')); const pid = Number((await readFile(path.join(input.cwd, 'owned-job-pid.txt'), 'utf8')).trim()); expect(isAlive(pid)).toBe(true);
      if (operation === 'cancel') controller.abort(new Error('Explicit user cancel')); else await brain.close();
      const stopped = await work; if (operation === 'cancel') { expect(stopped).toBeInstanceOf(BotDshAbortAcknowledgedError); expect(stopped.result.status).toBe('cancelled'); }
      const until = Date.now() + 3000; while (isAlive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      expect(isAlive(pid)).toBe(false); expect((await client.request<{ botRunningJobs: number }>('/health')).botRunningJobs).toBe(0);
      expect(await access(path.join(input.cwd, 'unwanted-completion.txt')).then(() => true, () => false)).toBe(false);
    }
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-descendants.json'), JSON.stringify({ version: native.runtimeVersion, actualNativeHost: true, usesRealModel: false,
      childQuestionRelayed: true, childEffectCommitted: true, childProofWithoutModelRequests: true, childAnswerColdRestored: true, childEffectCrashRemainsUnknown: true,
      coldJobWithoutSettlementDoesNotCertifyStop: true,
      durableBackgroundHandleAloneRemainsUnknown: true,
      unknownJobColdArchiveDoesNotForgeStopProof: true,
      childHostFileToolSameTask: true, nativeDepthLimitOnePreserved: true, nativeChildToolFailureSettled: true,
      backgroundCompletionWaitedForArtifact: true, cancelledBackgroundPidExited: true, suspendedBackgroundPidExited: true,
      cancelledDescendantBackgroundPidExited: true, suspendedDescendantBackgroundPidExited: true }, null, 2));
  } finally {
    await brain.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 120000);
