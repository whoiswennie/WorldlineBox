import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { parseGroupAttention, routeGroupAttention } from '../../src/main/companion-bot/group-attention';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Memory extends BotMemoryService {
  prepared: string[] = [];
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No fixture process'); }, embedding: async () => { throw Error('No fixture encoder'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    this.prepared.push(input.requestId); return { requestId: input.requestId, inputHash: 'fixture', scope: input.scope, messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async close() {}
}
async function until(check: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw Error('Group attention did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(options: { hold?: Promise<void>; peer?: boolean; invalid?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-group-attention-'));
  const requests: Array<{ system: string; input: Record<string, unknown> }> = [], hostCalls: string[] = [];
  const app = new BotAppBrain({ root: path.join(root, 'app-brain'), fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find(message => message.role === 'system')!.content;
    const user = [...body.messages].reverse().find(message => message.role === 'user')!.content;
    const input = JSON.parse(user) as Record<string, unknown>; requests.push({ system, input });
    let content: string;
    if (system.includes('轻量参与判断器')) {
      await options.hold;
      const trigger = input.trigger as { senderId: string; content: string };
      const recipients = trigger.senderId !== 'user' ? options.peer && trigger.senderId === 'alpha' ? ['beta'] : []
        : trigger.content === '大家一起出个主意' ? ['alpha', 'beta'] : trigger.content === '那个蓝色头发的伙伴怎么看' ? ['alpha'] : [];
      content = JSON.stringify({ recipients: options.invalid ? ['outside-room'] : recipients, reason: 'Local deterministic assessment fixture' });
    } else if (system.includes('对话记忆编码器')) content = JSON.stringify({ notes: [] });
    else content = '收到，我来回应这个话题。';
    const delta = JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
    return new Response(`data: ${delta}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const worker = new BotDshBrain({ getHost: async () => { hostCalls.push('unexpected'); throw Error('Group participation must not start DSH.'); } });
  const memory = new Memory(root), service = new BotService({ root, brain: new BotBrainRouter({ app, worker }), brainRuntime: 'worldlinebox', memory,
    model: () => ({ apiFormat: 'openai_chat', model: 'local-group-fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-no-network', contextWindow: 1000000 }), onEvent: () => undefined });
  cleanup.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' });
  for (const [id, name, persona] of [['alpha', '大肥鱼', '蓝色头发'], ['beta', 'GPT', '银白头发'], ['gamma', '黑幻', '沉静']]) service.store.createCompanion({ id: id!, name: name!, persona: persona! });
  const room = service.store.createGroup({ title: '共享讨论', memberIds: ['alpha', 'beta', 'gamma'] });
  const send = async (content: string, requestId: string) => service.handle({ type: 'message.send', conversationId: room.id, requestId, content });
  const idle = () => service.store.taskTransaction(sql => Number((sql.prepare("SELECT count(*) AS n FROM bot_inbox WHERE conversation_id=? AND status IN ('queued','running')").get(room.id) as { n: number }).n)) === 0;
  const replies = () => service.store.messagesPage(room.id).items.filter(message => message.senderId !== 'user' && message.status === 'sent');
  return { root, service, memory, requests, room, send, idle, replies, hostCalls };
}

it('admits a natural direct call immediately and validates semantic targets without prefix or quotation guesses', () => {
  const actors = [{ id: 'alpha', name: '大肥鱼' }, { id: 'beta', name: '大肥鱼姐姐' }, { id: 'gamma', name: 'GPT' }];
  expect(routeGroupAttention(actors, '大肥鱼在吗', 'automatic')).toEqual({ targets: ['alpha'], candidate: false });
  expect(routeGroupAttention(actors, '我看到“大肥鱼在吗”这句话', 'automatic').candidate).toBe(true);
  expect(routeGroupAttention(actors, '大肥鱼姐姐，你怎么看', 'automatic').targets).toEqual(['beta']);
  expect(parseGroupAttention('{"recipients":[],"reason":"旁观"}', ['alpha'])).toEqual({ recipients: [], reason: '旁观' });
  expect(() => parseGroupAttention('{"recipients":["other"]}', ['alpha'])).toThrow('非成员');
});

it('coalesces three silent candidates into one real App-engine assessment before any VCP or DSH work', async () => {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ hold }); await f.send('这句话不用回应', 'quiet');
  await until(() => f.requests.length === 1);
  expect(f.memory.prepared).toEqual([]); expect(f.replies()).toEqual([]);
  expect(f.service.store.messagesPage(f.room.id).items).toHaveLength(1);
  release(); await until(f.idle);
  expect(f.requests).toHaveLength(1); expect(f.memory.prepared).toEqual([]); expect(f.replies()).toEqual([]); expect(f.hostCalls).toEqual([]);
  const replay = await f.send('这句话不用回应', 'quiet'); expect(replay.ok).toBe(true); await until(f.idle); expect(f.requests).toHaveLength(1);
});

it('selects zero, one or multiple actual members, lets peers observe without duplicate transcript and keeps direct calls free of triage', async () => {
  const f = await fixture(); await f.send('大肥鱼在吗', 'direct-name'); await until(f.idle);
  expect(f.replies().map(message => message.senderId)).toEqual(['alpha']);
  expect(f.requests.filter(request => request.system.includes('轻量参与判断器')).every(request => (request.input.trigger as { senderId: string }).senderId !== 'user')).toBe(true);
  await f.send('那个蓝色头发的伙伴怎么看', 'implicit-role'); await until(f.idle);
  expect(f.replies().map(message => message.senderId)).toEqual(['alpha', 'alpha']);
  await f.send('大家一起出个主意', 'multiple'); await until(f.idle);
  expect(f.replies().slice(-2).map(message => message.senderId).sort()).toEqual(['alpha', 'beta']);
  const source = f.service.store.messagesPage(f.room.id).items;
  expect(source.filter(message => message.senderId === 'user')).toHaveLength(3);
  expect(source.filter(message => message.content === '收到，我来回应这个话题。')).toHaveLength(4);
  expect(f.memory.prepared).toHaveLength(4); expect(f.hostCalls).toEqual([]);
});

it('permits meaningful peer responses in the same user-owned group and rejects an invented assessment member', async () => {
  const f = await fixture({ peer: true }); await f.send('大肥鱼在吗', 'peer-exchange'); await until(f.idle);
  expect(f.replies().map(message => message.senderId)).toEqual(['alpha', 'beta']);
  expect(f.service.store.getConversation(f.room.id)).toMatchObject({ ownerId: 'user', memberIds: expect.arrayContaining(['user']) });
  const invalid = await fixture({ invalid: true }); await invalid.send('随便聊聊', 'invalid'); await until(invalid.idle);
  expect(invalid.replies()).toEqual([]); expect(invalid.memory.prepared).toEqual([]); expect(invalid.hostCalls).toEqual([]);
});

it('reuses an exact participant set without changing its title, policy, history or creating a second group', async () => {
  const f = await fixture(); const same = f.service.store.createGroup({ title: '不能覆盖', memberIds: ['gamma', 'beta', 'alpha', 'alpha'], includeUser: false, participationMode: 'all' });
  expect(same).toEqual(f.room); expect(same.ownerId).toBe('user');
  expect(f.service.store.conversations().filter(room => room.kind === 'group')).toHaveLength(1);
});
