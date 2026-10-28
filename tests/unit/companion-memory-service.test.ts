import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope, VcpMemoryMessage, VcpMemoryTimelineArtifacts, VcpMemoryPluginName } from '../../src/main/vcp-memory/contracts';
import { vcpMemoryNotebookFolder } from '../../src/main/vcp-memory/contracts';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import { companionsRequestSchema, type CompanionMemory } from '../../src/shared/companions';
import type { DshLauncher } from '../../src/main/dsh/launcher';
import { COMPANION_DIALOGUE_WINDOW } from '../../src/main/companions/context-window';
import { buildCompanionContext } from '../../src/main/companions/context';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionOptionalDreamError } from '../../src/main/companions/optional-dream-error';
import type { VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { verifyDshDelivery } from '../../src/main/dsh/task-delivery';
import type { DshTaskResult } from '../../src/shared/dsh-tasks';

const transport = vi.hoisted(() => ({ request: vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(),
  start: vi.fn<() => Promise<void>>(async () => undefined), close: vi.fn(async () => undefined), fetch: vi.fn<typeof fetch>(), memoryFetch: vi.fn<typeof fetch>(), worldFetch: vi.fn<typeof fetch>(), authorizationFetch: vi.fn<typeof fetch>(), prohibitionFetch: vi.fn<typeof fetch>(), progressFetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = transport.start; request = transport.request; close = transport.close;
} }));
vi.mock('electron', () => ({
  net: { fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => payload(init).purpose === 'topic_context_compaction'
    ? Promise.resolve(structuredResponse({ summary: '此前已聊过的普通历史，仍可按消息来源回读。', stage: '继续当前对话' })) : payload(init).purpose === 'companion_social_progress_review'
    ? transport.progressFetch(input, init) : /companion_management_authorization/u.test(String(init?.body))
    ? transport.authorizationFetch(input, init) : /vcp_memory_prohibition_check/u.test(String(init?.body)) ? transport.prohibitionFetch(input, init) : /vcp_(?:experience_journal|sleep_reflection)/u.test(String(init?.body))
    ? transport.memoryFetch(input, init) : /world_(?:decision|attention)/u.test(String(init?.body)) ? transport.worldFetch(input, init) : transport.fetch(input, init)) },
  dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() }, protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
}));

