import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { BotDshBrain, BotDshDeliveryUnknownError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { botRequestSchema } from '../../src/shared/companion-bot';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';
import type { BotScheduler } from '../../src/main/companion-bot/scheduler';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
class Memory extends BotMemoryService {
  preparations = new Map<string, BotMemoryPrepared>();
  deletedSources = new Map<string, { sourceEventIds: string[]; sourceMessageIds: string[] }>();
  nativeWithdrawals: Array<{ sourceEventIds: string[]; sourceMessageIds: string[] }> = [];
  private tombstones = new Map<string, { sourceEventIds: string[]; sourceMessageIds: string[] }>();
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No actual VCP runtime'); }, embedding: async () => { throw Error('No actual encoder'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    const prepared: BotMemoryPrepared = { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'fixture', status: 'ready', evidence: '', metadata: {}, events: [], omittedChars: 0 };
    this.preparations.set(input.requestId, prepared); return prepared;
  }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]) { return this.preparations.get(input.requestId)!; }
  override async withdrawnSources(scope: Parameters<BotMemoryService['withdrawnSources']>[0]) { const sources = this.tombstones.get(scope.conversationId); return { revision: sources ? '1' : '0', sourceEventIds: sources?.sourceEventIds ?? [], sourceMessageIds: sources?.sourceMessageIds ?? [] }; }
  override async withdrawSources(scope: Parameters<BotMemoryService['withdrawSources']>[0], input: Parameters<BotMemoryService['withdrawSources']>[1]) {
    this.nativeWithdrawals.push(input); const previous = await this.withdrawnSources(scope), next = { sourceEventIds: [...new Set([...previous.sourceEventIds, ...input.sourceEventIds])], sourceMessageIds: [...new Set([...previous.sourceMessageIds, ...input.sourceMessageIds])] };
    this.tombstones.set(scope.conversationId, next); return { withdrawn: true as const, revision: '1', ...next };
  }
  override async forget(scope: Parameters<BotMemoryService['forget']>[0], input: Parameters<BotMemoryService['forget']>[1]) {
    const sources = this.deletedSources.get(input.id); if (!sources) throw Error('No such fixture note'); this.tombstones.set(scope.conversationId, sources);
    return { forgotten: true as const, id: input.id, revision: '1', relatedIds: [input.id], physicalSourceErasure: false as const, ...sources };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async close() {}
}
class Brain extends BotDshBrain {
  calls: BotDshRun[] = [];
  constructor(private readonly handle: (input: BotDshRun) => Promise<string> = async () => '已收到') { super({ getHost: async () => { throw Error('No actual Host or model'); } }); }
  override async run(input: BotDshRun) {
    this.calls.push(input); const text = input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : await this.handle(input);
    return { status: 'succeeded' as const, text, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), inputContextCommitted: true };
  }
  override async cancelDurable() { return { accepted: true, absent: true }; }
  override async close() {}
}
const fixtures: Array<{ root: string; services: BotService[] }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const service of fixture.services) await service.shutdown();
    if (path.dirname(path.resolve(fixture.root)) !== path.resolve(tmpdir()) || !path.basename(fixture.root).startsWith('wlb-chat-media-')) throw Error('Invalid media fixture path');
    await rm(fixture.root, { recursive: true, force: true });
  }
});
async function fixture(brain = new Brain()) {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-chat-media-')), owner = { root, services: [] as BotService[] }; fixtures.push(owner);
  const memory = new Memory(path.join(root, 'memory')), media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
  const open = (next: Brain) => { const service = new BotService({ root, brain: next, memory, media, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }), onEvent: () => undefined }); owner.services.push(service); return service; };
  const service = open(brain), initial = (await service.handle({ type: 'state' })).snapshot!;
  const conversationId = initial.conversations.find(conversation => conversation.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!.id;
  return { root, service, memory, media, conversationId, reopen: open };
}
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000) { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw Error('Media condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function callback(input: BotDshRun, name: string, callId: string, args: Record<string, unknown>) {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, name, callId, args }) });
  const body = await response.text();
  return { status: response.status, ...(body ? JSON.parse(body) : { ok: false }) as { ok: boolean; result?: Record<string, unknown>; error?: string } };
}
async function userFile(f: Awaited<ReturnType<typeof fixture>>, name = '原始资料.any', bytes = Buffer.from('实际原始字节')) {
  const source = path.join(f.root, name); await writeFile(source, bytes); return (await f.media.importFiles({ conversationId: f.conversationId, paths: [source] }))[0]!;
}

it('gives the actual brain original sticker filenames, semantic descriptions and tags and searches by the source filename', async () => {
  let result: unknown;
  const brain = new Brain(async input => { result = (await callback(input, 'chat_list_stickers', 'find-source-name', { query: selected.originalName })).result; return '选好了'; });
  const f = await fixture(brain), pack = (await f.media.listPacks({ conversationId: f.conversationId }))[0]!;
  const selected = (await f.media.listStickers({ conversationId: f.conversationId, packId: pack.id }))[0]!;
  expect(selected.originalName).toBeTruthy(); expect(selected.tags?.length).toBeGreaterThan(0);
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '你好', requestId: 'source-name-search' });
  await waitFor(() => result !== undefined);
  expect(result).toMatchObject({ stickers: expect.arrayContaining([expect.objectContaining({ id: selected.id, originalName: selected.originalName, name: selected.name, description: selected.description, tags: selected.tags })]) });
});

