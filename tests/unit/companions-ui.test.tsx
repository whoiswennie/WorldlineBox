// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionAction, CompanionAttachment, CompanionConversation, CompanionMemory, CompanionMessage, CompanionReplyStreamEvent, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionMemoryDocumentRead } from '../../src/shared/companion-memory-documents';
import type { CompanionWorkspaceRequest, CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
const date = '2026-10-13T08:00:00.000Z';
const sisters: Companion[] = BUILTIN_COMPANIONS.map(item => ({ ...item, builtin: true, createdAt: date }));
function conversation(id: string, kind: 'private' | 'group', memberIds: string[], pinned = false): CompanionConversation { return { id, kind, title: kind === 'group' ? '海边小屋' : sisters.find(item => item.id === memberIds[0])!.name, memberIds, pinned, muted: false, unread: 0, updatedAt: date, lastMessage: '一起聊聊吧' }; }
function message(sequence: number, content = `第 ${sequence} 条消息`, extra: Partial<CompanionMessage> = {}): CompanionMessage { return { id: `message-${sequence}`, sequence, conversationId: 'private-sister', authorId: sequence % 2 ? 'user' : 'deepseek-sister', kind: 'text', content, createdAt: date, status: 'sent', attachments: [], ...extra }; }

function pendingReply(phase: 'waiting' | 'thinking' = 'thinking', detail = '正在生成回复'): CompanionMessage {
  return message(2, '', { isReplyDraft: true, segments: [], replyToId: 'message-1', replyProgress: {
    workId: 'work-one', revision: 1, phase, detail, startedAt: date, updatedAt: date } });
}

function fixture(extra: Partial<CompanionState> = {}, initialMessages = [message(1, '帮我整理照片'), message(2, '我们慢慢来。')], initialActions: CompanionAction[] = []) {
  let state: CompanionState = { companions: sisters.map(item => ({ ...item })), conversations: [conversation('private-sister', 'private', ['deepseek-sister'], true), conversation('group-home', 'group', ['deepseek-sister', 'deepseek-flash'])], activities: [], configured: true, ...extra };
  let messages = initialMessages;
  let memories: CompanionMemory[] = [];
  let actions: CompanionAction[] = initialActions;
  let listener: (() => void) | undefined;
  let streamListener: ((event: CompanionReplyStreamEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    switch (input.type) {
      case 'state': return { ok: true, state };
      case 'messages': {
        const all = messages.filter(item => item.conversationId === input.conversationId);
        const anchor = input.around ? all.find(item => item.id === input.around) : undefined;
        const selected = all.filter(item => (input.before === undefined || item.sequence < input.before) && (input.after === undefined || item.sequence > input.after));
        const limit = input.limit ?? 50;
        const page = anchor ? [...all.filter(item => item.sequence <= anchor.sequence).slice(-Math.ceil(limit / 2)), ...all.filter(item => item.sequence > anchor.sequence).slice(0, Math.floor(limit / 2))] : input.after !== undefined ? selected.slice(0, limit) : selected.slice(-limit);
        return { ok: true, messages: page, hasMore: all.some(item => item.sequence < (page[0]?.sequence ?? 0)), hasNewer: all.some(item => item.sequence > (page.at(-1)?.sequence ?? Infinity)) };
      }
      case 'message.search': return { ok: true, messages: messages.filter(item => (!input.conversationId || item.conversationId === input.conversationId) && item.content.includes(input.query)) };
      case 'message.get': return { ok: true, message: messages.find(item => item.id === input.id) };
      case 'conversation.read': state = { ...state, conversations: state.conversations.map(item => item.id === input.id ? { ...item, unread: 0 } : item) }; return { ok: true };
      case 'conversation.open': {
        let selected = state.conversations.find(item => item.kind === 'private' && item.memberIds[0] === input.companionId);
        if (!selected) { selected = conversation(`private-${input.companionId}`, 'private', [input.companionId]); state = { ...state, conversations: [...state.conversations, selected] }; }
        return { ok: true, conversation: selected };
      }
      case 'conversation.create-group': {
        const selected = { ...conversation('new-group', 'group', input.memberIds), title: input.title };
        state = { ...state, conversations: [...state.conversations, selected] }; return { ok: true, conversation: selected };
      }
      case 'conversation.update': {
        state = { ...state, conversations: state.conversations.map(item => item.id === input.id ? { ...item, ...input, id: item.id } : item) };
        return { ok: true, conversation: state.conversations.find(item => item.id === input.id) };
      }
      case 'companion.create': {
        const companion: Companion = { ...input.companion, id: 'new-companion', builtin: false, createdAt: date };
        state = { ...state, companions: [...state.companions, companion] }; return { ok: true, companion };
      }
      case 'companion.update': {
        state = { ...state, companions: state.companions.map(item => item.id === input.id ? { ...item, ...input.companion } : item) };
        return { ok: true, companion: state.companions.find(item => item.id === input.id) };
      }
      case 'companion.set-active': { state = { ...state, companions: state.companions.map(role => role.id === input.id ? { ...role, active: input.active } : role) }; return { ok: true, companion: state.companions.find(role => role.id === input.id) }; }
      case 'companion.delete': state = { ...state, companions: state.companions.filter(item => item.id !== input.id) }; return { ok: true };
      case 'companion.add-builtin': {
        const template = sisters.find(item => item.avatar === input.templateId)!;
        state = { ...state, companions: [...state.companions, template] }; return { ok: true, companion: template };
      }
      case 'message.send': {
        const sent = message((messages.at(-1)?.sequence ?? 0) + 1, input.content, { id: input.clientId, conversationId: input.conversationId, authorId: 'user', replyToId: input.replyToId, attachments: input.attachmentIds?.map(id => ({ id, name: '旅行照片.jpg', mime: 'image/jpeg', size: 2048 })) ?? [] });
        messages = [...messages, sent]; return { ok: true, message: sent };
      }
      case 'attachment.pick': return { ok: true, attachments: [{ id: 'photo', name: '旅行照片.jpg', mime: 'image/jpeg', size: 2048 }] };
      case 'avatar.crop': return { ok: true, attachments: [{ id: 'cropped-photo', name: '头像.png', mime: 'image/png', size: 4096 }] };
      case 'memory.list': return { ok: true, memories: memories.filter(item => item.companionId === input.companionId) };
      case 'memory.browse': return { ok: true, memoryPage: { items: memories.filter(item => item.companionId === input.companionId).map(memory => ({ memory, reasons: [], path: [] })), hasMore: false } };
      case 'schedule.list': return { ok: true, schedules: [], scheduleOccurrences: [] };
      case 'work-order.list': return { ok: true, workOrderPage: { items: [], hasMore: false } };
      case 'state.get': return { ok: true, runtimeState: { companionId: input.companionId, energy: 82, mood: 'calm', expression: 'gentle', affect: { pleasure: .2, arousal: -.1, dominance: .1 }, relationship: { affinity: 45, trust: 50, respect: 60 }, familiarity: { stage: 'acquainted', interactionCount: 4, sharedEventCount: 1 }, updatedAt: date, revision: 1 } };
      case 'memory.save': {
        const previous = memories.find(item => item.id === input.id);
        const source = messages.find(item => item.id === (input.sourceMessageId ?? previous?.sourceMessageId));
        const sourceConversationId = input.conversationId ?? source?.conversationId ?? previous?.sourceConversationId ?? 'private-sister';
        const saved: CompanionMemory = { id: input.id ?? 'memory-a', companionId: input.companionId,
          scopeId: `scope-${input.companionId}-${sourceConversationId}`, content: input.content, sourceMessageId: source?.id,
          sourceConversationId, sourceSequence: source?.sequence ?? 0,
          sources: source ? [{ messageId: source.id, conversationId: source.conversationId, sequence: source.sequence,
            authorId: source.authorId, revision: 1, checksum: 'fixture-host-checksum', createdAt: source.createdAt }] : [],
          tags: previous?.tags ?? [], status: 'queued', captureMethod: 'manual', version: (previous?.version ?? 0) + 1,
          origin: 'user', createdAt: previous?.createdAt ?? date, updatedAt: date };
        memories = [...memories.filter(item => item.id !== saved.id), saved]; return { ok: true, memories };
      }
      case 'memory.delete': memories = memories.filter(item => item.id !== input.id); return { ok: true };
      case 'actions': return { ok: true, actions: actions.filter(item => item.conversationId === input.conversationId) };
      case 'action.get': return { ok: true, action: actions.find(item => item.id === input.id) };
      case 'actions.page': {
        const items = actions.filter(item => item.conversationId === input.conversationId && (!input.companionId || item.companionId === input.companionId));
        return { ok: true, actionPage: { items: items.slice(0, input.limit), total: items.length, hasMore: false, owners: [] } };
      }
      case 'action.run': {
        actions = [...actions, { id: 'action-a', companionId: input.companionId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId, title: input.title, status: 'running', createdAt: date, updatedAt: date }]; return { ok: true, actions };
      }
      case 'action.cancel': actions = actions.map(item => item.id === input.id ? { ...item, status: 'cancelled' } : item); return { ok: true };
      default: return { ok: true };
    }
  });
  const api: WorldlineBoxCompanionsApi = { request, onChanged: vi.fn(next => { listener = next; return unsubscribe; }), onReplyStream: vi.fn(next => { streamListener = next; return () => { streamListener = undefined; }; }) };
  return { api, request, unsubscribe, state: () => state, async stream(event: CompanionReplyStreamEvent) { await act(() => streamListener?.(event)); }, async publish(next: Partial<CompanionState> = {}, nextMessages = messages) { state = { ...state, ...next }; messages = nextMessages; await act(() => listener?.()); }, async publishActions(next: CompanionAction[]) { actions = next; await act(() => listener?.()); }, memories: () => memories };
}
async function mount(api: WorldlineBoxCompanionsApi, isActive = true, onOpenSettings = vi.fn()) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<Companions api={api} isActive={isActive} onOpenSettings={onOpenSettings} />));
  return onOpenSettings;
}
function button(label: string, scope: ParentNode = container!): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  if (!found) throw new Error(`Button missing: ${label}`); return found;
}
async function click(label: string, scope?: ParentNode) { await act(() => button(label, scope).click()); }
function memoryWorkspaceFixture() {
  const documents: CompanionMemoryDocumentRead[] = ['日记/晨间札记.md', '资料/学习摘记.md'].map((path, index) => ({
    document: { path, name: path.split('/').at(-1)!, title: index ? '学习摘记' : '晨间札记', directory: index ? '资料' : '日记', kind: 'note', category: index ? 'material' : 'diary',
      createdAt: date, updatedAt: date, bytes: 40, revision: 'version-1', contentHash: 'a'.repeat(64), readOnly: false, tags: [], syncState: 'indexed', noteId: 'note-' + index, version: 1, sourceCount: 0 },
    content: index ? '今天读到的一段资料。' : '今天的晨间札记。', sources: [], hasMoreSources: false,
  }));
  return vi.fn(async (input: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse> => {
    if (input.type === 'status') return { ok: true };
    if (input.type === 'memory.learning.goals.list') return { ok: true, learningGoals: { items: [], hasMore: false } };
    if (input.type === 'memory.learning.status') return { ok: true, learning: { grants: [], reads: [], libraries: [] } };
    if (input.type === 'memory.documents.list') return { ok: true, documents: { companionId: input.companionId, directory: input.directory,
      folders: [{ path: '日记', name: '日记', count: 1 }, { path: '资料', name: '资料', count: 1 }],
      items: documents.filter(item => !input.directory || item.document.directory === input.directory).map(item => item.document), hasMore: false } };
    if (input.type === 'memory.documents.read') return { ok: true, document: documents.find(item => item.document.path === input.path) };
    return { ok: true };
  });
}

function stateReceiptFixture() {
  const f = fixture({}, [message(1), message(2), message(3, '这是状态变化对应的真实群聊来源。', { conversationId: 'group-home' })]);
  const base = f.request.getMockImplementation()!; let withdrawn = false;
  f.request.mockImplementation(input => input.type === 'state.get' ? Promise.resolve({ ok: true, runtimeState: {
    companionId: input.companionId, energy: 82, mood: 'calm', expression: 'gentle', affect: { pleasure: .2, arousal: -.1, dominance: .1 }, relationship: { affinity: 45, trust: 50, respect: 60 }, familiarity: { stage: 'acquainted', interactionCount: 4, sharedEventCount: 1 }, updatedAt: date, revision: 1,
    recentChanges: withdrawn ? [] : [{ id: 'formal-state', kind: 'memory', appliedAt: date, occurredAt: date, reason: '有真实来源的理解影响。', affectDelta: { pleasure: .05, arousal: 0, dominance: 0 }, relationshipDelta: { affinity: 0, trust: 0, respect: 0 }, energyDelta: 0, sourceConversationId: 'group-home', sourceMessageIds: ['message-3'], memoryIds: ['note-1'] }],
  } satisfies CompanionRuntimeState }) : base(input));
  return { ...f, withdraw: () => { withdrawn = true; } };
}
async function openStateReceiptSources() {
  await click('我们之间'); await click('查看当前伙伴状态详情');
  for (const text of ['状态变化的来处', '查看来源']) { const summary = [...container!.querySelectorAll('summary')].find(item => item.textContent?.includes(text))!; await act(() => { const details = summary.parentElement as HTMLDetailsElement; details.open = true; details.dispatchEvent(new Event('toggle')); }); }
}

it('revalidates a state source before navigating to its actual cross-conversation message', async () => {
  const f = stateReceiptFixture(); await mount(f.api); await openStateReceiptSources(); await click('查看来源消息 1');
  expect(f.request.mock.calls.filter(([input]) => input.type === 'state.get').length).toBeGreaterThanOrEqual(2); expect(f.request).toHaveBeenCalledWith({ type: 'message.get', id: 'message-3' });
  expect(container!.querySelector('.companions-chat-name')?.textContent).toContain('海边小屋'); expect(container!.textContent).toContain('这是状态变化对应的真实群聊来源。');
});

it('keeps a withdrawn state source from opening an obsolete or unrelated conversation', async () => {
  const f = stateReceiptFixture(); await mount(f.api); await openStateReceiptSources(); f.withdraw(); await click('查看来源消息 1');
  expect(container!.textContent).toContain('这条状态来源已变化或不可访问'); expect(f.request).not.toHaveBeenCalledWith({ type: 'message.get', id: 'message-3' }); expect(container!.querySelector('.companions-chat-name')?.textContent).not.toContain('海边小屋');
});

it('opens the exact current owner memory document from a committed state receipt', async () => {
  vi.useFakeTimers(); const f = stateReceiptFixture(), base = memoryWorkspaceFixture();
  const workspace = vi.fn((input: CompanionWorkspaceRequest) => input.type === 'memory.documents.locate' ? base({ type: 'memory.documents.read', companionId: input.companionId, path: '资料/学习摘记.md', sourceLimit: 20 }) : base(input));
  await mount({ ...f.api, workspace }); await openStateReceiptSources(); await click('查看相关记忆 1'); await act(() => vi.advanceTimersByTimeAsync(400));
  expect(workspace).toHaveBeenCalledWith({ type: 'memory.documents.locate', companionId: 'deepseek-sister', noteId: 'note-1' }); expect(container!.querySelector('.memory-library-paper')?.textContent ?? container!.textContent).toContain('今天读到的一段资料。');
});

it('keeps companion navigation usable and preserves the selected folder, document and unsaved edit across memory tabs', async () => {
  vi.useFakeTimers();
  const f = fixture(), workspace = memoryWorkspaceFixture();
  await mount({ ...f.api, workspace }); await click('打开伙伴记忆库');
  await act(() => vi.advanceTimersByTimeAsync(300));
  const manager = container!.querySelector<HTMLElement>('[aria-label="共同记忆管理"]')!;
  expect(manager.getAttribute('role')).toBe('region'); expect(manager.hasAttribute('aria-modal')).toBe(false);
  const nav = container!.querySelector<HTMLElement>('[aria-label="伙伴导航"]')!;
  expect(button('打开伙伴记忆库', nav).getAttribute('aria-pressed')).toBe('true');
  expect(button('消息', nav).getAttribute('aria-pressed')).toBe('false');
  await click('学习资料1'); await act(() => vi.advanceTimersByTimeAsync(300));
  await click('编辑记忆 note-1'); await fill('textarea[aria-label="共同记忆内容"]', '还没有保存的学习笔记。');
  const editor = manager.querySelector<HTMLTextAreaElement>('textarea[aria-label="共同记忆内容"]')!;
  await click('联系人', nav); expect(manager.hidden).toBe(true);
  expect(button('联系人', nav).getAttribute('aria-pressed')).toBe('true');
  const requests = workspace.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(workspace).toHaveBeenCalledTimes(requests);
  await click('消息', nav); expect(manager.hidden).toBe(true); expect(button('消息', nav).getAttribute('aria-pressed')).toBe('true');
  await click('生活总览', nav); expect(manager.hidden).toBe(true); expect(button('生活总览', nav).getAttribute('aria-pressed')).toBe('true');
  expect(container!.querySelector<HTMLElement>('[aria-label="伙伴生活总览"]')?.hidden).toBe(false);
  expect(f.request.mock.calls.some(([command]) => command.type === 'conversation.open')).toBe(false);
  await click('打开伙伴记忆库', nav); await act(() => vi.advanceTimersByTimeAsync(300));
  expect(manager.hidden).toBe(false); expect(container!.querySelector('[aria-label="共同记忆管理"]')).toBe(manager);
  expect(manager.querySelector('textarea[aria-label="共同记忆内容"]')).toBe(editor);
  expect(editor.value).toBe('还没有保存的学习笔记。');
  expect(manager.querySelector('[aria-label="记忆文档目录"] [aria-current="page"]')?.textContent).toContain('学习资料');
  expect(container!.querySelector('[role="alertdialog"]')).toBeNull();
});

it('routes the current chat processing entrance into the memory tab and leaves navigation available while preserving that view', async () => {
  vi.useFakeTimers();
  const f = fixture(), workspace = memoryWorkspaceFixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => input.type === 'memory.processing.status' ? { ok: true, memoryProcessing: { companionId: input.companionId,
    summary: { pending: 0, running: 0, failed: 0, completed: 1, cancelled: 0 }, jobs: [], hasMore: false } } : original(input));
  await mount({ ...f.api, workspace }); await click('我们之间');
  await click('查看记忆处理进度', container!.querySelector('[aria-label="伙伴手帐"]')!);
  await act(() => vi.advanceTimersByTimeAsync(300));
  const nav = container!.querySelector<HTMLElement>('[aria-label="伙伴导航"]')!;
  const manager = container!.querySelector<HTMLElement>('[aria-label="共同记忆管理"]')!;
  expect(button('打开伙伴记忆库', nav).getAttribute('aria-pressed')).toBe('true');
  expect(manager.querySelector('[role="region"][aria-label="记忆处理进度"]')).not.toBeNull();
  expect(document.querySelector('.companion-memory-processing-chat-overlay')).toBeNull();
  expect(manager.querySelector<HTMLSelectElement>('[aria-label="记忆所属伙伴"]')!.value).toBe('deepseek-sister');
  await click('联系人', nav); expect(manager.hidden).toBe(true);
  expect(manager.querySelector('[aria-label="记忆处理进度"]')).toBeNull();
  await click('打开伙伴记忆库', nav);
  expect(manager.querySelector('[aria-label="记忆处理进度"]')).not.toBeNull();
  await click('关闭记忆处理进度');
  await click('消息', nav); await click('打开伙伴记忆库', nav);
  expect(manager.querySelector('[aria-label="记忆处理进度"]')).toBeNull();
  expect(manager.querySelector('[aria-label="伙伴记忆库"]')).not.toBeNull();
  await click('学习与成长');
  expect(manager.querySelector('[aria-label="伙伴学习与成长"]')).not.toBeNull();
  await click('消息', nav);
  await click('查看记忆处理进度', container!.querySelector('[aria-label="伙伴手帐"]')!);
  expect(manager.querySelector('[aria-label="伙伴学习与成长"]')).toBeNull();
  expect(manager.querySelector('[role="region"][aria-label="记忆处理进度"]')).not.toBeNull();
});
async function fill(selector: string, value: string) {
  const element = container!.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  if (!element) throw new Error(`Input missing: ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
  return element;
}
async function select(selector: string, value: string) { const element = container!.querySelector<HTMLSelectElement>(selector)!; await act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function submitDialog() { const form = container!.querySelector<HTMLFormElement>('[role="dialog"] form')!; await act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('drops several local files into the composer, keeps text and absolute-path references, and deduplicates repeated drops', async () => {
  const f = fixture(), files = [new File(['alpha'], '资料.txt'), new File(['beta'], 'image.png')];
  const attachments: CompanionAttachment[] = files.map((file, index) => ({ id: `drop-${index}`, name: file.name, mime: file.type || 'text/plain', size: file.size, path: `C:\\fixture\\${file.name}` }));
  const importFiles = vi.fn(async () => ({ ok: true, attachments })); await mount({ ...f.api, importFiles });
  await fill('textarea', '帮我处理这两个文件');
  for (let repeat = 0; repeat < 2; repeat++) await act(async () => {
    const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files } });
    container!.querySelector('[aria-label="消息输入区"]')!.dispatchEvent(drop);
  });
  expect(importFiles).toHaveBeenCalledTimes(2); expect(container!.querySelectorAll('.companions-draft-attachments > span')).toHaveLength(2);
  expect(container!.querySelector('.companions-draft-attachments > span')!.getAttribute('title')).toBe(attachments[0]!.path);
  await click('发送'); expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', content: '帮我处理这两个文件', attachmentIds: ['drop-0', 'drop-1'] }));
});

it('pastes clipboard files through Main while leaving ordinary text paste untouched and blocking excess files', async () => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async input => input.type === 'attachment.clipboard' ? { ok: true, attachments: [{ id: 'paste', name: '粘贴.png', mime: 'image/png', path: 'C:\\fixture\\paste.png', size: 10 }] } : original(input));
  const importFiles = vi.fn(async () => ({ ok: true, attachments: [] })); await mount({ ...f.api, importFiles });
  const textarea = container!.querySelector('textarea')!;
  const text = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(text, 'clipboardData', { value: { files: [], types: ['text/plain'], getData: () => '保留正常文本粘贴' } });
  await act(() => textarea.dispatchEvent(text)); expect(text.defaultPrevented).toBe(false); expect(f.request).not.toHaveBeenCalledWith({ type: 'attachment.clipboard' });
  const paste = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { files: [], types: ['Files'], getData: () => '' } });
  await act(async () => { textarea.dispatchEvent(paste); }); expect(paste.defaultPrevented).toBe(true); expect(container!.textContent).toContain('粘贴.png');
  const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: Array.from({ length: 11 }, () => new File(['x'], 'x')) } });
  await act(() => textarea.dispatchEvent(drop)); expect(importFiles).not.toHaveBeenCalled(); expect(container!.textContent).toContain('最多添加 10');
});

it('searches and filters the full built-in catalogue and restores the selected role with its own template ID', async () => {
  const f = fixture({ companions: sisters.filter(item => item.id !== 'phoebe') });
  await mount(f.api); await click('联系人'); await click('添加新的伙伴');
  const dialog = container!.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll('[data-builtin-template]')).toHaveLength(15);
  await click('原创角色', dialog);
  expect([...dialog.querySelectorAll('[data-builtin-template]')].map(item => item.getAttribute('data-builtin-template'))).toEqual(['huan-white', 'huan-black']);
  await click('全部', dialog);
  await fill('input[aria-label="搜索内置角色"]', '菲比');
  expect(dialog.querySelectorAll('[data-builtin-template]')).toHaveLength(1);
  const card = dialog.querySelector('[data-builtin-template="phoebe"]')!;
  expect(card.querySelector('.companion-avatar')!.classList.contains('has-square-image')).toBe(true);
  await click('添加', card);
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.add-builtin', templateId: 'phoebe' });
});

it('keeps private and group conversations in the message list and opens the same private conversation from contacts', async () => {
  const f = fixture(); await mount(f.api);
  const navigation = container!.querySelector('nav[aria-label="伙伴导航"]')!;
  expect([...navigation.querySelectorAll('button')].map(item => item.textContent)).toEqual(['消息', '联系人', '生活', '记忆', '世界', '社交']);
  expect(container!.querySelector('[aria-label="伙伴设置"]')).toBeNull();
  expect(container!.querySelectorAll('[data-companion-conversation]')).toHaveLength(2);
  expect(container!.querySelector('[data-companion-conversation]')!.getAttribute('data-companion-conversation')).toBe('private-sister');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('我们慢慢来。');
  await click('联系人'); await click('发消息');
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.open', companionId: 'deepseek-sister' });
  expect(f.state().conversations).toHaveLength(2);
  expect(container!.querySelector('[data-companion-conversation="private-sister"]')!.classList.contains('is-selected')).toBe(true);
});

it('keeps user messages literal while formatting companion replies as structural Markdown', async () => {
  const f = fixture({}, [message(1, '**原始输入**\n- 保留换行'), message(2, '**伙伴回复**\n\n- 一项结果')]);
  await mount(f.api);
  const userBubble = container!.querySelector('.companions-message.is-own .companions-message-bubble')!;
  expect(userBubble.textContent).toBe('**原始输入**\n- 保留换行');
  expect(userBubble.querySelector('strong, ul')).toBeNull();
  const reply = container!.querySelector('.companions-message:not(.is-own) .companions-message-content')!;
  expect(reply.querySelector('strong')!.textContent).toBe('伙伴回复');
  expect(reply.querySelector('li')!.textContent).toBe('一项结果');
});

it('bounds long drafts in the floating input and returns to a compact height when the draft is sent', async () => {
  const f = fixture(); await mount(f.api);
  const input = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!;
  let measuredHeight = 640;
  Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => measuredHeight });
  await fill('textarea[aria-label="输入消息"]', '很长的消息\n'.repeat(80));
  expect(input.style.height).toBe('176px');
  expect(input.parentElement!.className).toBe('companions-composer');
  measuredHeight = 20;
  await click('发送');
  expect(input.value).toBe('');
  expect(input.style.height).toBe('56px');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', content: '很长的消息\n'.repeat(80) }));
});

it('does not mark messages read while the module is hidden or the contact page is visible', async () => {
  const f = fixture({ conversations: [{ ...conversation('private-sister', 'private', ['deepseek-sister'], true), unread: 3 }] });
  const settings = await mount(f.api, false);
  expect(f.request.mock.calls.some(([input]) => input.type === 'conversation.read')).toBe(false);
  await act(() => root!.render(<Companions api={f.api} isActive onOpenSettings={settings} />));
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.read', id: 'private-sister' });
  await click('联系人'); f.request.mockClear();
  await f.publish({ conversations: [{ ...f.state().conversations[0]!, unread: 4 }] });
  expect(f.request.mock.calls.some(([input]) => input.type === 'conversation.read')).toBe(false);
  await click('消息');
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.read', id: 'private-sister' });
});

it('honors IME and Shift+Enter, accepts new input while the companion is thinking, and does not turn chat into a DSH task', async () => {
  const f = fixture({ activities: [{ companionId: 'deepseek-sister', conversationId: 'private-sister', status: 'thinking' }] }, [message(1), pendingReply()]);
  await mount(f.api); const textarea = await fill('textarea[aria-label="输入消息"]', '你好，今天看海吗？');
  expect(textarea.disabled).toBe(false);
  await act(() => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }));
  });
  expect(f.request.mock.calls.some(([input]) => input.type === 'message.send')).toBe(false);
  await act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', conversationId: 'private-sister', content: '你好，今天看海吗？' }));
  expect(f.request.mock.calls.some(([input]) => input.type === 'action.run')).toBe(false);
  expect(textarea.value).toBe(''); await click('取消这条回复');
  expect(f.request).toHaveBeenCalledWith({ type: 'reply.cancel', conversationId: 'private-sister', workId: 'work-one' });
});

it('retains a failed message draft, shows the real error, and offers retry for a failed model reply', async () => {
  const failed = message(3, '服务暂时不可用', { kind: 'notice', authorId: 'system', status: 'failed' });
  const f = fixture({}, [message(1), failed]); const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'message.send' ? Promise.resolve({ ok: false, error: '网络连接中断，请稍后重试' }) : original(input));
  await mount(f.api); await fill('textarea[aria-label="输入消息"]', '不要丢掉这句话'); await click('发送');
  expect(container!.querySelector('[role="alert"]')!.textContent).toContain('网络连接中断');
  expect(container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!.value).toBe('不要丢掉这句话');
  await click('重试回复'); expect(f.request).toHaveBeenCalledWith({ type: 'reply.retry', conversationId: 'private-sister' });
});

it('coalesces a double send and keeps text entered during the pending acknowledgement', async () => {
  const f = fixture(); await mount(f.api); const original = f.request.getMockImplementation()!;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.request.mockImplementation(async input => { if (input.type === 'message.send') await pending; return original(input); });
  await fill('textarea[aria-label="输入消息"]', '第一句话');
  await act(() => { button('发送').click(); button('发送').click(); });
  expect(f.request.mock.calls.filter(([input]) => input.type === 'message.send')).toHaveLength(1);
  const textarea = await fill('textarea[aria-label="输入消息"]', '等待时想到的另一句话'); expect(textarea.disabled).toBe(false);
  await act(() => finish());
  expect(textarea.value).toBe('等待时想到的另一句话');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('第一句话');
});

it('sends a referenced message and previews its saved image inside the chat before revealing the file', async () => {
  const f = fixture(); await mount(f.api); await click('引用消息 2'); await click('发送文件或图片'); await click('发送');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', replyToId: 'message-2', attachmentIds: ['photo'], content: '' }));
  expect(container!.querySelector('[aria-label="取消引用"]')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>('.companions-attachment')!.click());
  expect(container!.querySelector('[role="dialog"][aria-label="图片预览：旅行照片.jpg"]')).not.toBeNull();
  expect(f.request.mock.calls.some(([input]) => input.type === 'attachment.open')).toBe(false);
  await click('查看文件位置');
  expect(f.request).toHaveBeenCalledWith({ type: 'attachment.open', id: 'photo' });
  await click('关闭图片预览'); expect(container!.querySelector('.companions-image-preview')).toBeNull();
});

it('preserves a scrolled history position on new messages and preserves the anchor when older messages load', async () => {
  const history = Array.from({ length: 65 }, (_, index) => message(index + 1)); const f = fixture({}, history); await mount(f.api);
  const scroll = container!.querySelector<HTMLDivElement>('[data-companion-messages]')!;
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  await act(() => { scroll.scrollTop = 200; scroll.dispatchEvent(new Event('scroll')); });
  await f.publish({}, [...history, message(66, '刚想到一件事。')]);
  expect(scroll.scrollTop).toBe(200); expect(container!.textContent).toContain('有新消息');
  expect(scroll.textContent).toContain('刚想到一件事。');
  await click('查看更早的消息'); expect(f.request).toHaveBeenCalledWith({ type: 'messages', conversationId: 'private-sister', topicId: null, before: 16, limit: 50 });
  expect(scroll.textContent).toContain('第 1 条消息'); expect(scroll.scrollTop).toBe(200);
  await click('回到最新消息'); expect(scroll.scrollTop).toBe(1000);
});

it('evicts messages during 80 consecutive history pages and returns directly to the newest page', async () => {
  const history = Array.from({ length: 5000 }, (_, index) => message(index + 1));
  const f = fixture({}, history); await mount(f.api);
  const scroll = container!.querySelector<HTMLDivElement>('[data-companion-messages]')!;
  for (let page = 0; page < 80; page++) {
    await click('查看更早的消息');
    expect(Number(scroll.dataset.windowCount)).toBeLessThanOrEqual(200);
    expect(scroll.querySelectorAll('[data-companion-message]').length).toBeLessThanOrEqual(200);
  }
  expect(scroll.textContent).not.toContain('第 5000 条消息');
  expect(container!.querySelector('[aria-label="回到最新消息"]')).not.toBeNull();
  await click('回到最新消息');
  expect(Number(scroll.dataset.windowCount)).toBe(50); expect(scroll.textContent).toContain('第 5000 条消息');
  expect(container!.querySelector('.companions-history-chip')).toBeNull();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'messages')).toHaveLength(82);
});

it('uses the messages plus button to choose a chat and reserves contact creation for the contacts tab', async () => {
  const f = fixture({ conversations: [] }, []); await mount(f.api);
  expect(container!.querySelector('[aria-label="添加联系人"]')).toBeNull();
  await click('发起聊天'); expect(container!.querySelector('[role="dialog"][aria-label="发起聊天"]')).not.toBeNull();
  const chooser = container!.querySelector('[role="dialog"]')!;
  const role = [...chooser.querySelectorAll<HTMLButtonElement>('.companions-start-chat-list button')].find(item => item.textContent?.includes('GPT'))!;
  await act(() => role.click()); expect(f.request).toHaveBeenCalledWith({ type: 'conversation.open', companionId: 'gpt' });
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.create')).toBe(false);
  await click('联系人'); await click('添加联系人'); expect(container!.querySelector('[role="dialog"][aria-label="添加联系人"]')).not.toBeNull();
});

it('fetches an older capability detail on demand instead of loading every historical task into the timeline', async () => {
  const action: CompanionAction = { id: 'old-action', conversationId: 'private-sister', companionId: 'deepseek-sister', sourceMessageId: 'message-1',
    title: '原来的文件处理', status: 'succeeded', createdAt: date, updatedAt: date, result: '原始能力结果已保留' };
  const f = fixture({}, [message(1, '旧任务正文', { segments: [{ text: '旧任务正文', actionIds: [action.id] }] })]);
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'action.get' ? Promise.resolve({ ok: true, action }) : original(input));
  await mount(f.api); expect(f.request.mock.calls.some(([input]) => input.type === 'action.get')).toBe(false);
  await click('查看这次能力调用'); expect(f.request).toHaveBeenCalledWith({ type: 'action.get', id: action.id });
  expect(container!.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('全部记录');
  expect(container!.textContent).toContain('原来的文件处理'); expect(container!.textContent).toContain('原始能力结果已保留');
  await f.publish(); expect(container!.textContent).toContain('原来的文件处理');
});

it('opens the exact parallel capability from a lightweight message entry and keeps logs out of the bubble', async () => {
  const first: CompanionAction = { id: 'weather-task', conversationId: 'private-sister', companionId: 'deepseek-sister', sourceMessageId: 'message-1', title: '查询上海天气', status: 'running', createdAt: date, updatedAt: date };
  const second: CompanionAction = { ...first, id: 'clock-task', title: '读取系统时间', events: [{ sequence: 0, type: 'tool_start', summary: '开始读取时间', content: 'CLOCK TOOL STREAM', contentKind: 'output', receivedAt: date }] };
  const f = fixture({}, [message(1, '我看看。', { segments: [{ text: '我看看。', actionIds: [first.id, second.id] }] })]);
  await mount(f.api); await f.publishActions([first, second]);
  const bubble = container!.querySelector('.companions-message-bubble')!;
  expect(bubble.querySelectorAll('.companions-capability-link')).toHaveLength(2);
  expect(bubble.querySelector('.companions-action-card')).toBeNull();
  expect(bubble.querySelector('details')).toBeNull();
  expect(bubble.textContent).not.toContain('CLOCK TOOL STREAM');
  await click('查看任务进度 读取系统时间');
  const monitor = container!.querySelector('[role="dialog"][aria-label="伙伴实时任务"]')!;
  expect(monitor.querySelector<HTMLSelectElement>('#companion-task-owner')!.value).toBe('deepseek-sister');
  expect(monitor.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('当前工作');
  expect(monitor.querySelector('main')!.textContent).toContain('CLOCK TOOL STREAM');
  expect(monitor.querySelector('main')!.textContent).toContain('读取系统时间');
  await click('关闭任务监视'); expect(bubble.textContent).not.toContain('CLOCK TOOL STREAM');
});

it('keeps incoming messages unread while viewing history and clears them when returning to the latest page', async () => {
  const f = fixture({}, Array.from({ length: 80 }, (_, index) => message(index + 1))); await mount(f.api);
  await click('查看更早的消息'); f.request.mockClear();
  await f.publish({ conversations: [{ ...conversation('private-sister', 'private', ['deepseek-sister'], true), unread: 1 }, conversation('group-home', 'group', ['deepseek-sister', 'deepseek-flash'])] });
  expect(f.request.mock.calls.some(([input]) => input.type === 'conversation.read')).toBe(false);
  await click('回到最新消息'); expect(f.request).toHaveBeenCalledWith({ type: 'conversation.read', id: 'private-sister' });
});

it('shows offline avatar presence in the header and contact list and moves notices into the header status panel', async () => {
  const f = fixture({ configured: false }); const settings = await mount(f.api);
  expect(container!.querySelector('.companions-config-hint')).toBeNull();
  expect(container!.querySelector('.companions-history-banner')).toBeNull();
  expect(container!.querySelector('[data-presence-trigger] .companion-avatar-presence')!.getAttribute('data-status')).toBe('offline');
  expect(container!.querySelector('.companions-presence-label')!.textContent).toBe('离线');
  await click('查看伙伴状态'); expect(container!.querySelector('[role="dialog"][aria-label="伙伴状态"]')).not.toBeNull();
  await click('全局模型设置'); expect(settings).toHaveBeenCalledOnce();
  await click('联系人');
  expect(container!.querySelector('[data-companion-contact="gpt"] .companion-avatar-presence')!.getAttribute('data-status')).toBe('offline');
});

it('keeps each group member presence distinct and updates the open status panel with live work and queue counts', async () => {
  const f = fixture({ companions: sisters.map(role => role.id === 'deepseek-sister' ? { ...role, availability: 'working', activeCount: 2, queuedCount: 1 } : role.id === 'deepseek-flash' ? { ...role, availability: 'waiting', queuedCount: 3 } : role) });
  await mount(f.api);
  await act(() => container!.querySelector<HTMLButtonElement>('[data-companion-conversation="group-home"]')!.click());
  await click('查看伙伴状态');
  const panel = container!.querySelector('[aria-label="伙伴状态"]')!;
  expect(panel.querySelector('[data-presence-role="deepseek-sister"]')!.textContent).toContain('2 条回复正在进行 · 1 条等待中');
  expect(panel.querySelector('[data-presence-role="deepseek-flash"]')!.textContent).toContain('3 条消息等待空闲位置');
  await f.publish({ companions: sisters.map(role => role.id === 'deepseek-sister' ? { ...role, availability: 'offline', availabilityReason: '模型认证失败' } : { ...role, availability: 'ready' }) });
  expect(panel.querySelector('[data-presence-role="deepseek-sister"] .companion-avatar-presence')!.getAttribute('data-status')).toBe('offline');
  expect(panel.querySelector('[data-presence-role="deepseek-flash"] .companion-avatar-presence')!.getAttribute('data-status')).toBe('ready');
  expect(container!.querySelector('.companions-chat-header')!.textContent).toContain('1 位离线');
  await act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container!.querySelector('[aria-label="伙伴状态"]')).toBeNull();
});

it('uses readable status badges consistently across contacts, profile and chat, with activation overriding stale work', async () => {
  const statuses = ['ready', 'working', 'waiting', 'dormant', 'offline'] as const;
  const roles = sisters.map((role, index) => ({ ...role, active: index !== 3, availability: index === 3 ? 'working' as const : statuses[index] ?? 'ready',
    ...(index === 1 ? { activeCount: 2 } : {}), ...(index === 4 ? { availabilityReason: '模型服务暂时未连接' } : {}) }));
  const f = fixture({ companions: roles }); await mount(f.api);
  expect(container!.querySelector('.companions-chat-header .companion-status-badge')?.getAttribute('data-status')).toBe('ready');
  await click('联系人');
  for (const [index, status] of statuses.entries()) {
    const row = container!.querySelector(`[data-companion-contact="${roles[index]!.id}"]`)!;
    const badge = row.querySelector('.companion-status-badge')!;
    expect(badge.getAttribute('data-status')).toBe(status);
    expect(badge.textContent).toContain(['就绪', '工作中 · 2', '等待中', '休眠', '离线'][index]);
    expect(badge.querySelector('i')?.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('.companion-avatar-presence')?.getAttribute('data-status')).toBe(status);
  }
  await act(() => container!.querySelector<HTMLButtonElement>(`[data-companion-contact="${roles[3]!.id}"]`)!.click());
  expect(container!.querySelector('.companions-profile-heading .companion-status-badge')?.getAttribute('data-status')).toBe('dormant');
  await f.publish({ companions: roles.map((role, index) => index === 3 ? { ...role, active: true, availability: 'ready' } : role) });
  expect(container!.querySelector('.companions-profile-heading .companion-status-badge')?.textContent).toBe('就绪');
  expect(container!.querySelector(`[data-companion-contact="${roles[3]!.id}"] .companion-status-badge`)?.getAttribute('data-status')).toBe('ready');
});

it('keeps a queued loop in its existing bubble and reserves the queue dock for an old item without a reply identity', async () => {
  const room = 'group-home', source = message(1, '正在处理的消息', { conversationId: room }), later = message(3, '随后的一条消息', { conversationId: room });
  const draft = (sequence: number, phase: 'thinking' | 'queued', sourceMessageId: string, workId: string) => message(sequence, '', {
    conversationId: room, authorId: 'deepseek-sister', replyToId: sourceMessageId, isReplyDraft: true, segments: [],
    replyProgress: { workId, sourceMessageId, phase, revision: 1, detail: '实际循环状态', startedAt: date, updatedAt: date } });
  const queue = [
    { id: 'working', conversationId: room, companionId: 'deepseek-sister', sourceMessageId: source.id, messageId: 'message-2', status: 'running' as const, proactive: false, createdAt: date, updatedAt: date },
    { id: 'queued', conversationId: room, companionId: 'deepseek-sister', sourceMessageId: later.id, messageId: 'message-4', status: 'queued' as const, proactive: false, createdAt: date, updatedAt: date },
  ];
  const f = fixture({ queue: [...queue, { ...queue[1]!, id: 'legacy', sourceMessageId: 'legacy-source', messageId: undefined }] }, [source, draft(2, 'thinking', source.id, 'working'), later, draft(4, 'queued', later.id, 'queued')]);
  await mount(f.api); await act(() => container!.querySelector<HTMLButtonElement>('[data-companion-conversation="group-home"]')!.click());
  expect(container!.querySelectorAll('.companions-queue-row')).toHaveLength(1);
  const bubble = container!.querySelector('[data-companion-message="message-4"]')!;
  expect(bubble.querySelector('[data-reply-stage="queued"]')).not.toBeNull();
  await click('立即引导', bubble);
  expect(f.request).toHaveBeenCalledWith({ type: 'message.guide', id: later.id, targetSourceMessageId: source.id });
  await f.publish({ queue });
  expect(container!.querySelector('.companions-queue-dock')).toBeNull();
  expect(container!.querySelector('[data-companion-message="message-4"]')).toBe(bubble);
});

it('finds an older message and explicitly returns to the latest history without mixing a gap into the timeline', async () => {
  const history = Array.from({ length: 65 }, (_, index) => message(index + 1, index === 2 ? '第一次一起去海边' : `日常 ${index + 1}`));
  const f = fixture({}, history); await mount(f.api); await click('搜索聊天记录');
  await fill('input[aria-label="搜索聊天内容"]', '海边'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
  await act(() => container!.querySelector<HTMLButtonElement>('.companions-history-hit')!.click());
  expect(f.request).toHaveBeenCalledWith({ type: 'messages', conversationId: 'private-sister', around: 'message-3', limit: 50 });
  expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('第一次一起去海边');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).not.toContain('日常 65');
  await f.publish({}, [...history, message(66, '最新的消息')]);
  expect(container!.querySelector('[data-companion-messages]')!.textContent).not.toContain('最新的消息');
  await click('回到最新消息'); expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('最新的消息');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).not.toContain('第一次一起去海边');
});

it('adds a custom contact with the complete global connection inherited by default', async () => {
  const f = fixture(); await mount(f.api); await click('联系人'); await click('添加联系人'); await click('自定义角色');
  await fill('[role="dialog"] input', '阿蓝'); await fill('[role="dialog"] textarea', '喜欢海风，也会有自己的看法。');
  expect(container!.querySelector('[role="dialog"] input[aria-label="模型"]')).toBeNull();
  await submitDialog();
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.create', companion: { name: '阿蓝', description: '', persona: '喜欢海风，也会有自己的看法。', model: '', avatar: 'custom', proactive: true, inputMode: 'steer' } });
  await click('联系人'); expect(container!.querySelector('[data-companion-contact="new-companion"]')).not.toBeNull();
});

it('shows a readable biography with the full editable role setting collapsed by default', async () => {
  const f = fixture(); await mount(f.api); await click('联系人');
  const introduction = container!.querySelector('.companions-introduction')!;
  expect(introduction.textContent).toContain('温柔沉稳'); expect(introduction.textContent).toContain('白米饭');
  expect(introduction.textContent).not.toContain('工具凭据');
  const details = container!.querySelector<HTMLDetailsElement>('.companions-persona-details')!;
  expect(details.open).toBe(false); expect(details.querySelector('summary')!.textContent).toBe('查看角色设定');
  await click('编辑资料'); expect(container!.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe(sisters[0]!.persona);
});

it('uses a custom contact description as its biography and keeps instructions inside a collapsed setting', async () => {
  const custom: Companion = { ...sisters[0]!, builtin: false, description: '一起把生活中的小事记下来', persona: '内部角色设定测试文本' };
  const f = fixture({ companions: [custom, sisters[1]!] }); await mount(f.api); await click('联系人');
  expect(container!.querySelector('.companions-introduction')!.textContent).toBe('一起把生活中的小事记下来');
  expect(container!.querySelector<HTMLDetailsElement>('.companions-persona-details')!.open).toBe(false);
});

it('selects a local image avatar, preserves it when contact settings change, and restores the name avatar', async () => {
  const f = fixture(); await mount(f.api); await click('联系人'); await click('添加联系人'); await click('自定义角色');
  await fill('[role="dialog"] input', '海盐'); await fill('[role="dialog"] textarea', '喜欢记录生活中的小事。');
  await click('选择本地头像');
  const source = document.querySelector<HTMLImageElement>('[alt="待调整的头像原图"]')!; Object.defineProperties(source, { naturalWidth: { value: 1200 }, naturalHeight: { value: 800 } }); await act(() => source.dispatchEvent(new Event('load'))); await act(() => document.querySelector<HTMLButtonElement>('.avatar-crop-dialog .companion-primary-button')!.click());
  expect(container!.querySelector<HTMLElement>('.companions-avatar-editor .companion-avatar')!.style.backgroundImage).toContain('worldlinebox-companion://attachment/cropped-photo');
  await submitDialog();
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.create', companion: expect.objectContaining({ avatar: 'custom', avatarAttachmentId: 'cropped-photo' }) }));
  await click('联系人'); await act(() => container!.querySelector<HTMLButtonElement>('[data-companion-contact="new-companion"]')!.click());
  expect(container!.querySelector<HTMLElement>('.companions-profile-heading .companion-avatar')!.style.backgroundImage).toContain('worldlinebox-companion://attachment/cropped-photo');
  await act(() => container!.querySelector<HTMLInputElement>('.companions-contact-profile input[type="checkbox"]')!.click());
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.update').at(-1)![0]).toEqual(expect.objectContaining({ companion: expect.objectContaining({ proactive: false, avatarAttachmentId: 'cropped-photo' }) }));
  await click('编辑资料'); await click('恢复名字头像');
  const restored = container!.querySelector<HTMLElement>('.companions-avatar-editor .companion-avatar')!;
  expect(restored.style.backgroundImage).toBe(''); expect(restored.textContent).toBe('海');
  await submitDialog();
  expect(f.state().companions.find(item => item.id === 'new-companion')!.avatarAttachmentId).toBeUndefined();
});

it('rejects a non-image avatar without clearing the previously selected image', async () => {
  const custom: Companion = { ...sisters[0]!, builtin: false, avatar: 'custom', avatarAttachmentId: 'saved-avatar' };
  const f = fixture({ companions: [custom, sisters[1]!] }); const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'attachment.pick' ? Promise.resolve({ ok: true, attachments: [{ id: 'not-image', name: 'notes.txt', mime: 'text/plain', size: 120 }] }) : original(input));
  await mount(f.api); await click('联系人'); await click('编辑资料'); await click('选择本地头像');
  expect(container!.querySelector('[role="dialog"] [role="alert"]')!.textContent).toBe('请选择图片文件作为头像。');
  expect(container!.querySelector<HTMLElement>('.companions-avatar-editor .companion-avatar')!.style.backgroundImage).toContain('worldlinebox-companion://attachment/saved-avatar');
});
it('keeps public appearance references and the loaded revision across contact shortcuts, cancelled edits and explicit removal', async () => {
  const contact = { ...sisters[0]!, appearanceAttachmentId: 'saved-board', revision: 3 };
  const f = fixture({ companions: [contact, sisters[1]!] }); await mount(f.api); await click('联系人');
  expect(container!.querySelector<HTMLImageElement>('.public-appearance-thumbnail img')!.src).toContain('/saved-board');
  await act(() => container!.querySelector<HTMLInputElement>('.companions-contact-profile input[type="checkbox"]')!.click());
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.update', expectedRevision: 3, companion: expect.objectContaining({ appearanceAttachmentId: 'saved-board' }) }));
  await click('编辑资料'); await click('更换三视图', container!.querySelector('[role="dialog"]')!);
  expect(f.request).toHaveBeenCalledWith({ type: 'attachment.pick', kind: 'image', purpose: 'appearance' });
  await click('取消', container!.querySelector('[role="dialog"]')!);
  expect(f.state().companions[0]!.appearanceAttachmentId).toBe('saved-board');
  await click('编辑资料'); await click('恢复内置三视图', container!.querySelector('[role="dialog"]')!); await submitDialog();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.update').at(-1)![0]).toMatchObject({ expectedRevision: 3, companion: { appearanceAttachmentId: undefined } });
  expect(f.state().companions[0]!.appearanceAttachmentId).toBeUndefined();
});
it('shows the public player nickname and avatar while keeping the user message submission identity unchanged', async () => {
  const playerProfile = { id: 'user' as const, name: '林澈', description: '喜欢画画', avatarAttachmentId: 'player-avatar', revision: 1, contentHash: 'a'.repeat(64), updatedAt: date };
  const f = fixture({ playerProfile }); await mount(f.api);
  const own = container!.querySelector('.companions-message.is-own')!;
  expect(own.querySelector('.companions-message-author')!.textContent).toContain('林澈');
  expect(own.querySelector<HTMLElement>('.companion-avatar')!.style.backgroundImage).toContain('/player-avatar');
  await fill('[aria-label="输入消息"]', '今天一起看海吧。'); await click('发送');
  const sent = f.request.mock.calls.find(([input]) => input.type === 'message.send')![0];
  expect(sent).toMatchObject({ type: 'message.send', conversationId: 'private-sister', content: '今天一起看海吧。' }); expect(sent).not.toHaveProperty('authorId');
  await f.publish({ playerProfile: { ...playerProfile, name: '小林', revision: 2 } });
  expect(container!.querySelector('.companions-message.is-own .companions-message-author')!.textContent).toContain('小林');
});

it('offers built-in and custom contacts and opens an existing built-in instead of duplicating it', async () => {
  const f = fixture(); await mount(f.api); await click('联系人'); await click('添加联系人');
  expect(container!.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('内置角色');
  const card = [...container!.querySelectorAll<HTMLElement>('.companions-builtin-card')].find(item => item.textContent?.includes('大肥鱼'))!;
  await click('已添加 · 打开', card);
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.open', companionId: 'deepseek-sister' });
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.add-builtin')).toBe(false);
});

it('configures an independent service without revealing a saved key and retains its connection when proactive is toggled', async () => {
  const independent = { ...sisters[0]!, llm: { apiFormat: 'anthropic' as const, baseUrl: 'https://example.test', model: 'test-model', hasKey: true } };
  const f = fixture({ configured: false, companions: [independent, sisters[1]!] }); await mount(f.api);
  expect(container!.querySelector('.companions-config-hint')).toBeNull();
  await click('联系人'); await click('编辑资料');
  const key = container!.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!;
  expect(key.type).toBe('password'); expect(key.value).toBe(''); expect(key.placeholder).toBe('已保存，留空保留');
  await select('select[aria-label="连接方式"]', 'openai_responses');
  await fill('input[aria-label="模型"]', 'another-model'); await submitDialog();
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.update', companion: expect.objectContaining({ model: '', llm: { apiFormat: 'openai_responses', baseUrl: 'https://example.test', model: 'another-model' } }) }));
  const update = f.request.mock.calls.find(([input]) => input.type === 'companion.update')![0]; expect('apiKey' in update).toBe(false);
  const proactive = container!.querySelector<HTMLInputElement>('.companions-contact-profile input[type="checkbox"]')!;
  await act(() => proactive.click());
  expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'state' }));
  const updateCalls = f.request.mock.calls.filter(([input]) => input.type === 'companion.update');
  expect(updateCalls.at(-1)![0]).toEqual(expect.objectContaining({ companion: expect.objectContaining({ proactive: false, llm: { apiFormat: 'openai_responses', baseUrl: 'https://example.test', model: 'another-model' } }) }));
});

it('creates a group and manages its name and membership in the same conversation', async () => {
  const f = fixture(); await mount(f.api); await click('创建群聊');
  await fill('[role="dialog"] input:not([type="checkbox"])', '摸鱼小组');
  await act(() => container!.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')[0]!.click());
  await submitDialog();
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.create-group', title: '摸鱼小组', memberIds: ['deepseek-sister'] });
  await click('管理群聊'); await fill('[role="dialog"] input:not([type="checkbox"])', '一起看海'); await submitDialog();
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.update', id: 'new-group', title: '一起看海', memberIds: ['deepseek-sister'] });
  expect(container!.querySelector('.companions-chat-header h2')!.textContent).toContain('一起看海');
});

it('saves and corrects sourced memory without a second manual capability dispatch entry', async () => {
  vi.useFakeTimers(); const f = fixture(); let saved: CompanionMemoryDocumentRead | undefined;
  const source = message(1, '帮我整理照片');
  const workspace = vi.fn(async (input: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse> => {
    if (input.type === 'status') return { ok: true, selected: { libraryId: 'fixture-library', displayName: '伙伴资产库', libraryPath: 'D:/fixture', dataRoot: 'D:/fixture/.companions', memoryRoot: 'D:/fixture/伙伴记忆' } };
    if (input.type === 'memory.documents.list') return { ok: true, documents: { companionId: input.companionId, directory: input.directory, folders: [{ path: '日记', name: '日记', count: saved ? 1 : 0 }], items: saved ? [saved.document] : [], hasMore: false } };
    if (input.type === 'memory.documents.read') return { ok: true, document: saved };
    if (input.type === 'memory.documents.create') {
      const memory: CompanionMemory = { id: 'memory-a', companionId: input.companionId, scopeId: 'fixture-scope', content: input.content, diaryName: input.diaryName, sourceMessageId: input.sourceMessageId,
        sourceConversationId: source.conversationId, sourceSequence: source.sequence, sources: [{ sourceType: 'message', messageId: source.id, conversationId: source.conversationId, sequence: source.sequence, authorId: source.authorId, revision: 1, checksum: 'fixture-source-checksum', createdAt: source.createdAt }],
        tags: input.tags, status: 'queued', captureMethod: 'manual', version: 1, origin: 'user', createdAt: date, updatedAt: date };
      saved = { document: { path: input.path, name: '聊天摘记.md', title: '聊天摘记', directory: '日记', kind: 'note', category: 'diary', updatedAt: date, bytes: 100, revision: 'fixture-document-1', contentHash: 'a'.repeat(64), readOnly: false, tags: input.tags, syncState: 'pending', noteId: memory.id, version: 1, sourceCount: 1 }, content: input.content, memory, sources: [source], hasMoreSources: false };
      return { ok: true, document: saved };
    }
    if (input.type === 'memory.documents.save' && saved) {
      if (input.expectedRevision !== saved.document.revision) return { ok: false, error: '版本已变化。' };
      saved = { ...saved, content: input.content, document: { ...saved.document, revision: 'fixture-document-2', version: 2 }, memory: saved.memory ? { ...saved.memory, content: input.content, version: 2 } : undefined }; return { ok: true, document: saved };
    }
    return { ok: true };
  });
  await mount({ ...f.api, workspace }); await click('记住消息 1'); await fill('textarea[aria-label="共同记忆内容"]', '喜欢把照片按旅行地点整理'); await click('保存文档');
  expect(workspace).toHaveBeenCalledWith({ type: 'memory.documents.create', companionId: 'deepseek-sister', path: '日记/聊天摘记.md', content: '喜欢把照片按旅行地点整理', sourceMessageId: 'message-1', tags: [], diaryName: '日记' });
  const created = (await workspace({ type: 'memory.documents.read', companionId: 'deepseek-sister', path: '日记/聊天摘记.md', sourceLimit: 30 })).document!;
  expect(created.memory?.sources[0]).toMatchObject({ sourceType: 'message', messageId: source.id });
  await click('编辑记忆 memory-a'); await fill('textarea[aria-label="共同记忆内容"]', '这次照片按地点整理'); await click('保存修正');
  expect(workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.save', path: '日记/聊天摘记.md', expectedRevision: 'fixture-document-1', content: '这次照片按地点整理' }));
  const corrected = (await workspace({ type: 'memory.documents.read', companionId: 'deepseek-sister', path: '日记/聊天摘记.md', sourceLimit: 30 })).document!;
  expect(corrected.memory?.content).toBe('这次照片按地点整理'); expect(corrected.memory?.sources[0]?.messageId).toBe(source.id);
  await click('关闭共同记忆管理'); await click('我们之间'); await click('管理共同记忆');
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(container!.querySelector('textarea[aria-label="共同记忆内容"]')).toBeNull();
  expect(container!.querySelector('.memory-library-paper')?.textContent).toContain('这次照片按地点整理');
  expect(container!.querySelector('[title="交给伙伴处理"]')).toBeNull();
  expect(f.request.mock.calls.some(([input]) => input.type === 'memory.save')).toBe(false);
  expect(f.request.mock.calls.some(([input]) => input.type === 'action.run')).toBe(false);
});

it('does not render a second ability bubble for a durable memory-only action result', async () => {
  const f = fixture({}, [message(1, '帮我整理文件'), message(2, '文件整理完成。'), message(3, '{"title":"整理文件","result":"内部证据正文"}', { kind: 'action', authorId: 'deepseek-sister', memoryEvidenceOnly: true, actionId: 'done-action' })]);
  await mount(f.api);
  expect(container!.textContent).toContain('文件整理完成。');
  expect(container!.textContent).not.toContain('内部证据正文');
  expect(container!.querySelector('[data-companion-message="message-3"]')).toBeNull();
});

it('updates a reply bubble directly from real stream frames without reloading the page data or duplicating committed turns', async () => {
  const source = message(1, '流式聊天');
  const reply = message(2, '前一步。', { replyToId: source.id, isReplyDraft: true, segments: [{ text: '前一步。', actionIds: [] }] });
  const f = fixture({}, [source, reply]); await mount(f.api); f.request.mockClear();
  const frame: CompanionReplyStreamEvent = { conversationId: reply.conversationId, companionId: reply.authorId, sourceMessageId: source.id, messageId: reply.id, step: 1, attemptId: 'attempt-a', text: '第一段真实增量', phase: 'streaming' };
  await f.stream(frame);
  const bubble = container!.querySelector('[data-companion-message="message-2"] .companions-message-bubble')!;
  expect(bubble.textContent).toContain('第一段真实增量'); expect(bubble.getAttribute('aria-busy')).toBe('true');
  expect(bubble.querySelector('[aria-label="伙伴正在输出"]')).not.toBeNull();
  await f.stream({ ...frame, text: '第一段真实增量，第二段接着来。' });
  expect(f.request).not.toHaveBeenCalled();
  await f.stream({ ...frame, text: '第一段真实增量，第二段接着来。', phase: 'committed' });
  expect(bubble.querySelector('[aria-label="伙伴正在输出"]')).toBeNull();
  await f.publish({}, [source, { ...reply, content: '前一步。\n\n第一段真实增量，第二段接着来。', isReplyDraft: undefined, segments: [...reply.segments!, { text: '第一段真实增量，第二段接着来。', actionIds: [] }] }]);
  expect(bubble.textContent!.match(/第一段真实增量/gu)).toHaveLength(1);
  await f.stream({ ...frame, text: '旧尝试迟到内容' }); expect(bubble.textContent).not.toContain('旧尝试迟到');
});

it('keeps interrupted stream text, replaces it on retry and preserves a reader scroll position', async () => {
  const source = message(1, '流式聊天');
  const reply = message(2, '', { replyToId: source.id, isReplyDraft: true, segments: [] });
  const f = fixture({}, [source, reply]); await mount(f.api);
  const scroll = container!.querySelector<HTMLElement>('[data-companion-messages]')!;
  Object.defineProperties(scroll, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } });
  await act(() => { scroll.scrollTop = 300; scroll.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const frame: CompanionReplyStreamEvent = { conversationId: reply.conversationId, companionId: reply.authorId, sourceMessageId: source.id, messageId: reply.id, step: 0, attemptId: 'attempt-a', text: '暂时说到这里', phase: 'streaming' };
  await f.stream(frame); expect(scroll.scrollTop).toBe(300);
  await f.stream({ ...frame, phase: 'interrupted' }); expect(container!.textContent).toContain('回复已中断'); expect(container!.textContent).toContain('暂时说到这里');
  await f.stream({ ...frame, phase: 'discarded' }); expect(container!.textContent).not.toContain('暂时说到这里');
  await f.stream({ ...frame, attemptId: 'attempt-b', text: '重新回答' });
  expect(container!.textContent).toContain('重新回答'); expect(container!.textContent).not.toContain('回复已中断'); expect(scroll.scrollTop).toBe(300);
});

it('resolves a reference outside the loaded page and jumps to its original history', async () => {
  const history = Array.from({ length: 65 }, (_, index) => message(index + 1));
  const quote = message(66, '接着聊这件事。', { replyToId: 'message-1' }); const f = fixture({}, [...history, quote]);
  await mount(f.api); expect(button('查看引用消息 message-1').disabled).toBe(false);
  await click('查看引用消息 message-1');
  expect(f.request).toHaveBeenCalledWith({ type: 'message.get', id: 'message-1' });
  expect(f.request).toHaveBeenCalledWith({ type: 'messages', conversationId: 'private-sister', around: 'message-1', limit: 50 });
  expect(container!.querySelector('[data-companion-message="message-1"]')!.classList.contains('is-highlighted')).toBe(true);
  expect(container!.querySelector('.companions-history-chip')).not.toBeNull();
});

it('shows scheduled reminder content without quoting hidden form evidence into the conversation', async () => {
  const hidden = message(1, '安排提醒：喝水。首次时间：内部记录。', { memoryEvidenceOnly: true });
  const f = fixture({}, [hidden, message(2, '记得喝一杯温水。', { authorId: 'deepseek-sister', replyToId: hidden.id })]);
  await mount(f.api);
  expect(container!.textContent).toContain('记得喝一杯温水。');
  expect(container!.textContent).not.toContain('内部记录');
  expect(container!.querySelector('[aria-label="查看引用消息 message-1"]')).toBeNull();
});

it('shows actual action steps and elapsed time, hides private thinking, and keeps completion wording tied to returned results', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 5000);
  const action: CompanionAction = { id: 'action-a', conversationId: 'private-sister', companionId: 'deepseek-sister', sourceMessageId: 'message-1', title: '整理照片', status: 'running', stage: '正在调用工具', createdAt: date, updatedAt: date, events: [
    { sequence: 1, type: 'tool_call', toolName: 'read_directory', summary: '读取照片清单', receivedAt: date },
    { sequence: 2, type: 'thinking', summary: '不应显示的私人原始推理', receivedAt: date },
    { sequence: 3, type: 'tool_result', toolName: 'read_directory', summary: '找到三张旅行照片', receivedAt: date },
  ] };
  const f = fixture({}, [message(1), message(2, '', { kind: 'action', actionId: action.id })], [action]); await mount(f.api);
  expect(container!.querySelector('[data-companion-action="action-a"]')).toBeNull();
  await click('查看任务进度 整理照片');
  const card = container!.querySelector('[data-companion-action="action-a"]')!;
  expect(card.textContent).toContain('正在调用工具'); expect(card.textContent).toContain('已用时 5 秒');
  expect(card.querySelector('.companions-action-latest-step')!.textContent).toContain('找到三张旅行照片');
  expect(card.textContent).not.toContain('私人原始推理'); expect(card.textContent).not.toContain('%');
  expect(card.querySelector('.companions-live-progress')).not.toBeNull();
  expect(card.querySelectorAll('.companions-live-output article')).toHaveLength(2);
  await click('停止处理 action-a'); expect(f.request).toHaveBeenCalledWith({ type: 'action.cancel', id: action.id });
  await f.publishActions([{ ...action, status: 'succeeded', stage: 'completed', updatedAt: '2026-10-13T08:00:09.000Z', result: '生成了整理清单。' }]);
  expect(card.textContent).toContain('已返回结果'); expect(card.textContent).toContain('已用时 9 秒');
  expect(card.querySelector('[aria-label="停止处理 action-a"]')).toBeNull();
});

it('tracks real reply elapsed time each second and resumes it accurately after the module is hidden', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T08:00:05.000Z'));
  const f = fixture({ activities: [{ companionId: 'deepseek-sister', conversationId: 'private-sister', status: 'thinking', startedAt: date }] }, [message(1), pendingReply()]);
  const settings = await mount(f.api); expect(container!.querySelector('[aria-label="本条回复进度"]')!.textContent).toContain('正在思考5 秒');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container!.querySelector('[aria-label="本条回复进度"]')!.textContent).toContain('7 秒');
  await act(() => root!.render(<Companions api={f.api} isActive={false} onOpenSettings={settings} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container!.querySelector('[aria-label="本条回复进度"]')!.textContent).toContain('7 秒');
  await act(() => root!.render(<Companions api={f.api} isActive onOpenSettings={settings} />));
  expect(container!.querySelector('[aria-label="本条回复进度"]')!.textContent).toContain('12 秒');
  expect(f.request.mock.calls.some(([input]) => input.type === 'reply.cancel')).toBe(false);
});

it('uses the image-only picker and displays the pending upload name and size', async () => {
  const f = fixture(); await mount(f.api); await click('发送图片');
  expect(f.request).toHaveBeenCalledWith({ type: 'attachment.pick', kind: 'image' });
  expect(container!.querySelector('.companions-draft-attachments')!.textContent).toContain('旅行照片.jpg');
  expect(container!.querySelector('.companions-draft-attachments')!.textContent).toContain('2.0 KB');
});

it('offers global settings when unconfigured, labels a preset greeting, and cleans up its event subscription', async () => {
  const f = fixture({ configured: false }, [message(1, '你来啦。', { kind: 'notice', authorId: 'deepseek-sister' })]);
  const settings = await mount(f.api); expect(container!.textContent).toContain('内置欢迎'); await click('查看伙伴状态'); await click('全局模型设置'); expect(settings).toHaveBeenCalledOnce();
  await act(() => root!.unmount()); root = undefined; expect(f.unsubscribe).toHaveBeenCalledOnce();
});


it('shows real waiting and generation stages before reply text exists and allows cancellation', async () => {
  const f = fixture({ activities: [{ companionId: 'deepseek-sister', conversationId: 'private-sister', sourceMessageId: 'message-1', status: 'waiting', stage: '正在用手机处理先前消息，稍后依次回复', startedAt: date }] }, [message(1), pendingReply('waiting', '正在用手机处理先前消息，稍后依次回复')]);
  await mount(f.api);
  const progress = container!.querySelector('[data-companion-message="message-2"] .companions-bubble-progress')!;
  expect(progress.textContent).toContain('等待回复');
  expect(progress.textContent).toContain('正在用手机处理先前消息');
  expect(progress.getAttribute('data-reply-stage')).toBe('waiting');
  expect(container!.querySelector('.companions-reply-progress')).toBeNull();
  await click('取消这条回复');
  expect(f.api.request).toHaveBeenCalledWith({ type: 'reply.cancel', conversationId: 'private-sister', workId: 'work-one' });
});


it('exposes explicit activation in contacts and preserves dormancy when opening a private conversation', async () => {
  const f = fixture({ companions: sisters.map(role => ({ ...role, active: role.id === 'deepseek-flash' })) });
  await mount(f.api);
  expect(container!.querySelector('.companions-dormant-note')).toBeNull();
  const composer = container!.querySelector('section[aria-label="消息输入区"]')!;
  expect(composer.querySelector('.companions-composer-dormant')!.textContent).toBe('伙伴休眠中激活');
  expect(button('激活大肥鱼').closest('section[aria-label="消息输入区"]')).toBe(composer);
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.set-active')).toBe(false);
  await click('联系人');
  expect(container!.textContent).toContain('虚拟世界未加载');
  await click('激活伙伴');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.set-active', id: 'deepseek-sister', active: true }));
  expect(container!.textContent).toContain('已激活');
  await click('让伙伴休眠');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.set-active', id: 'deepseek-sister', active: false }));
});

it('keeps dormant chat sending available and offers activation beside its compact composer status', async () => {
  const f = fixture({ companions: sisters.map(role => ({ ...role, active: false })) });
  await mount(f.api);
  const input = await fill('textarea[aria-label="输入消息"]', '先给你留条消息。');
  expect(input.disabled).toBe(false); expect(button('发送').disabled).toBe(false);
  await click('发送');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', content: '先给你留条消息。' }));
  expect(f.request.mock.calls.some(([call]) => call.type === 'companion.set-active')).toBe(false);
  await click('激活大肥鱼');
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.set-active', id: 'deepseek-sister', active: true });
  expect(container!.querySelector('.companions-composer-dormant')).toBeNull();
});
