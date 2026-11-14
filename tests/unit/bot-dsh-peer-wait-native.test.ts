import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotService } from '../../src/main/companion-bot/service';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { NativeServiceMemory, waitNative } from '../fixtures/bot-native-service';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('runs two real peer turns and wakes the DSH coordinator through either wait tool', async () => {
  const program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!;
  const native = await createBotNativeHost(program);
  const brain = new BotDshBrain({ getHost: async () => ({ client: await native.instances.ensureHost(native.instance.id) }) });
  const cases = ['companion_wait', 'wait_agent'].map((tool, index) => ({
    tool, owner: 'wait-owner-' + index, first: 'wait-first-' + index, second: 'wait-second-' + index,
    firstResult: 'FIRST_PEER_RESULT_' + index, secondResult: 'SECOND_PEER_RESULT_' + index, summary: 'JOINED_PEER_RESULTS_' + index,
    secondGate: gate(), seenWait: false,
  }));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: Array<{ role: string; content: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const context = data.messages.map(message => message.content).join('\n');
    const hasIdentity = (id: string) => context.includes('"identity":{"id":"' + id + '"');
    const scenario = cases.find(item => [item.owner, item.first, item.second].some(hasIdentity));
    const used = data.messages.filter(message => message.role === 'tool').length;
    let content = 'UNEXPECTED_MODEL_REQUEST', tool: string | undefined, args: object = {};
    if (scenario && hasIdentity(scenario.first)) content = scenario.firstResult;
    else if (scenario && hasIdentity(scenario.second)) {
      await scenario.secondGate.promise;
      content = scenario.secondResult;
    } else if (scenario && context.includes(scenario.firstResult) && context.includes(scenario.secondResult)) content = scenario.summary;
    else if (scenario && used < 2) {
      tool = 'companion_contact';
      args = { companionId: used === 0 ? scenario.first : scenario.second, destination: 'peer', message: 'Return your assigned fixture result.' };
    } else if (scenario && used === 2 && data.tools?.some(item => item.function.name === scenario.tool)) {
      tool = scenario.tool;
      args = { timeout_ms: 120000 };
      scenario.seenWait = true;
    }
    const delta = tool ? { tool_calls: [{ index: 0, id: 'call-' + used, type: 'function', function: {
      name: tool, arguments: JSON.stringify(args),
    } }] } : { content };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No fixture address');
  const service = new BotService({ root: path.join(native.root, 'service'), brain,
    memory: new NativeServiceMemory(path.join(native.root, 'service', 'memory')),
    model: () => ({ apiFormat: 'openai_chat', model: 'wait-fixture', baseUrl: 'http://127.0.0.1:' + address.port, apiKey: 'local-fixture' }),
    onEvent: () => undefined,
  });
  try {
    await native.instances.installDependencies(native.instance.id);
    const teamPatch = await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml'), 'utf8');
    const overlay = path.join(native.instance.homePath, 'profiles/web/cordis.patch.yml');
    await service.handle({ type: 'state' });
    const batches = vi.spyOn(service.store.peerReturns, 'inlineResults');
    for (const scenario of cases) {
      if (scenario.tool === 'wait_agent') {
        await native.instances.stop(native.instance.id);
        await writeFile(overlay, stringify([...parse(await readFile(overlay, 'utf8')), ...parse(teamPatch)]));
      }
      await native.instances.ensureHost(native.instance.id);
      for (const id of [scenario.owner, scenario.first, scenario.second]) service.store.createCompanion({ id, name: id, persona: id });
      const direct = service.store.openDirect(scenario.owner);
      await service.handle({ type: 'message.send', conversationId: direct.id, content: 'Collect and summarize both fixture results.', requestId: scenario.owner });
      await waitNative(() => scenario.seenWait && batches.mock.results.some((entry, index) =>
        batches.mock.calls[index]?.[0].companionId === scenario.owner && entry.value?.status === 'pending' && entry.value.pending === 1));
      scenario.secondGate.release();
      await waitNative(() => service.store.messagesPage(direct.id).items.some(message => message.status === 'sent' && message.content === scenario.summary));
      expect(service.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND source_instance_id='peer-return-v1'").all(direct.id))).toEqual([]);
    }
  } catch (error) {
    const log = await readFile(path.join(path.dirname(native.instance.homePath), 'logs/host.log'), 'utf8').catch(() => '');
    throw new Error(log.split('\n').slice(-30).join('\n'), { cause: error });
  } finally {
    for (const scenario of cases) scenario.secondGate.release();
    await service.shutdown();
    await native.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 240000);
