import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryTagService, parseVcpTagMasterOutput } from '../../src/main/companions/memory-tags-service';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import { CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
const seeds = [{ id: 'alice', name: 'Alice', persona: '谨慎区分经历和推测。', model: '', description: '', avatar: 'sister' as const, active: true, proactive: false }];
const prompt = readFileSync(path.resolve('vendor/vcp-memory/Plugin/DailyNote/TagMaster.txt'), 'utf8');
const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionMemoryTagService>();
const libraries = new Set<CompanionMemoryLibrary>(), documents = new Set<CompanionMemoryDocuments>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-21T10:00:00Z'); });
afterEach(async () => { for (const service of services) await service.close(); services.clear(); for (const docs of documents) await docs.close(); documents.clear();
  for (const library of libraries) await library.close(); libraries.clear(); for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-tags-')); roots.push(root); const filename = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(filename, seeds); stores.add(store);
  return { root, filename, store, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function response(format: AiApiFormat, text: string) {
  const body = format === 'openai_chat' ? { choices: [{ message: { content: text } }] }
    : format === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : format === 'anthropic' ? { content: [{ type: 'text', text }] }
        : format === 'gemini_native' ? { candidates: [{ content: { parts: [{ text }] } }] } : { output: { choices: [{ message: { content: text } }] } };
  return new Response(JSON.stringify(body));
}
function tagger(store: CompanionsStore, fetchFn: typeof fetch, format: AiApiFormat = 'openai_chat', options: { busy?: () => boolean; config?: () => never } = {}) {
  const service = new CompanionMemoryTagService({ request: async command => store.request(command),
    config: async () => options.config?.() ?? ({ apiFormat: format, model: 'global-chat-model', apiKey: 'fixture-secret', baseUrl: 'https://fixture.invalid' }),
    prompt: async () => prompt, fetchFn, busy: options.busy, changed: vi.fn(), report: vi.fn() }); services.add(service); return service;
}
function read(store: CompanionsStore, id: string) { return store.request({ type: 'memory.library.read', companionId: 'alice', id }).memoryRead?.memory; }
function status(store: CompanionsStore, noteId: string) { return store.request({ type: 'memory.tags.status', companionId: 'alice', noteId }).memoryTagStatus!; }

it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
  'fills a real manual diary with ordered original TagMaster output through the global %s transport and VCP outbox', async format => {
    const f = fixture(), note = f.store.saveMemory({ ...f.scope, diaryName: '学习资料', content: '# 阅读出处\n\n核对资料的出处，并区分原文和自己的推测。' });
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); expect(JSON.stringify(body)).toContain(note.content.replaceAll('\n', '\\n'));
      expect(JSON.stringify(body)).toContain('Knowledge Graph Architect'); expect(JSON.stringify(body)).not.toContain('fixture-secret');
      expect(body.model ?? String(_url)).toContain('global-chat-model'); expect(body.tools).toBeUndefined();
      return response(format, '[[Tag: 阅读出处, 原始资料, 推测]]');
    });
    expect(status(f.store, note.id).note?.state).toBe('pending'); await tagger(f.store, fetchFn, format).tick();
    expect(fetchFn).toHaveBeenCalledOnce(); expect(read(f.store, note.id)).toMatchObject({ version: 2, tags: ['阅读出处', '原始资料', '推测'],
      content: note.content, sourceConversationId: f.scope.conversationId, sources: note.sources });
    expect(status(f.store, note.id).note?.state).toBe('completed');
    const outbox = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
    expect(outbox).toMatchObject({ noteId: note.id, noteVersion: 2, note: { tags: ['阅读出处', '原始资料', '推测'] } });
    f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
    expect(read(f.store, note.id)?.status).toBe('indexed'); expect(f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
  });

it('preserves explicit tags and never tags automatic experience journals or disabled manual documents', async () => {
  const f = fixture(), manual = f.store.saveMemory({ ...f.scope, content: '手工选定的阅读锚点。', tags: ['我选的标签'] });
  f.store.saveMemory({ ...f.scope, content: '用户明确暂不加标签。', autoTags: false });
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '真实交流来源。', replyDirective: 'none' });
  const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ content: '有实际来源的自动日记', tags: [],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] }] });
  const fetchFn = vi.fn<typeof fetch>(); await tagger(f.store, fetchFn).tick(); expect(fetchFn).not.toHaveBeenCalled(); expect(read(f.store, manual.id)?.tags).toEqual(['我选的标签']);
});

