import { afterEach, expect, it, vi } from 'vitest';
import { VcpEmbeddingGateway, type VcpEmbeddingProvider } from '../../src/main/vcp-embedding-gateway';

const gateways: VcpEmbeddingGateway[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map(gateway => gateway.close())); });
type Config = Awaited<ReturnType<VcpEmbeddingGateway['configuration']>>;
function fixture(limits = {}, resolver = true) {
  const state = { profileKey: 'space-one', modelName: 'fixture', dimension: 3 };
  const listeners = new Set<() => void>();
  const encode = (texts: readonly string[]) => texts.map(text => [text.length / 7, .1234567890123456, -.75]);
  const embed = vi.fn<VcpEmbeddingProvider['embed']>(async texts => ({ profile: { ...state }, vectors: encode(texts) }));
  const provider: VcpEmbeddingProvider = { embed, ...(resolver ? { resolveProfile: vi.fn(async () => ({ ...state })) } : {}),
    subscribeInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const gateway = new VcpEmbeddingGateway(provider, limits); gateways.push(gateway);
  return { gateway, provider, embed, state, encode, reset: () => { for (const listener of listeners) listener(); } };
}
async function send(config: Config, texts: string[], purpose: 'query' | 'document' = 'document', signal?: AbortSignal) {
  return fetch(`${purpose === 'document' ? config.baseUrl : config.queryBaseUrl}/v1/embeddings`, { method: 'POST', signal,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ input: texts }) });
}
const payload = async (response: Response): Promise<number[][]> => (await response.json() as { data: Array<{ embedding: number[] }> }).data.map(item => item.embedding);

it('reuses exact canonical/view document inputs while every query still reaches the provider/device gate', async () => {
  const f = fixture(), config = await f.gateway.configuration('global', f.state), texts = ['日记：真正读过的资料', 'Tag: 约定'];
  const first = await payload(await send(config, texts)); expect(first).toEqual(f.encode(texts));
  first[0]![0] = 999;
  expect(await payload(await send(config, texts))).toEqual(f.encode(texts)); expect(f.embed).toHaveBeenCalledTimes(1);
  await send(config, texts, 'query'); await send(config, texts, 'query');
  expect(f.embed).toHaveBeenCalledTimes(3); expect(f.embed.mock.calls.slice(1).every(([, options]) => options.purpose === 'query')).toBe(true);
  f.embed.mockRejectedValueOnce(new Error('Device gate unavailable'));
  expect((await send(config, texts, 'query')).status).toBe(503);
  expect(f.gateway.cacheSnapshot()).toMatchObject({ vectors: 2, inflight: 0 });
});

it('coalesces repeated texts within and across concurrent batches without sharing mutable provider vectors', async () => {
  const f = fixture(), config = await f.gateway.configuration('global', f.state);
  let finish!: () => void, original!: number[][];
  f.embed.mockImplementation(async texts => { await new Promise<void>(resolve => { finish = resolve; }); original = f.encode(texts); return { profile: { ...f.state }, vectors: original }; });
  const one = send(config, ['A', 'A', 'B']); await vi.waitFor(() => expect(f.embed).toHaveBeenCalledTimes(1));
  const two = send(config, ['B', 'A', 'B']); await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.embed).toHaveBeenCalledTimes(1); expect(f.embed.mock.calls[0]![0]).toEqual(['A', 'B']);
  finish(); expect(await payload(await one)).toEqual(f.encode(['A', 'A', 'B'])); expect(await payload(await two)).toEqual(f.encode(['B', 'A', 'B']));
  original[0]![1] = 999; expect(await payload(await send(config, ['A']))).toEqual(f.encode(['A']));
});

it('checks the current profile on cache hits, returns 409 for old callers and clears same-profile resets immediately', async () => {
  const f = fixture(), config = await f.gateway.configuration('global', f.state);
  await send(config, ['A']); expect(f.gateway.cacheSnapshot().vectors).toBe(1);
  f.state.profileKey = 'space-two'; expect((await send(config, ['A'])).status).toBe(409);
  expect(f.embed).toHaveBeenCalledTimes(1); expect(f.gateway.cacheSnapshot().vectors).toBe(0);
  const next = await f.gateway.configuration('global', f.state); await send(next, ['A']);
  expect(f.gateway.cacheSnapshot().vectors).toBe(1); f.reset(); expect(f.gateway.cacheSnapshot()).toEqual({ vectors: 0, bytes: 0, inflight: 0 });
  await send(next, ['A']); expect(f.embed).toHaveBeenCalledTimes(3);
  f.state.dimension = 4; expect((await send(next, ['A'])).status).toBe(409); expect(f.gateway.cacheSnapshot().vectors).toBe(0);
});

