import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionMemoryRecallContext } from '../../src/shared/companion-memory-recall-context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';
import type { CompanionLearningGoalRound } from '../../src/shared/companion-learning-goals';
import type { AssetSummary } from '../../src/shared/asset-types';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionLearningGoalService } from '../../src/main/companions/learning-goal-service';
import { CompanionLearningService, type CompanionLearningAssets } from '../../src/main/companions/learning-service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import type { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import type { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemoryTagService } from '../../src/main/companions/memory-tags-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionActivityTaskService } from '../../src/main/companions/activity-task-service';
import { CompanionScheduleService } from '../../src/main/companions/schedule-service';
import { CompanionTopicCompactionService } from '../../src/main/companions/topic-compaction-service';
import { CompanionGrowthService } from '../../src/main/companions/growth-service';
import { CompanionMemoryFilesPending } from '../../src/main/companions/memory-files-pending';
import { COMPANION_MEMORY_SCOPE_MEANINGS, companionMemoryKinds } from '../../src/shared/companion-memory-scope';

// New, isolated acceptance fixture. The actual Main caller, SQLite transaction,
// Registry, file actors and provider transport run; only IPC and scheduling are
// controlled. Recall below verifies actual files, not native ranking quality.
const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }, dialog: {}, ipcMain: { handle: () => undefined },
  protocol: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (value: Buffer) => value.toString() } }));

