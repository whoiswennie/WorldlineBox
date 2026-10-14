import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Companion, CompanionAction, CompanionAttachment, CompanionConversation, CompanionMessage, CompanionSearchHit, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { BUILTIN_COMPANIONS } from '../../shared/companion-personas';
import { builtinCompanionProfile } from '../../shared/companion-catalogue';
import { companionMessagePreview } from '../../shared/companion-titles';
import { Icon } from '../Icons';
import { CompanionDialogs, type CompanionDialog } from './CompanionDialogs';
import { Avatar, ChatGlyph, companionPortrait } from './CompanionVisuals';
import { elapsedTime, useCompanionClock } from './CompanionProgress';
import { CompanionImagePreview } from './CompanionImagePreview';
import { CompanionTaskMonitor } from './CompanionTaskMonitor';
import { CompanionMessageBubble } from './CompanionMessageBubble';
import { CompanionReplyStreamStore } from './reply-stream';
import { CompanionHistorySearch } from './CompanionHistorySearch';
import { CompanionPresencePanel } from './CompanionPresencePanel';
import { type CompanionMemoryDraft } from './CompanionMemoryPanel';
import { CompanionMemoryManager } from './CompanionMemoryManager';
import { CompanionPlanner } from './CompanionPlanner';
import { CompanionScheduleManager } from './CompanionScheduleManager';
import { companionPresence, COMPANION_PRESENCE_LABELS } from '../../shared/companion-presence';
import { trimMessageWindow } from './message-window';
import { companionTimestamp, companionTimezone } from '../../shared/companion-time';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import type { CompanionActionEvent } from '../../shared/companions';
import { companionProgressEvent, mergeCompanionProgress } from '../../shared/companion-progress';
import type { WorldlineBoxShellApi } from '../../shared/external-url';
import fullBodyImage from '../../../assets/companions/deepseek.jpg';
import './companions.css';
import './companion-planner.css';
import './world/companion-world.css';

const CompanionWorld = lazy(() => import('./world/CompanionWorld').then(module => ({ default: module.CompanionWorld })));

