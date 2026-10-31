import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { VcpMemoryPeripherals } = require('../../src/main/vcp-memory/peripherals.cjs') as {
  VcpMemoryPeripherals: { prototype: { load(this: object, name: string): Promise<unknown> } };
};
const Handler = require('../../vendor/vcp-memory/Plugin/RAGDiaryPlugin/AIMemoHandler.js') as new (plugin: object, cache: object) => {
  config: { batchSize: number; maxTokensPerBatch: number }; loadConfig(): Promise<void>;
};
const keys = ['AIMemoModel', 'AIMemoApi', 'AIMemoUrl', 'AIMemoBatch', 'AIMemoMaxTokensPerBatch',
  'AIMEMO_CACHE_MAX_SIZE', 'AIMEMO_CACHE_TTL_MS', 'RAG_QUERY_CACHE_ENABLED', 'RAG_RIVER_THINKING_ENABLED'];
const environment = new Map(keys.map(key => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of environment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  vi.restoreAllMocks();
});

it('loads actual upstream AIMemo defaults through the host plugin configuration without worker or model calls', async () => {
  delete process.env.AIMemoBatch; delete process.env.AIMemoMaxTokensPerBatch;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const handler = new Handler({}, {});
  const plugin = { aiMemoHandler: handler, initialize: () => handler.loadConfig(),
    timeParser: { parse: () => [], defaultTimezone: 'Asia/Shanghai' }, semanticGroups: {}, metaThinkingManager: {} };
  const host = { plugins: new Map(), configuration: { chat: { model: 'synthetic', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1' } },
    runtime: { runtimeRoot: path.resolve('vendor/vcp-memory'), kb: {} }, ragClock: { load: () => plugin },
    queryEnvironment: (operation: () => Promise<void>) => operation(), observeMethod: () => undefined };
  expect(await VcpMemoryPeripherals.prototype.load.call(host, 'RAGDiaryPlugin')).toBe(plugin);
  expect(handler.config).toMatchObject({ batchSize: 5, maxTokensPerBatch: 60000 });
  expect(process.env.AIMemoBatch).toBeUndefined(); expect(process.env.AIMemoMaxTokensPerBatch).toBeUndefined();
  expect(process.env.AIMEMO_CACHE_TTL_MS).toBe('60000');
});
