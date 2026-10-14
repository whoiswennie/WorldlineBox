import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import type { CompanionMemory } from '../../src/shared/companions';
import type { DshLauncher } from '../../src/main/dsh/launcher';

const transport = vi.hoisted(() => ({ request: vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(),
  start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), fetch: vi.fn<typeof fetch>(), memoryFetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = transport.start; request = transport.request; close = transport.close;
} }));
vi.mock('electron', () => ({
  net: { fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => /memory_(?:extraction|query|maintenance)/u.test(String(init?.body))
    ? transport.memoryFetch(input, init) : transport.fetch(input, init)) },
  dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() }, protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
}));

const seeds: CompanionSeed[] = [{ id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳', model: '', avatar: 'sister', proactive: false }];
const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionService>();
const fixedTime = '2026-10-14T02:00:00Z';
type Payload = { purpose?: string; companion?: { id: string }; taskRequest?: { sourceMessageId: string; prompt: string };
  currentMessage?: { id: string; content: string }; messages: Array<{ id: string; content: string; authorId: string }>;
  relevantMemories?: CompanionMemory[]; memories?: CompanionMemory[] };
function body(init?: RequestInit): { messages: Array<{ role: string; content: string; tool_call_id?: string }> } {
  return JSON.parse(String(init?.body));
}
function payload(init?: RequestInit): Payload { return JSON.parse(body(init).messages[1]!.content); }
function textResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { 'Content-Type': 'application/json' } });
}
function structuredResponse(value: unknown): Response { return textResponse(JSON.stringify(value)); }
function toolResponse(id: string, name: string, args: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
}
function preference(source: { id: string; content: string }, value = '茶'): CompanionMemoryCandidate {
  return { kind: 'preference', subject: 'user', factKey: 'drink.preference', value, content: `用户喜欢${value}。`,
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [{ name: '饮料偏好', aliases: ['饮品习惯'] }] };
}
function bindStorage(store: CompanionsStore) {
  transport.request.mockImplementation(async command => store.request(command));
  transport.close.mockImplementation(async () => { store.close(); stores.delete(store); });
}
function startService(root: string): CompanionService {
  const dsh = { state: () => ({ tasks: [], operations: [] }), requestTask: vi.fn(async () => ({ ok: true })) } as unknown as DshLauncher;
  const service = new CompanionService({ userData: root, workerPath: 'mocked-worker', window: () => undefined,
    getConfig: () => ({ apiFormat: 'openai_chat', model: 'memory-test-chat-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' }),
    hasConfig: () => true, dsh: () => dsh, report: vi.fn() });
  services.add(service); return service;
}
function fixture(customSeeds = seeds) {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-service-')); roots.push(root);
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  const store = new CompanionsStore(databasePath, customSeeds); stores.add(store);
  const conversation = store.openPrivate('sister'); bindStorage(store);
  return { root, databasePath, store, conversation, service: startService(root) };
}
async function closeService(service: CompanionService) {
  const done = service.shutdown(); await vi.advanceTimersByTimeAsync(1_000); await done; services.delete(service);
}
async function sent(service: CompanionService, store: CompanionsStore, conversationId: string, content: string, clientId: string) {
  const result = await service.handle({ type: 'message.send', conversationId, content, clientId, delivery: 'chat' });
  const message = result.message!;
  await vi.waitFor(() => expect(store.request({ type: 'work.list', sourceMessageId: message.id }).works?.every(work => work.status === 'done')).toBe(true), { timeout: 500 });
  return message;
}
function active(store: CompanionsStore, conversationId: string, companionId = 'sister') {
  return store.request({ type: 'memory.browse', companionId, conversationId, limit: 100 }).memoryPage!.items.map(hit => hit.memory);
}
function status(store: CompanionsStore, companionId = 'sister') { return store.request({ type: 'memory.status', companionId }).memoryStatus!; }
async function background(milliseconds = 2_100) { await vi.advanceTimersByTimeAsync(milliseconds); }

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(fixedTime));
  transport.fetch.mockReset(); transport.memoryFetch.mockReset();
  transport.fetch.mockImplementation(async () => textResponse('好，慢慢聊。'));
  transport.memoryFetch.mockImplementation(async (_input, init) => structuredResponse(payload(init).purpose === 'memory_query' ? {} : { candidates: [] }));
});
afterEach(async () => {
  for (const service of services) await closeService(service);
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-memory-service-')) throw new Error('Unexpected memory test cleanup target.');
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe('automatic companion memory through the main service and real SQLite', () => {
  it('records a normal chat without a reminder or primary-model memory call and keeps actual user/reply sources', async () => {
    const f = fixture();
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const data = payload(init);
      if (data.purpose !== 'memory_extraction') return structuredResponse(data.purpose === 'memory_query' ? {} : { candidates: [] });
      const source = data.messages.find(message => message.authorId === 'user' && message.content === '我一直喜欢茶。');
      return structuredResponse({ candidates: source ? [preference(source)] : [] });
    });
    const source = await sent(f.service, f.store, f.conversation.id, '我一直喜欢茶。', 'normal-preference');
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    await background();
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(active(f.store, f.conversation.id)[0]).toMatchObject({ kind: 'preference', factKey: 'drink.preference', value: '茶', sourceMessageId: source.id });
    const read = f.store.request({ type: 'memory.read', companionId: 'sister', conversationId: f.conversation.id, id: active(f.store, f.conversation.id)[0]!.id }).memoryRead!;
    expect(read.sources.some(message => message.id === source.id && message.content === '我一直喜欢茶。')).toBe(true);
    expect(read.sources.some(message => message.authorId === 'sister' && message.content === '好，慢慢聊。')).toBe(true);
    expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.turns.every(turn => turn.calls.length === 0)).toBe(true);
    await background(31_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(status(f.store).extractionWatermark).toBe(status(f.store).messageWatermark);
  });

  it('retains a failed extraction and retries network and invalid-evidence output before advancing the watermark', async () => {
    const f = fixture(); let attempts = 0;
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const data = payload(init);
      if (data.purpose !== 'memory_extraction') return structuredResponse({});
      attempts++;
      if (attempts === 1) throw new Error('private provider network data: private-test-key');
      const source = data.messages.find(message => message.authorId === 'user' && message.content === '我一直喜欢茶。')!;
      return structuredResponse({ candidates: source ? [{ ...preference(source), ...(attempts === 2 ? { evidence: [{ sourceMessageId: source.id, quote: '这句原文并不存在' }] } : {}) }] : [] });
    });
    const source = await sent(f.service, f.store, f.conversation.id, '我一直喜欢茶。', 'retry-preference');
    await background();
    expect(status(f.store).failed).toBeGreaterThan(0);
    expect(status(f.store).extractionWatermark).toBeLessThan(source.sequence);
    expect(status(f.store).lastError).not.toContain('private-test-key');
    await background(31_000);
    expect(status(f.store).failed).toBeGreaterThan(0);
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(status(f.store).extractionWatermark).toBeLessThan(source.sequence);
    await background(31_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(status(f.store).failed).toBe(0);
    expect(status(f.store).extractionWatermark).toBe(status(f.store).messageWatermark);
  });

  it('recalls a once-stated birthday after 220 unrelated messages when the user changes the wording', async () => {
    const f = fixture();
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const data = payload(init);
      if (data.purpose === 'memory_query') return structuredResponse({ query: '用户生日', terms: ['生日', '出生日期'], subject: 'user', factKey: 'birthday' });
      const source = data.messages.find(message => message.content === '我的生日是4月9日。');
      return structuredResponse({ candidates: source ? [{ kind: 'fact', subject: 'user', factKey: 'birthday', value: '04-09', content: '用户生日是4月9日。',
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [{ name: '生日', aliases: ['出生日期'] }] }] : [] });
    });
    const birthday = await sent(f.service, f.store, f.conversation.id, '我的生日是4月9日。', 'old-birthday');
    await background();
    for (let i = 0; i < 220; i++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: `无关的天气闲聊第${i}次`, replyDirective: 'none' });
    let brainPayload: Payload | undefined;
    transport.fetch.mockImplementation(async (_input, init) => {
      brainPayload = payload(init);
      return textResponse(brainPayload.memories?.some(memory => memory.factKey === 'birthday' && memory.value === '04-09') ? '是4月9日。' : '不知道。');
    });
    await sent(f.service, f.store, f.conversation.id, '你知道我出生的那天是哪一日吗？', 'new-birthday-question');
    expect(brainPayload?.messages.some(message => message.id === birthday.id)).toBe(false);
    expect(brainPayload?.memories?.some(memory => memory.sourceMessageId === birthday.id && memory.value === '04-09')).toBe(true);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.at(-1)?.content).toBe('是4月9日。');
  });

  it('executes native record/search/read/revise/forget against the database and returns native result IDs', async () => {
    const f = fixture(); let savedId = '', version = 1; const steps = new Map<string, number>(), results: Array<{ id: string; value: CompanionStorageResponse }> = [];
    transport.fetch.mockImplementation(async (_input, init) => {
      const data = payload(init), source = { id: data.taskRequest!.sourceMessageId, content: data.taskRequest!.prompt };
      const step = steps.get(source.id) ?? 0; steps.set(source.id, step + 1);
      const latest = body(init).messages.at(-1)!;
      if (latest.role === 'tool') {
        const result = JSON.parse(latest.content) as CompanionStorageResponse; results.push({ id: latest.tool_call_id!, value: result });
        const saved = result.memories?.[0] ?? result.memoryRead?.memory ?? result.memoryPage?.items[0]?.memory;
        if (saved) { savedId = saved.id; version = saved.version ?? 1; }
      }
      if (source.content === '我一直喜欢茶。') {
        if (step === 0) return toolResponse('record_1', 'memory_record', { candidate: preference(source) });
        if (step === 1) return toolResponse('search_1', 'memory_search', { subject: 'user', factKey: 'drink.preference', terms: ['茶'] });
        if (step === 2) return toolResponse('read_1', 'memory_read', { id: savedId });
        if (step === 3) return toolResponse('organize_1', 'memory_organize', { ids: [savedId], tags: [{ name: '饮料偏好', aliases: ['饮品习惯'] }] });
      } else if (source.content === '更正，现在喜欢水。' && step === 0) return toolResponse('revise_1', 'memory_revise', { id: savedId, expectedVersion: version, candidate: { ...preference(source, '水'), correction: true } });
      else if (source.content.includes('忘掉') && step === 0) return toolResponse('forget_1', 'memory_forget', { subject: 'user', factKey: 'drink.preference', persistent: true, requestMessageId: source.id });
      return textResponse('处理好了。');
    });
    await sent(f.service, f.store, f.conversation.id, '我一直喜欢茶。', 'native-record');
    expect(active(f.store, f.conversation.id)[0]).toMatchObject({ value: '茶', version: 2 });
    expect(results.map(result => result.id)).toEqual(['record_1', 'search_1', 'read_1', 'organize_1']);
    expect(results.find(result => result.id === 'read_1')?.value.memoryRead?.sources.some(source => source.content === '我一直喜欢茶。')).toBe(true);
    const originalId = savedId;
    await sent(f.service, f.store, f.conversation.id, '更正，现在喜欢水。', 'native-revise');
    expect(active(f.store, f.conversation.id)[0]).toMatchObject({ value: '水', supersedesId: originalId });
    expect(results.find(result => result.id === 'revise_1')?.value.ok).toBe(true);
    expect(f.store.request({ type: 'memory.inspect', companionId: 'sister', conversationId: f.conversation.id, id: originalId }).memoryRead?.memory.status).toBe('superseded');
    await sent(f.service, f.store, f.conversation.id, '请忘掉我饮料偏好，以后不要再记录。', 'native-forget');
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(status(f.store).forgotten).toBe(2);
    expect(f.store.request({ type: 'memory.sources.search', companionId: 'sister', conversationId: f.conversation.id, terms: ['喜欢', '茶', '水'] }).memorySources).toHaveLength(0);
    await background(31_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
  });

  it('refuses a model-proposed forget when the actual current user message contains no forgetting request', async () => {
    const f = fixture(), old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '我一直喜欢茶。', replyDirective: 'none' });
    f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id, candidate: preference(old) });
    let attempted = false, result: CompanionStorageResponse | undefined;
    transport.fetch.mockImplementation(async (_input, init) => {
      const sourceId = payload(init).taskRequest!.sourceMessageId;
      if (!attempted) { attempted = true; return toolResponse('unauthorized_forget', 'memory_forget', { subject: 'user', factKey: 'drink.preference', requestMessageId: sourceId }); }
      result = JSON.parse(body(init).messages.at(-1)!.content) as CompanionStorageResponse;
      return textResponse('今天慢慢聊。');
    });
    await sent(f.service, f.store, f.conversation.id, '今天慢慢聊聊吧。', 'ordinary-user-message');
    expect(result?.ok).toBe(false);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(status(f.store).forgotten).toBe(0);
  });

  it('automatically records an observed group agreement for a companion who did not speak', async () => {
    const f = fixture([...seeds, { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false }]);
    const group = f.store.createConversation('出行安排', ['sister', 'flash']);
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const data = payload(init), source = data.messages.find(message => message.content.includes('周六十点'));
      return structuredResponse({ candidates: source ? [{ kind: 'agreement', subject: 'group', factKey: 'trip.meeting', content: '本群约定周六十点在东门集合。',
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: '周六十点在东门集合' }], tags: [{ name: '旅行集合' }] }] : [] });
    });
    const source = await sent(f.service, f.store, group.id, '@大肥鱼，大家周六十点在东门集合。', 'group-agreement');
    expect(f.store.messages({ conversationId: group.id }).messages.some(message => message.authorId === 'flash')).toBe(false);
    await background();
    expect(active(f.store, group.id, 'flash')[0]).toMatchObject({ sourceMessageId: source.id, sourceConversationId: group.id, kind: 'agreement' });
    expect(f.store.request({ type: 'memory.search', companionId: 'flash', conversationId: group.id, terms: ['东门'] }).memoryPage?.items[0]?.memory.content).toContain('东门');
  });

  it('builds a phase overview and experience from actual task sources and invalidates them after correction', async () => {
    const f = fixture();
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const data = payload(init), source = data.messages.find(message => message.content.includes('聊天功能验收通过'));
      if (data.purpose === 'memory_extraction') return structuredResponse({ candidates: source ? [{ kind: 'task', subject: 'WorldlineBox', factKey: 'chat.acceptance',
        content: 'WorldlineBox 聊天功能验收通过。', value: 'completed', eventId: 'chat_work', eventStatus: 'completed',
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [{ name: 'WorldlineBox' }] }] : [] });
      if (data.purpose === 'memory_maintenance' && source) return structuredResponse({ candidates: [
        { kind: 'overview', subject: 'WorldlineBox', factKey: 'phase.2026-10', content: '2026年10月阶段：聊天功能验收通过。',
          sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], relatedMemoryIds: data.relevantMemories!.map(memory => memory.id) },
        { kind: 'knowledge', subject: 'WorldlineBox', factKey: 'lesson.acceptance', content: '本次先检查真实结果再确认完成，适用于功能验收；仅有这次通过证据，不能保证所有功能。',
          sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], relatedMemoryIds: data.relevantMemories!.map(memory => memory.id) },
      ] });
      return structuredResponse({ candidates: [] });
    });
    await sent(f.service, f.store, f.conversation.id, 'WorldlineBox 聊天功能验收通过，我先核对了真实结果才确认完成。', 'phase-completed');
    await background();
    const records = active(f.store, f.conversation.id), atom = records.find(memory => memory.kind === 'task')!;
    expect(records.map(memory => memory.kind).sort()).toEqual(['knowledge', 'overview', 'task']);
    for (const derived of records.filter(memory => memory.id !== atom.id)) {
      const read = f.store.request({ type: 'memory.read', companionId: 'sister', conversationId: f.conversation.id, id: derived.id }).memoryRead!;
      expect(read.related.some(memory => memory.id === atom.id)).toBe(true);
      expect(read.sources.some(source => source.content.includes('先核对了真实结果'))).toBe(true);
    }
    const correction = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '更正：聊天功能验收没有通过，仍需修复。', replyDirective: 'none' });
    f.store.request({ type: 'memory.revise', companionId: 'sister', conversationId: f.conversation.id, id: atom.id, expectedVersion: atom.version!, candidate: {
      kind: 'task', subject: 'WorldlineBox', factKey: 'chat.acceptance', content: '聊天功能验收未通过，仍需修复。', value: 'ongoing', eventId: 'chat_work', eventStatus: 'ongoing', correction: true,
      sourceMessageIds: [correction.id], evidence: [{ sourceMessageId: correction.id, quote: correction.content }],
    } });
    expect(active(f.store, f.conversation.id).map(memory => memory.kind)).toEqual(['task']);
    for (const derived of records.filter(memory => memory.id !== atom.id)) expect(f.store.request({ type: 'memory.inspect', companionId: 'sister', conversationId: f.conversation.id, id: derived.id }).memoryRead?.memory.status).toBe('invalid');
  });

  it.each([false, true])('does not reintroduce withdrawn evidence when a loop resumes (request itself withdrawn: %s)', async requestWithdrawn => {
    const f = fixture(), secret = 'SECRET_ADDRESS_青松路881号';
    const old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: `旧地址是 ${secret}`, replyDirective: 'none' });
    const saved = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id, candidate: {
      kind: 'fact', subject: 'user', factKey: 'address', content: `用户地址 ${secret}`, value: secret,
      sourceMessageIds: [old.id], evidence: [{ sourceMessageId: old.id, quote: old.content }],
    } }).memories![0]!;
    let resolvePending!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { resolvePending = resolve; });
    transport.fetch.mockResolvedValueOnce(toolResponse('read_before_shutdown', 'memory_read', { id: saved.id })).mockImplementationOnce(() => pending);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id,
      content: requestWithdrawn ? `请核对地址 ${secret}` : '请核对我引用的旧地址。', replyToId: old.id, clientId: 'forgotten-resume-request' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 500 });
    const supplement = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: `补充地址仍是 ${secret}`,
      clientId: 'forgotten-supplement', delivery: 'steer', targetSourceMessageId: source.id })).message!;
    const checkpoint = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(JSON.stringify(checkpoint)).toContain(secret);
    expect(checkpoint.supplements[0]?.id).toBe(supplement.id);
    await closeService(f.service);
    resolvePending(textResponse(`未发送的旧回复 ${secret}`));
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const request = reopened.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: requestWithdrawn ? '请忘掉刚才地址、核对请求与补充的地址。' : '请忘掉旧地址和补充的地址，保留当前核对请求。', replyDirective: 'none' });
    expect(reopened.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id,
      sourceMessageIds: [old.id, ...(requestWithdrawn ? [source.id] : []), supplement.id], requestMessageId: request.id }).forgottenCount).toBeGreaterThan(0);
    transport.fetch.mockReset(); transport.memoryFetch.mockClear();
    transport.fetch.mockImplementation(async () => textResponse('撤回的资料已移除，不继续原来的核对。'));
    const restarted = startService(f.root);
    await restarted.handle({ type: 'state' });
    await restarted.handle({ type: 'reply.resume', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(reopened.request({ type: 'work.list', sourceMessageId: source.id }).works?.every(work => work.status === (requestWithdrawn ? 'cancelled' : 'done'))).toBe(true), { timeout: 500 });
    if (requestWithdrawn) expect(transport.fetch).not.toHaveBeenCalled();
    else expect(transport.fetch).toHaveBeenCalled();
    for (const [, init] of [...transport.fetch.mock.calls, ...transport.memoryFetch.mock.calls]) expect(String(init?.body)).not.toContain(secret);
    expect(active(reopened, f.conversation.id)).toHaveLength(0);
  });
});
