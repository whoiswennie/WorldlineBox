import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Companion, CompanionAction, CompanionAttachment, CompanionConversation, CompanionMemory, CompanionMessage, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { BUILTIN_COMPANIONS } from '../../shared/companion-personas';
import { companionMessagePreview } from '../../shared/companion-titles';
import { Icon } from '../Icons';
import { CompanionDialogs, type CompanionDialog } from './CompanionDialogs';
import { Avatar, ChatGlyph } from './CompanionVisuals';
import { CompanionActionCard, elapsedTime, useCompanionClock } from './CompanionProgress';
import { CompanionImagePreview } from './CompanionImagePreview';
import { MessageContent } from './MessageContent';
import { CompanionModeMenu } from './CompanionModeMenu';
import { CompanionTaskMonitor } from './CompanionTaskMonitor';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import type { CompanionActionEvent } from '../../shared/companions';
import { companionProgressEvent, mergeCompanionProgress } from '../../shared/companion-progress';
import type { WorldlineBoxShellApi } from '../../shared/external-url';
import fullBodyImage from '../../../assets/companions/deepseek.jpg';
import './companions.css';

interface ChatDraft { content: string; attachments: CompanionAttachment[]; reply?: CompanionMessage }
const EMPTY_DRAFT: ChatDraft = { content: '', attachments: [] };
const PAGE_SIZE = 50;
const emojis = ['🐳', '😊', '💙', '✨', '👀', '🥺', '🎉', '☕', '🌙', '👍', '🌸', '😴', '🤔', '😂', '🫶', '🌊'];
const builtinIntroductions: Record<string, string> = {
  'deepseek-sister': '温柔沉稳的鲸鱼姐姐，喜欢安静听歌、看海和白米饭，偶尔也会摸鱼。她擅长陪你慢慢梳理想法，有自己的判断，带一点可爱的小傲娇。答应你的事情，会认真放在心上。',
  'deepseek-flash': '活泼好奇的鲸鱼妹妹，喜欢音乐、探索新鲜事物和分享小发现。她说话轻快，偶尔会和姐姐拌几句嘴，也有一点小傲娇。她愿意陪你聊日常，也尊重你自己的节奏。',
};
function contactIntroduction(companion: Companion) { return (companion.builtin ? builtinIntroductions[companion.id] : undefined) || companion.description || '她还没有写下简介。可以在编辑资料中介绍这位伙伴。'; }
function mergeMessages(current: CompanionMessage[], next: CompanionMessage[]) {
  const byId = new Map(current.map(item => [item.id, item]));
  next.forEach(item => byId.set(item.id, item));
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}
function mergeLiveAction(action: CompanionAction, cache: Map<string, CompanionActionEvent[]>): CompanionAction {
  const live = action.taskId ? cache.get(action.taskId) : undefined;
  if (!live?.length) return action;
  const events = mergeCompanionProgress(action.events ?? [], live);
  return { ...action, events, ...(['running', 'queued'].includes(action.status) ? { stage: events.at(-1)?.summary } : {}) };
}
function clockTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function dayLabel(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}
function shortTime(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString() === new Date().toLocaleDateString() ? clockTime(value) : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function bytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }

