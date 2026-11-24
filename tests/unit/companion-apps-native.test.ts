import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { botAppTools } from '../../src/shared/companion-apps';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { NativeServiceMemory } from '../fixtures/bot-native-service';
import { createCompanionAssetApp } from '../fixtures/companion-asset-app';

type Wire = { role: string; content: string | Array<{ text?: string }> };
const wireText = (message: Wire) => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('\n');

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('changes app tools in the same real DSH Session and removes future context and execution access when detached', async () => {
  let releaseModel!: () => void; const modelGate = new Promise<void>(resolve => { releaseModel = resolve; }); let appCalls = 0;
  const observations: Array<{ latest: string; tools: string[]; system: string; envelope: Record<string, unknown> }> = [], errors: string[] = [];
  const revocationErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Wire[]; tools: Array<{ function: { name: string } }> };
      const envelopes = body.messages.flatMap(message => { if (message.role !== 'user') return []; try { const value = JSON.parse(wireText(message)); return value.message?.id ? [value] : []; } catch { return []; } });
      const latest = envelopes.at(-1), tools = body.tools?.map(tool => tool.function.name) ?? [];
      if (latest) observations.push({ latest: latest.message.content, tools, system: body.messages.filter(message => message.role === 'system').map(wireText).join('\n'), envelope: latest });
      const name = ['asset-task', 'active-revoke'].includes(latest?.message.content) ? 'asset_manager' : latest?.message.content === 'browser-task' ? 'browser' : undefined;
      if (latest?.message.content === 'active-revoke' && body.messages.at(-1)?.role !== 'tool') await modelGate;
      const delta = name && body.messages.at(-1)?.role !== 'tool'
        ? { tool_calls: [{ index: 0, id: 'app-call-' + latest.message.id, type: 'function', function: { name, arguments: JSON.stringify(name === 'browser' ? { action: 'tabs' } : { action: 'tools', query: 'library', offset: 0, limit: 3 }) } }] }
        : { content: 'APP_DONE ' + (latest?.message.content ?? '') };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n' + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); response.writeHead(500); response.end('Fixture failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!), root = path.join(native.root, 'bot'); await mkdir(root);
  const assets = await createCompanionAssetApp(path.join(root, 'assets-mcp'));
  const client = await native.instances.ensureHost(native.instance.id), brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const browserContext = { referenceId: randomUUID(), tabId: 'owned-tab', url: 'http://127.0.0.1/owned', title: 'Owned tab', selection: '', capturedAt: new Date().toISOString() };
  const service = new BotService({ root, brain, memory: new NativeServiceMemory(path.join(root, 'memory')), onEvent() {}, report(error) {
    if (String(error).includes('/bot/app-revoke')) revocationErrors.push(error);
    process.stderr.write(String(error) + '\n');
  }, assetManagerApp: { connect: (...args) => assets.app.connect(...args), execute: (...args) => { appCalls++; return assets.app.execute(...args); } },
    resolveBrowserContext: () => browserContext, browserTool: async () => ({ value: { tabs: [{ id: 'owned-tab' }] } }),
    videoTool: async () => ({ result: [] }), musicTool: async () => ({}),
    model: () => ({ apiFormat: 'openai_chat', model: 'apps-native-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', contextWindow: 32768, maxTokens: 2048 }) });
  try {
    const initial = (await service.handle({ type: 'state' })).snapshot!, room = initial.conversations.find(room => room.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    const send = async (content: string, apps: Array<'browser' | 'asset-manager'> = [], browserContextId?: string, surface?: 'call') => {
      const sent = await service.handle({ type: 'message.send', conversationId: room.id, requestId: randomUUID(), content, apps, browserContextId, surface }); expect(sent.ok, sent.error).toBe(true);
      await expect.poll(() => { const reply = service.store.getMessage(sent.replyMessageIds![0]!); if (reply?.status === 'failed') throw Error(reply.error); return reply?.status; }, { timeout: 40000 }).toBe('sent');
      return (await service.handle({ type: 'state', conversationId: room.id })).snapshot!;
    };
    const plain = await send('plain'); const session = plain.messages.at(-1)!.execution!.sessionId;
    const latest = (name: string) => observations.findLast(item => item.latest === name)!;
    for (const [appId, surface] of [['video', undefined], ['music', 'call']] as const) {
      expect((await service.handle({ type: 'app.connect', conversationId: room.id, appId })).ok).toBe(true);
      const enabled = await send(appId + '-enabled', [], undefined, surface);
      expect(enabled.messages.at(-1)!.execution!.sessionId).toBe(session);
      expect(latest(appId + '-enabled').tools).toEqual(expect.arrayContaining([...botAppTools[appId]]));
      expect((await service.handle({ type: 'app.detach', conversationId: room.id, appId })).ok).toBe(true);
      const disabled = await send(appId + '-disabled', [], undefined, surface);
      expect(disabled.messages.at(-1)!.execution!.sessionId).toBe(session);
      for (const name of botAppTools[appId]) expect(latest(appId + '-disabled').tools).not.toContain(name);
    }
    expect((await service.handle({ type: 'app.connect', conversationId: room.id, appId: 'asset-manager' })).ok).toBe(true);
    const attached = await send('asset-task', ['asset-manager']); expect(attached.messages.at(-1)!.execution!.sessionId).toBe(session);
    const topicId = attached.chatRuntime!.topic!.id;
    expect(attached.chatRuntime!.apps).toEqual(['asset-manager']);
    await service.handle({ type: 'app.detach', conversationId: room.id, topicId, appId: 'asset-manager' });
    const removed = await send('removed'); expect(removed.messages.at(-1)!.execution!.sessionId).toBe(session);
    await service.handle({ type: 'app.browser', conversationId: room.id, referenceId: browserContext.referenceId });
    const browser = await send('browser-task', ['browser'], browserContext.referenceId); expect(browser.messages.at(-1)!.execution!.sessionId).toBe(session);
    await service.handle({ type: 'app.detach', conversationId: room.id, topicId, appId: 'browser' });
    await send('browser-removed');
    const beforeRevoked = appCalls;
    const activeApps = ['asset-manager', 'video', 'music'] as const;
    for (const appId of activeApps) expect((await service.handle({ type: 'app.connect', conversationId: room.id, appId })).ok).toBe(true);
    const revoking = send('active-revoke', ['asset-manager']);
    await expect.poll(() => observations.some(item => item.latest === 'active-revoke'), { timeout: 40000 }).toBe(true);
    for (const appId of activeApps) expect((await service.handle({ type: 'app.detach', conversationId: room.id, topicId, appId })).ok).toBe(true);
    releaseModel(); await revoking;
    expect(revocationErrors).toEqual([]);
    for (const appId of activeApps) for (const name of botAppTools[appId]) expect(latest('active-revoke').tools).not.toContain(name);
    expect(appCalls).toBe(beforeRevoked);
    for (const name of ['plain', 'removed', 'browser-removed', 'active-revoke']) { expect(latest(name).tools).not.toContain('asset_manager'); expect(latest(name).tools).not.toContain('browser'); if (name !== 'active-revoke') expect(latest(name).envelope).not.toHaveProperty('apps'); expect(latest(name).envelope).not.toHaveProperty('browserContext'); expect(latest(name).system).not.toContain('MCP'); }
    expect(latest('asset-task').tools).toContain('asset_manager'); expect(latest('asset-task').tools).not.toContain('browser');
    expect(latest('browser-task').tools).toContain('browser'); expect(latest('browser-task').tools).not.toContain('asset_manager'); expect(latest('browser-task').envelope.browserContext).toEqual(browserContext);
    expect(errors).toEqual([]);
    const evidence = path.resolve('artifacts/companion-apps'); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'native-result.json'), JSON.stringify({ passed: true, actualDshHost: true, runtimeVersion: native.runtimeVersion, modelEndpoint: 'local-scripted-fixture', sameNativeSession: session, actualMcpHttp: true, appCatalogNeverInjectedWhenUnselected: true, browserAndAssetsIndependentlyRemoved: true, turns: observations.map(({ latest, tools }) => ({ latest, apps: tools.filter(name => ['browser', 'asset_manager'].includes(name)) })) }, null, 2));
  } finally { releaseModel(); await service.shutdown(); await assets.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 180000);
