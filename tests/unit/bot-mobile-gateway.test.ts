import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Client } from 'ssh2';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { startMobileGateway } from '../../src/main/companion-bot/mobile-gateway';
import { MobileAccessSettings } from '../../src/main/companion-bot/mobile-access-settings';
import { startMobileSsh } from '../../src/main/companion-bot/mobile-ssh';
import { MOBILE_ACCESS_PORT } from '../../src/shared/mobile-access';
import { BotService } from '../../src/main/companion-bot/service';
import { NativeServiceMemory, waitNative } from '../fixtures/bot-native-service';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

it('routes a mobile attachment and one durable message into the same desktop topic and downloads the published output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-mobile-test-'));
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
  const token = '9'.repeat(64);
  const port = await freePort();
  const output = path.join(root, 'result.csv');
  await writeFile(output, 'sum\n6\n');
  const calls: BotDshRun[] = [];
  const compactions: { laneId: string; requestId: string }[] = [];
  class Brain extends BotDshBrain {
    constructor() { super({ getHost: async () => { throw Error('Isolated execution adapter'); } }); }
    override async run(input: BotDshRun) {
      const memory = input.laneId.startsWith('memory-');
      if (!memory) calls.push(input);
      return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded' as const,
        text: memory ? '{"notes":[]}' : '已汇总', ...(memory ? {} : { artifacts: [{ path: output }] }) };
    }
    override async close() {}
    override async compact(input: Pick<BotDshRun, 'laneId'>, requestId: string) {
      compactions.push({ laneId: input.laneId, requestId });
      return true;
    }
    override async topicContext(laneId: string) {
      return { source: 'dsh-native-projections' as const, sessionId: BotDshBrain.sessionId(laneId),
        state: 'ready' as const, sampledAt: new Date().toISOString(), pressure: { projectedTokens: 3200, contextWindow: 128000 } };
    }
  }
  let gateway: Awaited<ReturnType<typeof startMobileGateway>>;
  const service = new BotService({ root, media, brain: new Brain(), memory: new NativeServiceMemory(root),
    model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', model: 'fixture', apiKey: 'fixture' }),
    onEvent: event => gateway?.notify(event) });
  const access = new MobileAccessSettings(root, async manager => {
    gateway = await startMobileGateway({ root, access: manager, port, bot: async () => service, media: async () => media, report: () => undefined });
    return { host: '127.0.0.1', sshPort: 47832, fingerprint: `SHA256:${'A'.repeat(43)}`,
      close: () => gateway?.close(), connected: () => false, disconnect: () => undefined };
  }, async data => data);
  try {
    await access.initialize();
    const pairing = JSON.parse((await access.request({ type: 'pair' })).pairing!.image);
    expect(await access.redeem(pairing.code, token, '测试手机')).toBe(true);
    const base = `http://127.0.0.1:${port}/mobile/v1`;
    const headers = { authorization: `Bearer ${token}` };
    const call = (data: object) => fetch(`${base}/requests`, { method: 'POST', headers, body: JSON.stringify(data) });
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers })).status).toBe(200);
    expect((await call({ type: 'companion.data.clear', companionId: 'dummy', requestId: 'blocked' })).status).toBe(403);
    const directory = await (await call({ type: 'state' })).json();
    expect(directory.snapshot.companions[0]).not.toHaveProperty('persona');
    const room = directory.snapshot.conversations[0].id as string;
    expect(await (await call({ type: 'user.identity', name: '林舟', bio: '偏好先看简短结论' })).json())
      .toMatchObject({ ok: true, userName: '林舟', userBio: '偏好先看简短结论' });
    expect(await (await call({ type: 'user.identity' })).json()).toMatchObject({ userName: '林舟', userBio: '偏好先看简短结论' });
    const topic = (await service.handle({ type: 'topic.new', conversationId: room, requestId: 'desktop-topic' })).topic!;
    const eventResponse = await fetch(`${base}/events?conversationId=${room}`, { headers });
    const reader = eventResponse.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toContain('"type":"ready"');
    gateway!.notify({ type: 'progress', conversationId: room, messageId: 'reply-fixture', progress: { phase: 'recalling-memory' } });
    gateway!.notify({ type: 'text', conversationId: room, messageId: 'reply-fixture', text: '正在汇总' });
    let live = '';
    while (!live.includes('正在汇总')) live += Buffer.from((await reader.read()).value!).toString();
    expect(live).toContain('"phase":"recalling-memory"');
    const upload = await fetch(`${base}/files?conversationId=${room}&name=input.csv`, { method: 'PUT', headers, body: 'n\n1\n2\n3\n' });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()).attachment;
    expect(attachment.name).toBe('input.csv');
    expect((await fetch(`${base}/files?conversationId=${room}&name=..%2Funsafe`, { method: 'PUT', headers, body: 'x' })).status).toBe(400);
    const request = { type: 'message.send', conversationId: room, content: '汇总 CSV', requestId: 'phone-1', topicId: topic.id, attachmentIds: [attachment.id] };
    const accepted = await (await call(request)).json();
    expect(accepted.ok).toBe(true);
    expect(service.store.getMessage(accepted.messageId)).toMatchObject({
      senderName: '林舟', origin: { kind: 'mobile', label: '测试手机' },
    });
    const sourceId = service.store.getMessage(accepted.messageId)?.origin?.id;
    const renamed = await fetch(`${base}/profile`, { method: 'PUT', headers, body: JSON.stringify({ name: '新设备名' }) });
    expect(await renamed.json()).toMatchObject({ name: '新设备名' });
    expect(access.authenticate(headers.authorization)).toBe(sourceId?.slice('mobile:'.length));
    await call({ type: 'user.identity', name: '林舟', bio: '已改介绍' });
    expect((await (await call(request)).json()).messageId).toBe(accepted.messageId);
    await reader.cancel();
    await waitNative(() => service.store.getMessage(accepted.replyMessageIds[0])?.status === 'sent');
    const state = await (await call({ type: 'state', conversationId: room })).json();
    const result = state.snapshot.messages.find((message: { id: string }) => message.id === accepted.replyMessageIds[0]);
    expect(result.topic.id).toBe(topic.id);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.prompt).delivery).toMatchObject({
      speaker: { id: 'user', name: '林舟' },
      userProfile: { name: '林舟', bio: '偏好先看简短结论' },
    });
    const download = `${base}/files?conversationId=${room}&messageId=${result.id}&id=${result.attachments[0].id}`;
    expect(await (await fetch(download, { headers })).text()).toBe('sum\n6\n');
    expect(await (await fetch(download, { headers: { ...headers, range: 'bytes=4-4' } })).text()).toBe('6');
    expect((await fetch(download.replace(result.id, accepted.messageId), { headers })).status).toBe(404);
    const member = service.store.getEvent(calls[0]!.eventId)!.companionId;
    const newTopic = { type: 'topic.new', conversationId: room, requestId: 'phone-new-topic' };
    const draft = (await (await call(newTopic)).json()).topic;
    expect(draft.id).not.toBe(topic.id);
    expect((await (await call(newTopic)).json()).topic.id).toBe(draft.id);
    const compact = { type: 'topic.compact', conversationId: room, topicId: topic.id, companionId: member, requestId: 'phone-compact' };
    expect(await (await call({ ...compact, topicId: draft.id })).json()).toMatchObject({
      ok: false, error: '这位伙伴尚未在此话题中开始会话。',
    });
    expect(await (await call({ type: 'topic.select', conversationId: room, topicId: topic.id })).json()).toMatchObject({ ok: true, topic: { id: topic.id } });
    expect(await (await call(compact)).json()).toMatchObject({ ok: true, compacted: true });
    expect(compactions).toEqual([{ laneId: calls[0]!.laneId, requestId: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect((await call({ type: 'history.search', conversationId: room, query: 'result.csv' })).status).toBe(403);
    const delta = await (await call({ type: 'state', conversationId: room, after: state.snapshot.cursor })).json();
    expect(delta.snapshot.messages).toEqual([]);
    expect(delta.snapshot.chatRuntime.contexts[member]).toMatchObject({ pressure: { projectedTokens: 3200, contextWindow: 128000 } });
    const tracked = await (await call({ type: 'state', conversationId: room, after: state.snapshot.cursor, tracked: [result.id] })).json();
    expect(tracked.snapshot.messages).toMatchObject([{ id: result.id }]);
    const quote = { type: 'message.send', conversationId: room, content: '请解释刚才的结果', requestId: 'phone-quote', topicId: topic.id, quoteMessageId: result.id };
    const quoted = await (await call(quote)).json();
    expect(quoted.message.quote).toMatchObject({ id: result.id, excerpt: '已汇总' });
    expect((await (await call(quote)).json()).messageId).toBe(quoted.messageId);
    expect((await (await call({ ...quote, quoteMessageId: accepted.messageId })).json()).ok).toBe(false);
    await waitNative(() => service.store.getMessage(quoted.replyMessageIds[0])?.status === 'sent');
    expect(JSON.parse(calls.at(-1)!.prompt).message.quote).toMatchObject({ id: result.id, excerpt: '已汇总' });
    const uploadId = 'b59fd055-8bb4-4cd4-9ce3-2d5dcbb80781';
    const resumable = `${base}/upload?conversationId=${room}&id=${uploadId}`;
    const part = (offset: number, body: string) => fetch(`${resumable}&name=resume.txt&total=6&offset=${offset}`, { method: 'PUT', headers, body });
    expect(await (await part(0, 'abc')).json()).toMatchObject({ offset: 3 });
    expect((await part(0, 'abc')).status).toBe(409);
    expect(await (await fetch(resumable, { headers })).json()).toMatchObject({ offset: 3 });
    const completed = await (await part(3, 'def')).json();
    expect(completed).toMatchObject({ offset: 6, attachment: { name: 'resume.txt', size: 6 } });
    expect(await (await fetch(resumable, { headers })).json()).toEqual(completed);
    const callResult = await (await call({ type: 'call.open', conversationId: room })).json();
    expect(callResult).toMatchObject({ ok: true, callStage: { mode: 'portrait' } });
    const meetingTopic = await (await call({ type: 'topic.new', conversationId: callResult.conversationId, requestId: 'mobile-call' })).json();
    expect(meetingTopic).toMatchObject({ ok: true, topic: { id: expect.any(String) } });
  } finally {
    access.close();
    await service.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
});

it('pairs a device once, disconnects its live stream, resumes it, and revokes it across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-mobile-device-'));
  const port = await freePort();
  const start = async (access: MobileAccessSettings) => ({ ...(await startMobileGateway({ root, access, port,
    bot: async () => ({} as BotService), media: async () => { throw new Error('Unexpected media access'); }, report: () => undefined }))!,
    host: '127.0.0.1', sshPort: 47832, fingerprint: `SHA256:${'A'.repeat(43)}` });
  const render = async (text: string) => text;
  let settings = new MobileAccessSettings(root, start, render);
  const base = `http://127.0.0.1:${port}/mobile/v1`;
  const token = 'c'.repeat(64);
  const headers = { authorization: `Bearer ${token}` };
  const pair = () => settings.request({ type: 'pair' });
  const health = () => fetch(`${base}/health`, { headers });
  try {
    await settings.initialize();
    expect((await settings.request({ type: 'service', enabled: true })).state?.running).toBe(true);
    const details = JSON.parse((await pair()).pairing!.image);
    const redeem = (deviceToken = token) => fetch(`${base}/pair`, { method: 'POST', body: JSON.stringify({ code: details.code, token: deviceToken, name: '测试手机' }) });
    expect((await health()).status).toBe(401);
    expect((await redeem()).status).toBe(201);
    expect((await redeem()).status).toBe(201);
    expect((await redeem('d'.repeat(64))).status).toBe(403);
    expect((await health()).status).toBe(200);
    const id = (await settings.request({ type: 'state' })).state!.devices[0]!.id;
    const stream = (await fetch(`${base}/events`, { headers })).body!.getReader();
    expect(Buffer.from((await stream.read()).value!).toString()).toContain('ready');
    expect((await settings.request({ type: 'state' })).state?.devices[0]?.connected).toBe(true);
    await settings.request({ type: 'device.pause', id });
    await expect(stream.read()).rejects.toThrow();
    expect((await health()).status).toBe(401);
    await settings.request({ type: 'device.resume', id });
    expect((await health()).status).toBe(200);
    await settings.request({ type: 'device.remove', id });
    expect((await health()).status).toBe(401);
    settings.close();
    settings = new MobileAccessSettings(root, start, render);
    await settings.initialize();
    expect((await settings.request({ type: 'state' })).state?.devices).toEqual([]);
    expect((await health()).status).toBe(401);
  } finally {
    settings.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
});

