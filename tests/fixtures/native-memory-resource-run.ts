import { createHash } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import type { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import type { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import type { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import type { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import type { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { restoredCompanionTaskRecall } from '../../src/main/companions/task-passive-recall';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';

export interface NativeMemoryResourceConfig { notes: number; owners: number; activeOwners: number; samples: number; phaseLimitMs: number; dimension: number;
  implementation?: { workerPath: string; vendorRoot: string; manifestFile: string; manifestSha256: string } }
interface Ports { store: CompanionsStore; memory: CompanionMemoryService; runtime: CompanionVcpRuntime; liveFiles: CompanionMemoryLiveFiles;
  profiles: CompanionAssetProfileStore; sourceFiles: CompanionMemorySourceFiles; historyFiles: CompanionMemoryHistoryFiles;
  endpoint: string; config: NativeMemoryResourceConfig; emit(value: Record<string, unknown>): void;
  measureQuery(operation: () => Promise<CompanionStorageResponse>, startedAt: number): Promise<CompanionStorageResponse & { localPreparationMs: number; preparationBoundary: string }> }
export async function runNativeMemoryResourceScenario(stage: 'seed' | 'run', ports: Ports) {
  const { store, memory, runtime, liveFiles, profiles, sourceFiles, historyFiles, endpoint, config, emit } = ports;
  if (![config.notes, config.owners, config.activeOwners, config.samples, config.phaseLimitMs, config.dimension].every(value => Number.isSafeInteger(value) && value > 0)
    || config.activeOwners > config.owners || config.notes > 100000 || config.owners > 1000 || config.phaseLimitMs > 600000 || config.dimension > 4096) throw new Error('Invalid bounded native memory benchmark configuration.');
  const phase = async <T>(name: string, operation: () => Promise<T>) => {
    emit({ stage: 'phase', phase: name, limitMs: config.phaseLimitMs, state: 'running' }); await immediate();
    const started = performance.now();
    try { const value = await operation(); emit({ stage: 'phase-complete', phase: name, elapsedMs: performance.now() - started, resources: memory.resourceSnapshot() }); return value; }
    catch (error) { emit({ stage: 'phase-failed', phase: name, elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === 'object' && 'memoryFilePreparation' in error ? { memoryFilePreparation: error.memoryFilePreparation } : {}) }); throw error; }
  };
  const owners = store.state(false, { includeConversations: false }).companions, active = owners.slice(0, config.activeOwners);
  const rooms = active.map(owner => store.openPrivate(owner.id));
  const scope = { companionId: 'alice', conversationId: rooms[0]!.id };
  if (stage === 'seed') {
    await phase('owner_asset_initialization', async () => {
      for (let offset = 0; offset < owners.length; offset += 4) await Promise.all(owners.slice(offset, offset + 4).map(owner => profiles.bootstrap(owner)));
      emit({ stage: 'owner-assets-initialized', owners: owners.length, activeOwners: active.length, inactiveOwnersOpenedNativeProcesses: false });
    });
    await phase('source_backed_ledger_ingestion', async () => {
      const hash = createHash('sha256');
      for (let ownerIndex = 0; ownerIndex < active.length; ownerIndex++) {
        const owner = active[ownerIndex]!, count = ownerIndex === 0 ? config.notes : 8;
        for (let index = 0; index < count; index++) {
          const group = index % 16, content = `group${group} Synthetic verified source ${index} for ${owner.id}: blue umbrella return Wednesday; the agreement is unfinished. Revision marker item_${index}.`;
          hash.update(content); store.saveMemory({ companionId: owner.id, conversationId: rooms[ownerIndex]!.id, content,
            tags: [`group${group}`, 'umbrella', `item_${index}`], diaryName: '资料' });
          if (index % 64 === 0) { emit({ stage: 'ingestion-progress', owner: owner.id, indexed: index, target: count }); await immediate(); }
        }
      }
      emit({ stage: 'corpus', seedHash: hash.digest('hex'), notes: config.notes, owners: config.owners, activeOwners: config.activeOwners,
        authoredSourceBacked: true, automaticEncodingQuality: false });
    });
    await phase('canonical_file_publication', async () => {
      for (const owner of active) {
        await profiles.bootstrap(owner); let cursor = 0;
        for (;;) { const result = await liveFiles.flush(owner.id, { limit: 64, cursor, reconcile: false });
          emit({ stage: 'publication-progress', owner: owner.id, cursor, checked: result.checked, pending: result.pending });
          if (!result.pending) break; cursor = result.nextCursor!;
        }
      }
    });
    await phase('canonical_original_and_history_publication', async () => {
      for (const owner of active) {
        while ((await sourceFiles.flush(owner.id)).pending) { emit({ stage: 'source-publication-progress', owner: owner.id }); await immediate(); }
        while ((await historyFiles.flush(owner.id)).pending) { emit({ stage: 'history-publication-progress', owner: owner.id }); await immediate(); }
      }
    });
    await phase('actual_native_outbox_ingestion', async () => {
      await memory.drainDeliveries();
      const status = store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus!;
      if (status.indexed !== config.notes || status.pendingIndex) throw new Error('Actual native ingestion did not acknowledge the complete primary corpus.');
      emit({ stage: 'ingested', indexed: status.indexed, pendingIndex: status.pendingIndex });
    });
    return;
  }
  const query = async (text: string, ownerIndex = 0) => {
    const startedAt = performance.now();
    const owner = active[ownerIndex]!, conversationId = rooms[ownerIndex]!.id;
    const source = store.appendMessage({ conversationId, authorId: 'user', content: text, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: owner.id, conversationId, sourceMessageId: source.id, status: 'running', turns: [], supplements: [] };
    store.request({ type: 'loop.save', checkpoint });
    const isCurrent = async () => store.request({ type: 'loop.get', companionId: owner.id, sourceMessageId: source.id }).loop?.status === 'running';
    const result = await ports.measureQuery(() => memory.search({ companionId: owner.id, conversationId, beforeSequence: source.sequence, query: text, limit: 12 }, 'passive', undefined, undefined, {
      taskKey: createHash('sha256').update('actual-native-resource-task:' + source.id).digest('hex'), isCurrent,
      rawSources: [{ id: source.id, conversationId, readerId: owner.id, checksum: createHash('sha256').update(source.content).digest('hex') }],
      onPrepared: async reference => { if (!await isCurrent()) throw new Error('Synthetic measured task was stopped.');
        if (reference) checkpoint.memoryPreparation = reference; else delete checkpoint.memoryPreparation;
        store.request({ type: 'loop.save', checkpoint }); emit({ stage: 'durable-preparation', checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint)),
          focused: !!reference?.focusHash, owner: owner.id }); },
    }), startedAt);
    const reference = checkpoint.memoryPreparation; delete checkpoint.memoryPreparation;
    checkpoint.context = { system: 'Measured native memory task', user: JSON.stringify({ memoryRecall: { memories: [], sources: [], reasons: [], pending: false, degraded: false, context: result.memoryContext } }) };
    store.request({ type: 'loop.save', checkpoint }); await memory.acknowledgeTaskRecall(reference);
    emit({ stage: 'durable-context', checkpointBytes: Buffer.byteLength(JSON.stringify(checkpoint)), owner: owner.id });
    return result;
  };
  let primaryPhysicalCount = config.notes;
  const sample = async (name: string, index: number, operation: () => ReturnType<typeof query>, expectedPhysicalCount = primaryPhysicalCount) => {
    const started = performance.now(), result = await operation();
    if (!result.ok || !result.memoryContext?.evidence?.dependencies?.length) throw new Error('The measured authorized native inputs were not recalled.');
    const physicalGraphNotes = Number(result.memoryRetrieval?.stages.find(stage => stage.id === 'scope')?.facts.find(fact => fact.label === '获权记忆文档')?.value);
    if (physicalGraphNotes !== expectedPhysicalCount) throw new Error('The measured task did not use its complete authorized physical corpus.');
    emit({ stage: 'sample', phase: name, index, elapsedMs: performance.now() - started, timings: result.memorySearchTimings,
      localPreparationMs: result.localPreparationMs, preparationBoundary: result.preparationBoundary,
      corpusDependencies: result.memoryContext.evidence.dependencies.length, contextChars: result.memoryContext.text.length, candidateCount: result.memoryPage?.items.length,
      physicalFileDependencies: result.memoryContext.fileReceipts?.length, nativeReferenceCoverage: result.memoryContext.evidence.referenceCoverage,
      physicalGraphNotes,
      native: runtime.resourceSnapshot() }); return result;
  };
  const cold = await phase('cold_start_first_task', () => sample('cold_start_first_task', 0, () => query('group0 What is the unfinished blue umbrella agreement?')));
  await phase('warm_new_task', async () => { for (let index = 0; index < config.samples; index++)
    await sample('warm_new_task', index, () => query(`group${index % 16} Recheck the umbrella agreement for distinct task ${index}.`)); });
  await phase('same_query_new_task_cache', async () => { for (let index = 0; index < config.samples; index++)
    await sample('same_query_new_task_cache', index, () => query('group0 What is the unfinished blue umbrella agreement?')); });
  await phase('same_task_checkpoint_reuse', async () => {
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'Synthetic continuing task with a fixed recall.', replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { ...scope, sourceMessageId: source.id, status: 'running', turns: [], supplements: [],
      context: { system: 'Synthetic continuing task', user: JSON.stringify({ memoryRecall: { memories: [], sources: [], reasons: [], pending: false, degraded: false, context: cold.memoryContext } }) } };
    store.request({ type: 'loop.save', checkpoint });
    for (let index = 0; index < config.samples; index++) {
      const started = performance.now(), saved = store.request({ type: 'loop.get', companionId: 'alice', sourceMessageId: source.id }).loop!;
      const recalled = restoredCompanionTaskRecall(saved);
      if (!recalled?.context || !await memory.contextValid(scope, recalled.context)) throw new Error('The fixed task checkpoint became invalid without withdrawal.');
      emit({ stage: 'sample', phase: 'same_task_checkpoint_reuse', index, elapsedMs: performance.now() - started,
        checkpointBytes: Buffer.byteLength(JSON.stringify(saved)), readDependencies: recalled.context.evidence?.dependencies?.length,
        fileDependencies: recalled.context.fileReceipts?.length, native: runtime.resourceSnapshot() });
    }
  });
  await phase('concurrent_write_while_focusing', async () => {
    const pending = query('group0 A distinct write-interference task checks the unfinished umbrella agreement.');
    await fetch(endpoint + '/control/wait-model');
    try {
      const started = performance.now(), note = store.saveMemory({ ...scope, content: 'group0 A new unrelated source arrived while the previous task was focusing.', tags: ['group0'], diaryName: '资料' });
      await sourceFiles.flush('alice'); await historyFiles.flush('alice'); await liveFiles.flush('alice', { noteIds: [note.id] }); await memory.drainDeliveries(); memory.changed('alice');
      emit({ stage: 'sample', phase: 'concurrent_write_while_focusing', index: 0, elapsedMs: performance.now() - started, operation: 'actual_source_file_and_native_outbox_commit' });
    } finally { await fetch(endpoint + '/control/release', { method: 'POST' }); }
    const result = await pending;
    const physicalCount = Number(result.memoryRetrieval?.stages.find(stage => stage.id === 'scope')?.facts.find(fact => fact.label === '获权记忆文档')?.value);
    if (physicalCount !== config.notes) throw new Error('Ordinary write restarted or replaced the fixed complete native task candidate corpus.');
    primaryPhysicalCount++;
  });
  await phase('background_native_maintenance_with_foreground', async () => {
    const started = performance.now();
    await Promise.all([memory.dreamWave({ ...scope, now: new Date().toISOString(), clockDomain: 'real' }).then(dream => {
      emit({ stage: 'sample', phase: 'actual_native_maintenance', index: 0, operation: 'actual_DreamWave', elapsedMs: performance.now() - started,
        sourceCount: dream.diagnostics.sourceCount });
    }), sample('foreground_during_native_maintenance', 0, () => query('group0 Foreground query while actual native DreamWave runs.'))]);
  });
  if (active.length > 1) await phase('few_active_owners', async () => {
    const started = performance.now();
    await Promise.all(active.map((_owner, index) => sample('few_active_owners', index, () => query(`group0 Distinct owner query ${index}.`, index), index ? 8 : primaryPhysicalCount)));
    emit({ stage: 'owner-probe', phase: 'few_active_owners', elapsedMs: performance.now() - started, totalOwners: config.owners, activeOwners: active.length,
      native: runtime.resourceSnapshot(), inactiveOwnersWereNotOpened: true });
  });
  await phase('hard_revoke_during_focus', async () => {
    const pending = query('group0 A distinct hard-revocation task checks the umbrella agreement.');
    const rejected = pending.then(() => false, () => true);
    await fetch(endpoint + '/control/wait-model');
    const source = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes[0]!;
    const started = performance.now(); store.request({ type: 'memory.forget', ...scope, id: source.id });
    const fenced = performance.now() - started;
    await memory.invalidate('alice'); await fetch(endpoint + '/control/release', { method: 'POST' });
    if (!await rejected) throw new Error('A revoked late focus was published.');
    emit({ stage: 'sample', phase: 'hard_revoke_during_focus', index: 0, elapsedMs: performance.now() - started, fenceMs: fenced,
      latePublicationRejected: true, alreadyObservedRemoteInputsCannotBeErased: true });
  });
}
