import { afterEach, expect, it, vi } from 'vitest';
import { BotModelCapabilities, botModelImageSupport } from '../../src/main/companion-bot/model-capabilities';

const owned: BotModelCapabilities[] = [];
afterEach(() => { for (const capabilities of owned.splice(0)) capabilities.close(); });
const own = (capabilities: BotModelCapabilities) => { owned.push(capabilities); return capabilities; };
const official = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai_chat', apiKey: 'fixture-no-network' };
const unknown = { ...official, model: 'private-model', baseUrl: 'https://fixture.invalid/v1' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const response = (rows: unknown[]) => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

it('uses only the exact custom route metadata for image support and leaves unknown model names unresolved', async () => {
  expect(botModelImageSupport('private-vision', { data: [{ id: 'private-vision', architecture: { input_modalities: ['text', 'image'] } }] })).toBe('supported');
  expect(botModelImageSupport('private-vision', { data: [{ id: 'private-vision', input_modalities: ['text'] }] })).toBe('unsupported');
  expect(botModelImageSupport('gpt-6.1', { data: [{ id: 'other', supports_images: true }] })).toBe('unknown');
  const capabilities = own(new BotModelCapabilities({ fetchFn: async () => response([{ id: unknown.model, capabilities: { vision: true } }]) }));
  expect(capabilities.imageSupport(unknown)).toBe('unknown'); capabilities.current(unknown); await settle();
  expect(capabilities.imageSupport(unknown)).toBe('supported');
});

it('returns disclosed limits synchronously while one standard GET remains pending across repeated profile polls', async () => {
  const pending = deferred<Response>(), changed = vi.fn();
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.deepseek.com/v1/models');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-no-network');
    return pending.promise;
  });
  const capabilities = own(new BotModelCapabilities({ fetchFn, changed }));
  const immediate = capabilities.current(official);
  expect(immediate).not.toBeInstanceOf(Promise);
  expect(immediate).toMatchObject({ window: 1048576, source: 'official-default', contextEstimate: 'utf8-byte-upper-bound' });
  for (let index = 0; index < 30; index++) expect(capabilities.current(official)).toEqual(immediate);
  expect(fetchFn).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
  pending.resolve(response([{ id: official.model, context_window: 262144, max_output_tokens: 8192 }])); await settle();
  expect(changed).toHaveBeenCalledTimes(1);
  // Metadata has higher provenance even when its verified window is smaller.
  expect(capabilities.current(official)).toMatchObject({ window: 262144, source: 'metadata', maxOutputTokens: 8192,
    sourceUrl: 'https://api.deepseek.com/v1/models', contextEstimate: 'utf8-byte-upper-bound' });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it.each([official, unknown])('ignores another model record instead of borrowing its name or large advertised window (%s)', async profile => {
  const changed = vi.fn(), fetchFn = vi.fn(async () => response([{ id: 'different-model', name: profile.model, context_window: 9000000, max_output_tokens: 900000 }]));
  const capabilities = own(new BotModelCapabilities({ fetchFn, changed })), before = capabilities.current(profile);
  expect(before.source).toBe(profile === official ? 'official-default' : 'unknown'); await settle();
  expect(capabilities.current(profile)).toEqual(before); expect(changed).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(1);
});

it.each(['network', 'http'] as const)('keeps chat limits available after %s discovery failure and retries only when the cache TTL expires', async failure => {
  let now = 1000, requests = 0;
  const changed = vi.fn(), fetchFn = vi.fn(async () => {
    if (requests++ === 0) { if (failure === 'network') throw new Error('Fixture discovery unavailable'); return new Response('Unavailable', { status: 503 }); }
    return response([{ id: unknown.model, limits: { context_length: 131072, max_completion_tokens: 2048 } }]);
  });
  const capabilities = own(new BotModelCapabilities({ fetchFn, changed, now: () => now }));
  const fallback = capabilities.current(unknown); expect(fallback).toMatchObject({ source: 'unknown', contextEstimate: 'utf8-byte-upper-bound' });
  await settle(); expect(changed).not.toHaveBeenCalled();
  now = 600999;
  for (let index = 0; index < 20; index++) expect(capabilities.current(unknown)).toEqual(fallback);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  now = 601000; expect(capabilities.current(unknown)).toEqual(fallback); expect(fetchFn).toHaveBeenCalledTimes(2); await settle();
  expect(capabilities.current(unknown)).toMatchObject({ source: 'metadata', window: 131072, maxTokens: 2048 }); expect(changed).toHaveBeenCalledTimes(1);
});

