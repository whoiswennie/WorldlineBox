import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { ownerGenerationRuntime } from '../fixtures/owner-generation-runtime';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Paid-model opt-in: actual journal/reflection/maintenance generation and
 * vendored SQLite/Rust indexing over synthetic data. Date advances simulate
 * inactivity; fixture vectors deliberately make no encoder-quality claim. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_LIFECYCLE_REAL !== '1')('aggregates an episode, records a correction, and settles daytime maintenance debt during ordinary work after reopening SQLite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-lifecycle-real-'));
  const config = await realGlobalChatConfig(root), commands: CompanionStorageCommand[] = [];
  const purposes: string[] = [], errors: string[] = [], encodingDiagnostics: unknown[] = [], started = performance.now(); let status = 'failed';
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-26T10:00:00Z');
  const seeds = [{ id: 'alice', name: '阿澜', persona: '认真温和，保留实际经历中的细节、更正和未知，不把计划当完成。',
    description: '', model: '', avatar: 'sister' as const, active: true, proactive: false }];
  const database = path.join(root, 'ledger.sqlite'); let store = new CompanionsStore(database, seeds);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  let memory: CompanionMemoryService | undefined, world: CompanionWorldService | undefined;
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command); const response = store.request(command);
    for (const owner of response.memoryChangedCompanionIds ?? []) memory?.changed(owner);
    for (const owner of response.memoryInvalidatedCompanionIds ?? []) void memory?.invalidate(owner).catch(error => errors.push(String(error)));
    return response;
  };
  const modelFetch: typeof fetch = async (url, init) => {
    let journalInput: { purpose?: string; relevantMemories?: Array<{ id: string; version: number; sourceConversationId: string }> } | undefined;
    try { const body = JSON.parse(String(init?.body)); journalInput = JSON.parse(body.messages[1]?.content ?? '{}'); purposes.push(journalInput?.purpose ?? 'native_focus_or_timeline'); }
    catch { purposes.push('native_focus_or_timeline'); }
    const response = await fetch(url, init);
    if (journalInput?.purpose === 'vcp_experience_journal') try {
      const body = await response.clone().json(), proposal = JSON.parse(body.choices[0].message.content);
      encodingDiagnostics.push({ readVersions: journalInput.relevantMemories?.map(({ id, version, sourceConversationId }) => ({ id, version, sourceConversationId })),
        proposed: proposal.notes?.map((note: { encoding?: unknown; relatedMemoryIds?: string[] }) => ({ encoding: note.encoding, relatedMemoryIds: note.relatedMemoryIds })) });
    } catch { /* Diagnostics never change a provider response or its parser. */ }
    return response;
  };
  const native = await nativeManagementHarness(root, request);
  let routed = ownerGenerationRuntime(path.join(root, 'owner-runtime'), native.embedding, native.launch, modelFetch);
  const createMemory = () => new CompanionMemoryService({ request, cacheRoot: path.join(root, 'views'), runtime: routed.runtime,
    configFor: async () => config, fetchFn: modelFetch, busy: () => false, changed: () => undefined,
    report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const snapshot = () => store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes;
  const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline) {
      if (await check()) return;
      const failed = store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.failed;
      if (failed) { vi.setSystemTime(Date.now() + 31_000); memory?.schedule(0); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`REAL_LIFECYCLE_TIMEOUT_${label}: ${errors.join('; ')}`);
  };
  let before: unknown, after: unknown;
  try {
    const initial = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
    memory = createMemory();
    const sources = [
      '这是合成验收记录。今天我在青岚书店修复编号 QL-27 的旧书；先拍照留底，保留蓝色封皮，不凭空补写缺失的第17页。',
      '继续同一次 QL-27 修复：我用了米色棉线，每针约3毫米，只缝好上半部书脊，下半部尚未开始。',
      'QL-27 的剩余米色棉线在第二层抽屉。下半部计划周六继续，仍未完成，不能说整本书已修好。',
    ].map(content => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' }));
    memory.schedule(0); await new Promise(resolve => setTimeout(resolve, 300));
    expect(purposes.filter(purpose => purpose === 'vcp_experience_journal')).toHaveLength(0);
    vi.setSystemTime(Date.now() + 61_000); memory.schedule(0);
    await waitFor(() => sources.every(source => snapshot().some(note => note.sources.some(item => item.messageId === source.id))), 'episode_indexed');
    expect(purposes.filter(purpose => purpose === 'vcp_experience_journal')).toHaveLength(1);
    before = snapshot();
    const correction = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user',
      content: '更正一下 QL-27 这同一次修复的针距：之前3毫米记错了，实际约4毫米。蓝色封皮、第17页仍缺、仅上半部完成、下半部未完成和第二层抽屉都不变。', replyDirective: 'none' });
    memory.schedule(0);
    await waitFor(() => snapshot().some(note => note.sources.some(source => source.messageId === correction.id) && /4\s*毫米/u.test(note.content)), 'correction_indexed');
    await memory.close(); memory = undefined; await routed.close(); store.close();
    // Reopen only this synthetic ledger, after a real-time gap. No sleep or
    // historical dream is manufactured to pay the persisted maintenance debt.
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 + 1_000);
    store = new CompanionsStore(database, seeds);
    routed = ownerGenerationRuntime(path.join(root, 'owner-runtime'), native.embedding, native.launch, modelFetch);
    memory = createMemory();
    store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
    const stamp = new Date().toISOString();
    store.request({ type: 'work.enqueue', work: { id: 'ongoing_actual_work', ...scope, sourceMessageId: correction.id,
      status: 'queued', proactive: false, createdAt: stamp, updatedAt: stamp } });
    expect(store.request({ type: 'work.claim' }).work?.id).toBe('ongoing_actual_work');
    store.request({ type: 'world.work.begin', ...scope, workId: 'ordinary_work', kind: 'chat', sourceMessageId: correction.id });
    vi.spyOn(Math, 'random').mockReturnValue(.99);
    world = new CompanionWorldService({ request, configFor: async () => ({ ...config, ownerId: 'alice', workPriority: 'background' }), fetchFn: modelFetch,
      changed: () => memory?.schedule(0), wakeWaiting: () => undefined, report: error => errors.push(String(error)) });
    store.request({ type: 'world.tick' }); await world.tick();
    await waitFor(async () => { await world!.tick(); return commands.some(command => command.type === 'world.job.complete' && command.stage === 'real'); }, 'daytime_real_commit');
    const admitted = commands.find(command => command.type === 'world.job.claim' && command.kind === 'dream');
    expect(admitted).toBeDefined();
    expect(store.request({ type: 'work.list', unfinishedOnly: true }).works?.some(work => work.id === 'ongoing_actual_work' && work.status === 'running')).toBe(true);
    const plan = store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!;
    expect(plan.maintenance?.mode).toBe('background'); expect(plan.maintenance?.lastDecisionAt).toBeDefined();
    expect(plan.actor?.activity).not.toBe('sleeping');
    const completedCount = commands.filter(command => command.type === 'world.job.complete' && command.stage === 'real').length;
    vi.setSystemTime(Date.now() + 31_000); store.request({ type: 'world.tick' }); await world.tick();
    expect(commands.filter(command => command.type === 'world.job.complete' && command.stage === 'real')).toHaveLength(completedCount);
    after = snapshot(); status = 'passed';
  } finally {
    await world?.close(); await memory?.close(); after ??= snapshot();
    const captureStatus = store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus;
    await routed.close(); await native.close(); store.close();
    vi.restoreAllMocks(); vi.useRealTimers();
    const output = path.resolve('artifacts/vcp-validation/memory-lifecycle-real-2026-10-26.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, actualChatModel: true, actualVendoredRustIndex: true, actualEncoder: false,
      syntheticFixtureOnly: true, userDataModified: false, durationMs: performance.now() - started, model: config.model,
      before, after, purposes, errors, encodingDiagnostics, captureStatus,
      completions: commands.filter(command => command.type === 'world.job.complete' || command.type === 'memory.jobs.complete' || command.type === 'memory.jobs.fail') }, null, 2));
    await removeOwnedDirectory(root);
  }
}, 300_000);
