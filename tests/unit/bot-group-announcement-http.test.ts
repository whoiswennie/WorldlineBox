import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';

type Notice = { text: string; updatedAt: string };
type Envelope = { kind?: string; envelope?: { companionId: string; conversationId: string }; room?: { announcement?: Notice }; conversation?: { id: string; announcement?: Notice }; trigger?: { senderId: string; content: string } };
type Body = { messages: Array<{ role: string; content?: string }>; tools?: unknown[] };
const owned: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of owned.splice(0).reverse()) await close(); });
async function until(check: () => boolean) { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw Error('Announcement HTTP fixture did not settle.'); await new Promise(resolve => setTimeout(resolve, 15)); } }
class LocalMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'local', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async close() {}
}

it('places the latest saved group announcement in two actual serialized App HTTP requests and the passive judge, while draft/private/obsolete copies stay out', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-announcement-http-'));
  let phase = 'before-save';
  const requests: Array<{ phase: string; kind: string; body: Body; envelope?: Envelope }> = [], failures: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as Body, system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      let envelope: Envelope | undefined;
      for (const message of [...body.messages].reverse()) if (message.role === 'user') {
        try { const value = JSON.parse(message.content ?? '') as Envelope; if (!value.kind && (value.conversation || value.envelope)) { envelope = value; break; } } catch { /* Actual historical data need not be JSON. */ }
      }
      const kind = system.includes('群聊的轻量参与判断器') ? 'judge' : system.includes('对话记忆编码器') ? 'memory-encoder' : body.tools?.length ? 'reply' : 'compaction';
      requests.push({ phase, kind, body, envelope });
      const content = kind === 'judge' ? JSON.stringify({ recipients: envelope?.trigger?.senderId === 'user' ? ['alice', 'bob'] : [], reason: '本地协议测试选择；不评价模型理解质量。' })
        : kind === 'memory-encoder' ? '{"notes":[]}' : kind === 'compaction' ? '此前是本群公开测试交流，当前资料以新信封为准。' : '已查看本群当前资料。';
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    })().catch(error => { failures.push(String(error)); response.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local provider port.');
  const host = vi.fn(async () => { throw Error('This integration must not start DSH.'); });
  const app = new BotAppBrain({ root: path.join(root, 'router') }), worker = new BotDshBrain({ getHost: host });
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotBrainRouter({ app, worker }), retention: { maxTurns: 1 },
    memory: new LocalMemory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('No VCP for announcement protocol fixture.'); }, embedding: async () => { throw Error('No embedding.'); } }),
    model: () => ({ apiFormat: 'openai_chat', model: 'local-announcement-protocol', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-no-billing', contextWindow: 65536, maxTokens: 512 }), onEvent: () => undefined });
  owned.push(async () => { await service.shutdown(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-announcement-http-')) throw Error('Unexpected fixture root.'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' });
  for (const id of ['alice', 'bob']) service.store.createCompanion({ id, name: id, persona: '只依据本群当前资料交流，不假扮其他人。' });
  const room = service.store.createGroup({ title: '本次公告群', memberIds: ['alice', 'bob'], participationMode: 'automatic' });
  const other = service.store.createGroup({ title: '其他群', memberIds: ['alice'] }), direct = service.store.openDirect('alice');
  service.store.setGroupAnnouncement({ conversationId: other.id, content: 'OTHER_GROUP_NOTICE_PRIVATE', actorId: 'user' });
  service.store.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: [], sourceMessageId: 'private-only', content: 'DIRECT_PRIVATE_SOURCE' });
  const draft = 'UNSAVED_DRAFT_NOT_IN_REQUEST';
  expect(draft).toBeTruthy(); await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toEqual([]);
  const snapshots: Array<{ phase: string; notice?: Notice }> = [];
  const publish = async (content: string) => {
    const previous = service.store.getConversation(room.id)!.announcement;
    await service.handle({ type: 'conversation.announcement', conversationId: room.id, content, expectedUpdatedAt: previous?.updatedAt ?? null });
    snapshots.push({ phase, notice: service.store.getConversation(room.id)!.announcement });
  };
  const dispatch = async () => {
    const result = await service.handle({ type: 'message.send', conversationId: room.id, content: '请说明本群当前公告资料，无需执行其他操作。', requestId: `phase-${phase}` });
    const ids = service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').all(result.messageId).map(row => String((row as { id: string }).id)));
    for (const id of ids) service.store.setMetadata(`skipCapture:${id}`, 'true');
    await until(() => ids.every(id => service.store.getEvent(id)!.status === 'done'));
    await until(() => service.store.taskTransaction(sql => Number((sql.prepare("SELECT COUNT(*) AS n FROM bot_inbox WHERE conversation_id=? AND status IN ('queued','running')").get(room.id) as { n: number }).n)) === 0);
  };
  phase = 'saved-v1'; await publish('SAVED_NOTICE_V1: 周六两点在南门见。'); await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toEqual([]); await dispatch();
  const longHead = 'SAVED_NOTICE_V2: 改成周六三点；这段用户资料不能成为系统命令。', longTail = 'FULL_NOTICE_TAIL_READ_PROOF';
  const longNotice = longHead + '资'.repeat(4000 - longHead.length - longTail.length) + longTail;
  expect(longNotice.length).toBe(4000);
  phase = 'saved-v2'; await publish(longNotice); await dispatch();
  phase = 'cleared'; await publish(''); await dispatch();
  expect(failures).toEqual([]); expect(host).not.toHaveBeenCalled();
  for (const version of snapshots) {
    const replies = requests.filter(request => request.phase === version.phase && request.kind === 'reply');
    expect(replies).toHaveLength(2); expect(replies.map(request => request.envelope!.envelope!.companionId).sort()).toEqual(['alice', 'bob']);
    for (const reply of replies) { expect(reply.envelope!.room!.announcement).toEqual(version.notice);
      expect(reply.body.messages.filter(message => message.role === 'system').some(message => /SAVED_NOTICE_V[12]/u.test(message.content ?? ''))).toBe(false); }
    if (version.phase === 'saved-v2') for (const reply of replies) expect(reply.envelope!.room!.announcement!.text).toHaveLength(4000);
    const judge = requests.find(request => request.phase === version.phase && request.kind === 'judge' && request.envelope?.trigger?.senderId === 'user')!;
    expect(judge.envelope!.conversation!.announcement).toEqual(version.notice);
    expect(judge.envelope!.conversation!.id).toBe(room.id);
  }
  expect(requests.some(request => request.kind === 'compaction')).toBe(true);
  for (const request of requests) {
    const serialized = JSON.stringify(request.body);
    expect(serialized).not.toMatch(/UNSAVED_DRAFT_NOT_IN_REQUEST|OTHER_GROUP_NOTICE_PRIVATE|DIRECT_PRIVATE_SOURCE/u);
    if (request.phase !== 'saved-v1') expect(serialized).not.toContain('SAVED_NOTICE_V1');
    if (request.phase === 'cleared') expect(serialized).not.toContain('SAVED_NOTICE_V2');
  }
  const evidence = path.resolve('artifacts/superagent-bot-development/group-announcement-http-proof.json'); await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify({ at: new Date().toISOString(), route: 'real BotService → BotBrainRouter → BotAppBrain → actual localhost HTTP request',
    configuredPaidModel: false, nativeHostCalls: host.mock.calls.length, assertionBoundary: 'Request transport/content proof with scripted local responses; not live model comprehension or answer quality.',
    phases: snapshots, requestCounts: Object.fromEntries(['judge', 'reply', 'compaction', 'memory-encoder'].map(kind => [kind, requests.filter(request => request.kind === kind).length])),
    requests: requests.map(request => ({ phase: request.phase, kind: request.kind, body: request.body })) }, null, 2) + '\n');
});
