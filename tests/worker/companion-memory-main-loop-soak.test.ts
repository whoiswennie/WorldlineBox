import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionFileReader } from '../../src/main/companions/file-reader';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { companionMemoryContextDependencies } from '../../src/main/companions/memory-context-evidence';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
import { companionMemoryPolicyFileSchema } from '../../src/shared/companion-memory-policy';
import { assetSummarySchema, type AssetSummary } from '../../src/shared/asset-types';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionLoopCheckpoint, CompanionWork } from '../../src/shared/companion-loop';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { freezeMemorySoakImplementation } from '../fixtures/frozen-memory-soak';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { ownerGenerationRuntime } from '../fixtures/owner-generation-runtime';

const transport = vi.hoisted(() => ({
  request: undefined as undefined | ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>),
  fetch: undefined as undefined | typeof fetch,
}));
// This boundary replaces only Electron utility IPC, not storage behavior. All
// commands still execute the production store, Main, agent kernel and tools.
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  async start() { /* The fixture already owns its real SQLite connection. */ }
  async request(command: CompanionStorageCommand) { if (!transport.request) throw Error('Storage fixture is not bound.'); return transport.request(command); }
  async close() { /* A restart preserves this connection; finally closes it. */ }
} }));
vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() }, net: { fetch: (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!transport.fetch) throw Error('Provider fixture is not bound.'); return transport.fetch(url, init);
  } }, dialog: { showOpenDialog: vi.fn() }, protocol: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
}));
const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const jsonResponse = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
const nativeCall = (name: string, args: unknown, id: string) => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
type CommandReceipt = { type: string; at: string; stage?: string; status?: string; turns?: number; results?: number };