it('accepts QR and device SSH credentials and limits forwarding to the companion endpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-mobile-ssh-'));
  const targetPort = await freePort();
  const target = createServer(socket => socket.end('mobile API fixture'));
  await new Promise<void>(resolve => target.listen(targetPort, '127.0.0.1', resolve));
  let port: number;
  const start = async (manager: MobileAccessSettings) => {
    const listener = await startMobileSsh(root, manager, { port: 0, targetPort });
    port = listener.sshPort;
    return { ...listener, connected: () => false };
  };
  const render = async (text: string) => text;
  let access = new MobileAccessSettings(root, start, render);
  const clients = new Set<Client>();
  const login = (username: string, password: string, fingerprint?: string) => new Promise<Client>((resolve, reject) => {
    const client = new Client();
    clients.add(client);
    client.once('ready', () => resolve(client)).on('error', reject).connect({ host: '127.0.0.1', port, username, password,
      ...(fingerprint ? { hostVerifier: (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}` === fingerprint } : {}),
    });
  });
  try {
    await access.initialize();
    const pair = await access.request({ type: 'pair' });
    expect(pair.state?.running).toBe(true);
    const { code, fingerprint } = JSON.parse(pair.pairing!.image);
    const guest = await login('pair', code, fingerprint);
    const payload = await new Promise<string>((resolve, reject) => {
      guest.forwardOut('127.0.0.1', 0, '127.0.0.1', MOBILE_ACCESS_PORT, (error, stream) => {
        if (error) { reject(error); return; }
        let body = '';
        stream.on('data', (chunk: Buffer) => { body += chunk.toString(); }).on('end', () => resolve(body)).on('error', reject);
      });
    });
    expect(payload).toBe('mobile API fixture');
    await new Promise<void>((resolve, reject) => guest.forwardOut('127.0.0.1', 0, '127.0.0.1', 22, error => error ? resolve() : reject(new Error('Unexpected forwarding access'))));
    await new Promise<void>((resolve, reject) => guest.shell(error => error ? resolve() : reject(new Error('Unexpected shell access'))));
    const token = 'a'.repeat(64);
    expect(await access.redeem(code, token, 'Android')).toBe(true);
    const beforeRestart = await login('mobile', token, fingerprint);
    const closedForRestart = Promise.all([beforeRestart, guest].map(client => new Promise<void>(resolve => client.once('close', resolve))));
    access.close();
    await closedForRestart;
    access = new MobileAccessSettings(root, start, render);
    await access.initialize();
    expect((await access.request({ type: 'state' })).state?.running).toBe(true);
    const device = await login('mobile', token, fingerprint);
    const closed = new Promise<void>(resolve => device.once('close', resolve));
    const id = (await access.request({ type: 'state' })).state!.devices[0]!.id;
    await access.request({ type: 'device.remove', id });
    await closed;
    await expect(login('mobile', token)).rejects.toThrow();
  } finally {
    for (const client of clients) client.end();
    access.close();
    await new Promise<void>(resolve => target.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
});

it('restores a failed fixed endpoint with the saved device, and stops retrying when disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-mobile-fixed-'));
  const token = 'b'.repeat(64);
  const endpoint = { host: 'mobile.example.com', sshPort: 443, fingerprint: `SHA256:${'A'.repeat(43)}`,
    transport: 'wss' as const, endpointMode: 'fixed' as const };
  const connectors: { alive: boolean; close(): void }[] = [];
  const start = vi.fn(async () => {
    if (connectors.length === 1 && start.mock.calls.length === 2) throw new Error('公网入口连接超时。');
    const connector = { alive: true, close() { this.alive = false; } };
    connectors.push(connector);
    return { ...endpoint, alive: () => connector.alive, close: () => connector.close(),
      connected: () => false, disconnect: () => undefined };
  });
  let settings = new MobileAccessSettings(root, start, async value => value, true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await settings.initialize();
    const pair = await settings.request({ type: 'pair' });
    const qr = JSON.parse(pair.pairing!.image);
    expect(qr).toMatchObject({ host: endpoint.host, fingerprint: endpoint.fingerprint, transport: endpoint.transport });
    expect(await settings.redeem(qr.code, token, 'Android')).toBe(true);
    const deviceId = settings.authenticate(`Bearer ${token}`);
    expect(deviceId).toBeTruthy();
    settings.close();

    settings = new MobileAccessSettings(root, start, async value => value, true);
    await settings.initialize();
    expect((await settings.request({ type: 'state' })).state).toMatchObject({
      enabled: true, running: false, endpointMode: 'fixed',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await settings.request({ type: 'state' })).state).toMatchObject({ running: true });
    expect(settings.authenticate(`Bearer ${token}`)).toBe(deviceId);

    connectors.at(-1)!.alive = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(start).toHaveBeenCalledTimes(4);
    expect(settings.authenticate(`Bearer ${token}`)).toBe(deviceId);
    await settings.request({ type: 'service', enabled: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).toHaveBeenCalledTimes(4);
    expect(settings.authenticate(`Bearer ${token}`)).toBeUndefined();
  } finally {
    settings.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  }
});
