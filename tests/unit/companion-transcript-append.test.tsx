// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { appendCompanionTranscript } from '../../src/renderer/companions/transcript-append';
import { companionChangeEventSchema, companionTranscriptChangeEventSchema, type CompanionChangeEvent, type CompanionMessage,
  type CompanionReplyStreamEvent, type CompanionState, type CompanionsRequest, type CompanionsResponse,
  type WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-11-01T00:00:00.000Z';
const companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
const room = { id: 'append-room', kind: 'private' as const, title: companion.name, memberIds: [companion.id],
  pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '之前的消息' };
const source: CompanionMessage = { id: 'append-source', conversationId: room.id, authorId: 'user', sequence: 10, revision: 1,
  kind: 'text', status: 'sent', content: '之前的消息', createdAt: at, attachments: [] };
const next: CompanionMessage = { ...source, id: 'append-next', sequence: 12, content: '这条消息已经正式保存。' };
const event = (message = next) => ({ kind: 'transcript' as const, change: 'append' as const, message });
const apply = (overrides: Partial<Parameters<typeof appendCompanionTranscript>[0]> = {}) => appendCompanionTranscript({
  event: event(), conversations: [room], selectedId: room.id, topicId: null, history: false,
  acceptedPage: { conversationId: room.id, topicId: null }, messages: [source], ...overrides });

it('accepts only typed committed user appends or empty persisted drafts, preserving the complete attachment DTO', () => {
  const message = { ...next, attachments: [{ id: 'append-file', name: 'example.txt', mime: 'text/plain', size: 4 }] };
  expect(companionChangeEventSchema.safeParse(event(next)).success).toBe(true);
  expect(companionTranscriptChangeEventSchema.safeParse(event({ ...next, attachments: message.attachments })).success).toBe(true);
  expect(companionTranscriptChangeEventSchema.safeParse(event({ ...next, authorId: companion.id, content: '', isReplyDraft: true })).success).toBe(true);
  for (const invalid of [{ ...next, kind: 'notice' }, { ...next, status: 'failed' }, { ...next, sourceUnavailable: 'execution_source_changed' },
    { ...next, actionId: 'action-one' }, { ...next, authorId: companion.id }, { ...next, audience: 'agenda' },
    { ...next, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...next, segments: [{ text: next.content, actionIds: [] }] }])
    expect(companionChangeEventSchema.safeParse(event(invalid as CompanionMessage)).success).toBe(false);
  expect(companionChangeEventSchema.safeParse({ ...event(), sql: 'not-a-wire-field' }).success).toBe(false);
});

it('deduplicates exact id/revision and refuses changed identities or an append that would amend a read row', () => {
  const appended = apply(); expect(appended.kind).toBe('append');
  if (appended.kind !== 'append') throw new Error('Expected an append');
  expect(apply({ messages: appended.messages }).kind).toBe('duplicate');
  expect(apply({ messages: [source, { ...next, revision: 2 }] }).kind).toBe('duplicate');
  expect(apply({ event: event({ ...next, revision: 2 }), messages: [source, next] }).kind).toBe('reload');
  for (const altered of [{ ...next, content: 'changed' }, { ...next, sequence: 13 },
    { ...next, authorId: companion.id }, { ...next, topicId: 'other-topic' }])
    expect(apply({ messages: [source, altered] }).kind).toBe('reload');
  expect(apply({ messages: [source, { ...source, id: 'sequence-collision', sequence: next.sequence }] }).kind).toBe('reload');
});

it('binds the exact room/topic/latest-page authority and leaves a historical page in place', () => {
  expect(apply({ acceptedPage: undefined }).kind).toBe('reload');
  expect(apply({ acceptedPage: { conversationId: room.id, topicId: undefined } }).kind).toBe('reload');
  expect(apply({ conversations: [] }).kind).toBe('reload');
  expect(apply({ history: true }).kind).toBe('newer');
  expect(apply({ event: event({ ...next, topicId: 'another-topic' }) }).kind).toBe('ignore');
  expect(apply({ event: event({ ...next, conversationId: 'another-room' }), conversations: [room, { ...room, id: 'another-room' }] }).kind).toBe('ignore');
  expect(apply({ event: event({ ...next, authorId: 'not-a-member', content: '', isReplyDraft: true }) }).kind).toBe('reload');
});

it('keeps active draft progress and bounds an append to the existing message window', () => {
  const draft = { ...next, authorId: companion.id, content: '', isReplyDraft: true };
  expect(apply({ event: event(draft), messages: [source, { ...draft, content: '已经流入的正文' }] }).kind).toBe('duplicate');
  const messages = Array.from({ length: 200 }, (_, index) => ({ ...source, id: 'bounded-' + index, sequence: index + 1 }));
  const result = apply({ event: event({ ...next, sequence: 201 }), messages });
  expect(result.kind).toBe('append');
  if (result.kind !== 'append') throw new Error('Expected bounded append');
  expect(result.messages).toHaveLength(200); expect(result.messages[0]!.sequence).toBe(2); expect(result.trimmed).toBe(true);
});

let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount() {
  vi.useFakeTimers();
  const state: CompanionState = { companions: [companion], conversations: [room], activities: [], configured: true };
  let rows = [source], changed: ((event?: CompanionChangeEvent) => void) | undefined;
  let stream: ((event: CompanionReplyStreamEvent) => void) | undefined;
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'state' ? { ok: true, state }
    : input.type === 'state.progress' ? { ok: true, runtimeProgress: { queue: [], activities: [], owners: [] } }
      : input.type === 'messages' ? { ok: true, messages: [...rows], hasMore: false, hasNewer: false }
        : input.type === 'actions' ? { ok: true, actions: [] } : input.type === 'topic.list' ? { ok: true, topics: [] } : { ok: true });
  const api: WorldlineBoxCompanionsApi = { request, onChanged(listener) { changed = listener; return () => { changed = undefined; }; },
    onReplyStream(listener) { stream = listener; return () => { stream = undefined; }; } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<Companions api={api} onOpenSettings={() => undefined} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); request.mockClear();
  return { request, rows: (messages: CompanionMessage[]) => { rows = messages; }, changed: (event?: CompanionChangeEvent) => changed?.(event),
    progress: () => stream?.({ conversationId: room.id, companionId: companion.id, sourceMessageId: source.id, messageId: 'live-draft',
      step: 0, attemptId: 'append-progress', text: '', phase: 'progress', messageIdentity: { sequence: 11, createdAt: at },
      progress: { workId: 'append-work', sourceMessageId: source.id, revision: 1, phase: 'memory', detail: '正在回忆', startedAt: at, updatedAt: at } }) };
}
const transcriptText = () => host!.querySelector('[data-companion-messages]')!.textContent;
const fullReads = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter(([input]) => ['messages', 'actions', 'topic.list', 'topic.read'].includes(input.type));

