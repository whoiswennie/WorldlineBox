import { fork } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function launch(file: string): VcpMemoryTransport {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete environment.NODE_PATH;
  const child = fork(file, [], { execPath: process.execPath, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return { postMessage: message => { child.send(message as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
}
async function fixture() {
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
      if (body.messages?.length === 1 && body.messages[0]?.role === 'user') {
        controls.focusCalls++; controls.focusPrompts.push(body.messages[0].content);
        const content = `这是我获取的所有相关知识/记忆[[alpha borrowed the blue umbrella.${body.messages[0].content.includes('TIMELINE_ONLY_VALIDATED_MONTH') ? ' TIMELINE_ONLY_VALIDATED_MONTH.' : ''}]]`;
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
    response.end(JSON.stringify({ data: body.input.map((_input: string, index: number) => ({ index, embedding: [1, 0, 0, 0] })) }));
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
    candidate: { content: source.content, tags: ['alpha', 'umbrella'], occurredAt: '2026-10-14T01:00:00Z',
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture-chat', apiKey: 'fixture-key', baseUrl: `${baseUrl}/chat` };
  const cacheRoot = path.join(root, 'views');
  const services: CompanionMemoryService[] = [];
  cleanups.push(async () => { for (const service of services) await service.close(); });
  function createService() {
    const client = new VcpMemoryClient({ dataRoot: path.join(root, 'runtime'), vendorRoot: path.resolve('vendor/vcp-memory'),
      workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), launch, maxOpenScopes: 4, requestTimeoutMs: 30000,
      embedding: { baseUrl: `${baseUrl}/document`, queryBaseUrl: `${baseUrl}/query`, model: 'fixture', modelSignature: 'continuity-test', dimension: 4, apiKey: 'fixture-key' },
      plugins: { chat: { baseUrl: `${baseUrl}/chat`, model: 'fixture-chat', apiKey: 'fixture-key' } } });
    const changed = vi.fn(), report = vi.fn(), published = vi.fn();
    const service = new CompanionMemoryService({ cacheRoot, request: async command => {
      const response = store.request(command);
      // This fixture runs the memory host alone; the app's separate world ticker is out of scope.
      if (response.worldClock) response.worldClock.backlog = false;
      return response;
    },
      configFor: async () => ({ ...config, model: controls.modelConfigured ? config.model : '' }), runtime: { get: async () => ({ client, profileKey: 'continuity-test' }), close: () => client.close() },
      runtimeAvailability: () => { controls.deviceStatusReads++; return { state: controls.deviceState, message: '实际检测快照的公开原因。' }; },
      fetchFn: fetch, busy: () => controls.foregroundBusy, changed, report,
      onTimelineArtifacts: async (scope, artifacts, stillValid) => { published({ scope, artifacts, stillValid }); } });
    services.push(service); return { service, client, changed, report, published };
  }
  return { root, store, note, conversation, cacheRoot, controls, pending, createService };
}

describe('original monthly VCP continuity behind the main memory service', () => {
  it('reports only registered future host checks and explains busy and unconfigured conditions without loading a worker', async () => {
    const { createService, controls } = await fixture();
    const { service, client, changed } = createService();
    const replace = vi.spyOn(client, 'replace'), before = Date.now();
    service.schedule(10000);
    const planned = await service.schedulingFor('alpha'), at = planned.schedulers.find(item => item.kind === 'capture')!.nextCheckAt!;
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before + 10000); expect(changed).toHaveBeenCalled();
    service.schedule(20000);
    expect((await service.schedulingFor('alpha')).schedulers.find(item => item.kind === 'capture')?.nextCheckAt).toBe(at);
    controls.foregroundBusy = true;
    const busy = await service.schedulingFor('alpha');
    expect(busy.schedulers.find(item => item.kind === 'capture')).toMatchObject({ waitingReason: 'foreground_busy', nextCheckAt: at });
    expect(busy.schedulers.find(item => item.kind === 'timeline')?.waitingReason).toBe('foreground_busy');
    expect(busy.schedulers.find(item => item.kind === 'index')?.waitingReason).not.toBe('foreground_busy');
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

  it('generates and persists a real monthly timeline and summary, then reuses them after restart in passive RAG context', async () => {
    const { createService, cacheRoot, controls, conversation } = await fixture();
    const first = createService(); first.service.schedule(0);
    const cache = new CompanionMemoryViewCache(cacheRoot);
    const identity = `alpha:${conversation.id}`;
    await vi.waitFor(async () => {
      const artifacts = await cache.loadArtifacts(identity, 'continuity-test');
      expect(artifacts?.agents[0]?.months[0], first.report.mock.calls.map(([error]) => String(error)).join('\n')).toMatchObject({ month: '2026-10', summary: expect.stringContaining('TIMELINE_ONLY_VALIDATED_MONTH') });
    }, { timeout: 20000, interval: 50 });
    expect(controls.timelineCalls).toBe(2);
    const artifacts = await cache.loadArtifacts(identity, 'continuity-test');
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
    expect(await first.published.mock.calls[0]![0].stillValid()).toBe(true);
    await first.service.close();
    const restarted = createService();
    expect(restarted.service.processingFor('alpha')).toEqual([]);
    const replayed = await restarted.service.search({ companionId: 'alpha', conversationId: conversation.id, query: 'alpha umbrella' }, 'passive');
    expect(replayed.memoryContext?.text).toContain('umbrella');
    expect(replayed.memoryContext?.text).toContain('TIMELINE_ONLY_VALIDATED_MONTH');
    expect(replayed.memoryContext?.text).not.toContain('[[VCPTimeLine');
    expect(controls.focusCalls).toBe(1);
    expect(controls.focusPrompts[0]).toContain('TIMELINE_ONLY_VALIDATED_MONTH');
    const timeline = vi.spyOn(restarted.client, 'timeline');
    restarted.service.schedule(0);
    await vi.waitFor(() => expect(restarted.changed).toHaveBeenCalled(), { timeout: 20000 });
    expect(timeline).not.toHaveBeenCalled();
    expect(controls.timelineCalls).toBe(2);
  });

  it('does not reuse legacy brand-authored artifacts or an old owner name after a resident rename', async () => {
    const { createService, cacheRoot, controls, conversation, store, note } = await fixture();
    const identity = `alpha:${conversation.id}`, cache = new CompanionMemoryViewCache(cacheRoot);
    const revision = store.request({ type: 'memory.snapshot', companionId: 'alpha', conversationId: conversation.id }).memorySnapshot!.revision;
    await cache.saveArtifacts(identity, 'continuity-test', { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision,
      agents: [{ agentName: 'WorldlineBox', months: [{ month: '2026-10', sourceDigest: 'a'.repeat(64), content: 'STALE_BRAND_OWNER', summary: 'STALE_BRAND_OWNER' }] }] });
    const first = createService(), imported = vi.spyOn(first.client, 'importTimelineArtifacts');
    first.service.schedule(0);
    await vi.waitFor(() => expect(first.published).toHaveBeenCalled(), { timeout: 20000 });
    expect(imported).not.toHaveBeenCalled();
    expect(first.published.mock.calls[0]![0].artifacts.owner).toMatchObject({ companionId: 'alpha', name: 'Alpha', version: 2 });
    expect(JSON.stringify(first.published.mock.calls)).not.toContain('STALE_BRAND_OWNER');
    await first.service.close();
    const owner = store.state().companions.find(role => role.id === 'alpha')!;
    store.updateCompanion(owner.id, { ...owner, name: '小肥鱼' }, owner.revision);
    const renamed = createService(); renamed.service.schedule(0);
    await vi.waitFor(() => expect(renamed.published).toHaveBeenCalled(), { timeout: 20000 });
    const artifacts = renamed.published.mock.calls[0]![0].artifacts;
    expect(artifacts.owner).toMatchObject({ companionId: 'alpha', name: '小肥鱼', agentName: '小肥鱼', version: 2 });
    expect(artifacts.agents[0]?.agentName).toBe('小肥鱼');
    expect(artifacts.agents[0]?.months[0]?.content).toContain('2026-10 小肥鱼时间线');
    expect(controls.timelineCalls).toBe(4);
    const current = store.request({ type: 'memory.read', companionId: 'alpha', conversationId: conversation.id, id: note.id }).memoryRead!.memory;
    expect(current).toMatchObject({ id: note.id, version: note.version, content: note.content });
  });

  it('serves a foreground query during long generation and immediately cancels and purges on source retraction', async () => {
    const { createService, cacheRoot, controls, conversation, store, note, pending } = await fixture();
    const { service, client, report } = createService();
    controls.hangTimeline = true; service.schedule(0);
    await vi.waitFor(() => expect(pending.size, report.mock.calls.map(([error]) => String(error)).join('\n')).toBe(1), { timeout: 20000 });
    expect(service.processingFor('alpha')[0]).toMatchObject({ kind: 'timeline', status: 'running', stage: '整理2026-10的月度时间线' });
    const front = await service.search({ companionId: 'alpha', conversationId: conversation.id, query: 'alpha umbrella' }, 'passive');
    expect(front.memoryPage?.items[0]?.memory.id).toBe(note.id);
    store.request({ type: 'memory.forget', companionId: 'alpha', conversationId: conversation.id, id: note.id });
    const interrupted = vi.spyOn(client, 'interruptScope'), purged = vi.spyOn(client, 'purgeScope');
    await service.invalidate('alpha', [note.scopeId]);
    expect(service.processingFor('alpha')[0]?.status).toBe('cancelled');
    expect(interrupted).toHaveBeenCalled(); expect(purged).toHaveBeenCalled();
    await vi.waitFor(() => expect(controls.disconnected).toBeGreaterThan(0));
    expect((await readdir(cacheRoot)).some(file => file.endsWith('.timeline'))).toBe(false);
    const recalled = await service.search({ companionId: 'alpha', conversationId: conversation.id, query: 'alpha umbrella' }, 'passive');
    expect(recalled.memoryPage?.items).toEqual([]);
    expect(recalled.memoryContext).toBeUndefined();
  });

  it('explicitly retries only a failed owner without waiting for the five-minute monthly cooldown', async () => {
    const { createService, controls, store, note, conversation } = await fixture();
    const { service, client, published } = createService();
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

  it('retires a queued old revision when a newer source revision is actually retried', async () => {
    const { createService, store, conversation, controls } = await fixture();
    const { service, client, published } = createService();
    vi.spyOn(client, 'timeline').mockRejectedValueOnce(new Error('first revision failure')).mockRejectedValueOnce(new Error('new revision failure'));
    service.schedule(0);
    await vi.waitFor(() => expect(service.processingFor('alpha')[0]?.status).toBe('failed'), { timeout: 20000 });
    const first = service.processingFor('alpha')[0]!;
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: 'The blue umbrella was returned to alpha.', replyDirective: 'none' });
    store.request({ type: 'memory.record', companionId: 'alpha', conversationId: conversation.id,
      candidate: { content: source.content, tags: ['umbrella', 'returned'], occurredAt: '2026-10-14T02:00:00Z',
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    expect(service.retryProcessingFor('alpha')).toBe(1);
    await vi.waitFor(() => {
      const jobs = service.processingFor('alpha');
      expect(jobs[0]).toMatchObject({ status: 'failed', sourceRevision: expect.any(String) });
      expect(jobs[0]!.sourceRevision).not.toBe(first.sourceRevision);
      expect(jobs.find(job => job.id === first.id)?.status).toBe('stale');
    }, { timeout: 20000 });
    expect(service.retryProcessingFor('alpha')).toBe(1);
    await vi.waitFor(() => expect(published).toHaveBeenCalled(), { timeout: 20000 });
    const jobs = service.processingFor('alpha');
    expect(jobs[0]?.status).toBe('completed'); expect(jobs.find(job => job.id === first.id)?.status).toBe('stale');
    expect(jobs.some(job => job.status === 'pending' || job.status === 'running')).toBe(false);
    expect(controls.timelineCalls).toBe(2);
  });

  it('closes while the original timeline model call is pending', async () => {
    const { createService, controls, pending } = await fixture();
    const { service, report } = createService(); controls.hangTimeline = true; service.schedule(0);
    await vi.waitFor(() => expect(pending.size, report.mock.calls.map(([error]) => String(error)).join('\n')).toBe(1), { timeout: 20000 });
    await service.close();
    await vi.waitFor(() => expect(controls.disconnected).toBe(1));
  });
});