type Host = {
  learningGoals: CompanionLearningGoalService;
  historyFiles: CompanionMemoryHistoryFiles;
  liveFiles: CompanionMemoryLiveFiles;
  call(command: CompanionStorageCommand, signal?: AbortSignal, origin?: 'memory-files'): Promise<CompanionStorageResponse>;
  wakeMemoryFiles(owner: string): void;
  pumpPendingMemoryFiles(): Promise<void>;
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const body = '借阅上限为三本，借期十四天；已预约的书不能续借。';

it('retains the committed learning integration across exact file pending, restart and release without repeating the model or the note', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'companion-learning-file-pending-'));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-learning-file-pending-')) throw new Error('Unexpected fixture root');
  const sourceFile = path.join(root, '教材.txt'); writeFileSync(sourceFile, body);
  const seed: CompanionSeed = { id: 'alice', name: 'Alice', description: '', persona: '核对真实资料，区分阅读与亲历。', model: '', avatar: 'sister', active: true, proactive: false };
  const database = path.join(root, 'companions', 'messages.sqlite');
  let store = new CompanionsStore(database, [seed]), service: CompanionService | undefined, host: Host | undefined;
  const reports: unknown[] = [], http: Array<{ stage: string; hash: string }> = [], returnedPending: string[] = [];
  const commands: string[] = [], pendingErrors: CompanionMemoryFilesPending[] = [];
  const checkpoints: Array<{ phase: string; round: CompanionLearningGoalRound; file: CompanionJobDisposition }> = [];
  let outcome = 'running', failure: unknown;
  let goalId = '', held: CompanionJobDisposition | undefined, committed: CompanionLearningGoalRound | undefined;
  let holdNextIntegration = true, indexEnabled = false;
  const asset: AssetSummary = { assetId: 'book', displayName: '教材.txt', currentRevisionId: sha(body), relativeFilePath: '教材.txt', mediaType: 'text' } as AssetSummary;
  const assets: CompanionLearningAssets = {
    catalog: async () => [], grant: async () => ({ libraryName: '准确教材', libraryPath: root }),
    page: async () => ({ assets: [asset], hasMore: false }),
    read: async () => { const content = readFileSync(sourceFile, 'utf8'); return { content, revisionId: sha(content), truncated: false }; },
  };
  const server = createServer((incoming, outgoing) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8'), wire = JSON.parse(text) as { messages: Array<{ content: string }> };
    const input = JSON.parse(wire.messages[1]!.content) as { purpose: string; data: { reads?: Array<{ id: string }>; recalled?: string } };
    const stage = input.purpose.replace('companion_learning_', ''); http.push({ stage, hash: sha(text) });
    const value = stage === 'plan' ? { focus: '准确的借阅条件', questions: ['借阅与续借有哪些限制？'], searchQueries: [] }
      : stage === 'learn' ? { summary: body, claims: [{ text: body, evidence: [{ sourceId: input.data.reads![0]!.id, quote: body }] }] }
        : stage === 'questions' ? { questions: ['这份材料说明了什么限制？'] }
          : stage === 'answer' ? { answers: [input.data.recalled?.includes(body) ? body : '不知道'] }
            : stage === 'assess' ? { evaluations: [{ evaluation: 'supported', rationale: '受控自测仅验证恢复链路，不证明掌握。', evidence: [{ sourceId: input.data.reads![0]!.id, quote: body }] }], gaps: ['未做外部交叉核实'], nextPlan: ['核对更新的正式规则'] }
              : undefined;
    if (!value) throw new Error('Unexpected provider stage: ' + input.purpose);
    outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  })().catch(error => { reports.push(error); outgoing.writeHead(500); outgoing.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local provider address');
  const readRound = () => store.request({ type: 'learning.goals.rounds', companionId: 'alice', id: goalId, limit: 20 }).learningRounds!.items[0]!;
  const inspect = (id: string) => store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'history_files', id }).jobDisposition!;
  try {
    for (const [prototype, method] of [[CompanionMemoryLibrary.prototype, 'start'], [CompanionMemoryTagService.prototype, 'start'],
      [CompanionWorldService.prototype, 'start'], [CompanionActivityTaskService.prototype, 'start'], [CompanionScheduleService.prototype, 'start'],
      [CompanionTopicCompactionService.prototype, 'start'], [CompanionGrowthService.prototype, 'start'], [CompanionGrowthService.prototype, 'wake'],
      [CompanionLearningService.prototype, 'start'], [CompanionLearningGoalService.prototype, 'start']] as const)
      vi.spyOn(prototype as { start(): void; wake(): void }, method).mockImplementation(() => undefined);
    vi.spyOn(CompanionWorldService.prototype, 'ready').mockResolvedValue(); vi.spyOn(CompanionWorldService.prototype, 'end').mockResolvedValue();
    // Real held rows govern readiness; these seams only make scheduling explicit
    // and reproducible. They never bypass ensure/read or unseal a held row.
    vi.spyOn(CompanionService.prototype as unknown as Host, 'wakeMemoryFiles').mockImplementation(() => undefined);
    vi.spyOn(CompanionService.prototype as unknown as Host, 'pumpPendingMemoryFiles').mockResolvedValue();
    const actualCall = (CompanionService.prototype as unknown as Host).call;
    vi.spyOn(CompanionService.prototype as unknown as Host, 'call').mockImplementation(async function (this: Host, ...args) {
      const response = await actualCall.apply(this, args);
      if (args[0].type === 'learning.goals.integrate') {
        expect(response.ok).toBe(true); expect(response.memoryFilesPending).toBe(true);
        returnedPending.push(...response.memories!.map(note => note.id));
      }
      return response;
    });
    vi.spyOn(CompanionMemoryService.prototype, 'schedule').mockImplementation(() => {
      if (!indexEnabled) return;
      for (;;) {
        const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
        if (job.operation === 'remember') {
          const readiness = store.request({ type: 'memory.files.inspect', companionId: 'alice', conversationId: 'world_alice', id: job.note.id, contentRevision: job.note.contentRevision! }).memoryFileReadiness;
          expect(readiness?.state).toBe('published');
        }
        store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
      }
    });
    vi.spyOn(CompanionMemoryService.prototype, 'search').mockImplementation(async query => {
      const response = await host!.call({ type: 'memory.browse', companionId: query.companionId, conversationId: query.conversationId, retrievalScope: 'knowledge' });
      const page = response.memoryPage!, notes = page.items.map(item => item.memory), actual = await host!.liveFiles.materialize('alice', notes);
      const context: CompanionMemoryRecallContext = { text: actual.notes.map(note => note.content).join('\n'), revision: 'actual-canonical-files', profileKey: 'controlled-file-recovery', fileReceipts: actual.receipts,
        typeScope: { schema: 'worldlinebox.memory-type-scope-v2', consumer: 'knowledge', contentKinds: companionMemoryKinds('knowledge'), meaning: COMPANION_MEMORY_SCOPE_MEANINGS.knowledge },
        evidence: { capturedAt: new Date().toISOString(), corpusHash: sha(JSON.stringify(actual.notes)), dependencyCoverage: 'complete',
          dependencies: actual.notes.map(note => ({ id: note.id, version: note.version })), frozenDependencies: actual.notes.map(note => ({ id: note.id, contentRevision: note.contentRevision!,
            sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) })) } };
      return { ok: true, memoryPage: page, memoryContext: context };
    });
    vi.spyOn(CompanionMemoryService.prototype, 'contextValid').mockImplementation(async (_scope, context) => !context?.fileReceipts?.length || await host!.liveFiles.validate('alice', context.fileReceipts));
    transport.request = async command => {
      commands.push(command.type); const response = store.request(command);
      if (command.type === 'learning.goals.integrate' && response.ok && holdNextIntegration) {
        holdNextIntegration = false; committed = response.learningGoal!.lastRound!;
        const note = response.memories![0]!, descriptor = store.request({ type: 'memory.files.inspect', companionId: 'alice', conversationId: 'world_alice', id: note.id, contentRevision: note.contentRevision! }).memoryFileReadiness!;
        const current = inspect(descriptor.historyJob!.id);
        held = store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'history_files', id: current.id, inputVersion: current.inputVersion,
          expectedRevision: current.revision, operationId: randomUUID(), action: 'park' }).jobDisposition!;
      }
      return response;
    };
    const open = async () => {
      service = new CompanionService({ userData: root, workerPath: 'controlled-real-sqlite', memoryLibraryRoot: path.join(root, 'cognition', '伙伴记忆'),
        learningAssets: assets, window: () => undefined, hasConfig: () => true, getConfig: () => ({ apiFormat: 'openai_chat', model: 'local-file-pending-acceptance', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic-test-key' }),
        dsh: () => undefined, report: error => reports.push(error) });
      await service.handle({ type: 'state' }); host = service as unknown as Host;
    };
    await open();
    const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'testbook', libraryName: '准确教材', libraryPath: root, autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
    goalId = store.request({ type: 'learning.goals.create', companionId: 'alice', text: '核对教材中的借阅及续借限制。', materials: [{ kind: 'library', grantId: grant.id }], allowWeb: false,
      schedule: { intervalMinutes: 5, windows: [], timeZone: 'UTC' } }).learningGoal!.id;
    const settled = async () => { await host!.learningGoals.tick(); await vi.waitFor(() => expect((host!.learningGoals as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0), { timeout: 15000 }); };
    await settled();
    expect(committed?.integration, JSON.stringify({ round: readRound(), reports: reports.map(String), http, commands: commands.filter(type => !type.startsWith('cognition.registry')).slice(-30) })).toBeDefined(); expect(held?.state).toBe('parked');
    const pending = readRound();
    expect(pending, pending.error).toMatchObject({ status: 'deferred', memoryIds: committed!.memoryIds, integration: committed!.integration, disposition: { failureCount: 0, cycleFailureCount: 0 } });
    checkpoints.push({ phase: 'committed_then_file_pending', round: pending, file: inspect(held!.id) });
    expect(http.map(item => item.stage)).toEqual(['plan', 'learn']); expect(pending.selfTest).toBeUndefined();
    const memoryId = committed!.memoryIds[0]!, revision = store.listMemory('alice')[0]!.contentRevision!;
    await expect(host!.call({ type: 'memory.library.read', companionId: 'alice', id: memoryId, sourceLimit: 1 })).rejects.toBeInstanceOf(CompanionMemoryFilesPending);
    try { await host!.call({ type: 'memory.library.read', companionId: 'alice', id: memoryId, sourceLimit: 1 }); }
    catch (error) { if (!(error instanceof CompanionMemoryFilesPending)) throw error; pendingErrors.push(error); }
    expect(inspect(held!.id)).toMatchObject({ state: 'parked', failureCount: 0 });
    await service!.shutdown(); service = undefined; host = undefined; store.close(); store = new CompanionsStore(database, [seed]);
    vi.setSystemTime(Date.now() + 61000); await open(); await settled();
    expect(readRound()).toMatchObject({ id: pending.id, memoryIds: [memoryId], integration: committed!.integration, status: 'deferred', disposition: { failureCount: 0 } });
    expect(inspect(held!.id)).toMatchObject({ state: 'parked', failureCount: 0 });
    // Question preparation may advance independently; the answer must still
    // wait for the exact canonical note. This is not a repeated integration.
    expect(http.map(item => item.stage)).toEqual(['plan', 'learn', 'questions']);
    expect(readRound().selfTestProgress).toMatchObject({ questions: {} }); expect(readRound().selfTestProgress?.recall).toBeUndefined();
    checkpoints.push({ phase: 'restarted_still_held', round: readRound(), file: inspect(held!.id) });
    // Release only the exact synthetic file hold. No learning retry, memory
    // record, source re-import or user re-entry is involved.
    const current = inspect(held!.id);
    store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'history_files', id: current.id, inputVersion: current.inputVersion,
      expectedRevision: current.revision, operationId: randomUUID(), action: 'resume' });
    await host!.historyFiles.flush('alice', { memoryId, contentRevision: revision, operation: 'publish', limit: 1 });
    indexEnabled = true; vi.setSystemTime(Date.now() + 61000); await settled();
    const final = readRound();
    expect(final, final.error + '\n' + reports.map(String).join('\n')).toMatchObject({ id: pending.id, status: 'completed', memoryIds: [memoryId], integration: committed!.integration, disposition: { failureCount: 0 } });
    expect(store.listMemory('alice')).toHaveLength(1); expect(store.listMemory('alice')[0]).toMatchObject({ id: memoryId, contentRevision: revision, artifactKind: 'knowledge' });
    expect(commands.filter(type => type === 'learning.goals.integrate')).toHaveLength(1);
    expect(http.map(item => item.stage)).toEqual(['plan', 'learn', 'questions', 'answer', 'assess']);
    expect(pendingErrors).toHaveLength(1); expect(returnedPending).toEqual([memoryId]);
    expect(store.getMessage(final.reads[0]!.sourceMessageId!).content).toContain(body); expect(readFileSync(sourceFile, 'utf8')).toBe(body);
    expect((await host!.call({ type: 'memory.library.read', companionId: 'alice', id: memoryId, sourceLimit: 1 })).memoryRead!.memory.content).toContain(body);
    expect(inspect(held!.id)).toMatchObject({ state: 'completed', failureCount: 0 }); expect(reports).toEqual([]);
    checkpoints.push({ phase: 'same_file_released_original_round_completed', round: final, file: inspect(held!.id) }); outcome = 'passed';
  } catch (error) { outcome = 'failed'; failure = error; throw error;
  } finally {
    const proofDirectory = path.resolve('artifacts/cognition-validation'); mkdirSync(proofDirectory, { recursive: true });
    writeFileSync(path.join(proofDirectory, 'learning-integration-file-pending-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.json'), JSON.stringify({
      schema: 'worldlinebox.learning-integration-file-pending-acceptance-v1', outcome,
      fixtureHash: sha(readFileSync(path.resolve('tests/worker/companion-learning-integration-file-pending.test.ts'), 'utf8')),
      actualMain: true, actualSqlite: true, actualRegistryFiles: true, actualLoopbackHttp: true, paidProvider: false,
      recallLimit: 'Controlled canonical recall and index acknowledgements; this does not assess Rust/Gemma retrieval quality.',
      release: 'Explicit jobs.control.resume of the one artificially parked history_files job; no learning retry or memory.record.',
      committed, returnedPending, checkpoints, http,
      integrationCommands: commands.filter(type => type === 'learning.goals.integrate').length,
      pendingErrors: pendingErrors.map(error => ({ name: error.name, code: error.code, reason: error.reason })),
      reports: reports.map(String), ...(failure ? { failure: failure instanceof Error ? failure.stack : String(failure) } : {}),
    }, null, 2));
    await service?.shutdown(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    transport.request = undefined; vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
  }
}, 60000);
