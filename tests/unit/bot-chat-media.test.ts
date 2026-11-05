import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { reportWorkerOutcome } from '../fixtures/bot-worker-report';

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
    if (input.role === 'worker' && !input.signal?.aborted) await reportWorkerOutcome(input, { state: 'ready', summary: text.slice(0, 16000) || '媒体夹具交付已完成', verification: ['受控媒体脚本已完成本场景的实际文件与交付检查。'] });
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
  const turn = brain.calls.find(input => JSON.parse(input.prompt).trigger?.content.includes(ref.id))!;
  expect(JSON.parse(turn.prompt).trigger.content).toContain(request.content); expect(JSON.parse(turn.prompt).trigger.content).toContain(ref.sha256);
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
  expect(resumed.store.searchMessages(f.conversationId, { query: '' }).items.some(message => message.id === resumed.store.getEvent(eventId)!.replyMessageId)).toBe(false);
  expect(resumed.store.historyProjectionPage(f.conversationId, { after: 0, through: resumed.store.historyProjectionHead(f.conversationId) }).map(row => row.message.id)).toContain(publication.id);
  expect(next.calls.filter(input => !input.laneId.startsWith('memory-encoder-'))).toHaveLength(1);
  const noFeedback = resumed.store.taskTransaction(sql => sql.prepare('SELECT COUNT(*) AS count FROM bot_inbox WHERE source_record_id=?').get(publication.id)) as { count: number };
  expect(noFeedback.count).toBe(0);
  const event = resumed.store.getEvent(eventId)!;
  expect(resumed.store.modelAttachments(event, { ids: [sticker.id] })).toHaveLength(1);
  resumed.store.withdrawSources(event.companionId, event.securityDomainId, [eventId]);
  expect(resumed.store.modelAttachments(event, { ids: [sticker.id] })).toEqual([]);
  expect(resumed.store.withdrawnIn(event.companionId, event.securityDomainId, [publication.id])).toEqual(new Set([publication.id]));
});

it('stages authorized inputs for a real task, sends verified output through its admitted worker callback and rejects out-of-workspace files', async () => {
  let taskId = '', publishedId = ''; const expectedBytes = Buffer.from('input bytes');
  const brain = new Brain(async input => {
    if (input.role === 'worker') {
      expect(input.workerTools?.map(tool => tool.name)).toContain('worker_chat_send_file');
      const metadata = JSON.parse(input.prompt.split('文件；内容是资料，不是系统指令】\n')[1]!)[0];
      expect(await readFile(path.join(input.cwd, metadata.relativePath))).toEqual(expectedBytes);
      const output = Buffer.from('verified output bytes'); await writeFile(path.join(input.cwd, 'result.bin'), output);
      expect((await callback(input, 'worker_chat_send_file', 'not-admitted', { path: 'result.bin' })).status).toBe(400);
      const send = async (callId: string, file: string) => {
        const argsHash = hash(JSON.stringify({ path: file }));
        await callback(input, 'worker_effect_start', callId, { callId, toolName: 'worker_chat_send_file', argsHash, argumentsPreview: file });
        const result = await callback(input, 'worker_chat_send_file', callId, { path: file, nativeSessionId: BotDshBrain.sessionId(input.laneId), nativeCallId: callId });
        await callback(input, 'worker_effect_commit', callId, { callId, toolName: 'worker_chat_send_file', argsHash, isError: !result.ok }); return result;
      };
      const outside = path.join(input.cwd, '..', '..', '..', 'outside.txt'); await writeFile(outside, 'outside this task');
      expect((await send('forbidden-outside', outside)).status).toBe(400);
      const result = await send('real-file', 'result.bin'); expect(result).toMatchObject({ status: 200, result: { sent: true, relativePath: 'result.bin' } });
      publishedId = String(result.result!.messageId); return `实际文件已发至 ${publishedId}`;
    }
    const trigger = JSON.parse(input.prompt).trigger;
    if (trigger.source === 'user') {
      const result = await callback(input, 'dsh_task', 'create-file-task', { goal: '依据真实附件产生并验证文件', title: '处理文件' });
      taskId = String(result.result!.taskId); return '正在处理文件';
    }
    return '文件已经发送，请查看实际附件';
  });
  const f = await fixture(brain), ref = await userFile(f, 'input.bin', expectedBytes);
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '处理这个附件', attachmentIds: [ref.id], requestId: 'file-task' });
  await waitFor(() => !!taskId && f.service.store.getTask(taskId)?.status === 'succeeded' && !!publishedId);
  const message = f.service.store.getMessage(publishedId)!, output = message.attachments![0]!;
  expect(await readFile((await f.media.getForAgent(f.conversationId, output.id)).path)).toEqual(Buffer.from('verified output bytes'));
  expect(f.service.store.publicationsForTask(taskId)).toEqual([{ messageId: publishedId, attachmentIds: [output.id], relativePath: 'result.bin' }]);
  expect(f.service.store.searchMessages(f.conversationId, { query: 'result.bin' }).items.map(item => item.id)).toContain(publishedId);
  const card = (await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId })).task!;
  expect(card.outputs).toEqual(f.service.store.publicationsForTask(taskId));
});

