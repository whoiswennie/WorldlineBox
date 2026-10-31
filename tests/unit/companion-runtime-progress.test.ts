import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { companionsRequestSchema, companionsResponseSchema, type CompanionActivity } from '../../src/shared/companions';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionMemoryService, type CompanionMemoryWarmupCandidates } from '../../src/main/companions/memory-service';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

it('projects actual SQL queue status without opening canonical contacts, credentials, files or historical evidence', async () => {
  const f = managedMemoryFiles();
  try {
    const message = (owner: string) => f.store.appendMessage({ conversationId: f.store.openPrivate(owner).id, authorId: 'user',
      content: 'SOURCE_BODY_MUST_NOT_ENTER_PROGRESS', replyDirective: 'auto' });
    const first = message('alice'); message('alice'); const peer = message('bob');
    for (const source of [first, peer]) {
      const work = f.store.request({ type: 'work.list', sourceMessageId: source.id }).works![0]!;
      f.store.request({ type: 'work.status', id: work.id, status: 'running' });
    }
    const queue = f.store.request({ type: 'work.list', unfinishedOnly: true }).works!;
    expect(queue).toHaveLength(3); expect(queue.every(work => !!work.receivedState)).toBe(true);
    const activities = new Map<string, CompanionActivity>([
      ['alice_wait', { companionId: 'alice', conversationId: f.scope.conversationId, status: 'waiting', stage: '等待实际工具回执' }],
      ['bob_wait', { companionId: 'bob', conversationId: peer.conversationId, status: 'waiting', stage: '另一等待' }],
      ['bob_think', { companionId: 'bob', conversationId: peer.conversationId, status: 'thinking' }],
    ]);
    const raw = vi.fn(async (command: CompanionStorageCommand) => f.store.request(command));
    const forbidden = vi.fn(() => { throw new Error('Progress must not read canonical or historical content.'); });
    const service = Object.assign(Object.create(CompanionService.prototype), { initialization: Promise.resolve(), closed: false,
      storage: { request: raw }, activities, call: forbidden, credentials: { ids: forbidden },
      assetProfiles: { bootstrap: forbidden, bootstrapProfile: forbidden, load: forbidden, artifacts: forbidden }, profiles: { runtimeImages: forbidden } }) as CompanionService;
    const result = companionsResponseSchema.parse(await service.handle(companionsRequestSchema.parse({ type: 'state.progress' })));
    expect(raw.mock.calls.map(([command]) => command.type)).toEqual(['work.list']); expect(forbidden).not.toHaveBeenCalled();
    expect(result.runtimeProgress?.owners).toEqual(expect.arrayContaining([
      expect.objectContaining({ companionId: 'alice', activeCount: 1, queuedCount: 1, activityCount: 1, waitingCount: 1,
        availability: 'waiting', availabilityReason: '等待实际工具回执' }),
      expect.objectContaining({ companionId: 'bob', activeCount: 1, queuedCount: 0, activityCount: 2, waitingCount: 1, availability: 'working' }),
    ]));
    expect(result.runtimeProgress?.queue).toHaveLength(3); expect(result.runtimeProgress?.activities).toEqual([...activities.values()]);
    expect(result).not.toHaveProperty('state');
    for (const work of result.runtimeProgress!.queue) {
      expect(work).not.toHaveProperty('receivedState'); expect(work).not.toHaveProperty('agendaLeaseToken');
      expect(work).not.toHaveProperty('persona'); expect(work).not.toHaveProperty('content');
    }
    expect(JSON.stringify(result)).not.toContain('SOURCE_BODY_MUST_NOT_ENTER_PROGRESS');
    for (const work of queue) f.store.request({ type: 'work.status', id: work.id, status: 'done' });
    activities.clear(); raw.mockClear();
    const idle = await service.handle({ type: 'state.progress' });
    expect(idle.runtimeProgress).toEqual({ queue: [], activities: [], owners: [] });
    expect(raw.mock.calls.map(([command]) => command.type)).toEqual(['work.list']);
  } finally { await f.close(); }
});

