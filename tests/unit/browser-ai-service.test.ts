import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from([...text].reverse().join('')), decryptString: (bytes: Buffer) => [...bytes.toString()].reverse().join('') } }));
import { BrowserAiService, type BrowserAiHooks } from '../../src/main/browser/ai-service';
import { browserStateSchema } from '../../src/shared/browser';
import { browserAiRequestSchema } from '../../src/shared/browser-ai';

function sse(text: string, call?: { name: string; arguments: string; id?: string }): Response {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id ?? 'call1', type: 'function', function: { name: call.name, arguments: call.arguments } }] } : { content: text };
  return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: '
    + JSON.stringify({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(fetchFn: typeof fetch, extra: Partial<BrowserAiHooks> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-ai-unit-'));
  const hooks: BrowserAiHooks = { getConfig: () => ({ apiFormat: 'openai_chat', model: 'test-global-model', baseUrl: 'https://model.example.com', apiKey: 'test-global-secret' }),
    changed: vi.fn(), hasTab: id => id === 'tab1', context: () => ({ activeTabId: 'tab1' }), showResults: vi.fn(async () => undefined),
    tool: vi.fn(async () => ({ actual: true })), fetchFn, ...extra };
  const service = new BrowserAiService(root, hooks); await service.init(); return { service, hooks, root };
}
async function done(service: BrowserAiService) { await vi.waitFor(() => expect(['completed', 'failed', 'cancelled']).toContain(service.state().task?.status), { timeout: 5000 }); }

it('defaults to 600K, migrates legacy small budgets once, and persists explicit budgets up to 1M', async () => {
  const { service, root, hooks } = await fixture(vi.fn<typeof fetch>());
  expect(service.config().contextTokens).toBe(600000); await service.shutdown();
  await writeFile(path.join(root, 'ai-preferences.json'), JSON.stringify({ contextTokens: 16000 }));
  const migrated = new BrowserAiService(root, hooks); await migrated.init(); expect(migrated.config().contextTokens).toBe(600000);
  expect(JSON.parse(await readFile(path.join(root, 'ai-preferences.json'), 'utf8'))).toEqual({ version: 2, contextTokens: 600000 });
  expect(browserAiRequestSchema.safeParse({ type: 'ai.preferences', contextTokens: 1000000 }).success).toBe(true);
  expect(browserAiRequestSchema.safeParse({ type: 'ai.preferences', contextTokens: 1000001 }).success).toBe(false);
  for (const contextTokens of [1000000, 12000]) {
    await migrated.handle({ type: 'ai.preferences', contextTokens });
    const restarted = new BrowserAiService(root, hooks); await restarted.init(); expect(restarted.config().contextTokens).toBe(contextTokens); await restarted.shutdown();
  }
  await migrated.shutdown();
});

it('sends a mixed-language conversation well beyond the old cap without premature or repeated compression', async () => {
  const sent: string[] = []; const fetchFn: typeof fetch = vi.fn(async (_url, init) => { sent.push(String(init?.body)); return sse('页面核实内容和事实结论。'.repeat(900)); });
  const { service } = await fixture(fetchFn);
  for (let index = 0; index < 8; index++) {
    await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: `问题 ${index}: ` + '核实官方文档与页面实际内容。'.repeat(80) }); await done(service);
    expect(service.state().task!.status).toBe('completed'); expect(service.state().task!.compacted).toBe(0);
  }
  expect(service.state().task!.contextTokensUsed).toBeGreaterThan(100000);
  expect(service.state().task!.contextTokensUsed).toBeLessThan(600000 - 4096);
  expect(sent.at(-1)).toContain('问题 0:'); await service.shutdown();
});

it('stops a reset result producer even if its network ignores abort, retaining the independent conversation', async () => {
  let resolve!: (value: Response) => void;
  const fetchFn: typeof fetch = vi.fn(async url => String(url).endsWith('/tools/search') ? new Promise<Response>(done => { resolve = done; }) : sse('Keep this conversation.'));
  const { service, hooks } = await fixture(fetchFn);
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'Keep my chat' }); await done(service);
  await service.handle({ type: 'ai.key.save', key: 'local-test-only' });
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'search', query: 'Delayed results' });
  const reset = service.stopForResults('tab1');
  resolve(new Response('{"results":[{"title":"Late result","url":"https://example.com/"}]}')); await reset;
  expect(hooks.showResults).not.toHaveBeenCalled(); expect(service.state().task!.status).toBe('cancelled');
  expect(service.state().task!.messages).toContainEqual({ role: 'assistant', content: 'Keep this conversation.' });
  await service.shutdown();
});

