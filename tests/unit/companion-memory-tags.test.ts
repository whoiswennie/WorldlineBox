import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryTagService, parseVcpTagMasterOutput } from '../../src/main/companions/memory-tags-service';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import { CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
import { randomUUID } from 'node:crypto';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
const seeds = [{ id: 'alice', name: 'Alice', persona: '谨慎区分经历和推测。', model: '', description: '', avatar: 'sister' as const, active: true, proactive: false }];
const prompt = readFileSync(path.resolve('vendor/vcp-memory/Plugin/DailyNote/TagMaster.txt'), 'utf8');
const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionMemoryTagService>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-21T10:00:00Z'); });
afterEach(async () => { for (const service of services) await service.close(); services.clear(); for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-tags-')); roots.push(root); const filename = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(filename, seeds); stores.add(store);
  return { root, filename, store, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function record(store: CompanionsStore, input: { companionId: string; conversationId: string; content: string; diaryName?: string;
  tags?: string[]; autoTags?: boolean; id?: string; expectedVersion?: number }) {
  const source = store.appendMessage({ conversationId: input.conversationId, authorId: 'user', content: input.content, replyDirective: 'none' });
  const candidate = { artifactKind: 'knowledge' as const, content: input.content, tags: input.tags ?? [], diaryName: input.diaryName ?? '学习资料',
    metadata: { autoTags: input.autoTags ?? true }, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
  return store.request(input.id ? { type: 'memory.revise', companionId: input.companionId, conversationId: input.conversationId,
    id: input.id, expectedVersion: input.expectedVersion!, candidate } : { type: 'memory.record', companionId: input.companionId, conversationId: input.conversationId, candidate }).memories![0]!;
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

it('scopes tag claims to the agenda owner and renews only the matched live native lease', () => {
  const f = fixture();
  const bob = f.store.createCompanion({ name: 'Bob', description: '', persona: '独立核对自己的资料。', model: '', avatar: 'custom', proactive: false });
  f.store.setCompanionActive(bob.id, true);
  const aliceNote = record(f.store, { ...f.scope, content: 'Alice 的原始学习资料。' });
  const bobScope = { companionId: bob.id, conversationId: f.store.openPrivate(bob.id).id };
  const bobNote = record(f.store, { ...bobScope, content: 'Bob 的原始学习资料。' });
  const claim = f.store.request({ type: 'memory.tags.claim', companionId: bob.id, leaseMs: 120000 }).memoryTagJob!;
  expect(claim).toMatchObject({ companionId: bob.id, noteId: bobNote.id });
  expect(f.store.request({ type: 'memory.tags.heartbeat', id: claim.id, leaseToken: 'wrong_token', leaseMs: 120000 }).memoryTagValid).toBe(false);
  vi.setSystemTime(Date.now() + 119000);
  expect(f.store.request({ type: 'memory.tags.heartbeat', id: claim.id, leaseToken: claim.leaseToken, leaseMs: 120000 }).memoryTagValid).toBe(true);
  vi.setSystemTime(Date.now() + 2000);
  expect(f.store.request({ type: 'memory.tags.validate', id: claim.id, leaseToken: claim.leaseToken }).memoryTagValid).toBe(true);
  expect(f.store.request({ type: 'memory.tags.claim', companionId: 'alice' }).memoryTagJob).toMatchObject({ companionId: 'alice', noteId: aliceNote.id });
});

it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
  'tags a real source-backed knowledge note through the original %s TagMaster transport and VCP outbox', async format => {
    const f = fixture(), note = record(f.store, { ...f.scope, diaryName: '学习资料', content: '# 阅读出处\n\n核对资料的出处，并区分原文和自己的推测。' });
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
  const f = fixture(), manual = record(f.store, { ...f.scope, content: '手工选定的阅读锚点。', tags: ['我选的标签'] });
  record(f.store, { ...f.scope, content: '用户明确暂不加标签。', autoTags: false });
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '真实交流来源。', replyDirective: 'none' });
  const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
  f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ artifactKind: 'episode_memory', content: '有实际来源的自动日记', tags: [],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] }] });
  const fetchFn = vi.fn<typeof fetch>(); await tagger(f.store, fetchFn).tick(); expect(fetchFn).not.toHaveBeenCalled(); expect(read(f.store, manual.id)?.tags).toEqual(['我选的标签']);
});