it('honors an imported original final Tag line before asking any model', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '原始材料。\nTag: 手工原标签, [项目甲]' });
  const fetchFn = vi.fn<typeof fetch>(); await tagger(f.store, fetchFn, 'openai_chat', { config: () => { throw new Error('No model'); } }).tick();
  expect(fetchFn).not.toHaveBeenCalled(); expect(read(f.store, note.id)?.tags).toEqual(['手工原标签', '[项目甲]']);
});

it('reports the tag timer and model condition while foreground work remains independent', async () => {
  const f = fixture(), fetchFn = vi.fn<typeof fetch>(); let busy = false;
  const service = tagger(f.store, fetchFn, 'openai_chat', { busy: () => busy, config: () => { throw new Error('No model'); } });
  service.start();
  const initial = await service.schedulingFor('alice');
  expect(initial).toMatchObject({ scheduleKind: 'condition', waitingReason: 'model_unconfigured', nextCheckAt: new Date(Date.now() + 1000).toISOString() });
  expect(initial.condition).toContain('明确 Tag 行');
  busy = true;
  expect(await service.schedulingFor('alice')).toMatchObject({ waitingReason: 'model_unconfigured', nextCheckAt: initial.nextCheckAt });
  vi.setSystemTime(Date.now() + 2000);
  expect((await service.schedulingFor('alice')).nextCheckAt).toBeUndefined();
  expect(fetchFn).not.toHaveBeenCalled();
  await service.close();
  expect(await service.schedulingFor('alice')).toMatchObject({ waitingReason: 'app_stopped', nextCheckAt: undefined });
});

it.each(['hand-tags', 'edit', 'forget', 'delete', 'cancel', 'policy'] as const)('does not publish an old tag result after %s during inference', async change => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '原始资料版本一。', diaryName: '资料' });
  let resolve!: (value: Response) => void, pause = false; const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn = vi.fn<typeof fetch>(() => pending), service = tagger(f.store, fetchFn, 'openai_chat', { busy: () => pause });
  const work = service.tick(); await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce()); pause = true;
  if (change === 'hand-tags') f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: 1, tags: ['手工最新'], diaryName: '资料' });
  if (change === 'edit') f.store.saveMemory({ ...f.scope, id: note.id, expectedVersion: 1, content: '新正文版本二。' });
  if (change === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
  if (change === 'delete') f.store.deleteMemory(note.id);
  if (change === 'cancel') f.store.request({ type: 'memory.tags.cancel', companionId: 'alice', noteId: note.id });
  if (change === 'policy') f.store.request({ type: 'memory.forget', ...f.scope, tag: '之后不记的主题', persistent: true });
  resolve(response('openai_chat', '[[Tag: 旧版标签]]')); await work;
  expect(read(f.store, note.id)?.tags ?? []).not.toContain('旧版标签');
  if (change === 'hand-tags') expect(read(f.store, note.id)?.tags).toEqual(['手工最新']);
  if (change === 'cancel') expect(status(f.store, note.id).note?.state).toBe('cancelled');
});

