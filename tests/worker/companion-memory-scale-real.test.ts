import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import { generateCompanionReply, generateCompanionText } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { MEMORY_SCALE_CORPUS_VERSION, memoryScaleCorpus } from '../fixtures/companion-memory-scale-corpus';
import type { CompanionMemory } from '../../src/shared/companions';
import type { VcpMemoryNote } from '../../src/main/vcp-memory/contracts';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
type Retrieval = { queryId: string; category: string; query: string; expectedKeys: string[]; keys: string[];
  firstRelevantRank: number | null; reciprocalRank: number; recallAt1: number; recallAt5: number; recallAt10: number;
  latencyMs: number; degraded: boolean; error?: string; hits: unknown[]; contextLength: number; context?: string; diagnostics?: unknown };
type Answer = { queryId: string; query: string; noAnswer: boolean; context: string; answer: string;
  requiredSurfaceChecks: boolean[]; passedSurfaceCheck: boolean; latencyMs: number; error?: string };
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { count: sorted.length, min: sorted[0] ?? 0, p50: at(.5), p95: at(.95), max: sorted.at(-1) ?? 0 };
};
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
async function sampledProcesses() {
  const host = { pid: process.pid, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed };
  if (process.platform !== 'win32') return { host, descendants: null, limitation: 'Only host process RSS available on this platform.' };
  const command = `$items=Get-CimInstance Win32_Process; $ids=@(${process.pid}); for($i=0;$i -lt 4;$i++){ $ids=@($ids+@($items | Where-Object { $ids -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId) | Sort-Object -Unique) }; @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`;
  const descendants = await new Promise<unknown>(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => { try { resolve(error ? null : JSON.parse(stdout)); } catch { resolve(null); } }));
  return { host, descendants, limitation: 'Sampled host/descendant Windows working sets, not continuous peak RSS; GPU VRAM is not measured.' };
}

