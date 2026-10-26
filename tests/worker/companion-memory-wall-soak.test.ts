import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { initialCompanionMemoryPolicy, COMPANION_MEMORY_POLICY_FILE } from '../../src/shared/companion-memory-policy';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { ownerGenerationRuntime } from '../fixtures/owner-generation-runtime';
import { freezeMemorySoakImplementation } from '../fixtures/frozen-memory-soak';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Real wall clock, real SQLite/Rust/files; synthetic local chat and 16-D
 * vectors. This exercises one persistent ordinary-work snapshot and the Main
 * memory/maintenance pipelines, not a real external DSH executor or encoder. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_WALL_SOAK !== '1')('keeps a running task frozen while actual authorized reads, encoding and integration commit for two wall-clock hours', async () => {
  const duration = Number(process.env.WORLDLINEBOX_MEMORY_SOAK_MS ?? 7_200_000);
  const period = Number(process.env.WORLDLINEBOX_MEMORY_SOAK_PERIOD_MS ?? 300_000);
  if (!Number.isSafeInteger(duration) || duration < 30_000 || duration > 7_800_000 || !Number.isSafeInteger(period) || period < 10_000 || period > duration)
    throw new Error('Invalid bounded soak duration.');
  const started = performance.now(), root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-memory-wall-soak-'));
  const output = path.resolve('artifacts/vcp-validation/memory-wall-soak-frozen-live.json'), commands: Array<{ type: string; at: string; stage?: string }> = [];
  const frozen = await freezeMemorySoakImplementation({ fixtureRoot: root, requireClean: process.env.WORLDLINEBOX_MEMORY_SOAK_ALLOW_DIRTY !== '1',
    loadedImplementation: { CompanionsStore, CompanionMemoryService, CompanionWorldService, CompanionMemoryLibrary, CompanionAssetProfileStore,
      CompanionMemoryHistoryFiles, CompanionMemorySourceFiles, CompanionMemoryLiveFiles,
      CompanionVcpRuntime, VcpMemoryClient, VcpMemoryProcessBroker, nativeManagementHarness, ownerGenerationRuntime } });
  const implementationOutput = path.resolve('artifacts/vcp-validation/memory-wall-soak-frozen-implementation.json');
  await mkdir(path.dirname(implementationOutput), { recursive: true }); await writeFile(implementationOutput, JSON.stringify(frozen.manifest, null, 2));
  const errors: string[] = [], checkpoints: unknown[] = [], purposes: string[] = [];
  let status = 'running', trackingTaskPrepare = false, taskPrepareCalls = 0, allPrepareCalls = 0, failure: unknown;
  const originalPrepare = VcpMemoryClient.prototype.prepareRecall;
  vi.spyOn(VcpMemoryClient.prototype, 'prepareRecall').mockImplementation(function (this: VcpMemoryClient, ...args) {
    allPrepareCalls++; if (trackingTaskPrepare) taskPrepareCalls++; return originalPrepare.apply(this, args);
  });
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), [{ id: 'alice', name: 'SoakAlice', description: '', persona: '只承认真实读取和有来源的任务结果。', model: '', avatar: 'sister', proactive: false, active: true }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, worldScope = { companionId: 'alice', conversationId: 'world_alice' };
  let world: CompanionWorldService | undefined;
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push({ type: command.type, at: new Date().toISOString(), ...('stage' in command ? { stage: command.stage } : {}) });
    if (command.type === 'memory.revision.read') {
      if (!historyFiles) throw new Error('Canonical history is not initialized.');
      await sourceFiles!.flush(command.companionId); return { ok: true, memories: [await historyFiles.read(command, command.id, command.contentRevision)] };
    }
    if ('companionId' in command && typeof command.companionId === 'string' && liveFiles
      && ['memory.snapshot', 'memory.read', 'memory.library.read', 'memory.jobs.contributions'].includes(command.type))
      await liveFiles.flush(command.companionId, { reconcile: true });
    const result = store.request(command);
    if (sourceFiles && historyFiles && liveFiles) for (const owner of result.memoryChangedCompanionIds ?? []) {
      await sourceFiles.flush(owner); await historyFiles.flush(owner); await liveFiles.flush(owner, { reconcile: false });
    }
    if (result.memorySnapshot && liveFiles) { const materialized = await liveFiles.materialize(command.type === 'memory.snapshot' ? command.companionId : 'alice', result.memorySnapshot.notes);
      result.memorySnapshot = { ...result.memorySnapshot, notes: materialized.notes, fileReceipts: materialized.receipts }; }
    if (result.memoryRead && liveFiles && historyFiles && sourceFiles) {
      const note = result.memoryRead.memory, ownerScope = { companionId: note.companionId, conversationId: note.sourceConversationId };
      result.memoryRead.memory = note.archivedAt ? await historyFiles.read(ownerScope, note.id, note.contentRevision!)
        : (await liveFiles.materialize(note.companionId, [note])).notes[0]!;
      result.memoryRead.sources = await Promise.all(result.memoryRead.sources.map(async source => {
        const reference = note.sources.find(reference => reference.messageId === source.id); return reference ? { ...source, content: await sourceFiles!.read(ownerScope, reference) } : source;
      }));
    }
    for (const owner of result.memoryChangedCompanionIds ?? []) memory?.changed(owner);
    for (const owner of result.memoryInvalidatedCompanionIds ?? []) await memory?.invalidate(owner);
    return result;
  };
  const profiles = new CompanionAssetProfileStore(path.join(root, '伙伴记忆'), { loadInitialFocusPrompt: () => readFile(path.join(frozen.vendorRoot, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8') });
  const owner = store.state().companions[0]!, profile = await profiles.bootstrap(owner), policy = initialCompanionMemoryPolicy();
  policy.capture.quietMs = 5_000; policy.capture.maxWaitMs = 15_000; policy.deep.intervalMs = 1_800_000; policy.deep.maxDebtAgeMs = 1_800_000; policy.deep.minEpisodes = 2; policy.dream.probability = 0;
  await profiles.writePrompt({ companionId: 'alice', relativePath: COMPANION_MEMORY_POLICY_FILE, expectedRevision: profile.memoryPolicyRevision,
    content: JSON.stringify({ schema: 'worldlinebox.companion-memory-policy-v1', companionId: 'alice', policy }) });
  store.request({ type: 'world.maintenance.bind-policy-root', root: profiles.libraryDirectory });
  const config = { apiFormat: 'openai_chat' as const, model: 'bounded-synthetic-soak', apiKey: 'synthetic-only', baseUrl: 'https://fixture.invalid', ownerId: 'alice',
    resolveAssetContext: async (context: { system: string; user: string }) => assembleCompanionAssetContext(context, await profiles.load('alice'), 'structured') };
  const modelFetch: typeof fetch = async (_url, init) => {
    const messages = JSON.parse(String(init?.body)).messages; let payload: { purpose?: string; messages?: Array<{ id: string; content: string }>; relevantMemories?: Array<{ id: string; version: number }> } = {};
    try { payload = JSON.parse(messages.find((message: { role: string }) => message.role === 'user')?.content ?? '{}'); } catch { /* Native focus has its exact upstream text format. */ }
    purposes.push(payload.purpose ?? 'native_focus_or_timeline');
    let value: unknown;
    if (payload.purpose === 'vcp_experience_journal') value = { notes: payload.messages!.map(source => ({ diaryName: '资料', content: source.content, tags: ['重要', '合成持续学习'],
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) };
    else if (payload.purpose === 'vcp_sleep_reflection') value = { notes: [], dream: null };
    else if (payload.purpose === 'vcp_sleep_memory_maintenance') value = { decision: 'merge', reason: '同一合成学习主题有新的真实阅读回执，保留全部来源后整合。', consolidations: [{
      inputs: payload.relevantMemories!.map(note => ({ id: note.id, version: note.version })), candidate: { diaryName: '资料', content: payload.messages!.map(source => source.content).join('\n\n'), tags: ['合成持续学习'],
        sourceMessageIds: payload.messages!.map(source => source.id), relatedMemoryIds: payload.relevantMemories!.map(note => note.id), evidence: payload.messages!.map(source => ({ sourceMessageId: source.id, quote: source.content })) } }] };
    else value = 'group0 ORIGINAL_TASK_CONTEXT：这只是合成测试的初始资料；持续任务沿用开始时已读取的上下文。';
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const broker = new VcpMemoryProcessBroker(2);
  const native = await nativeManagementHarness(root, request, { workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot, processBroker: broker,
    maxLiveProcesses: 2, beforeLaunch: frozen.beforeLaunch });
  const routed = ownerGenerationRuntime(root, native.embedding, native.launch, modelFetch, { workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot,
    nativeProcessLimit: 2, processBroker: broker });
  const memory: CompanionMemoryService = new CompanionMemoryService({ request, runtime: routed.runtime, cacheRoot: path.join(root, 'views'), configFor: async () => config, fetchFn: modelFetch,
    validateFiles: (owner, receipts, window) => liveFiles?.validate(owner, receipts, window) ?? Promise.resolve(false),
    flushSourceFiles: async () => { await sourceFiles!.flushPending(async command => store.request(command)); await historyFiles!.flushPending(async command => store.request(command)); },
    busy: () => false, changed: () => undefined, report: error => errors.push(String(error)) });
  const library = new CompanionMemoryLibrary({ libraryDirectory: profiles.libraryDirectory, profileStore: profiles, request: async command => store.request(command) });
  const sourceFiles = new CompanionMemorySourceFiles({ library }), historyFiles = new CompanionMemoryHistoryFiles({ library });
  const liveFiles = new CompanionMemoryLiveFiles({ library, history: historyFiles });
  const waitFor = async (check: () => boolean, label: string) => { const deadline = performance.now() + 90_000;
    while (!check()) { if (performance.now() > deadline) throw new Error('SOAK_TIMEOUT_' + label + ': ' + errors.slice(-5).join(';')); memory!.schedule(0); await delay(100); } };
  let reads = 0, taskContextHash = '', taskReceipt: NonNullable<CompanionStorageResponse['memoryContext']> | undefined, originalSourceId = '';
  const receipt = async (phase: string) => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ status, phase, actualWallMs: performance.now() - started,
    targetWallMs: duration, simulatedClock: false, actualChatModel: false, actualEncoder: false, actualSQLite: true, actualVendoredRustIndex: true, actualOwnerFiles: true,
    vectorDimension: 16, syntheticOnly: true, userDataModified: false, resourceLimits: { owners: 1, ordinaryTasks: 1, maxNativeProcesses: 2, backgroundTickMs: period },
    implementation: { manifestSha256: frozen.manifestSha256, receipt: implementationOutput, commit: frozen.manifest.git.head, cleanAtStart: !frozen.manifest.git.dirty,
      hostAndVendorCopied: true, npmDependencies: 'explicit pinned shared installed boundary, not copied' },
    nativeProcessAudit: native.processSnapshot(), broker: broker.snapshot(),
    taskContextHash, taskPrepareCalls, allPrepareCalls, reads, checkpoints, purposes, errors, commands, runtime: routed.runtime.resourceSnapshot() }, null, 2)); };
  try {
    store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 2 });
    const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'synthetic-library', libraryName: '本地合成授权资料', libraryPath: root, autonomous: true, intervalMinutes: 5 }).learning!.grants[0]!;
    const readActualFile = async () => {
      const file = path.join(root, `authorized-${reads}.txt`), text = `group${reads % 8} ORIGINAL_TASK_CONTEXT 合成课程第${reads}段：先核对出处，再记录当前条件；材料编号=${reads}。这不是用户真实资料。`;
      await writeFile(file, text); const content = await readFile(file, 'utf8');
      store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
      const job = store.request({ type: 'learning.claim' }).learningJob!; if (!job) throw new Error('Authorized read failed to acquire its actual grant.');
      const read = store.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: `synthetic-${reads}`, assetRevisionId: digest(content), assetName: path.basename(file), offset: 0, content, more: false }).learning!.reads[0]!;
      reads++; originalSourceId ||= read.sourceMessageId; memory!.schedule(0);
      await waitFor(() => store.request({ type: 'memory.snapshot', ...worldScope }).memorySnapshot!.notes.some(note => note.status === 'indexed' && note.sources.some(source => source.messageId === read.sourceMessageId)), 'capture_' + reads);
    };
    await readActualFile(); await readActualFile(); await library.sync();
    trackingTaskPrepare = true;
    const recalled = await memory.search({ ...scope, query: 'group0 ORIGINAL_TASK_CONTEXT', limit: 8 }, 'passive');
    trackingTaskPrepare = false; taskReceipt = recalled.memoryContext; expect(taskReceipt?.evidence?.snapshotPolicy).toBe('task_passive_v1'); expect(taskPrepareCalls).toBe(1);
    taskContextHash = digest(taskReceipt); const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '合成长期任务：保持初始回忆快照，等待后台持续学习完成。', replyDirective: 'none' });
    const stamp = new Date().toISOString(); store.request({ type: 'work.enqueue', work: { id: 'two-hour-task', ...scope, sourceMessageId: source.id, status: 'queued', proactive: false, createdAt: stamp, updatedAt: stamp } });
    expect(store.request({ type: 'work.claim' }).work?.id).toBe('two-hour-task');
    world = new CompanionWorldService({ request: command => command.type === 'world.job.claim' && command.kind === 'decision' ? Promise.resolve({ ok: true }) : request(command),
      configFor: async () => config, fetchFn: modelFetch, changed: () => memory!.schedule(0), wakeWaiting: () => undefined, report: error => errors.push(String(error)) });
    const runningAt = performance.now(); let nextRead = runningAt, nextCheckpoint = runningAt;
    while (performance.now() - runningAt < duration) {
      if (performance.now() >= nextRead) { await readActualFile(); nextRead += period; }
      memory.schedule(0); await world.tick();
      expect(digest(taskReceipt)).toBe(taskContextHash); expect(taskPrepareCalls).toBe(1);
      expect(await memory.contextValid(scope, taskReceipt)).toBe(true);
      expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: taskReceipt!.evidence!.frozenDependencies! }).memoryFrozenValid).toBe(true);
      if (performance.now() >= nextCheckpoint) { checkpoints.push({ at: new Date().toISOString(), runningWallMs: performance.now() - runningAt, contextHash: taskContextHash, taskPrepareCalls,
        indexed: store.request({ type: 'memory.snapshot', ...worldScope }).memorySnapshot!.notes.length, realCommits: commands.filter(command => command.type === 'world.job.complete' && command.stage === 'real').length });
        await frozen.verifyFrozen(); await frozen.verifySources(); expect(native.processSnapshot().peak).toBeLessThanOrEqual(2);
        expect(native.processSnapshot().limitViolations).toBe(0); expect(broker.snapshot().limit).toBe(2);
        await library.sync(); await receipt('running'); nextCheckpoint += Math.min(period, 60_000); }
      await delay(Math.min(1000, Math.max(50, nextCheckpoint - performance.now())));
    }
    await waitFor(() => commands.some(command => command.type === 'world.job.complete' && command.stage === 'real'), 'real_maintenance');
    expect(reads).toBeGreaterThanOrEqual(3); expect(purposes).toContain('vcp_sleep_memory_maintenance');
    const captured = store.request({ type: 'memory.snapshot', ...worldScope }).memorySnapshot!.notes;
    expect(captured.some(note => note.metadata?.consolidation && note.sources.length >= 2)).toBe(true);
    store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
    expect(store.request({ type: 'memory.frozen.valid', ...scope, memories: taskReceipt!.evidence!.frozenDependencies! }).memoryFrozenValid).toBe(false);
    await frozen.verifyFrozen(); await frozen.verifySources(); expect(native.processSnapshot().peak).toBeLessThanOrEqual(2);
    expect(native.processSnapshot().limitViolations).toBe(0);
    store.request({ type: 'work.status', id: 'two-hour-task', status: 'done' }); status = 'passed';
  } catch (error) {
    status = 'failed'; failure = error; errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    const closeErrors: unknown[] = [], drain = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { closeErrors.push(error); } };
    trackingTaskPrepare = false; await drain(async () => world?.close()); await drain(() => memory.close()); await drain(() => library.close());
    await drain(() => routed.close()); await drain(() => native.close()); await drain(() => broker.close());
    if (native.processSnapshot().live !== 0 || broker.snapshot().processes !== 0) { status = 'failed'; errors.push('Native processes remained after actual close/exit drain.'); }
    if (closeErrors.length) { status = 'failed'; errors.push(...closeErrors.map(error => 'Close failure: ' + String(error))); }
    await receipt('complete'); store.close(); vi.restoreAllMocks(); await removeOwnedDirectory(root);
  }
  if (failure) throw failure;
  if (status === 'failed') throw new Error('Frozen soak failed; see the final receipt and shutdown diagnostics.');
}, 8_100_000);
