import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotService } from '../../src/main/companion-bot/service';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { NativeServiceMemory } from '../fixtures/bot-native-service';
import { CabinWorld } from '../../src/main/cabin-world';
import { connectCabinPlugin } from '../../src/main/dsh/cabin-plugin';
import type { CompanionSchedule } from '../../src/shared/companion-schedule';

const program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
const bridgeJson = process.env.WORLDLINEBOX_TEST_CABIN_BRIDGE_JSON;
const bundled = process.env.WORLDLINEBOX_TEST_BUNDLED_CABIN === '1';
const prefix = 'mcp__cabin_world__';
type ModelRequest = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };

it.runIf(!!program && (!!bridgeJson || bundled))('creates a schedule in companion chat and runs it in a fresh native DSH session against Cabin World', async () => {
  const native = await createBotNativeHost(program!);
  const cabin = bundled ? new CabinWorld(path.resolve('resources/cabin-world'), path.join(native.root, 'cabin-data'), process.execPath) : undefined;
  const calls = [
    { name: prefix + 'cabin_status', arguments: {} },
    { name: prefix + 'cabin_use', arguments: { object: 'swing', use: 'swing' } },
    { name: prefix + 'cabin_go', arguments: { place: 'xjhome' } },
  ];
  const receipts: string[] = [];
  const companionId = 'cabin-world-test';
  const requestPrompt = '请帮我新增一个每隔一小时的小屋世界日程。';
  const prompt = '用小屋世界工具查一下小鲸鱼在哪儿，去公园荡秋千，再回家。';
  const draft = { title: '公园秋千', prompt, recurrence: { kind: 'interval', minutes: 60 }, enabled: true };
  let fixtureError: unknown;
  let modelRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      modelRequests++;
      let body = '';
      for await (const chunk of request) body += chunk;
      const wire = JSON.parse(body) as ModelRequest;
      const user = JSON.stringify(wire.messages.filter(message => message.role === 'user'));
      const names = wire.tools?.map(tool => tool.function.name);
      for (const call of calls) expect(names).toContain(call.name);
      expect(names).toContain(prefix + 'cabin_task_status');
      const results = wire.messages.filter(message => message.role === 'tool');
      const last = results.at(-1);
      const scheduling = user.includes(requestPrompt);
      expect(user).toContain(scheduling ? requestPrompt : prompt);
      if (!scheduling && last) receipts.push(JSON.stringify(last.content));
      const scheduleCalls = [
        { name: 'companion_schedule', arguments: { operation: 'save', draft } },
        { name: 'companion_schedule', arguments: { operation: 'settings', enabled: true } },
      ];
      const call = (scheduling ? scheduleCalls : calls)[results.length];
      const delta = call ? { tool_calls: [{ index: 0, id: `cabin-${results.length}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: scheduling ? '日程已创建并启用。' : '小鲸鱼荡完秋千，已经回家了。' };
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) { fixtureError = error; response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model fixture did not bind a port.');
  let service: BotService | undefined;
  let stage = 'install MCP bundle';
  try {
    const connect = () => connectCabinPlugin({ instance: native.instance, cabin: cabin ?? { bridgeJson: bridgeJson!, toolDefinitions: path.resolve(path.dirname(bridgeJson!), '../bridge/openai-tools.json') },
      packagePath: path.resolve('resources/dsh-cabin-world'), ensureHost: () => native.instances.ensureHost(native.instance.id),
      recordChange: result => native.instances.recordPluginChange(native.instance.id, result) });
    await connect();
    stage = 'discover MCP tools';
    const client = await native.instances.ensureHost(native.instance.id);
    const catalog = await client.request<{ catalog: { items: Array<{ name: string }> } }>('/capabilities', {
      sessionId: 'cabin-discovery', cwd: native.instance.workspacePath, companion: true,
      query: { kind: 'catalog', category: 'tool', query: prefix, limit: 15 },
    });
    expect(catalog.catalog.items.map(item => item.name)).toHaveLength(8);
    stage = 'create schedule in chat';
    const baseUrl = `http://127.0.0.1:${address.port}`;
    service = new BotService({ root: path.join(native.root, 'service'),
      brain: new BotDshBrain({ getHost: async () => ({ client, instance: native.instance }) }),
      memory: new NativeServiceMemory(path.join(native.root, 'service', 'memory')),
      model: () => ({ apiFormat: 'openai_chat', model: 'cabin-world-fixture', baseUrl, apiKey: 'local-no-billing' }),
      scheduledWorldOnline: async () => cabin ? cabin.online() : true,
      onEvent: () => undefined,
    });
    await service.handle({ type: 'state' });
    service.store.createCompanion({ id: companionId, name: '小屋测试伙伴', persona: '按游戏回执汇报小鲸鱼的动作。' });
    const { id: conversationId } = service.store.openDirect(companionId);
    expect(await service.handle({ type: 'message.send', conversationId, content: requestPrompt, requestId: 'cabin-schedule-create' })).toMatchObject({ ok: true });
    const list = () => service!.handle({ type: 'companion.schedule', companionId, command: { operation: 'list' } });
    await expect.poll(async () => (await list()).schedule, { timeout: 30000, interval: 200 }).toMatchObject({ enabled: true, items: expect.arrayContaining([expect.objectContaining({ title: draft.title, prompt })]) });
    const { schedule } = await list();
    const entry = (schedule!.items as CompanionSchedule[]).find(item => item.title === draft.title)!;
    expect(entry!.nextAt).toBeGreaterThan(Date.now());
    const toggle = async (enabled: boolean) => (await service!.handle({ type: 'companion.schedule', companionId, command: { operation: 'toggle', id: entry.id, enabled } })).schedule!.items.find(item => item.id === entry.id);
    expect(await toggle(false)).toMatchObject({ enabled: false });
    expect(await toggle(true)).toMatchObject({ enabled: true });
    const scheduleKey = 'companion-schedule:' + companionId;
    const due = () => service!.store.setMetadata(scheduleKey, JSON.stringify({ enabled: true, presetsAdded: true, items: [{ ...entry, nextAt: Date.now() - 1 }] }));
    if (cabin) {
      stage = 'skip while the bundled game is offline';
      await expect.poll(() => service!.store.messagesPage(conversationId).items.some(message => message.content === '日程已创建并启用。' && message.status === 'sent')).toBe(true);
      const before = modelRequests;
      due();
      await expect.poll(async () => (await list()).schedule!.items[0]?.lastRun?.status).toBe('skipped');
      expect(modelRequests).toBe(before);
      expect(await cabin.online()).toBe(false);
      expect(receipts).toHaveLength(0);
      expect(service.store.messagesPage(conversationId).items.some(message => message.senderId === 'schedule')).toBe(false);
      await cabin.open();
    }
    stage = 'execute an online schedule';
    due();
    await expect.poll(() => {
      if (fixtureError) throw fixtureError;
      return service!.store.messagesPage(conversationId).items.find(message => message.senderId === companionId && message.content === '小鲸鱼荡完秋千，已经回家了。');
    }, { timeout: 120000, interval: 200 }).toMatchObject({ status: 'sent', content: '小鲸鱼荡完秋千，已经回家了。' });
    expect(receipts).toHaveLength(3);
    expect(receipts[0]).toContain('xiaojingyu');
    expect(receipts[0]).toMatch(/connected\\*":true/);
    expect(receipts[1]).toContain('荡秋千');
    expect(receipts[1]).toMatch(/status\\*":\\*"done/);
    expect(receipts[2]).toMatch(/status\\*":\\*"done/);
    const reply = service.store.messagesPage(conversationId).items.find(message => message.senderId === companionId && message.content === '小鲸鱼荡完秋千，已经回家了。')!;
    const event = service.store.getEvent(reply.eventId)!;
    const previous = service.store.messagesPage(conversationId).items.find(message => message.senderId === companionId && message.content === '日程已创建并启用。')!;
    const chat = (await service.handle({ type: 'state', conversationId })).snapshot!;
    const scheduledTopic = chat.messages.find(message => message.id === reply.id)?.topic?.id;
    expect(scheduledTopic).toBeTruthy();
    expect(scheduledTopic).not.toBe(chat.messages.find(message => message.id === previous.id)?.topic?.id);
    expect(event.source).toBe('schedule');
    expect((await list()).schedule!.items[0]!.lastRun).toMatchObject({ status: 'done', topicId: scheduledTopic });
    if (cabin) expect(await cabin.state()).toMatchObject({ available: true, running: true });
  } catch (error) {
    const log = await readFile(path.join(native.instances.getRoot(native.instance.id), 'logs/host.log'), 'utf8').catch(() => '');
    if (log) process.stderr.write(log);
    throw new Error(`Cabin World acceptance failed at ${stage}.`, { cause: error });
  } finally {
    await service?.shutdown();
    await cabin?.close();
    try { await native.close(); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}, 360000);
