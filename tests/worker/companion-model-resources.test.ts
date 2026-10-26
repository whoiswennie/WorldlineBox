import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionModelResources } from '../../src/main/companions/model-resources';
import { generateCompanionText, companionModelAdmissionRetryAfter } from '../../src/main/companions/model';
import { companionModelConnection, companionModelQuota } from '../../src/main/companions/model-quota';
import { INITIAL_COMPANION_MODEL_RESOURCES, type CompanionModelConnectionPolicy } from '../../src/shared/companion-model-resources';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
afterEach(() => vi.useRealTimers());
const seeds = [{ id: 'alice', name: 'Alice', description: '', persona: '合成独立伙伴。', model: '', avatar: 'sister' as const, active: true, proactive: false }];
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', baseUrl: 'https://model-budget.invalid', apiKey: 'never-log-this-key' };
const connectionId = companionModelConnection(config), hostInstance = randomUUID();
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-model-resources-')), database = path.join(root, 'state.sqlite');
  let store = new CompanionsStore(database, seeds);
  const resources = new CompanionModelResources({ directory: root, request: async command => store.request(command), report: error => { throw error; } });
  return { root, resources, get store() { return store; }, reopen() { store.close(); store = new CompanionsStore(database, seeds); },
    async close() { await resources.close(); store.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-model-resources-')) throw Error('Unexpected cleanup'); removeOwnedDirectorySync(root); } };
}
function admit(f: ReturnType<typeof fixture>, policy: CompanionModelConnectionPolicy, id = randomUUID(), inputBytes = 10, reservedOutputTokens = 10) {
  return f.store.request({ type: 'model.resources.admit', id, companionId: 'alice', connectionId, hostPid: process.pid, hostInstance,
    policyRevision: 'a'.repeat(64), policy, inputBytes, reservedOutputTokens }).modelResourceAdmission!;
}
function finish(f: ReturnType<typeof fixture>, id: string, outcome: 'response' | 'network_error' | 'cancelled_before_send' = 'response') {
  f.store.request({ type: 'model.resources.finish', id, outcome, durationMs: 1, httpStatus: outcome === 'response' ? 200 : undefined });
}

it('keeps rolling request and daily input/output reservations across restart and clock rollback', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T10:00:00Z');
  const f = fixture(), policy = { ...INITIAL_COMPANION_MODEL_RESOURCES.defaultConnection, requestsPerMinute: 1, inputBytesPerUtcDay: 25 };
  try {
    const id = randomUUID(); expect(admit(f, policy, id)).toEqual({ accepted: true });
    expect(admit(f, policy, id)).toEqual({ accepted: true, duplicate: true }); finish(f, id);
    f.reopen(); expect(admit(f, policy).reason).toBe('requests_minute');
    vi.setSystemTime('2026-10-27T10:01:01Z'); const second = randomUUID(); expect(admit(f, policy, second)).toEqual({ accepted: true }); finish(f, second, 'network_error');
    vi.setSystemTime('2026-10-27T10:02:02Z'); expect(admit(f, policy).reason).toBe('input_day');
    vi.setSystemTime('2026-10-26T10:00:00Z'); expect(admit(f, { ...policy, requestsPerMinute: 10 }).reason).toBe('input_day');
    const usage = f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage!;
    expect(usage).toMatchObject({ requests: 2, inputBytes: 20, reservedOutputTokens: 20, responses: 1, networkErrors: 1 });
    vi.setSystemTime('2026-10-28T00:00:00Z'); expect(admit(f, policy).accepted).toBe(true);
  } finally { await f.close(); }
});