it('drains a gated attachment preparation on shutdown and aborts before another media directory operation or model call', async () => {
  const brain = new Brain(), f = await fixture(brain), ref = await userFile(f, 'prepare-before-close.txt');
  const original = f.media.verifiedLocalFile.bind(f.media); let entered = false, checked = false, incoming: AbortSignal | undefined, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.media.verifiedLocalFile = async (conversationId, id, signal) => { entered = true; incoming = signal; await gate; checked = true; return original(conversationId, id, signal); };
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '核验这个附件', attachmentIds: [ref.id], requestId: 'shutdown-preparing-file' });
  await waitFor(() => entered);
  let closed = false; const closing = f.service.shutdown().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(incoming?.aborted).toBe(true); expect(closed).toBe(false); expect(checked).toBe(false);
  } finally { release(); await closing; }
  expect(checked).toBe(true); expect(brain.calls).toEqual([]);
  // A pre-aborted inventory cannot recreate a directory after its owner has
  // removed the media workspace, even when it was delayed before I/O began.
  await rm(path.join(f.root, 'media'), { recursive: true, force: true });
  await expect(original(f.conversationId, ref.id, incoming)).rejects.toBe(incoming!.reason);
  await expect(stat(path.join(f.root, 'media'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fences a model that returns after the bounded scheduler drain without accessing closed SQLite', async () => {
  let entered = false, returned = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(new Brain(async () => { entered = true; await gate; returned = true; return '关闭后的迟到回复'; }));
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '你好', requestId: 'late-provider-after-close' });
  await waitFor(() => entered);
  // Exercise the scheduler's explicit deadline without making this fixture
  // sleep for the production five-second grace period.
  await (f.service as unknown as { scheduler: BotScheduler }).scheduler.close(20); await f.service.shutdown();
  const timing = vi.spyOn(f.service.store, 'recordTurnTiming'), state = vi.spyOn(f.service.store, 'getEvent');
  try {
    release(); await waitFor(() => returned); await new Promise<void>(resolve => setImmediate(resolve));
    expect(timing).not.toHaveBeenCalled(); expect(state).not.toHaveBeenCalled();
  } finally { timing.mockRestore(); state.mockRestore(); release(); }
});

