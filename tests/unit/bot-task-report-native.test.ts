import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { createOwnedNativeEffectHost } from '../fixtures/bot-native-effect-host';

// Installed native DSH, actual worker_report tool and durable continuation
// receipts. Provider responses are local protocol fixtures, with no billing.
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('persists root business reports and resumes the same native task once per follow-up ID across restart', async () => {
  type Message = { role: string; content?: string; tool_calls?: Array<{ function: { name: string } }> };
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const effects = createOwnedNativeEffectHost(path.join(native.root, 'report-effects.sqlite'));
  const identities = effects.register('report-native', 'Explain the result, with no filesystem mutation.'), calls: BotToolCall[] = [];
  let modelCalls = 0, reportCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      if (request.url === '/bot/tool') {
        const call = JSON.parse(raw) as BotToolCall; calls.push(call);
        if (request.headers.authorization !== 'Bearer ' + 'e'.repeat(64)) throw Error('Invalid native fixture callback credential');
        const result = effects.handle(call); if (call.name === 'worker_report') reportCalls++;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result })); return;
      }
      modelCalls++;
      const input = JSON.parse(raw) as { messages: Message[]; tools: Array<{ function: { name: string } }> };
      expect(input.tools.some(tool => tool.function.name === 'worker_report')).toBe(true);
      const lastUser = input.messages.findLastIndex(message => message.role === 'user'), messages = input.messages.slice(lastUser + 1);
      const reported = messages.some(message => message.tool_calls?.some(call => call.function.name === 'worker_report'));
      const second = input.messages[lastUser]?.content?.includes('SEGMENT_TWO') === true;
      const delta = reported ? { content: 'Task complete; the concrete answer is above.' }
        : { content: second ? 'SECOND_SEGMENT_BODY: source fixture two, measured value 27.' : 'FIRST_SEGMENT_BODY: source fixture one, measured value 18.6.',
          tool_calls: [{ index: 0, id: 'native-report-' + randomUUID(), type: 'function', function: { name: 'worker_report',
          arguments: JSON.stringify({ state: 'ready', summary: second ? 'Second verified result' : 'First verified result', verification: ['Checked the provided fixture facts; this is a text-only result.'] }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reported ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No native report fixture port');
  let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const input = { ...identities, role: 'worker' as const, workerAccess: 'full' as const, tools: [], cwd: path.join(native.root, 'task'), system: 'Execute this text-only fixture and use worker_report.', prompt: 'Explain the first fixture facts.',
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'e'.repeat(64) },
    model: { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-no-billing' } };
  try {
    const first = await brain.run(input); expect(first.status).toBe('succeeded'); expect(effects.report('report-native')).toMatchObject({ state: 'ready', summary: 'First verified result' });
    expect(first.text).toContain('FIRST_SEGMENT_BODY: source fixture one, measured value 18.6.');
    expect(first.text).toContain('Task complete; the concrete answer is above.'); expect(first.text).not.toContain('native-report-');
    expect(reportCalls).toBe(1);
    const next = { ...input, taskContinuation: { id: 'followup-two', text: 'SEGMENT_TWO: Explain the second provided facts.' } };
    const second = await brain.run(next); expect(second.status).toBe('succeeded'); expect(second.sessionId).toBe(first.sessionId);
    expect(second.text).toContain('SECOND_SEGMENT_BODY: source fixture two, measured value 27.'); expect(second.text).not.toContain('FIRST_SEGMENT_BODY');
    expect(effects.report('report-native')).toMatchObject({ state: 'ready', summary: 'Second verified result' });
    expect(reportCalls).toBe(2); const requests = modelCalls;
    expect(await brain.run(next)).toMatchObject({ text: second.text, sessionId: first.sessionId }); expect(modelCalls).toBe(requests);
    await expect(brain.run({ ...next, taskContinuation: { id: 'followup-two', text: 'Changed work cannot reuse a guidance identity.' } })).rejects.toThrow(); expect(modelCalls).toBe(requests);
    await brain.close(); await native.instances.stop(native.instance.id);
    // Recreate the exact crash window: native input and its segment are
    // durable, the child admission is accepted, but the parent event still
    // holds its previous completed segment. Recovery must read the existing
    // native input instead of waiting forever or submitting it a second time.
    const receiptPath = (id: string) => path.join(input.cwd, '.worldlinebox-brain', createHash('sha256').update(id).digest('hex') + '.json');
    const childKey = input.eventId + ':task-continuation:' + next.taskContinuation.id;
    const child = JSON.parse(await readFile(receiptPath(childKey), 'utf8'));
    await writeFile(receiptPath(childKey), JSON.stringify({ ...child, status: 'accepted', result: undefined }));
    await writeFile(receiptPath(input.eventId), JSON.stringify({ eventId: input.eventId, status: 'complete', result: first }));
    client = await native.instances.ensureHost(native.instance.id);
    expect(await brain.run(next)).toMatchObject({ text: second.text, sessionId: first.sessionId }); expect(modelCalls).toBe(requests);
    // Replaying the original completed request never re-opens its first work.
    await brain.run(input); expect(reportCalls).toBe(2);
    expect(calls.filter(call => call.name === 'worker_report')).toHaveLength(2);
  } finally {
    await brain.close(); effects.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 120000);
