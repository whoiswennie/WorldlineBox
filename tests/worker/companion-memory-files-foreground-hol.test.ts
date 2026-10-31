import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryLibrary, companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import type { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import type { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemoryTagService } from '../../src/main/companions/memory-tags-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionActivityTaskService } from '../../src/main/companions/activity-task-service';
import { CompanionScheduleService } from '../../src/main/companions/schedule-service';
import { CompanionTopicCompactionService } from '../../src/main/companions/topic-compaction-service';
import { CompanionGrowthService } from '../../src/main/companions/growth-service';
import { CompanionModelError } from '../../src/main/companions/model';

// Deliberately separate from the frozen broad-suite fixtures. Only the IPC
// transport and provider are controlled; publication, leases, Registry, SQLite,
// Main preparation and canonical reads use their production implementations.
const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined,
  fetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (...args: Parameters<typeof fetch>) => transport.fetch(...args) }, dialog: {}, ipcMain: { handle: () => undefined },
  protocol: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (value: Buffer) => value.toString() } }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Lane = 'source_files' | 'history_files';
type Host = {
  sourceFiles: CompanionMemorySourceFiles; historyFiles: CompanionMemoryHistoryFiles; memoryLibrary: CompanionMemoryLibrary;
  call(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  filePublicationTimer?: ReturnType<typeof setInterval>;
  initialization: Promise<void>;
};
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(lane: Lane) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-file-hol-'));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-file-hol-')) throw new Error('Unexpected fixture root');
  const database = path.join(root, 'companions/messages.sqlite');
  let store = new CompanionsStore(database, [{ id: 'alice', name: 'Alice', description: '', persona: '认真核验当前问题及真实来源。',
    model: '', avatar: 'sister', active: true, proactive: false }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const source = (content: string) => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
  const record = (content: string, from: CompanionMessage) => {
    const result = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content,
      sourceMessageIds: [from.id], evidence: [{ sourceMessageId: from.id, quote: from.content }] } });
    const note = result.memories?.[0]; if (!note) throw new Error(result.error ?? 'Real memory was not recorded'); return note;
  };
  const aSource = source('PUBLISHED_A_ORIGINAL_SOURCE'); let a: CompanionMemory;
  const provider = deferred<'foreground-provider'>(), lateClaim = deferred<'unrelated-late-claim'>(), releaseLate = deferred<void>();
  const blockedContext = deferred<'context-publication-blocked'>();
  const observations: string[] = [], reports: string[] = [];
  let b: CompanionMemory | undefined, c: CompanionMemory | undefined, injected = false, lateJobId: string | undefined;
  let service: CompanionService | undefined;
  let storageHook: ((command: CompanionStorageCommand) => void) | undefined;
  // Disable unrelated schedulers, not the real foreground recall or its file
  // preparation. No native runtime is configured: indexed readiness reports
  // pending and the ordinary reply can use its current input without native.
  vi.spyOn(CompanionMemoryService.prototype, 'schedule').mockImplementation(() => undefined);
  vi.spyOn(CompanionMemoryLibrary.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionMemoryTagService.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionWorldService.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionWorldService.prototype, 'ready').mockResolvedValue();
  vi.spyOn(CompanionWorldService.prototype, 'end').mockResolvedValue();
  vi.spyOn(CompanionActivityTaskService.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionScheduleService.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionTopicCompactionService.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionGrowthService.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompanionGrowthService.prototype, 'wake').mockImplementation(() => undefined);
  transport.fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const context = JSON.parse(body.messages[1]!.content) as { purpose?: string; taskRequest?: { prompt: string }; source?: { content: string } };
    if (context.taskRequest?.prompt === 'HOL_FOREGROUND_REQUEST') { observations.push('foreground-provider'); provider.resolve('foreground-provider'); }
    const content = context.purpose === 'world_attention' ? { urgency: 'ordinary', confidence: .9, evidence: [context.source?.content ?? ''], reason: '本次普通对话。' }
      : context.purpose === 'world_decision' ? { action: null, reason: '没有独立世界事件。' } : { text: '已处理当前独立问题。' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  transport.request = async command => {
    let response: CompanionStorageResponse;
    try { storageHook?.(command); response = store.request(command); }
    catch (error) {
      if (command.type === 'cognition.registry.publication.prepare' && command.publication.operationId.startsWith('context:prepare:')) {
        observations.push('context-publication-blocked'); blockedContext.resolve('context-publication-blocked');
      }
      throw error;
    }
    const publicationOperation = 'operationId' in command ? command.operationId : 'publication' in command ? command.publication.operationId : undefined;
    if (response.registryPublicationBusy && typeof publicationOperation === 'string' && publicationOperation.startsWith('context:prepare:')) {
      observations.push('context-publication-blocked'); blockedContext.resolve('context-publication-blocked');
    }
    const sourceJob = response.memorySourceOutbox, historyJob = response.memoryHistoryOutbox;
    if (b && !injected && (lane === 'source_files' && command.type === 'memory.sources.outbox.complete'
      && store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: lane, id: command.id }).jobDisposition?.sourceMessageId === b.sources[0]!.messageId
      || lane === 'history_files' && command.type === 'memory.history.outbox.complete'
      && store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: lane, id: command.id }).jobDisposition?.memoryId === b.id)) {
      injected = true;
      // This event arrives after foreground preparation started. For history,
      // A's already formal source makes C independently ready, not upstream-waiting.
      const cSource = lane === 'source_files' ? source('UNRELATED_LATE_C_ORIGINAL_SOURCE') : aSource;
      c = record('前台开始准备之后才到达的无关记忆 C。', cSource); observations.push('late-C-enqueued');
    }
    if (c && (lane === 'source_files' && command.type === 'memory.sources.outbox.claim' && sourceJob?.sourceId === c.sources[0]!.messageId
      || lane === 'history_files' && command.type === 'memory.history.outbox.claim' && historyJob?.memoryId === c.id)) {
      lateJobId = (sourceJob ?? historyJob)!.id; observations.push('unrelated-late-claim'); lateClaim.resolve('unrelated-late-claim');
      await releaseLate.promise;
    }
    return response;
  };
  const open = () => new CompanionService({ userData: root, workerPath: 'controlled-real-storage', memoryLibraryRoot: path.join(root, 'cognition', '伙伴记忆'),
      window: () => undefined, hasConfig: () => true, getConfig: () => ({ apiFormat: 'openai_chat', model: 'controlled-local-provider', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-test-key' }),
      dsh: () => undefined, report: error => {
        reports.push(error instanceof Error ? error.message : String(error));
        if (error instanceof CompanionModelError && error.code === 'CONTEXT_RECORD_FAILED') blockedContext.resolve('context-publication-blocked');
      } });
  try {
    service = open();
    await service.handle({ type: 'state' });
    const host = service as unknown as Host;
    // Keep this ordering probe about foreground preparation; the independent
    // background consumer is exercised explicitly in the writer/read cases.
    if (host.filePublicationTimer) clearInterval(host.filePublicationTimer);
    a = record('已正式发布、可独立核验的旧记忆 A。', aSource);
    await host.call({ type: 'memory.revision.read', ...scope, id: a.id, contentRevision: a.contentRevision! });
    expect((await host.historyFiles.read(scope, a.id, a.contentRevision!)).content).toBe(a.content);
    // Locate using the real session: the owner directory layout is not a fixture assumption.
    const aFile = await host.memoryLibrary.withDocuments('alice', async session => session.file(companionMemoryRegisteredPath(a)), { readOnly: true });
    const aHash = sha(readFileSync(aFile));
    b = record('前台开始前排队、但与本次问题无关的记忆 B。', lane === 'source_files' ? source('UNRELATED_B_ORIGINAL_SOURCE') : aSource);
    return { root, get store() { return store; }, scope, get service() { return service!; }, host, a, aSource, aFile, aHash, provider, lateClaim, blockedContext, observations, reports,
      get b() { return b!; }, intercept: (hook?: typeof storageHook) => { storageHook = hook; },
      get c() { return c; }, get lateJobId() { return lateJobId; }, releaseLate,
      async restart() { await service!.shutdown(); store.close(); store = new CompanionsStore(database, []); service = open(); return service; },
      async close() {
        releaseLate.resolve();
        try { await service?.shutdown(); } finally { store.close(); vi.restoreAllMocks(); transport.fetch.mockReset(); transport.request = undefined; rmSync(root, { recursive: true, force: true }); }
      } };
  } catch (error) {
    releaseLate.resolve(); try { await service?.shutdown(); } finally { store.close(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); } throw error;
  }
}

it.each(['source_files', 'history_files'] as const)('sends an ordinary Main reply before consuming an unrelated late %s arrival', async lane => {
  const f = await fixture(lane);
  try {
    const sent = await f.service.handle({ type: 'message.send', conversationId: f.scope.conversationId, content: 'HOL_FOREGROUND_REQUEST', clientId: 'controlled-foreground', delivery: 'chat' });
    expect(sent.ok).toBe(true);
    const first = await Promise.race([f.provider.promise, f.lateClaim.promise]);
    expect(sha(readFileSync(f.aFile))).toBe(f.aHash);
    expect(f.store.getMessage(f.aSource.id).content).toBe(f.aSource.content);
    if (f.c) expect(f.store.getMessage(f.c.sources[0]!.messageId).content).toBe(lane === 'source_files' ? 'UNRELATED_LATE_C_ORIGINAL_SOURCE' : f.aSource.content);
    // Verify the controlled provider really is reachable after releasing C;
    // a broken model fixture cannot impersonate this ordering regression.
    f.releaseLate.resolve(); await f.provider.promise;
    // RED: readiness for the current task must not move its finish line to C,
    // which was not even present when that task entered file preparation.
    expect(first, JSON.stringify({ observations: f.observations, reports: f.reports })).toBe('foreground-provider');
  } finally { await f.close(); }
}, 30000);

it('reopens real Main and serves a new chat while an unrelated startup publication is held, retaining strict published A', async () => {
  const f = await fixture('source_files'); let state: ReturnType<CompanionService['handle']> | undefined;
  try {
    const restarted = await f.restart(), host = restarted as unknown as Host; let initialized = false;
    void host.initialization.then(() => { initialized = true; });
    state = restarted.handle({ type: 'state' });
    await f.lateClaim.promise;
    // A startup synchronous source drain would reach this exact claim with
    // initialization unresolved. A background consumer can only start after
    // the strong recovery/privacy fence has completed, independent of timings.
    expect(initialized).toBe(true); expect((await state).ok).toBe(true);
    expect((await host.call({ type: 'memory.revision.read', ...f.scope, id: f.a.id, contentRevision: f.a.contentRevision! })).memories?.[0]?.content).toBe(f.a.content);
    expect(sha(readFileSync(f.aFile))).toBe(f.aHash);
    expect((await restarted.handle({ type: 'message.send', conversationId: f.scope.conversationId, content: 'HOL_FOREGROUND_REQUEST', clientId: 'after-real-main-restart', delivery: 'chat' })).ok).toBe(true);
    await f.provider.promise;
    expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'source_files', id: f.lateJobId! }).jobDisposition?.state).toBe('running');
    expect(f.store.getMessage(f.aSource.id).content).toBe(f.aSource.content); expect(f.reports).toEqual([]);
  } finally { f.releaseLate.resolve(); try { await state; } finally { await f.close(); } }
}, 30000);