it('honors an imported original final Tag line before asking any model', async () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: '原始材料。\nTag: 手工原标签, [项目甲]' });
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
  const f = fixture(), note = record(f.store, { ...f.scope, content: '原始资料版本一。', diaryName: '资料' });
  let resolve!: (value: Response) => void, pause = false; const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn = vi.fn<typeof fetch>(() => pending), service = tagger(f.store, fetchFn, 'openai_chat', { busy: () => pause });
  const work = service.tick(); await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce()); pause = true;
  if (change === 'hand-tags') f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: 1, tags: ['手工最新'], diaryName: '资料' });
  if (change === 'edit') record(f.store, { ...f.scope, id: note.id, expectedVersion: 1, content: '新正文版本二。' });
  if (change === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
  if (change === 'delete') f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
  if (change === 'cancel') f.store.request({ type: 'memory.tags.cancel', companionId: 'alice', noteId: note.id });
  if (change === 'policy') f.store.request({ type: 'memory.forget', ...f.scope, tag: '之后不记的主题', persistent: true });
  resolve(response('openai_chat', '[[Tag: 旧版标签]]')); await work;
  expect(read(f.store, note.id)?.tags ?? []).not.toContain('旧版标签');
  if (change === 'hand-tags') expect(read(f.store, note.id)?.tags).toEqual(['手工最新']);
  if (change === 'cancel') expect(status(f.store, note.id).note?.state).toBe('cancelled');
});

it('persists waiting-model status without a request and resumes after restart using a restored global configuration', async () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: '暂无聊天模型时仍可保存的资料。' });
  const fetchFn = vi.fn<typeof fetch>(async () => response('openai_chat', '[[Tag: 资料保存, 后台处理]]'));
  await tagger(f.store, fetchFn, 'openai_chat', { config: () => { throw new Error('No chat config'); } }).tick();
  expect(fetchFn).not.toHaveBeenCalled(); expect(status(f.store, note.id)).toMatchObject({ waitingModel: 1, note: { state: 'waiting_model', error: expect.stringContaining('正文已保存') } });
  f.store.close(); stores.delete(f.store); vi.setSystemTime(Date.now() + 31000);
  const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened); await tagger(reopened, fetchFn).tick();
  expect(read(reopened, note.id)?.tags).toEqual(['资料保存', '后台处理']); expect(status(reopened, note.id).completed).toBe(1);
});
it('does not spend genuine tag failures while repeatedly waiting for model configuration', async () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: '未配置模型的等待不是一次已发送标签失败。' });
  const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}', { status: 429 }));
  const waiting = tagger(f.store, fetchFn, 'openai_chat', { config: () => { throw Error('No configured model.'); } });
  for (let attempt = 0; attempt < 10; attempt++) { await waiting.tick(); vi.setSystemTime(Date.now() + 31_000); }
  expect(fetchFn).not.toHaveBeenCalled(); expect(status(f.store, note.id).waitingModel).toBe(1);
  await tagger(f.store, fetchFn).tick(); expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(status(f.store, note.id).failed).toBe(1);
  vi.setSystemTime(Date.now() + 10_001);
  expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob).toMatchObject({ attempts: 12, failureCount: 1, cycleFailureCount: 1 });
});

it('recovers a crashed tag lease and accepts a completion only once', () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: '需要持久处理的资料。' });
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
  const f = fixture(), note = record(f.store, { ...f.scope, content: '只有正式发送模型请求失败才占用标签重试次数。' });
  let store = f.store, refused = true;
  const fetchFn = vi.fn<typeof fetch>(async () => response('openai_chat', '[[Tag: 队列恢复, 真实资料]]'));
  const service = new CompanionMemoryTagService({ request: async command => store.request(command), fetchFn, prompt: async () => prompt,
    config: async () => ({ apiFormat: 'openai_chat', model: 'queued-tags', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid', providerLifecycle: {
      beforeDispatch: async () => { if (refused) throw new CompanionModelAdmissionError('queue_full', 'Actual local queue is temporarily unavailable.', new Date(Date.now() + 86400000).toISOString()); return async () => undefined; },
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
  const f = fixture(), note = record(f.store, { ...f.scope, content: '提供方响应与本地未发送准入拒绝有不同的重试语义。' });
  const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"error":"provider rate limit"}', { status: 429 }));
  await tagger(f.store, fetchFn).tick(); expect(fetchFn).toHaveBeenCalledOnce(); expect(status(f.store, note.id).note?.state).toBe('failed');
  vi.setSystemTime(Date.now() + 10001); expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob?.attempts).toBe(2);
});