it('selects idle warmup candidates from one raw SQL metadata read without hydrating private profiles or historical bodies', async () => {
  const f = managedMemoryFiles(); let memory: CompanionMemoryService | undefined;
  try {
    const aliceRoom = f.store.openPrivate('alice'), bobRoom = f.store.openPrivate('bob'), group = f.store.createConversation('PRIVATE_GROUP_TITLE', ['alice', 'bob']);
    const clock = Date.now(), timestamps = [1, 2, 3].map(index => new Date(clock + index * 1000).toISOString());
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const [index, [room, content]] of ([
      [aliceRoom, 'OLDER_PRIVATE_HISTORY_BODY'], [group, 'LATEST_ACTIVE_GROUP_BODY'], [bobRoom, 'INACTIVE_PRIVATE_HISTORY_BODY'],
    ] as const).entries()) {
      vi.setSystemTime(timestamps[index]!);
      f.store.appendMessage({ conversationId: room.id, authorId: 'user', content, replyDirective: 'none' });
    }
    f.store.setCompanionActive('bob', false);
    vi.useRealTimers();
    let pendingWithdrawal = false;
    const raw = vi.fn(async (command: CompanionStorageCommand) => ({ ...f.store.request(command), ...(pendingWithdrawal
      ? { memoryInvalidatedCompanionIds: ['alice'], memoryInvalidatedScopeIds: ['actual-source-scope'] } : {}) }));
    const forbidden = vi.fn(() => { throw new Error('Idle candidate labels must not open profiles, files, credentials, actions or historical evidence.'); });
    const invalidate = vi.fn(async () => undefined), schedule = vi.fn(), libraryInvalidated = vi.fn(async () => undefined), retract = vi.fn(async () => undefined),
      drain = vi.fn(async () => undefined), redact = vi.fn(async () => undefined), wakeFiles = vi.fn();
    const service = Object.assign(Object.create(CompanionService.prototype), { storage: { request: raw }, resettingCompanions: new Set(), sourceValidationRevision: 0, evidenceRevision: 0,
      credentials: { ids: forbidden }, assetProfiles: { bootstrap: forbidden, bootstrapProfile: forbidden, load: forbidden, snapshot: forbidden, artifacts: forbidden },
      profiles: { prepare: forbidden, visibleFiles: forbidden, runtimeImages: forbidden }, sourceFiles: { read: forbidden }, historyFiles: { read: forbidden, readMany: forbidden },
      liveFiles: { materialize: forbidden, projectionNotes: forbidden, validate: forbidden }, contextSnapshots: { read: forbidden, redactStale: redact },
      memory: { recall: forbidden, search: forbidden, invalidate, schedule, changed: vi.fn() }, memoryManagement: { invalidate: vi.fn(async () => undefined) }, memoryLibrary: { invalidate: libraryInvalidated },
      wakeMemoryFiles: wakeFiles, flushRetractedMemoryFiles: retract, drainRevokedCognition: drain,
      options: { report: forbidden } }) as { memoryWarmupCandidates(): Promise<CompanionMemoryWarmupCandidates> };
    let candidates: CompanionMemoryWarmupCandidates | undefined;
    const physical = vi.fn(async (command: CompanionStorageCommand) => {
      if (command.type !== 'memory.snapshot') throw new Error('An empty candidate must not open any native or historical body.');
      return { ok: true, memorySnapshot: { scopeId: 'empty', revision: 'empty', notes: [] } };
    });
    memory = new CompanionMemoryService({ request: physical, warmupCandidates: async () => candidates = await service.memoryWarmupCandidates(),
      runtime: { supportsPreparation: true, get: forbidden, close: async () => undefined }, configFor: forbidden, fetchFn: forbidden,
      busy: () => false, changed: forbidden, report: forbidden });
    await memory.primeIdle();
    expect(raw.mock.calls.map(([command]) => command)).toEqual([{ type: 'state', activeOnly: true, includeHidden: true }]);
    expect(candidates?.companions).toEqual([{ id: 'alice', name: 'alice', active: true }]);
    expect(candidates?.conversations).toEqual(expect.arrayContaining([
      { id: aliceRoom.id, memberIds: ['alice'], lastMessage: 'present', updatedAt: timestamps[0] },
      { id: group.id, memberIds: ['alice', 'bob'], lastMessage: 'present', updatedAt: timestamps[1] },
      { id: bobRoom.id, memberIds: ['bob'], lastMessage: 'present', updatedAt: timestamps[2] },
    ]));
    expect(physical.mock.calls.map(([command]) => command)).toEqual([{ type: 'memory.snapshot', companionId: 'alice', conversationId: group.id,
      contentKinds: ['episode_memory', 'knowledge', 'procedure'] }]);
    for (const room of candidates!.conversations) expect(Object.keys(room).sort()).toEqual(['id', 'lastMessage', 'memberIds', 'updatedAt']);
    const serialized = JSON.stringify(candidates);
    for (const privateText of ['OLDER_PRIVATE_HISTORY_BODY', 'LATEST_ACTIVE_GROUP_BODY', 'INACTIVE_PRIVATE_HISTORY_BODY', 'PRIVATE_GROUP_TITLE', '有来源的伙伴。']) expect(serialized).not.toContain(privateText);
    expect(invalidate).not.toHaveBeenCalled(); expect(retract).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled();
    pendingWithdrawal = true; await service.memoryWarmupCandidates();
    expect(raw).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith('alice', ['actual-source-scope'], { preserveIndexes: false });
    expect(libraryInvalidated).toHaveBeenCalledWith('alice'); expect(wakeFiles).toHaveBeenCalledWith('alice');
    expect(retract).toHaveBeenCalledWith('alice'); expect(drain).toHaveBeenCalledWith('alice'); expect(redact).toHaveBeenCalledWith('alice');
    expect(forbidden).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await memory?.close(); await f.close(); }
});