it('runs actual native function-call/result rounds, keeps search syntax, citations and follow-up context', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []; let round = 0;
  const fetchFn: typeof fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body });
    if (String(url).endsWith('/tools/search')) return new Response(JSON.stringify({ results: [{ title: 'Electron docs', url: 'https://www.electronjs.org/docs/latest', summary: 'Official docs' }] }));
    if (String(url).endsWith('/tools/fetch')) return new Response(JSON.stringify({ title: 'Electron docs', content: '# Native browser\nVerified page content.' }));
    round++;
    if (round === 1) return sse('', { name: 'browser_search', arguments: '{"query":"Electron site:electronjs.org lang:en after:2026-01-01"}' });
    if (round === 2) return sse('', { name: 'browser_fetch', id: 'call2', arguments: '{"url":"https://www.electronjs.org/docs/latest"}' });
    return sse('The verified facts are in [1](https://www.electronjs.org/docs/latest).');
  });
  const { service, hooks, root } = await fixture(fetchFn);
  await service.handle({ type: 'ai.key.save', key: 'dedicated-search-secret' });
  const disk = await readFile(path.join(root, 'search-key.enc.json'), 'utf8'); expect(disk).not.toContain('dedicated-search-secret');
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'research', query: 'Find official 2026 English documentation, then verify it.' }); await done(service);
  expect(service.state().task).toMatchObject({ status: 'completed', model: 'test-global-model', tools: [{ name: 'browser_search', status: 'completed' }, { name: 'browser_fetch', status: 'completed' }] });
  expect(hooks.showResults).toHaveBeenCalledOnce();
  expect(requests.find(item => item.url.endsWith('/tools/search'))!.body).toMatchObject({ query: 'Electron site:electronjs.org lang:en after:2026-01-01', need_content: false });
  expect(JSON.stringify(service.state())).not.toContain('dedicated-search-secret'); expect(JSON.stringify(service.state())).not.toContain('test-global-secret');
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'What changed in those docs?' }); await done(service);
  expect(JSON.stringify(requests.at(-1)!.body)).toContain('Find official 2026');
  expect(service.state().task!.messages).toHaveLength(4);
  await service.shutdown();
});

it('keeps browser search keys independent and only falls back to the official DeepSeek global origin', async () => {
  const { service } = await fixture(vi.fn<typeof fetch>(), { getConfig: () => ({ apiFormat: 'openai_chat', model: 'another-model', baseUrl: 'https://proxy.example.com', apiKey: 'global-only' }) });
  expect(service.config()).toMatchObject({ hasSearchKey: false, keySource: 'none', hasModel: true });
  await service.handle({ type: 'ai.key.save', key: 'browser-only' }); expect(service.config().keySource).toBe('browser');
  await service.handle({ type: 'ai.key.save', key: '' }); expect(service.config().keySource).toBe('none');
  const official = await fixture(vi.fn<typeof fetch>(), { getConfig: () => ({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'global-deepseek' }) });
  expect(official.service.config()).toMatchObject({ hasSearchKey: true, keySource: 'global' });
  await service.shutdown(); await official.service.shutdown();
});

it('supports tools-only search without any global model and returns an honest missing-model error for analysis', async () => {
  const { service } = await fixture(vi.fn(async () => new Response('{"results":[]}')), { getConfig: undefined });
  await service.handle({ type: 'ai.key.save', key: 'search-only' });
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'search', query: 'no results fixture' }); await done(service);
  expect(service.state().task!.status).toBe('completed'); expect(service.state().task!.sources).toEqual([]);
  await expect(service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'page', query: 'Analyze' })).rejects.toThrow('全局模型'); await service.shutdown();
});

it('shows the requested source on repeated fetches and reports only the latest search count', async () => {
  const fetchFn: typeof fetch = vi.fn(async (url, init) => String(url).endsWith('/tools/search') ? new Response('{"results":[]}')
    : new Response(JSON.stringify({ title: JSON.parse(String(init?.body)).url, content: 'Actual fetched page body. '.repeat(500) })));
  const { service, hooks } = await fixture(fetchFn, { getConfig: undefined }); await service.handle({ type: 'ai.key.save', key: 'search-test-key' });
  for (const url of ['https://example.com/a', 'https://example.com/b', 'https://example.com/a']) {
    await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'fetch', query: url }); await done(service);
    expect(vi.mocked(hooks.showResults).mock.calls.at(-1)![2][0]!.url).toBe(url);
    expect(vi.mocked(hooks.showResults).mock.calls.at(-1)![2][0]!.content.length).toBeGreaterThan(9000);
  }
  expect(service.state().task!.sources).toHaveLength(2);
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'search', query: 'no fresh results' }); await done(service);
  expect(service.state().task!.answer).toContain('找到 0 个来源'); await service.shutdown();
});