it('wakes only typed deferred tags without erasing real failures, another owner or a running lease', () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: '队列恢复仅重新核验宿主延期，不覆盖真实失败计数。' });
  const first = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  f.store.request({ type: 'memory.tags.defer', id: first.id, leaseToken: first.leaseToken, reason: 'retry', error: 'Actual HTTP failure.', retryAfterMs: 1000 });
  vi.setSystemTime(Date.now() + 1001); const second = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!; expect(second.attempts).toBe(2);
  f.store.request({ type: 'memory.tags.defer', id: second.id, leaseToken: second.leaseToken, reason: 'admission', error: 'Typed host admission.', retryAfterMs: 86400000 });
  f.store.request({ type: 'memory.tags.retry-admission', companionId: 'bob' }); expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob).toBeUndefined();
  f.store.request({ type: 'memory.tags.retry-admission' }); const awakened = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  expect(awakened).toMatchObject({ id: second.id, attempts: 3, failureCount: 1, cycleFailureCount: 1 });
  f.store.request({ type: 'memory.tags.retry-admission' });
  f.store.request({ type: 'memory.tags.complete', id: awakened.id, leaseToken: awakened.leaseToken, tags: ['真实标签'] });
  expect(status(f.store, note.id).note?.state).toBe('completed');
});

it('exposes tag status/retry/cancel for registered source-backed files while keeping document editing read-only', async () => {
  const f = managedMemoryFiles();
  try {
    const note = record(f.store, { ...f.scope, content: '# 阅读出处\n\n对照原始材料，保留不确定性。' }); f.index(); await f.publish();
    const docs = f.documents, file = companionMemoryRegisteredPath(note);
    const initial = (await docs.handle({ type: 'memory.documents.read', companionId: 'alice', path: file, sourceLimit: 30 })).document!;
    expect(initial.tagStatus?.note?.state).toBe('pending'); expect(initial.memory?.sources.every(source => source.sourceType !== 'manual_input')).toBe(true);
    const cancelled = (await docs.handle({ type: 'memory.documents.tags.cancel', companionId: 'alice', path: file, expectedRevision: initial.document.revision })).document!;
    expect(cancelled.document.autoTagsEnabled).toBe(false); expect(cancelled.tagStatus?.note?.state).toBe('cancelled');
    expect((await docs.handle({ type: 'memory.documents.tags.retry', companionId: 'alice', path: file, expectedRevision: initial.document.revision })).ok).toBe(false);
    const resumed = (await docs.handle({ type: 'memory.documents.tags.retry', companionId: 'alice', path: file, expectedRevision: cancelled.document.revision })).document!;
    expect(resumed.tagStatus?.note?.state).toBe('pending');
    const fetchFn = vi.fn<typeof fetch>(async () => response('openai_chat', '[[Tag: 阅读出处, 不确定性]]')), service = tagger(f.store, fetchFn);
    await service.tick(); await f.publish();
    const tagged = (await docs.handle({ type: 'memory.documents.tags.status', companionId: 'alice', path: file })).document!;
    expect(tagged.document.tags).toEqual(['阅读出处', '不确定性']); expect(tagged.tagStatus?.note?.state).toBe('completed');
    expect((await docs.handle({ type: 'memory.documents.save', companionId: 'alice', path: file, expectedRevision: tagged.document.revision,
      content: tagged.content, tags: [], autoTags: false })).ok).toBe(false);
    await service.tick(); expect(fetchFn).toHaveBeenCalledOnce(); await service.close(); services.delete(service);
  } finally { await f.close(); }
});

it.each(['解释：[[Tag: 标签]]', '[[Tag: ]]', '{"tags":["不是原格式"]}', '[[Tag: ' + '中'.repeat(101) + ']]'])(
  'rejects malformed TagMaster output without guessing tags: %s', value => { expect(() => parseVcpTagMasterOutput(value)).toThrow(); });