it('saves an actual Main request snapshot and sends a new chat while an unrelated failed file package remains prepared', async () => {
  const f = await fixture('source_files');
  try {
    const job = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'source_files', limit: 50 }).jobPage!.items
      .find(job => job.sourceMessageId === f.b.sources[0]!.messageId)!;
    const operationId = `source-file:${job.id}:cycle:0`;
    f.intercept(command => {
      if (command.type === 'cognition.registry.publication.transition' && command.operationId === operationId && command.nextState === 'validated')
        throw new Error('Controlled publication interruption after the real durable prepare and stage write.');
    });
    expect(await f.host.sourceFiles.flush('alice', { jobId: job.id, limit: 1 })).toMatchObject({ failed: 1, completed: 0 }); f.intercept();
    const failed = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'source_files', id: job.id }).jobDisposition!;
    const registry = await f.host.memoryLibrary.withDocuments('alice', async session => session.registry, { readOnly: true });
    const publication = await registry.publication(operationId);
    expect(failed).toMatchObject({ state: 'failed', failureCount: 1, cycleFailureCount: 1, attemptCount: 1 }); expect(publication?.state).toBe('prepared');
    const failureReports = [...f.reports];
    expect((await f.host.call({ type: 'memory.revision.read', ...f.scope, id: f.a.id, contentRevision: f.a.contentRevision! })).memories?.[0]?.content).toBe(f.a.content);
    const sent = await f.service.handle({ type: 'message.send', conversationId: f.scope.conversationId, content: 'HOL_FOREGROUND_REQUEST', clientId: 'unrelated-prepared-failure', delivery: 'chat' });
    expect(sent.ok).toBe(true);
    const first = await Promise.race([f.provider.promise, f.blockedContext.promise]);
    expect(first, JSON.stringify({ observations: f.observations, reports: f.reports })).toBe('foreground-provider');
    const snapshots = await registry.page({ consumer: 'audit', kind: 'context_snapshot', limit: 50 });
    const requests = await Promise.all(snapshots.items.filter(item => item.relativePath.endsWith('/request.json')).map(item => registry.read({ artifactId: item.artifactId, consumer: 'audit' })));
    expect(requests.some(item => { const snapshot = JSON.parse(item.text) as { providerBody: string }; return snapshot.providerBody.includes('HOL_FOREGROUND_REQUEST'); })).toBe(true);
    expect(await registry.publication(operationId)).toEqual(publication);
    expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'source_files', id: job.id }).jobDisposition).toEqual(failed);
    expect(f.store.getMessage(f.b.sources[0]!.messageId).content).toBe('UNRELATED_B_ORIGINAL_SOURCE'); expect(sha(readFileSync(f.aFile))).toBe(f.aHash);
    expect(f.reports).toEqual(failureReports);
  } finally { f.intercept(); await f.close(); }
}, 30000);

