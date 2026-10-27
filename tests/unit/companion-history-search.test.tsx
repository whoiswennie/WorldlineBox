// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionHistorySearch } from '../../src/renderer/companions/CompanionHistorySearch';
import type { CompanionConversation } from '../../src/shared/companions';
import type { CompanionRequest } from '../../src/renderer/companions/CompanionDialogs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); vi.useRealTimers(); });
const room: CompanionConversation = { id: 'room', title: '聊天', kind: 'private', memberIds: ['alice'], activeTopicId: 'topic_one',
  pinned: false, muted: false, unread: 0, updatedAt: '', lastMessage: '' };
it('searches ordinary and current-topic original history separately and clears the topic filter for all conversations', async () => {
  vi.useFakeTimers();
  const request = vi.fn<CompanionRequest>(async () => ({ ok: true, searchPage: { items: [], hasMore: false, snapshot: 100, indexReady: true } }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<CompanionHistorySearch request={request} conversations={[room]} companions={[]} conversationId={room.id} onClose={() => undefined} onLocate={() => undefined} />));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(request.mock.lastCall![0]).toMatchObject({ conversationId: room.id });
  expect(request.mock.lastCall![0]).not.toHaveProperty('topicId');
  const change = async (label: string, value: string) => {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    await act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(() => vi.advanceTimersByTimeAsync(300));
  };
  await change('搜索话题范围', 'ordinary');
  expect(request.mock.lastCall![0]).toMatchObject({ conversationId: room.id, topicId: null });
  await change('搜索话题范围', 'current');
  expect(request.mock.lastCall![0]).toMatchObject({ conversationId: room.id, topicId: 'topic_one' });
  await act(() => root!.render(<CompanionHistorySearch request={request} conversations={[{ ...room, activeTopicId: 'topic_two' }]} companions={[]} conversationId={room.id} onClose={() => undefined} onLocate={() => undefined} />));
  await act(() => vi.advanceTimersByTimeAsync(300));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(request.mock.lastCall![0]).toMatchObject({ conversationId: room.id, topicId: 'topic_two' });
  expect(request.mock.lastCall![0]).not.toHaveProperty('snapshot');
  await change('搜索范围', '');
  expect(request.mock.lastCall![0]).not.toHaveProperty('topicId');
  expect(request.mock.lastCall![0]).not.toHaveProperty('conversationId');
  expect(container.querySelector('select[aria-label="搜索话题范围"]')).toBeNull();
});