it('persists original text and canonical file bytes while denying other-chat, unsent-draft and withdrawn source access to the brain', async () => {
  const lists: unknown[] = [];
  const brain = new Brain(async input => { lists.push((await callback(input, 'chat_list_files', 'list-files', {})).result); return '已收到'; });
  const f = await fixture(brain), ref = await userFile(f), draft = await userFile(f, '尚未发送的草稿.pdf', Buffer.from('draft'));
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '你好', requestId: 'before-file' }); await waitFor(() => lists.length === 1);
  expect(lists[0]).toMatchObject({ files: [] });
  const request = { type: 'message.send' as const, conversationId: f.conversationId, content: '请查看原件，不要替换我的话', attachmentIds: [ref.id], requestId: 'send-real-file' };
  const first = await f.service.handle(request), duplicate = await f.service.handle(request); expect(duplicate.messageId).toBe(first.messageId);
  await waitFor(() => lists.length === 2);
  const record = f.service.store.getMessage(first.messageId!)!;
  expect(record).toMatchObject({ content: request.content, attachments: [ref] });
  expect(lists[1]).toMatchObject({ files: [expect.objectContaining({ id: ref.id })] }); expect(JSON.stringify(lists[1])).not.toContain(draft.id);
  const turn = brain.calls.find(input => JSON.parse(input.prompt).files?.some((file: { id: string }) => file.id === ref.id))!;
  expect(JSON.parse(turn.prompt).message.content).toContain(request.content); expect(JSON.stringify(JSON.parse(turn.prompt).files)).toContain(ref.sha256);
  expect(await readFile((await f.media.getForAgent(f.conversationId, ref.id)).path)).toEqual(Buffer.from('实际原始字节'));
  const other = await f.service.handle({ type: 'companion.create', name: '别的伙伴', persona: '单独域' });
  await expect(f.service.handle({ ...request, conversationId: other.conversationId!, requestId: 'wrong-chat' })).rejects.toThrow('不属于当前会话');
  await expect(f.service.handle({ ...request, requestId: 'send-real-file', attachmentIds: [draft.id] })).rejects.toThrow('不同内容');
  await waitFor(() => f.service.store.getEvent(turn.eventId)?.status === 'done');
  const conversation = f.service.store.getConversation(f.conversationId)!;
  f.service.store.withdrawSources(DEFAULT_BOT_COMPANION_ID, conversation.securityDomainId, [turn.eventId]);
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '你好', requestId: 'after-withdrawal' }); await waitFor(() => lists.length === 3);
  expect(lists[2]).toMatchObject({ files: [] });
  expect(botRequestSchema.safeParse({ type: 'message.send', conversationId: f.conversationId, content: '', attachmentIds: [ref.id], requestId: 'only-file' }).success).toBe(true);
  expect(botRequestSchema.safeParse({ type: 'message.send', conversationId: f.conversationId, content: '', attachmentIds: [], requestId: 'empty' }).success).toBe(false);
});

it('publishes a pure sticker once across unknown native delivery/restart, archives real metadata and consumes the empty placeholder without self-chat', async () => {
  const selected: { sticker?: BotMediaRef } = {}, receipts: unknown[] = [];
  const handler = async (input: BotDshRun) => { receipts.push((await callback(input, 'chat_send_sticker', 'one-sticker', { stickerId: selected.sticker!.id })).result); return ''; };
  const firstBrain = new Brain(async input => { await handler(input); throw new BotDshDeliveryUnknownError('receipt persisted; final native stream lost'); });
  const f = await fixture(firstBrain), pack = (await f.media.listPacks({ conversationId: f.conversationId }))[0]!, sticker = (await f.media.listStickers({ conversationId: f.conversationId, packId: pack.id }))[0]!; selected.sticker = sticker;
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '你好', requestId: 'sticker-turn' });
  await waitFor(() => receipts.length === 1 && f.service.store.getEvent(firstBrain.calls[0]!.eventId)?.status === 'queued');
  const eventId = firstBrain.calls[0]!.eventId; await f.service.shutdown();
  const next = new Brain(handler), resumed = f.reopen(next); await resumed.handle({ type: 'state' });
  await waitFor(() => resumed.store.getEvent(eventId)?.status === 'done');
  expect(receipts).toHaveLength(2); expect(receipts[1]).toEqual(receipts[0]); expect(resumed.store.publicationsForEvent(eventId)).toHaveLength(1);
  const publication = resumed.store.publicationsForEvent(eventId)[0]!;
  expect(publication).toMatchObject({ content: '', status: 'sent', senderId: DEFAULT_BOT_COMPANION_ID, attachments: [sticker] });
  const bytes = Buffer.from(await (await f.media.response(new Request(sticker.url))).arrayBuffer()); expect(hash(bytes)).toBe(sticker.sha256);
  const replyId=resumed.store.getEvent(eventId)!.replyMessageId;
  expect(resumed.store.searchMessages(f.conversationId, { query: '' }).items.some(message => message.id === replyId)).toBe(true);
  expect(resumed.store.searchMessages(f.conversationId,{query:''}).items.some(message=>message.id===publication.id)).toBe(false);
  expect(resumed.store.historyProjectionPage(f.conversationId, { after: 0, through: resumed.store.historyProjectionHead(f.conversationId) }).map(row => row.message.id)).toContain(replyId);
  expect(resumed.store.historyProjectionPage(f.conversationId,{after:0,through:resumed.store.historyProjectionHead(f.conversationId)}).filter(row=>!row.suppressed).map(row=>row.message.id)).not.toContain(publication.id);
  expect(next.calls.filter(input => !input.laneId.startsWith('memory-encoder-'))).toHaveLength(1);
  const noFeedback = resumed.store.taskTransaction(sql => sql.prepare('SELECT COUNT(*) AS count FROM bot_inbox WHERE source_record_id=?').get(publication.id)) as { count: number };
  expect(noFeedback.count).toBe(0);
  const event = resumed.store.getEvent(eventId)!;
  expect(resumed.store.modelAttachments(event, { ids: [sticker.id] })).toHaveLength(1);
  resumed.store.withdrawSources(event.companionId, event.securityDomainId, [eventId]);
  expect(resumed.store.modelAttachments(event, { ids: [sticker.id] })).toEqual([]);
  expect(resumed.store.withdrawnIn(event.companionId, event.securityDomainId, [publication.id])).toEqual(new Set([publication.id]));
});