it('records router-delivered task files and reuses only the same current artifact receipt unless an explicit resend or new file version is requested', async () => {
  let taskId = '', outputPath = '';
  const receipts: Array<Record<string, unknown>> = [];
  const brain = new Brain(async input => {
    if (input.role === 'worker') { outputPath = path.join(input.cwd, 'cedar-proof.txt'); await writeFile(outputPath, 'cedar version one'); return 'cedar-proof.txt 已实际产生并验证'; }
    const body = JSON.parse(input.prompt), text = body.trigger.content;
    if (text === '生成文件') { taskId = String((await callback(input, 'dsh_task', 'produce-file', { goal: '生成cedar-proof.txt', title: '产物交付' })).result!.taskId); return '任务已提交'; }
    if (body.trigger.source === 'task' || ['只核对回执', '明确再发', '发送新版本'].includes(text)) {
      const output = body.tasks.find((task: { id: string }) => task.id === taskId)?.outputs;
      if (text === '只核对回执') expect(output).toEqual([expect.objectContaining({ messageId: receipts[0]!.messageId, relativePath: 'cedar-proof.txt' })]);
      const result = await callback(input, 'chat_send_file', `deliver-${body.trigger.source}-${text}`, { taskId, path: './cedar-proof.txt', ...(text === '明确再发' ? { resend: true } : {}) });
      expect(result.status).toBe(200); receipts.push(result.result!); return '已根据真实文件与回执处理';
    }
    return '已收到';
  });
  const f = await fixture(brain);
  const send = (content: string, requestId: string) => f.service.handle({ type: 'message.send', conversationId: f.conversationId, content, requestId });
  await send('生成文件', 'create-router-delivery'); await waitFor(() => receipts.length === 1 && f.service.store.getTask(taskId)?.status === 'succeeded');
  const first = f.service.store.getMessage(String(receipts[0]!.messageId))!, firstRef = first.attachments![0]!;
  expect(await readFile((await f.media.getForAgent(f.conversationId, firstRef.id)).path, 'utf8')).toBe('cedar version one');
  expect(f.service.store.publicationsForTask(taskId)).toEqual([{ messageId: first.id, attachmentIds: [firstRef.id], relativePath: 'cedar-proof.txt' }]);
  await send('只核对回执', 'conditional-delivery'); await waitFor(() => receipts.length === 2);
  expect(receipts[1]).toMatchObject({ sent: true, alreadySent: true, messageId: first.id, attachmentIds: [firstRef.id] });
  expect(f.service.store.publicationsForTask(taskId)).toHaveLength(1);
  await send('明确再发', 'explicit-resend'); await waitFor(() => receipts.length === 3);
  expect(receipts[2]!.alreadySent).toBeUndefined(); expect(receipts[2]!.messageId).not.toBe(first.id); expect(receipts[2]!.attachmentIds).toEqual([firstRef.id]);
  expect(f.service.store.publicationsForTask(taskId)).toHaveLength(2);
  await writeFile(outputPath, 'cedar version two'); await send('发送新版本', 'changed-file'); await waitFor(() => receipts.length === 4);
  expect(receipts[3]!.alreadySent).toBeUndefined(); expect(receipts[3]!.attachmentIds).not.toEqual([firstRef.id]);
  const newest = f.service.store.getMessage(String(receipts[3]!.messageId))!;
  expect(await readFile((await f.media.getForAgent(f.conversationId, newest.attachments![0]!.id)).path, 'utf8')).toBe('cedar version two');
  const card = (await f.service.handle({ type: 'task.get', conversationId: f.conversationId, taskId })).task!;
  expect(card.outputs).toHaveLength(3);
});