it('reads a known formally published A revision through Main before an unrelated late source is claimed', async () => {
  const f = await fixture('source_files'); let pending: Promise<CompanionStorageResponse> | undefined;
  try {
    pending = f.host.call({ type: 'memory.revision.read', ...f.scope, id: f.a.id, contentRevision: f.a.contentRevision! });
    const read = pending.then(response => { expect(response.memories?.[0]?.content).toBe(f.a.content); return 'known-A-read' as const; });
    const first = await Promise.race([read, f.lateClaim.promise]);
    expect(first, JSON.stringify(f.observations)).toBe('known-A-read');
  } finally { f.releaseLate.resolve(); try { await pending; } finally { await f.close(); } }
}, 30000);

it.each(['source_files', 'history_files'] as const)('keeps canonical read-only A independent of an active same-owner %s writer session', async lane => {
  const f = await fixture(lane); let flushing: Promise<unknown> | undefined;
  try {
    flushing = lane === 'source_files' ? f.host.sourceFiles.flush('alice') : f.host.historyFiles.flush('alice');
    await f.lateClaim.promise;
    expect(f.host.memoryLibrary.documentsWriting('alice')).toBe(true);
    // No release yet: this proves read-only sessions themselves do not wait
    // behind the held owner writer. The outer Main drain is a separate cause.
    const actual = await f.host.historyFiles.read(f.scope, f.a.id, f.a.contentRevision!);
    expect(actual.content).toBe(f.a.content); expect(sha(readFileSync(f.aFile))).toBe(f.aHash);
    expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: lane, id: f.lateJobId! }).jobDisposition?.state).toBe('running');
  } finally { f.releaseLate.resolve(); try { await flushing; } finally { await f.close(); } }
}, 30000);
