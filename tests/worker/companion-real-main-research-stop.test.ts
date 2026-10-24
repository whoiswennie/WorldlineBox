import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { CompanionsStore } from '../../src/companions/store';
import { generateCompanionStructured } from '../../src/main/companions/model';

vi.mock('../fixtures/companion-real-chat', () => ({ realGlobalChatConfig: async () => ({
  apiFormat: 'openai_chat', model: 'offline_no_model_calls', apiKey: 'offline-only',
}) }));
async function removeOwned(root: string) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-real-main-')) throw new Error('Unexpected research-stop cleanup target.');
  await rm(root, { recursive: true, force: true });
}

it('interrupts a real Main research wait, shuts down normally and preserves the unchanged pending source without model calls', async () => {
  const control = await mkdtemp(path.join(tmpdir(), 'worldlinebox-real-main-stop-control-'));
  const stop = path.join(control, 'stop'), output = path.join(control, 'evidence.json');
  const seeds = [{ id: 'writer', name: 'writer', description: '', persona: '只按真实来源协作。', model: '', avatar: 'sister' as const, active: true, proactive: false }];
  const f = await realMainFixture('offline_research_stop', seeds, false, { researchStopFile: stop });
  let closed = false;
  try {
    const room = f.store.openPrivate('writer');
    const source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '这是保留的实际待处理来源。', replyDirective: 'none' });
    const draft = f.store.appendMessage({ conversationId: room.id, authorId: 'writer', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
    const waiting = f.waitFor(() => false, 'offline_wait', 10000);
    const interrupted = expect(waiting).rejects.toThrow('REAL_MAIN_RESEARCH_INTERRUPTED_offline_research_stop');
    await writeFile(stop, 'Research controller requested a normal stop.'); await interrupted;
    await f.close(true); closed = true;
    await f.save(output, { status: 'interrupted', sourceId: source.id, draftId: draft.id, calls: f.calls }, true);
    const stored = new CompanionsStore(path.join(output.replace(/\.json$/u, '-sqlite'), 'messages.sqlite'), seeds);
    try {
      expect(stored.getMessage(source.id).content).toBe(source.content);
      expect(stored.getMessage(draft.id).content).toBe('');
    } finally { stored.close(); }
    expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ status: 'interrupted', sourceId: source.id, calls: [] });
  } finally {
    if (!closed) await f.close(true);
    for (const root of [control, f.root]) await removeOwned(root);
  }
});

it('retains the research interruption cause when an already-returned model response stream abort is wrapped as a network error', async () => {
  const control = await mkdtemp(path.join(tmpdir(), 'worldlinebox-real-main-stop-control-')), stop = path.join(control, 'stop');
  const f = await realMainFixture('offline_stream_stop', [{ id: 'writer', name: 'writer', description: '', persona: '测试。', model: '', avatar: 'sister', active: false, proactive: false }], false, { researchStopFile: stop });
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init!.signal!.addEventListener('abort', () => controller.error(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  try {
    const request = generateCompanionStructured({ system: '只输出JSON。', user: JSON.stringify({ purpose: 'offline_stream_stop' }) }, f.config, undefined, { fetchFn: f.modelFetch });
    const aborted = expect(request).rejects.toMatchObject({ code: 'NETWORK' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); await writeFile(stop, 'Actual response stream research stop.');
    await aborted; expect(() => f.throwIfResearchStopped()).toThrow('REAL_MAIN_RESEARCH_INTERRUPTED_offline_stream_stop');
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close(true); vi.unstubAllGlobals();
    for (const root of [control, f.root]) await removeOwned(root);
  }
});