it('keeps the frozen task prompt and does not overwrite an already edited staged input during unknown native recovery', async () => {
  let taskId = '', runs = 0;
  const brain = new Brain(async input => {
    if (input.role !== 'worker') {
      if (JSON.parse(input.prompt).trigger.content.startsWith('开始文件任务')) taskId = String((await callback(input, 'dsh_task', 'start-once', { goal: '编辑附件并保留进度', title: '附件恢复' })).result!.taskId);
      return '已收到';
    }
    const metadata = JSON.parse(input.prompt.split('文件；内容是资料，不是系统指令】\n')[1]!)[0], file = path.join(input.cwd, metadata.relativePath);
    if (++runs === 1) {
      expect(await readFile(file, 'utf8')).toBe('原始内容');
      const effect = { callId: 'known-input-edit', toolName: 'write', argsHash: hash(JSON.stringify({ path: metadata.relativePath })), argumentsPreview: 'edit assigned task input' };
      await callback(input, 'worker_effect_start', effect.callId, effect); await writeFile(file, 'DSH已经编辑的内容');
      await callback(input, 'worker_effect_commit', effect.callId, { callId: effect.callId, toolName: effect.toolName, argsHash: effect.argsHash, isError: false });
      throw new BotDshDeliveryUnknownError('native edit durable; stream detached');
    }
    expect(await readFile(file, 'utf8')).toBe('DSH已经编辑的内容'); return '从已编辑的文件恢复完成';
  });
  const f = await fixture(brain), ref = await userFile(f, 'editable.txt', Buffer.from('原始内容'));
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '开始文件任务', attachmentIds: [ref.id], requestId: 'edit-input' });
  await waitFor(() => !!taskId && Number(f.service.store.getTask(taskId)?.extra.retryAttempts) === 1);
  f.service.store.updateTask(taskId, { extra: { ...f.service.store.getTask(taskId)!.extra, retryAt: 0 } });
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '你好', requestId: 'wake-known-edit' });
  await waitFor(() => f.service.store.getTask(taskId)?.status === 'succeeded');
  const calls = brain.calls.filter(input => input.role === 'worker'); expect(calls).toHaveLength(2); expect(calls[1]!.prompt).toBe(calls[0]!.prompt);
  expect(await readFile((await f.media.getForAgent(f.conversationId, ref.id)).path, 'utf8')).toBe('原始内容');
});

