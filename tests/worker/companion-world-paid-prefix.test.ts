import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { companionModelConnection, companionModelQuota, CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import type { CompanionWorldJob } from '../../src/shared/companion-world';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T10:00:00Z'); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });

/** Actual SQLite restart and canonical role files. The test host becomes
 * temporarily busy after each response; there is no production allowance. */
it.each(['reflection', 'real', 'dream'] as const)('resumes %s after temporary host unavailability without repeating its completed writer or prior checks', async phase => {
  const f = await fixture(phase);
  try {
    await f.process(f.job); expect(f.providerPurposes.filter(purpose => purpose !== 'vcp_memory_prohibition_check')).toHaveLength(1);
    expect(f.providerPurposes).not.toContain('vcp_memory_prohibition_check'); expect(f.commands.some(command => command.type === 'world.job.defer'), JSON.stringify(f.reports)).toBe(true);
    // A real restart, volatile state/clock change, annotation and unrelated
    // new source do not change this job's fixed semantic input.
    await f.restart(); f.annotateAndAddUnrelated(); vi.setSystemTime('2026-10-28T10:00:01Z');
    const next = f.claim()!; expect(next.id).toBe(f.job.id); await f.process(next);
    expect(f.providerPurposes.filter(purpose => purpose !== 'vcp_memory_prohibition_check')).toHaveLength(1);
    expect(f.providerPurposes.filter(purpose => purpose === 'vcp_memory_prohibition_check')).toHaveLength(1);
    expect(f.check().status).toBe('done'); expect(f.waveCalls()).toBe(phase === 'dream' ? 1 : 0);
  } finally { await f.close(); }
});

it.each(['forget', 'body', 'role'] as const)('does not reuse an unfinished paid reflection after its %s authority changes', async change => {
  const f = await fixture('reflection');
  try {
    await f.process(f.job); await f.restart();
    if (change === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.notes[0]!.sources[0]!.messageId] });
    else if (change === 'body') f.store.request({ type: 'memory.revise', ...f.scope, id: f.notes[0]!.id, expectedVersion: f.notes[0]!.version,
      candidate: { artifactKind: 'episode_memory' as const, content: '原正文已实际修订，不能把旧拟稿作为新输入的结果。', sourceMessageIds: [f.notes[0]!.sources[0]!.messageId], evidence: [{ sourceMessageId: f.notes[0]!.sources[0]!.messageId, quote: f.rawContents[0]! }] } });
    else await f.publishRole();
    vi.setSystemTime('2026-10-28T10:00:01Z'); const next = f.claim();
    if (change !== 'role') { if (next) await f.process(next); expect(f.providerPurposes).toHaveLength(1);
      expect(f.commands.filter(command => command.type === 'world.job.proposal.save')).toHaveLength(1); }
    else { expect(next).toBeDefined(); await f.process(next!); expect(f.providerPurposes.filter(purpose => purpose === 'vcp_sleep_reflection')).toHaveLength(2);
      expect(f.providerPurposes.filter(purpose => purpose === 'vcp_memory_prohibition_check')).toHaveLength(0); }
  } finally { await f.close(); }
});

it('retains each completed semantic check when a two-note reflection spans three host process lifetimes', async () => {
  const f = await fixture('reflection', 2);
  try {
    for (let day = 0; day < 3; day++) {
      if (day) { await f.restart(); vi.setSystemTime(Date.UTC(2026, 9, 27 + day, 10)); }
      await f.process(day ? f.claim()! : f.job);
    }
    expect(f.providerPurposes.filter(purpose => purpose === 'vcp_sleep_reflection')).toHaveLength(1);
    expect(f.providerPurposes.filter(purpose => purpose === 'vcp_memory_prohibition_check')).toHaveLength(2);
    expect(f.commands.filter(command => command.type === 'world.job.complete' && command.stage === 'reflection')).toHaveLength(1);
    expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan?.maintenance?.reflectionCompletedAt).toBeDefined();
  } finally { await f.close(); }
});