it('keeps the real vector LRU within both entry and byte limits and evicts the least recently used document', async () => {
  const f = fixture({ maxCachedVectors: 2, maxCacheBytes: 1100 }), config = await f.gateway.configuration('global', f.state);
  await send(config, ['A', 'B']); await send(config, ['A']); await send(config, ['C']);
  expect(f.embed).toHaveBeenCalledTimes(2); expect(f.gateway.cacheSnapshot()).toMatchObject({ vectors: 2, bytes: 1072 });
  await send(config, ['B']); expect(f.embed).toHaveBeenCalledTimes(3); expect(f.gateway.cacheSnapshot().bytes).toBeLessThanOrEqual(1100);
});

it.each([NaN, Infinity, -Infinity])('disables retention for nonfinite cache bounds (%s) instead of bypassing the hard limits', async invalid => {
  for (const limits of [{ maxCachedVectors: invalid }, { maxCacheBytes: invalid }]) {
    const f = fixture(limits), config = await f.gateway.configuration('global', f.state);
    expect((await send(config, ['A'])).status).toBe(200); expect((await send(config, ['A'])).status).toBe(200);
    expect(f.embed).toHaveBeenCalledTimes(2); expect(f.gateway.cacheSnapshot()).toEqual({ vectors: 0, bytes: 0, inflight: 0 });
  }
});

it('rejects an in-flight old-profile result even when the provider ignores cancellation', async () => {
  const f = fixture(), config = await f.gateway.configuration('global', f.state); let finish!: () => void;
  f.embed.mockImplementationOnce(async texts => { const profile = { ...f.state }; await new Promise<void>(resolve => { finish = resolve; }); return { profile, vectors: f.encode(texts) }; });
  const pending = send(config, ['A']); await vi.waitFor(() => expect(f.embed).toHaveBeenCalledOnce());
  f.state.profileKey = 'space-two'; finish(); expect((await pending).status).toBe(409);
  expect(f.gateway.cacheSnapshot()).toEqual({ vectors: 0, bytes: 0, inflight: 0 });
  const fresh = await f.gateway.configuration('global', f.state); expect((await send(fresh, ['A'])).status).toBe(200); expect(f.embed).toHaveBeenCalledTimes(2);
});

it('does not cache when authoritative profile resolution is unavailable or when the provider returns invalid vectors', async () => {
  const unsafe = fixture({}, false), config = await unsafe.gateway.configuration('global', unsafe.state);
  await send(config, ['A']); await send(config, ['A']); expect(unsafe.embed).toHaveBeenCalledTimes(2); expect(unsafe.gateway.cacheSnapshot().vectors).toBe(0);
  const f = fixture(), safe = await f.gateway.configuration('global', f.state);
  f.embed.mockResolvedValueOnce({ profile: { ...f.state }, vectors: [[NaN, 0, 0]] });
  expect((await send(safe, ['A'])).status).toBe(503); expect(f.gateway.cacheSnapshot().vectors).toBe(0);
  expect((await send(safe, ['A'])).status).toBe(200); expect(f.embed).toHaveBeenCalledTimes(2);
});

it('lets one concurrent caller cancel without poisoning the other caller or shared fill', async () => {
  const f = fixture(), config = await f.gateway.configuration('global', f.state); let finish!: () => void; let owned: AbortSignal | undefined;
  f.embed.mockImplementation(async (texts, options) => { owned = options.signal; await new Promise<void>(resolve => { finish = resolve; }); return { profile: { ...f.state }, vectors: f.encode(texts) }; });
  const controller = new AbortController(), one = send(config, ['A'], 'document', controller.signal).catch(() => undefined);
  await vi.waitFor(() => expect(owned).toBeDefined()); const two = send(config, ['A']); await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort(); await one; await new Promise(resolve => setTimeout(resolve, 25)); expect(owned!.aborted).toBe(false);
  finish(); expect((await two).status).toBe(200); expect(f.embed).toHaveBeenCalledTimes(1); expect(f.gateway.cacheSnapshot().vectors).toBe(1);
});

it.each(['cancel', 'reset', 'close'] as const)('aborts shared inference after %s and never publishes a late vector', async action => {
  const f = fixture(), config = await f.gateway.configuration('global', f.state); let owned: AbortSignal | undefined;
  f.embed.mockImplementation(async (_texts, options) => { owned = options.signal; return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })); });
  const controller = new AbortController(), pending = send(config, ['A'], 'document', controller.signal).catch(() => undefined);
  await vi.waitFor(() => expect(owned).toBeDefined());
  if (action === 'cancel') controller.abort(); else if (action === 'reset') f.reset(); else await f.gateway.close();
  await vi.waitFor(() => expect(owned!.aborted).toBe(true)); await pending;
  expect(f.gateway.cacheSnapshot()).toEqual({ vectors: 0, bytes: 0, inflight: 0 });
  if (action !== 'close') { f.embed.mockImplementation(async texts => ({ profile: { ...f.state }, vectors: f.encode(texts) })); expect((await send(config, ['A'])).status).toBe(200); }
});
