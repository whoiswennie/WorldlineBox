import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, BotDshDeliveryUnknownError } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('recovers one native event after five cold Host crashes without re-admitting its original input', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let finish = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: finish ? 'RECOVERED_EVENT' : 'waiting' }, finish_reason: null }] }) + '\n\n');
    if (finish) {
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('No provider fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const base = { laneId: 'repeated-cold-lane', eventId: 'one-stable-event', cwd: path.join(native.root, 'worker'), system: 'Native repeated recovery fixture.',
    prompt: 'ONE_ORIGINAL_NATIVE_INPUT', tools: [], model: { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}` },
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'c'.repeat(64) } };
  try {
    for (let cycle = 0; cycle < 5; cycle++) {
      const interrupted = brain.run(base).catch(error => error), deadline = Date.now() + 12000;
      while (requests.length <= cycle) { if (Date.now() > deadline) throw Error('Native recovery did not reach provider'); await new Promise(resolve => setTimeout(resolve, 20)); }
      process.kill(client.pid, 'SIGKILL');
      expect(await interrupted).toBeInstanceOf(BotDshDeliveryUnknownError);
      await native.instances.stop(native.instance.id).catch(() => undefined); client = await native.instances.ensureHost(native.instance.id);
    }
    finish = true; const result = await brain.run(base);
    expect(result).toMatchObject({ status: 'succeeded', eventId: base.eventId, sessionId: BotDshBrain.sessionId(base.laneId), text: 'RECOVERED_EVENT', inputContextCommitted: true });
    expect(requests).toHaveLength(6);
    for (const request of requests) expect(request.messages.filter(message => message.role === 'user' && message.content === base.prompt)).toHaveLength(1);
    const beforeDuplicate = requests.length; expect(await brain.run(base)).toEqual(result); expect(requests).toHaveLength(beforeDuplicate);
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-repeat-recovery.json'), JSON.stringify({ version: native.runtimeVersion, actualNativeHost: true,
      usesRealModel: false, coldRestores: 5, providerRequests: requests.length, oneOriginalInputPerRestore: true, stableEventId: true, duplicateMadeNoModelRequest: true }, null, 2));
  } finally { await brain.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);