it('does not release a live HTTP reservation merely because another store reader was opened and never refunds an unknown remote outcome', async () => {
  const f = fixture(), policy = { ...INITIAL_COMPANION_MODEL_RESOURCES.defaultConnection, concurrency: 1, requestsPerUtcDay: 2 };
  try {
    const first = randomUUID(); expect(admit(f, policy, first).accepted).toBe(true); f.reopen();
    expect(admit(f, policy).reason).toBe('concurrency'); finish(f, first, 'network_error');
    const second = randomUUID(); expect(admit(f, policy, second).accepted).toBe(true); finish(f, second);
    f.reopen(); expect(admit(f, policy).reason).toBe('requests_day');
  } finally { await f.close(); }
});

it('uses configured cost units and conservative reservations, while a known pre-send cancellation consumes no remote budget', async () => {
  const f = fixture(), policy = { ...INITIAL_COMPANION_MODEL_RESOURCES.defaultConnection,
    cost: { unit: 'TEST_UNIT', maximumMicrosPerUtcDay: 25, inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 } };
  try {
    const cancelled = randomUUID(); expect(admit(f, policy, cancelled).accepted).toBe(true); finish(f, cancelled, 'cancelled_before_send');
    const first = randomUUID(); expect(admit(f, policy, first).accepted).toBe(true); finish(f, first);
    expect(admit(f, policy).reason).toBe('cost_day');
    expect(admit(f, { ...policy, cost: { ...policy.cost, unit: 'OTHER_UNIT' } }).reason).toBe('cost_unit_changed');
    expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage).toMatchObject({ requests: 1, reservedCostMicros: 20 });
  } finally { await f.close(); }
});

it('reads current file limits before every real provider attempt, including a visual fallback, without leaking host accounting into provider bodies', async () => {
  const f = fixture(), calls: string[] = [];
  try {
    const snapshot = await f.resources.load();
    await f.resources.save(snapshot.revision, JSON.stringify({ ...snapshot.policy,
      defaultConnection: { ...snapshot.policy.defaultConnection, requestsPerMinute: 2 } }));
    const bound = await f.resources.bind({ ...config, model: 'gpt-4o' }, 'alice');
    const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxZkAAAAASUVORK5CYII=';
    const portrait = path.join(f.root, 'portrait.png'); writeFileSync(portrait, Buffer.from(pixels, 'base64'));
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push(String(init?.body));
      if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'This model does not support image inputs', code: 'unsupported_image_input' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '实际返回正文。' } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    expect(await generateCompanionText({ system: '宿主合同。', user: JSON.stringify({ purpose: 'vcp_experience_journal', source: '合成来源。', publicProfiles: [
      { id: 'alice', name: 'Alice', kind: 'companion', description: '', avatar: { absolutePath: portrait, mime: 'image/png', available: true } }] }) }, bound, undefined, { fetchFn,
      visualInputs: [{ personId: 'alice', role: 'avatar', mime: 'image/png', base64: pixels, sha256: createHash('sha256').update(Buffer.from(pixels, 'base64')).digest('hex') }] })).toBe('实际返回正文。');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls.every(body => !body.includes('providerBudget') && !body.includes('policyRevision') && !body.includes(config.apiKey))).toBe(true);
    await expect(generateCompanionText({ system: '合同', user: '第三次来源' }, bound, undefined, { fetchFn })).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage).toMatchObject({ requests: 2, responses: 2 });
    expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage?.purposes).toEqual([
      { purpose: 'journal', requests: 2, inputBytes: expect.any(Number), reservedOutputTokens: 16384 }]);
    const current = await f.resources.load(); writeFileSync(f.resources.file, JSON.stringify({ ...current.policy, defaultConnection: { ...current.policy.defaultConnection, requestsPerMinute: 3 } }));
    await expect(f.resources.save(current.revision, current.content)).rejects.toThrow('外部修改');
    expect(await generateCompanionText({ system: '合同', user: '已调整预算后的来源' }, bound, undefined, { fetchFn })).toBe('实际返回正文。');
    unlinkSync(f.resources.file); await expect(f.resources.load()).rejects.toMatchObject({ code: 'CONFIG' });
    expect(existsSync(f.resources.file)).toBe(false);
  } finally { await f.close(); }
});
it('preserves a durable unsent budget deadline while a real provider HTTP 429 remains a charged failure', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T23:59:00Z');
  const f = fixture(), fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));
  try {
    const initial = await f.resources.load();
    await f.resources.save(initial.revision, JSON.stringify({ ...initial.policy, defaultConnection: { ...initial.policy.defaultConnection, requestsPerUtcDay: 1 } }));
    const bound = await f.resources.bind(config, 'alice');
    const remote = await generateCompanionText({ system: '合同', user: '已实际发送' }, bound, undefined, { fetchFn }).catch(error => error);
    expect(remote).toMatchObject({ code: 'RATE_LIMIT' }); expect(companionModelAdmissionRetryAfter(remote)).toBeUndefined();
    const local = await generateCompanionText({ system: '合同', user: '预算拒绝不得发送' }, bound, undefined, { fetchFn }).catch(error => error);
    expect(local).toMatchObject({ code: 'RATE_LIMIT', admission: { reason: 'budget', retryAt: '2026-10-28T00:00:00.000Z' } });
    expect(companionModelAdmissionRetryAfter(local)).toBe(60_000); expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage).toMatchObject({ requests: 1, responses: 1 });
    vi.setSystemTime('2026-10-28T00:00:01Z');
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '次日恢复。' } }] })));
    expect(await generateCompanionText({ system: '合同', user: '保留欠账后次日发送' }, bound, undefined, { fetchFn })).toBe('次日恢复。');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