/** This is a measured quality evaluation, not an assertion that all retrievals
 * succeed. Initial misses, wrong ranks and answer failures remain in the report.
 */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_SCALE_REAL !== '1')('measures the real 1024-document cross-domain owner corpus without hiding retrieval or answer failures', async () => {
  const corpus = memoryScaleCorpus(), corpusJson = JSON.stringify(corpus), corpusHash = createHash('sha256').update(corpusJson).digest('hex');
  expect(corpus.documents).toHaveLength(1024); expect(corpus.queries).toHaveLength(72);
  expect(new Set(corpus.documents.map(document => document.key)).size).toBe(1024);
  expect(corpus.queries.filter(query => query.passive)).toHaveLength(24);
  const outputRoot = path.resolve(process.env.WORLDLINEBOX_MEMORY_SCALE_OUTPUT ?? 'artifacts/vcp-validation/large-memory-initial');
  await mkdir(outputRoot, { recursive: true });
  const existingReport = await access(path.join(outputRoot, 'report.json')).then(() => true, () => false);
  if (existingReport) throw new Error('Preserve existing evaluation results. Set WORLDLINEBOX_MEMORY_SCALE_OUTPUT to a fresh directory.');
  // Freeze the complete corpus and gold *before* any model or retrieval call.
  await writeFile(path.join(outputRoot, 'corpus.json'), JSON.stringify({ version: MEMORY_SCALE_CORPUS_VERSION, corpusHash, ...corpus }, null, 2));
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-large-memory-real-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-large-memory-real-')) throw new Error('Unsafe scale fixture cleanup.');
  const config = await realGlobalChatConfig(root);
  const seeds = [{ id: 'examiner', name: '星野', persona: '你是星野，是独立虚拟伙伴。只根据真实给定记忆回答，区分人物、旧约定、失败回执、个人认识和梦境。' },
    { id: 'peerone', name: '小樱', persona: '你是小樱，只拥有自己的经历，不知道别人未告诉你的事。' },
    { id: 'peertwo', name: '小葵', persona: '你是小葵，不冒认其他伙伴的记忆。' },
    { id: 'autocapture', name: '月见', persona: '你是月见，谨慎温和，只记录值得长久记住的真实信息。' }];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds.map(seed => ({ ...seed,
    description: '独立合成验收伙伴', model: '', avatar: 'sister', active: true, proactive: false })));
  const errors: string[] = [], modelCalls: Array<{ purpose: string; headerLatencyMs: number }> = [], embeddings = { calls: 0, documents: 0, queries: 0, milliseconds: 0 };
  const retrievals: Retrieval[] = [], answers: Answer[] = [], processSamples: unknown[] = [];
  let progress: Record<string, unknown> = { phase: 'initializing', corpusHash, documents: 1024, queries: 72, completedQueries: 0 };
  const checkpoint = async (patch: Record<string, unknown>) => { progress = { ...progress, ...patch, updatedAt: new Date().toISOString() };
    await writeFile(path.join(outputRoot, 'progress.json'), JSON.stringify(progress, null, 2)); };
  const fetchFn: typeof fetch = async (input, init) => {
    let purpose = 'original_vcp';
    try { const body = JSON.parse(String(init?.body)); purpose = JSON.parse(body.messages?.[1]?.content ?? '{}').purpose ?? purpose; } catch { /* Original native VCP prompt has its own format. */ }
    const started = performance.now(), response = await fetch(input, init);
    modelCalls.push({ purpose, headerLatencyMs: performance.now() - started }); return response;
  };
  const native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { fetchFn, timeoutMs: 90000 }), { modelFetch: fetchFn });
  const embed = native.encoder.embed.bind(native.encoder);
  vi.spyOn(native.encoder, 'embed').mockImplementation(async (...args) => {
    const started = performance.now(), result = await embed(...args);
    embeddings.calls++; embeddings[args[1].purpose === 'query' ? 'queries' : 'documents'] += args[0].length;
    embeddings.milliseconds += performance.now() - started; return result;
  });
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => {
    const response = store.request(command); if (response.worldClock) response.worldClock.backlog = false; return response;
  };
  const service = new CompanionMemoryService({ request, configFor: async () => config, runtime: native.runtime,
    cacheRoot: path.join(root, 'views'), fetchFn, busy: () => true, changed: () => undefined,
    report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), status: 'running', corpusVersion: MEMORY_SCALE_CORPUS_VERSION,
    corpusHash, declaredDocuments: 1024, declaredGoldQueries: 72, chatModel: config.model, embeddingProfile: native.profile,
    realBundledEmbedding: true, originalVcp: true, publicServiceSearchUsed: true, modelCalls, embeddings, retrievals, answers, errors, processSamples,
    limitations: ['Synthetic corpus with 8 authored themes and 16 near-distractor variants per category; this is not an independently sampled public benchmark.',
      'The large corpus is authored source-backed memory text, not 1024 automatically learned chat conclusions. A separate small representative batch measures actual selective automatic journaling.',
      'This evaluation is text-only. It does not establish image/audio/video retrieval quality or model quality on every real user library.',
      'Gold note retrieval, focused context coverage, and actual answer surface checks are reported separately. Surface checks are conservative diagnostic checks, not complete semantic proof.',
      'Model header response timings exclude streamed body generation; end-to-end query/answer timings include awaited processing.',
      'Sampled process working sets are not a continuous memory peak and do not include GPU VRAM.'] };
  report.runtimeVersions = { node: process.versions.node, electron: process.versions.electron };
  report.implementationHashes = Object.fromEntries(await Promise.all([
    'tests/fixtures/companion-memory-scale-corpus.ts', 'tests/worker/companion-memory-scale-real.test.ts',
    'src/main/companions/context.ts', 'src/main/companions/memory-grounding.ts', 'src/main/companions/memory-service.ts',
    'src/main/vcp-embedding-gateway.ts', 'src/main/embedding-global-service.ts', 'src/main/vcp-memory/runtime.cjs',
    'vendor/vcp-memory/KnowledgeBaseManager.js', 'vendor/vcp-memory/RiverMemoEngine.js', 'vendor/vcp-memory/upstream-manifest.json',
  ].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  const notesByKey = new Map<string, CompanionMemory>(), keyById = new Map<string, string>();
  try {
    await checkpoint({ phase: 'automatic_capture_subset' }); processSamples.push({ phase: 'baseline', ...await sampledProcesses() });
    const autoRoom = store.openPrivate('autocapture'), autoSources = [
      '早上好呀。', '嗯嗯，哈哈。', '我第一次介绍自己：我叫青遥，以后请叫我青遥，这是我自己的名字。',
      '我以前说完全不喝咖啡不准确；白天仍喝淡咖啡，只是晚上不喝。',
      '虚构世界里，我们约周六下午三点在图书馆东门集合；这是计划，还没有出门。',
      '我实际提供给你的学习材料是：薄荷盆土表层两厘米干后再少量浇水，仍湿则跳过；这是材料建议，不证明长期验证过。',
      '合成任务回执：二十张照片已经筛选，但只读限制没有允许删除，原图没有删除。',
      '我现在只是在测试梦境区分：纸船飞去月亮是虚构故事，不是我实际做过的事。',
      'Please remember this current arrangement: the borrowed umbrella is due back on Wednesday at the library.',
      '刚才关于名字和晚间咖啡的说法都不变，不是新约定。',
    ].map(content => store.appendMessage({ conversationId: autoRoom.id, authorId: 'user', content, replyDirective: 'none' }));
    const capture = new CompanionMemoryService({ request, configFor: async () => config,
      runtime: { get: () => native.runtime.get(), describeEmbedding: () => native.runtime.describeEmbedding(),
        describeGeneration: selection => native.runtime.describeGeneration(selection),
        acquireGeneration: selection => native.runtime.acquireGeneration(selection),
        interruptOwner: ownerId => native.runtime.interruptOwner(ownerId),
        purgeOwner: (ownerId, scopes) => native.runtime.purgeOwner(ownerId, scopes),
        close: async () => undefined }, cacheRoot: path.join(root, 'auto-views'), fetchFn,
      busy: () => false, changed: () => undefined, report: error => errors.push(String(error)) });
    try {
      capture.schedule(0);
      await vi.waitFor(() => {
        const status = store.request({ type: 'memory.status', companionId: 'autocapture' }).memoryStatus!;
        expect(status.failed, errors.join('\n')).toBe(0); expect(status.pending + status.running + status.pendingIndex).toBe(0);
        expect(status.indexed).toBeGreaterThan(0);
      }, { timeout: 180000, interval: 200 });
      const actual = store.listMemory('autocapture');
      report.automaticCaptureSubset = { sourceCount: autoSources.length, sourceIds: autoSources.map(source => source.id), noteCount: actual.length,
        notes: actual.map(note => ({ id: note.id, content: note.content, tags: note.tags, sources: note.sources.map(source => source.messageId) })),
        greetingOnlySourcesNotCaptured: !actual.some(note => note.sources.some(source => autoSources.slice(0, 2).some(greeting => greeting.id === source.messageId))) };
    } finally { await capture.close(); }

    const ownerRoom = store.openPrivate('examiner');
    const group = store.createConversation('多来源共同经历', ['examiner', 'peerone', 'peertwo']);
    const peer = store.request({ type: 'social.conversation.ensure', companionId: 'examiner', memberIds: ['examiner', 'peerone'] }).socialConversation!;
    const entrances = { private: ownerRoom.id, group: group.id, peer: peer.id };
    await checkpoint({ phase: 'creating_source_backed_corpus' });
    const creationStarted = performance.now();
    for (const document of corpus.documents) {
      const conversationId = entrances[document.entrance], authorId = document.entrance === 'peer' ? 'peerone' : 'user';
      const source = store.appendMessage({ conversationId, authorId, content: document.text, replyDirective: 'none' });
      const note = store.request({ type: 'memory.record', companionId: 'examiner', conversationId, candidate: {
        content: document.text, diaryName: document.notebook, tags: document.tags, occurredAt: document.occurredAt,
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
        metadata: { fixtureKey: document.key, corpusVersion: MEMORY_SCALE_CORPUS_VERSION, synthetic: true, ...(document.dream ? { dream: true, simulation: true } : {}) },
      } }).memories![0]!;
      notesByKey.set(document.key, note); keyById.set(note.id, document.key);
    }
    const wrongOwnerNotes: CompanionMemory[] = [];
    for (const companionId of ['peerone', 'peertwo']) {
      const room = store.openPrivate(companionId);
      for (let n = 0; n < 16; n++) {
        const text = `${companionId}的独立合成私聊记录：只有这位伙伴实际听到的私有纪念物叫“孤星藏品${n}号”，放在未向星野公开的抽屉中。`;
        const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: text, replyDirective: 'none' });
        const note = store.request({ type: 'memory.record', companionId, conversationId: room.id,
          candidate: { content: text, diaryName: '独立日记', tags: [companionId, '私有纪念物'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: text }] } }).memories![0]!;
        wrongOwnerNotes.push(note);
      }
    }
    report.sourceBackedCreationMs = performance.now() - creationStarted;
    report.authoredNoteCount = notesByKey.size; report.otherOwnerNoteCount = wrongOwnerNotes.length;
    report.categoryCounts = Object.fromEntries([...new Set(corpus.documents.map(document => document.category))].map(category => [category, corpus.documents.filter(document => document.category === category).length]));
    expect(store.request({ type: 'memory.snapshot', companionId: 'examiner', conversationId: ownerRoom.id }).memorySnapshot?.notes).toEqual([]);
    report.queuedNotesNotYetRecallable = true;

    await checkpoint({ phase: 'native_indexing', indexedDocuments: 0 });
    const indexStarted = performance.now(), batches = new Map<string, CompanionMemory[]>();
    for (const note of [...notesByKey.values(), ...wrongOwnerNotes]) batches.set(note.scopeId, [...(batches.get(note.scopeId) ?? []), note]);
    let indexedDocuments = 0;
    for (const [scopeId, notes] of batches) {
      const owner = store.state().companions.find(owner => owner.id === notes[0]!.companionId)!, identity = companionMemoryIdentity(owner);
      const nativeNotes: VcpMemoryNote[] = notes.map(note => ({ id: note.id, content: note.content, tags: note.tags, diaryName: note.diaryName,
        author: identity.agentName, occurredAt: note.occurredAt, metadata: { ...note.metadata, hostMemoryOwner: identity } }));
      for (let through = 64; through < notes.length + 64; through += 64) {
        const count = Math.min(through, notes.length), result = await native.client.replace({ scopeId }, nativeNotes.slice(0, count));
        expect(result.count).toBe(count);
        await checkpoint({ phase: 'native_indexing', indexedDocuments: indexedDocuments + count, totalIndexedTarget: 1056, embeddingInputs: embeddings.documents });
      }
      indexedDocuments += notes.length;
    }
    let acknowledgements = 0;
    for (;;) {
      const job = store.request({ type: 'memory.outbox.claim', leaseMs: 600000 }).memoryOutbox;
      if (!job) break;
      // Every ID is already physically indexed in this exact original source
      // scope by the successful native replacement above.
      store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); acknowledgements++;
    }
    report.canonicalIndexMs = performance.now() - indexStarted; report.acknowledgements = acknowledgements;
    report.afterCanonicalEmbeddingInputs = { ...embeddings }; report.afterCanonicalGatewayCache = native.gateway.cacheSnapshot();
    const snapshot = store.request({ type: 'memory.snapshot', companionId: 'examiner', conversationId: group.id }).memorySnapshot!;
    expect(snapshot.notes).toHaveLength(1024); report.indexedPrimaryCount = snapshot.notes.length;
    processSamples.push({ phase: 'after_canonical_index', ...await sampledProcesses() });
    await writeFile(path.join(outputRoot, 'note-map.json'), JSON.stringify({ corpusHash, notes: [...notesByKey].map(([key, note]) => ({ key, id: note.id, version: note.version, sourceIds: note.sources.map(source => source.messageId), scopeId: note.scopeId })) }, null, 2));

    for (const [index, query] of corpus.queries.entries()) {
      await checkpoint({ phase: 'active_retrieval', completedQueries: index, currentQuery: query.id });
      const started = performance.now();
      try {
        const result = await service.search({ companionId: 'examiner', conversationId: index % 2 ? group.id : peer.id, query: query.text, limit: 20 }, 'active');
        const hits = result.memoryPage?.items ?? [], keys = hits.map(hit => keyById.get(hit.memory.id) ?? 'FOREIGN_OR_UNKNOWN');
        const rank = keys.findIndex(key => query.expectedKeys.includes(key));
        const recall = (k: number) => query.expectedKeys.length ? query.expectedKeys.filter(key => keys.slice(0, k).includes(key)).length / query.expectedKeys.length : 0;
        retrievals.push({ queryId: query.id, category: query.category, query: query.text, expectedKeys: query.expectedKeys, keys,
          firstRelevantRank: rank < 0 ? null : rank + 1, reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1), recallAt1: recall(1), recallAt5: recall(5), recallAt10: recall(10),
          latencyMs: performance.now() - started, degraded: hits.some(hit => hit.reasons.includes('原生召回已降级')),
          hits: hits.slice(0, 20).map(hit => ({ id: hit.memory.id, key: keyById.get(hit.memory.id), owner: hit.memory.companionId, score: hit.score, scoreDetails: hit.scoreDetails })),
          contextLength: result.memoryContext?.text.length ?? 0, context: result.memoryContext?.text ?? '', diagnostics: result.memoryRetrieval });
        expect(hits.every(hit => hit.memory.companionId === 'examiner')).toBe(true);
      } catch (error) {
        retrievals.push({ queryId: query.id, category: query.category, query: query.text, expectedKeys: query.expectedKeys, keys: [], firstRelevantRank: null,
          reciprocalRank: 0, recallAt1: 0, recallAt5: 0, recallAt10: 0, latencyMs: performance.now() - started, degraded: true,
          error: error instanceof Error ? error.message : String(error), hits: [], contextLength: 0 });
      }
      if (index === 0) { report.afterColdFirstEmbeddingInputs = { ...embeddings }; report.afterColdFirstGatewayCache = native.gateway.cacheSnapshot(); }
      await writeFile(path.join(outputRoot, 'retrievals-initial.json'), JSON.stringify({ corpusHash, retrievals }, null, 2));
    }
    processSamples.push({ phase: 'after_all_active_queries', ...await sampledProcesses() });
    const companion = store.state().companions.find(owner => owner.id === 'examiner')!;
    let passiveIndex = 0;
    for (const query of corpus.queries.filter(query => query.passive)) {
      await checkpoint({ phase: 'passive_context_and_actual_answer', completedQueries: 72, completedPassive: passiveIndex, currentQuery: query.id });
      const started = performance.now();
      try {
        const focused = await service.search({ companionId: companion.id, conversationId: group.id, query: query.text, limit: 12 }, 'passive');
        // Ask the focused owner in its real private entrance, so group PASS
        // coordination cannot be mistaken for a memory-content failure. Native
        // passive retrieval above still entered through the separate group.
        const message = store.appendMessage({ conversationId: ownerRoom.id, authorId: 'user', content: query.text, replyDirective: 'none' });
        const hits = focused.memoryPage?.items ?? [];
        const answer = await generateCompanionReply({ companion, conversation: ownerRoom, messages: [message], sourceMessage: message,
          memories: hits.map(hit => hit.memory), memoryRecall: { reasons: hits.map(hit => ({ id: hit.memory.id, version: hit.memory.version, reasons: hit.reasons, path: hit.path })),
            context: focused.memoryContext, pending: false, degraded: hits.some(hit => hit.reasons.includes('原生召回已降级')) } }, config, undefined, { fetchFn, timeoutMs: 90000 });
        const normalized = normalize(answer.text), checks = query.required.map(alternatives => alternatives.some(fragment => normalized.includes(normalize(fragment))));
        answers.push({ queryId: query.id, query: query.text, noAnswer: !!query.noAnswer, context: focused.memoryContext?.text ?? '', answer: answer.text,
          requiredSurfaceChecks: checks, passedSurfaceCheck: checks.every(Boolean) && !(query.forbidden ?? []).some(fragment => normalized.includes(normalize(fragment))), latencyMs: performance.now() - started });
      } catch (error) { answers.push({ queryId: query.id, query: query.text, noAnswer: !!query.noAnswer, context: '', answer: '', requiredSurfaceChecks: [],
        passedSurfaceCheck: false, latencyMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) }); }
      passiveIndex++; await writeFile(path.join(outputRoot, 'answers-initial.json'), JSON.stringify({ corpusHash, answers }, null, 2));
    }
    const wrong = await service.search({ companionId: 'examiner', conversationId: peer.id, query: '孤星藏品放在什么位置？', limit: 20 }, 'passive');
    const privateNote = notesByKey.get('identity_0_0')!;
    const peerOwn = await service.search({ companionId: 'peerone', conversationId: peer.id, query: corpus.queries.find(query => query.id === 'gold_identity_0')!.text, limit: 20 }, 'active');
    const forbiddenSource = store.request({ type: 'memory.sources.filter', companionId: 'peerone', conversationId: peer.id, ids: privateNote.sources.map(source => source.messageId) }).memorySources;
    report.ownerIsolation = { primaryHitsAllOwned: retrievals.every(query => !query.keys.includes('FOREIGN_OR_UNKNOWN')),
      otherPrivateSentinelNotInjected: !Array.from({ length: 16 }, (_, n) => `孤星藏品${n}号`).some(sentinel => (wrong.memoryContext?.text ?? '').includes(sentinel)),
      otherOwnerCannotRetrievePrimaryDiary: !peerOwn.memoryPage?.items.some(hit => keyById.has(hit.memory.id)), otherOwnerCannotReadPrimaryPrivateSource: forbiddenSource?.length === 0 };
    expect(report.ownerIsolation).toEqual({ primaryHitsAllOwned: true, otherPrivateSentinelNotInjected: true, otherOwnerCannotRetrievePrimaryDiary: true, otherOwnerCannotReadPrimaryPrivateSource: true });
    await checkpoint({ phase: 'forgetting_and_retraction' });
    const targetQuery = corpus.queries.find(query => query.id === 'gold_identity_0')!, target = notesByKey.get(targetQuery.expectedKeys[0]!)!;
    store.request({ type: 'memory.forget', companionId: 'examiner', conversationId: peer.id, id: target.id }); await service.invalidate('examiner');
    const withdrawn = await service.search({ companionId: 'examiner', conversationId: group.id, query: targetQuery.text, limit: 20 }, 'active');
    report.forgetting = { noteId: target.id, returnedAfterForget: withdrawn.memoryPage?.items.some(hit => hit.memory.id === target.id) ?? false,
      sourceVisibleAfterForget: store.request({ type: 'memory.sources.filter', companionId: 'examiner', conversationId: ownerRoom.id, ids: target.sources.map(source => source.messageId) }).memorySources?.length ?? 0 };
    expect(report.forgetting).toMatchObject({ returnedAfterForget: false, sourceVisibleAfterForget: 0 });
    const positives = retrievals.filter(query => query.expectedKeys.length);
    const summarize = (values: Retrieval[]) => ({ count: values.length, recallAt1: values.reduce((sum, query) => sum + query.recallAt1, 0) / (values.length || 1),
      recallAt5: values.reduce((sum, query) => sum + query.recallAt5, 0) / (values.length || 1), recallAt10: values.reduce((sum, query) => sum + query.recallAt10, 0) / (values.length || 1),
      mrrAt20: values.reduce((sum, query) => sum + query.reciprocalRank, 0) / (values.length || 1), missesAt20: values.filter(query => query.firstRelevantRank === null).map(query => query.queryId) });
    report.retrievalSummary = summarize(positives);
    report.perCategory = Object.fromEntries([...new Set(positives.map(query => query.category))].map(category => [category, summarize(positives.filter(query => query.category === category))]));
    report.answerSummary = { count: answers.length, passedSurfaceChecks: answers.filter(answer => answer.passedSurfaceCheck).length,
      noAnswerCount: answers.filter(answer => answer.noAnswer).length, noAnswerChecksPassed: answers.filter(answer => answer.noAnswer && answer.passedSurfaceCheck).length,
      failures: answers.filter(answer => !answer.passedSurfaceCheck).map(answer => answer.queryId),
      meaning: 'Exact answer facts and abstention surface forms; inspect full answers/context to distinguish wording false negatives from semantic errors.' };
    report.latency = { active: quantiles(retrievals.map(query => query.latencyMs)), activeAfterColdFirst: quantiles(retrievals.slice(1).map(query => query.latencyMs)),
      passiveAndFinalAnswer: quantiles(answers.map(answer => answer.latencyMs)), firstQueryIncludesUnifiedOwnerIndexMaterialization: true };
    processSamples.push({ phase: 'finished', ...await sampledProcesses() });
    report.finalGatewayCache = native.gateway.cacheSnapshot();
    report.status = positives.some(query => query.recallAt10 < 1) || answers.some(answer => !answer.passedSurfaceCheck) ? 'completed_with_quality_findings' : 'passed';
    report.completedAt = new Date().toISOString();
    await checkpoint({ phase: 'completed', status: report.status, completedPassive: answers.length });
  } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); await checkpoint({ phase: 'failed', error: report.error }); throw error; }
  finally {
    await service.close(); await native.close(); store.close();
    await writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
    if (process.env.WORLDLINEBOX_MEMORY_SCALE_KEEP_TEMP === '1') await writeFile(path.join(outputRoot, 'retained-temp.json'), JSON.stringify({ root, corpusHash }));
    else await removeOwnedDirectory(root);
  }
}, 1800000);