interface ChatDraft { content: string; attachments: CompanionAttachment[]; reply?: CompanionMessage }
const EMPTY_DRAFT: ChatDraft = { content: '', attachments: [] };
const PAGE_SIZE = 50;
const emojis = ['🐳', '😊', '💙', '✨', '👀', '🥺', '🎉', '☕', '🌙', '👍', '🌸', '😴', '🤔', '😂', '🫶', '🌊'];
function contactIntroduction(companion: Companion) { return (companion.builtin ? builtinCompanionProfile(companion.id)?.introduction : undefined) || companion.description || '还没有写下简介。可以在编辑资料中介绍这位伙伴。'; }
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
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ChatDraft>>({});
  const [sending, setSending] = useState(false);
  const [guideMessageId, setGuideMessageId] = useState<string | null>(null);
  const [showTaskMonitor, setShowTaskMonitor] = useState(false);
  const [selectedTaskActionId, setSelectedTaskActionId] = useState<string>();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showPresence, setShowPresence] = useState(false);
  const [searchScope, setSearchScope] = useState<string | undefined>();
  const [historyMode, setHistoryMode] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
  const [showScheduleManager, setShowScheduleManager] = useState(false);
  const [worldCompanionId, setWorldCompanionId] = useState<string | null>(null);
  const [memoryOwnerId, setMemoryOwnerId] = useState<string | null>(null);
  const [actions, setActions] = useState<CompanionAction[]>([]);
  const [memoryDraft, setMemoryDraft] = useState<CompanionMemoryDraft>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [composerMore, setComposerMore] = useState(false);
  const [dialog, setDialog] = useState<CompanionDialog | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<CompanionAttachment | null>(null);
  const [referencedMessages, setReferencedMessages] = useState<Record<string, CompanionMessage>>({});
  const [activityStarts, setActivityStarts] = useState<Record<string, string>>({});
  const [replyStreams] = useState(() => new CompanionReplyStreamStore());
  const selectedRef = useRef<string | null>(null);
  const activeRef = useRef(isActive);
  const historyRef = useRef(false);
  const aliveRef = useRef(true);
  const stickyRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const scrollAnchor = useRef<{ id?: string; offset: number; height: number; top: number } | null>(null);
  const messagesRef = useRef(messages);
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  useLayoutEffect(() => { replyStreams.reconcile(messages); }, [messages, replyStreams]);
  const pagingRef = useRef(false);
  const pendingJump = useRef<CompanionSearchHit | null>(null);
  const positionedHighlight = useRef<string | null>(null);
  const loadEpoch = useRef(0);
  const latestLoadEpoch = useRef(0);
  const actionsEpoch = useRef(0);
  const streamedEvents = useRef(new Map<string, CompanionActionEvent[]>());
  const stateEpoch = useRef(0);
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
    if (!stickyRef.current && next.conversations.some(room => room.id === selectedRef.current && room.unread > 0)) setNewMessages(true);
    if (!selectedRef.current || !next.conversations.some(item => item.id === selectedRef.current)) {
      const first = [...next.conversations].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))[0];
      ++loadEpoch.current; historyRef.current = false; stickyRef.current = true; latestSequence.current = 0; loadedConversation.current = null;
      pagingRef.current = false; scrollAnchor.current = null; setLoadingOlder(false); setLoadingNewer(false); setMessages([]); setActions([]); setHasMore(false); setHasNewer(false); setAwayFromBottom(false); setHistoryMode(false); setHighlightedId(null); setMemoryOwnerId(null); setMemoryDraft(undefined);
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
    const merged = refresh ? mergeMessages(messagesRef.current, response.messages!) : response.messages;
    const window = trimMessageWindow(merged, 'newer');
    setMessages(window); setHasNewer(false);
    if (!refresh || loadedConversation.current !== id || window.length < merged.length) setHasMore((response.hasMore ?? false) || window.length < merged.length);
    loadedConversation.current = id; setLoadingMessages(false);
  }, [request]);

  const loadActions = useCallback(async (id: string) => {
    const epoch = ++actionsEpoch.current;
    const response = await request({ type: 'actions', conversationId: id });
    if (selectedRef.current === id && epoch === actionsEpoch.current && response?.actions) {
      const next = response.actions.map(action => mergeLiveAction(action, streamedEvents.current));
      const visible = new Set(messagesRef.current.flatMap(message => [message.actionId, ...(message.segments ?? []).flatMap(segment => segment.actionIds)]).filter(Boolean));
      setActions(current => [...next, ...current.filter(action => visible.has(action.id) && !next.some(item => item.id === action.id)).slice(-50)].slice(0, 250));
    }
  }, [request]);

  const loadAround = useCallback(async (message: Pick<CompanionMessage, 'id' | 'sequence' | 'conversationId'>) => {
    const epoch = ++loadEpoch.current; ++latestLoadEpoch.current;
    pagingRef.current = false; setLoadingOlder(false); setLoadingNewer(false);
    historyRef.current = true; stickyRef.current = false; setHistoryMode(true); setAwayFromBottom(true);
    positionedHighlight.current = null; scrollAnchor.current = null;
    const response = await request({ type: 'messages', conversationId: message.conversationId, around: message.id, limit: PAGE_SIZE });
    if (response?.messages && epoch === loadEpoch.current && selectedRef.current === message.conversationId) {
      setMessages(trimMessageWindow(response.messages, 'newer')); setHasMore(response.hasMore ?? false); setHasNewer(response.hasNewer ?? false); setHighlightedId(message.id); setLoadingMessages(false);
    }
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
  useEffect(() => api?.onReplyStream(event => replyStreams.accept(event)), [api, replyStreams]);
  const scrollStreamingReply = useCallback((conversationId: string) => {
    if (activeRef.current && selectedRef.current === conversationId && !historyRef.current && stickyRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, []);
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
    });
  }, [api, refreshState, loadMessages, loadActions]);
  useEffect(() => { if (selectedId) void Promise.resolve().then(() => {
    const jump = pendingJump.current; pendingJump.current = null;
    if (jump?.conversationId === selectedId) void loadAround(jump); else void loadMessages(selectedId);
    void loadActions(selectedId);
  }); }, [selectedId, loadMessages, loadActions, loadAround]);
  useEffect(() => {
    // Quotes are a bounded cache too; evicted history cannot stay alive here.
    const needed = new Set(messages.flatMap(message => message.replyToId ? [message.replyToId] : []));
    void Promise.resolve().then(() => setReferencedMessages(current => {
      const entries = Object.entries(current).filter(([id]) => needed.has(id)).slice(-50);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    }));
  }, [messages]);
  const selected = state?.conversations.find(item => item.id === selectedId);
  const companions = useMemo(() => (state?.companions ?? []).map(role => ({ ...role, availability: companionPresence(role, state?.configured ?? false) })), [state?.companions, state?.configured]);
  const members = companions.filter(item => selected?.memberIds.includes(item.id));
  const primary = members[0];
  const offlineMembers = members.filter(item => item.availability === 'offline');
  const roomPresence = members.some(role => role.availability === 'working') ? 'working' : members.some(role => role.availability === 'waiting') ? 'waiting' : members.length && offlineMembers.length === members.length ? 'offline' : 'ready';
  const selectedContact = companions.find(item => item.id === contactId) ?? companions[0];
  const memoryOwner = members.find(item => item.id === memoryOwnerId) ?? primary;
  const timelineMessages = messages.filter(message => !message.memoryEvidenceOnly);
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
    if (isActive && page === 'messages' && selectedId && selected?.unread && !historyMode && !awayFromBottom) void Promise.resolve().then(() => {
      if (!historyRef.current && stickyRef.current) return markRead(selectedId);
    });
  }, [isActive, page, selectedId, selected?.unread, markRead, historyMode, awayFromBottom]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (scrollAnchor.current) {
      const anchor = scrollAnchor.current;
      const element = [...scroll.querySelectorAll<HTMLElement>('[data-companion-message]')].find(item => item.dataset.companionMessage === anchor.id);
      scroll.scrollTop = element ? scroll.scrollTop + element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset : anchor.top + scroll.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    } else if (highlightedId && positionedHighlight.current !== highlightedId) {
      const element = [...scroll.querySelectorAll<HTMLElement>('[data-companion-message]')].find(item => item.dataset.companionMessage === highlightedId);
      element?.scrollIntoView?.({ block: 'center' });
      positionedHighlight.current = highlightedId;
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
      pagingRef.current = false; scrollAnchor.current = null; setLoadingOlder(false); setLoadingNewer(false); setSelectedId(conversation.id); setMessages([]); setActions([]); setHasMore(false); setHasNewer(false); setAwayFromBottom(false); setLoadingMessages(true); setHistoryMode(false);

      positionedHighlight.current = null; setHighlightedId(null); setShowSearch(false); setNewMessages(false); setMemoryOwnerId(null); setMemoryDraft(undefined);
    }
    setPage('messages'); setEmojiOpen(false); setComposerMore(false);
    setShowPresence(false);
    if (activeRef.current && conversation.unread && !historyRef.current && stickyRef.current && !pendingJump.current) void markRead(conversation.id);
  }
  async function openPrivate(companionId: string) {
    const response = await request({ type: 'conversation.open', companionId });
    if (response?.conversation) { selectConversation(response.conversation); void refreshState(); }
  }
  const queuedMessages = [...new Map((state?.queue ?? []).filter(work => work.conversationId === selectedId && work.status === 'queued').map(work => [work.sourceMessageId, work])).values()];
  const runningSources = [...new Set((state?.queue ?? []).filter(work => work.conversationId === selectedId && work.status === 'running').map(work => work.sourceMessageId))];
  async function guideQueued(id: string, target?: string) {
    if (!target && runningSources.length > 1) { setGuideMessageId(id); return; }
    await request({ type: 'message.guide', id, targetSourceMessageId: target ?? runningSources[0] });
    setGuideMessageId(null); void refreshState();
  }
  async function send(guide = false, targetSourceMessageId?: string) {
    if (guide && !targetSourceMessageId && runningSources.length > 1) { setGuideMessageId('composer'); return; }
    if (!selectedId || sendInFlight.current || (!draft.content.trim() && !draft.attachments.length)) return;
    const id = selectedId;
    const sentDraft = draft;
    sendInFlight.current = true; setSending(true); setError(''); stickyRef.current = true; setHighlightedId(null);
    const wasHistory = historyRef.current;
    if (wasHistory) { historyRef.current = false; setHistoryMode(false); setMessages([]); }
    const response = await request({ type: 'message.send', conversationId: id, content: sentDraft.content, clientId: crypto.randomUUID(),
      ...(guide ? { delivery: 'steer', targetSourceMessageId: targetSourceMessageId ?? runningSources[0] } : {}),
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
  function captureScrollAnchor() {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top;
    const visible = [...scroll.querySelectorAll<HTMLElement>('[data-companion-message]')].find(item => item.getBoundingClientRect().bottom > top);
    scrollAnchor.current = { id: visible?.dataset.companionMessage, offset: (visible?.getBoundingClientRect().top ?? top) - top, height: scroll.scrollHeight, top: scroll.scrollTop };
  }
  async function loadOlder() {
    if (!selectedId || !messagesRef.current[0] || pagingRef.current || !hasMore) return;
    const id = selectedId; const epoch = loadEpoch.current; ++latestLoadEpoch.current;
    pagingRef.current = true;
    setLoadingOlder(true);
    const response = await request({ type: 'messages', conversationId: id, before: messagesRef.current[0]!.sequence, limit: PAGE_SIZE });
    if (selectedRef.current !== id || epoch !== loadEpoch.current) return;
    pagingRef.current = false; setLoadingOlder(false);
    if (!response?.messages) return;
    captureScrollAnchor();
    stickyRef.current = false; setHighlightedId(null);
    historyRef.current = true; setHistoryMode(true); setAwayFromBottom(true);
    const merged = mergeMessages(messagesRef.current, response.messages); const window = trimMessageWindow(merged, 'older');
    setMessages(window); setHasMore(response.hasMore ?? false); setHasNewer(window.length < merged.length || hasNewer);
  }
  async function loadNewer() {
    if (!selectedId || !messagesRef.current.length || pagingRef.current || !hasNewer) return;
    const id = selectedId; const epoch = loadEpoch.current;
    pagingRef.current = true; setLoadingNewer(true);
    const response = await request({ type: 'messages', conversationId: id, after: messagesRef.current.at(-1)!.sequence, limit: PAGE_SIZE });
    if (selectedRef.current !== id || epoch !== loadEpoch.current) return;
    pagingRef.current = false; setLoadingNewer(false);
    if (!response?.messages) return;
    captureScrollAnchor(); setHighlightedId(null); stickyRef.current = false;
    const merged = mergeMessages(messagesRef.current, response.messages); const window = trimMessageWindow(merged, 'newer');
    setMessages(window); setHasMore((response.hasMore ?? false) || window.length < merged.length || hasMore); setHasNewer(response.hasNewer ?? false);
    if (!response.hasNewer) { historyRef.current = false; setHistoryMode(false); }
  }
  async function jumpToMessage(message: Pick<CompanionMessage, 'id' | 'sequence' | 'conversationId'>) {
    if (message.conversationId !== selectedRef.current) return;
    stickyRef.current = false; setHighlightedId(null);
    if (messages.some(item => item.id === message.id)) { setHighlightedId(message.id); return; }
    await loadAround(message);
  }
  async function jumpToReference(id: string) {
    const conversationId = selectedRef.current;
    const cached = messages.find(item => item.id === id) || referencedMessages[id];
    const message = cached ?? (await request({ type: 'message.get', id }))?.message;
    if (!message || selectedRef.current !== conversationId) return;
    if (message.conversationId !== conversationId) { setError('引用消息不属于当前聊天。'); return; }
    setReferencedMessages(current => Object.fromEntries([...Object.entries(current).filter(([key]) => key !== message.id), [message.id, message]].slice(-50)));
    await jumpToMessage(message);
  }
  async function stopAction(id: string) {
    const response = await request({ type: 'action.cancel', id });
    if (response && selectedRef.current) void loadActions(selectedRef.current);
  }
  function openTaskProgress(id?: string) {
    setSelectedTaskActionId(id); setShowTaskMonitor(true);
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
    pagingRef.current = false; setLoadingOlder(false); setLoadingNewer(false); scrollAnchor.current = null;
    historyRef.current = false; stickyRef.current = true; setHistoryMode(false); setHasNewer(false); setAwayFromBottom(false); setHighlightedId(null); setNewMessages(false);
    if (selectedId) void loadMessages(selectedId);
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }
  function rememberMessage(message: CompanionMessage) {
    setShowMemoryManager(true); setMemoryDraft({ content: message.content, sourceMessageId: message.id, nonce: Date.now() });
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
      <button aria-label="打开伙伴世界" onClick={() => setWorldCompanionId('')}><Icon name="globe" /><span>世界</span></button>
    </nav>
    <aside className="companions-list-pane" aria-label={page === 'messages' ? '消息列表' : '联系人列表'}>
      <header className="companions-list-title"><h1>{page === 'messages' ? '消息' : '联系人'}</h1><button className="companion-icon-button" aria-label={page === 'messages' ? '发起聊天' : '添加联系人'} title={page === 'messages' ? '发起聊天' : '添加联系人'} onClick={() => setDialog({ kind: page === 'messages' ? 'chat' : 'companion' })}><Icon name="plus" /></button></header>
      <div className="companions-list-search"><Icon name="search" /><input aria-label={page === 'messages' ? '搜索会话' : '搜索联系人'} placeholder={page === 'messages' ? '搜索消息和群聊' : '搜索联系人'} value={filter} onChange={event => setFilter(event.target.value)} />{filter && <button aria-label="清空搜索" className="companion-icon-button" onClick={() => setFilter('')}>×</button>}</div>
      {page === 'messages' ? <>
        <div className="companions-list-caption"><span>最近联系</span><button className="companion-icon-button" aria-label="查找所有聊天记录" title="查找所有聊天记录" onClick={() => { setSearchScope(undefined); setShowSearch(true); }}><Icon name="search" /></button><button onClick={() => setDialog({ kind: 'group' })}><ChatGlyph name="group" />创建群聊</button></div>
        <div className="companions-list-scroll">{visibleConversations.map(item => <button className={`companions-conversation${selectedId === item.id ? ' is-selected' : ''}`} data-companion-conversation={item.id} key={item.id} onClick={() => selectConversation(item)}>
          {conversationAvatar(item)}<span className="companions-conversation-copy"><span className="companions-conversation-title">{item.title}{item.kind === 'private' && <small className="companions-availability" data-status={companions.find(role => role.id === item.memberIds[0])?.availability ?? 'ready'}>{COMPANION_PRESENCE_LABELS[companions.find(role => role.id === item.memberIds[0])?.availability ?? 'offline']}</small>}{item.pinned && <span title="置顶"><ChatGlyph name="pin" /></span>}</span><span className="companions-conversation-preview">{item.muted ? '消息免打扰 · ' : ''}{companionMessagePreview(item.lastMessage) || '开始聊聊吧'}</span></span><span className="companions-conversation-meta"><time>{shortTime(item.updatedAt)}</time>{!!item.unread && <span className={`companions-unread${item.muted ? ' is-muted' : ''}`} aria-label={`${item.unread} 条未读消息`}>{item.unread > 99 ? '99+' : item.unread}</span>}</span>
        </button>)}{!visibleConversations.length && state && <div className="companions-list-empty">{filter ? '没有找到相关会话' : '添加一个伙伴，开始你们的日常。'}</div>}</div>
      </> : <div className="companions-list-scroll"><div className="companions-list-caption"><span>虚拟伙伴 · {companions.length}</span></div>{visibleContacts.map(item => <button key={item.id} className={`companions-contact${selectedContact?.id === item.id ? ' is-selected' : ''}`} data-companion-contact={item.id} onClick={() => setContactId(item.id)}><Avatar companion={item} /><span><strong>{item.name}<span className="companions-availability" data-status={item.availability ?? 'ready'}>{COMPANION_PRESENCE_LABELS[item.availability ?? 'offline']}{item.availability === 'working' && item.activeCount ? ' · ' + item.activeCount : ''}</span></strong><small>{item.description || '与你一起生活的伙伴'}</small></span></button>)}
        <div className="companions-list-caption"><span>群聊 · {visibleGroups.length}</span><button onClick={() => setDialog({ kind: 'group' })}>新建</button></div>{visibleGroups.map(item => <button className="companions-contact" key={item.id} onClick={() => selectConversation(item)}>{conversationAvatar(item)}<span><strong>{item.title}</strong><small>{item.memberIds.length + 1} 位成员</small></span></button>)}
        <button className="companions-add-contact" onClick={() => setDialog({ kind: 'companion' })}><Icon name="plus" />添加新的伙伴</button>
      </div>}
      <footer className="companions-list-footer"><span className="companions-local-dot" />消息保存在本机</footer>
    </aside>
    <main className="companions-main">
      {error && !showMemoryManager && !showScheduleManager && <div className="companions-error" role="alert"><Icon name="alert-circle" /><span>{error}</span><button className="companion-icon-button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
      {!state ? <div className="companions-empty"><ChatGlyph name="chat" /><h2>{api ? '正在打开伙伴的消息…' : '伙伴服务暂不可用'}</h2>{error && <button className="companion-secondary-button" onClick={() => void refreshState()}>重新加载</button>}</div>
        : page === 'contacts' ? selectedContact ? <div className="companions-contact-profile"><header className="companions-profile-label">联系人资料</header><div className="companions-profile-heading"><Avatar companion={selectedContact} large /><div><h2>{selectedContact.name}</h2><p>{selectedContact.description}</p>{selectedContact.builtin && <span className="companions-profile-tag">{builtinCompanionProfile(selectedContact.id)?.sourceSummary ?? '内置伙伴'}</span>}</div></div>
          <div className="companions-profile-body"><div><section><h3>关于她</h3><p className="companions-introduction">{contactIntroduction(selectedContact)}</p><details key={selectedContact.id} className="companions-persona-details"><summary>查看角色设定</summary><p className="companions-persona">{selectedContact.persona}</p></details></section><section><h3>联系习惯</h3><label className="companions-checkbox"><input type="checkbox" checked={selectedContact.proactive} onChange={event => void toggleProactive(selectedContact, event.target.checked)} />允许她主动联系我</label><p className="companions-subtle">应用运行时，她可以延续你们的话题。夜间会保持安静。</p></section><section><h3>模型与能力</h3><p>{selectedContact.llm ? '使用此伙伴的独立 LLM 服务' : '共用设置中的全局 LLM 服务'}</p><p className="companions-subtle">{selectedContact.llm ? `模型：${selectedContact.llm.model}` : '跟随全局模型'} · 可以使用自己的能力查看文件、查资料和处理任务</p></section><div className="companions-profile-actions"><button className="companion-primary-button" onClick={() => void openPrivate(selectedContact.id)}><ChatGlyph name="chat" />发消息</button><button className="companion-secondary-button" onClick={() => setWorldCompanionId(selectedContact.id)}><Icon name="globe" />看看她的小屋</button><button className="companion-secondary-button" onClick={() => setDialog({ kind: 'companion', companion: selectedContact })}>编辑资料</button><button className="companion-text-danger" onClick={() => setDialog({ kind: 'delete', companion: selectedContact })}>移除联系人</button></div></div>
          {companionPortrait(selectedContact) && <figure className={`companions-character-art${selectedContact.avatar !== 'sister' && selectedContact.avatar !== 'flash' ? ' is-portrait' : ''}`}><img src={selectedContact.avatar === 'sister' || selectedContact.avatar === 'flash' ? fullBodyImage : companionPortrait(selectedContact)} alt={`${selectedContact.name}的角色形象`} /><figcaption>{selectedContact.avatar === 'sister' || selectedContact.avatar === 'flash' ? '大肥鱼姐妹 · 角色形象参考' : `${selectedContact.name} · 聊天头像`}</figcaption></figure>}</div>
        </div> : <div className="companions-empty"><ChatGlyph name="contacts" /><h2>认识你的第一位伙伴</h2><p>从内置角色开始，或者创造属于你的伙伴。</p><button className="companion-primary-button" onClick={() => setDialog({ kind: 'companion' })}>添加联系人</button></div>
        : !selected ? <div className="companions-empty"><ChatGlyph name="chat" /><h2>每天，都可以接着聊</h2><p>打开一个伙伴，开始你们的第一段共同经历。</p><button className="companion-primary-button" onClick={() => setPage('contacts')}>查看联系人</button></div>
        : <div className={`companions-chat-layout${showPanel ? ' has-panel' : ''}`}>
          <section className="companions-chat" aria-label={`${selected.title}的聊天`}>
            <header className="companions-chat-header"><div className="companions-chat-identity"><button className="companions-presence-avatar" data-presence-trigger aria-label="查看伙伴状态" aria-expanded={showPresence} title={COMPANION_PRESENCE_LABELS[roomPresence] + ' · 点击查看状态'} onClick={() => setShowPresence(!showPresence)}>{conversationAvatar(selected)}</button><div><h2><span className="companions-chat-name">{selected.title}{selected.kind === 'group' && '（' + (selected.memberIds.length + 1) + '）'}</span><span className="companions-presence-label" data-status={roomPresence}>{COMPANION_PRESENCE_LABELS[roomPresence]}</span>{offlineMembers.length > 0 && selected.kind === 'group' && <span className="companions-presence-label" data-status="offline">{offlineMembers.length} 位离线</span>}{historyMode && <button className="companions-history-chip" aria-label="正在查看历史消息" title="回到最新消息" onClick={returnToLatest}><Icon name="clock" />历史记录</button>}</h2><p>{activities.length ? [...new Set(activities.map(item => item.companionId))].map(id => `${authorName(id)}工作中 · ${(state?.queue ?? []).filter(work => work.companionId === id && work.conversationId === selected.id && work.status === 'running').length || 1} 条回复`).join(' · ') : selected.kind === 'group' ? members.map(item => item.name).join('、') : primary?.availability === 'offline' ? primary.availabilityReason || '尚未连接模型服务 · 点击头像配置' : primary?.description || '你们的日常，慢慢聊'}</p></div></div><div className="companions-header-actions">{actions.length > 0 && <button className="companions-task-monitor-button" aria-label="查看伙伴任务" onClick={() => setShowTaskMonitor(true)}><Icon name="activity" /><span>{runningActions.length ? `进行中 ${runningActions.length}` : '任务'}</span></button>}<button className={`companion-icon-button${selected.pinned ? ' is-active' : ''}`} title={selected.pinned ? '取消置顶' : '置顶聊天'} aria-label={selected.pinned ? '取消置顶' : '置顶聊天'} onClick={() => void request({ type: 'conversation.update', id: selected.id, pinned: !selected.pinned }).then(result => { if (result) void refreshState(); })}><ChatGlyph name="pin" /></button><button className={`companion-icon-button${selected.muted ? ' is-active' : ''}`} aria-label={selected.muted ? '取消免打扰' : '消息免打扰'} title={selected.muted ? '取消免打扰' : '消息免打扰'} onClick={() => void request({ type: 'conversation.update', id: selected.id, muted: !selected.muted }).then(result => { if (result) void refreshState(); })}><ChatGlyph name="bell" /></button><button className="companion-icon-button" title="搜索聊天记录" aria-label="搜索聊天记录" onClick={() => { setSearchScope(selected.id); setShowSearch(true); }}><Icon name="search" /></button>{selected.kind === 'group' && <button className="companion-icon-button" aria-label="管理群聊" title="管理群聊" onClick={() => setDialog({ kind: 'group', conversation: selected })}><ChatGlyph name="group" /></button>}<button className="companion-icon-button" aria-label="删除聊天" title="删除聊天" onClick={() => setDialog({ kind: 'delete-conversation', conversation: selected, mode: 'hide' })}><Icon name="trash" /></button><button className={`companion-icon-button${showPanel ? ' is-active' : ''}`} aria-label="我们之间" title="我们之间" aria-expanded={showPanel} onClick={() => setShowPanel(!showPanel)}><Icon name="panel-right" /></button></div></header>
            {showPresence && <CompanionPresencePanel members={members} onClose={() => setShowPresence(false)} onConfigure={role => { setShowPresence(false); if (role.llm) setDialog({ kind: 'companion', companion: role }); else onOpenSettings(); }} />}
            <div className="companions-message-scroll" ref={scrollRef} data-companion-messages data-window-count={messages.length} onScroll={event => {
              const element = event.currentTarget; const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
              stickyRef.current = atBottom && !hasNewer; setAwayFromBottom(!atBottom || hasNewer || historyRef.current);
              if (stickyRef.current) setNewMessages(false);
              if (!loadingMessages && element.scrollTop < 120 && hasMore) void loadOlder();
              else if (!loadingMessages && atBottom && hasNewer) void loadNewer();
            }}>
              {hasMore && <button className="companions-load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '正在读取…' : '查看更早的消息'}</button>}
              {loadingMessages && <p className="companions-chat-tip">正在读取聊天记录…</p>}
              {!loadingMessages && !timelineMessages.length && <div className="companions-chat-welcome"><ChatGlyph name="chat" /><p>从一句“你好”开始。以后每次回来，都可以接着聊。</p></div>}
              {timelineMessages.map((message, index) => {
                const own = message.authorId === 'user'; const author = companions.find(item => item.id === message.authorId);
                const replied = messages.find(item => item.id === message.replyToId) || (message.replyToId ? referencedMessages[message.replyToId] : undefined);
                if (message.segments && !message.isReplyDraft && !message.segments.some(part => part.text || part.actionIds.length) && !state?.queue?.some(work => work.status === 'running' && work.sourceMessageId === message.replyToId && work.companionId === message.authorId)) return null;
                const newDay = index === 0 || dayLabel(timelineMessages[index - 1]!.createdAt) !== dayLabel(message.createdAt);
                return <div key={message.id}>{newDay && <div className="companions-date-separator">{dayLabel(message.createdAt)}</div>}
                  {message.kind === 'notice' ? <div className={`companions-notice${message.status === 'failed' ? ' is-failed' : ''}`} data-companion-message={message.id}>{message.authorId !== 'system' && <small>内置欢迎 · {authorName(message.authorId)}</small>}<span>{message.content}</span>{message.status === 'failed' && <button onClick={() => void request({ type: 'reply.retry', conversationId: selected.id })}>重试回复</button>}</div> : <article className={`companions-message${own ? ' is-own' : ''}${highlightedId === message.id ? ' is-highlighted' : ''}`} data-companion-message={message.id}>
                    <Avatar companion={author} showPresence={false} /><div className="companions-message-body"><div className="companions-message-author">{authorName(message.authorId)}<time title={companionTimestamp(message.createdAt) + ' · ' + companionTimezone(message.createdAt)}>{clockTime(message.createdAt)}</time></div><CompanionMessageBubble message={message} replied={replied} quoteAuthor={replied ? authorName(replied.authorId) : undefined} actions={actions} now={clock} streamStore={replyStreams} interrupted={state?.recoveries?.some(item => item.conversationId === message.conversationId && item.sourceMessageId === message.replyToId && !item.completedIds.includes(message.authorId) && (item.status === 'interrupted' || item.status === 'cancelled')) ?? false} onOpenAction={openTaskProgress} onOpenUrl={url => void openMessageLink(url)} onOpenAttachment={openAttachment} onLocateQuote={id => void jumpToReference(id)} onStreamLayout={scrollStreamingReply} /><div className="companions-message-tools"><button aria-label={`引用消息 ${message.sequence}`} title="引用回复" onClick={() => { updateDraft({ reply: message }); composerRef.current?.focus(); }}><ChatGlyph name="reply" /></button>{message.content && !message.isReplyDraft && <button aria-label={`记住消息 ${message.sequence}`} title="记住这件事" onClick={() => rememberMessage(message)}><Icon name="heart" /></button>}{message.status === 'failed' && <button onClick={() => void request({ type: 'reply.retry', conversationId: selected.id })}>重试回复</button>}</div></div>
                  </article>}
                </div>;
              })}
              {hasNewer && <button className="companions-load-older" disabled={loadingNewer} onClick={() => void loadNewer()}>{loadingNewer ? '正在读取…' : '查看后续消息'}</button>}
              {state?.recoveries?.some(item => item.conversationId === selected.id && item.status === 'interrupted') && <div className="companions-recovery-notice"><span>上次回复还没说完，消息和进度已经保留。</span><button onClick={() => void request({ type: 'reply.resume', conversationId: selected.id }).then(() => refreshState())}>继续上次回复</button></div>}
              {activities.some(item => item.status === 'thinking') && <div className="companions-typing"><span /><span /><span /><span className="companions-typing-label">{activities.filter(item => item.status === 'thinking').map(item => `${authorName(item.companionId)}正在回复 · ${elapsedTime(item.startedAt || activityStarts[`${item.conversationId}/${item.companionId}/${item.status}`] || new Date(clock).toISOString(), clock)}`).join('；')}</span><button onClick={() => void request({ type: 'reply.cancel', conversationId: selected.id })}>取消回复</button></div>}
            </div>
            {(awayFromBottom || historyMode || newMessages) && <button className="companions-new-message" aria-label="回到最新消息" onClick={returnToLatest}><Icon name="download" />{newMessages ? '有新消息 · ' : ''}回到最新消息</button>}
            {!!queuedMessages.length && <aside className="companions-queue-dock" aria-label="待发消息队列">
              <span className="companions-queue-heading"><Icon name="clock" />排队中的消息 · {queuedMessages.length}</span>
              {queuedMessages.map(item => <div key={item.sourceMessageId} className="companions-queue-row">
                <span>{messages.find(message => message.id === item.sourceMessageId)?.content || '附件消息'}</span>
                <button disabled={!runningSources.length || runningSources.includes(item.sourceMessageId)} onClick={() => void guideQueued(item.sourceMessageId)}>立即引导</button>
              </div>)}
            </aside>}
            <section className="companions-composer" aria-label="消息输入区">
              {emojiOpen && <div className="companions-emoji-picker" aria-label="选择表情">{emojis.map(emoji => <button key={emoji} aria-label={`表情 ${emoji}`} onClick={() => { updateDraft({ content: draft.content + emoji }); setEmojiOpen(false); composerRef.current?.focus(); }}>{emoji}</button>)}</div>}
              {composerMore && <div className="companions-composer-menu"><button onClick={() => { setComposerMore(false); setShowMemoryManager(true); }}><Icon name="heart" />查看共同记忆</button></div>}
              {draft.reply && <div className="companions-draft-reply"><ChatGlyph name="reply" /><span>回复 {authorName(draft.reply.authorId)}：{draft.reply.content || '附件'}</span><button className="companion-icon-button" aria-label="取消引用" onClick={() => updateDraft({ reply: undefined })}>×</button></div>}
              {!!draft.attachments.length && <div className="companions-draft-attachments">{draft.attachments.map(item => <span key={item.id}>{item.mime.startsWith('image/') ? <ChatGlyph name="image" /> : <Icon name="file" />}<span>{item.name}</span><small>{bytes(item.size)}</small><button aria-label={`移除附件 ${item.name}`} onClick={() => updateDraft({ attachments: draft.attachments.filter(attachment => attachment.id !== item.id) })}>×</button></span>)}</div>}
              <textarea ref={composerRef} rows={2} aria-label="输入消息" placeholder={selected.kind === 'group' ? '和大家聊聊，@名字可以指定伙伴…' : `发消息给${selected.title}…`} value={draft.content} maxLength={16000} onChange={event => updateDraft({ content: event.target.value })} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); void send((event.ctrlKey || event.metaKey) && activities.length > 0); } }} />
              <div className="companions-composer-toolbar"><div className="companions-composer-tools"><button className="companion-icon-button" aria-label="发送文件或图片" title="发送文件" onClick={() => void pickAttachments()}><Icon name="plus" /></button><button className={`companion-icon-button${emojiOpen ? ' is-active' : ''}`} aria-label="表情" title="表情" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen(!emojiOpen); setComposerMore(false); }}><ChatGlyph name="smile" /></button><button className="companion-icon-button" aria-label="发送图片" title="发送图片" onClick={() => void pickAttachments('image')}><ChatGlyph name="image" /></button><button className={`companion-icon-button${composerMore ? ' is-active' : ''}`} aria-label="更多聊天操作" title="更多" aria-expanded={composerMore} onClick={() => { setComposerMore(!composerMore); setEmojiOpen(false); }}><ChatGlyph name="more" /></button></div><div className="companions-composer-send"><span>{sending ? '正在发送…' : draft.content.length > 15000 ? `${draft.content.length} / 16000` : 'Enter 发送 · Shift + Enter 换行'}</span><button className="companions-send-button" aria-label="发送" title="发送消息" disabled={sending || (!draft.content.trim() && !draft.attachments.length)} onClick={() => void send()}><ChatGlyph name="send" /></button></div></div>
            </section>
          </section>
          {showPanel && memoryOwner && <CompanionPlanner key={selected.id + '/' + memoryOwner.id} companion={memoryOwner} members={members} conversationId={selected.id} conversationKind={selected.kind} actions={actions} request={request} api={api} onOwnerChange={id => { setMemoryOwnerId(id); setMemoryDraft(undefined); }} onClose={() => setShowPanel(false)} onProfile={() => { setContactId(memoryOwner.id); setPage('contacts'); }} onMemory={() => setShowMemoryManager(true)} onTasks={() => { setSelectedTaskActionId(undefined); setShowTaskMonitor(true); }} onSchedules={() => setShowScheduleManager(true)} onWorld={() => setWorldCompanionId(memoryOwner.id)} onOpenAction={openTaskProgress} />}
        </div>}
    </main>
    {showMemoryManager && selected && memoryOwner && <CompanionMemoryManager companions={members} ownerId={memoryOwner.id} conversation={selected} request={request} api={api} draft={memoryDraft} onDraftConsumed={() => setMemoryDraft(undefined)} requestError={error} onDismissError={() => setError('')} authorName={authorName} onOwnerChange={id => { setMemoryOwnerId(id); setMemoryDraft(undefined); }} onClose={() => setShowMemoryManager(false)} onLocateSource={source => {
      setShowMemoryManager(false);
      if (source.conversationId === selectedRef.current) { if (source.memoryEvidenceOnly && source.actionId) openTaskProgress(source.actionId); else void jumpToMessage(source); return; }
      void (async () => {
        const room = state?.conversations.find(item => item.id === source.conversationId) ?? (await request({ type: 'conversation.reopen', id: source.conversationId }))?.conversation;
        if (!room) { setError('请先重新打开来源聊天，再查看原消息。'); return; }
        if (source.memoryEvidenceOnly && source.actionId) { selectConversation(room); openTaskProgress(source.actionId); }
        else { pendingJump.current = { ...source, excerpt: source.content.slice(0, 600) }; selectConversation(room); }
        void refreshState();
      })();
    }} />}
    {showScheduleManager && selected && memoryOwner && <CompanionScheduleManager key={selected.id + '/' + memoryOwner.id} companion={memoryOwner} conversationId={selected.id} conversationKind={selected.kind} request={request} api={api} requestError={error} onDismissError={() => setError('')} onClose={() => setShowScheduleManager(false)} />}
    {worldCompanionId !== null && <Suspense fallback={<div className="companions-modal-backdrop"><p>正在打开伙伴世界…</p></div>}><CompanionWorld api={api} companions={companions} initialCompanionId={worldCompanionId || undefined} active={isActive} onClose={() => setWorldCompanionId(null)} /></Suspense>}
    {guideMessageId && <div className="companions-modal-backdrop" onClick={() => setGuideMessageId(null)}><section className="companions-modal" role="dialog" aria-modal="true" aria-label="选择要引导的回复" onClick={event => event.stopPropagation()}>
      <header><h2>选择要引导的回复</h2><button className="companion-icon-button" aria-label="关闭引导选择" onClick={() => setGuideMessageId(null)}>×</button></header>
      <p className="companions-subtle">这条补充只会进入所选回复的下一步。</p>
      {runningSources.map(id => <button key={id} className="companions-guide-target" onClick={() => { const pending = guideMessageId; setGuideMessageId(null); void (pending === 'composer' ? send(true, id) : guideQueued(pending, id)); }}>
        <Icon name="activity" /><span>{messages.find(message => message.id === id)?.content || '正在处理的附件消息'}</span><Icon name="chevron" />
      </button>)}
    </section></div>}
    {showSearch && state && <CompanionHistorySearch request={request} conversations={state.conversations} companions={companions} conversationId={searchScope} onClose={() => setShowSearch(false)} onLocate={async hit => {
      const conversation = state.conversations.find(room => room.id === hit.conversationId) ?? (await request({ type: 'conversation.reopen', id: hit.conversationId }))?.conversation;
      if (!conversation) { setError('请先重新打开这个聊天，再查看记录。'); return; }
      setShowSearch(false);
      if (hit.conversationId !== selectedRef.current) { pendingJump.current = hit; selectConversation(conversation); }
      else void jumpToMessage(hit);
    }} />}
    {dialog && <CompanionDialogs key={dialog.kind === 'companion' ? 'companion-' + (dialog.companion?.id ?? 'new') : dialog.kind === 'group' ? 'group-' + (dialog.conversation?.id ?? 'new') : dialog.kind === 'action' ? 'action-' + dialog.message.id : dialog.kind === 'delete' ? 'delete-' + dialog.companion.id : dialog.kind === 'delete-conversation' ? 'delete-conversation-' + dialog.conversation.id : 'chat'} dialog={dialog} companions={companions} request={request} requestError={error} onClose={() => { setDialog(null); void refreshState(); }} onOpen={id => void openPrivate(id)} onCreated={selectConversation} builtins={BUILTIN_COMPANIONS} />}
    {previewAttachment && <CompanionImagePreview key={previewAttachment.id} attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} onReveal={() => void request({ type: 'attachment.open', id: previewAttachment.id })} />}
    {showTaskMonitor && <CompanionTaskMonitor initialActionId={selectedTaskActionId} conversationId={selectedId!} request={request} dshApi={dshApi} actions={actions} companions={companions} now={clock} onClose={() => { setShowTaskMonitor(false); setSelectedTaskActionId(undefined); }} onStop={id => void stopAction(id)} onResume={id => manageAction('action.resume', id)} onTerminate={id => manageAction('action.terminate', id)} onGuide={() => { setShowTaskMonitor(false); setSelectedTaskActionId(undefined); setTimeout(() => composerRef.current?.focus(), 0); }} onOpenUrl={url => void openMessageLink(url)} />}
  </div>;
}