it('rejects a queued writer after source withdrawal before the actual provider dispatch', async () => {
  const f = await fixture('reflection'); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const holding = companionModelQuota.run({ ownerId: 'trusted-fixture-blocker', connectionId: companionModelConnection(f.config), priority: 'foreground' }, async () => { entered(); await gate; });
  let pending: Promise<unknown> | undefined;
  try {
    await ready; pending = f.process(f.job);
    await vi.waitFor(() => expect(companionModelQuota.snapshot().queued).toBeGreaterThan(0));
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.notes[0]!.sources[0]!.messageId] });
    release(); await holding; await pending;
    expect(f.providerPurposes).toEqual([]);
  } finally { release(); await holding; await pending; await f.close(); }
});

it('counts a real narrative checker HTTP 429 while retaining its already successful writer for the next attempt', async () => {
  const f = await fixture('dream');
  try {
    await f.process(f.job); await f.restart(); vi.setSystemTime('2026-10-28T10:00:01Z'); f.failNextCheck(); await f.process(f.claim()!);
    expect(f.check().status).toBe('failed');
    await f.restart(); vi.setSystemTime('2026-10-29T10:00:01Z'); await f.process(f.claim()!);
    expect(f.providerPurposes.filter(purpose => purpose === 'companion_dream_wave_narrative')).toHaveLength(1);
    expect(f.providerPurposes.filter(purpose => purpose === 'vcp_memory_prohibition_check')).toHaveLength(2); expect(f.check().status).toBe('done');
  } finally { await f.close(); }
});

it('defers ten unavailable host configurations while lifetime claims grow and processing failures stay zero', async () => {
  const f = await fixture('reflection');
  try {
    f.configurationUnavailable(true);
    for (let n = 0; n < 10; n++) {
      if (n) vi.setSystemTime(Date.now() + 31_000);
      await f.process(n ? f.claim()! : f.job);
      expect(f.check()).toMatchObject({ status: 'pending', attempts: n + 1 });
      expect(f.inspect()).toMatchObject({ state: 'pending', failureCount: 0, cycleFailureCount: 0, attemptCount: n + 1 });
    }
    expect(f.providerPurposes).toEqual([]);
    expect(f.commands.filter(command => command.type === 'world.job.defer')).toHaveLength(10);
    f.configurationUnavailable(false); f.failNextWriter(); vi.setSystemTime(Date.now() + 31_000); await f.process(f.claim()!);
    expect(f.check()).toMatchObject({ status: 'failed', attempts: 11 });
    expect(f.inspect()).toMatchObject({ state: 'failed', failureCount: 1, cycleFailureCount: 1, attemptCount: 11 });
    expect(f.providerPurposes).toEqual(['vcp_sleep_reflection']);
    vi.setSystemTime(Date.now() + 86_400_000); expect(f.claim()).toMatchObject({ id: f.job.id, attempts: 12 });
  } finally { await f.close(); }
});