export function Companions({ api, dshApi, onOpenSettings, isActive = true }: { readonly api?: WorldlineBoxCompanionsApi; readonly dshApi?: WorldlineBoxDshLauncherApi; readonly onOpenSettings: () => void; readonly isActive?: boolean }): ReactNode {
  const [state, setState] = useState<CompanionState | null>(null);
  const [page, setPage] = useState<'messages' | 'contacts'>('messages');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<'auto' | 'steer' | 'queue' | 'parallel' | 'chat'>('auto');
  const [targetActionId, setTargetActionId] = useState<string | null>(null);
  const [showTaskMonitor, setShowTaskMonitor] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CompanionMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [historyMode, setHistoryMode] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [memoryOwnerId, setMemoryOwnerId] = useState<string | null>(null);
  const [memories, setMemories] = useState<CompanionMemory[]>([]);
  const [actions, setActions] = useState<CompanionAction[]>([]);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memorySource, setMemorySource] = useState<string | undefined>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [composerMore, setComposerMore] = useState(false);
  const [dialog, setDialog] = useState<CompanionDialog | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<CompanionAttachment | null>(null);
  const [referencedMessages, setReferencedMessages] = useState<Record<string, CompanionMessage>>({});
  const [activityStarts, setActivityStarts] = useState<Record<string, string>>({});
  const selectedRef = useRef<string | null>(null);
  const activeRef = useRef(isActive);
  const historyRef = useRef(false);
  const aliveRef = useRef(true);
  const stickyRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const loadEpoch = useRef(0);
  const latestLoadEpoch = useRef(0);
  const actionsEpoch = useRef(0);
  const streamedEvents = useRef(new Map<string, CompanionActionEvent[]>());
  const stateEpoch = useRef(0);
  const searchEpoch = useRef(0);
  const memoryEpoch = useRef(0);
  const memoryOwnerRef = useRef<string | null>(null);
  const readInFlight = useRef<string | null>(null);
  const sendInFlight = useRef(false);
  const latestSequence = useRef(0);
  const loadedConversation = useRef<string | null>(null);

  const request = useCallback(async (input: CompanionsRequest): Promise<CompanionsResponse | undefined> => {
    if (!api) return;
    try {
      const result = await api.request(input);
      if (!aliveRef.current) return;
      if (!result.ok) { setError(result.error || '操作未完成，请重试。'); return; }
      return result;
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
  }, [api]);

  const refreshState = useCallback(async () => {
    const epoch = ++stateEpoch.current;
    const response = await request({ type: 'state' });
    if (!response?.state || epoch !== stateEpoch.current) return;
    const next = response.state;
    const observedAt = new Date().toISOString();
    setActivityStarts(current => Object.fromEntries(next.activities.map(item => {
      const key = `${item.conversationId}/${item.companionId}/${item.status}`;
      return [key, item.startedAt || current[key] || observedAt];
    })));
    setState(next);
    if (!selectedRef.current || !next.conversations.some(item => item.id === selectedRef.current)) {
      const first = [...next.conversations].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))[0];
      ++loadEpoch.current; historyRef.current = false; stickyRef.current = true; latestSequence.current = 0; loadedConversation.current = null;
      setMessages([]); setActions([]); setHasMore(false); setHistoryMode(false); setHighlightedId(null); setMemoryOwnerId(null); setMemories([]);
      selectedRef.current = first?.id ?? null;
      setSelectedId(first?.id ?? null);
    }
  }, [request]);

  const loadMessages = useCallback(async (id: string, refresh = false) => {
    const epoch = refresh ? loadEpoch.current : ++loadEpoch.current;
    const latestEpoch = ++latestLoadEpoch.current;
    const response = await request({ type: 'messages', conversationId: id, limit: PAGE_SIZE });
    if (selectedRef.current !== id || epoch !== loadEpoch.current || latestEpoch !== latestLoadEpoch.current || historyRef.current) return;
    if (!response?.messages) { if (!refresh) setLoadingMessages(false); return; }
    const newest = response.messages.at(-1)?.sequence ?? 0;
    if (refresh && !stickyRef.current && newest > latestSequence.current) setNewMessages(true);
    latestSequence.current = Math.max(latestSequence.current, newest);
    setMessages(current => refresh ? mergeMessages(current, response.messages!) : response.messages!);
    if (!refresh || loadedConversation.current !== id) setHasMore(response.hasMore ?? false);
    loadedConversation.current = id; setLoadingMessages(false);
  }, [request]);

  const loadActions = useCallback(async (id: string) => {
    const epoch = ++actionsEpoch.current;
    const response = await request({ type: 'actions', conversationId: id });
    if (selectedRef.current === id && epoch === actionsEpoch.current && response?.actions) setActions(response.actions.map(action => mergeLiveAction(action, streamedEvents.current)));
  }, [request]);

  const loadMemories = useCallback(async (id: string) => {
    const epoch = ++memoryEpoch.current;
    const response = await request({ type: 'memory.list', companionId: id });
    if (epoch === memoryEpoch.current && memoryOwnerRef.current === id && response?.memories) setMemories(response.memories);
  }, [request]);

  const markRead = useCallback(async (id: string) => {
    if (!activeRef.current || readInFlight.current === id) return;
    readInFlight.current = id;
    const response = await request({ type: 'conversation.read', id });
    readInFlight.current = null;
    if (response?.ok) setState(current => current ? { ...current, conversations: current.conversations.map(item => item.id === id ? { ...item, unread: 0 } : item) } : current);
  }, [request]);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => { activeRef.current = isActive; }, [isActive]);
  useEffect(() => dshApi?.onTaskEvent?.(event => {
    const visible = companionProgressEvent(event);
    if (!visible) return;
    const cache = streamedEvents.current;
    cache.set(event.taskId, mergeCompanionProgress(cache.get(event.taskId) ?? [], [visible]));
    while (cache.size > 30) cache.delete(cache.keys().next().value!);
    // Apply IPC frames immediately; a delayed SQLite snapshot cannot erase them.
    setActions(current => current.map(action => mergeLiveAction(action, cache)));
  }), [dshApi]);
  useEffect(() => {
    void Promise.resolve().then(refreshState);
    if (!api) return;
    return api.onChanged(() => {
      void refreshState();
      const id = selectedRef.current;
      if (id) { if (!historyRef.current) void loadMessages(id, true); void loadActions(id); }
      const owner = memoryOwnerRef.current;
      if (owner) void loadMemories(owner);
    });
  }, [api, refreshState, loadMessages, loadActions, loadMemories]);
  useEffect(() => { if (selectedId) void Promise.resolve().then(() => { void loadMessages(selectedId); void loadActions(selectedId); }); }, [selectedId, loadMessages, loadActions]);
  const selected = state?.conversations.find(item => item.id === selectedId);
  const companions = state?.companions ?? [];
  const members = companions.filter(item => selected?.memberIds.includes(item.id));
  const primary = members[0];
  const unconfiguredMembers = members.filter(item => item.llm ? !item.llm.hasKey : !state?.configured);
  const selectedContact = companions.find(item => item.id === contactId) ?? companions[0];
  const memoryOwner = members.find(item => item.id === memoryOwnerId) ?? primary;
  const draft = selectedId ? drafts[selectedId] ?? EMPTY_DRAFT : EMPTY_DRAFT;
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    // Grow with the draft while keeping long messages inside the input card.
    input.style.height = 'auto';
    input.style.height = `${Math.min(176, Math.max(56, input.scrollHeight))}px`;
  }, [draft.content, selectedId, page]);
  const activities = state?.activities.filter(item => item.conversationId === selectedId) ?? [];
  const runningActions = actions.filter(action => ['queued', 'running'].includes(action.status));
  const clock = useCompanionClock(activities.length > 0 || actions.some(item => item.status === 'queued' || item.status === 'running'), isActive && page === 'messages');
  useEffect(() => {
    if (isActive && page === 'messages' && selectedId && selected?.unread) void Promise.resolve().then(() => markRead(selectedId));
  }, [isActive, page, selectedId, selected?.unread, markRead]);
  useEffect(() => {
    if (!showPanel || !memoryOwner) return;
    memoryOwnerRef.current = memoryOwner.id;
    void Promise.resolve().then(() => loadMemories(memoryOwner.id));
    return () => { memoryOwnerRef.current = null; };
  }, [showPanel, memoryOwner?.id, memoryOwner, loadMemories]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (scrollAnchor.current) {
      scroll.scrollTop = scrollAnchor.current.top + scroll.scrollHeight - scrollAnchor.current.height;
      scrollAnchor.current = null;
    } else if (highlightedId) {
      const element = [...scroll.querySelectorAll<HTMLElement>('[data-companion-message]')].find(item => item.dataset.companionMessage === highlightedId);
      element?.scrollIntoView?.({ block: 'center' });
    } else if (stickyRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [messages, selectedId, highlightedId]);
  useLayoutEffect(() => {
    if (stickyRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [actions]);

  function updateDraft(patch: Partial<ChatDraft>, id = selectedId) {
    if (id) setDrafts(current => ({ ...current, [id]: { ...EMPTY_DRAFT, ...current[id], ...patch } }));
  }
  function selectConversation(conversation: CompanionConversation) {
    if (selectedRef.current !== conversation.id) {
      ++loadEpoch.current; selectedRef.current = conversation.id; historyRef.current = false; stickyRef.current = true; latestSequence.current = 0; loadedConversation.current = null;
      setSelectedId(conversation.id); setMessages([]); setActions([]); setHasMore(false); setLoadingMessages(true); setHistoryMode(false);
      setDelivery('auto'); setTargetActionId(null);
      ++searchEpoch.current; setSearching(false); setHighlightedId(null); setSearchResults(null); setSearchQuery(''); setShowSearch(false); setNewMessages(false); setMemoryOwnerId(null); setMemories([]); setMemoryDraft(''); setEditingMemoryId(null); setMemorySource(undefined);
    }
    setPage('messages'); setEmojiOpen(false); setComposerMore(false);
    if (activeRef.current && conversation.unread) void markRead(conversation.id);
  }
  async function openPrivate(companionId: string) {
    const response = await request({ type: 'conversation.open', companionId });
    if (response?.conversation) { selectConversation(response.conversation); void refreshState(); }
  }
  async function send() {
    if (!selectedId || sendInFlight.current || (!draft.content.trim() && !draft.attachments.length)) return;
    const id = selectedId;
    const sentDraft = draft;
    sendInFlight.current = true; setSending(true); setError(''); stickyRef.current = true; setHighlightedId(null);
    const wasHistory = historyRef.current;
    if (wasHistory) { historyRef.current = false; setHistoryMode(false); setMessages([]); }
    const response = await request({ type: 'message.send', conversationId: id, content: sentDraft.content, clientId: crypto.randomUUID(), delivery,
      ...(targetActionId && (delivery === 'steer' || delivery === 'queue') ? { targetActionId } : {}),
      ...(sentDraft.reply ? { replyToId: sentDraft.reply.id } : {}), ...(sentDraft.attachments.length ? { attachmentIds: sentDraft.attachments.map(item => item.id) } : {}) });
    sendInFlight.current = false; setSending(false);
    if (!response) return;
    setDrafts(current => {
      const currentDraft = current[id] ?? EMPTY_DRAFT;
      return { ...current, [id]: { content: currentDraft.content === sentDraft.content ? '' : currentDraft.content, attachments: currentDraft.attachments.filter(item => !sentDraft.attachments.some(sent => sent.id === item.id)), ...(currentDraft.reply?.id !== sentDraft.reply?.id && currentDraft.reply ? { reply: currentDraft.reply } : {}) } };
    });
    if (selectedRef.current === id) {
      if (response.message) setMessages(current => mergeMessages(current, [response.message!]));
      await loadMessages(id, !wasHistory);
    }
    void refreshState(); if (selectedRef.current === id) composerRef.current?.focus();
  }
  async function pickAttachments(kind?: 'image') {
    const id = selectedId;
    if (!id) return;
    const response = await request({ type: 'attachment.pick', ...(kind ? { kind } : {}) });
    if (kind && response?.attachments?.some(item => !item.mime.startsWith('image/'))) setError('已忽略非图片文件，请选择图片。');
    const attachments = response?.attachments?.filter(item => !kind || item.mime.startsWith('image/'));
    if (attachments) setDrafts(current => {
      const currentDraft = current[id] ?? EMPTY_DRAFT;
      return { ...current, [id]: { ...currentDraft, attachments: [...currentDraft.attachments, ...attachments].slice(0, 10) } };
    });
  }
  async function openMessageLink(url: string) {
    const shell = (window as Window & { worldlinebox?: { shell?: Pick<WorldlineBoxShellApi, 'openExternalUrl'> } }).worldlinebox?.shell;
    if (!shell) { setError('当前无法打开外部链接。'); return; }
    try {
      const result = await shell.openExternalUrl(url);
      if (!result.ok) setError('无法打开此链接。');
    } catch { setError('无法打开此链接。'); }
  }
  async function loadOlder() {
    if (!selectedId || !messages[0] || loadingOlder) return;
    const id = selectedId; const epoch = loadEpoch.current;
    setLoadingOlder(true);
    const response = await request({ type: 'messages', conversationId: id, before: messages[0].sequence, limit: PAGE_SIZE });
    setLoadingOlder(false);
    if (!response?.messages || selectedRef.current !== id || epoch !== loadEpoch.current) return;
    const scroll = scrollRef.current;
    if (scroll) scrollAnchor.current = { height: scroll.scrollHeight, top: scroll.scrollTop };
    stickyRef.current = false; setHighlightedId(null);
    setMessages(current => mergeMessages(current, response.messages!)); setHasMore(response.hasMore ?? false);
  }
  async function searchMessages() {
    if (!searchQuery.trim() || !selectedId) return;
    const epoch = ++searchEpoch.current; const id = selectedId;
    setSearching(true);
    const response = await request({ type: 'message.search', conversationId: id, query: searchQuery.trim() });
    if (epoch !== searchEpoch.current || selectedRef.current !== id) return;
    setSearching(false); if (response?.messages) setSearchResults(response.messages);
  }
  async function jumpToMessage(message: CompanionMessage) {
    if (message.conversationId !== selectedRef.current) return;
    stickyRef.current = false; setHighlightedId(null);
    if (messages.some(item => item.id === message.id)) { setHighlightedId(message.id); return; }
    const epoch = ++loadEpoch.current;
    historyRef.current = true; setHistoryMode(true);
    const response = await request({ type: 'messages', conversationId: message.conversationId, before: message.sequence + 1, limit: PAGE_SIZE });
    if (response?.messages && epoch === loadEpoch.current && selectedRef.current === message.conversationId) { setMessages(response.messages); setHasMore(response.hasMore ?? false); setHighlightedId(message.id); }
  }
  async function jumpToReference(id: string) {
    const conversationId = selectedRef.current;
    const cached = messages.find(item => item.id === id) || referencedMessages[id];
    const message = cached ?? (await request({ type: 'message.get', id }))?.message;
    if (!message || selectedRef.current !== conversationId) return;
    if (message.conversationId !== conversationId) { setError('引用消息不属于当前聊天。'); return; }
    setReferencedMessages(current => ({ ...current, [message.id]: message }));
    await jumpToMessage(message);
  }
  async function stopAction(id: string) {
    const response = await request({ type: 'action.cancel', id });
    if (response && selectedRef.current) void loadActions(selectedRef.current);
  }
  async function manageAction(type: 'action.resume' | 'action.terminate', id: string) {
    const response = await request({ type, id });
    if (response && selectedRef.current) { void loadActions(selectedRef.current); void refreshState(); }
  }
  function openAttachment(attachment: CompanionAttachment) {
    if (attachment.mime.startsWith('image/')) setPreviewAttachment(attachment);
    else void request({ type: 'attachment.open', id: attachment.id });
  }
  function returnToLatest() {
    historyRef.current = false; stickyRef.current = true; setHistoryMode(false); setHighlightedId(null); setNewMessages(false);
    if (selectedId) void loadMessages(selectedId);
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }
  function rememberMessage(message: CompanionMessage) {
    setShowPanel(true); setMemoryDraft(message.content); setMemorySource(message.id); setEditingMemoryId(null);
  }
  async function saveMemory() {
    if (!memoryOwner || !memoryDraft.trim()) return;
    const response = await request({ type: 'memory.save', companionId: memoryOwner.id, content: memoryDraft.trim(), ...(editingMemoryId ? { id: editingMemoryId } : {}), ...(memorySource ? { sourceMessageId: memorySource } : {}) });
    if (response) { setMemoryDraft(''); setEditingMemoryId(null); setMemorySource(undefined); void loadMemories(memoryOwner.id); }
  }
  async function toggleProactive(item: Companion, value: boolean) {
    const { name, description, persona, avatar, avatarAttachmentId } = item;
    const llm = item.llm ? { apiFormat: item.llm.apiFormat, baseUrl: item.llm.baseUrl, model: item.llm.model } : undefined;
    const response = await request({ type: 'companion.update', id: item.id, companion: { name, description, persona, model: '', avatar, proactive: value, ...(llm ? { llm } : {}), ...(avatarAttachmentId ? { avatarAttachmentId } : {}) } });
    if (response) void refreshState();
  }
  const visibleConversations = [...(state?.conversations ?? [])].filter(item => `${item.title} ${item.lastMessage}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const visibleContacts = companions.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const visibleGroups = (state?.conversations ?? []).filter(item => item.kind === 'group' && item.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const authorName = (id: string) => id === 'user' ? '我' : companions.find(item => item.id === id)?.name ?? (id === 'system' ? '系统' : '伙伴');
  function conversationAvatar(item: CompanionConversation) {
    const owners = companions.filter(companion => item.memberIds.includes(companion.id));
    return item.kind === 'private' ? <Avatar companion={owners[0]} /> : <span className="companion-group-avatar" aria-hidden="true">{owners.slice(0, 2).map(owner => <Avatar key={owner.id} companion={owner} />)}{!owners.length && <ChatGlyph name="group" />}</span>;
  }
  return <div className="companions-app" data-companions>
    <nav className="companions-navigation" aria-label="伙伴导航">
      <button className={page === 'messages' ? 'is-active' : ''} aria-pressed={page === 'messages'} onClick={() => { setPage('messages'); setFilter(''); }}><ChatGlyph name="chat" /><span>消息</span>{!!state?.conversations.reduce((sum, item) => sum + item.unread, 0) && <i className="companions-nav-dot" />}</button>
      <button className={page === 'contacts' ? 'is-active' : ''} aria-pressed={page === 'contacts'} onClick={() => { setPage('contacts'); setFilter(''); }}><ChatGlyph name="contacts" /><span>联系人</span></button>
    </nav>
    <aside className="companions-list-pane" aria-label={page === 'messages' ? '消息列表' : '联系人列表'}>
      <header className="companions-list-title"><h1>{page === 'messages' ? '消息' : '联系人'}</h1><button className="companion-icon-button" aria-label="添加联系人" title="添加联系人" onClick={() => setDialog({ kind: 'companion' })}><Icon name="plus" /></button></header>
      <div className="companions-list-search"><Icon name="search" /><input aria-label={page === 'messages' ? '搜索会话' : '搜索联系人'} placeholder={page === 'messages' ? '搜索消息和群聊' : '搜索联系人'} value={filter} onChange={event => setFilter(event.target.value)} />{filter && <button aria-label="清空搜索" className="companion-icon-button" onClick={() => setFilter('')}>×</button>}</div>
      {page === 'messages' ? <>
        <div className="companions-list-caption"><span>最近联系</span><button onClick={() => setDialog({ kind: 'group' })}><ChatGlyph name="group" />创建群聊</button></div>
        <div className="companions-list-scroll">{visibleConversations.map(item => <button className={`companions-conversation${selectedId === item.id ? ' is-selected' : ''}`} data-companion-conversation={item.id} key={item.id} onClick={() => selectConversation(item)}>
          {conversationAvatar(item)}<span className="companions-conversation-copy"><span className="companions-conversation-title">{item.title}{item.pinned && <span title="置顶"><ChatGlyph name="pin" /></span>}</span><span className="companions-conversation-preview">{item.muted ? '消息免打扰 · ' : ''}{companionMessagePreview(item.lastMessage) || '开始聊聊吧'}</span></span><span className="companions-conversation-meta"><time>{shortTime(item.updatedAt)}</time>{!!item.unread && <span className={`companions-unread${item.muted ? ' is-muted' : ''}`} aria-label={`${item.unread} 条未读消息`}>{item.unread > 99 ? '99+' : item.unread}</span>}</span>
        </button>)}{!visibleConversations.length && state && <div className="companions-list-empty">{filter ? '没有找到相关会话' : '添加一个伙伴，开始你们的日常。'}</div>}</div>
      </> : <div className="companions-list-scroll"><div className="companions-list-caption"><span>虚拟伙伴 · {companions.length}</span></div>{visibleContacts.map(item => <button key={item.id} className={`companions-contact${selectedContact?.id === item.id ? ' is-selected' : ''}`} data-companion-contact={item.id} onClick={() => setContactId(item.id)}><Avatar companion={item} /><span><strong>{item.name}</strong><small>{item.description || '与你一起生活的伙伴'}</small></span></button>)}
        <div className="companions-list-caption"><span>群聊 · {visibleGroups.length}</span><button onClick={() => setDialog({ kind: 'group' })}>新建</button></div>{visibleGroups.map(item => <button className="companions-contact" key={item.id} onClick={() => selectConversation(item)}>{conversationAvatar(item)}<span><strong>{item.title}</strong><small>{item.memberIds.length + 1} 位成员</small></span></button>)}
        <button className="companions-add-contact" onClick={() => setDialog({ kind: 'companion' })}><Icon name="plus" />添加新的伙伴</button>
      </div>}
      <footer className="companions-list-footer"><span className="companions-local-dot" />消息保存在本机</footer>
    </aside>
    <main className="companions-main">
      {error && <div className="companions-error" role="alert"><Icon name="alert-circle" /><span>{error}</span><button className="companion-icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
      {!state ? <div className="companions-empty"><ChatGlyph name="chat" /><h2>{api ? '正在打开伙伴的消息…' : '伙伴服务暂不可用'}</h2>{error && <button className="companion-secondary-button" onClick={() => void refreshState()}>重新加载</button>}</div>
        : page === 'contacts' ? selectedContact ? <div className="companions-contact-profile"><header className="companions-profile-label">联系人资料</header><div className="companions-profile-heading"><Avatar companion={selectedContact} large /><div><h2>{selectedContact.name}</h2><p>{selectedContact.description}</p>{selectedContact.builtin && <span className="companions-profile-tag">{selectedContact.id === 'deepseek-sister' ? '大肥鱼姐姐 · Pro' : selectedContact.id === 'deepseek-flash' ? '小肥鱼妹妹 · Flash' : '内置伙伴'}</span>}</div></div>
          <div className="companions-profile-body"><div><section><h3>关于她</h3><p className="companions-introduction">{contactIntroduction(selectedContact)}</p><details key={selectedContact.id} className="companions-persona-details"><summary>查看角色设定</summary><p className="companions-persona">{selectedContact.persona}</p></details></section><section><h3>联系习惯</h3><label className="companions-checkbox"><input type="checkbox" checked={selectedContact.proactive} onChange={event => void toggleProactive(selectedContact, event.target.checked)} />允许她主动联系我</label><p className="companions-subtle">应用运行时，她可以延续你们的话题。夜间会保持安静。</p></section><section><h3>模型与能力</h3><p>{selectedContact.llm ? '使用此伙伴的独立 LLM 服务' : '共用设置中的全局 LLM 服务'}</p><p className="companions-subtle">{selectedContact.llm ? `模型：${selectedContact.llm.model}` : '跟随全局模型'} · 可以使用自己的能力查看文件、查资料和处理任务</p></section><div className="companions-profile-actions"><button className="companion-primary-button" onClick={() => void openPrivate(selectedContact.id)}><ChatGlyph name="chat" />发消息</button><button className="companion-secondary-button" onClick={() => setDialog({ kind: 'companion', companion: selectedContact })}>编辑资料</button><button className="companion-text-danger" onClick={() => setDialog({ kind: 'delete', companion: selectedContact })}>移除联系人</button></div></div>
          {(selectedContact.avatar === 'sister' || selectedContact.avatar === 'flash') && <figure className="companions-character-art"><img src={fullBodyImage} alt="蓝发鲸鱼女仆形象" /><figcaption>大肥鱼姐妹 · 角色形象参考</figcaption></figure>}</div>
        </div> : <div className="companions-empty"><ChatGlyph name="contacts" /><h2>认识你的第一位伙伴</h2><p>从内置角色开始，或者创造属于你的伙伴。</p><button className="companion-primary-button" onClick={() => setDialog({ kind: 'companion' })}>添加联系人</button></div>
        : !selected ? <div className="companions-empty"><ChatGlyph name="chat" /><h2>每天，都可以接着聊</h2><p>打开一个伙伴，开始你们的第一段共同经历。</p><button className="companion-primary-button" onClick={() => setPage('contacts')}>查看联系人</button></div>
        : <div className={`companions-chat-layout${showPanel ? ' has-panel' : ''}`}>
          <section className="companions-chat" aria-label={`${selected.title}的聊天`}>
            <header className="companions-chat-header"><div className="companions-chat-identity">{conversationAvatar(selected)}<div><h2>{selected.title}{selected.kind === 'group' && <span>（{selected.memberIds.length + 1}）</span>}</h2><p>{activities.length ? activities.map(item => `${authorName(item.companionId)}${item.status === 'thinking' ? '正在回复…' : '正在办事…'}`).join(' · ') : selected.kind === 'group' ? members.map(item => item.name).join('、') : primary?.description || '你们的日常，慢慢聊'}</p></div></div><div className="companions-header-actions">{actions.length > 0 && <button className="companions-task-monitor-button" aria-label="查看伙伴任务" onClick={() => setShowTaskMonitor(true)}><Icon name="activity" /><span>{runningActions.length ? `进行中 ${runningActions.length}` : '任务'}</span></button>}<button className={`companion-icon-button${selected.pinned ? ' is-active' : ''}`} title={selected.pinned ? '取消置顶' : '置顶聊天'} aria-label={selected.pinned ? '取消置顶' : '置顶聊天'} onClick={() => void request({ type: 'conversation.update', id: selected.id, pinned: !selected.pinned }).then(result => { if (result) void refreshState(); })}><ChatGlyph name="pin" /></button><button className={`companion-icon-button${selected.muted ? ' is-active' : ''}`} aria-label={selected.muted ? '取消免打扰' : '消息免打扰'} title={selected.muted ? '取消免打扰' : '消息免打扰'} onClick={() => void request({ type: 'conversation.update', id: selected.id, muted: !selected.muted }).then(result => { if (result) void refreshState(); })}><ChatGlyph name="bell" /></button><button className="companion-icon-button" title="搜索聊天记录" aria-label="搜索聊天记录" onClick={() => setShowSearch(!showSearch)}><Icon name="search" /></button>{selected.kind === 'group' && <button className="companion-icon-button" aria-label="管理群聊" title="管理群聊" onClick={() => setDialog({ kind: 'group', conversation: selected })}><ChatGlyph name="group" /></button>}<button className={`companion-icon-button${showPanel ? ' is-active' : ''}`} aria-label="我们之间" title="我们之间" aria-expanded={showPanel} onClick={() => setShowPanel(!showPanel)}><Icon name="panel-right" /></button></div></header>
            {!!unconfiguredMembers.length && <div className="companions-config-hint"><span>{unconfiguredMembers.map(item => item.name).join('、')}还没有连接 LLM 服务，消息仍会保存在这里。</span><button onClick={() => { const independent = unconfiguredMembers.find(item => item.llm); if (independent) setDialog({ kind: 'companion', companion: independent }); else onOpenSettings(); }}>{unconfiguredMembers.some(item => item.llm) ? '配置伙伴' : '前往设置'} <Icon name="chevron-right" /></button></div>}
            {showSearch && <section className="companions-history-search" aria-label="聊天记录搜索"><form onSubmit={event => { event.preventDefault(); void searchMessages(); }}><Icon name="search" /><input aria-label="搜索聊天内容" maxLength={200} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索你们聊过的事情" autoFocus /><button disabled={searching || !searchQuery.trim()}>{searching ? '搜索中…' : '搜索'}</button><button type="button" className="companion-icon-button" aria-label="关闭聊天搜索" onClick={() => setShowSearch(false)}>×</button></form>{searchResults && <div className="companions-search-results">{searchResults.length ? searchResults.map(item => <button key={item.id} onClick={() => void jumpToMessage(item)}><span><strong>{authorName(item.authorId)}</strong><time>{dayLabel(item.createdAt)} {clockTime(item.createdAt)}</time></span><p>{item.content || item.attachments.map(attachment => attachment.name).join('、')}</p></button>) : <p>没有找到相关消息</p>}</div>}</section>}
            {historyMode && <div className="companions-history-banner">正在查看历史消息<button onClick={returnToLatest}>回到最新消息 ↓</button></div>}
            <div className="companions-message-scroll" ref={scrollRef} data-companion-messages onScroll={event => { const element = event.currentTarget; stickyRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; if (stickyRef.current) setNewMessages(false); }}>
              {hasMore && <button className="companions-load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '正在读取…' : '查看更早的消息'}</button>}
              {loadingMessages && <p className="companions-chat-tip">正在读取聊天记录…</p>}
              {!loadingMessages && !messages.length && <div className="companions-chat-welcome"><ChatGlyph name="chat" /><p>从一句“你好”开始。以后每次回来，都可以接着聊。</p></div>}
              {messages.map((message, index) => {
                const own = message.authorId === 'user'; const author = companions.find(item => item.id === message.authorId);
                const replied = messages.find(item => item.id === message.replyToId) || (message.replyToId ? referencedMessages[message.replyToId] : undefined);
                const action = actions.find(item => item.id === message.actionId);
                const newDay = index === 0 || dayLabel(messages[index - 1]!.createdAt) !== dayLabel(message.createdAt);
                return <div key={message.id}>{newDay && <div className="companions-date-separator">{dayLabel(message.createdAt)}</div>}
                  {message.kind === 'notice' ? <div className={`companions-notice${message.status === 'failed' ? ' is-failed' : ''}`} data-companion-message={message.id}>{message.authorId !== 'system' && <small>内置欢迎 · {authorName(message.authorId)}</small>}<span>{message.content}</span>{message.status === 'failed' && <button onClick={() => void request({ type: 'reply.retry', conversationId: selected.id })}>重试回复</button>}</div> : <article className={`companions-message${own ? ' is-own' : ''}${highlightedId === message.id ? ' is-highlighted' : ''}`} data-companion-message={message.id}>
                    <Avatar companion={author} /><div className="companions-message-body"><div className="companions-message-author">{authorName(message.authorId)}<time>{clockTime(message.createdAt)}</time></div><div className={`companions-message-bubble${message.kind === 'action' ? ' is-action' : ''}`}>
                      {message.replyToId && <button className="companions-reply-quote" aria-label={`查看引用消息 ${message.replyToId}`} onClick={() => void jumpToReference(message.replyToId!)}><strong>{replied ? authorName(replied.authorId) : '引用消息'}</strong><span>{replied?.content || (replied ? replied.attachments.map(item => item.name).join('、') : '点击查看引用的消息')}</span></button>}
                      {message.kind === 'action' && action ? <CompanionActionCard action={action} now={clock} onStop={() => void stopAction(action.id)} onResume={() => manageAction('action.resume', action.id)} onTerminate={() => manageAction('action.terminate', action.id)} onGuide={() => { setDelivery('steer'); setTargetActionId(action.id); composerRef.current?.focus(); }} onOpenUrl={url => void openMessageLink(url)} /> : message.content && (own ? <p>{message.content}</p> : <MessageContent content={message.content} onOpenUrl={url => void openMessageLink(url)} />)}
                      {!!message.attachments.length && <div className="companions-message-attachments">{message.attachments.map(item => <button className={`companions-attachment${item.mime.startsWith('image/') ? ' is-image' : ''}`} key={item.id} onClick={() => openAttachment(item)}>{item.mime.startsWith('image/') ? <img src={item.url || `worldlinebox-companion://attachment/${encodeURIComponent(item.id)}`} alt={item.name} /> : <Icon name="file" />}<span><strong>{item.name}</strong><small>{bytes(item.size)} · {item.mime.startsWith('image/') ? '点击预览' : '查看文件位置'}</small></span></button>)}</div>}
                    </div><div className="companions-message-tools"><button aria-label={`引用消息 ${message.sequence}`} title="引用回复" onClick={() => { updateDraft({ reply: message }); composerRef.current?.focus(); }}><ChatGlyph name="reply" /></button>{message.content && <button aria-label={`记住消息 ${message.sequence}`} title="记住这件事" onClick={() => rememberMessage(message)}><Icon name="heart" /></button>}{own && <button aria-label={`处理消息 ${message.sequence}`} title="交给伙伴处理" onClick={() => setDialog({ kind: 'action', message, conversation: selected })}><Icon name="code" /></button>}{message.status === 'failed' && <button onClick={() => void request({ type: 'reply.retry', conversationId: selected.id })}>重试回复</button>}</div></div>
                  </article>}
                </div>;
              })}
              {state?.recoveries?.some(item => item.conversationId === selected.id && item.status === 'interrupted') && <div className="companions-recovery-notice"><span>上次回复还没说完，消息和进度已经保留。</span><button onClick={() => void request({ type: 'reply.resume', conversationId: selected.id }).then(() => refreshState())}>继续上次回复</button></div>}
              {activities.some(item => item.status === 'thinking') && <div className="companions-typing"><span /><span /><span /><span className="companions-typing-label">{activities.filter(item => item.status === 'thinking').map(item => `${authorName(item.companionId)}正在回复 · ${elapsedTime(item.startedAt || activityStarts[`${item.conversationId}/${item.companionId}/${item.status}`] || new Date(clock).toISOString(), clock)}`).join('；')}</span><button onClick={() => void request({ type: 'reply.cancel', conversationId: selected.id })}>取消回复</button></div>}
            </div>
            {newMessages && !historyMode && <button className="companions-new-message" onClick={returnToLatest}>有新消息 · 回到最新 ↓</button>}
            <section className="companions-composer" aria-label="消息输入区">
              {emojiOpen && <div className="companions-emoji-picker" aria-label="选择表情">{emojis.map(emoji => <button key={emoji} aria-label={`表情 ${emoji}`} onClick={() => { updateDraft({ content: draft.content + emoji }); setEmojiOpen(false); composerRef.current?.focus(); }}>{emoji}</button>)}</div>}
              {composerMore && <div className="companions-composer-menu"><button onClick={() => { setComposerMore(false); const message = [...messages].reverse().find(item => item.authorId === 'user' && item.kind === 'text'); if (message) setDialog({ kind: 'action', message, conversation: selected }); else setError('请先发送需要委托的消息，再交给伙伴处理。'); }}><Icon name="code" />处理上一条消息</button><button onClick={() => { setComposerMore(false); setShowPanel(true); }}><Icon name="heart" />查看共同记忆</button></div>}
              {draft.reply && <div className="companions-draft-reply"><ChatGlyph name="reply" /><span>回复 {authorName(draft.reply.authorId)}：{draft.reply.content || '附件'}</span><button className="companion-icon-button" aria-label="取消引用" onClick={() => updateDraft({ reply: undefined })}>×</button></div>}
              {!!draft.attachments.length && <div className="companions-draft-attachments">{draft.attachments.map(item => <span key={item.id}>{item.mime.startsWith('image/') ? <ChatGlyph name="image" /> : <Icon name="file" />}<span>{item.name}</span><small>{bytes(item.size)}</small><button aria-label={`移除附件 ${item.name}`} onClick={() => updateDraft({ attachments: draft.attachments.filter(attachment => attachment.id !== item.id) })}>×</button></span>)}</div>}
              <textarea ref={composerRef} rows={2} aria-label="输入消息" placeholder={selected.kind === 'group' ? '和大家聊聊，@名字可以指定伙伴…' : `发消息给${selected.title}…`} value={draft.content} maxLength={16000} onChange={event => updateDraft({ content: event.target.value })} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); void send(); } }} />
              <div className="companions-composer-toolbar"><div className="companions-composer-tools"><CompanionModeMenu value={delivery} onChange={setDelivery} tasks={runningActions} target={targetActionId} onTarget={setTargetActionId} authorName={authorName} /><button className="companion-icon-button" aria-label="发送文件或图片" title="发送文件" onClick={() => void pickAttachments()}><Icon name="plus" /></button><button className={`companion-icon-button${emojiOpen ? ' is-active' : ''}`} aria-label="表情" title="表情" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen(!emojiOpen); setComposerMore(false); }}><ChatGlyph name="smile" /></button><button className="companion-icon-button" aria-label="发送图片" title="发送图片" onClick={() => void pickAttachments('image')}><ChatGlyph name="image" /></button><button className={`companion-icon-button${composerMore ? ' is-active' : ''}`} aria-label="更多聊天操作" title="更多" aria-expanded={composerMore} onClick={() => { setComposerMore(!composerMore); setEmojiOpen(false); }}><ChatGlyph name="more" /></button></div><div className="companions-composer-send"><span>{sending ? '正在发送…' : draft.content.length > 15000 ? `${draft.content.length} / 16000` : 'Enter 发送 · Shift + Enter 换行'}</span><button className="companions-send-button" aria-label="发送" title="发送消息" disabled={sending || (!draft.content.trim() && !draft.attachments.length)} onClick={() => void send()}><ChatGlyph name="send" /></button></div></div>
            </section>
          </section>
          {showPanel && <aside className="companions-relationship-panel" aria-label="我们之间面板"><header><h3>我们之间</h3><button className="companion-icon-button" aria-label="收起我们之间" onClick={() => setShowPanel(false)}>×</button></header>{memoryOwner && <><div className="companions-panel-profile"><Avatar companion={memoryOwner} large /><strong>{memoryOwner.name}</strong><p>{memoryOwner.description}</p><button onClick={() => { setContactId(memoryOwner.id); setPage('contacts'); }}>查看资料</button></div>{members.length > 1 && <label className="companions-panel-owner">正在查看谁的记忆<select aria-label="记忆所属伙伴" value={memoryOwner.id} onChange={event => { setMemoryOwnerId(event.target.value); setMemories([]); setMemoryDraft(''); setEditingMemoryId(null); setMemorySource(undefined); }}>{members.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            <section><h4>联系习惯</h4><label className="companions-checkbox"><input type="checkbox" checked={memoryOwner.proactive} onChange={event => void toggleProactive(memoryOwner, event.target.checked)} />主动联系我</label><p className="companions-subtle">应用运行时延续话题，夜间保持安静。</p></section>
            <section><h4>正在做的事 <span>{actions.length}</span></h4>{!actions.length && <p className="companions-subtle">交给她的事情，会出现在这里。</p>}{actions.map(action => <CompanionActionCard key={action.id} action={action} now={clock} compact onStop={() => void stopAction(action.id)} onResume={() => manageAction('action.resume', action.id)} onTerminate={() => manageAction('action.terminate', action.id)} onGuide={() => { setDelivery('steer'); setTargetActionId(action.id); composerRef.current?.focus(); }} onOpenUrl={url => void openMessageLink(url)} />)}</section>
            <section><h4>共同记忆 <span>{memories.length}</span></h4><p className="companions-subtle">她会记住你们的相处。你也可以补充、修正或忘记。</p>{memories.map(memory => <article className="companions-memory" key={memory.id}><p>{memory.content}</p><div><small>{memory.origin === 'user' ? '你告诉她的' : '从聊天中记住'} · {shortTime(memory.updatedAt)}</small><button aria-label={`编辑记忆 ${memory.id}`} title="修正记忆" onClick={() => { setMemoryDraft(memory.content); setEditingMemoryId(memory.id); setMemorySource(memory.sourceMessageId); }}><Icon name="edit" /></button><button aria-label={`删除记忆 ${memory.id}`} title="忘记这件事" onClick={() => void request({ type: 'memory.delete', id: memory.id }).then(result => { if (result) void loadMemories(memoryOwner.id); })}><Icon name="trash" /></button></div></article>)}
              <div className="companions-memory-editor"><textarea aria-label="共同记忆内容" rows={3} maxLength={4000} value={memoryDraft} onChange={event => setMemoryDraft(event.target.value)} placeholder="希望她记住什么？" />{memorySource && <small>来自聊天中的一条消息</small>}<div>{editingMemoryId && <button onClick={() => { setEditingMemoryId(null); setMemoryDraft(''); setMemorySource(undefined); }}>取消修正</button>}<button disabled={!memoryDraft.trim()} onClick={() => void saveMemory()}>{editingMemoryId ? '保存修正' : '记住这件事'}</button></div></div>
            </section></>}</aside>}
        </div>}
    </main>
    {dialog && <CompanionDialogs key={dialog.kind === 'companion' ? `companion-${dialog.companion?.id ?? 'new'}` : dialog.kind === 'group' ? `group-${dialog.conversation?.id ?? 'new'}` : dialog.kind === 'action' ? `action-${dialog.message.id}` : `delete-${dialog.companion.id}`} dialog={dialog} companions={companions} request={request} requestError={error} onClose={() => { setDialog(null); void refreshState(); }} onOpen={id => void openPrivate(id)} onCreated={selectConversation} builtins={BUILTIN_COMPANIONS} />}
    {previewAttachment && <CompanionImagePreview key={previewAttachment.id} attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} onReveal={() => void request({ type: 'attachment.open', id: previewAttachment.id })} />}
    {showTaskMonitor && <CompanionTaskMonitor conversationId={selectedId!} request={request} dshApi={dshApi} actions={actions} companions={companions} now={clock} onClose={() => setShowTaskMonitor(false)} onStop={id => void stopAction(id)} onResume={id => manageAction('action.resume', id)} onTerminate={id => manageAction('action.terminate', id)} onGuide={id => { setShowTaskMonitor(false); setDelivery('steer'); setTargetActionId(id); setTimeout(() => composerRef.current?.focus(), 0); }} onOpenUrl={url => void openMessageLink(url)} />}
  </div>;
}
