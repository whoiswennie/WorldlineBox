import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { companionModelConnection, companionModelQuota } from '../../src/main/companions/model-quota';
import { generateCompanionReply, generateCompanionText, companionModelAdmissionRetryAfter, type CompanionModelConfig } from '../../src/main/companions/model';
import type { CompanionReplyInput } from '../../src/main/companions/context';

afterEach(() => vi.useRealTimers());
const input: CompanionReplyInput = { companion: { id: 'alice', name: 'Alice', description: '', persona: '测试角色。', model: '', avatar: 'sister', builtin: false, createdAt: '2026-10-27T00:00:00Z', proactive: false },
  conversation: { id: 'room', kind: 'private', title: '测试', memberIds: ['alice'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: '2026-10-27T00:00:00Z' },
  messages: [], memories: [] };
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: '实际正文。' } }] }), { headers: { 'Content-Type': 'application/json' } });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const config = (): CompanionModelConfig => ({ ownerId: 'alice', model: randomUUID(), apiFormat: 'openai_chat', baseUrl: 'https://synthetic.invalid', apiKey: 'never-send-test-key' });
function invoke(kind: 'text' | 'reply', settings: CompanionModelConfig, fetchFn: typeof fetch, signal?: AbortSignal) {
  return kind === 'text' ? generateCompanionText({ system: '技术测试合同。', user: '测试正文。' }, settings, signal, { fetchFn, timeoutMs: 10 })
    : generateCompanionReply(input, settings, signal, { fetchFn, timeoutMs: 10 });
}

it.each(['text', 'reply'] as const)('defers an unsent %s queue timeout while explicit cancellation remains cancelled', async kind => {
  vi.useFakeTimers(); const settings = config(), connection = companionModelConnection(settings), policy = randomUUID(), hold = pending<void>();
  companionModelQuota.configureConnection(connection, 1, policy);
  const blocker = companionModelQuota.run({ ownerId: 'blocker', connectionId: connection, priority: 'foreground' }, () => hold.promise);
  const fetchFn = vi.fn<typeof fetch>(async () => response());
  try {
    await Promise.resolve();
    const expired = invoke(kind, settings, fetchFn).catch(error => error);
    await vi.advanceTimersByTimeAsync(11); const timeout = await expired;
    expect(timeout).toMatchObject({ code: 'RATE_LIMIT', admission: { reason: 'queue_timeout' } });
    expect(companionModelAdmissionRetryAfter(timeout)).toBe(30_000); expect(fetchFn).not.toHaveBeenCalled();
    const controller = new AbortController(), cancelled = invoke(kind, settings, fetchFn, controller.signal).catch(error => error);
    controller.abort(); const cancellation = await cancelled;
    expect(cancellation).toMatchObject({ code: 'CANCELLED' }); expect(companionModelAdmissionRetryAfter(cancellation)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled(); expect(companionModelQuota.snapshot().queued).toBe(0);
  } finally { hold.resolve(); await blocker; companionModelQuota.releaseConnectionPolicy(connection, policy); }
});

it.each(['text', 'reply'] as const)('defers an unsent %s preflight timeout and settles a late reservation as cancelled before send', async kind => {
  vi.useFakeTimers(); const settings = config(), hold = pending<void>(), finish = vi.fn(async () => undefined), fetchFn = vi.fn<typeof fetch>(async () => response());
  settings.providerBudget = { beforeRequest: async () => { await hold.promise; return finish; } };
  try {
    const result = invoke(kind, settings, fetchFn).catch(error => error);
    await vi.advanceTimersByTimeAsync(11); const error = await result;
    expect(error).toMatchObject({ code: 'RATE_LIMIT', admission: { reason: 'preflight_timeout' } }); expect(fetchFn).not.toHaveBeenCalled();
    hold.resolve(); await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('cancelled_before_send', 0));
    expect(fetchFn).not.toHaveBeenCalled();
  } finally { hold.resolve(); }
});

it.each(['text', 'reply'] as const)('keeps a %s timeout after actual HTTP invocation as a real provider outcome', async kind => {
  vi.useFakeTimers(); const settings = config(), hold = pending<Response>(), fetchFn = vi.fn<typeof fetch>(() => hold.promise);
  try {
    const result = invoke(kind, settings, fetchFn).catch(error => error);
    await vi.advanceTimersByTimeAsync(11); const error = await result;
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(error).toMatchObject({ code: 'TIMEOUT' }); expect(companionModelAdmissionRetryAfter(error)).toBeUndefined();
  } finally { hold.resolve(response()); await Promise.resolve(); }
});
it.each(['text', 'reply'] as const)('parks known unsent %s configuration errors while provider authentication failure remains a real failure', async kind => {
  const settings = config(), fetchFn = vi.fn<typeof fetch>(async () => response());
  for (const patch of [{ apiKey: '' }, { model: '' }, { baseUrl: 'https://user:secret@synthetic.invalid' }]) {
    const error = await invoke(kind, { ...settings, ...patch }, fetchFn).catch(value => value);
    expect(error).toMatchObject({ code: 'CONFIG', admission: { reason: 'configuration_unavailable' } });
    expect(companionModelAdmissionRetryAfter(error)).toBe(30_000);
  }
  expect(fetchFn).not.toHaveBeenCalled();
  fetchFn.mockImplementation(async () => new Response('{}', { status: 401 }));
  const remote = await invoke(kind, settings, fetchFn).catch(error => error);
  expect(remote).toMatchObject({ code: 'AUTH' }); expect(companionModelAdmissionRetryAfter(remote)).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledTimes(1);
});
