import { expect, it, vi } from 'vitest';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { generateCompanionText } from '../../src/main/companions/model';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('drains an admitted local resolver after the provider caller has already returned cancellation', async () => {
  const io = new CompanionAssetIo(), entered = deferred(), release = deferred(), controller = new AbortController();
  const fetchFn = vi.fn<typeof fetch>();
  let readFinished = false, closed = false;
  const result = generateCompanionText({ system: 'HOST', user: '{}' }, { ownerId: 'alice', apiFormat: 'openai_chat', model: 'fixture', apiKey: 'test',
    resolveAssetContext: (context) => io.run(async () => { entered.resolve(); await release.promise; readFinished = true; return context; }) }, controller.signal, { fetchFn });
  await entered.promise;
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
  const closing = io.close().then(() => { closed = true; });
  await Promise.resolve(); expect(readFinished).toBe(false); expect(closed).toBe(false);
  await expect(io.run(async () => undefined)).rejects.toThrow('正在关闭');
  release.resolve(); await closing;
  expect(readFinished).toBe(true); expect(closed).toBe(true); expect(fetchFn).not.toHaveBeenCalled();
});

it('drains failed local operations without hiding their original rejection', async () => {
  const io = new CompanionAssetIo(), entered = deferred(), release = deferred();
  const job = io.run(async () => { entered.resolve(); await release.promise; throw new Error('missing canonical file'); });
  await entered.promise; const result = expect(job).rejects.toThrow('missing canonical file'), closing = io.close();
  release.resolve(); await Promise.all([result, closing]);
});
