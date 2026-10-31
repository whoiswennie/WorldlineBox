import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';
import type { VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import { ownerGenerationRuntime } from '../fixtures/owner-generation-runtime';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function launch(file: string): VcpMemoryTransport {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete environment.NODE_PATH;
  const child = fork(file, [], { execPath: process.execPath, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return { postMessage: message => { child.send(message as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
}
async function fixture(vectorDimension = 4) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-continuity-'));
  cleanups.push(async () => {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-continuity-')) throw new Error('Unsafe continuity cleanup.');
    await removeOwnedDirectory(root);
  });
  const controls = { hangTimeline: false, foregroundBusy: false, modelConfigured: true,
    deviceState: 'unchecked' as 'unchecked' | 'testing' | 'supported' | 'unsupported' | 'error', deviceStatusReads: 0,
    timelineCalls: 0, timelinePrompts: [] as string[], focusCalls: 0, focusPrompts: [] as string[], disconnected: 0 };
  const pending = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    const body = JSON.parse(text);
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.includes('/chat/')) {
      if (JSON.stringify(body).includes('vcp_experience_journal')) {
        response.end(JSON.stringify({ choices: [{ message: { content: '{"notes":[]}' } }] })); return;
      }
      const prompt = body.messages?.at(-1)?.content;
      // The provider serializer adds an empty system message for this isolated
      // host fixture. Identify the original AIMemo user template instead of
      // relying on the removed built-in gateway system instruction.
      if (typeof prompt === 'string' && prompt.startsWith('### 角色与核心使命 ###')) {
        controls.focusCalls++; controls.focusPrompts.push(prompt);
        const content = `这是我获取的所有相关知识/记忆[[alpha borrowed the blue umbrella.${prompt.includes('TIMELINE_ONLY_VALIDATED_MONTH') ? ' TIMELINE_ONLY_VALIDATED_MONTH.' : ''}]]`;
        response.end(JSON.stringify({ choices: [{ message: { content } }] })); return;
      }
      controls.timelineCalls++;
      controls.timelinePrompts.push(JSON.stringify(body.messages));
      if (controls.hangTimeline) {
        pending.add(response);
        response.once('close', () => { pending.delete(response); controls.disconnected++; });
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: '2026-10-14: alpha borrowed the blue umbrella. TIMELINE_ONLY_VALIDATED_MONTH.\nTag: alpha, umbrella' } }] })); return;
    }
    response.end(JSON.stringify({ data: body.input.map((_input: string, index: number) => ({ index, embedding: Array.from({ length: vectorDimension }, (_, position) => position === 0 ? 1 : 0) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test gateway.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [
    { id: 'alpha', name: 'Alpha', description: '测试伙伴', persona: '谨慎', model: '', avatar: 'sister', proactive: false, active: true },
  ]);
  cleanups.push(async () => { store.close(); });
  const conversation = store.openPrivate('alpha');
  const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: 'alpha borrowed the blue umbrella.', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', companionId: 'alpha', conversationId: conversation.id,
    candidate: { artifactKind: 'episode_memory' as const, content: source.content, tags: ['alpha', 'umbrella'], occurredAt: '2026-10-14T01:00:00Z',
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture-chat', apiKey: 'fixture-key', baseUrl: `${baseUrl}/chat` };
  const cacheRoot = path.join(root, 'views');
  const services: CompanionMemoryService[] = [];
  cleanups.push(async () => { for (const service of services) await service.close(); });
  async function createService() {
    const native = ownerGenerationRuntime(path.join(root, 'runtime'),
      { baseUrl: `${baseUrl}/document`, queryBaseUrl: `${baseUrl}/query`, model: 'fixture', modelSignature: 'continuity-test', dimension: vectorDimension, apiKey: 'fixture-key' }, launch);
    cleanups.push(native.close);
    // An explicitly acquired/released handle observes the actual generation
    // client; it does not replace Main's own lease or select a global model.
    const observed = await native.runtime.acquireGeneration({ ownerId: 'alpha', config });
    const client = observed.client, profileKey = observed.profileKey; await observed.release();
    const changed = vi.fn(), report = vi.fn(), published = vi.fn();
    const service = new CompanionMemoryService({ cacheRoot, request: async command => {
      const response = store.request(command);
      // This fixture runs the memory host alone; the app's separate world ticker is out of scope.
      if (response.worldClock) response.worldClock.backlog = false;
      return response;
    },
      configFor: async () => ({ ...config, model: controls.modelConfigured ? config.model : '' }), runtime: native.runtime,
      runtimeAvailability: () => { controls.deviceStatusReads++; return { state: controls.deviceState, message: '实际检测快照的公开原因。' }; },
      fetchFn: fetch, busy: () => controls.foregroundBusy, changed, report,
      onTimelineArtifacts: async (scope, artifacts, stillValid) => { published({ scope, artifacts, stillValid, validAtPublication: await stillValid() }); } });
    services.push(service); return { service, client, changed, report, published, profileKey, runtime: native.runtime };
  }
  return { root, store, note, conversation, cacheRoot, controls, pending, createService };
}

describe('original monthly VCP continuity behind the main memory service', () => {
  it('reuses both actual Rust monthly digests after one hundred tag writes and native publications', async () => {
    const f = await fixture(16), scope = { companionId: 'alpha', conversationId: f.conversation.id };
    for (const [day, fact] of [['2026-09-12', '雨伞在九月借出，仍未归还。'], ['2026-09-18', '保留九月雨伞的归还条件。'], ['2026-10-19', '十月仍须先核对借还记录。']]) {
      const raw = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: day + ' ' + fact, replyDirective: 'none' });
      f.store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, content: raw.content, occurredAt: day + 'T10:00:00Z', tags: ['雨伞'],
        sourceMessageIds: [raw.id], evidence: [{ sourceMessageId: raw.id, quote: raw.content }] } });
    }
    for (;;) { const job = f.store.request({ type: 'memory.outbox.claim', companionId: 'alpha' }).memoryOutbox; if (!job) break;
      f.store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); }
    const { service, client, runtime, profileKey, report } = await f.createService(); service.schedule = () => undefined;
    const core = await runtime.get({ ownerId: 'alpha' }), nativeRemember = vi.spyOn(core.client, 'remember');
    let clock = Date.now(); const time = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const run = () => (service as unknown as { runContinuity(scope: { companionId: string; conversationId: string }, generation: number): Promise<boolean> }).runContinuity(scope, 0);
    const receipt: Record<string, unknown> = { status: 'failed', actualVendoredRust: true, actualEncoder: false, actualPaidProvider: false, syntheticFixtureOnly: true,
      model: 'local deterministic HTTP', vectorDimension: 16, limitations: ['monthly digest and request reuse only; no semantic-quality or real encoder claim'] };
    try {
      await run(); await run();
      const cache = new CompanionMemoryViewCache(f.cacheRoot), artifacts = await cache.loadArtifacts('alpha:owner-v2', profileKey);
      receipt.initialArtifacts = artifacts; receipt.initialModelCalls = f.controls.timelineCalls;
      expect(artifacts?.agents.flatMap(agent => agent.months)).toHaveLength(2); expect(f.controls.timelineCalls).toBe(4);
      const before = f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
      for (let index = 0; index < 100; index++) {
        f.store.request({ type: 'memory.organize', ...scope, ids: [f.note.id], tags: ['alpha', 'tag_' + index] });
        await service.drainDeliveries(); service.changed('alpha'); clock += 301000; await run();
      }
      const after = f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!, owner = companionMemoryIdentity(f.store.state(false).companions.find(owner => owner.id === 'alpha')!);
      receipt.nativeRememberCalls = nativeRemember.mock.calls.length; receipt.modelCallsAfterAnnotations = f.controls.timelineCalls;
      expect(nativeRemember).toHaveBeenCalledTimes(100); expect(after.semanticRevision).toBe(before.semanticRevision);
      expect(f.controls.timelineCalls).toBe(4);
      const freshView = { scopeId: 'actual_tag_reuse_fresh_view' };
      const timeZone = f.store.request({ type: 'world.clock' }).worldClock!.timeZone;
      await client.replace(freshView, after.notes.map(note => ({ id: note.id, content: note.content, tags: note.tags, diaryName: note.diaryName, occurredAt: note.occurredAt,
        author: owner.agentName, metadata: { ...note.metadata, hostMemoryOwner: owner, hostMemoryVersion: note.version }, hostProjection: { timeZone } })));
      const imported = await client.importTimelineArtifacts(freshView, after.semanticRevision!, artifacts!);
      receipt.imported = imported;
      expect(imported).toEqual({ acceptedMonths: 2, skippedMonths: 0 });
      await client.timeline(freshView, { operation: 'generateTimelines', agentName: owner.agentName, owner, options: { overwrite: false } });
      await client.timeline(freshView, { operation: 'generateSummaries', agentName: owner.agentName, owner, options: { overwrite: false } });
      const final = await client.exportTimelineArtifacts(freshView, after.semanticRevision!);
      receipt.finalArtifacts = final; receipt.finalModelCalls = f.controls.timelineCalls; receipt.errors = report.mock.calls.map(([error]) => String(error));
      expect(final.agents.flatMap(agent => agent.months).every(month => month.content && month.summary)).toBe(true);
      expect(final.agents.flatMap(agent => agent.months)).toHaveLength(2); expect(f.controls.timelineCalls).toBe(4);
      // A real changed body is the negative control: normalization must not
      // turn genuine October evidence changes into a reusable old digest.
      const original = after.notes.find(note => note.id === f.note.id)!;
      const changedSource = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '2026-10-14 alpha confirmed the umbrella was returned, correcting the earlier unfinished status.', replyDirective: 'none' });
      f.store.request({ type: 'memory.revise', ...scope, id: original.id, expectedVersion: original.version, candidate: { artifactKind: 'episode_memory' as const, content: changedSource.content,
        occurredAt: original.occurredAt, tags: original.tags, sourceMessageIds: [changedSource.id], evidence: [{ sourceMessageId: changedSource.id, quote: changedSource.content }] } });
      await service.drainDeliveries();
      const changed = f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!, changedView = { scopeId: 'actual_body_changed_control_view' };
      expect(changed.semanticRevision).not.toBe(after.semanticRevision);
      await client.replace(changedView, changed.notes.map(note => ({ id: note.id, content: note.content, tags: note.tags, diaryName: note.diaryName, occurredAt: note.occurredAt,
        author: owner.agentName, metadata: { ...note.metadata, hostMemoryOwner: owner, hostMemoryVersion: note.version }, hostProjection: { timeZone } })));
      const negativeImport = await client.importTimelineArtifacts(changedView, changed.semanticRevision!, artifacts!);
      receipt.changedBodyImport = negativeImport; expect(negativeImport).toEqual({ acceptedMonths: 1, skippedMonths: 1 });
      await client.timeline(changedView, { operation: 'generateTimelines', agentName: owner.agentName, owner, options: { overwrite: false } });
      await client.timeline(changedView, { operation: 'generateSummaries', agentName: owner.agentName, owner, options: { overwrite: false } });
      receipt.modelCallsAfterRealBodyChange = f.controls.timelineCalls; expect(f.controls.timelineCalls).toBe(6);
      const changedArtifacts = await client.exportTimelineArtifacts(changedView, changed.semanticRevision!);
      receipt.changedBodyArtifacts = changedArtifacts;
      const months = changedArtifacts.agents.flatMap(agent => agent.months), initial = artifacts!.agents.flatMap(agent => agent.months);
      expect(months.find(month => month.month === '2026-09')?.sourceDigest).toBe(initial.find(month => month.month === '2026-09')?.sourceDigest);
      expect(months.find(month => month.month === '2026-10')?.sourceDigest).not.toBe(initial.find(month => month.month === '2026-10')?.sourceDigest);
      expect(report).not.toHaveBeenCalled(); receipt.status = 'passed';
    } catch (error) { receipt.failure = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      receipt.timelinePrompts = f.controls.timelinePrompts; receipt.modelCalls = f.controls.timelineCalls;
      const output = path.resolve(`artifacts/vcp-validation/memory-100tag-native-reuse-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
      await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(receipt, null, 2));
      time.mockRestore(); nativeRemember.mockRestore(); await core.release?.();
    }
  });
  it('reports actual future checks without blocking maintenance on foreground work', async () => {
    const { createService, controls } = await fixture();
    const { service, client, changed } = await createService();
    const replace = vi.spyOn(client, 'replace'), before = Date.now();
    service.schedule(10000);
    const planned = await service.schedulingFor('alpha'), at = planned.schedulers.find(item => item.kind === 'capture')!.nextCheckAt!;
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before + 10000); expect(changed).toHaveBeenCalled();
    service.schedule(20000);
    expect((await service.schedulingFor('alpha')).schedulers.find(item => item.kind === 'capture')?.nextCheckAt).toBe(at);
    controls.foregroundBusy = true;
    const busy = await service.schedulingFor('alpha');
    expect(busy.schedulers.find(item => item.kind === 'capture')).toMatchObject({ nextCheckAt: at });
    expect(busy.schedulers.every(item => item.waitingReason !== 'foreground_busy')).toBe(true);
    controls.foregroundBusy = false; controls.modelConfigured = false;
    expect((await service.schedulingFor('alpha')).schedulers.find(item => item.kind === 'capture')?.waitingReason).toBe('model_unconfigured');
    controls.modelConfigured = true;
    controls.deviceState = 'testing';
    const detecting = await service.schedulingFor('alpha');
    expect(detecting.schedulers.find(item => item.kind === 'index')).toMatchObject({ waitingReason: 'device_testing', nextCheckAt: undefined });
    expect(detecting.schedulers.find(item => item.kind === 'timeline')?.waitingReason).toBe('device_testing');
    expect(detecting.schedulers.find(item => item.kind === 'capture')?.waitingReason).not.toBe('device_testing');
    controls.deviceState = 'unsupported';
    expect((await service.schedulingFor('alpha')).schedulers.find(item => item.kind === 'index')?.waitingReason).toBe('embedding_unavailable');
    controls.deviceState = 'unchecked';
    expect((await service.schedulingFor('alpha')).schedulers.find(item => item.kind === 'index')?.waitingReason).not.toBe('embedding_unavailable');
    expect(controls.deviceStatusReads).toBeGreaterThan(0);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(at) + 1000);
    try {
      const overdue = await service.schedulingFor('alpha');
      expect(overdue.nextCheckAt).toBeUndefined(); expect(overdue.schedulers.every(item => !item.nextCheckAt)).toBe(true);
      expect(overdue.schedulers.find(item => item.kind === 'capture')?.waitingReason).toBe('event_loop_busy');
    } finally { vi.useRealTimers(); }
    expect(replace).not.toHaveBeenCalled();
    await service.close();
    expect((await service.schedulingFor('alpha')).schedulers.every(item => item.waitingReason === 'app_stopped' && !item.nextCheckAt)).toBe(true);
  });

  it('generates a real timeline and reuses it after a tag change and restart in passive RAG context', async () => {
    const { createService, cacheRoot, controls, conversation, store, note } = await fixture();
    const first = await createService(); first.service.schedule(0);
    const cache = new CompanionMemoryViewCache(cacheRoot);
    const identity = 'alpha:owner-v2';
    await vi.waitFor(async () => {
      const artifacts = await cache.loadArtifacts(identity, first.profileKey);
      expect(artifacts?.agents[0]?.months[0], first.report.mock.calls.map(([error]) => String(error)).join('\n')).toMatchObject({ month: '2026-10', summary: expect.stringContaining('TIMELINE_ONLY_VALIDATED_MONTH') });
    }, { timeout: 20000, interval: 50 });
    expect(controls.timelineCalls).toBe(2);
    const artifacts = await cache.loadArtifacts(identity, first.profileKey);
    expect(artifacts?.owner).toEqual(companionMemoryIdentity({ id: 'alpha', name: 'Alpha' }));
    expect(artifacts?.agents[0]?.agentName).toBe('Alpha');
    expect(artifacts?.agents[0]?.months[0]?.content).toContain('2026-10 Alpha时间线');
    expect(controls.timelinePrompts[0]).toContain('[2026-10-14] - Alpha');
    expect(controls.timelinePrompts[0]).toContain('[09:00:00]');
    expect(controls.timelinePrompts[0]).toContain('宿主核验的记忆归属');
    expect(controls.timelinePrompts[0]).not.toContain('[2026-10-14] - WorldlineBox');
    expect(first.service.processingFor('alpha')[0]).toMatchObject({ kind: 'timeline', status: 'completed', conversationId: conversation.id,
      sourceRevision: artifacts?.sourceRevision, startedAt: expect.any(String), updatedAt: expect.any(String) });
    expect(first.service.processingFor('another-owner')).toEqual([]);
    expect(first.published).toHaveBeenCalledWith(expect.objectContaining({ scope: { companionId: 'alpha', conversationId: conversation.id }, artifacts: expect.objectContaining({ sourceRevision: expect.any(String) }) }));
    expect(first.published.mock.calls[0]![0].validAtPublication).toBe(true);
    // A completed run no longer owns a publication lease. Its callback must
    // not become a reusable authority after onTimelineArtifacts returns.
    expect(await first.published.mock.calls[0]![0].stillValid()).toBe(false);
    await first.service.close();
    store.request({ type: 'memory.organize', companionId: 'alpha', conversationId: conversation.id, ids: [note.id], tags: ['annotated', 'umbrella'] });
    for (;;) {
      const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!outbox) break;
      store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
    }
    expect(store.request({ type: 'memory.snapshot', companionId: 'alpha', conversationId: conversation.id, contentKinds: ['episode_memory'] }).memorySnapshot?.semanticRevision).toBe(artifacts?.sourceRevision);
    const restarted = await createService();
    expect(restarted.service.processingFor('alpha')).toEqual([]);
    const replayed = await restarted.service.search({ companionId: 'alpha', conversationId: conversation.id, query: 'alpha umbrella' }, 'passive');
    expect(replayed.memoryContext?.text).toContain('umbrella');
    expect(replayed.memoryContext?.text).not.toContain('TIMELINE_ONLY_VALIDATED_MONTH');
    expect(replayed.memoryContext?.text).not.toContain('[[VCPTimeLine');
    expect(controls.focusCalls).toBe(1);
    expect(controls.focusPrompts[0]).not.toContain('TIMELINE_ONLY_VALIDATED_MONTH');
    const timeline = vi.spyOn(restarted.client, 'timeline');
    restarted.service.schedule(0);
    await vi.waitFor(() => expect(restarted.changed).toHaveBeenCalled(), { timeout: 20000 });
    expect(timeline).not.toHaveBeenCalled();
    expect(controls.timelineCalls).toBe(2);
  });

  it('does not reuse legacy brand-authored artifacts and rejects identity changes through runtime configuration', async () => {
    const { createService, cacheRoot, controls, conversation, store, note } = await fixture();
    const identity = 'alpha:owner-v2', cache = new CompanionMemoryViewCache(cacheRoot);
    const revision = store.request({ type: 'memory.snapshot', companionId: 'alpha', conversationId: conversation.id }).memorySnapshot!.revision;
    const first = await createService(), imported = vi.spyOn(first.client, 'importTimelineArtifacts');
    await cache.saveArtifacts(identity, first.profileKey, { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision,
      agents: [{ agentName: 'WorldlineBox', months: [{ month: '2026-10', sourceDigest: 'a'.repeat(64), content: 'STALE_BRAND_OWNER', summary: 'STALE_BRAND_OWNER' }] }] });
    first.service.schedule(0);
    await vi.waitFor(() => expect(first.published).toHaveBeenCalled(), { timeout: 20000 });
    expect(imported).not.toHaveBeenCalled();
    expect(first.published.mock.calls[0]![0].artifacts.owner).toMatchObject({ companionId: 'alpha', name: 'Alpha', version: 2 });
    expect(JSON.stringify(first.published.mock.calls)).not.toContain('STALE_BRAND_OWNER');
    await vi.waitFor(() => expect(first.service.processingFor('alpha')[0]?.status).toBe('completed'));
    await first.service.close();
    const owner = store.state().companions.find(role => role.id === 'alpha')!;
    expect(() => store.updateCompanion(owner.id, { ...owner, name: '小肥鱼' }, owner.revision)).toThrow('身份与人格');
    const renamed = await createService(); renamed.service.schedule = () => undefined;
    const run = () => Reflect.apply(Reflect.get(CompanionMemoryService.prototype, 'runContinuity'), renamed.service,
      [{ companionId: 'alpha', conversationId: conversation.id }, 0]);
    const callsBeforeRestart = controls.timelineCalls; expect(await run()).toBe(false);
    expect(renamed.published).not.toHaveBeenCalled(); expect(controls.timelineCalls).toBe(callsBeforeRestart);
    const artifacts = await new CompanionMemoryViewCache(cacheRoot).loadArtifacts(identity, renamed.profileKey);
    expect(artifacts?.owner).toMatchObject({ companionId: 'alpha', name: 'Alpha', agentName: 'Alpha', version: 2 });
    expect(artifacts?.agents[0]?.agentName).toBe('Alpha');
    expect(artifacts?.agents[0]?.months[0]?.content).toContain('2026-10 Alpha时间线');
    expect(JSON.stringify(artifacts)).not.toContain('小肥鱼');
    const current = store.request({ type: 'memory.read', companionId: 'alpha', conversationId: conversation.id, id: note.id }).memoryRead!.memory;
    expect(current).toMatchObject({ id: note.id, version: note.version, content: note.content });
  });

  it('serves a foreground query during long generation and immediately cancels and purges on source retraction', async () => {
    const { root, createService, cacheRoot, controls, conversation, store, note, pending } = await fixture();
    const { service, client, report, runtime } = await createService();
    controls.hangTimeline = true; service.schedule(0);
    await vi.waitFor(() => expect(pending.size, report.mock.calls.map(([error]) => String(error)).join('\n')).toBe(1), { timeout: 20000 });
    expect(service.processingFor('alpha')[0]).toMatchObject({ kind: 'timeline', status: 'running', stage: '整理2026-10的月度时间线' });
    const front = await service.search({ companionId: 'alpha', conversationId: conversation.id, query: 'alpha umbrella' }, 'passive');
    expect(front.memoryPage?.items[0]?.memory.id).toBe(note.id);
    const ownerProjection = path.join(root, 'runtime', '伙伴记忆', 'alpha', '.运行', '索引', 'generation');
    expect((await readdir(ownerProjection)).length).toBeGreaterThan(0);
    store.request({ type: 'memory.forget', companionId: 'alpha', conversationId: conversation.id, id: note.id });
    const interrupted = vi.spyOn(client, 'interruptScope'), purged = vi.spyOn(runtime, 'purgeOwner');
    await service.invalidate('alpha', [note.scopeId]);
    expect(service.processingFor('alpha')[0]?.status).toBe('stale');
    expect(interrupted).toHaveBeenCalled();
    expect(purged).toHaveBeenCalledWith('alpha', expect.objectContaining({ canonicalScopes: expect.arrayContaining([note.scopeId]) }));
    await expect(readdir(ownerProjection)).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.waitFor(() => expect(controls.disconnected).toBeGreaterThan(0));
    expect((await readdir(cacheRoot)).some(file => file.endsWith('.timeline'))).toBe(false);
    const recalled = await service.search({ companionId: 'alpha', conversationId: conversation.id, query: 'alpha umbrella' }, 'passive');
    expect(recalled.memoryPage?.items).toEqual([]);
    expect(recalled.memoryContext).toBeUndefined();
  });

  it('explicitly retries only a failed owner without waiting for the five-minute monthly cooldown', async () => {
    const { createService, controls, store, note, conversation } = await fixture();
    const { service, client, published } = await createService();
    vi.spyOn(client, 'timeline').mockRejectedValueOnce(new Error('fixture timeline interruption'));
    service.schedule(0);
    await vi.waitFor(() => expect(service.processingFor('alpha')[0]?.status).toBe('failed'), { timeout: 20000 });
    const first = service.processingFor('alpha')[0]!;
    expect(Date.parse(first.nextAttemptAt!)).toBeGreaterThan(Date.now());
    expect(service.retryProcessingFor('unrelated-owner')).toBe(0);
    expect(service.processingFor('alpha')[0]?.status).toBe('failed');
    expect(service.retryProcessingFor('alpha')).toBe(1);
    await vi.waitFor(() => expect(published).toHaveBeenCalled(), { timeout: 20000 });
    expect(service.processingFor('alpha')[0]).toMatchObject({ id: first.id, status: 'completed', attempts: 2 });
    expect(controls.timelineCalls).toBe(2);
    expect(service.retryProcessingFor('alpha')).toBe(0);
    expect(store.request({ type: 'memory.read', companionId: 'alpha', conversationId: conversation.id, id: note.id }).memoryRead?.memory)
      .toMatchObject({ id: note.id, version: note.version, content: note.content });
  });

  it('processes a newer independent source revision while retaining the earlier failed fixed input and original evidence', async () => {
    const { createService, store, conversation, controls, note } = await fixture();
    const { service, client, published } = await createService();
    vi.spyOn(client, 'timeline').mockRejectedValueOnce(new Error('first revision failure')).mockRejectedValueOnce(new Error('new revision failure'));
    service.schedule(0);
    await vi.waitFor(() => expect(service.processingFor('alpha')[0]?.status).toBe('failed'), { timeout: 20000 });
    const first = service.processingFor('alpha')[0]!;
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: 'The blue umbrella was returned to alpha.', replyDirective: 'none' });
    store.request({ type: 'memory.record', companionId: 'alpha', conversationId: conversation.id,
      candidate: { artifactKind: 'episode_memory' as const, content: source.content, tags: ['umbrella', 'returned'], occurredAt: '2026-10-14T02:00:00Z',
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    expect(service.retryProcessingFor('alpha')).toBe(1);
    await vi.waitFor(() => {
      const jobs = service.processingFor('alpha');
      expect(jobs[0]).toMatchObject({ status: 'failed', sourceRevision: expect.any(String) });
      expect(jobs[0]!.sourceRevision).not.toBe(first.sourceRevision);
      expect(jobs[0]!.id).not.toBe(first.id);
      expect(jobs.find(job => job.id === first.id)?.status).toBe('failed');
      expect(store.request({ type: 'jobs.inspect', ownerId: 'alpha', kind: 'timeline', id: first.id }).jobDisposition).toMatchObject({ state: 'failed', failureCount: 1 });
    }, { timeout: 20000 });
    expect(service.retryProcessingFor('alpha')).toBe(service.processingFor('alpha').filter(job => job.status === 'failed').length);
    await vi.waitFor(() => expect(published).toHaveBeenCalled(), { timeout: 20000 });
    const jobs = service.processingFor('alpha');
    expect(jobs[0]?.status).toBe('completed'); expect(jobs.find(job => job.id === first.id)?.status).toBe('failed');
    expect(jobs.some(job => job.status === 'pending' || job.status === 'running')).toBe(false);
    expect(store.getMessage(note.sources[0]!.messageId).content).toBe(note.content);
    expect(controls.timelineCalls).toBe(2);
  });

  it('closes while the original timeline model call is pending', async () => {
    const { createService, controls, pending } = await fixture();
    const { service, report } = await createService(); controls.hangTimeline = true; service.schedule(0);
    await vi.waitFor(() => expect(pending.size, report.mock.calls.map(([error]) => String(error)).join('\n')).toBe(1), { timeout: 20000 });
    await service.close();
    await vi.waitFor(() => expect(controls.disconnected).toBe(1));
  });
});