const seeds: CompanionSeed[] = [{ id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳', model: '', avatar: 'sister', proactive: false }];
const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionService>();
const clients = new Map<string, FakeVcpClient>();
const fixedTime = '2026-10-14T02:00:00Z';

type Payload = { purpose?: string; companion?: { id: string }; taskRequest?: { sourceMessageId: string; prompt: string };
  currentMessage?: { id: string; content: string }; messages: Array<{ id: string; content: string; authorId: string }>;
  relevantMemories?: CompanionMemory[]; memories?: CompanionMemory[]; memoryRecall?: { context?: { text: string } } };
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
function memoryResponse(id: string, action: string, args: Record<string, unknown>): Response {
  return toolResponse(id, 'memory', { action, ...args });
}
function journal(source: { id: string; content: string }, content = '用户喜欢茶。', tags = ['饮料偏好']): CompanionMemoryCandidate {
  return { content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags };
}

/** Host orchestration fake only. Original indexing/River behavior is tested in the worker suite. */
class FakeVcpClient extends VcpMemoryClient {
  override readonly supportsDetachedRecall = false;
  readonly notes = new Map<string, Map<string, VcpMemoryNote>>();
  constructor(root: string) {
    super({ dataRoot: root, vendorRoot: 'unused-vendor', workerPath: 'unused-worker',
      embedding: { baseUrl: 'http://127.0.0.1/internal-document', model: 'bundled-gemma2', apiKey: 'internal', dimension: 768 } });
  }
  override remember = vi.fn(async (scope: VcpMemoryScope, note: VcpMemoryNote) => {
    const notes = this.notes.get(scope.scopeId) ?? new Map<string, VcpMemoryNote>();
    notes.set(note.id, structuredClone(note)); this.notes.set(scope.scopeId, notes);
    return { id: note.id, indexed: true as const };
  });
  override replace = vi.fn(async (scope: VcpMemoryScope, notes: VcpMemoryNote[]) => {
    this.notes.set(scope.scopeId, new Map(notes.map(note => [note.id, structuredClone(note)])));
    return { replaced: true as const, count: notes.length };
  });
  override search = vi.fn(async (scope: VcpMemoryScope, query: { text: string; topK?: number }) => ({
    results: [...(this.notes.get(scope.scopeId)?.values() ?? [])].slice(0, query.topK ?? 100)
      .map(note => ({ ...structuredClone(note), score: 0.9, sourceFile: `memories/${note.id}.md`, engine: 'river' as const })),
    diagnostics: { jointUsed: true }, degraded: false,
  }));
  override forget = vi.fn(async (scope: VcpMemoryScope, id: string) => {
    this.notes.get(scope.scopeId)?.delete(id); return { id, deleted: true as const };
  });
  override purgeScope = vi.fn(async (scope: VcpMemoryScope) => { this.notes.delete(scope.scopeId); });
  override interruptScope = vi.fn(async () => undefined);
  override capabilities = vi.fn(async () => ({ plugins: {}, timelineGenerationConfigured: false, coldKnowledge: false }));
  override preprocess = vi.fn(async (scope: VcpMemoryScope, messages: VcpMemoryMessage[]) => ({
    messages: messages.map(message => ({ ...message, content: typeof message.content === 'string'
      ? message.content.replace(/\[\[([^\]]+)日记本::RiverMemo(?:::TimeDecay180\/0)?(?:::AIMemo\+)?\]\]/gu, (_marker, folders: string) => [...(this.notes.get(scope.scopeId)?.values() ?? [])]
        .filter(note => folders.split('|').includes(vcpMemoryNotebookFolder(note.diaryName))).map(note => note.content).join('\n'))
        .replace('[[AIMemo=True]]', '')
        .replace('[[VCPTimeLine::WorldlineBox]]', '') : message.content })), events: [],
  }));
  override pluginCall = vi.fn(async (scope: VcpMemoryScope, plugin: VcpMemoryPluginName, arguments_: Record<string, unknown>) => {
    if (plugin !== 'LightMemo' || typeof arguments_.folder !== 'string') throw new Error('Unexpected fixture plugin command.');
    return { result: [...(this.notes.get(scope.scopeId)?.values() ?? [])].filter(note => String(arguments_.folder).split(',').includes(vcpMemoryNotebookFolder(note.diaryName))).map(note => note.content).join('\n'), indexed: true };
  });
  override exportTimelineArtifacts = vi.fn(async (_scope: VcpMemoryScope, sourceRevision: string): Promise<VcpMemoryTimelineArtifacts> => ({
    schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision, agents: [],
  }));
  override importTimelineArtifacts = vi.fn(async () => ({ acceptedMonths: 0, skippedMonths: 0 }));
  override close = vi.fn(async () => undefined);
}
function bindStorage(store: CompanionsStore) {
  transport.request.mockImplementation(async command => store.request(command));
  transport.close.mockImplementation(async () => { store.close(); stores.delete(store); });
}
function startService(root: string, memoryLibrary = false): CompanionService {
  const dsh = { state: () => ({ tasks: [], operations: [] }), requestTask: vi.fn(async () => ({ ok: true })) } as unknown as DshLauncher;
  const client = new FakeVcpClient(root); clients.set(root, client);
  const runtime: CompanionMemoryRuntime = controlledMemoryRuntime({ get: async () => ({ client, profileKey: 'bundled-gemma2:768' }), close: async () => client.close() });
  const service = new CompanionService({ userData: root, workerPath: 'mocked-worker', window: () => undefined, memoryRuntime: runtime,
    ...(memoryLibrary ? { memoryLibraryRoot: path.join(root, 'assets', '伙伴记忆') } : {}),
    getConfig: () => ({ apiFormat: 'openai_chat', model: 'memory-test-chat-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' }),
    hasConfig: () => true, dsh: () => dsh, report: vi.fn() });
  services.add(service); return service;
}
function fixture(customSeeds = seeds, memoryLibrary = false) {
  const testNow = Date.now(); vi.setSystemTime(testNow - 10_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-service-')); roots.push(root);
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  const store = new CompanionsStore(databasePath, customSeeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const conversation = store.openPrivate('sister');
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
  for (const seed of customSeeds) {
    const room = store.openPrivate(seed.id);
    const computer = world.scenes.find(scene => scene.ownerId === seed.id)!.objects.find(object => object.kind === 'computer')!;
    store.request({ type: 'world.tool', companionId: seed.id, conversationId: room.id, arguments: { action: 'move', destinationId: computer.id } });
  }
  vi.setSystemTime(testNow); store.request({ type: 'world.tick' }); bindStorage(store);
  return { root, databasePath, store, conversation, service: startService(root, memoryLibrary) };
}
async function closeService(service: CompanionService) {
  const done = service.shutdown(); await vi.advanceTimersByTimeAsync(1_000); await done; services.delete(service);
}
async function sent(service: CompanionService, store: CompanionsStore, conversationId: string, content: string, clientId: string) {
  const result = await service.handle({ type: 'message.send', conversationId, content, clientId, delivery: 'chat' });
  const message = result.message!;
  try { await vi.waitFor(() => expect(store.request({ type: 'work.list', sourceMessageId: message.id }).works?.every(work => work.status === 'done'), content).toBe(true), { timeout: 5000 }); }
  catch (error) {
    const reports = (service as unknown as { options: { report: { mock: { calls: unknown[][] } } } }).options.report.mock.calls.flat().map(value => value instanceof Error ? value.message : String(value));
    const work = store.request({ type: 'work.list', sourceMessageId: message.id }).works;
    const checkpoint = store.request({ type: 'loop.get', companionId: 'sister', sourceMessageId: message.id }).loop;
    const memory = (service as unknown as { memory: { invalidations: Map<string, unknown>; queryTails: Map<string, unknown>; captures: Map<string, unknown>; continuity?: { owner: string } } }).memory;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nHost reports: ${JSON.stringify(reports)}\nWork: ${JSON.stringify(work)}\nLoop: ${JSON.stringify({ status: checkpoint?.status, calls: checkpoint?.turns.flatMap(turn => turn.calls.map(call => call.id)), progress: checkpoint?.progress })}\nMemory waits: ${JSON.stringify({ invalidations: [...memory.invalidations.keys()], queries: [...memory.queryTails.keys()], captures: [...memory.captures.keys()], continuity: memory.continuity?.owner })}`, { cause: error });
  }
  return message;
}
function active(store: CompanionsStore, conversationId: string, companionId = 'sister') {
  return store.request({ type: 'memory.browse', companionId, conversationId, limit: 100 }).memoryPage!.items.map(hit => hit.memory);
}
function status(store: CompanionsStore, companionId = 'sister') { return store.request({ type: 'memory.status', companionId }).memoryStatus!; }

it('edits the actual shared model budget file through Main only after validating the selected companion', async () => {
  const f = fixture(seeds, true);
  const initial = (await f.service.manageModelResources({ type: 'model.resources.read', companionId: 'sister' })).modelResources!;
  const file = path.join(f.root, 'companions', initial.path), policy = JSON.parse(initial.content);
  expect(readFileSync(file, 'utf8')).toBe(initial.content); expect(initial.usage.requests).toBe(0);
  policy.defaultConnection.requestsPerMinute = 3;
  const edited = JSON.stringify(policy, null, 2);
  const saved = (await f.service.manageModelResources({ type: 'model.resources.save', companionId: 'sister', expectedRevision: initial.revision, content: edited })).modelResources!;
  expect(readFileSync(file, 'utf8')).toBe(edited); expect(saved.revision).not.toBe(initial.revision);
  policy.defaultConnection.requestsPerMinute = 7;
  await expect(f.service.manageModelResources({ type: 'model.resources.save', companionId: 'missing-owner', expectedRevision: saved.revision, content: JSON.stringify(policy) })).rejects.toThrow('伙伴不存在');
  expect(readFileSync(file, 'utf8')).toBe(edited);
  writeFileSync(file, JSON.stringify(policy));
  await expect(f.service.manageModelResources({ type: 'model.resources.save', companionId: 'sister', expectedRevision: saved.revision, content: edited })).rejects.toThrow('外部修改');
  expect(JSON.parse(readFileSync(file, 'utf8')).defaultConnection.requestsPerMinute).toBe(7);
});
it.each(['next_day', 'raised_budget'] as const)('parks actual Main capture until the durable local budget deadline without spending eight extraction attempts: %s', async recovery => {
  const f = fixture(seeds, true);
  await sent(f.service, f.store, f.conversation.id, '今天先正常聊一句。', 'budget-deferral-baseline');
  const initial = (await f.service.manageModelResources({ type: 'model.resources.read', companionId: 'sister' })).modelResources!;
  const policy = JSON.parse(initial.content); expect(initial.usage.requests).toBeGreaterThan(0);
  policy.defaultConnection.requestsPerUtcDay = initial.usage.requests;
  await f.service.manageModelResources({ type: 'model.resources.save', companionId: 'sister', expectedRevision: initial.revision, content: JSON.stringify(policy) });
  const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '这份欠账需要在资源恢复后写入。', replyDirective: 'none' });
  (f.service as unknown as { memory: CompanionMemoryService }).memory.changed('sister');
  const db = new (Database as unknown as { new(file: string): CompanionConnection })(f.databasePath);
  try {
    const httpBefore = transport.memoryFetch.mock.calls.length;
    await background(65_000);
    await vi.waitFor(() => expect((db.prepare('SELECT next_attempt FROM vcp_capture_jobs WHERE message_id=?').get(source.id) as { next_attempt: number }).next_attempt).toBeGreaterThan(Date.now()), { timeout: 5000 });
    const deferred = db.prepare('SELECT status,attempts,next_attempt,error FROM vcp_capture_jobs WHERE message_id=?').get(source.id) as { status: string; attempts: number; next_attempt: number; error: string };
    expect(deferred).toMatchObject({ status: 'pending', attempts: 0, error: expect.stringContaining('预算') });
    expect(deferred.next_attempt).toBeGreaterThan(Date.now() + 60_000);
    for (let poll = 0; poll < 10; poll++) await background(31_000);
    expect(db.prepare('SELECT status,attempts,next_attempt FROM vcp_capture_jobs WHERE message_id=?').get(source.id)).toEqual({ status: 'pending', attempts: 0, next_attempt: deferred.next_attempt });
    expect(transport.memoryFetch).toHaveBeenCalledTimes(httpBefore);
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const actual = payload(init).messages.find(message => message.id === source.id);
      return structuredResponse({ notes: actual ? [journal(actual, actual.content)] : [] });
    });
    if (recovery === 'next_day') vi.setSystemTime(deferred.next_attempt + 1000);
    else {
      const current = (await f.service.manageModelResources({ type: 'model.resources.read', companionId: 'sister' })).modelResources!;
      const raised = JSON.parse(current.content); raised.defaultConnection.requestsPerUtcDay += 20;
      await f.service.manageModelResources({ type: 'model.resources.save', companionId: 'sister', expectedRevision: current.revision, content: JSON.stringify(raised) });
    }
    await background(31_000);
    await vi.waitFor(() => expect(db.prepare('SELECT status,attempts FROM vcp_capture_jobs WHERE message_id=?').get(source.id)).toEqual({ status: 'done', attempts: 1 }), { timeout: 5000 });
    expect(active(f.store, f.conversation.id).some(note => note.content === source.content)).toBe(true);
  } finally { db.close(); }
}, 20_000);
/** The native model memory tool uses this Main host port; internal proposals
 * are deliberately absent from the human management request schema. */
function hostMemory(service: CompanionService, command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
  return (service as unknown as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }).call(command);
}
it('resumes a paid capture writer after restart with one HTTP request per UTC day instead of paying the writer forever', async () => {
  const f = fixture(seeds, true), currentService = f.service; let currentStore = f.store;
  const initial = (await currentService.manageModelResources({ type: 'model.resources.read', companionId: 'sister' })).modelResources!;
  const policy = JSON.parse(initial.content); policy.defaultConnection.requestsPerUtcDay = 1;
  await currentService.manageModelResources({ type: 'model.resources.save', companionId: 'sister', expectedRevision: initial.revision, content: JSON.stringify(policy) });
  currentStore.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, tag: '家庭住址', persistent: true });
  const source = currentStore.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '蓝色纸张放在书房抽屉。', replyDirective: 'none' });
  transport.memoryFetch.mockImplementation(async () => structuredResponse({ notes: [journal(source, source.content)] }));
  (currentService as unknown as { memory: CompanionMemoryService }).memory.changed('sister');
  await background(65_000);
  const db = new (Database as unknown as { new(file: string): CompanionConnection })(f.databasePath);
  let deadline: number;
  try {
    await vi.waitFor(() => expect(db.prepare('SELECT status,attempts,admission_deferred FROM vcp_capture_jobs WHERE message_id=?').get(source.id)).toEqual({ status: 'pending', attempts: 0, admission_deferred: 1 }), { timeout: 5000 });
    deadline = (db.prepare('SELECT next_attempt FROM vcp_capture_jobs WHERE message_id=?').get(source.id) as { next_attempt: number }).next_attempt;
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_capture_proposals').get()).toEqual({ n: 1 });
  } finally { db.close(); }
  expect(transport.memoryFetch).toHaveBeenCalledTimes(1); expect(transport.prohibitionFetch).not.toHaveBeenCalled();
  expect(currentStore.request({ type: 'model.resources.usage', companionId: 'sister' }).modelResourceUsage?.requests).toBe(1);
  await closeService(currentService);
  currentStore = new CompanionsStore(f.databasePath, seeds); stores.add(currentStore); bindStorage(currentStore);
  vi.setSystemTime(deadline! + 1000); startService(f.root, true);
  await background(31_000);
  await vi.waitFor(() => expect(active(currentStore, f.conversation.id)).toHaveLength(1), { timeout: 5000 });
  expect(active(currentStore, f.conversation.id)[0]!.content).toBe(source.content);
  expect(transport.memoryFetch).toHaveBeenCalledTimes(1); expect(transport.prohibitionFetch).toHaveBeenCalledTimes(1);
  expect(currentStore.request({ type: 'model.resources.usage', companionId: 'sister' }).modelResourceUsage?.requests).toBe(1);
  const after = new (Database as unknown as { new(file: string): CompanionConnection })(f.databasePath);
  try { expect(after.prepare('SELECT COUNT(*) AS n FROM companion_capture_proposals').get()).toEqual({ n: 0 }); } finally { after.close(); }
}, 30_000);
it('reconciles an external new topic on memory read while its semantic checker can read the current role', async () => {
  const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
  const saved = (await f.service.handle({ type: 'memory.save', ...scope, content: '旧稿只写过银色文件夹。' })).memories![0]!;
  f.store.request({ type: 'memory.forget', ...scope, tag: '家庭住址', persistent: true });
  const file = path.join(f.root, 'assets', '伙伴记忆', 'sister', '日记', saved.id + '.md');
  writeFileSync(file, '外部修改的新主题：海棠磁卡位于实验室的蓝色工具盒。');
  let reentered = 0;
  transport.prohibitionFetch.mockImplementation(async () => {
    const nested = await f.service.prepareModelAssetContext('sister', { system: '内部checker技术合同。', user: JSON.stringify({ purpose: 'vcp_memory_prohibition_check' }) }, 'structured');
    expect(nested.system).toContain('当前伙伴目录'); reentered++;
    return structuredResponse({ allowed: true, matchedPolicyIds: [] });
  });
  const actual = (await f.service.handle({ type: 'memory.read', ...scope, id: saved.id, sourceLimit: 10 })).memoryRead!;
  const admission = await f.service.prepareModelAssetContext('sister', { system: '外部实际请求技术合同。', user: JSON.stringify({ purpose: 'companion_reply' }) }, 'reply');
  expect(admission.system).toContain('当前伙伴目录'); expect(reentered).toBe(1);
  expect(actual.memory.content).toContain('海棠磁卡位于实验室的蓝色工具盒');
  expect(actual.sources.some(source => source.content.includes('海棠磁卡位于实验室的蓝色工具盒'))).toBe(true);
}, 20_000);
it('finishes and displays a real reply while unrelated notebook reconciliation is still pending', async () => {
  const f = fixture(seeds, true);
  const gate = vi.spyOn(f.service as unknown as { prepareOwnerMemoryFiles(owner: string): Promise<void> }, 'prepareOwnerMemoryFiles')
    .mockRejectedValue(Object.assign(new Error('测试：其他文档仍在分批核对'), { code: 'MEMORY_FILES_PENDING' }));
  transport.fetch.mockImplementation(async () => textResponse('你好，我在这里。'));
  const source = await sent(f.service, f.store, f.conversation.id, '你好，聊聊今天的计划。', 'pending-file-reply');
  const loop = f.store.request({ type: 'loop.get', companionId: 'sister', sourceMessageId: source.id }).loop!;
  expect(loop.status).toBe('done'); expect(loop.progress?.phase).toBe('completed');
  expect(loop.progress?.memory?.status).toBe('unavailable');
  const replies = f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === 'sister' && !message.memoryEvidenceOnly);
  expect(replies.some(message => message.content === '你好，我在这里。')).toBe(true);
  expect(replies.every(message => message.replyProgress?.phase !== 'failed')).toBe(true);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
  const role = await f.service.prepareModelAssetContext('sister', { system: '继续读取当前角色。', user: '{}' }, 'structured');
  expect(role.system).toContain('当前伙伴目录');
  gate.mockRestore();
}, 20_000);
async function background(milliseconds = 2_100) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  // The persistent permission-view manifest uses real asynchronous file I/O.
  await vi.waitFor(() => {
    for (const store of stores) for (const companion of store.request({ type: 'state', includeConversations: false }).state?.companions ?? []) {
      expect(status(store, companion.id).running).toBe(0);
    }
  }, { timeout: 5000 });
}
function markIndexed(store: CompanionsStore) {
  for (let count = 0; count < 100; count++) {
    const row = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (!row) return;
    store.request({ type: 'memory.outbox.complete', id: row.id, leaseToken: row.leaseToken, indexed: true });
  }
  throw new Error('Unexpected outbox backlog.');
}

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(fixedTime));
  transport.start.mockReset(); transport.start.mockResolvedValue(undefined);
  transport.fetch.mockReset(); transport.memoryFetch.mockReset();
  // This suite verifies memory orchestration, not semantic critic accuracy.
  // Keep the actual mandatory review phase separate from writer mock sequences.
  transport.progressFetch.mockReset(); transport.progressFetch.mockImplementation(async () => structuredResponse({ supported: true, correction: '' }));
  transport.prohibitionFetch.mockReset(); transport.prohibitionFetch.mockImplementation(async () => structuredResponse({ allowed: true, matchedPolicyIds: [] }));
  transport.authorizationFetch.mockReset(); transport.authorizationFetch.mockImplementation(async (_input, init) => {
    const data = JSON.parse(body(init).messages[1]!.content) as { source: { id: string; content: string }; tool: string; action: string; targetId: string | null };
    return structuredResponse({ allowed: data.source.content.startsWith('请忘掉'), confidence: 1,
      sourceMessageId: data.source.id, tool: data.tool, action: data.action, targetId: data.targetId, evidence: [data.source.content] });
  });
  transport.worldFetch.mockReset(); transport.worldFetch.mockImplementation(async () => structuredResponse({ action: null, reason: '安静观察。', appraisals: [] }));
  transport.fetch.mockImplementation(async () => textResponse('好，慢慢聊。'));
  transport.memoryFetch.mockImplementation(async () => structuredResponse({ notes: [] }));
});
afterEach(async () => {
  for (const service of services) await closeService(service);
  for (const store of stores) store.close(); stores.clear(); clients.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-memory-service-')) throw new Error('Unexpected memory test cleanup target.');
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe('VCP companion memory through the main service and real SQLite', () => {
  it.each([false, true])('reads actual same-source summaries when VCP returns no hit and preserves a missing contribution (missing=%s)', async missing => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const raw = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user',
      content: '我叫青遥。剩余米色棉线放在第二层抽屉。', replyDirective: 'none' });
    const saved = (await hostMemory(f.service, { type: 'memory.record', ...scope,
      candidate: { ...journal(raw, missing ? '玩家亲口介绍自己名叫青遥。' : '玩家名叫青遥，剩余米色棉线在第二层抽屉。'),
        evidence: [{ sourceMessageId: raw.id, quote: '我叫青遥。' }] } })).memories![0]!;
    clients.get(f.root)!.search.mockResolvedValue({ results: [], diagnostics: { jointUsed: true }, degraded: false });
    let observed = false;
    transport.memoryFetch.mockImplementation(async (_url, init) => {
      const data = payload(init) as Payload & { sourceContract: { savedContributions: Array<{ memoryId: string; coverage: string }> } };
      expect(data.relevantMemories?.find(note => note.id === saved.id)?.content).toBe(saved.content);
      expect(data.sourceContract.savedContributions).toContainEqual(expect.objectContaining({ memoryId: saved.id, coverage: 'partial' }));
      observed = true;
      return structuredResponse({ notes: missing ? [journal(raw, '玩家说明剩余米色棉线放在第二层抽屉。', ['材料存放'])] : [] });
    });
    await background(61_100); await vi.waitFor(() => expect(observed).toBe(true));
    const notes = active(f.store, scope.conversationId).filter(note => note.sources.some(source => source.messageId === raw.id));
    expect(notes).toHaveLength(missing ? 2 : 1);
    expect(notes.find(note => note.id === saved.id)?.content).toBe(saved.content);
    if (missing) expect(notes.some(note => note.id !== saved.id && note.content.includes('第二层抽屉'))).toBe(true);
  });

  it('does not encode a stale SQL contribution when its actual file has an unapproved external edit', async () => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const raw = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我叫青遥，这条介绍还等待后台核对。', replyDirective: 'none' });
    const saved = (await hostMemory(f.service, { type: 'memory.record', ...scope, candidate: journal(raw, '玩家的名字是青遥。') })).memories![0]!;
    const prohibited = f.store.saveMemory({ ...scope, content: '不得再记录住址。', tags: ['住址'] });
    f.store.request({ type: 'memory.forget', ...scope, id: prohibited.id, tag: '住址', persistent: true });
    const file = path.join(f.root, 'assets', '伙伴记忆', 'sister', '日记', saved.id + '.md');
    writeFileSync(file, '外部编辑包含尚未获准登记的住址。');
    transport.prohibitionFetch.mockImplementation(async () => structuredResponse({ allowed: false, matchedPolicyIds: [] }));
    await background(61_100);
    await vi.waitFor(() => expect(status(f.store).failed).toBeGreaterThan(0));
    expect(transport.memoryFetch).not.toHaveBeenCalled();
    expect(active(f.store, scope.conversationId).find(note => note.id === saved.id)?.content).toBe(saved.content);
    expect(readFileSync(file, 'utf8')).toBe('外部编辑包含尚未获准登记的住址。');
  });

  it('browses complete canonical journal bodies by empty-query tags and date with bounded pagination and actual owner/source ACLs', async () => {
    const f = fixture([...seeds, { ...seeds[0]!, id: 'flash', name: '另一位伙伴', avatar: 'flash' }], true);
    const scope = { companionId: 'sister', conversationId: f.conversation.id }, tag = '元数据分页验收';
    const save = (content: string, ownerScope = scope, tags = [tag], occurredAt = fixedTime) => {
      const source = f.store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content, replyDirective: 'none' });
      return f.store.request({ type: 'memory.record', ...ownerScope, candidate: { ...journal(source, content, tags), occurredAt, metadata: { autoTags: false } } }).memories![0]!;
    };
    const full = '分页正文的前部。' + '必要的原始过程与限定。'.repeat(500) + 'FINAL_REQUIRED_FRAGMENT_761';
    const expected = [full, '同一事件的第二篇独立记录。', '同一事件的第三篇独立记录。'].map(content => save(content));
    save('同标签但日期范围之外，明确发生于2020年1月1日。', scope, [tag], '2020-01-01T00:00:00Z');
    save('日期相同但标签不匹配。', scope, ['其他标签']);
    const blocked = save('已明确撤销的来源不属于浏览结果。');
    f.store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [blocked.sources[0]!.messageId] });
    const otherScope = { companionId: 'flash', conversationId: f.store.openPrivate('flash').id };
    save('FOREIGN_OWNER_TAG_MATCH_SECRET', otherScope);
    markIndexed(f.store);
    const found: CompanionMemory[] = [], cursors: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 4; page++) {
      const response = await f.service.handle(companionsRequestSchema.parse({ type: 'memory.search', ...scope, tags: [tag], from: '2026-10-14', to: '2026-10-14', limit: 1,
        ...(page % 2 ? { query: '' } : {}), ...(cursor === undefined ? {} : { cursor }) }));
      expect(response.memoryContext).toBeUndefined();
      const actual = response.memoryPage!; expect(actual.items).toHaveLength(1);
      expect(response.memorySelection).toMatchObject({ kind: 'metadata_directory', scope, filters: { tags: [tag], from: '2026-10-14', to: '2026-10-14' },
        page: { cursor: cursor ?? 0, limit: 1, returned: 1, hasMore: actual.hasMore }, directoryEndReached: !actual.hasMore, priorPagesReadAttested: false });
      found.push(...actual.items.map(hit => hit.memory));
      if (!actual.hasMore) { expect(actual.nextCursor).toBeUndefined(); break; }
      expect(actual.nextCursor).toBeGreaterThan(cursor ?? 0); cursor = actual.nextCursor; cursors.push(cursor!);
    }
    expect(cursors).toEqual([1, 2]);
    expect(new Set(found.map(note => note.id))).toEqual(new Set(expected.map(note => note.id)));
    expect(found.find(note => note.id === expected[0]!.id)?.content).toBe(full);
    expect(found.every(note => note.companionId === 'sister')).toBe(true);
    for (const note of found) expect(readFileSync(path.join(f.root, 'assets', '伙伴记忆', 'sister', '日记', note.id + '.md'), 'utf8')).toBe(note.content);
    expect(clients.get(f.root)!.search).not.toHaveBeenCalled();
    await expect(f.service.handle(companionsRequestSchema.parse({ type: 'memory.search', companionId: 'sister', conversationId: otherScope.conversationId, tags: [tag], limit: 1 }))).rejects.toThrow();
  }, 20000);

  it('reconciles external canonical edits before an empty-query tag browse and never returns deleted-file SQL bodies', async () => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id }, tags = ['目录浏览文件权威'];
    const note = f.store.saveMemory({ ...scope, content: 'OLD_SQL_BODY_MUST_NOT_BE_USED', tags }); markIndexed(f.store);
    const first = await f.service.handle(companionsRequestSchema.parse({ type: 'memory.search', ...scope, tags, limit: 1 }));
    expect(first.memoryPage!.items[0]!.memory.content).toBe(note.content);
    const file = path.join(f.root, 'assets', '伙伴记忆', 'sister', '日记', note.id + '.md');
    const edited = '外部真实文件中的完整新正文。' + '保留目录读取的实际限定。'.repeat(400) + 'EXTERNAL_END_982';
    writeFileSync(file, edited);
    const current = await f.service.handle({ type: 'memory.search', ...scope, query: '', tags, limit: 1 });
    expect(current.memoryPage!.items[0]!.memory).toMatchObject({ id: note.id, content: edited, contentRevision: 2 });
    unlinkSync(file);
    // Reconciliation may remove the note from the page or reject the read.
    // Neither outcome may expose a stale copy of the now-missing body.
    const missing = await f.service.handle(companionsRequestSchema.parse({ type: 'memory.search', ...scope, tags, limit: 1 })).catch(() => undefined);
    expect(missing?.memoryPage?.items ?? []).toEqual([]);
    expect(() => readFileSync(file, 'utf8')).toThrow();
    expect(clients.get(f.root)!.search).not.toHaveBeenCalled();
  }, 20000);

  it('delivers the full empty-query tagged body through the actual Main tool loop instead of a truncated preview', async () => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id }, tags = ['完整原记录工具验收'];
    const full = '本条长记忆的起点。' + '实际原记录中的条件和过程。'.repeat(500) + 'TOOL_BODY_END_678';
    const note = f.store.saveMemory({ ...scope, content: full, tags }); markIndexed(f.store);
    let steps = 0, nativeSearchesBeforeBrowse = 0;
    transport.fetch.mockImplementation(async (_input, init) => {
      if (steps++ === 0) {
        nativeSearchesBeforeBrowse = clients.get(f.root)!.search.mock.calls.length;
        return memoryResponse('actual_empty_query_browse', 'search', { tags, limit: 1 });
      }
      const result = body(init).messages.findLast(message => message.role === 'tool');
      expect(result).toBeDefined();
      const parsed = JSON.parse(result!.content);
      expect(parsed.memoryPage.items[0].memory).toMatchObject({ id: note.id, content: full });
      expect(parsed.memorySelection).toMatchObject({ kind: 'metadata_directory', scope, page: { returned: 1, hasMore: false },
        directoryEndReached: true, priorPagesReadAttested: false });
      expect(result!.content).toContain('TOOL_BODY_END_678');
      expect(clients.get(f.root)!.search.mock.calls.length).toBe(nativeSearchesBeforeBrowse);
      return textResponse('已读取实际原记录的末尾 TOOL_BODY_END_678。');
    });
    const source = await sent(f.service, f.store, scope.conversationId, '请核对已保存资料的完整原记录。', 'empty-query-complete-tool-body');
    const loop = f.store.request({ type: 'loop.get', companionId: scope.companionId, sourceMessageId: source.id }).loop!;
    expect(steps).toBe(2);
    const result = loop.turns.flatMap(turn => turn.results ?? []).find(item => item.callId === 'actual_empty_query_browse')!;
    expect(JSON.parse(result.content).memoryPage.items[0].memory.content).toBe(full);
  }, 20000);

  it('writes app saves to canonical owner files and immediately imports external edits through the same checked policy gate', async () => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const saved = (await f.service.handle({ type: 'memory.save', ...scope, content: 'APP_WRITE_THROUGH_ACTUAL_TEXT' })).memories![0]!;
    const notebook = path.join(f.root, 'assets', '伙伴记忆', 'sister', '日记');
    const file = path.join(notebook, saved.id + '.md'); expect(readFileSync(file, 'utf8')).toBe(saved.content);
    const blocked = f.store.saveMemory({ ...scope, content: '另一个禁止今后记录的主题。', tags: ['禁止项'] });
    f.store.request({ type: 'memory.forget', ...scope, id: blocked.id, tag: '禁止项', persistent: true });
    writeFileSync(file, 'EXTERNAL_EDIT_READ_IMMEDIATELY_WITH_POLICY');
    const actual = await f.service.handle({ type: 'memory.read', ...scope, id: saved.id, sourceLimit: 10 });
    expect(actual.memoryRead!.memory).toMatchObject({ content: 'EXTERNAL_EDIT_READ_IMMEDIATELY_WITH_POLICY', contentRevision: 2 });
    expect(f.store.request({ type: 'memory.read', ...scope, id: saved.id }).memoryRead!.memory.content).toBe('EXTERNAL_EDIT_READ_IMMEDIATELY_WITH_POLICY');
    expect(transport.prohibitionFetch).toHaveBeenCalled();
  }, 20000);

  it('fails closed when the actual canonical file was removed instead of answering from cached SQL', async () => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const saved = (await f.service.handle({ type: 'memory.save', ...scope, content: 'REMOVED_FILE_MUST_NOT_FALL_BACK_TO_SQL' })).memories![0]!;
    const file = path.join(f.root, 'assets', '伙伴记忆', 'sister', '日记', saved.id + '.md');
    unlinkSync(file);
    await expect(f.service.handle({ type: 'memory.read', ...scope, id: saved.id, sourceLimit: 10 })).rejects.toThrow();
    expect(() => readFileSync(file, 'utf8')).toThrow();
  }, 20000);

  it('uses edited asset profile text in the actual provider request while another malformed owner remains isolated', async () => {
    const f = fixture([...seeds, { ...seeds[0]!, id: 'flash', name: '另一位伙伴', avatar: 'flash', persona: '另一位伙伴自己的稳定设置。' }], true);
    await f.service.handle({ type: 'state' });
    const ownerRoot = path.join(f.root, 'assets', '伙伴记忆', 'sister'), profile = path.join(ownerRoot, 'profile.md');
    writeFileSync(profile, readFileSync(profile, 'utf8').replace(/(\r?\n---\r?\n)[\s\S]*$/u, '$1\nCURRENT_FILE_PERSONA_MUST_REACH_PROVIDER\n'));
    writeFileSync(path.join(f.root, 'assets', '伙伴记忆', 'flash', 'profile.md'), 'malformed profile must not replace another owner');
    const state = (await f.service.handle({ type: 'state' })).state!;
    expect(state.companions.find(owner => owner.id === 'flash')?.availability).toBe('offline');
    expect(state.companions.find(owner => owner.id === 'sister')?.persona).toBe('CURRENT_FILE_PERSONA_MUST_REACH_PROVIDER');
    await sent(f.service, f.store, f.conversation.id, '请简短说明你现在依据的角色资料。', 'live_profile_provider');
    expect(transport.fetch.mock.calls.some(([, init]) => String(init?.body).includes('CURRENT_FILE_PERSONA_MUST_REACH_PROVIDER'))).toBe(true);
    expect(transport.fetch.mock.calls.every(([, init]) => !String(init?.body).includes('温柔沉稳'))).toBe(true);
    expect(readdirSync(ownerRoot)).toContain('提示词');
  }, 20000);
  it('persists initialization outside the owner directory and never restores a deleted owner from seed settings after restart', async () => {
    const f = fixture(seeds, true);
    await f.service.handle({ type: 'state' });
    expect(f.store.request({ type: 'companion.assets.initialized', companionId: 'sister' }).assetProfileInitialized).toBe(true);
    await closeService(f.service);
    const ownerRoot = path.join(f.root, 'assets', '伙伴记忆', 'sister');
    rmSync(ownerRoot, { recursive: true });
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, true), state = (await restarted.handle({ type: 'state' })).state!;
    expect(state.companions.find(owner => owner.id === 'sister')).toMatchObject({ availability: 'offline', assetProfileError: expect.any(String) });
    await expect(restarted.resolveOwnerStorage('sister')).rejects.toThrow();
    const cleanup = await restarted.resolveOwnerCleanupStorage('sister');
    expect(cleanup).toMatchObject({ ownerId: 'sister', ownerRoot, indexRoot: path.join(ownerRoot, '.认知索引') });
    expect(() => readdirSync(ownerRoot)).toThrow();
    expect(reopened.request({ type: 'companion.assets.initialized', companionId: 'sister' }).assetProfileInitialized).toBe(true);
  }, 20000);
  it.each(['runtime', 'native', 'source_revision', 'owner', 'generation', 'native_integrity', 'native_abort', 'returned_owner', 'returned_time', 'returned_revision',
    'VCP_MEMORY_CLOSED', 'VCP_MEMORY_DERIVED_TIMEOUT', 'VCP_MEMORY_DERIVED_FAILED', 'VCP_MEMORY_EMBEDDING_RESPONSE_INVALID', 'VCP_MEMORY_PACKAGE_MISSING', 'VCP_MEMORY_ERROR',
    'VCP_MEMORY_UNSAFE_SOURCE', 'VCP_MEMORY_SOURCE_ID_MISMATCH', 'VCP_MEMORY_DIARY_ID_CONFLICT', 'VCP_MEMORY_EMBEDDING_SPACE_MISMATCH',
    'VCP_MEMORY_RUNTIME_LAYOUT', 'VCP_MEMORY_INVALID_INPUT', 'VCP_MEMORY_INVALID_DIMENSION', 'VCP_MEMORY_UNKNOWN_FUTURE_CODE'] as const)(
    'classifies optional dream %s failure only while the actual owner and sources remain current', async failure => {
    const f = fixture(), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '梦境服务故障不改变这一真实来源。', replyDirective: 'none' });
    f.store.request({ type: 'memory.record', ...scope, candidate: journal(source, source.content) }); markIndexed(f.store);
    const captured = f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
    const client = new FakeVcpClient(path.join(f.root, 'optional-dream'));
    let cancelDuringOwnerCheck = false;
    const get = vi.fn(async () => {
      if (failure === 'runtime') throw Error('Operational failure with private endpoint details that must not be persisted.');
      return { client, profileKey: 'optional-dream-fixture' };
    });
    const memory = new CompanionMemoryService({ cacheRoot: path.join(f.root, 'optional-dream-views'), runtime: controlledMemoryRuntime({ get, close: async () => client.close() }),
      request: async command => {
        const response = f.store.request(command);
        if (cancelDuringOwnerCheck && command.type === 'state') { cancelDuringOwnerCheck = false; memory.cancelCompanion('sister'); }
        return response;
      }, configFor: async () => ({ apiFormat: 'openai_chat', model: 'unused', baseUrl: 'https://provider.invalid', apiKey: 'unused' }),
      fetchFn: async () => { throw Error('No model dispatch is allowed in operational-boundary tests.'); }, busy: () => true, changed: vi.fn(), report: vi.fn() });
    const native = vi.spyOn(client, 'dreamWave').mockImplementation(async (_view, request): Promise<VcpMemoryDreamWaveResult> => {
      if (failure === 'source_revision') {
        const db = new (Database as { new(file: string): CompanionConnection })(f.databasePath);
        try { db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(source.id); }
        finally { db.close(); }
        const frozen = captured.notes.map(note => ({ id: note.id, sources: note.sources.map(receipt => ({
          id: receipt.messageId, conversationId: receipt.conversationId, checksum: receipt.checksum,
        })) }));
        expect(f.store.request({ type: 'memory.lifecycle.state', companionId: scope.companionId }).memoryLifecycleState!.revocationEpoch).toBe(captured.revocationEpoch);
        expect(f.store.request({ type: 'memory.frozen.valid', ...scope, memories: frozen }).memoryFrozenValid).toBe(true);
        expect(f.store.request({ type: 'memory.frozen.valid', ...scope, memories: frozen.map(note => ({ ...note,
          sources: note.sources.map(receipt => ({ ...receipt, revision: captured.notes.find(original => original.id === note.id)!.sources.find(original => original.messageId === receipt.id)!.revision })),
        })) }).memoryFrozenValid).toBe(false);
      } else if (failure === 'owner') f.store.updateCompanion('sister', { name: '改名后的真实伙伴', description: '姐姐', persona: '温柔沉稳', model: '', avatar: 'sister', proactive: false });
      else if (failure === 'generation') cancelDuringOwnerCheck = true;
      else if (failure === 'native_integrity') throw Object.assign(Error('Native owner/version/content evidence is invalid.'), { code: 'VCP_MEMORY_DREAM_INVALID' });
      else if (failure === 'native_abort') throw Object.assign(Error('Native scope was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
      else if (failure.startsWith('VCP_MEMORY_')) throw Object.assign(Error('Native operation returned a coded failure.'), { code: failure });
      if (failure.startsWith('returned_')) return { schema: 'worldlinebox.vcp-dream-wave', owner: { ...request.owner,
        ...(failure === 'returned_owner' ? { companionId: 'another-owner' } : {}) },
        sourceRevision: failure === 'returned_revision' ? 'forged-revision' : request.sourceRevision,
        now: failure === 'returned_time' ? '1999-01-01T00:00:00Z' : request.now, clockDomain: request.clockDomain,
        boundaries: { recentDays: 7, midDays: 90 }, stages: { recent: { seeds: [], resonanceL1: [], cascadeL2: [] }, mid: { seeds: [], cascadeL1: [] }, deep: { recalls: [] } },
        diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: 1, indexedCount: 1, queries: [] } };
      throw Error('Native request failed; this raw provider detail must not become a persisted diagnostic.');
    });
    try {
      const result = memory.dreamWave({ ...scope, now: fixedTime, clockDomain: 'world' });
      const operational = new Set<string>(['runtime', 'native', 'VCP_MEMORY_CLOSED', 'VCP_MEMORY_DERIVED_TIMEOUT', 'VCP_MEMORY_DERIVED_FAILED',
        'VCP_MEMORY_EMBEDDING_RESPONSE_INVALID', 'VCP_MEMORY_PACKAGE_MISSING', 'VCP_MEMORY_ERROR']);
      if (operational.has(failure)) {
        await expect(result).rejects.toBeInstanceOf(CompanionOptionalDreamError);
        await expect(result).rejects.toMatchObject({ code: failure === 'runtime' ? 'runtime_unavailable' : 'wave_operation_failed' });
      } else {
        await expect(result).rejects.not.toBeInstanceOf(CompanionOptionalDreamError);
        await expect(result).rejects.toThrow(/来源|授权|取消|归属|时间凭证|Native/u);
      }
      expect(native).toHaveBeenCalledTimes(failure === 'runtime' ? 0 : 1);
      if (failure === 'runtime') expect(get).toHaveBeenCalledOnce();
    } finally { await memory.close(); }
  });

  it('polls processing, life plan and unified overview without advancing the world, opening chats or loading a model', async () => {
    const f = fixture();
    await f.service.handle({ type: 'memory.processing.status', companionId: 'sister', limit: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const db = new (Database as { new(file: string): CompanionConnection })(f.databasePath);
    const capture = () => ({ world: db.prepare('SELECT data FROM companion_world WHERE id=1').get(),
      conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get(), jobs: db.prepare('SELECT COUNT(*) AS n FROM companion_world_jobs').get(),
      admissions: db.prepare('SELECT COUNT(*) AS n FROM companion_memory_maintenance_sessions').get(), version: db.prepare('PRAGMA data_version').get() });
    try {
      const before = capture();
      transport.request.mockClear();
      for (const fn of [transport.fetch, transport.memoryFetch, transport.worldFetch, transport.prohibitionFetch, transport.progressFetch]) fn.mockClear();
      const base = Date.now();
      for (const lag of [500, 4_900, 3_600_000]) {
        vi.setSystemTime(base + lag);
        for (let pass = 0; pass < 3; pass++) {
          const [processing, life, overview] = await Promise.all([
            f.service.handle({ type: 'memory.processing.status', companionId: 'sister', limit: 5 }),
            f.service.handle({ type: 'memory.life-plan.status', companionId: 'sister' }),
            f.service.handle({ type: 'life.overview.status', companionId: 'sister', filter: 'all', limit: 20 }),
          ]);
          expect(processing.memoryProcessing?.companionId).toBe('sister'); expect(life.memoryLifePlan?.companionId).toBe('sister');
          // Civil time follows the wall clock; the persisted observation cursor
          // remains unchanged, including when the background world is behind.
          expect(overview.lifeOverview?.clock.virtualNow).toBe(new Date(base + lag).toISOString());
          expect(overview.lifeOverview?.clock.backlog, `persisted observation lag ${lag}ms`).toBe(lag > 5_000);
          expect(processing.memoryProcessing?.schedule?.schedulers.some(item => item.waitingReason === 'world_backlog'), `memory maintenance remains independent of observation lag ${lag}ms`).toBe(false);
        }
      }
      expect(capture()).toEqual(before);
      const commands = transport.request.mock.calls.map(([command]) => command.type);
      const observations = transport.request.mock.calls.map(([command]) => command).filter(command => command.type === 'state');
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every(command => command.includeConversations === false), 'management projections must not load the full conversation list').toBe(true);
      for (const mutation of ['world.clock', 'world.tick', 'world.job.claim', 'conversation.open']) expect(commands).not.toContain(mutation);
      for (const fn of [transport.fetch, transport.memoryFetch, transport.worldFetch, transport.prohibitionFetch, transport.progressFetch]) expect(fn).not.toHaveBeenCalled();
      expect(clients.get(f.root)?.replace).not.toHaveBeenCalled(); expect(clients.get(f.root)?.remember).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('closes once after a pending storage start without reviving initialization or recovery jobs', async () => {
    let ready!: () => void;
    transport.start.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    const f = fixture(), first = f.service.shutdown(), second = f.service.shutdown();
    f.service.configurationChanged();
    expect(first).toBe(second); expect(transport.close).not.toHaveBeenCalled();
    ready(); await vi.advanceTimersByTimeAsync(1000); await first; services.delete(f.service);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls.map(([command]) => command.type)).toEqual(['actions', 'action.interrupt-pending']);
    await expect(f.service.handle({ type: 'state' })).rejects.toThrow('关闭');
  });
  it('captures an experience journal without primary-model tools and retains actual user/reply sources', async () => {
    const f = fixture();
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const data = payload(init), user = data.messages.find(message => message.authorId === 'user' && message.content === '我一直喜欢茶。');
      const reply = data.messages.find(message => message.authorId === 'sister');
      const note = user ? journal(user) : undefined;
      if (note && reply) { note.sourceMessageIds.push(reply.id); note.evidence.push({ sourceMessageId: reply.id, quote: reply.content }); }
      return structuredResponse({ notes: note ? [note] : [] });
    });
    transport.progressFetch.mockImplementationOnce(async () => {
      const current = f.store.request({ type: 'messages', conversationId: f.conversation.id }).messages ?? [];
      expect(current.filter(message => message.authorId === 'sister' && message.kind === 'text' && message.status === 'sent'
        && !message.isReplyDraft && !message.replyDraft)).toHaveLength(0);
      return structuredResponse({ supported: true, correction: '' });
    });
    const source = await sent(f.service, f.store, f.conversation.id, '我一直喜欢茶。', 'normal-preference');
    expect(transport.progressFetch).toHaveBeenCalled();
    expect(payload(transport.progressFetch.mock.calls[0]![1])).toMatchObject({ purpose: 'companion_social_progress_review', proposedText: '好，慢慢聊。' });
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    await background();
    expect(transport.memoryFetch).not.toHaveBeenCalled();
    await background(60_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    const note = active(f.store, f.conversation.id)[0]!;
    expect(note).toMatchObject({ content: '用户喜欢茶。', tags: ['饮料偏好'], sourceMessageId: source.id, status: 'indexed', captureMethod: 'automatic' });
    const read = f.store.request({ type: 'memory.read', companionId: 'sister', conversationId: f.conversation.id, id: note.id }).memoryRead!;
    expect(read.sources.some(message => message.id === source.id && message.content === source.content)).toBe(true);
    expect(read.sources.some(message => message.authorId === 'sister' && message.content === '好，慢慢聊。')).toBe(true);
    expect(clients.get(f.root)!.remember).toHaveBeenCalledWith(expect.objectContaining({ scopeId: note.scopeId }), expect.objectContaining({ id: note.id, content: note.content, author: '大肥鱼',
      metadata: expect.objectContaining({ hostMemoryOwner: { version: 2, companionId: 'sister', name: '大肥鱼', agentName: '大肥鱼' } }) }));
    expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.turns.every(turn => turn.calls.length === 0)).toBe(true);
    await background(31_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(status(f.store).captureWatermark).toBe(status(f.store).messageWatermark);
    expect(transport.memoryFetch.mock.calls.every(([, init]) => payload(init).purpose === 'vcp_experience_journal')).toBe(true);
  });

  it('retries network failure and invalid evidence before advancing capture and indexing watermarks', async () => {
    const f = fixture(); let attempts = 0;
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const source = payload(init).messages.find(message => message.content === '我一直喜欢茶。');
      attempts++;
      if (attempts === 1) throw new Error('private provider network data: private-test-key');
      return structuredResponse({ notes: source ? [{ ...journal(source), ...(attempts === 2 ? { evidence: [{ sourceMessageId: source.id, quote: '这句原文并不存在' }] } : {}) }] : [] });
    });
    const source = await sent(f.service, f.store, f.conversation.id, '我一直喜欢茶。', 'retry-preference');
    await background(62_100);
    expect(status(f.store).failed).toBeGreaterThan(0);
    expect(status(f.store).captureWatermark).toBeLessThan(source.sequence);
    expect(status(f.store).lastError).not.toContain('private-test-key');
    await background(31_000);
    expect(status(f.store).failed).toBeGreaterThan(0);
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(status(f.store).captureWatermark).toBeLessThan(source.sequence);
    await background(31_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(status(f.store).failed).toBe(0);
    expect(status(f.store).captureWatermark).toBe(status(f.store).messageWatermark);
  });

  it('keeps an accepted journal queued until VCP acknowledges indexing and retries failed delivery', async () => {
    const f = fixture(), client = clients.get(f.root)!;
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const source = payload(init).messages.find(message => message.content === '记住周六带伞。');
      return structuredResponse({ notes: source ? [journal(source, '约好周六带伞。', ['周六', '雨伞'])] : [] });
    });
    client.remember.mockRejectedValueOnce(new Error('Local encoder temporarily unavailable.'));
    await sent(f.service, f.store, f.conversation.id, '记住周六带伞。', 'pending-embedding');
    await background(62_100);
    expect(active(f.store, f.conversation.id)[0]?.status).toBe('queued');
    expect(status(f.store).pendingIndex).toBe(1);
    expect(f.store.request({ type: 'memory.snapshot', companionId: 'sister', conversationId: f.conversation.id }).memorySnapshot?.notes).toHaveLength(0);
    await background(35_000);
    expect(active(f.store, f.conversation.id)[0]?.status).toBe('indexed');
    expect(client.remember).toHaveBeenCalledTimes(2);
    expect(f.store.request({ type: 'memory.snapshot', companionId: 'sister', conversationId: f.conversation.id }).memorySnapshot?.notes).toHaveLength(1);
  });

  it('delegates recall of an old journal to VCP after the source leaves recent chat context', async () => {
    const f = fixture();
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const source = payload(init).messages.find(message => message.content === '我的生日是4月9日。');
      return structuredResponse({ notes: source ? [journal(source, '用户的生日是4月9日。', ['生日'])] : [] });
    });
    const birthday = await sent(f.service, f.store, f.conversation.id, '我的生日是4月9日。', 'old-birthday');
    await background(62_100);
    expect(active(f.store, f.conversation.id)).toEqual(expect.arrayContaining([expect.objectContaining({ content: '用户的生日是4月9日。', status: 'indexed' })]));
    for (let i = 0; i < COMPANION_DIALOGUE_WINDOW.maxMessages + 20; i++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: `无关的天气闲聊第${i}次`, replyDirective: 'none' });
    let brainPayload: Payload | undefined;
    transport.fetch.mockImplementation(async (_input, init) => {
      brainPayload = payload(init);
      return textResponse(brainPayload.memoryRecall?.context?.text.includes('4月9日') ? '是4月9日。' : '不知道。');
    });
    await sent(f.service, f.store, f.conversation.id, '你知道我出生的那天是哪一日吗？', 'new-birthday-question');
    expect(brainPayload?.messages.some(message => message.id === birthday.id)).toBe(false);
    expect(brainPayload?.memories).toEqual([]);
    expect(brainPayload?.memoryRecall?.context?.text).toContain('4月9日');
    expect(clients.get(f.root)!.search).not.toHaveBeenCalled();
    expect(clients.get(f.root)!.preprocess).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: expect.stringContaining(`[[${vcpMemoryNotebookFolder('经历')}日记本::RiverMemo::TimeDecay180/0::AIMemo+]]`) }),
    ]), expect.objectContaining({ now: expect.any(String), timeZone: expect.any(String) }), expect.objectContaining({ schema: 'episodic-v1', halfLifeDays: 180, minScore: 0 }));
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.at(-1)?.content).toBe('是4月9日。');
  });

  it('executes native record/search/read/organize/revise/forget tools with stable journal IDs and VCP receipts', async () => {
    const f = fixture(); let savedId = '', version = 1; const steps = new Map<string, number>();
    const results: Array<{ id: string; value: CompanionStorageResponse }> = [];
    const collect = (sourceId: string) => {
      const checkpoint = f.store.request({ type: 'loop.get', companionId: 'sister', sourceMessageId: sourceId }).loop!;
      results.push(...checkpoint.turns.flatMap(turn => (turn.results ?? []).map(result => ({ id: result.callId, value: JSON.parse(result.content) as CompanionStorageResponse }))));
    };
    transport.fetch.mockImplementation(async (_input, init) => {
      const data = payload(init), source = { id: data.taskRequest!.sourceMessageId, content: data.taskRequest!.prompt };
      const step = steps.get(source.id) ?? 0; steps.set(source.id, step + 1);
      const latest = body(init).messages.at(-1)!;
      if (latest.role === 'tool') {
        const result = JSON.parse(latest.content) as CompanionStorageResponse;
        const saved = result.memories?.[0] ?? result.memoryRead?.memory ?? result.memoryPage?.items[0]?.memory;
        if (saved) { savedId = saved.id; version = saved.version; }
      }
      if (source.content === '我一直喜欢茶。' && step === 0) return memoryResponse('record_1', 'record', { candidate: journal(source) });
      if (source.content === '回忆并整理饮料日记。') {
        if (step === 0) return memoryResponse('search_1', 'search', { query: '饮料偏好' });
        if (step === 1) return memoryResponse('read_1', 'read', { id: savedId });
        if (step === 2) return memoryResponse('organize_1', 'organize', { ids: [savedId], tags: ['饮料偏好', '茶'] });
      }
      if (source.content === '更正，现在喜欢水。' && step === 0) return memoryResponse('revise_1', 'revise', { id: savedId, expectedVersion: version, candidate: journal(source, '用户现在喜欢水。', ['饮料偏好', '水']) });
      if (source.content.includes('忘掉') && step === 0) return memoryResponse('forget_1', 'forget', { tag: '饮料偏好', persistent: true, requestMessageId: source.id });
      return textResponse('处理好了。');
    });
    const recordSource = await sent(f.service, f.store, f.conversation.id, '我一直喜欢茶。', 'native-record'); collect(recordSource.id);
    expect(active(f.store, f.conversation.id)[0]).toMatchObject({ status: 'queued', version: 1 });
    await background();
    const organizeSource = await sent(f.service, f.store, f.conversation.id, '回忆并整理饮料日记。', 'native-organize'); collect(organizeSource.id);
    expect(active(f.store, f.conversation.id)[0]).toMatchObject({ content: '用户喜欢茶。', tags: ['饮料偏好', '茶'], version: 2 });
    expect(results.map(result => result.id)).toEqual(['record_1', 'search_1', 'read_1', 'organize_1']);
    expect(clients.get(f.root)!.pluginCall).toHaveBeenCalledWith(expect.anything(), 'LightMemo', expect.objectContaining({ folder: vcpMemoryNotebookFolder('经历'), query: '饮料偏好', enginemode: 'rivermemo' }));
    expect(results.find(result => result.id === 'read_1')?.value.memoryRead?.sources.some(source => source.content === '我一直喜欢茶。')).toBe(true);
    const originalId = savedId;
    version = active(f.store, f.conversation.id)[0]!.version;
    const reviseSource = await sent(f.service, f.store, f.conversation.id, '更正，现在喜欢水。', 'native-revise'); collect(reviseSource.id);
    expect(active(f.store, f.conversation.id)[0]).toMatchObject({ id: originalId, content: '用户现在喜欢水。', version: 3 });
    expect(results.find(result => result.id === 'revise_1')?.value.ok).toBe(true);
    await sent(f.service, f.store, f.conversation.id, '请忘掉我的饮料偏好，以后不要再记录。', 'native-forget');
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(status(f.store).forgotten).toBe(1);
    await background(31_000);
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(clients.get(f.root)!.forget).toHaveBeenCalledWith(expect.anything(), originalId);
    const newSource = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '再说一次，我喜欢茶。', replyDirective: 'none' });
    expect(() => f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id, candidate: journal(newSource) })).toThrow();
    expect(transport.prohibitionFetch).not.toHaveBeenCalled();
  });

  it('binds native record to observed inference reads instead of a guessed ID or the passive physical corpus', async () => {
    const f = fixture(), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const raw = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '验收方法应先检查真实产物。', replyDirective: 'none' });
    const note = f.store.request({ type: 'memory.record', ...scope, candidate: journal(raw, raw.content) }).memories![0]!;
    const source = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '这次核对方法以后再形成一条记录。', replyDirective: 'none' });
    const inference: Pick<CompanionLoopCheckpoint, 'context' | 'turns'> = { turns: [], context: { system: '', user: JSON.stringify({ conversation: { id: scope.conversationId },
      memoryRecall: { context: { text: '', revision: 'physical-corpus', profileKey: 'fixture', evidence: { dependencyCoverage: 'complete', snapshotPolicy: 'task_passive_v1',
        dependencies: [{ id: note.id, version: note.version }], frozenDependencies: [{ id: note.id, contentRevision: note.contentRevision,
          sources: note.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId, checksum: reference.checksum })) }], references: [], referenceCoverage: 'observed' } } } }) } };
    const execute = (f.service as unknown as { executeMemoryTool(name: 'memory.record', serialized: string, scope: { companionId: string; conversationId: string; beforeSequence: number }, ids: string[], signal: undefined,
      operationId: string, inference: Pick<CompanionLoopCheckpoint, 'context' | 'turns'>): Promise<CompanionStorageResponse> }).executeMemoryTool.bind(f.service);
    const candidate = { ...journal(source, source.content), relatedMemoryIds: [note.id] };
    expect(await execute('memory.record', JSON.stringify({ candidate }), { ...scope, beforeSequence: source.sequence }, [source.id], undefined, 'unread-native', inference))
      .toMatchObject({ ok: false, error: expect.stringContaining('实际推理') });
    expect(await execute('memory.record', JSON.stringify({ candidate, readMemories: [{ id: note.id, version: note.version }] }), { ...scope, beforeSequence: source.sequence }, [source.id], undefined, 'forged-native', inference))
      .toMatchObject({ ok: false });
    const read = await hostMemory(f.service, { type: 'memory.read', ...scope, id: note.id });
    inference.turns.push({ text: '', rawText: '', calls: [{ id: 'actual-read', name: 'memory', arguments: JSON.stringify({ action: 'read', id: note.id }) }],
      results: [{ callId: 'actual-read', content: JSON.stringify(read) }] });
    const annotated = f.store.request({ type: 'memory.organize', ...scope, ids: [note.id], tags: ['核对真实产物'] }).memories![0]!;
    expect(await execute('memory.record', JSON.stringify({ candidate }), { ...scope, beforeSequence: source.sequence }, [source.id], undefined, 'read-native', inference))
      .toMatchObject({ ok: true, memories: [expect.objectContaining({ content: source.content })] });
    f.store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: annotated.version, candidate: journal(raw, '正文后来采用了新的核对方法。') });
    expect(await execute('memory.record', JSON.stringify({ candidate }), { ...scope, beforeSequence: source.sequence }, [source.id], undefined, 'changed-native', inference))
      .toMatchObject({ ok: false, error: expect.stringContaining('正文已变化') });
  });

  it.each([false, true])('keeps a real tool-read body across one hundred tags and trusted practice annotation, while source withdrawal=%s still wins', async withdraw => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const raw = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '候选方法：先保存结果文件，再实际读取，确认包含ACTUAL_VALIDATED_RESULT才算交付。', replyDirective: 'none' });
    const proposal = { applicability: '当前受管测试目录的文本交付', steps: ['写入结果文件。', '读取并核对实际正文。'], limitations: ['只适用于当前客观合同。'],
      verification: { kind: 'artifact_delivery' as const, artifactRequirements: [{ path: 'verified.txt', containsText: 'ACTUAL_VALIDATED_RESULT' }] } };
    const original = (await hostMemory(f.service, { type: 'memory.record', ...scope, candidate: { ...journal(raw, raw.content, ['方法候选']), procedure: proposal, metadata: { autoTags: false } } })).memories![0]!;
    markIndexed(f.store); let steps = 0, actualRead: CompanionStorageResponse | undefined, resumedToolBodies: string[] = [], withdrawFailure: unknown;
    const providerFailures: string[] = [];
    transport.fetch.mockImplementation(async (_url, init) => {
      try {
      const data = payload(init), source = f.store.getMessage(data.taskRequest!.sourceMessageId), step = steps++;
      if (step === 0) return memoryResponse('fixed_method_read', 'read', { id: original.id });
      if (step === 1) {
        actualRead = JSON.parse(body(init).messages.find(message => message.tool_call_id === 'fixed_method_read')!.content) as CompanionStorageResponse;
        expect(actualRead.memoryRead?.fileReceipts).toHaveLength(1);
        const proof = captureCompanionExecutionReadset({ ...scope, beforeSequence: source.sequence }, { turns: [{ text: '', rawText: '',
          calls: [{ id: 'fixed_method_read', name: 'memory', arguments: JSON.stringify({ action: 'read', id: original.id }) }],
          results: [{ callId: 'fixed_method_read', content: JSON.stringify(actualRead) }] }] });
        expect(proof.memoryReads).toContainEqual(expect.objectContaining({ id: original.id, version: original.version, contentRevision: original.contentRevision }));
        for (let index = 0; index < 100; index++) await hostMemory(f.service, { type: 'memory.organize', ...scope, ids: [original.id], tags: ['方法候选', '人工标签' + index] });
        const action = f.store.request({ type: 'action.create', action: { ...scope, sourceMessageId: source.id, title: '受管方法实际产物验证', status: 'queued' },
          checkpoint: { prompt: source.content, executionReadset: proof, dshTask: { delivery: { format: 'text', artifacts: proposal.verification.artifactRequirements } } } }).action!;
        f.store.request({ type: 'tasks.capacity.claim-action', id: action.id });
        const taskId = action.id, at = new Date().toISOString(), artifact = path.join(f.root, 'verified.txt');
        writeFileSync(artifact, 'ACTUAL_VALIDATED_RESULT');
        const result: DshTaskResult = { taskId, instanceId: 'controlled-instance', runtimeId: 'controlled-runtime', runtimeVersion: 'test', code: 0,
          text: '实际读取受管产物完成当前合同。', artifacts: [{ path: artifact }] };
        await verifyDshDelivery(result, { format: 'text', artifacts: proposal.verification.artifactRequirements }, f.root);
        f.store.request({ type: 'checkpoint.execution', id: action.id, execution: { id: taskId, operationId: taskId, instanceId: 'controlled-instance', runtimeId: 'controlled-runtime',
          runtimeVersion: 'test', title: action.title, status: 'succeeded', code: 0, startedAt: at, finishedAt: at, taskWorkspaceRoot: f.root } });
        f.store.request({ type: 'action.update', id: action.id, patch: { taskId, status: 'succeeded', result: result.text,
          executionSummary: { recordId: action.id, title: action.title, status: 'succeeded', createdAt: at, executionStartedAt: at, finishedAt: at, durationMs: 1,
            turns: 1, steps: 1, toolCalls: 1, recordCount: 1, storedBytes: 100, finalReply: result.text!, finalReplyChars: result.text!.length,
            finalReplyTruncated: false, complete: true, storageLimited: false, artifacts: result.artifacts, verification: result.verification } } });
        await hostMemory(f.service, { type: 'memory.procedure.observe-action', actionId: action.id });
        expect(f.store.request({ type: 'memory.read', ...scope, id: original.id }).memoryRead?.memory).toMatchObject({ contentRevision: original.contentRevision,
          procedure: { validation: { state: 'validated' } } });
        if (withdraw) {
          try { await hostMemory(f.service, { type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] }); }
          catch (error) { withdrawFailure = error instanceof Error ? error.stack : String(error); }
          return textResponse('已撤回的旧方法仍然可用。');
        }
        return memoryResponse('after_annotation_catalog', 'retrieval_modes', {});
      }
      const tools = body(init).messages.filter(message => message.role === 'tool');
      if (withdraw) {
        resumedToolBodies = tools.map(message => message.content);
        return textResponse('这份方法的来源已经撤回，不能沿用旧正文。');
      }
      const saved = tools.find(message => message.tool_call_id === 'fixed_method_read');
      expect(saved).toBeDefined(); expect(JSON.parse(saved!.content).memoryRead.memory.content).toBe(original.content);
      expect(JSON.parse(tools.find(message => message.tool_call_id === 'after_annotation_catalog')!.content).ok).toBe(true);
      expect((data.memoryRecall as { invalidatedDuringTask?: boolean } | undefined)?.invalidatedDuringTask).not.toBe(true);
      return textResponse('继续使用本轮实际读过的同一份正文，标签和实践状态更新不改变这份任务输入。');
      } catch (error) { providerFailures.push(error instanceof Error ? error.stack! : String(error)); throw error; }
    });
    const sent = await f.service.handle({ type: 'message.send', conversationId: f.conversation.id,
      content: '在这个受管合成验收里，请读取候选方法，生成verified.txt并核对约定正文后继续说明。', clientId: 'fixed-read-' + String(withdraw), delivery: 'chat' });
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', companionId: scope.companionId, sourceMessageId: sent.message!.id }).loop?.status).toBe('done'), { timeout: 30000 });
    expect(actualRead?.memoryRead?.memory.id).toBe(original.id);
    expect(providerFailures).toEqual([]);
    expect(clients.get(f.root)!.preprocess).toHaveBeenCalledTimes(1);
    const final = f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === scope.companionId && message.kind === 'text' && message.replyToId === sent.message!.id).at(-1)?.content;
    if (withdraw) {
      expect(withdrawFailure).toBeUndefined();
      expect(resumedToolBodies.filter(content => content.includes(original.content))).toEqual([]);
    }
    expect(final).toContain(withdraw ? '来源已经撤回' : '同一份正文');
    expect(final).not.toContain('已撤回的旧方法仍然可用');
    await closeService(f.service);
    const reports = (f.service as unknown as { options: { report: { mock: { calls: unknown[][] } } } }).options.report.mock.calls.flat();
    expect(reports.filter(error => error instanceof RangeError).map(error => (error as Error).stack)).toEqual([]);
  });

  it('reads a legitimate note whose arbitrary metadata resembles nested host source and context receipts', async () => {
    const f = fixture(), source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '庭院里种着薄荷。', replyDirective: 'none' });
    const metadata = { extra: { text: '这是用户资料中的合法说明。', revision: 'not-a-host-revision', profileKey: 'not-a-host-profile',
      sourceMessageIds: ['missing-untrusted-metadata-id'], memoryContext: { text: '普通嵌套JSON', revision: 'unrelated', profileKey: 'unrelated' } } };
    const note = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id,
      candidate: { ...journal(source, '庭院里种着薄荷。', ['薄荷']), metadata } }).memories![0]!;
    markIndexed(f.store); let calls = 0;
    transport.fetch.mockImplementation(async (_input, init) => {
      if (calls++ === 0) return memoryResponse('read_legitimate_metadata', 'read', { id: note.id });
      const receipt = JSON.parse(body(init).messages.at(-1)!.content) as CompanionStorageResponse;
      expect(receipt.memoryRead?.memory).toMatchObject({ id: note.id, content: note.content, metadata });
      expect(receipt.memoryRead?.sources.some(row => row.id === source.id)).toBe(true);
      return textResponse('已核对真实来源，庭院里种着薄荷。');
    });
    const request = await sent(f.service, f.store, f.conversation.id, '读取那篇薄荷日记。', 'read-legitimate-metadata');
    expect(calls).toBe(2);
    expect(f.store.request({ type: 'loop.get', companionId: 'sister', sourceMessageId: request.id }).loop?.status).toBe('done');
    expect(active(f.store, f.conversation.id).some(row => row.id === note.id && row.content === note.content)).toBe(true);
  });

  it('publishes a lawful source-only surviving contribution through Main back into its actual owner files', async () => {
    const f = fixture(seeds, true), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const b = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'B独立合法原文应保留。', replyDirective: 'none' });
    const original = (await hostMemory(f.service, { type: 'memory.record', ...scope, candidate: { ...journal(b, b.content), metadata: { autoTags: false } } })).memories![0]!;
    const a = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'A后来增加但需要撤回。', replyDirective: 'none' });
    await hostMemory(f.service, { type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version,
      candidate: { content: b.content + a.content, sourceMessageIds: [a.id, b.id], evidence: [a, b].map(message => ({ sourceMessageId: message.id, quote: message.content })), metadata: { autoTags: false } } });
    await hostMemory(f.service, { type: 'memory.forget', ...scope, sourceMessageIds: [a.id] });
    const job = (await hostMemory(f.service, { type: 'memory.jobs.claim', companionId: scope.companionId, force: true })).memoryJob!;
    expect(job.sourceMessageIds).toEqual([b.id]);
    const saved = (await hostMemory(f.service, { type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken,
      notes: [{ ...journal(b, b.content), metadata: { autoTags: false } }] })).memories![0]!;
    expect(saved.id).toBe(original.id);
    const actual = (await hostMemory(f.service, { type: 'memory.read', ...scope, id: saved.id })).memoryRead!;
    expect(actual.memory.content).toBe(b.content); expect(actual.sources.map(source => source.content)).toEqual([b.content]);
    expect(actual.fileReceipts).toHaveLength(1);
    expect(readFileSync(path.join(f.root, 'assets', '伙伴记忆', 'sister', actual.fileReceipts![0]!.path), 'utf8')).toBe(b.content);
    expect((await hostMemory(f.service, { type: 'memory.revision.read', ...scope, id: original.id, contentRevision: original.contentRevision! })).memories![0]!.content).toBe(b.content);
    await hostMemory(f.service, { type: 'memory.forget', ...scope, id: original.id });
    await expect(hostMemory(f.service, { type: 'memory.read', ...scope, id: original.id })).rejects.toThrow();
    await expect(hostMemory(f.service, { type: 'memory.revision.read', ...scope, id: original.id, contentRevision: original.contentRevision! })).rejects.toThrow();
  });

  it.each(['record', 'revise', 'save'] as const)('checks a changed-word residence proposal at the unified %s entrance', async action => {
    const f = fixture(), secret = 'FORGOTTEN_RESIDENCE_8734';
    f.store.saveMemory({ companionId: 'sister', conversationId: f.conversation.id, content: secret, tags: ['家庭住址'] });
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, tag: '家庭住址', persistent: true });
    const safe = f.store.saveMemory({ companionId: 'sister', conversationId: f.conversation.id, content: '周六为花园浇水。', tags: ['花园'] });
    const rules = f.store.request({ type: 'memory.prohibitions', companionId: 'sister', conversationId: f.conversation.id }).memoryProhibitions!;
    const proposed = '用户已经搬到枫树街二十三号居住。';
    transport.prohibitionFetch.mockImplementation(async () => structuredResponse({ allowed: false, matchedPolicyIds: [rules[0]!.id] }));
    if (action === 'save') {
      await expect(f.service.handle({ type: 'memory.save', companionId: 'sister', conversationId: f.conversation.id, content: proposed })).rejects.toThrow('不再记录');
    } else {
      let step = 0;
      transport.fetch.mockImplementation(async (_input, init) => {
        if (step++ === 0) return memoryResponse('blocked_diary', action, {
          ...(action === 'revise' ? { id: safe.id, expectedVersion: safe.version } : {}),
          candidate: journal({ id: payload(init).taskRequest!.sourceMessageId, content: proposed }, proposed, ['新居']),
        });
        expect(JSON.parse(body(init).messages.at(-1)!.content)).toMatchObject({ ok: false, error: expect.stringContaining('不再记录') });
        return textResponse('这项信息尚未保存。');
      });
      await sent(f.service, f.store, f.conversation.id, proposed, `prohibition-${action}`);
      expect(step).toBe(2);
    }
    expect(transport.prohibitionFetch).toHaveBeenCalledTimes(1);
    const validation = String(transport.prohibitionFetch.mock.calls[0]?.[1]?.body);
    expect(validation).toContain(proposed); expect(validation).toContain('家庭住址'); expect(validation).not.toContain(secret);
    expect(active(f.store, f.conversation.id)).toEqual([expect.objectContaining({ id: safe.id, content: safe.content, version: safe.version })]);
  });

  it('keeps a manual diary uncommitted when semantic prohibition validation fails', async () => {
    const f = fixture();
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, tag: '家庭住址', persistent: true });
    transport.prohibitionFetch.mockRejectedValueOnce(new Error('Policy provider unavailable'));
    await expect(f.service.handle({ type: 'memory.save', companionId: 'sister', conversationId: f.conversation.id,
      content: '用户已搬到枫树街二十三号。' })).rejects.toThrow();
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(transport.request.mock.calls.filter(([command]) => command.type === 'memory.save')).toHaveLength(0);
  });

  it('atomically refuses a new prohibition installed after an empty preflight read', async () => {
    const f = fixture(); let installed = false;
    transport.request.mockImplementation(async command => {
      const response = f.store.request(command);
      if (command.type === 'memory.prohibitions' && !installed) {
        installed = true;
        f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, tag: '饮食偏好', persistent: true });
      }
      return response;
    });
    await expect(f.service.handle({ type: 'memory.save', companionId: 'sister', conversationId: f.conversation.id,
      content: '用户最喜欢香煎蛋。' })).rejects.toThrow('禁记规则已变化');
    expect(transport.prohibitionFetch).not.toHaveBeenCalled();
    expect(active(f.store, f.conversation.id)).toHaveLength(0);
    expect(transport.request.mock.calls.find(([command]) => command.type === 'memory.save')?.[0]).toMatchObject({
      memory: { expectedProhibitionRevision: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
  });

  it('uses the actual group source policy when a private tool records witnessed group material', async () => {
    const f = fixture([...seeds, { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false }]);
    const group = f.store.createConversation('讨论', ['sister', 'flash']);
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: group.id, tag: '家庭住址', persistent: true });
    const source = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: '我现在住枫树街二十三号。', replyDirective: 'none' });
    const rules = f.store.request({ type: 'memory.prohibitions', companionId: 'sister', conversationId: group.id }).memoryProhibitions!;
    transport.prohibitionFetch.mockImplementation(async () => structuredResponse({ allowed: false, matchedPolicyIds: [rules[0]!.id] }));
    let step = 0;
    transport.fetch.mockImplementation(async (_input, init) => {
      if (step++ === 0) return memoryResponse('group_diary', 'record', { candidate: journal(source, source.content, ['新居']) });
      expect(JSON.parse(body(init).messages.at(-1)!.content)).toMatchObject({ ok: false, error: expect.stringContaining('不再记录') });
      return textResponse('尚未保存。');
    });
    await sent(f.service, f.store, f.conversation.id, '把我刚才在群里说的内容记下。', 'group-source-policy');
    expect(transport.prohibitionFetch).toHaveBeenCalledTimes(1);
    expect(active(f.store, group.id)).toHaveLength(0);
  });

  it('refuses a model-proposed forget when the current user message contains no forgetting request', async () => {
    const f = fixture(), old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '我一直喜欢茶。', replyDirective: 'none' });
    f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id, candidate: journal(old) }); markIndexed(f.store);
    let attempted = false, result: CompanionStorageResponse | undefined;
    transport.fetch.mockImplementation(async (_input, init) => {
      const sourceId = payload(init).taskRequest!.sourceMessageId;
      if (!attempted) { attempted = true; return memoryResponse('unauthorized_forget', 'forget', { tag: '饮料偏好', requestMessageId: sourceId }); }
      result = JSON.parse(body(init).messages.at(-1)!.content) as CompanionStorageResponse;
      return textResponse('今天慢慢聊。');
    });
    await sent(f.service, f.store, f.conversation.id, '今天慢慢聊聊吧。', 'ordinary-user-message');
    expect(result?.ok).toBe(false);
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(status(f.store).forgotten).toBe(0);
  });

  it.each(['memory', 'world'])('keeps a new host world-query receipt visible through the %s entrance without admitting later chat', async entrance => {
    const f = fixture([...seeds, { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false }]);
    const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'sister', memberIds: ['sister', 'flash'] }).socialConversation!;
    f.store.request({ type: 'social.message.append', conversationId: peer.id, authorId: 'sister', content: '很高兴认识你。',
      virtualCreatedAt: fixedTime, clientId: 'known-peer-' + entrance });
    let step = 0, receiptId: string | undefined;
    transport.fetch.mockImplementation(async (_input, init) => {
      if (step++ === 0) {
        f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: 'LATER_CHAT_MUST_STAY_OUT', replyDirective: 'none' });
        return toolResponse('discover_sister', entrance, { action: entrance === 'memory' ? 'world_query' : 'query', category: 'contacts', query: '小肥鱼' });
      }
      expect(step).toBe(2);
      const latest = body(init).messages.at(-1)!;
      expect(latest).toMatchObject({ role: 'tool', tool_call_id: 'discover_sister' });
      const result = JSON.parse(latest.content) as CompanionStorageResponse;
      expect(result.worldKnowledge?.items).toContainEqual(expect.objectContaining({ id: 'flash', name: '小肥鱼' }));
      receiptId = result.worldKnowledge?.evidenceMessageId;
      expect(receiptId).toBeTruthy();
      expect(String(init?.body)).not.toContain('LATER_CHAT_MUST_STAY_OUT');
      return textResponse('已经查到妹妹的真实联络标识，不必重复查询。');
    });
    const source = await sent(f.service, f.store, f.conversation.id, '看看妹妹的联络信息。', 'world-query-receipt-' + entrance);
    expect(step).toBe(2);
    const receipt = f.store.getMessage(receiptId!);
    expect(receipt.sequence).toBeGreaterThan(source.sequence);
    const checkpoint = f.store.request({ type: 'loop.get', companionId: 'sister', sourceMessageId: source.id }).loop!;
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBeUndefined();
  });

  it('retains an actual sent-message receipt newer than the dialogue cursor and still revokes its forgotten source', async () => {
    const f = fixture([...seeds, { id: 'flash', name: '小肥鱼', description: '朋友', persona: '活泼', model: '', avatar: 'flash', proactive: false }]);
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '邀请朋友一起玩。', replyDirective: 'none' });
    const room = f.store.request({ type: 'social.conversation.ensure', companionId: 'sister', memberIds: ['sister', 'flash'] }).socialConversation!;
    const sent = f.store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'sister', content: '想一起玩吗？',
      clientId: 'fresh-receipt', virtualCreatedAt: fixedTime }).socialMessage!;
    expect(sent.message.sequence).toBeGreaterThan(source.sequence);
    const companion = f.store.state().companions.find(role => role.id === 'sister')!;
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: source.id,
      status: 'running', supplements: [], context: buildCompanionContext({ companion, conversation: f.conversation,
        messages: [source], sourceMessage: source, memories: [], agentLoop: true, taskRequest: { sourceMessageId: source.id, prompt: source.content } }),
      turns: [{ text: '我已发出邀请。', rawText: '我已发出邀请。', calls: [{ id: 'invite', name: 'world',
        arguments: JSON.stringify({ action: 'message', recipientIds: ['flash'], text: sent.message.content }) }],
        results: [{ callId: 'invite', content: JSON.stringify({ ok: true, socialMessage: sent }) }] }] };
    const inference = (f.service as unknown as { memoryInference(checkpoint: CompanionLoopCheckpoint, id: string, room: string, sequence: number): Promise<{ turns: CompanionLoopCheckpoint['turns'] }> });
    const current = await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence);
    expect(current.turns[0]?.results?.[0]?.content).toContain(sent.message.id);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBeUndefined();
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: room.id, sourceMessageIds: [sent.message.id] });
    const withdrawn = await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence);
    expect(JSON.stringify(withdrawn.turns)).not.toContain(sent.message.content);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBe(1);
  });

  it('keeps new authorized search and read results after forgetting cuts off the contaminated provider history', async () => {
    const f = fixture(), secret = 'WITHDRAWN_SECRET_9127';
    const oldSource = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: `旧秘密是${secret}`, replyDirective: 'none' });
    const old = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id,
      candidate: journal(oldSource, `旧秘密是${secret}`, ['旧秘密']) }).memories![0]!;
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '花园计划是周六给玫瑰浇水。', replyDirective: 'none' });
    const safe = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id,
      candidate: journal(source, source.content, ['花园计划']) }).memories![0]!;
    markIndexed(f.store);
    let step = 0;
    transport.fetch.mockImplementation(async (_input, init) => {
      const current = payload(init), latest = body(init).messages.at(-1)!;
      if (step++ === 0) return memoryResponse('withdraw_old_secret', 'forget', { id: old.id, requestMessageId: current.taskRequest!.sourceMessageId });
      expect(String(init?.body)).not.toContain(secret);
      if (step === 2) {
        expect(latest.role).not.toBe('tool');
        return memoryResponse('new_search', 'search', { query: '花园计划' });
      }
      if (step === 3) {
        expect(latest).toMatchObject({ role: 'tool', tool_call_id: 'new_search' });
        expect((JSON.parse(latest.content) as CompanionStorageResponse).memoryPage?.items[0]?.memory.id).toBe(safe.id);
        return memoryResponse('new_read', 'read', { id: safe.id });
      }
      expect(latest).toMatchObject({ role: 'tool', tool_call_id: 'new_read' });
      expect((JSON.parse(latest.content) as CompanionStorageResponse).memoryRead?.memory.content).toBe(source.content);
      return textResponse('仍然记得花园计划：周六给玫瑰浇水。');
    });
    const request = await sent(f.service, f.store, f.conversation.id, '请忘掉旧秘密，然后查看仍然有效的花园计划。', 'forget-then-new-tools');
    expect(step).toBe(4);
    const checkpoint = f.store.request({ type: 'loop.get', companionId: 'sister', sourceMessageId: request.id }).loop!;
    expect(JSON.parse(checkpoint.context!.user).memoryEvidenceThroughStep).toBe(1);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.at(-1)?.content).toContain('玫瑰浇水');
  });

  it('records an observed group agreement for a silent witness and recalls it across that owners other entrances', async () => {
    const f = fixture([...seeds,
      { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false },
      { id: 'comet', name: '阿星', description: '朋友', persona: '安静', model: '', avatar: 'sister', proactive: false }]);
    const group = f.store.createConversation('出行安排', ['sister', 'flash']);
    transport.memoryFetch.mockImplementation(async (_input, init) => {
      const source = payload(init).messages.find(message => message.content.includes('周六十点'));
      return structuredResponse({ notes: source ? [journal(source, '本群约定周六十点在东门集合。', ['旅行集合', '东门'])] : [] });
    });
    const source = await sent(f.service, f.store, group.id, '@大肥鱼，大家周六十点在东门集合。', 'group-agreement');
    expect(f.store.messages({ conversationId: group.id }).messages.some(message => message.authorId === 'flash')).toBe(false);
    await background(62_100);
    expect(active(f.store, group.id, 'flash')[0]).toMatchObject({ sourceMessageId: source.id, sourceConversationId: group.id, content: expect.stringContaining('东门'), status: 'indexed' });
    const other = f.store.createConversation('另一个群', ['sister', 'flash', 'comet']);
    expect(active(f.store, other.id, 'flash')).toHaveLength(1);
    expect(active(f.store, other.id, 'comet')).toHaveLength(0);
    const hit = await f.service.handle({ type: 'memory.search', companionId: 'flash', conversationId: group.id, query: '东门集合', tags: [], limit: 20 });
    expect(hit.memoryPage?.items[0]?.memory.content).toContain('东门');
  });

  it('preserves journal dependency sources and invalidates derived notes when a source note is revised', async () => {
    const f = fixture(), source = await sent(f.service, f.store, f.conversation.id, 'WorldlineBox 聊天功能验收通过，我先核对真实结果再确认。', 'phase-completed');
    const atom = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id,
      candidate: journal(source, 'WorldlineBox 聊天功能验收通过。', ['WorldlineBox', '聊天验收']) }).memories![0]!;
    const derived = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id,
      candidate: { ...journal(source, '这次验收先核对真实结果才确认完成；一次通过不能保证所有功能。', ['WorldlineBox', '验收经验']), relatedMemoryIds: [atom.id] } }).memories![0]!;
    await background();
    expect(active(f.store, f.conversation.id)).toHaveLength(2);
    expect(f.store.request({ type: 'memory.read', companionId: 'sister', conversationId: f.conversation.id, id: derived.id }).memoryRead?.sources.some(message => message.id === source.id)).toBe(true);
    const correction = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '更正：聊天功能验收没有通过，仍需修复。', replyDirective: 'none' });
    f.store.request({ type: 'memory.revise', companionId: 'sister', conversationId: f.conversation.id, id: atom.id, expectedVersion: atom.version,
      candidate: journal(correction, '聊天功能验收未通过，仍需修复。', ['WorldlineBox', '聊天验收']) });
    expect(active(f.store, f.conversation.id)).toHaveLength(1);
    expect(active(f.store, f.conversation.id)[0]?.id).toBe(atom.id);
    expect(() => f.store.request({ type: 'memory.read', companionId: 'sister', conversationId: f.conversation.id, id: derived.id })).toThrow();
    await background(31_000);
    expect(clients.get(f.root)!.forget).toHaveBeenCalledWith(expect.anything(), derived.id);
  });

  it('withdraws an old world-inspection tool result after its source is forgotten, even outside recalled chat and memory sources', async () => {
    const f = fixture([...seeds, { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false }]);
    const secret = 'PRIVATE_VISIT_REASON_8417';
    const old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '请拜访妹妹，原因是' + secret, replyDirective: 'none' });
    f.store.request({ type: 'world.tool', companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: old.id,
      arguments: { action: 'visit', targetCompanionId: 'flash', reason: secret } });
    for (let index = 0; index < COMPANION_DIALOGUE_WINDOW.maxMessages + 20; index++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '普通的历史消息' + index, replyDirective: 'none' });
    let resolvePending!: (value: Response) => void; const pending = new Promise<Response>(resolve => { resolvePending = resolve; });
    transport.fetch.mockResolvedValueOnce(toolResponse('old_world_inspection', 'world', { action: 'inspect' })).mockImplementationOnce(() => pending);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '看看你现在在哪里。', clientId: 'world-source-withdrawal' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const first = payload(transport.fetch.mock.calls[0]?.[1]);
    expect(first.messages.some(message => message.id === old.id)).toBe(false);
    expect(String(transport.fetch.mock.calls[1]?.[1]?.body)).toContain(secret);
    await closeService(f.service); resolvePending(textResponse('这条未发送回复不会写入。'));
    const reopened = new CompanionsStore(f.databasePath, [...seeds, { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false }]); stores.add(reopened); bindStorage(reopened);
    const request = reopened.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '请忘掉之前的私人拜访原因。', replyDirective: 'none' });
    reopened.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, sourceMessageIds: [old.id], requestMessageId: request.id });
    transport.fetch.mockReset(); transport.memoryFetch.mockClear();
    transport.fetch.mockImplementation(async () => textResponse('我已经移除撤回的资料。'));
    const restarted = startService(f.root); await restarted.handle({ type: 'state' }); await restarted.handle({ type: 'reply.resume', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(reopened.request({ type: 'work.list', sourceMessageId: source.id }).works?.[0]?.status).toBe('done'), { timeout: 10000 });
    expect(transport.fetch).toHaveBeenCalled();
    for (const [, init] of transport.fetch.mock.calls) expect(String(init?.body)).not.toContain(secret);
  });

  it('revalidates an older world receipt after an unrelated VCP revision refresh and later source withdrawal', async () => {
    const f = fixture([...seeds, { id: 'flash', name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false }]);
    const secret = 'PRIVATE_VISIT_AFTER_MEMORY_REFRESH_5782';
    const old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '请拜访妹妹，原因是' + secret, replyDirective: 'none' });
    f.store.request({ type: 'world.tool', companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: old.id,
      arguments: { action: 'visit', targetCompanionId: 'flash', reason: secret } });
    for (let index = 0; index < COMPANION_DIALOGUE_WINDOW.maxMessages + 20; index++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '无关的日常历史' + index, replyDirective: 'none' });
    const safe = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '窗台上的薄荷今天浇过水了。', replyDirective: 'none' });
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '看看你现在在哪里。', replyDirective: 'none' });
    const snapshot = f.store.request({ type: 'memory.snapshot', companionId: 'sister', conversationId: f.conversation.id,
      beforeSequence: source.sequence }).memorySnapshot!;
    expect(snapshot.revision).toBeTruthy();
    const inspection = f.store.request({ type: 'world.tool', companionId: 'sister', conversationId: f.conversation.id, arguments: { action: 'inspect' } });
    expect(JSON.stringify(inspection)).toContain(secret);
    const companion = f.store.state().companions.find(role => role.id === 'sister')!;
    const context = buildCompanionContext({ companion, conversation: f.conversation, messages: [source], sourceMessage: source,
      memories: [], agentLoop: true, taskRequest: { sourceMessageId: source.id, prompt: source.content } });
    // Capture the real SQLite corpus fingerprint and the fixture runtime's
    // actual profile. No model response fabricates a changed-context flag.
    context.user = JSON.stringify({ ...JSON.parse(context.user), memoryRecall: { context: {
      text: '', revision: snapshot.revision, profileKey: 'bundled-gemma2:768',
    } } });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: source.id,
      status: 'running', supplements: [], context, turns: [{ text: '', rawText: '', calls: [{ id: 'older_world_inspection', name: 'world',
        arguments: JSON.stringify({ action: 'inspect' }) }], results: [{ callId: 'older_world_inspection', content: JSON.stringify(inspection) }] }] };
    // A separate harmless note changes the VCP revision. That may discard old
    // memory.* results, but this still-valid world receipt must remain usable.
    f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id,
      candidate: journal(safe, safe.content, ['薄荷']) });
    markIndexed(f.store);
    const inference = f.service as unknown as { memoryInference(checkpoint: CompanionLoopCheckpoint, id: string, room: string, sequence: number): Promise<{ turns: CompanionLoopCheckpoint['turns'] }> };
    const refreshed = await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence);
    expect(JSON.parse(checkpoint.context!.user).memoryEvidenceThroughStep).toBe(1);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBeUndefined();
    expect(JSON.stringify(refreshed.turns)).toContain(secret);
    // The original request is outside the recent window and VCP recall. Its
    // later withdrawal must still invalidate the retained world's provenance.
    const forget = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '请忘掉之前的私人拜访原因。', replyDirective: 'none' });
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id,
      sourceMessageIds: [old.id], requestMessageId: forget.id });
    const withdrawn = await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence);
    expect(JSON.stringify(withdrawn.turns)).not.toContain(secret);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBe(1);
    expect(JSON.parse(checkpoint.context!.user).messages.some((message: { id: string }) => message.id === old.id)).toBe(false);
  });

  it('withdraws an older native history receipt after its source outside the recent window is forgotten', async () => {
    const f = fixture(), secret = 'HISTORY_RECEIPT_WITHDRAWN_6741';
    const old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: secret, replyDirective: 'none' });
    for (let index = 0; index < COMPANION_DIALOGUE_WINDOW.maxMessages + 20; index++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '普通历史' + index, replyDirective: 'none' });
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '请核对更早的聊天。', replyDirective: 'none' });
    const companion = f.store.state().companions.find(role => role.id === 'sister')!;
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: source.id,
      status: 'running', supplements: [], context: buildCompanionContext({ companion, conversation: f.conversation, messages: [source], sourceMessage: source,
        memories: [], agentLoop: true, taskRequest: { sourceMessageId: source.id, prompt: source.content } }),
      turns: [{ text: '', rawText: '', calls: [{ id: 'older_history', name: 'world', arguments: JSON.stringify({ action: 'history', before: old.sequence + 1, limit: 1 }) }],
        results: [{ callId: 'older_history', content: JSON.stringify({ messages: [f.store.getMessage(old.id)], nextBefore: old.sequence }) }] }] };
    const inference = f.service as unknown as { memoryInference(checkpoint: CompanionLoopCheckpoint, id: string, room: string, sequence: number): Promise<{ turns: CompanionLoopCheckpoint['turns'] }> };
    expect(JSON.stringify((await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence)).turns)).toContain(secret);
    expect(JSON.parse(checkpoint.context!.user).messages.some((message: { id: string }) => message.id === old.id)).toBe(false);
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, sourceMessageIds: [old.id] });
    expect(JSON.stringify((await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence)).turns)).not.toContain(secret);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBe(1);
  });

  it('withdraws old native topic receipts after a VCP-only refresh and hides the forgotten checkpoint from fresh reads and recall', async () => {
    const f = fixture(), secret = 'TOPIC_RECEIPT_WITHDRAWN_9638';
    const topic = f.store.request({ type: 'topic.create', conversationId: f.conversation.id, readerId: 'user', title: '长期规则讨论', kind: 'discussion', participantIds: ['sister'] }).topic!;
    const joined = f.store.request({ type: 'topic.join', conversationId: f.conversation.id, topicId: topic.id, readerId: 'sister' }).topic!;
    const old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', topicId: topic.id, content: secret, replyDirective: 'none' });
    const receipt = f.store.request({ type: 'topic.update', conversationId: f.conversation.id, topicId: topic.id, readerId: 'user', expectedRevision: joined.revision,
      patch: { shared: { summary: secret, sourceMessageIds: [old.id], state: { sourceMessageIds: ['FREE_STATE_NOT_A_REAL_SOURCE'] } } } });
    const topicReceipt = f.store.request({ type: 'topic.read', conversationId: f.conversation.id, topicId: topic.id, readerId: 'sister' });
    expect(receipt.topicState?.shared?.summary).toBe(secret);
    const safe = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', topicId: null, content: '今天给薄荷浇过水了。', replyDirective: 'none' });
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', topicId: null, content: '请查看之前话题的规则。', replyDirective: 'none' });
    const snapshot = f.store.request({ type: 'memory.snapshot', companionId: 'sister', conversationId: f.conversation.id, beforeSequence: source.sequence }).memorySnapshot!;
    const companion = f.store.state().companions.find(role => role.id === 'sister')!;
    const context = buildCompanionContext({ companion, conversation: f.conversation, messages: [source], sourceMessage: source,
      memories: [], agentLoop: true, taskRequest: { sourceMessageId: source.id, prompt: source.content } });
    context.user = JSON.stringify({ ...JSON.parse(context.user), memoryRecall: { context: { text: '', revision: snapshot.revision, profileKey: 'bundled-gemma2:768' } } });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: source.id,
      status: 'running', supplements: [], context, turns: [{ text: '', rawText: '', calls: [{ id: 'older_topic', name: 'world',
        arguments: JSON.stringify({ action: 'topic', parameters: { action: 'read', topicId: topic.id } }) }], results: [{ callId: 'older_topic', content: JSON.stringify(topicReceipt) }] }] };
    f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id, candidate: journal(safe, safe.content, ['薄荷']) }); markIndexed(f.store);
    const inference = f.service as unknown as { memoryInference(checkpoint: CompanionLoopCheckpoint, id: string, room: string, sequence: number): Promise<{ turns: CompanionLoopCheckpoint['turns'] }> };
    expect(JSON.stringify((await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence)).turns)).toContain(secret);
    expect(JSON.parse(checkpoint.context!.user).memoryEvidenceThroughStep).toBe(1);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBeUndefined();
    f.store.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, sourceMessageIds: [old.id] });
    expect(JSON.stringify((await inference.memoryInference(checkpoint, 'sister', f.conversation.id, source.sequence)).turns)).not.toContain(secret);
    expect(JSON.parse(checkpoint.context!.user).withdrawnEvidenceThroughStep).toBe(1);
    expect(f.store.request({ type: 'topic.read', conversationId: f.conversation.id, topicId: topic.id, readerId: 'sister' }).topicState?.shared).toBeUndefined();
    expect(JSON.stringify(f.store.request({ type: 'memory.world_query', companionId: 'sister', conversationId: f.conversation.id, category: 'topics', topicId: topic.id, query: '', limit: 10 }))).not.toContain(secret);
  });

  it.each([false, true])('does not reintroduce withdrawn evidence when a loop resumes (request itself withdrawn: %s)', async requestWithdrawn => {
    const f = fixture(), secret = 'SECRET_ADDRESS_青松路881号';
    const old = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: `旧地址是 ${secret}`, replyDirective: 'none' });
    const saved = f.store.request({ type: 'memory.record', companionId: 'sister', conversationId: f.conversation.id, candidate: {
      content: `用户地址 ${secret}`, tags: ['地址'],
      sourceMessageIds: [old.id], evidence: [{ sourceMessageId: old.id, quote: old.content }],
    } }).memories![0]!;
    let resolvePending!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { resolvePending = resolve; });
    transport.fetch.mockResolvedValueOnce(memoryResponse('read_before_shutdown', 'read', { id: saved.id })).mockImplementationOnce(() => pending);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id,
      content: requestWithdrawn ? `请核对地址 ${secret}` : '请核对我引用的旧地址。', replyToId: old.id, clientId: 'forgotten-resume-request' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const supplement = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: `补充地址仍是 ${secret}`,
      clientId: 'forgotten-supplement', delivery: 'steer', targetSourceMessageId: source.id })).message!;
    const checkpoint = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(JSON.stringify(checkpoint)).toContain(secret);
    expect(checkpoint.supplements[0]?.id).toBe(supplement.id);
    await closeService(f.service);
    resolvePending(textResponse(`未发送的旧回复 ${secret}`));
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
    const request = reopened.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: requestWithdrawn ? '请忘掉刚才地址、核对请求与补充的地址。' : '请忘掉旧地址和补充的地址，保留当前核对请求。', replyDirective: 'none' });
    expect(reopened.request({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id,
      sourceMessageIds: [old.id, ...(requestWithdrawn ? [source.id] : []), supplement.id], requestMessageId: request.id }).forgottenCount).toBeGreaterThan(0);
    transport.fetch.mockReset(); transport.memoryFetch.mockClear();
    transport.fetch.mockImplementation(async () => textResponse('撤回的资料已移除，不继续原来的核对。'));
    const restarted = startService(f.root);
    await restarted.handle({ type: 'state' });
    await restarted.handle({ type: 'reply.resume', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(reopened.request({ type: 'work.list', sourceMessageId: source.id }).works?.every(work => work.status === (requestWithdrawn ? 'cancelled' : 'done'))).toBe(true), { timeout: 12000 });
    if (requestWithdrawn) expect(transport.fetch).not.toHaveBeenCalled();
    else expect(transport.fetch).toHaveBeenCalled();
    for (const [, init] of [...transport.fetch.mock.calls, ...transport.memoryFetch.mock.calls]) expect(String(init?.body)).not.toContain(secret);
    expect(active(reopened, f.conversation.id)).toHaveLength(0);
  });
});
