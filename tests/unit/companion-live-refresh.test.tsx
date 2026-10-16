// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionMessage, CompanionState, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers();
});

it('shows completed replies during sustained changes when IPC reads take longer than one change interval', async () => {
  vi.useFakeTimers();
  const at = '2026-10-16T07:43:25.000Z', companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
  const room = { id: 'refresh-private', kind: 'private' as const, title: companion.name, memberIds: [companion.id], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '你累吗' };
  const state: CompanionState = { companions: [companion], conversations: [room], activities: [], configured: true };
  const source: CompanionMessage = { id: 'refresh-source', sequence: 1, conversationId: room.id, authorId: 'user', kind: 'text', content: '你累吗', createdAt: at, status: 'sent', attachments: [] };
  const reply: CompanionMessage = { ...source, id: 'refresh-reply', sequence: 2, authorId: companion.id, replyToId: source.id,
    content: '收到，我准备去休息一下。', segments: [{ text: '收到，我准备去休息一下。', actionIds: [] }] };
  let messages = [source], changed: (() => void) | undefined, slow = false;
  const api: WorldlineBoxCompanionsApi = {
    async request(input): Promise<CompanionsResponse> {
      const result: CompanionsResponse = input.type === 'state' ? { ok: true, state }
        : input.type === 'messages' ? { ok: true, messages: [...messages], hasMore: false, hasNewer: false }
          : input.type === 'actions' ? { ok: true, actions: [] } : { ok: true };
      if (slow) await new Promise<void>(resolve => setTimeout(resolve, 50));
      return result;
    },
    onChanged(listener) { changed = listener; return () => { changed = undefined; }; },
    onReplyStream() { return () => undefined; },
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<Companions api={api} onOpenSettings={() => undefined} />));
  expect(container.textContent).not.toContain(reply.content);
  slow = true; messages = [source, reply];
  const changes = setInterval(() => changed?.(), 10);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(container.querySelector('[data-companion-messages]')!.textContent).toContain(reply.content);
  } finally { clearInterval(changes); await act(async () => { await vi.advanceTimersByTimeAsync(100); }); }
});