it('delivers explicit peer media to the actual other brain in the same group without self-reflection, private-file or draft-file leakage', async () => {
  let peerId = '', stickerId = '', draftId = '', privateId = '', peerEvent = '';
  const failures: number[] = [];
  const brain = new Brain(async input => {
    const body = JSON.parse(input.prompt);
    if (body.identity.id === DEFAULT_BOT_COMPANION_ID && body.message.senderId === 'user') {
      for (const forbidden of [draftId, privateId]) failures.push((await callback(input, 'message_peer', `deny-${forbidden}`, { companionId: peerId, attachmentIds: [forbidden] })).status);
      const sent = await callback(input, 'message_peer', 'send-real-peer-sticker', { companionId: peerId, attachmentIds: [stickerId] });
      expect(sent).toMatchObject({ status: 200, result: { sent: true } }); peerEvent = String((sent.result!.eventIds as string[])[0]); return '';
    }
    if (body.identity.id === peerId) { expect(body.message).toMatchObject({ senderId: DEFAULT_BOT_COMPANION_ID }); expect(body.message.content).toContain(stickerId); return '收到你的真实表情啦'; }
    return '已收到';
  });
  const f = await fixture(brain), peer = await f.service.handle({ type: 'companion.create', name: 'Bob', persona: '独立伙伴' });
  peerId = f.service.store.getConversation(peer.conversationId!)!.memberIds.find(id => id !== 'user')!;
  const group = await f.service.handle({ type: 'conversation.create', title: '斗图群', kind: 'group', memberIds: [DEFAULT_BOT_COMPANION_ID, peerId], participationMode: 'mentions' });
  const groupId = group.conversationId!, pack = (await f.media.listPacks({ conversationId: groupId }))[0]!;
  stickerId = (await f.media.listStickers({ conversationId: groupId, packId: pack.id }))[0]!.id;
  const draft = path.join(f.root, 'not-sent-to-group.bin'); await writeFile(draft, 'user draft, not shared');
  draftId = (await f.media.importFiles({ conversationId: groupId, paths: [draft] }))[0]!.id;
  privateId = (await userFile(f, 'private-conversation.bin', Buffer.from('private only'))).id;
  await f.service.handle({ type: 'message.send', conversationId: groupId, content: '@大肥鱼 给Bob发一张表情', requestId: 'explicit-peer-sticker' });
  await waitFor(() => !!peerEvent && f.service.store.getEvent(peerEvent)?.status === 'done');
  expect(failures).toEqual([400, 400]);
  const actual = f.service.store.getEvent(peerEvent)!, sender = brain.calls.find(input => input.eventId === actual.causationId)!;
  expect(actual).toMatchObject({ source: 'companion', companionId: peerId, senderId: DEFAULT_BOT_COMPANION_ID, payload: { hop: 1 } });
  expect(actual.correlationId).toBe(f.service.store.getEvent(sender.eventId)!.correlationId);
  const reflected = f.service.store.taskTransaction(sql => sql.prepare('SELECT companion_id FROM bot_inbox WHERE source_record_id=?').all(actual.sourceMessageRecordId)) as Array<{ companion_id: string }>;
  expect(reflected).toEqual([{ companion_id: peerId }]);
  expect(f.service.store.getMessage(actual.sourceMessageRecordId)).toMatchObject({ content: '', attachments: [{ id: stickerId }] });
});