it.each(['park', 'forget'] as const)('refuses a tag request invalidated by %s after admission and before actual HTTP', async action => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: 'TAG_PRE_DISPATCH_ORIGINAL_MUST_REMAIN' }), fetchFn = vi.fn<typeof fetch>(), finish = vi.fn(async () => undefined);
  const service = new CompanionMemoryTagService({ request: async command => f.store.request(command), prompt: async () => prompt,
    config: async () => ({ apiFormat: 'openai_chat', model: 'global', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid', providerLifecycle: { beforeDispatch: async () => {
      if (action === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
      else {
        const current = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'tags', states: ['running'], limit: 50 }).jobPage!.items[0]!;
        f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'tags', id: current.id, inputVersion: current.inputVersion,
          expectedRevision: current.revision, operationId: randomUUID(), action: 'park' });
      }
      return finish;
    } } }), fetchFn, changed: vi.fn(), report: vi.fn() }); services.add(service);
  await service.tick(); expect(fetchFn).not.toHaveBeenCalled(); expect(finish).toHaveBeenCalledWith('cancelled_before_send', 0);
  expect(f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'tags', limit: 50 }).jobPage!.items[0]).toMatchObject({ state: action === 'park' ? 'parked' : 'stale', failureCount: 0 });
  const original = f.store.messages({ conversationId: f.scope.conversationId }).messages.find(message => message.content === note.content);
  expect(original?.content).toBe(note.content);
});

it('repairs only a malformed TagMaster envelope with the global JSON port and retains the actual original input', async () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: 'TAG_REPAIR_ACTUAL_SOURCE' }), bad = '解释文字导致原TagMaster信封格式无效';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    if (fetchFn.mock.calls.length === 1) { expect(wire.model).toBe('original-tags'); return response('openai_chat', bad); }
    expect(wire.model).toBe('global-repair'); expect(wire.tools).toBeUndefined();
    const repair = JSON.parse(wire.messages[1].content);
    expect(repair.originalOutput).toBe(bad); expect(repair.originalRequest.system).toContain('ACTUAL_RESOLVED_TAG_SYSTEM');
    expect(repair.originalRequest.user).toContain('ACTUAL_RESOLVED_TAG_INPUT'); expect(repair.originalRequest.user).toContain(note.content);
    return response('openai_chat', '{"tags":["实际来源","格式修复"]}');
  });
  const service = new CompanionMemoryTagService({ request: async command => f.store.request(command), prompt: async () => prompt,
    config: async () => ({ apiFormat: 'openai_chat', ownerId: 'alice', model: 'original-tags', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid',
      resolveAssetContext: async context => ({ system: context.system + '\nACTUAL_RESOLVED_TAG_SYSTEM', user: context.user + '\nACTUAL_RESOLVED_TAG_INPUT' }),
      resolveStructuredRepairConfig: async () => ({ apiFormat: 'openai_chat', ownerId: 'alice', model: 'global-repair', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid' }) }),
    fetchFn, changed: vi.fn(), report: vi.fn() }); services.add(service);
  await service.tick(); expect(fetchFn).toHaveBeenCalledTimes(2); expect(read(f.store, note.id)?.tags).toEqual(['实际来源', '格式修复']);
  expect(status(f.store, note.id).note?.state).toBe('completed');
});

it('bounds malformed tag repair at two attempts and never accepts empty tags as successful processing', async () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: 'EMPTY_TAG_REPAIR_MUST_NOT_DROP_SOURCE' });
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('openai_chat', '坏格式'))
    .mockImplementation(async () => response('openai_chat', '{"tags":[]}'));
  await tagger(f.store, fetchFn).tick(); expect(fetchFn).toHaveBeenCalledTimes(3);
  expect(status(f.store, note.id).note?.state).toBe('failed'); expect(read(f.store, note.id)?.tags).toEqual([]);
  expect(f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'tags', limit: 50 }).jobPage!.items[0]).toMatchObject({ failureCount: 1, cycleFailureCount: 1 });
  expect(f.store.messages({ conversationId: f.scope.conversationId }).messages.some(message => message.content === note.content)).toBe(true);
});