/** A real Main ordinary loop, actual read_file + wait, durable restart and real
 * native/file memory maintenance. Only chat, vectors, and utility IPC are test
 * transports. No DSH process, encoder, user data, fake clock or forged work row. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK !== '1' && process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK_SMOKE !== '1')(
  'runs the ordinary Main agent loop through real tools and restart while authorized learning and memory keep committing', async () => {
    const smoke = process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK !== '1';
    const duration = Number(process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK_MS ?? (smoke ? 45_000 : 7_200_000));
    const period = Number(process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK_PERIOD_MS ?? (smoke ? 10_000 : 300_000));
    const quantum = smoke ? 2_000 : 60_000;
    if (!Number.isSafeInteger(duration) || duration < 30_000 || duration > 7_800_000 || !Number.isSafeInteger(period) || period < 5_000 || period > duration)
      throw Error('Invalid bounded Main soak duration.');
    const started = performance.now(), root = await mkdtemp(path.join(tmpdir(), 'memory-main-loop-soak-'));
    const output = path.resolve('artifacts/vcp-validation/memory-main-loop-' + (smoke ? 'smoke' : 'frozen-soak') + '.json');
    const frozen = await freezeMemorySoakImplementation({ fixtureRoot: root, requireClean: !smoke,
      loadedImplementation: { CompanionService, CompanionsStore, CompanionMemoryService, CompanionFileReader, CompanionAssetProfileStore, VcpMemoryClient, VcpMemoryProcessBroker } });
    const implementationOutput = output.replace(/\.json$/u, '-implementation.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(implementationOutput, JSON.stringify(frozen.manifest, null, 2));
    const commands: CommandReceipt[] = [], commandCounts = new Map<string, number>(), errors: string[] = [], checkpoints: unknown[] = [], providerWires: Array<{ at: string; recallHash: string; tools: number; final: boolean }> = [];
    const audited = new Set(['loop.save', 'work.enqueue', 'work.status', 'file.result.commit', 'learning.commit', 'memory.jobs.complete', 'world.job.complete', 'memory.history.outbox.complete', 'memory.sources.outbox.complete']);
    const database = path.join(root, 'messages.sqlite'), seeds = [{ id: 'alice', name: 'SoakAlice', description: 'Synthetic Main loop fixture', persona: '只承认真实读取与正式工具回执。', model: '', avatar: 'sister' as const, active: true, proactive: false }];
    let store = new CompanionsStore(database, seeds);
    const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, worldScope = { companionId: 'alice', conversationId: 'world_alice' };
    const broker = new VcpMemoryProcessBroker(2);
    let service: CompanionService | undefined, routed: ReturnType<typeof ownerGenerationRuntime> | undefined, failure: unknown, status = 'running';
    let sourceId = '', taskRecallCalls = 0, taskPrepareCalls = 0, allPrepareCalls = 0, recallHash = '', finalReply = '', deadline = 0, observedDeadline = 0, taskStartedAt = 0, staticFileHash = '', readCount = 0, restartCount = 0;
    let beforeRestart: CompanionLoopCheckpoint | undefined, afterRestart: CompanionLoopCheckpoint | undefined;
    let claimedWork: CompanionWork | undefined;
    const taskFile = path.join(root, 'authorized-task.txt'), lessonRoot = path.join(root, 'authorized-lessons'), lessonIds: string[] = [];
    await mkdir(lessonRoot);
    const rawRequest = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      const receipt: CommandReceipt = { type: command.type, at: new Date().toISOString(), ...('stage' in command ? { stage: command.stage } : {}) };
      if (command.type === 'loop.save') { receipt.status = command.checkpoint.status; receipt.turns = command.checkpoint.turns.length; receipt.results = command.checkpoint.turns.filter(turn => !!turn.results).length; }
      commandCounts.set(command.type, (commandCounts.get(command.type) ?? 0) + 1);
      if (audited.has(command.type)) commands.push(receipt);
      const result = store.request(command);
      if (command.type === 'work.claim' && result.work && store.getMessage(result.work.sourceMessageId).content.includes('MAIN_LOOP_SOAK') && !taskStartedAt) {
        taskStartedAt = performance.now(); claimedWork = structuredClone(result.work);
      }
      return result;
    };
    transport.request = rawRequest;
    const originalPrepare = VcpMemoryClient.prototype.prepareRecall, originalRecall = CompanionMemoryService.prototype.recall;
    vi.spyOn(VcpMemoryClient.prototype, 'prepareRecall').mockImplementation(function (this: VcpMemoryClient, ...args) {
      allPrepareCalls++; if (args[4]?.recovery) taskPrepareCalls++; return originalPrepare.apply(this, args);
    });
    vi.spyOn(CompanionMemoryService.prototype, 'recall').mockImplementation(function (this: CompanionMemoryService, input) {
      if (input.currentMessage.id === sourceId || input.currentMessage.content.includes('MAIN_LOOP_SOAK')) taskRecallCalls++;
      return originalRecall.call(this, input);
    });
    const summary = async (assetId: string): Promise<AssetSummary | undefined> => {
      if (!lessonIds.includes(assetId)) return;
      const relative = assetId + '.txt', file = path.join(lessonRoot, relative), bytes = await readFile(file), info = await stat(file);
      return assetSummarySchema.parse({ assetId, locationKind: 'managed', managedFolderId: null, relativeFilePath: relative, displayName: relative, currentRevisionId: sha(bytes.toString()),
        byteSize: bytes.length, modifiedAt: info.mtime.toISOString(), availability: 'available', rating: 0, favorite: false, deletedAt: null, trashedFromPath: null,
        remainingDays: null, thumbnailStatus: null, thumbnailArtifactId: null, mediaType: 'text', width: null, height: null });
    };
    const assets: CompanionLearningAssets = {
      catalog: async () => [{ libraryId: 'synthetic-lessons', displayName: 'Real fixture files', folders: [] }],
      grant: async () => ({ libraryName: 'Real fixture files', libraryPath: lessonRoot }), describe: async () => ({ libraryName: 'Real fixture files', libraryPath: lessonRoot }),
      page: async (_grant, afterId) => ({ assets: (await Promise.all(lessonIds.filter(id => !afterId || id > afterId).map(summary))).filter((asset): asset is AssetSummary => !!asset), hasMore: false }),
      asset: async (_grant, id) => summary(id), read: async (_grant, asset) => {
        const content = await readFile(path.join(lessonRoot, asset.relativeFilePath), 'utf8'); readCount++; return { content, revisionId: sha(content), truncated: false };
      },
    };
    const addLesson = async () => {
      const id = 'lesson-' + String(lessonIds.length).padStart(4, '0');
      await writeFile(path.join(lessonRoot, id + '.txt'), `group0 ORIGINAL_TASK_CONTEXT 实际授权学习第${lessonIds.length}份资料：核对出处与适用条件，保留材料编号${lessonIds.length}。`); lessonIds.push(id);
    };
    const modelFetch: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
      const user = wire.messages.find(message => message.role === 'user')?.content ?? '';
      let data: Record<string, unknown> = {}; try { data = JSON.parse(user); } catch { /* Original native prompts intentionally use text. */ }
      const purpose = data.purpose;
      if ((data.taskRequest as { prompt?: string } | undefined)?.prompt?.includes('MAIN_LOOP_SOAK')) {
        expect(taskStartedAt).toBeGreaterThan(0);
        const recall = (data.memoryRecall as { context?: unknown } | undefined)?.context, currentHash = sha(recall);
        expect(JSON.stringify(recall)).toContain('ORIGINAL_TASK_CONTEXT');
        recallHash ||= currentHash; expect(currentHash).toBe(recallHash);
        const tools = wire.messages.filter(message => message.role === 'tool');
        const fileRead = tools.find(message => message.content.includes('STATIC_TASK_DEADLINE_872'));
        const deadlineText = fileRead?.content.match(/TARGET_AT=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/u)?.[1];
        if (deadlineText) observedDeadline = Date.parse(deadlineText);
        const observedNow = Date.parse((data.worldClock as { now: string }).now); expect(Number.isFinite(observedNow)).toBe(true);
        // This deterministic provider retains only the deadline it actually saw
        // in a real tool result; later host history compaction may omit that old
        // receipt from its bounded wire, without causing a second file effect.
        const done = observedDeadline > 0 && observedNow >= observedDeadline;
        providerWires.push({ at: new Date().toISOString(), recallHash: currentHash, tools: tools.length, final: done });
        if (!observedDeadline) return nativeCall('dsh', { operation: 'read_file', parameters: { path: taskFile, limit: 10 } }, 'actual-static-file');
        if (!done) return nativeCall('wait', { ms: Math.max(100, Math.min(quantum, deadline - Date.now())), reason: '按已实际读取的静态截止时刻等候，然后核对宿主时钟。' }, 'actual-wait-' + tools.length);
        finalReply = '已实际读取 STATIC_TASK_DEADLINE_872，完成原任务的真实等候，并保留 ORIGINAL_TASK_CONTEXT 的初始回忆。';
        return jsonResponse({ text: finalReply, memories: [] });
      }
      if (purpose === 'vcp_experience_journal') {
        const messages = data.messages as Array<{ id: string; content: string }>;
        return jsonResponse({ notes: messages.map(source => ({ diaryName: '资料', content: source.content, tags: ['重要', '实际合成持续学习'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) });
      }
      if (purpose === 'vcp_sleep_reflection') return jsonResponse({ notes: [], dream: null });
      if (purpose === 'vcp_sleep_memory_maintenance') {
        const messages = data.messages as Array<{ id: string; content: string }>, notes = data.relevantMemories as Array<{ id: string; version: number }>;
        return jsonResponse({ decision: 'merge', reason: '真实独立阅读提供了新材料，合并保留每份实际来源。', consolidations: [{ inputs: notes.map(note => ({ id: note.id, version: note.version })), candidate: {
          diaryName: '资料', content: messages.map(source => source.content).join('\n\n'), tags: ['重要', '实际合成持续学习'], sourceMessageIds: messages.map(source => source.id), relatedMemoryIds: notes.map(note => note.id), evidence: messages.map(source => ({ sourceMessageId: source.id, quote: source.content })) } }] });
      }
      if (purpose === 'companion_social_progress_review') return jsonResponse({ supported: true, correction: '' });
      if (purpose === 'world_attention') return jsonResponse({ urgency: 'ordinary', confidence: 1, reason: '合成资料不是紧急通知。', evidence: [] });
      if (purpose === 'world_decision') return jsonResponse({ action: null, reason: '当前持续任务未完成，不新增独立行动。', appraisals: [] });
      if (wire.messages[0]?.content.includes('Knowledge Graph Architect')) return jsonResponse('[[Tag: 重要, 实际合成持续学习]]');
      return jsonResponse('group0 ORIGINAL_TASK_CONTEXT：合成测试的初始资料，任务保留当时已读快照。');
    };
    transport.fetch = modelFetch;
    const native = await nativeManagementHarness(root, rawRequest, { workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot, processBroker: broker, maxLiveProcesses: 2, beforeLaunch: frozen.beforeLaunch });
    const startMain = async () => {
      routed = ownerGenerationRuntime(root, native.embedding, native.launch, modelFetch, { workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot, processBroker: broker, nativeProcessLimit: 2 });
      service = new CompanionService({ userData: root, dataRoot: root, memoryLibraryRoot: path.join(root, '伙伴记忆'), vcpMemoryVendorRoot: frozen.vendorRoot,
        workerPath: 'explicit-real-store-transport', appPath: process.cwd(), window: () => undefined, hasConfig: () => true,
        getConfig: () => ({ apiFormat: 'openai_chat', model: 'deterministic-main-soak', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-only' }),
        memoryRuntime: routed.runtime, learningAssets: assets, dsh: () => undefined, report: error => errors.push(String(error)) });
      await service.handle({ type: 'state' });
    };
    const waitFor = async (check: () => boolean, label: string, ms = 90_000) => {
      const until = performance.now() + ms; while (!check()) { if (performance.now() > until) throw Error('MAIN_SOAK_TIMEOUT_' + label + ': ' + errors.slice(-5).join('; ')); await delay(100); }
    };
    const loop = () => store.request({ type: 'loop.get', sourceMessageId: sourceId, companionId: 'alice' }).loop!;
    const receipt = async (phase: string) => writeFile(output, JSON.stringify({ status, phase, smoke, actualWallMs: performance.now() - started, targetTaskWallMs: duration,
      actualMainAgentLoop: true, actualSQLite: true, actualCanonicalFiles: true, actualNativeRust: true, actualChatModel: false, actualEncoder: false, utilityIpc: 'replaced by real-store transport',
      learningAssetCatalog: 'synthetic host adapter over actual grant-scoped files; production LibraryWorker IPC is outside this test',
      syntheticOnly: true, userDataModified: false, restartPolicy: smoke ? 'explicit reply.resume after pending wait; completed file receipt is never replayed' : 'continuous task, no mid-run restart or manual resume',
      backgroundLearning: smoke ? 'real LearningService with explicit public run commands within one authorized grant' : 'real autonomous LearningService interval, no manual run commands',
      observedDeadline, staticFileHash, taskWallMs: taskStartedAt ? performance.now() - taskStartedAt : 0,
      learningUniqueReceipts: store.request({ type: 'learning.status', companionId: 'alice' }).learning?.reads.length,
      claimedWork, finalLoop: sourceId ? loop() : undefined, commandCounts: Object.fromEntries(commandCounts),
      implementation: { receipt: implementationOutput, manifestSha256: frozen.manifestSha256, cleanAtStart: !frozen.manifest.git.dirty,
        fullSourceFreezeEnforced: !smoke, frozenHostAndVendor: true }, taskRecallCalls, taskPrepareCalls, allPrepareCalls, readCount, restartCount, recallHash, finalReply,
      nativeProcessAudit: native.processSnapshot(), broker: broker.snapshot(), providerWires, checkpoints, beforeRestart, afterRestart, commands, errors }, null, 2));
    try {
      const world = store.request({ type: 'world.snapshot' }).world!;
      store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
      const routine = store.request({ type: 'routine.get', ...scope }).routine!;
      const futureTime = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(11, 16);
      store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: futureTime(240), wakeAt: futureTime(241), meals: [], habits: [] } });
      await startMain(); await receipt('initializing');
      const profiles = new CompanionAssetProfileStore(path.join(root, '伙伴记忆')), snapshot = await profiles.load('alice');
      const policy = companionMemoryPolicyFileSchema.parse(JSON.parse(await readFile(path.join(root, '伙伴记忆', 'alice', '记忆策略.json'), 'utf8')));
      policy.policy.capture.quietMs = 5_000; policy.policy.capture.maxWaitMs = 5_000; policy.policy.deep.intervalMs = 1_800_000; policy.policy.deep.maxDebtAgeMs = 1_800_000; policy.policy.deep.minEpisodes = 2; policy.policy.dream.probability = 0;
      await profiles.writePrompt({ companionId: 'alice', relativePath: '记忆策略.json', expectedRevision: snapshot.memoryPolicyRevision, content: JSON.stringify(policy) });
      await addLesson();
      const grant = (await service!.manageLearningSources({ type: 'memory.learning.grant', companionId: 'alice', libraryId: 'synthetic-lessons', autonomous: true, intervalMinutes: 5 })).learning!.grants[0]!;
      await waitFor(() => readCount >= 1, 'initial_actual_read');
      await waitFor(() => store.request({ type: 'memory.snapshot', ...worldScope }).memorySnapshot!.notes.some(note => note.status === 'indexed'), 'initial_actual_capture');
      deadline = Date.now() + duration + 5_000;
      await writeFile(taskFile, `STATIC_TASK_DEADLINE_872\nTARGET_AT=${new Date(deadline).toISOString()}\n这是一份不再修改的合成授权文件。ORIGINAL_TASK_CONTEXT\n`);
      staticFileHash = sha(await readFile(taskFile, 'utf8'));
      const source = (await service!.handle({ type: 'message.send', conversationId: scope.conversationId, clientId: 'main-soak-original-user', delivery: 'queue',
        content: `MAIN_LOOP_SOAK group0 ORIGINAL_TASK_CONTEXT：只读 ${taskFile}，读取其中截止时刻，实际等待并核对宿主当前时钟，达到后报告完成。保持本任务开始时的回忆快照。` })).message!;
      sourceId = source.id; await waitFor(() => providerWires.length >= 2 && loop()?.turns.some(turn => turn.calls.some(call => call.name === 'wait')), 'actual_file_and_wait');
      const runningAt = performance.now(); let nextRead = runningAt, restarted = false;
      while (loop().status !== 'done') {
        if (performance.now() - runningAt > duration + 120_000) throw Error('Actual Main loop did not complete within its bounded deadline.');
        if (performance.now() >= nextRead) {
          await addLesson();
          if (smoke) await service!.manageLearningSources({ type: 'memory.learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
          nextRead += period;
        }
        if (smoke && !restarted && performance.now() - runningAt >= duration / 2) {
          beforeRestart = structuredClone(loop()); expect(beforeRestart.turns[0]!.results).toHaveLength(1);
          await service!.shutdown(); await routed!.close(); store.close(); store = new CompanionsStore(database, seeds); await startMain();
          // The pending wait has no committed result at shutdown. Preserve the
          // production unknown-effect stop gate and use its explicit resume API.
          await service!.handle({ type: 'reply.resume', conversationId: scope.conversationId }); restartCount++; restarted = true;
          await waitFor(() => providerWires.length > 2 && loop().turns.length >= beforeRestart!.turns.length, 'restored_loop'); afterRestart = structuredClone(loop());
          expect(afterRestart.messageId).toBe(beforeRestart.messageId); expect(afterRestart.turns[0]).toEqual(beforeRestart.turns[0]);
        }
        expect(taskRecallCalls).toBe(1); expect(taskPrepareCalls).toBe(1); expect(providerWires.every(wire => wire.recallHash === recallHash)).toBe(true);
        expect(native.processSnapshot().peak).toBeLessThanOrEqual(2); expect(native.processSnapshot().limitViolations).toBe(0);
        await frozen.verifyFrozen(); if (!smoke) await frozen.verifySources();
        checkpoints.push({ at: new Date().toISOString(), taskWallMs: performance.now() - runningAt, turnCount: loop().turns.length, committedResults: loop().turns.filter(turn => !!turn.results).length,
          learningCommitCalls: commands.filter(command => command.type === 'learning.commit').length,
          learningUniqueReceipts: store.request({ type: 'learning.status', companionId: 'alice' }).learning?.reads.length,
          captureCommits: commands.filter(command => command.type === 'memory.jobs.complete').length,
          realMaintenanceCommits: commands.filter(command => command.type === 'world.job.complete' && command.stage === 'real').length, taskRecallCalls, taskPrepareCalls });
        await receipt('running'); await delay(smoke ? 1000 : 10_000);
      }
      expect(Date.now()).toBeGreaterThanOrEqual(deadline); expect(observedDeadline).toBe(deadline); expect(restartCount).toBe(smoke ? 1 : 0); expect(taskRecallCalls).toBe(1); expect(taskPrepareCalls).toBe(1);
      expect(performance.now() - taskStartedAt).toBeGreaterThanOrEqual(duration); expect(sha(await readFile(taskFile, 'utf8'))).toBe(staticFileHash);
      expect(loop().turns.filter(turn => turn.calls.some(call => call.name === 'dsh'))).toHaveLength(1);
      expect(loop().turns.filter(turn => turn.calls.some(call => call.name === 'wait') && turn.results)).not.toHaveLength(0);
      expect(store.getMessage(loop().messageId!).content).toContain(finalReply);
      await waitFor(() => store.request({ type: 'work.list', sourceMessageId: sourceId }).works?.[0]?.status === 'done', 'ordinary_work_completed');
      expect(commands.filter(command => command.type === 'file.result.commit')).toHaveLength(1);
      await waitFor(() => commands.filter(command => command.type === 'learning.commit').length >= 2 && commands.filter(command => command.type === 'memory.jobs.complete').length >= 2, 'concurrent_learning_capture');
      expect(store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads.length).toBeGreaterThanOrEqual(2);
      expect(commands.some(command => command.type === 'world.job.complete' && command.stage === 'real')).toBe(true);
      status = 'passed';
    } catch (error) { failure = error; status = 'failed'; errors.push(String(error)); }
    finally {
      const drain = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failure ??= error; status = 'failed'; errors.push(String(error)); } };
      await drain(async () => service?.shutdown()); await drain(async () => routed?.close()); await drain(() => native.close()); await drain(() => broker.close());
      if (native.processSnapshot().live || broker.snapshot().processes) { status = 'failed'; failure ??= Error('Native child remained after actual exit drain.'); }
      await receipt('closed'); store.close(); transport.request = undefined; transport.fetch = undefined; vi.restoreAllMocks(); await removeOwnedDirectory(root);
    }
    if (failure) throw failure; expect(status).toBe('passed');
  }, Number(process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK_MS ?? (process.env.WORLDLINEBOX_MEMORY_MAIN_SOAK === '1' ? 7_200_000 : 45_000)) + 240_000);

