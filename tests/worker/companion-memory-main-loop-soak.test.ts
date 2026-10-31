import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { companionMemoryContextDependencies } from '../../src/main/companions/memory-context-evidence';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
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
const jsonResponse = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });

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
    const r1 = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, diaryName: '资料', content: 'group2 以前阅读过的材料暂存于旧主题概述。',
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
    const r2 = store.request({ type: 'memory.revise', ...scope, id: r1.id, expectedVersion: exact.version, candidate: { artifactKind: 'episode_memory' as const,
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