it('persists waiting-model status without a request and resumes after restart using a restored global configuration', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '暂无聊天模型时仍可保存的资料。' });
  const fetchFn = vi.fn<typeof fetch>(async () => response('openai_chat', '[[Tag: 资料保存, 后台处理]]'));
  await tagger(f.store, fetchFn, 'openai_chat', { config: () => { throw new Error('No chat config'); } }).tick();
  expect(fetchFn).not.toHaveBeenCalled(); expect(status(f.store, note.id)).toMatchObject({ waitingModel: 1, note: { state: 'waiting_model', error: expect.stringContaining('正文已保存') } });
  f.store.close(); stores.delete(f.store); vi.setSystemTime(Date.now() + 31000);
  const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened); await tagger(reopened, fetchFn).tick();
  expect(read(reopened, note.id)?.tags).toEqual(['资料保存', '后台处理']); expect(status(reopened, note.id).completed).toBe(1);
});
it('does not spend genuine tag failures while repeatedly waiting for model configuration', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '未配置模型的等待不是一次已发送标签失败。' });
  const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}', { status: 429 }));
  const waiting = tagger(f.store, fetchFn, 'openai_chat', { config: () => { throw Error('No configured model.'); } });
  for (let attempt = 0; attempt < 10; attempt++) { await waiting.tick(); vi.setSystemTime(Date.now() + 31_000); }
  expect(fetchFn).not.toHaveBeenCalled(); expect(status(f.store, note.id).waitingModel).toBe(1);
  await tagger(f.store, fetchFn).tick(); expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(status(f.store, note.id).failed).toBe(1);
  vi.setSystemTime(Date.now() + 10_001);
  expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob?.attempts).toBe(2);
});

it('recovers a crashed tag lease and accepts a completion only once', () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '需要持久处理的资料。' });
  const first = f.store.request({ type: 'memory.tags.claim', leaseMs: 1000 }).memoryTagJob!;
  f.store.close(); stores.delete(f.store); vi.setSystemTime(Date.now() + 1001);
  const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened);
  const retry = reopened.request({ type: 'memory.tags.claim' }).memoryTagJob!; expect(retry.id).toBe(first.id); expect(retry.leaseToken).not.toBe(first.leaseToken);
  reopened.request({ type: 'memory.tags.complete', id: first.id, leaseToken: first.leaseToken, tags: ['过期结果'] });
  reopened.request({ type: 'memory.tags.complete', id: retry.id, leaseToken: retry.leaseToken, tags: ['实际标签'] });
  reopened.request({ type: 'memory.tags.complete', id: retry.id, leaseToken: retry.leaseToken, tags: ['重复结果'] });
  expect(read(reopened, note.id)).toMatchObject({ version: 2, tags: ['实际标签'] });
});

it('keeps tag attempts intact through repeated durable host admission deferrals and a SQLite restart', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '只有正式发送模型请求失败才占用标签重试次数。' });
  let store = f.store, refused = true;
  const fetchFn = vi.fn<typeof fetch>(async () => response('openai_chat', '[[Tag: 预算恢复, 真实资料]]'));
  const service = new CompanionMemoryTagService({ request: async command => store.request(command), fetchFn, prompt: async () => prompt,
    config: async () => ({ apiFormat: 'openai_chat', model: 'budgeted-tags', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid', providerBudget: {
      beforeRequest: async () => { if (refused) throw new CompanionModelAdmissionError('budget', 'Actual local budget admission.', new Date(Date.now() + 86400000).toISOString()); return async () => undefined; },
    } }), changed: vi.fn(), report: vi.fn() }); services.add(service);
  for (let attempt = 0; attempt < 10; attempt++) {
    await service.tick(); expect(status(store, note.id)).toMatchObject({ failed: 0, pending: 1, note: { state: 'pending' } });
    expect(store.request({ type: 'memory.tags.claim' }).memoryTagJob).toBeUndefined();
    if (attempt === 4) { store.close(); stores.delete(store); store = new CompanionsStore(f.filename, seeds); stores.add(store); }
    vi.setSystemTime(Date.now() + 86400001);
  }
  expect(fetchFn).not.toHaveBeenCalled(); refused = false; await service.tick();
  expect(fetchFn).toHaveBeenCalledOnce(); expect(status(store, note.id).note?.state).toBe('completed');
});

it('counts an actual provider HTTP 429 as a tag failure rather than a host admission deferral', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '提供方响应与本地未发送准入拒绝有不同的重试语义。' });
  const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"error":"provider rate limit"}', { status: 429 }));
  await tagger(f.store, fetchFn).tick(); expect(fetchFn).toHaveBeenCalledOnce(); expect(status(f.store, note.id).note?.state).toBe('failed');
  vi.setSystemTime(Date.now() + 10001); expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob?.attempts).toBe(2);
});

