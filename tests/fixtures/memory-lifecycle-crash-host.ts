import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemory } from '../../src/shared/companions';
import { fixtureOwnerRuntimePaths } from './owner-runtime-storage';

async function run() {
  const [root, endpoint, phase, mode] = process.argv.slice(2);
  if (!root || !path.isAbsolute(root) || !endpoint || !phase || !['seed', 'resume'].includes(mode!)) throw Error('Invalid isolated crash fixture');
  const keepAlive = setInterval(() => undefined, 60000), database = path.join(root, 'ledger.sqlite');
  const store = new CompanionsStore(database, [{ id: 'alice', name: 'Alice', description: 'Synthetic crash validation', persona: 'Retain actual conditions and unfinished work.',
    model: '', avatar: 'sister', active: true, proactive: false }]);
  if (mode === 'resume') {
    // The host really died. Only lease time is advanced for this bounded test;
    // source/body revisions, model output and journal identities are untouched.
    const db = new (Database as { new(file: string): CompanionConnection })(database);
    try {
      for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox']) db.prepare(`UPDATE ${table} SET lease_until=? WHERE status='running'`).run(Date.now() - 1);
    } finally { db.close(); }
  }
  const rawRequest = async (command: CompanionStorageCommand) => store.request(command);
  const workspaceRoot = path.join(root, '伙伴资产'), vendorRoot = path.resolve('vendor/vcp-memory');
  const profiles = new CompanionAssetProfileStore(workspaceRoot, {
    registryStorage: { request: async command => {
      const response = await rawRequest(command); if (!response.ok) throw new Error(response.error ?? 'Crash fixture registry request failed.'); return response;
    } },
    loadInitialFocusPrompt: () => readFile(path.join(vendorRoot, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8'),
    loadInitialTagPrompt: () => readFile(path.join(vendorRoot, 'Plugin/DailyNote/TagMaster.txt'), 'utf8'),
    loadInitialTimelinePrompts: () => loadInitialTimelinePrompts(vendorRoot),
  });
  const owner = store.state(false).companions.find(owner => owner.id === 'alice')!;
  await profiles.bootstrap(owner);
  const library = new CompanionMemoryLibrary({ libraryDirectory: workspaceRoot, request: rawRequest, profileStore: profiles });
  const sourceFiles = new CompanionMemorySourceFiles({ library }), historyFiles = new CompanionMemoryHistoryFiles({ library });
  const liveFiles = new CompanionMemoryLiveFiles({ library, history: historyFiles });
  const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
  const nativePids = new Set<number>(), outboxes = new Map<string, NonNullable<CompanionStorageResponse['memoryOutbox']>>();
  let modelCalls = 0, mergeId = '', gateReached = false;
  const runtime = new CompanionVcpRuntime({ vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
    resolveOwnerCleanupStorage: fixtureOwnerRuntimePaths(workspaceRoot), resolveOwnerStorage: async ownerId => {
      const current = await profiles.load(ownerId);
      return { ownerId, workspaceRoot, ownerRoot: current.root, indexRoot: path.join(current.root, '.运行', '索引'),
        ownerPrompts: { aimemoTemplate: current.nativeFocusTemplate, timelineTemplate: current.nativeTimelineTemplate, summaryTemplate: current.nativeSummaryTemplate } };
    }, resolveEmbedding: async () => ({ baseUrl: endpoint + '/document', queryBaseUrl: endpoint + '/query', model: 'synthetic-crash-16', dimension: 16, apiKey: 'synthetic-local-vector' }),
    launch: file => {
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH;
      const child = fork(file, [], { execPath: process.execPath, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      nativePids.add(child.pid!); process.send?.({ stage: 'native-launch', nativePids: [...nativePids] });
      child.on('exit', () => { nativePids.delete(child.pid!); });
      return { postMessage: message => { child.send(message as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
    } });
  const notes = (): CompanionMemory[] => {
    const db = new (Database as { new(file: string): CompanionConnection })(database);
    try { return (db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=? ORDER BY id').all('alice') as Array<{ data: string }>).map(row => JSON.parse(row.data) as CompanionMemory); }
    finally { db.close(); }
  };
  const queues = () => {
    const db = new (Database as { new(file: string): CompanionConnection })(database);
    try { return Object.fromEntries(['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_source_outbox', 'companion_memory_history_outbox'].map(table => [table,
      Object.fromEntries((db.prepare(`SELECT status,COUNT(*) AS n FROM ${table} WHERE companion_id=? GROUP BY status`).all('alice') as Array<{ status: string; n: number }>).map(row => [row.status, row.n]))])); }
    finally { db.close(); }
  };
  const flushAssets = async () => {
    for (let page = 0; page < 32 && (await sourceFiles.flush('alice')).pending; page++) { /* Bounded batches yield to the actual publisher. */ }
    for (let page = 0; page < 32 && (await historyFiles.flush('alice')).pending; page++) { /* Finish this tiny fixture's immutable publications. */ }
    await liveFiles.flush('alice');
  };
  const gate = async (stage: string, indexed: CompanionMemory[] | unknown[] = []) => {
    if (mode !== 'seed' || phase !== stage || gateReached) return;
    gateReached = true;
    process.send?.({ stage, journals: notes(), nativeIndexed: indexed, modelCalls,
      capture: store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus, queues: queues(), nativePids: [...nativePids] });
    await new Promise<void>(() => undefined);
  };
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.revision.read') return { ok: true, memories: [await historyFiles.read(command, command.id, command.contentRevision)] };
    if (command.type === 'memory.outbox.complete' && mode === 'seed') {
      const outbox = outboxes.get(command.id);
      if (outbox && (phase === 'partial-native-index' || phase === 'before-publish' && outbox.noteId === mergeId)) {
        const lease = await runtime.get({ ownerId: 'alice' });
        try { await gate(phase, await lease.client.list({ scopeId: `${outbox.scopeId}:kind-${outbox.note.artifactKind}-v2` })); } finally { await lease.release?.(); }
      }
    }
    const response = store.request(command);
    if (response.memoryOutbox) outboxes.set(response.memoryOutbox.id, response.memoryOutbox);
    if (command.type === 'memory.jobs.claim' && response.memoryJob) await gate('claim');
    if (command.type === 'memory.jobs.complete') await gate('commit');
    if (response.memories?.length) await flushAssets();
    if (response.memoryOutbox?.operation === 'remember') {
      await flushAssets();
      response.memoryOutbox.note = (await liveFiles.materialize('alice', [response.memoryOutbox.note])).notes[0]!;
    }
    if (response.memorySnapshot) {
      const materialized = await liveFiles.materialize('alice', response.memorySnapshot.notes);
      response.memorySnapshot = { ...response.memorySnapshot, notes: materialized.notes, fileReceipts: materialized.receipts };
    }
    if (response.memoryCaptureContributions) {
      const materialized = await liveFiles.materialize('alice', response.memoryCaptureContributions.items);
      response.memoryCaptureContributions.items = materialized.notes;
    }
    return response;
  };
  const errors: string[] = [];
  const config = { apiFormat: 'openai_chat' as const, model: 'deterministic-crash-provider', baseUrl: endpoint + '/provider', apiKey: 'synthetic-local-provider',
    resolveAssetContext: async (context: { system: string; user: string }, kind: 'reply' | 'structured' | 'text') => assembleCompanionAssetContext(context, await profiles.load('alice'), kind) };
  const memory = new CompanionMemoryService({ request, runtime, cacheRootFor: async ownerId => path.join(workspaceRoot, ownerId, '.运行', '索引', 'views'),
    validateFiles: (owner, receipts) => liveFiles.validate(owner, receipts), configFor: async () => config,
    prepareFiles: async () => flushAssets(), materializeNotes: (ownerId, notes) => liveFiles.projectionNotes(ownerId, notes),
    canonicalInputs: (scope, notes) => canonicalProjectionInputs(historyFiles, scope, notes, library),
    fetchFn: async (url, init) => { modelCalls++; const response = await fetch(url, init); await response.clone().text(); await gate('model-return'); return response; },
    busy: () => false, changed: () => undefined, report: error => errors.push(String(error)) });
  memory.schedule = () => undefined;
  try {
    let sourceIds: string[];
    if (mode === 'seed') {
      sourceIds = Array.from({ length: 12 }, (_, index) => store.appendMessage({ conversationId: conversation.id, authorId: 'user',
        content: `合成材料${index}：QL-${index}已完成上半部，下半部尚未开始；剩余材料在第${index + 1}层抽屉。`, replyDirective: 'none' }).id);
      await writeFile(path.join(root, 'task.json'), JSON.stringify({ sourceIds }));
    } else sourceIds = (JSON.parse(await readFile(path.join(root, 'task.json'), 'utf8')) as { sourceIds: string[] }).sourceIds;
    await flushAssets();
    await (memory as unknown as { process(): Promise<void> }).process();
    await memory.drainDeliveries();
    if (phase === 'before-publish' && mode === 'seed') {
      const inputs = notes();
      if (inputs.length !== 2 || inputs.some(note => note.status !== 'indexed')) throw Error('Synthetic capture did not publish exactly two originals');
      const sources = store.request({ type: 'memory.sources.filter', ...scope, ids: sourceIds }).memorySources!;
      const result = await request({ type: 'memory.consolidate', ...scope, operationId: 'crash-validation-merge', inputs: inputs.map(note => ({ id: note.id, version: note.version })),
        candidate: { artifactKind: 'episode_memory' as const, content: inputs.map(note => note.content).join('\n'), tags: ['合成验收'], sourceMessageIds: sourceIds,
          evidence: sources.map(source => ({ sourceMessageId: source.id, quote: source.content })) } });
      mergeId = result.memories![0]!.id;
      await writeFile(path.join(root, 'merge.json'), JSON.stringify({ mergeId }));
      await memory.drainDeliveries();
    }
    await flushAssets();
    await memory.drainDeliveries();
    const all = notes(), lease = await runtime.get({ ownerId: 'alice' });
    let nativeIndexed: unknown[];
    try { nativeIndexed = all.length ? await lease.client.list({ scopeId: `${all[0]!.scopeId}:kind-${all[0]!.artifactKind}-v2` }) : []; } finally { await lease.release?.(); }
    const finalQueues = queues(), finalCapture = store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus,
      originals = sourceIds.map(id => store.getMessage(id));
    const current = await liveFiles.materialize('alice', all.filter(note => !note.archivedAt && note.status === 'indexed'));
    for (const note of all) if ((await historyFiles.read(scope, note.id, note.contentRevision!)).content !== note.content) throw Error('Actual historical file does not preserve body');
    const sourceReferences = [...new Map(all.flatMap(note => note.sources).map(source => [source.messageId, source])).values()];
    for (const reference of sourceReferences) if (await sourceFiles.read(scope, reference) !== store.getMessage(reference.messageId).content) throw Error('Actual raw material file mismatch');
    const revokedReference = sourceReferences[0]!, affected = all.find(note => note.sources.some(source => source.messageId === revokedReference.messageId))!;
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [revokedReference.messageId] });
    await flushAssets(); await memory.drainDeliveries();
    let historicalRejected = false, sourceRejected = false;
    try { await historyFiles.read(scope, affected.id, affected.contentRevision!); } catch { historicalRejected = true; }
    try { await sourceFiles.read(scope, revokedReference); } catch { sourceRejected = true; }
    if (!historicalRejected || !sourceRejected) throw Error('Revoked source was revived by file publication');
    process.send?.({ stage: 'complete', journals: all, nativeIndexed, modelCalls, errors, sourceIds, queues: finalQueues,
      filesChecked: { current: current.notes.length, history: all.length, sources: sourceReferences.length },
      afterRevocation: { historicalRejected, sourceRejected, queues: queues() },
      originals, capture: finalCapture, nativePids: [...nativePids] });
  } catch (error) { process.send?.({ stage: 'fatal', error: error instanceof Error ? error.message : String(error), nativePids: [...nativePids], errors }); process.exitCode = 1; }
  finally { clearInterval(keepAlive); await memory.close(); await library.close(); await runtime.close(); store.close(); }
}
void run().catch(error => { process.send?.({ stage: 'fatal', error: String(error) }); process.exitCode = 1; });
