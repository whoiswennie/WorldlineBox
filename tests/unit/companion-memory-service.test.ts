import { mkdtempSync, rmSync } from 'node:fs';
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
import type { CompanionMemory } from '../../src/shared/companions';
import type { DshLauncher } from '../../src/main/dsh/launcher';
import { COMPANION_DIALOGUE_WINDOW } from '../../src/main/companions/context-window';
import { buildCompanionContext } from '../../src/main/companions/context';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionOptionalDreamError } from '../../src/main/companions/optional-dream-error';
import type { VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';

const transport = vi.hoisted(() => ({ request: vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(),
  start: vi.fn<() => Promise<void>>(async () => undefined), close: vi.fn(async () => undefined), fetch: vi.fn<typeof fetch>(), memoryFetch: vi.fn<typeof fetch>(), worldFetch: vi.fn<typeof fetch>(), authorizationFetch: vi.fn<typeof fetch>(), prohibitionFetch: vi.fn<typeof fetch>(), progressFetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = transport.start; request = transport.request; close = transport.close;
} }));
vi.mock('electron', () => ({
  net: { fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => payload(init).purpose === 'companion_social_progress_review'
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
function startService(root: string): CompanionService {
  const dsh = { state: () => ({ tasks: [], operations: [] }), requestTask: vi.fn(async () => ({ ok: true })) } as unknown as DshLauncher;
  const client = new FakeVcpClient(root); clients.set(root, client);
  const runtime: CompanionMemoryRuntime = { get: async () => ({ client, profileKey: 'bundled-gemma2:768' }), close: async () => client.close() };
  const service = new CompanionService({ userData: root, workerPath: 'mocked-worker', window: () => undefined, memoryRuntime: runtime,
    getConfig: () => ({ apiFormat: 'openai_chat', model: 'memory-test-chat-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' }),
    hasConfig: () => true, dsh: () => dsh, report: vi.fn() });
  services.add(service); return service;
}
function fixture(customSeeds = seeds) {
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
  return { root, databasePath, store, conversation, service: startService(root) };
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
  it.each(['runtime', 'native', 'source_revision', 'owner', 'generation', 'native_integrity', 'native_abort', 'returned_owner', 'returned_time', 'returned_revision',
    'VCP_MEMORY_CLOSED', 'VCP_MEMORY_DERIVED_TIMEOUT', 'VCP_MEMORY_DERIVED_FAILED', 'VCP_MEMORY_EMBEDDING_RESPONSE_INVALID', 'VCP_MEMORY_PACKAGE_MISSING', 'VCP_MEMORY_ERROR',
    'VCP_MEMORY_UNSAFE_SOURCE', 'VCP_MEMORY_SOURCE_ID_MISMATCH', 'VCP_MEMORY_DIARY_ID_CONFLICT', 'VCP_MEMORY_EMBEDDING_SPACE_MISMATCH',
    'VCP_MEMORY_RUNTIME_LAYOUT', 'VCP_MEMORY_INVALID_INPUT', 'VCP_MEMORY_INVALID_DIMENSION', 'VCP_MEMORY_UNKNOWN_FUTURE_CODE'] as const)(
    'classifies optional dream %s failure only while the actual owner and sources remain current', async failure => {
    const f = fixture(), scope = { companionId: 'sister', conversationId: f.conversation.id };
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '梦境服务故障不改变这一真实来源。', replyDirective: 'none' });
    f.store.request({ type: 'memory.record', ...scope, candidate: journal(source, source.content) }); markIndexed(f.store);
    const client = new FakeVcpClient(path.join(f.root, 'optional-dream'));
    let cancelDuringOwnerCheck = false;
    const get = vi.fn(async () => {
      if (failure === 'runtime') throw Error('Operational failure with private endpoint details that must not be persisted.');
      return { client, profileKey: 'optional-dream-fixture' };
    });
    const memory = new CompanionMemoryService({ cacheRoot: path.join(f.root, 'optional-dream-views'), runtime: { get, close: async () => client.close() },
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
      admissions: db.prepare('SELECT COUNT(*) AS n FROM companion_world_sleep_episodes').get(), version: db.prepare('PRAGMA data_version').get() });
    try {
      const before = capture(), clock = f.store.request({ type: 'world.clock.peek' }).worldClock!;
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
          expect(overview.lifeOverview?.clock.virtualNow, transport.request.mock.calls.map(([command]) => command.type).join(',')).toBe(clock.virtualNow);
          expect(overview.lifeOverview?.clock.backlog, `persisted observation lag ${lag}ms`).toBe(lag > 5_000);
          expect(processing.memoryProcessing?.schedule?.schedulers.some(item => item.waitingReason === 'world_backlog'), `memory schedule lag ${lag}ms`).toBe(lag > 5_000);
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
    await background();
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
    await background();
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
    await background();
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
    expect(clients.get(f.root)!.search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: expect.stringContaining('出生的那天') }));
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
    await background();
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