it('parks a missing policy or unavailable local admission ledger without HTTP and recovers after an explicit real repair', async () => {
  const f = fixture(), fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '修复后实际返回。' } }] })));
  let ledgerReady = false;
  const other = new CompanionModelResources({ directory: f.root, request: async command => command.type === 'model.resources.admit' && !ledgerReady
    ? { ok: false, error: '合成本地准入不可用' } : f.store.request(command), report: error => { throw error; } });
  try {
    const initial = await f.resources.load(), bound = await f.resources.bind(config, 'alice');
    unlinkSync(f.resources.file);
    const missing = await generateCompanionText({ system: '合同', user: '不应发送' }, bound, undefined, { fetchFn }).catch(error => error);
    expect(missing).toMatchObject({ code: 'RATE_LIMIT', admission: { reason: 'policy_unavailable' } });
    expect(companionModelAdmissionRetryAfter(missing)).toBe(30_000); expect(fetchFn).not.toHaveBeenCalled();
    expect(existsSync(f.resources.file)).toBe(false); writeFileSync(f.resources.file, initial.content);
    const guarded = await other.bind(config, 'alice');
    const unavailable = await generateCompanionText({ system: '合同', user: '尚无本地记账准入' }, guarded, undefined, { fetchFn }).catch(error => error);
    expect(unavailable).toMatchObject({ code: 'RATE_LIMIT', admission: { reason: 'accounting_unavailable' } }); expect(fetchFn).not.toHaveBeenCalled();
    ledgerReady = true;
    expect(await generateCompanionText({ system: '合同', user: '已修复' }, guarded, undefined, { fetchFn })).toBe('修复后实际返回。');
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage?.requests).toBe(1);
  } finally { await other.close(); await f.close(); }
});

it('drains an actual pending preflight during cancellation and keeps software policy edits in the same file', async () => {
  const f = fixture(); let finishLoad!: () => void;
  try {
    const snapshot = await f.resources.load(); expect(readFileSync(f.resources.file, 'utf8')).toBe(snapshot.content);
    const bound = await f.resources.bind(config, 'alice'), original = bound.providerBudget!.beforeRequest;
    const blocked = new Promise<void>(resolve => { finishLoad = resolve; });
    bound.providerBudget = { beforeRequest: async (...args) => { const done = await original(...args); await blocked; return done; } };
    const controller = new AbortController(), fetchFn = vi.fn<typeof fetch>();
    const operation = generateCompanionText({ system: '合同', user: '真正发送前取消。' }, bound, controller.signal, { fetchFn });
    await vi.waitFor(() => expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage?.unfinished).toBe(1));
    const cancelled = expect(operation).rejects.toMatchObject({ code: 'CANCELLED' }); controller.abort(); await cancelled;
    let closed = false; const closing = f.resources.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(fetchFn).not.toHaveBeenCalled();
    finishLoad(); await closing;
    expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage).toMatchObject({ requests: 0, unfinished: 0 });
  } finally { finishLoad?.(); await f.close(); }
});