it('aborts discovery on close and ignores a late response even if its transport does not honour cancellation', async () => {
  const pending = deferred<Response>(), changed = vi.fn(); let signal: AbortSignal | undefined;
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { signal = init?.signal ?? undefined; return pending.promise; });
  const capabilities = own(new BotModelCapabilities({ fetchFn, changed })), fallback = capabilities.current(unknown);
  expect(signal?.aborted).toBe(false); capabilities.close(); expect(signal?.aborted).toBe(true);
  pending.resolve(response([{ id: unknown.model, context_window: 500000 }])); await settle();
  expect(changed).not.toHaveBeenCalled(); expect(capabilities.current(unknown)).toEqual(fallback); expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('bounds profiles at eight and prevents an evicted late response from replacing a reentered profile or another model', async () => {
  const requests: Array<{ response: ReturnType<typeof deferred<Response>>; signal: AbortSignal }> = [], changed = vi.fn();
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const pending = deferred<Response>(); requests.push({ response: pending, signal: init!.signal! }); return pending.promise;
  });
  const capabilities = own(new BotModelCapabilities({ fetchFn, changed }));
  const profiles = Array.from({ length: 9 }, (_, index) => ({ ...unknown, model: `private-${index}` }));
  for (const profile of profiles) expect(capabilities.current(profile).source).toBe('unknown');
  expect(fetchFn).toHaveBeenCalledTimes(9); expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests.slice(1).every(request => !request.signal.aborted)).toBe(true);
  capabilities.current(profiles[0]!); expect(fetchFn).toHaveBeenCalledTimes(10); expect(requests[1]!.signal.aborted).toBe(true);
  requests[9]!.response.resolve(response([{ id: profiles[0]!.model, context_window: 131072 }])); await settle();
  expect(capabilities.current(profiles[0]!)).toMatchObject({ source: 'metadata', window: 131072 });
  requests[0]!.response.resolve(response([{ id: profiles[0]!.model, context_window: 777777 }])); await settle();
  expect(capabilities.current(profiles[0]!)).toMatchObject({ source: 'metadata', window: 131072 }); expect(changed).toHaveBeenCalledTimes(1);
  requests[8]!.response.resolve(response([{ id: profiles[0]!.model, context_window: 9999999 }, { id: profiles[8]!.model, context_window: 262144 }])); await settle();
  expect(capabilities.current(profiles[8]!)).toMatchObject({ source: 'metadata', window: 262144 });
  expect(capabilities.current(profiles[0]!)).toMatchObject({ source: 'metadata', window: 131072 }); expect(changed).toHaveBeenCalledTimes(2);
  expect(fetchFn).toHaveBeenCalledTimes(10);
});

it('does not discover with unsupported transport, malformed endpoint or unusable credentials', () => {
  const fetchFn = vi.fn(async () => { throw new Error('Discovery must not be attempted'); });
  const capabilities = own(new BotModelCapabilities({ fetchFn }));
  for (const profile of [{ ...unknown, apiFormat: 'anthropic' }, { ...unknown, apiKey: '' }, { ...unknown, apiKey: 'invalid\r\nheader' }, { ...unknown, baseUrl: 'invalid-endpoint' }]) {
    expect(capabilities.current(profile).source).toBe('unknown');
  }
  expect(fetchFn).not.toHaveBeenCalled();
});
