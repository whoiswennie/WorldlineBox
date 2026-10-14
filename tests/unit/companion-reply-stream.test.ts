import { expect, it, vi } from 'vitest';
import { CompanionReplyStreamStore, projectCompanionReply } from '../../src/renderer/companions/reply-stream';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
const message: CompanionMessage = { id: 'reply', conversationId: 'room', authorId: 'role', sequence: 2, createdAt: '2026-10-14T08:00:00Z', kind: 'text', status: 'sent', content: '前一步。', attachments: [], replyToId: 'source', isReplyDraft: true, segments: [{ text: '前一步。', actionIds: ['actual-tool'] }] };
function event(patch: Partial<CompanionReplyStreamEvent> = {}): CompanionReplyStreamEvent { return { conversationId: 'room', companionId: 'role', sourceMessageId: 'source', messageId: 'reply', step: 1, attemptId: 'attempt-a', text: '这一段正在输出', phase: 'streaming', ...patch }; }
it('projects only the current turn and lets durable committed text take over without duplication', () => {
  const store = new CompanionReplyStreamStore(), current = vi.fn(), other = vi.fn();
  store.subscribe('reply', current); store.subscribe('another-message', other); store.reconcile([message]);
  store.accept(event()); store.accept(event({ text: '这一段正在输出，继续。' }));
  const projected = projectCompanionReply(message, store.snapshot('reply'));
  expect(projected.segments).toEqual([{ text: '前一步。', actionIds: ['actual-tool'] }, { text: '这一段正在输出，继续。', actionIds: [] }]);
  expect(other).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledTimes(2);
  store.accept(event({ text: '这一段正在输出，继续。', phase: 'committed' }));
  store.reconcile([{ ...message, content: '前一步。\n\n这一段正在输出，继续。', segments: projected.segments, isReplyDraft: true }]);
  expect(store.snapshot('reply').overlays).toHaveLength(0);
  store.accept(event({ text: '迟到旧帧' })); expect(store.snapshot('reply').overlays).toHaveLength(0);
});
it('replaces retried attempts, drops discarded persisted drafts immediately and ignores late or cross-scope frames', () => {
  const store = new CompanionReplyStreamStore();
  const draft = { ...message, replyDraft: { step: 1, attemptId: 'attempt-a', text: '这段不要了' }, segments: [...message.segments!, { text: '这段不要了', actionIds: [] }] };
  store.reconcile([draft]); store.accept(event({ text: '这段不要了' })); store.accept(event({ phase: 'discarded' }));
  expect(projectCompanionReply(draft, store.snapshot('reply')).segments![1]!.text).toBe('');
  store.accept(event({ attemptId: 'attempt-b', text: '重新生成的正文' })); store.accept(event({ text: '旧尝试迟到的正文' }));
  store.accept(event({ attemptId: 'wrong-owner', companionId: 'another-role', text: '不能混入' }));
  expect(projectCompanionReply(draft, store.snapshot('reply')).segments![1]!.text).toBe('重新生成的正文');
  store.accept(event({ attemptId: 'attempt-b', text: '更短' })); expect(store.snapshot('reply').overlays[0]!.text).toBe('重新生成的正文');
});
it('keeps interrupted partial text until a real resumed attempt replaces it', () => {
  const store = new CompanionReplyStreamStore(); store.reconcile([message]); store.accept(event()); store.accept(event({ phase: 'interrupted' }));
  const draft = { ...message, replyDraft: { step: 1, attemptId: 'attempt-a', text: '这一段正在输出' }, segments: [...message.segments!, { text: '这一段正在输出', actionIds: [] }] };
  store.reconcile([draft]); expect(projectCompanionReply(draft, store.snapshot('reply')).phase).toBe('interrupted');
  store.accept(event({ attemptId: 'attempt-b', text: '' })); expect(projectCompanionReply(draft, store.snapshot('reply')).segments![1]!.text).toBe('');
});

it('does not retire a fresh attempt when a late persisted draft happens to have the same prefix', () => {
  const store = new CompanionReplyStreamStore();
  const old = { ...message, replyDraft: { step: 1, attemptId: 'attempt-old', text: '你好' }, segments: [...message.segments!, { text: '你好', actionIds: [] }] };
  store.reconcile([old]); store.accept(event({ attemptId: 'attempt-new', text: '你好' })); store.reconcile([old]);
  store.accept(event({ attemptId: 'attempt-new', text: '你好世界' }));
  expect(projectCompanionReply(old, store.snapshot('reply')).segments![1]!.text).toBe('你好世界');
  store.accept(event({ attemptId: 'attempt-new', phase: 'committed', text: '你好世界' }));
  store.reconcile([{ ...old, replyDraft: { ...old.replyDraft, text: '你好世界' }, segments: [...message.segments!, { text: '你好世界', actionIds: [] }] }]);
  expect(store.snapshot('reply').overlays).toHaveLength(1);
});

it('keeps an empty opening frame across stale snapshots and accepts its later real text', () => {
  const store = new CompanionReplyStreamStore(), empty = { ...message, content: '', segments: [] };
  store.reconcile([empty]); store.accept(event({ step: 0, text: '' })); store.reconcile([empty]);
  store.accept(event({ step: 0, text: '第一次真实增量' }));
  expect(projectCompanionReply(empty, store.snapshot('reply')).segments![0]!.text).toBe('第一次真实增量');
});

it('lets a published final snapshot win when terminal IPC is delayed or missing', () => {
  const store = new CompanionReplyStreamStore(); store.reconcile([message]); store.accept(event({ text: '当前前缀' }));
  store.reconcile([{ ...message, isReplyDraft: undefined, content: '前一步。\n\n当前前缀与全部正式结果。', segments: [...message.segments!, { text: '当前前缀与全部正式结果。', actionIds: [] }] }]);
  expect(store.snapshot('reply').overlays).toHaveLength(0);
  store.accept(event({ text: '当前前缀更多', attemptId: 'late-unknown-attempt' }));
  expect(store.snapshot('reply').overlays).toHaveLength(0);
});