it('serializes concurrent software edits across instances and accepts only one writer for the same captured file revision', async () => {
  const f = fixture(), other = new CompanionModelResources({ directory: f.root, request: async command => f.store.request(command), report: error => { throw error; } });
  try {
    const first = await f.resources.load();
    const results = await Promise.allSettled([f.resources.save(first.revision, JSON.stringify({ ...first.policy, defaultConnection: { ...first.policy.defaultConnection, requestsPerMinute: 2 } })),
      other.save(first.revision, JSON.stringify({ ...first.policy, defaultConnection: { ...first.policy.defaultConnection, requestsPerMinute: 3 } }))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await f.resources.load(); expect([2, 3]).toContain(current.policy.defaultConnection.requestsPerMinute);
    expect(readFileSync(f.resources.file, 'utf8')).toBe(current.content);
  } finally { await other.close(); await f.close(); }
});

it('holds the durable connection permit through response body completion and drains it before shutdown', async () => {
  const f = fixture(); let complete!: () => void;
  try {
    const snapshot = await f.resources.load(), policy = { ...snapshot.policy.defaultConnection, concurrency: 1 };
    await f.resources.save(snapshot.revision, JSON.stringify({ ...snapshot.policy, defaultConnection: policy }));
    const bound = await f.resources.bind(config, 'alice');
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) {
      let completed = false;
      complete = () => { if (completed) return; completed = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '完整正文。' } }] }))); controller.close(); };
    } }), { headers: { 'Content-Type': 'application/json' } }));
    const operation = generateCompanionText({ system: '合同', user: '保留实际响应读取中的连接。' }, bound, undefined, { fetchFn });
    await vi.waitFor(() => expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage?.unfinished).toBe(1));
    expect(admit(f, policy).reason).toBe('concurrency');
    let closed = false; const closing = f.resources.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); complete();
    expect(await operation).toBe('完整正文。'); await closing;
    expect(f.store.request({ type: 'model.resources.usage', connectionId }).modelResourceUsage).toMatchObject({ requests: 1, unfinished: 0, responses: 1 });
  } finally { complete?.(); await f.close(); }
});

it('joins a pending config binding before releasing its connection policy on close', async () => {
  const f = fixture(); let release!: () => void, observed!: () => void;
  const observedLoad = new Promise<void>(resolve => { observed = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const other = new CompanionModelResources({ directory: f.root, request: async command => {
    if (command.type === 'model.resources.config.status') { observed(); await gate; }
    return f.store.request(command);
  }, report: error => { throw error; } });
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  const jobs: Promise<void>[] = [];
  try {
    const snapshot = await f.resources.load(); await f.resources.save(snapshot.revision, JSON.stringify({ ...snapshot.policy,
      defaultConnection: { ...snapshot.policy.defaultConnection, concurrency: 1 } }));
    const binding = other.bind(config, 'alice'); await observedLoad;
    let closed = false; const closing = other.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    release(); await binding; await closing;
    const started: string[] = [];
    for (const ownerId of ['alice', 'bob']) jobs.push(companionModelQuota.run({ ownerId, connectionId, priority: 'foreground' }, async () => { started.push(ownerId); await held; }));
    await vi.waitFor(() => expect(started).toEqual(['alice', 'bob']));
  } finally { release(); finish(); await Promise.all(jobs); await other.close(); await f.close(); }
});