/** Short, separately opt-in acceptance of Main's real passive delta path. The
 * five-second polling loop is disabled; OS notifications and the public recall
 * gate must publish an edited document that was not in the old readset. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_MAIN_DELTA_SMOKE !== '1')('recalls a new external-file topic through real Main/native delta without revoking another task snapshot', async () => {
  const started = performance.now(), root = await mkdtemp(path.join(tmpdir(), 'memory-main-native-delta-'));
  const output = path.resolve('artifacts/vcp-validation/memory-main-native-file-delta.json');
  const receiptPath = output.replace(/\.json$/u, '-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + process.pid + '.json');
  const implementationPaths = ['src/main/companions/service.ts', 'src/main/companions/memory-service.ts', 'src/main/companions/memory-library.ts',
    'src/main/companions/memory-library-dirty.ts', 'src/main/companions/memory-projection-cache.ts', 'src/main/vcp-memory/worker.cjs',
    'src/main/vcp-memory/runtime.cjs', 'src/main/vcp-memory/peripherals.cjs', 'vendor/vcp-memory/upstream-manifest.json', 'vendor/vcp-memory/peripheral-manifest.json'];
  const implementationHashes = async () => Object.fromEntries(await Promise.all(implementationPaths.map(async file => [file, sha(await readFile(file, 'utf8'))])));
  const sourcesBefore = await implementationHashes();
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'DeltaAlice', description: '', persona: '只采用本伙伴实际有据资料。',
    avatar: 'sister', model: '', active: true, proactive: false }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, broker = new VcpMemoryProcessBroker(2);
  const commands: string[] = [], errors: string[] = [], focusBodies: string[] = [], searches: CompanionStorageResponse[] = [];
  const snapshotOrigins: Array<{ commandIndex: number; stack: string }> = [];
  const modelWires: Array<{ keys: string[]; task?: string; memory?: string }> = [];
  let service: CompanionService | undefined, routed: ReturnType<typeof ownerGenerationRuntime> | undefined;
  const raw = async (command: CompanionStorageCommand) => {
    commands.push(command.type);
    if (command.type === 'memory.snapshot') snapshotOrigins.push({ commandIndex: commands.length - 1, stack: new Error('Actual snapshot caller').stack ?? '' });
    return store.request(command);
  };
  transport.request = raw;
  const marker = 'EXTERNAL_NEW_TOPIC_ACTUAL_BODY_915';
  const cutoffRequest = 'MAIN_CUTOFF_BOUNDARY_771', r2Marker = 'PAST_RAW_SOURCE_R2_ALLOWED_661', lateMarker = 'LATE_FILE_SOURCE_MUST_STAY_OUT_662';
  let cutoffContext: unknown, cutoffReplies = 0, releaseCutoff: (() => void) | undefined;
  const provider: typeof fetch = async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    let data: { purpose?: string; taskRequest?: { prompt?: string }; memoryRecall?: { context?: { text: string } } } = {};
    try { data = JSON.parse(wire.messages[1]?.content ?? ''); } catch { /* Native focus uses its original text template. */ }
    modelWires.push({ keys: Object.keys(data), task: data.taskRequest?.prompt, memory: data.memoryRecall?.context?.text });
    if (data.taskRequest?.prompt?.includes(cutoffRequest)) {
      cutoffContext = structuredClone(data.memoryRecall?.context); cutoffReplies++;
      expect(data.memoryRecall?.context?.text).toContain(r2Marker); expect(data.memoryRecall?.context?.text).not.toContain(lateMarker);
      return jsonResponse({ text: 'CUTOFF_CONFIRMED：按真实来源截止线完成本次回复。', memories: [] });
    }
    if (data.purpose === 'companion_social_progress_review') return jsonResponse({ supported: true, correction: '' });
    if (data.purpose === 'vcp_experience_journal') return jsonResponse({ notes: [] });
    if (data.purpose === 'vcp_sleep_reflection') return jsonResponse({ notes: [], dream: null });
    if (data.purpose === 'world_attention') return jsonResponse({ urgency: 'ordinary', confidence: 1, reason: '本次不产生紧急通知。', evidence: [] });
    if (data.purpose === 'world_decision') return jsonResponse({ action: null, reason: '不产生额外行动。', appraisals: [] });
    if (wire.messages[0]?.content.includes('Knowledge Graph Architect')) return jsonResponse('[[Tag: 合成来源]]');
    focusBodies.push(wire.messages.map(message => message.content).join('\n'));
    const observed = [marker, r2Marker, lateMarker].filter(value => focusBodies.at(-1)!.includes(value));
    return jsonResponse(`这是我获取的所有相关知识/记忆[[${observed.join(' ') || 'GROUP0_OLD_SOURCE_FIXED'}]]`);
  };
  transport.fetch = provider;
  const noPolling = vi.spyOn(CompanionMemoryLibrary.prototype, 'start').mockImplementation(() => undefined);
  const sync = vi.spyOn(CompanionMemoryLibrary.prototype, 'sync');
  const search = CompanionMemoryService.prototype.search;
  vi.spyOn(CompanionMemoryService.prototype, 'search').mockImplementation(async function (this: CompanionMemoryService, ...args) {
    const result = await search.apply(this, args); if (args[1] === 'passive') searches.push(result); return result;
  });
  const native = await nativeManagementHarness(root, raw, { processBroker: broker, maxLiveProcesses: 2 });
  let failure: unknown, evidence: Record<string, unknown> = {};
  try {
    const notes = Array.from({ length: 48 }, (_, n) => store.saveMemory({ ...scope, diaryName: '资料', autoTags: false,
      content: `group${n < 8 ? 0 : 2} 独立合成资料${n}：${n < 8 ? '旧任务实际关注蓝伞约定与归还条件。' : '原来只讨论园艺，与新主题无关。'}`, tags: ['fixture_' + n] }));
    routed = ownerGenerationRuntime(root, native.embedding, native.launch, provider, { processBroker: broker, nativeProcessLimit: 2 });
    service = new CompanionService({ userData: root, dataRoot: root, memoryLibraryRoot: path.join(root, '伙伴记忆'),
      workerPath: 'explicit-real-store-transport', appPath: process.cwd(), window: () => undefined, hasConfig: () => true,
      getConfig: () => ({ apiFormat: 'openai_chat', model: 'synthetic-main-native-delta', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-only' }),
      memoryRuntime: routed.runtime, dsh: () => undefined, report: error => errors.push(String(error)) });
    await service.handle({ type: 'state' });
    await (service as unknown as { memory: CompanionMemoryService }).memory.drainDeliveries();
    const cold = performance.now();
    const first = await service.handle({ type: 'memory.recall.test', companionId: 'alice', query: 'group0 蓝伞的旧约定？', mode: 'passive', limit: 2 });
    expect(first.ok).toBe(true); const initial = searches.at(-1)!; expect(initial.ok, initial.error).toBe(true);
    evidence = { first, initial, actualStatus: store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus };
    expect(initial.memoryContext, 'The initial native passive corpus must be nonempty.').toBeDefined();
    const context = structuredClone(initial.memoryContext)!;
    const references = (context.evidence as { references?: Array<{ id: string }> } | undefined)?.references ?? [];
    const selected = new Set(references.map(reference => reference.id));
    const edited = notes.slice(8).find(note => !selected.has(note.id)); expect(edited, 'A real noncandidate is required for this acceptance.').toBeDefined();
    const beforeQueryCount = commands.length, coldMs = performance.now() - cold, changedAt = performance.now();
    await writeFile(path.join(root, '伙伴记忆', 'alice', '资料', edited!.id + '.md'), `group7 ${marker}：新主题天文观测站的资料只存在于这个外部实际文件。`);
    let next: Awaited<ReturnType<CompanionService['handle']>> | undefined, retries = 0;
    for (; retries < 3; retries++) {
      try { next = await service.handle({ type: 'memory.recall.test', companionId: 'alice', query: 'group7 新主题天文观测站的资料？', mode: 'passive', limit: 2 }); break; }
      catch (error) { if (!String(error).includes('记忆在检索期间发生了变化')) throw error; }
    }
    evidence = { ...evidence, next, lastSearch: searches.at(-1), afterEditCommands: commands.slice(beforeQueryCount),
      editedCurrent: store.request({ type: 'memory.library.read', companionId: 'alice', id: edited!.id }).memoryRead?.memory,
      snapshotOrigins: snapshotOrigins.filter(origin => origin.commandIndex >= beforeQueryCount),
      filePreparation: (service as unknown as { memoryLibrary: CompanionMemoryLibrary }).memoryLibrary.ownerFilePreparationStatus('alice') };
    expect(next?.ok).toBe(true); expect(next?.memoryProbe?.contextText).toContain(marker);
    expect(retries).toBe(0);
    expect(focusBodies.some(body => body.includes(marker))).toBe(true);
    expect(commands.slice(beforeQueryCount)).toContain('memory.save');
    expect(snapshotOrigins.filter(origin => origin.commandIndex >= beforeQueryCount && /CompanionMemoryService\.searchView/u.test(origin.stack))).toEqual([]);
    const memory = (service as unknown as { memory: CompanionMemoryService }).memory;
    const diagnosticScope = store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation!.id;
    expect(await memory.contextValid({ companionId: 'alice', conversationId: diagnosticScope }, context)).toBe(true);
    expect(sha(context)).toBe(sha(initial.memoryContext)); expect(noPolling).toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
    evidence = { actualMain: true, actualSQLite: true, actualNativeRust: true, actualCanonicalFiles: true,
      utilityIpc: 'real-store adapter', chatAndVectors: 'controlled deterministic transports', pollingEnabled: false,
      actualWallMs: performance.now() - started, coldMs, editedTopicToSuccessfulRecallMs: performance.now() - changedAt,
      corpusSize: notes.length, originalSelected: [...selected], editedId: edited!.id, editedWasOutsideReadset: true,
      oldContextStillValid: true, firstProbeRetryCount: retries, focusSawActualFileSentinel: true,
      afterEditCommands: commands.slice(beforeQueryCount), native: native.processSnapshot(), errors };
    evidence.snapshotOrigins = snapshotOrigins.filter(origin => origin.commandIndex >= beforeQueryCount);
    // Pause only test orchestration, after a real user message/work exists and
    // before its actual initial recall. Production sequence/ACL logic remains
    // unchanged. A revision based on a past raw source belongs in this window;
    // a newly registered file source after the message does not.
    const past = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user',
      content: `group8 ${r2Marker}：此前真实材料已经包含这项天文观察，来源编号保持不变。`, replyDirective: 'none' });
    const r1 = store.request({ type: 'memory.record', ...scope, candidate: { diaryName: '资料', content: 'group2 以前阅读过的材料暂存于旧主题概述。',
      tags: ['合成独立来源'], sourceMessageIds: [past.id], evidence: [{ sourceMessageId: past.id, quote: past.content }] } }).memories![0]!;
    await service.handle({ type: 'memory.read', ...scope, id: r1.id, sourceLimit: 100 });
    await memory.drainOwnerDeliveries('alice');
    let actualCutoff = 0;
    const cutoffGate = new Promise<void>(resolve => { releaseCutoff = resolve; });
    const originalRecall = CompanionMemoryService.prototype.recall;
    vi.spyOn(CompanionMemoryService.prototype, 'recall').mockImplementation(async function (this: CompanionMemoryService, input) {
      if (input.currentMessage.content.includes(cutoffRequest)) { actualCutoff = input.currentMessage.sequence; await cutoffGate; }
      return originalRecall.call(this, input);
    });
    const taskMessage = (await service.handle({ type: 'message.send', conversationId: scope.conversationId, clientId: 'actual-main-cutoff-771', delivery: 'queue',
      content: `${cutoffRequest} group8 请根据本次开始时已经存在的实际来源说明天文观察，不使用之后才登记的未来资料。` })).message!;
    await vi.waitFor(() => expect(actualCutoff).toBe(taskMessage.sequence), { timeout: 30000 });
    const exact = (await service.handle({ type: 'memory.read', ...scope, id: r1.id, sourceLimit: 100 })).memoryRead!.memory;
    const r2 = store.request({ type: 'memory.revise', ...scope, id: r1.id, expectedVersion: exact.version, candidate: {
      diaryName: '资料', content: past.content, tags: ['合成独立来源'], sourceMessageIds: [past.id], evidence: [{ sourceMessageId: past.id, quote: past.content }] } }).memories![0]!;
    await service.handle({ type: 'memory.read', ...scope, id: r2.id, sourceLimit: 100 });
    await writeFile(path.join(root, '伙伴记忆', 'alice', '资料', '晚登记外部资料.md'), `group8 ${lateMarker}：这份新文件是在本次用户消息之后才正式登记。`);
    await (service as unknown as { memoryLibrary: CompanionMemoryLibrary }).memoryLibrary.prepareOwnerFiles('alice');
    const late = store.request({ type: 'memory.list', companionId: 'alice' }).memories!.find(note => note.content.includes(lateMarker))!;
    expect(past.sequence).toBeLessThan(actualCutoff); expect(r2.sources.every(source => source.sequence < actualCutoff)).toBe(true);
    expect(late).toBeDefined(); expect(late.sources.every(source => source.sequence > actualCutoff)).toBe(true);
    releaseCutoff!();
    await vi.waitFor(() => {
      const work = store.request({ type: 'work.list', sourceMessageId: taskMessage.id }).works?.[0];
      evidence.cutoffDebug = { work, loop: store.request({ type: 'loop.get', sourceMessageId: taskMessage.id, companionId: 'alice' }).loop,
        cutoffReplies, cutoffContext, modelWires, errors };
      expect(work?.status).toBe('done');
    }, { timeout: 30000 });
    expect(cutoffReplies).toBe(1); expect(cutoffContext).toBeDefined();
    const cutoffEvidence = (cutoffContext as { evidence?: { references?: Array<{ id: string; version: number; sources: Array<{ messageId: string; revision: number }> }> } }).evidence;
    const fixedRawSource = r2.sources.find(source => source.messageId === past.id)!;
    expect(fixedRawSource.sequence).toBe(past.sequence); expect(fixedRawSource.checksum).toBe(sha(past.content));
    expect(cutoffEvidence?.references).toEqual(expect.arrayContaining([expect.objectContaining({ id: r2.id, version: r2.version,
      sources: expect.arrayContaining([expect.objectContaining({ messageId: past.id, revision: fixedRawSource.revision })]) })]));
    expect(cutoffEvidence?.references?.some(reference => reference.id === late.id)).toBe(false);
    const savedLoop = store.request({ type: 'loop.get', sourceMessageId: taskMessage.id, companionId: 'alice' }).loop!;
    const savedRecall = JSON.parse(savedLoop.context!.user).memoryRecall.context;
    const fixedDependencies = companionMemoryContextDependencies(savedRecall);
    expect(fixedDependencies.frozenMemories).toEqual(expect.arrayContaining([expect.objectContaining({ id: r2.id, contentRevision: r2.contentRevision,
      sources: expect.arrayContaining([expect.objectContaining({ id: past.id, checksum: sha(past.content) })]) })]));
    expect(fixedDependencies.frozenMemories?.some(note => note.id === late.id)).toBe(false);
    evidence.cutoff = { realMessageId: taskMessage.id, actualCutoff, pastSourceSequence: past.sequence, existingRevision: r2.contentRevision,
      existingSourceSequenceUnchanged: true, lateSourceSequences: late.sources.map(source => source.sequence), providerReplies: cutoffReplies,
      context: cutoffContext, completedByActualMainLoop: true };
    evidence.topicPhaseWallMs = evidence.actualWallMs; evidence.actualWallMs = performance.now() - started;
    delete evidence.cutoffDebug;
  } catch (error) { failure = error; errors.push(String(error)); }
  finally {
    releaseCutoff?.();
    await service?.shutdown(); await routed?.close(); await native.close(); await broker.close();
    await mkdir(path.dirname(output), { recursive: true });
    const receipt = JSON.stringify({ status: failure ? 'failed' : 'passed', receiptPath, ...evidence, errors, drainedNative: native.processSnapshot() }, null, 2);
    const sourcesAfter = await implementationHashes();
    const withImplementation = JSON.stringify({ ...JSON.parse(receipt), implementation: { frozen: false, baselineOnly: true,
      loadedServiceFunctionHash: sha(CompanionService.toString()), loadedSearchFunctionHash: sha(search.toString()),
      sourcesBefore, sourcesAfter, sourcesChangedDuringRun: sha(sourcesBefore) !== sha(sourcesAfter) } }, null, 2);
    await writeFile(receiptPath, withImplementation, { flag: 'wx' }); await writeFile(output, withImplementation);
    store.close(); transport.request = undefined; transport.fetch = undefined; vi.restoreAllMocks(); await removeOwnedDirectory(root);
  }
  if (failure) throw failure;
}, 180000);