async function fixture(phase: 'reflection' | 'real' | 'dream', reflectionNotes = 1) {
  vi.spyOn(Math, 'random').mockReturnValue(phase === 'dream' ? .1 : .99);
  const root = await mkdtemp(path.join(tmpdir(), 'world-paid-prefix-')), filename = path.join(root, 'state.sqlite');
  const seeds = [{ id: 'alice', name: 'Alice', description: '', persona: '按真实资料反思。', avatar: 'sister' as const, active: true, proactive: false, model: '' }];
  let store = new CompanionsStore(filename, seeds);
  let files: Awaited<ReturnType<typeof canonicalMemoryFiles>> | undefined;
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, commands: CompanionStorageCommand[] = [], providerPurposes: string[] = [];
  const request = async (command: CompanionStorageCommand) => { commands.push(command); return files ? files.request(command) : store.request(command); };
  const world = store.request({ type: 'world.snapshot' }).world!; store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  store.request({ type: 'memory.forget', ...scope, tag: '受保护的住址资料', persistent: true });
  const rawContents = Array.from({ length: phase === 'real' ? 2 : reflectionNotes }, (_, index) => `真实材料${index}：修改前实际保留了备份与恢复入口。`);
  const notes = rawContents.map(content => { const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
    return store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, content, diaryName: '日记', tags: ['重要'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] } }).memories![0]!; });
  const index = () => { for (;;) { const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!outbox) return;
    store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); } }; index();
  vi.setSystemTime(Date.now() + 6000); store.request({ type: 'world.tick' });
  const claim = () => { for (let index = 0; index < 100; index++) { store.request({ type: 'world.tick' }); const next = store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob;
    if (next) return next; if (!store.request({ type: 'world.snapshot' }).world!.backlog) return undefined; } throw Error('World catch-up did not reach the current simulated instant.'); };
  const job = claim()!; expect(job).toBeDefined();
  store.request({ type: 'world.job.bind-memories', id: job.id, leaseToken: job.leaseToken!, memoryVersions: notes.map(note => ({ id: note.id, version: note.version })) });
  if (phase !== 'reflection') store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'reflection' });
  if (phase === 'dream') store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, stage: 'real', sourceMemoryIds: job.sourceMemoryIds });
  const currentJob = store.request({ type: 'world.job.check', id: job.id, leaseToken: job.leaseToken! }).worldJob!;
  const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'durable-checkpoint-fixture', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-only' };
  files = await canonicalMemoryFiles(root, store, config);
  const connection = companionModelConnection(config), schedulerOwner = randomUUID(); companionModelQuota.configureConnection(connection, 1, schedulerOwner);
  const reports: string[] = [];
  let waves = 0, failCheck = false, unavailable = false, failWriter = false, hostBusy = false;
  const service = new CompanionWorldService({ request, configFor: async () => {
    if (unavailable) throw new Error('Actual host role/configuration unavailable.');
    const current = await files!.configFor({ id: 'alice' });
    return { ...current, providerLifecycle: { beforeDispatch: async () => {
      if (hostBusy) throw new CompanionModelAdmissionError('queue_full', 'Controlled host queue is temporarily unavailable.', new Date(Date.now() + 1000).toISOString());
      return async () => undefined;
    } } };
  }, changed: () => undefined, wakeWaiting: () => undefined, report: error => { reports.push(error instanceof Error ? error.stack ?? error.message : String(error)); },
    dreamWave: async () => { waves++; const active = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
      return { schema: 'worldlinebox.vcp-dream-wave', owner: { version: 2, companionId: 'alice', name: 'Alice', agentName: 'Alice' }, sourceRevision: active.revision,
        now: new Date().toISOString(), clockDomain: 'world', boundaries: { recentDays: 7, midDays: 90 }, stages: { recent: { seeds: notes.map(note => ({ id: note.id, version: store.request({ type: 'memory.read', ...scope, id: note.id }).memoryRead!.memory.version,
          text: note.content, eventTime: new Date().toISOString(), clockDomain: 'world' })), resonanceL1: [], cascadeL2: [] }, mid: { seeds: [], cascadeL1: [] }, deep: { recalls: [] } },
        diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: notes.length, indexedCount: notes.length, queries: [] } } satisfies VcpMemoryDreamWaveResult; },
    fetchFn: async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); providerPurposes.push(data.purpose);
      hostBusy = true;
      if (failWriter) { failWriter = false; return new Response('{"error":"actual provider rate limit"}', { status: 429 }); }
      if (data.purpose === 'vcp_memory_prohibition_check') { if (failCheck) { failCheck = false; return new Response('{"error":"actual provider rate limit"}', { status: 429 }); }
        return response({ allowed: true, matchedPolicyIds: [] }); }
      if (data.purpose === 'vcp_sleep_reflection' && reflectionNotes > 1) return response({ notes: data.messages.map((source: { id: string; content: string }) => ({ artifactKind: 'knowledge' as const,
        content: source.content + ' 本次保留备份为恢复留下了条件。', tags: ['有条件反思'], sourceMessageIds: [source.id],
        relatedMemoryIds: data.relevantMemories.filter((note: { content: string }) => note.content === source.content).map((note: { id: string }) => note.id), evidence: [{ sourceMessageId: source.id, quote: source.content }] })), dream: null });
      if (data.purpose === 'vcp_sleep_reflection') return response({ notes: [{ artifactKind: 'knowledge' as const, content: '这次修改保留备份，为本次恢复留下了条件。', tags: ['有条件反思'],
        sourceMessageIds: data.messages.map((source: { id: string }) => source.id), relatedMemoryIds: data.relevantMemories.map((note: { id: string }) => note.id),
        evidence: data.messages.map((source: { id: string; content: string }) => ({ sourceMessageId: source.id, quote: source.content })) }], dream: null });
      if (data.purpose === 'vcp_sleep_memory_maintenance') return response({ decision: 'merge', reason: '这两份本批实际材料互补，保留来源整合。', consolidations: [{
        inputs: data.relevantMemories.map((note: { id: string; version: number }) => ({ id: note.id, version: note.version })), candidate: { artifactKind: 'episode_memory' as const, content: data.messages.map((source: { content: string }) => source.content).join('\n'), tags: ['真实整合'],
          sourceMessageIds: data.messages.map((source: { id: string }) => source.id), relatedMemoryIds: data.relevantMemories.map((note: { id: string }) => note.id), evidence: data.messages.map((source: { id: string; content: string }) => ({ sourceMessageId: source.id, quote: source.content })) } }] });
      if (data.purpose === 'companion_dream_wave_narrative') return response({ text: '这是私人的虚构联想：备份像一座小桥。', relatedMemoryIds: notes.map(note => note.id) });
      throw Error('Unexpected actual provider request: ' + data.purpose);
    } });
  const process = (current: CompanionWorldJob) => (service as unknown as { process(job: CompanionWorldJob, signal: AbortSignal): Promise<void> }).process(current, new AbortController().signal);
  return { root, scope, notes, rawContents, commands, providerPurposes, config, job: currentJob, claim, process,
    get store() { return store; }, inspect: () => store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'world', id: currentJob.id }).jobDisposition!, reports, waveCalls: () => waves, failNextCheck: () => { failCheck = true; },
    configurationUnavailable: (value: boolean) => { unavailable = value; }, failNextWriter: () => { failWriter = true; },
    check: () => store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.job
      ?? ({ status: 'done' } as const),
    annotateAndAddUnrelated: () => { for (const note of notes) store.request({ type: 'memory.organize', ...scope, ids: [note.id], tags: ['重要', '标签变化'] });
      const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '完全无关的新事项，不替换已领取任务。', replyDirective: 'none' });
      store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }); index(); },
    publishRole: async () => {
      const profile = await files!.profiles.load('alice'), role = profile.modules.find(module => module.purposes.includes('vcp_sleep_reflection'))!;
      const registry = await files!.profiles.artifacts('alice'), artifact = (await registry.findByPath(role.path))!;
      expect(artifact.kind).toBe('processor_prompt');
      await registry.publish({ artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath, content: role.content + '\nHost processing policy changed.\n',
        expectedRevision: artifact.contentRevision, producer: { kind: 'host', id: 'synthetic-processor-maintenance' }, sourceRefs: artifact.sourceRefs,
        dependencyRefs: artifact.dependencyRefs, visibility: artifact.visibility, allowedConsumers: artifact.allowedConsumers, retentionClass: artifact.retentionClass,
        operationId: 'processor:' + randomUUID() });
    },
    restart: async () => { await files!.close(); store.close(); store = new CompanionsStore(filename, seeds); files = await canonicalMemoryFiles(root, store, config); hostBusy = false; },
    close: async () => { await service.close(); await files!.close(); companionModelQuota.releaseConnectionPolicy(connection, schedulerOwner); store.close(); await removeOwnedDirectory(root); },
  };
}