it('requires a matching action confirmation and cancellation clears pending work without orphan tool history', async () => {
  let count = 0; let confirmed = false;
  const fetchFn: typeof fetch = vi.fn(async () => ++count === 1 ? sse('', { name: 'browser_click', arguments: '{"tabId":"tab1","ref":"e1"}' }) : sse('Declined as requested.'));
  const { service } = await fixture(fetchFn, { tool: async (_name, _input, _signal, confirm) => { confirmed = await confirm('Submit a form'); return { clicked: confirmed }; } });
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'Operate this test form' });
  await vi.waitFor(() => expect(service.state().task?.status).toBe('approval'));
  const task = service.state().task!;
  await expect(service.handle({ type: 'ai.approve', taskId: task.id, actionId: 'stale', allow: true })).rejects.toThrow('失效');
  await service.handle({ type: 'ai.approve', taskId: task.id, actionId: task.approval!.id, allow: false }); await done(service);
  expect(confirmed).toBe(false); expect(service.state().task!.approval).toBeUndefined(); await service.shutdown();
});

it('stops a cancelled provider request and rejects simultaneous sends without duplicating execution', async () => {
  const fetchFn: typeof fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true })));
  const { service } = await fixture(fetchFn);
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'Wait' });
  await expect(service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'Duplicate' })).rejects.toThrow('进行');
  const task = service.state().task!; await service.handle({ type: 'ai.cancel', tabId: 'tab1', taskId: task.id }); await done(service);
  expect(service.state().task!.status).toBe('cancelled'); await service.handle({ type: 'ai.clear', tabId: 'tab1' }); expect(service.state().task).toBeUndefined();
  await service.shutdown();
});

it('includes the optional AI state in the strict browser response schema', () => {
  const parsed = browserStateSchema.shape.ai.safeParse({ config: { hasSearchKey: false, keySource: 'none', hasModel: false, model: '', apiFormat: '', contextTokens: 16000 } });
  expect(parsed.success).toBe(true);
});

it('bounds a long multi-turn conversation, compacts earlier turns, and reserves capacity for replies', async () => {
  const fetchFn: typeof fetch = vi.fn(async () => sse('Verified response from the current page. '.repeat(100)));
  const { service } = await fixture(fetchFn);
  await service.handle({ type: 'ai.preferences', contextTokens: 12000 });
  for (let index = 0; index < 12; index++) {
    await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'Follow-up ' + index }); await done(service);
    expect(service.state().task!.status).toBe('completed');
    expect(service.state().task!.contextTokensUsed).toBeLessThan(12000 - 2400);
  }
  expect(service.state().task!.compacted).toBeGreaterThan(0); expect(service.state().task!.messages.length).toBeLessThanOrEqual(30);
  await service.shutdown();
});

it('never persists chat, evidence or tool history and starts empty after restarting with the same preferences', async () => {
  const fetchFn: typeof fetch = vi.fn(async url => String(url).endsWith('/tools/search')
    ? new Response('{"results":[{"title":"Ephemeral evidence","url":"https://example.com/source","summary":"Temporary source"}]}') : sse('Temporary conversation answer.'));
  const { service, root, hooks } = await fixture(fetchFn);
  await service.handle({ type: 'ai.key.save', key: 'temporary-test-key' });
  await service.handle({ type: 'ai.preferences', contextTokens: 12000 });
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'search', query: 'PRIVATE_EPHEMERAL_QUERY' }); await done(service);
  await service.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'PRIVATE_EPHEMERAL_FOLLOWUP' }); await done(service);
  expect(service.state().task!.sources).toHaveLength(1); expect(service.state().task!.messages).toHaveLength(4);
  await service.shutdown(); expect(service.state().task).toBeUndefined();
  expect((await readdir(root)).sort()).toEqual(['ai-preferences.json', 'search-key.enc.json']);
  for (const filename of await readdir(root)) expect(await readFile(path.join(root, filename), 'utf8')).not.toMatch(/PRIVATE_EPHEMERAL|Ephemeral evidence|Temporary conversation/);
  const restarted = new BrowserAiService(root, hooks); await restarted.init();
  expect(restarted.state()).toMatchObject({ config: { hasSearchKey: true, contextTokens: 12000 } }); expect(restarted.state().task).toBeUndefined();
  await restarted.handle({ type: 'ai.start', tabId: 'tab1', mode: 'followup', query: 'A new temporary conversation' }); await done(restarted);
  const sent = JSON.parse(String(vi.mocked(fetchFn).mock.calls.at(-1)![1]!.body)); expect(JSON.stringify(sent)).not.toContain('PRIVATE_EPHEMERAL');
  await restarted.shutdown();
});