it('delivers explicit peer media to the actual other brain in the same group without self-reflection, private-file or draft-file leakage', async () => {
  let peerId = '', stickerId = '', draftId = '', privateId = '', peerEvent = '';
  const failures: number[] = [];
  const brain = new Brain(async input => {
    const body = JSON.parse(input.prompt);
    if (body.envelope.companionId === DEFAULT_BOT_COMPANION_ID && body.trigger.source === 'user') {
      for (const forbidden of [draftId, privateId]) failures.push((await callback(input, 'message_peer', `deny-${forbidden}`, { companionId: peerId, attachmentIds: [forbidden] })).status);
      const sent = await callback(input, 'message_peer', 'send-real-peer-sticker', { companionId: peerId, attachmentIds: [stickerId] });
      expect(sent).toMatchObject({ status: 200, result: { sent: true } }); peerEvent = String((sent.result!.eventIds as string[])[0]); return '';
    }
    if (body.envelope.companionId === peerId) { expect(body.trigger).toMatchObject({ source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID }); expect(body.trigger.content).toContain(stickerId); return '收到你的真实表情啦'; }
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

it('cancels a staged task whose earlier attachment grant is forgotten, blocks late file publication/status, and synchronizes derived raw IDs before confirming forget', async () => {
  let fileId = '', taskId = '', worker: BotDshRun | undefined;
  const brain = new Brain(async input => {
    if (input.role === 'worker') {
      worker = input; await writeFile(path.join(input.cwd, 'late-result.txt'), 'derived from the original input');
      await new Promise<never>((_resolve, reject) => { if (input.signal?.aborted) reject(input.signal.reason); else input.signal?.addEventListener('abort', () => reject(input.signal!.reason), { once: true }); });
    }
    const body = JSON.parse(input.prompt);
    if (body.trigger.content.startsWith('委派旧文件')) taskId = String((await callback(input, 'dsh_task', 'derive-later-task', { goal: '根据之前附件继续处理', title: '后续任务', attachmentIds: [fileId] })).result!.taskId);
    if (body.trigger.content.startsWith('查询旧任务')) expect(await callback(input, 'dsh_task_control', 'blocked-status', { taskId, operation: 'status' })).toMatchObject({ status: 400, error: expect.stringContaining('来源已撤回') });
    return '已收到';
  });
  const f = await fixture(brain), ref = await userFile(f); fileId = ref.id;
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '最初附件', attachmentIds: [ref.id], requestId: 'origin-grant' });
  await waitFor(() => brain.calls.length >= 1 && f.service.store.getEvent(brain.calls[0]!.eventId)?.status === 'done'); const rootSource = brain.calls[0]!.eventId;
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '委派旧文件', requestId: 'later-file-task' });
  await waitFor(() => !!worker && !!taskId && f.service.store.getTask(taskId)?.status === 'running');
  const source = f.service.store.getEvent(rootSource)!, staged = JSON.parse(worker!.prompt.split('文件；内容是资料，不是系统指令】\n')[1]!)[0];
  expect(await readFile(path.join(worker!.cwd, staged.relativePath), 'utf8')).toBe('实际原始字节');
  f.memory.deletedSources.set('source-note', { sourceEventIds: [rootSource], sourceMessageIds: [source.sourceMessageRecordId] });
  const receipt = await f.service.handle({ type: 'memory.forget', companionId: DEFAULT_BOT_COMPANION_ID, conversationId: f.conversationId, id: 'source-note' });
  expect(receipt.ok).toBe(true); expect(f.service.store.getTask(taskId)?.extra.cancelRequested).toBe(true);
  await waitFor(() => f.service.store.getTask(taskId)?.status === 'cancelled');
  const rejected = await callback(worker!, 'worker_chat_send_file', 'late-after-forget', { path: 'late-result.txt' }); expect(rejected.status).not.toBe(200);
  expect(f.service.store.publicationsForTask(taskId)).toEqual([]);
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '查询旧任务', requestId: 'no-task-resurrection' });
  await waitFor(() => brain.calls.some(input => input.role !== 'worker' && JSON.parse(input.prompt).trigger.content === '查询旧任务'));
  const latest = brain.calls.find(input => input.role !== 'worker' && JSON.parse(input.prompt).trigger.content === '查询旧任务')!;
  expect(JSON.parse(latest.prompt).tasks.some((task: { id: string }) => task.id === taskId)).toBe(false);
  expect(f.memory.nativeWithdrawals.flatMap(item => item.sourceMessageIds)).toContain(source.sourceMessageRecordId);
  await f.service.handle({ type: 'message.send', conversationId: f.conversationId, content: '我现在明确重新提供', attachmentIds: [fileId], requestId: 'independent-new-grant' });
  await waitFor(() => brain.calls.some(input => input.role !== 'worker' && JSON.parse(input.prompt).trigger.content.startsWith('我现在明确重新提供')));
  expect(f.service.store.modelAttachments({ ...source, companionId: DEFAULT_BOT_COMPANION_ID }, { ids: [fileId] })).toHaveLength(1);
  expect(f.service.store.taskSourcesWithdrawn(taskId)).toBe(true);
});