it('wakes only typed deferred tags without erasing real failures, another owner or a running lease', () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '预算调整仅重新核验宿主延期，不覆盖真实失败计数。' });
  const first = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  f.store.request({ type: 'memory.tags.defer', id: first.id, leaseToken: first.leaseToken, reason: 'retry', error: 'Actual HTTP failure.', retryAfterMs: 1000 });
  vi.setSystemTime(Date.now() + 1001); const second = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!; expect(second.attempts).toBe(2);
  f.store.request({ type: 'memory.tags.defer', id: second.id, leaseToken: second.leaseToken, reason: 'admission', error: 'Typed host admission.', retryAfterMs: 86400000 });
  f.store.request({ type: 'memory.tags.retry-admission', companionId: 'bob' }); expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob).toBeUndefined();
  f.store.request({ type: 'memory.tags.retry-admission' }); const awakened = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  expect(awakened).toMatchObject({ id: second.id, attempts: 2 });
  f.store.request({ type: 'memory.tags.retry-admission' });
  f.store.request({ type: 'memory.tags.complete', id: awakened.id, leaseToken: awakened.leaseToken, tags: ['真实标签'] });
  expect(status(f.store, note.id).note?.state).toBe('completed');
});

it('imports a real natural file, exposes human tag status/retry/cancel and respects an explicit tag clear', async () => {
  const f = fixture(), directory = path.join(f.root, '伙伴记忆');
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, request: async command => f.store.request(command) }); libraries.add(library);
  await library.sync(); writeFileSync(path.join(directory, 'alice', '资料', '阅读出处.md'), '# 阅读出处\n\n对照原始材料，保留不确定性。');
  await library.sync();
  const docs = new CompanionMemoryDocuments({ library, libraryDirectory: directory, requestStorage: async command => f.store.request(command) }); documents.add(docs);
  const initial = (await docs.handle({ type: 'memory.documents.read', companionId: 'alice', path: '资料/阅读出处.md', sourceLimit: 30 })).document!;
  expect(initial.tagStatus?.note?.state).toBe('pending'); expect(initial.memory?.sources.some(source => source.sourceType === 'manual_input')).toBe(true);
  const cancelled = (await docs.handle({ type: 'memory.documents.tags.cancel', companionId: 'alice', path: initial.document.path, expectedRevision: initial.document.revision })).document!;
  expect(cancelled.document.autoTagsEnabled).toBe(false); expect(cancelled.tagStatus?.note?.state).toBe('cancelled');
  expect((await docs.handle({ type: 'memory.documents.tags.retry', companionId: 'alice', path: initial.document.path, expectedRevision: initial.document.revision })).ok).toBe(false);
  const resumed = (await docs.handle({ type: 'memory.documents.tags.retry', companionId: 'alice', path: initial.document.path, expectedRevision: cancelled.document.revision })).document!;
  expect(resumed.tagStatus?.note?.state).toBe('pending');
  const fetchFn = vi.fn<typeof fetch>(async () => response('openai_chat', '[[Tag: 阅读出处, 不确定性]]')); const service = tagger(f.store, fetchFn); await service.tick(); await library.sync();
  const tagged = (await docs.handle({ type: 'memory.documents.tags.status', companionId: 'alice', path: initial.document.path })).document!;
  expect(tagged.document.tags).toEqual(['阅读出处', '不确定性']); expect(tagged.tagStatus?.note?.state).toBe('completed');
  const cleared = (await docs.handle({ type: 'memory.documents.save', companionId: 'alice', path: initial.document.path, expectedRevision: tagged.document.revision,
    content: tagged.content, tags: [], autoTags: false })).document!;
  expect(cleared.document.tags).toEqual([]); expect(cleared.document.autoTagsEnabled).toBe(false); await service.tick(); expect(fetchFn).toHaveBeenCalledOnce();
});

it.each(['解释：[[Tag: 标签]]', '[[Tag: ]]', '{"tags":["不是原格式"]}', '[[Tag: ' + '中'.repeat(101) + ']]'])(
  'rejects malformed TagMaster output without guessing tags: %s', value => { expect(() => parseVcpTagMasterOutput(value)).toThrow(); });