it('renders committed appends and deduplicates them without a full-page/source read, retaining live progress', async () => {
  const f = await mount();
  await act(async () => { f.progress(); f.changed(event()); f.changed(event()); await vi.advanceTimersByTimeAsync(1000); });
  expect(transcriptText()).toContain(next.content); expect(host!.querySelectorAll('[data-companion-message="append-next"]')).toHaveLength(1);
  expect(host!.querySelector('[data-reply-stage="memory"]')).not.toBeNull();
  expect(fullReads(f.request)).toHaveLength(0); expect(f.request.mock.calls.some(([input]) => input.type === 'state')).toBe(true);
});

it('falls back to the authoritative page for a conflicting append without amending the old row', async () => {
  const f = await mount(); f.rows([{ ...source, content: '', sourceUnavailable: 'execution_source_changed' }]);
  await act(async () => f.changed(event({ ...source, content: '不能覆盖原行' })));
  expect(transcriptText()).not.toContain('不能覆盖原行');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(fullReads(f.request).some(([input]) => input.type === 'messages')).toBe(true);
  expect(transcriptText()).not.toContain(source.content); expect(transcriptText()).toContain('此消息引用的资料已变化');
});

it('does not let a late delta bypass a pending hard withdrawal read or restore its old page', async () => {
  const f = await mount(), original = f.request.getMockImplementation()!;
  let finish!: (response: CompanionsResponse) => void, held = false;
  f.request.mockImplementation(input => {
    if (input.type === 'messages' && !held) { held = true; return new Promise(resolve => { finish = resolve; }); }
    return original(input);
  });
  await act(async () => { f.changed(); await vi.advanceTimersByTimeAsync(600); }); expect(held).toBe(true);
  await act(async () => { f.changed(event()); f.changed({ kind: 'memory', change: 'content', companionIds: [] }); });
  expect(transcriptText()).not.toContain(next.content);
  const withdrawn = { ...source, content: '', sourceUnavailable: 'execution_source_changed' as const }; f.rows([withdrawn]);
  await act(async () => { finish({ ok: true, messages: [withdrawn], hasMore: false }); await vi.advanceTimersByTimeAsync(1000); });
  expect(transcriptText()).not.toContain(next.content); expect(transcriptText()).toContain('此消息引用的资料已变化');
});

it('rejects a delayed successful send ACK after a hard event before its new page has finished', async () => {
  const f = await mount(), original = f.request.getMockImplementation()!;
  let acknowledge!: (response: CompanionsResponse) => void, read!: (response: CompanionsResponse) => void;
  f.request.mockImplementation(input => input.type === 'message.send' ? new Promise(resolve => { acknowledge = resolve; })
    : input.type === 'messages' ? new Promise(resolve => { read = resolve; }) : original(input));
  const textarea = host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, next.content);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click(); });
  expect(acknowledge).toBeTypeOf('function');
  await act(async () => { f.changed(); await vi.advanceTimersByTimeAsync(600); });
  await act(async () => acknowledge({ ok: true, message: next }));
  expect(transcriptText()).not.toContain(next.content);
  await act(async () => { read({ ok: true, messages: [source], hasMore: false }); await vi.advanceTimersByTimeAsync(1000); });
  expect(transcriptText()).not.toContain(next.content);
});

it('uses at most one fresh page fallback when a public ACK arrives without a verified delta, never its raw body', async () => {
  const f = await mount(), original = f.request.getMockImplementation()!;
  let finish!: (response: CompanionsResponse) => void;
  f.request.mockImplementation(input => input.type === 'message.send' ? Promise.resolve({ ok: true, message: next })
    : input.type === 'messages' ? new Promise(resolve => { finish = resolve; }) : original(input));
  const textarea = host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, next.content);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click(); });
  expect(finish).toBeTypeOf('function'); expect(transcriptText()).not.toContain(next.content);
  expect(f.request.mock.calls.filter(([input]) => input.type === 'messages')).toHaveLength(1);
  const fresh = { ...next, content: '当前页面实际核验的正文。' };
  await act(async () => { finish({ ok: true, messages: [source, fresh], hasMore: false }); });
  expect(transcriptText()).toContain(fresh.content); expect(transcriptText()).not.toContain(next.content);
});
