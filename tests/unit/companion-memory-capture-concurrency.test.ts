import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
it('limits journal inference to two owners and cancellation releases only that owner without waiting for the other provider', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-memory-capture-concurrency-'));
  const owners = ['alpha', 'beta', 'charlie'];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), owners.map(id => ({ id, name: id, description: '', persona: '谨慎', model: '', avatar: 'sister', active: true, proactive: false })));
  const started: string[] = [], releases = new Map<string, () => void>(), aborted: string[] = [];
  let active = 0, maximum = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    const owner = payload.companion.id as string; started.push(owner); active++; maximum = Math.max(maximum, active);
    return new Promise<Response>((resolve, reject) => {
      const abort = () => { active--; aborted.push(owner); reject(new Error('fixture aborted')); };
      init?.signal?.addEventListener('abort', abort, { once: true });
      releases.set(owner, () => { init?.signal?.removeEventListener('abort', abort); active--; resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"notes":[]}' } }] }))); });
    });
  };
  const service = new CompanionMemoryService({ request: async command => { const response = store.request(command); if (response.worldClock) response.worldClock.backlog = false; return response; },
    configFor: async () => ({ model: 'test', apiFormat: 'openai_chat', baseUrl: 'https://fixture.invalid', apiKey: 'test' }), fetchFn,
    changed: () => undefined, busy: () => false, report: error => { throw error; } });
  try {
    // Only the host clock is controlled: provider promises, aborts and service
    // timers remain real throughout this concurrency/cancellation experiment.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now());
    for (const id of owners) store.appendMessage({ conversationId: store.openPrivate(id).id, authorId: 'user', content: `和${id}约定周六带雨伞。`, replyDirective: 'none' });
    expect(store.request({ type: 'memory.jobs.claim' }).memoryJob).toBeUndefined();
    vi.setSystemTime(Date.now() + 60_001);
    service.schedule(0);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(maximum).toBe(2);
    await service.drainCompanion('alpha');
    await vi.waitFor(() => expect(started).toContain('charlie'));
    expect(aborted).toEqual(['alpha']);
    expect(maximum).toBe(2);
    expect(active).toBe(2); // beta is still pending while charlie has started.
    releases.get('beta')!(); releases.get('charlie')!();
    await vi.waitFor(() => expect(active).toBe(0));
  } finally { await service.close(); vi.useRealTimers(); store.close(); await removeOwnedDirectory(root); }
});