it.each(['network', 'withdrawal'] as const)('does not send an unknown %s outcome to the format-repair model', async kind => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: 'TAG_NON_FORMAT_FAILURE_ORIGINAL' });
  const repairConfig = vi.fn(), fetchFn = vi.fn<typeof fetch>(async () => {
    if (kind === 'network') throw new Error('Unknown provider connection outcome.');
    f.store.request({ type: 'memory.forget', ...f.scope, id: note.id }); return response('openai_chat', '坏格式不能恢复已撤回权限');
  });
  const service = new CompanionMemoryTagService({ request: async command => f.store.request(command), prompt: async () => prompt,
    config: async () => ({ apiFormat: 'openai_chat', ownerId: 'alice', model: 'global', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid', resolveStructuredRepairConfig: repairConfig }),
    fetchFn, changed: vi.fn(), report: vi.fn() }); services.add(service);
  await service.tick(); expect(fetchFn).toHaveBeenCalledOnce(); expect(repairConfig).not.toHaveBeenCalled();
  expect(status(f.store, note.id).note?.state).toBe(kind === 'network' ? 'failed' : 'stale');
});

it('preserves held tag identity and failure counts across annotation revisions and rejects old stop or retry bypasses', () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: 'TAG_HELD_FIXED_BODY' }), first = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  f.store.request({ type: 'memory.tags.defer', id: first.id, leaseToken: first.leaseToken, reason: 'retry', error: 'Actual processing failure.', retryAfterMs: 1000 });
  const current = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'tags', id: first.id }).jobDisposition!;
  const held = f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'tags', id: current.id, inputVersion: current.inputVersion,
    expectedRevision: current.revision, operationId: randomUUID(), action: 'park' }).jobDisposition!;
  expect(() => f.store.request({ type: 'memory.tags.cancel', companionId: 'alice', noteId: note.id })).toThrow('作业处置');
  expect(() => f.store.request({ type: 'memory.tags.retry', companionId: 'alice', noteId: note.id })).toThrow('具体作业');
  f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: note.version, tags: [], diaryName: '另一个分类', autoTags: true });
  const annotated = read(f.store, note.id)!; expect(annotated.version).toBeGreaterThan(note.version); expect(annotated.contentRevision).toBe(note.contentRevision);
  expect(status(f.store, note.id).note?.state).toBe('parked');
  expect(f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'tags', limit: 50 }).jobPage?.items).toEqual([held]);
  record(f.store, { ...f.scope, content: '后续真正新资料应继续' });
  expect(f.store.request({ type: 'memory.tags.claim' }).memoryTagJob?.noteId).not.toBe(note.id);
  const resumed = f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'tags', id: held.id, inputVersion: held.inputVersion,
    expectedRevision: held.revision, operationId: randomUUID(), action: 'resume' }).jobDisposition!;
  expect(resumed).toMatchObject({ state: 'pending', failureCount: 1, cycleFailureCount: 0, inputVersion: held.inputVersion });
  const retry = f.store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  expect(retry).toMatchObject({ id: first.id, noteId: note.id, version: annotated.version, attempts: 2, failureCount: 1 });
  f.store.request({ type: 'memory.tags.complete', id: retry.id, leaseToken: retry.leaseToken, tags: ['实际标签'] });
  expect(status(f.store, note.id).note?.state).toBe('completed');
});

it('waits for canonical file validation without sending SQL-only text or counting a quality failure', async () => {
  const f = fixture(), note = record(f.store, { ...f.scope, content: 'CANONICAL_FILE_PENDING_MUST_NOT_SEND' }), fetchFn = vi.fn<typeof fetch>();
  const service = new CompanionMemoryTagService({ request: async command => f.store.request(command), prompt: async () => prompt,
    config: async () => ({ apiFormat: 'openai_chat', ownerId: 'alice', model: 'global', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid' }),
    validateInput: async () => { throw new CompanionModelAdmissionError('files_pending', 'Canonical document is not yet available.'); },
    fetchFn, changed: vi.fn(), report: vi.fn() }); services.add(service);
  await service.tick(); expect(fetchFn).not.toHaveBeenCalled();
  expect(status(f.store, note.id).note?.state).toBe('pending');
  expect(f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'tags', limit: 50 }).jobPage?.items[0]).toMatchObject({ failureCount: 0, cycleFailureCount: 0, attemptCount: 1 });
});
