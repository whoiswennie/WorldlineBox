import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotCompanion, BotMessage, BotParticipationMode, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { useLocale } from '../i18n';
import './bot-workspace.css';
import './bot-group-chat.css';
import './bot-atmosphere.css';
import { BotWorldScene } from './BotWorldScene';
import { BotMessageBody } from './BotMessageBody';
import { BotPeerAvatar } from './BotPeerAvatar';
import { BotAvatar } from './BotAvatar';
import { BotCallWindow, type BotCallComposerOptions, type BotCallComposerSendBridge } from './BotCallWindow';
import { BotPresenceSummary, BotPresenceText } from './BotPresence';
import { builtinBotCompanion } from '../../shared/builtin-bot-companions';
import { orderBotConversations } from '../../shared/bot-conversation-order';
import { BotCompanionEditor, type BotCompanionEditorDraft, type BotCompanionSettingsSection } from './BotCompanionEditor';
import { BotGroupMembers } from './BotGroupMembers';
import { useBotConversationUpdates } from './BotConversationActivity';
import './bot-peer-observation.css';
import { BotComposer } from './BotComposer';
import { BotTopicBar } from './BotTopicBar';
import { BotIcon } from './BotIcon';
import { BotApps, BotAssetAppCard } from './BotApps';
import { BotBrowserContextCard, BotBrowserContextPicker } from './BotBrowserContext';
import type { BrowserPageContext } from '../../shared/browser-page-context';
import type { WorldlineBoxBrowserApi } from '../../shared/browser';
import { BotHistoryDialog } from './BotHistoryPanel';
import { BotReplyTiming } from './BotReplyTiming';
import { BotReplyProgressIndicator, botReplyProgressLabel } from './BotReplyProgress';
import { BotMemoryWorkspace } from './BotMemoryWorkspace';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import type { WorldlineBoxBotSpeechApi } from '../../shared/companion-bot-speech';
import { BotChatContext } from './BotChatContext';
import { BotExecutorNotice } from './BotExecutorNotice';
import { BotDshBindingDialog } from './BotDshBindingDialog';
import { hasSharedDshBinding, useBotDshBindings } from './useBotDshBindings';
import { isBotFilePaste } from './clipboard-paste';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
const ignoreLink = () => undefined;
const MESSAGE_WINDOW_LIMIT = 400;
const SIDEBAR_PAGE_SIZE = 40;
const orderedConversations = (snapshot: BotSnapshot) => orderBotConversations(snapshot.conversations, snapshot.conversationActivity);
const messageDay = (createdAt: string, locale: 'zh-CN' | 'en') => {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
};
const copy = {
  'zh-CN': { title: '伙伴', add: '新伙伴', group: '新群聊', world: '世界频道', chats: '聊天', contacts: '联系人', empty: '选择一位伙伴开始聊天',
    intro: '对话会一直保留在这里。伙伴通过 DSH 会话回复、查询记忆并完成工作。', send: '发送', placeholder: '发消息，Enter 发送，Shift + Enter 换行',
    name: '名字', persona: '人格与相处方式', create: '创建', save: '保存', cancel: '取消', settings: '模型设置', memory: '记忆',
    search: '查询', remember: '记住', memoryPlaceholder: '查询过去的事实，或保存一条明确的信息', stop: '停止', more: '查看更早消息',
    groupTitle: '聊天名称', members: '参与伙伴', loading: '正在打开伙伴…', unavailable: '伙伴服务尚未连接', edit: '角色卡',
    working: '正在回复', queued: '等待回复', failed: '回复失败', cancelled: '已停止', worldEvent: '发布世界事件', ready: '已就绪', boot: '按需启动',
    close: '关闭', noMemory: '没有匹配的记忆', runtime: '运行信息', memoryEngine: 'VCP Memory 记忆', error: '操作失败，请稍后重试。', user: '我', connected: '持续对话', scene: '世界场景',

    memoryRecords: '记忆记录', forget: '忘记', withdrawn: '已撤回这条记忆的使用', noRecords: '还没有记忆记录', saved: '已保存', indexed: '可召回', indexing: '索引处理中', indexFailed: '索引失败', owner: '伙伴',
    latest: '回到最新', newer: '有新消息', loadingLatest: '正在读取最新消息…',
    replyMode: '参与方式', automatic: '智能参与', all: '全体讨论', mentions: '仅点名回应', mentionHint: '@姓名 点名，@所有人 邀请全体',
    find: '搜索', space: '伙伴', welcomeHint: '聊聊近况，或者一起完成一件事。',
    reference: '形象设定', sharedIdentity: '两种形象，同一位大肥鱼。聊天与记忆始终相连。', keyboard: 'Enter 发送 · Shift + Enter 换行',
    private: '私聊', memoryHint: '回想曾经聊过的事，也可以保存或撤回一条记忆。'
  },
  en: { title: 'Companions', add: 'New companion', group: 'New group', world: 'World channel', chats: 'Chats', contacts: 'Contacts', empty: 'Choose a companion to start',
    intro: 'Your conversation stays here. Companions use DSH sessions to reply, recall memories and complete work.', send: 'Send', placeholder: 'Message · Enter to send · Shift + Enter for a new line',
    name: 'Name', persona: 'Personality and relationship', create: 'Create', save: 'Save', cancel: 'Cancel', settings: 'Model settings', memory: 'Memory',
    search: 'Search', remember: 'Remember', memoryPlaceholder: 'Find past facts or save something specific', stop: 'Stop', more: 'Earlier messages',
    groupTitle: 'Chat name', members: 'Participants', loading: 'Opening companions…', unavailable: 'Companion service is not connected', edit: 'Character card',
    working: 'Responding', queued: 'Queued', failed: 'Reply failed', cancelled: 'Stopped', worldEvent: 'Publish world event', ready: 'Ready', boot: 'Starts when needed',
    close: 'Close', noMemory: 'No matching memories', runtime: 'Runtime', memoryEngine: 'VCP Memory', error: 'The operation failed. Try again.', user: 'Me', connected: 'Continuous conversation', scene: 'World scene',

    memoryRecords: 'Memory records', forget: 'Forget', withdrawn: 'This memory has been withdrawn from use', noRecords: 'No memory records yet', saved: 'Saved', indexed: 'Available for recall', indexing: 'Indexing', indexFailed: 'Indexing failed', owner: 'Companion',
    latest: 'Back to latest', newer: 'New messages', loadingLatest: 'Loading latest messages…',
    replyMode: 'Participation', automatic: 'Smart participation', all: 'Everyone', mentions: 'Mentions only', mentionHint: '@Name to address someone · @all for everyone',
    find: 'Search', space: 'Companions', welcomeHint: 'Share your day, or work on something together.',
    reference: 'Character reference', sharedIdentity: 'Two appearances, one companion. Your conversation and memories stay together.', keyboard: 'Enter to send · Shift + Enter for a new line',
    private: 'Direct chat', memoryHint: 'Recall your conversations, save a memory, or withdraw one.'
  },
};

/** A conversation UI backed by one durable event runtime, with no legacy topic/job controllers. */
export function BotWorkspace({ api, mediaApi, speechApi, launcherApi, browserApi, browserContext, onOpenBrowserContext, onOpenLauncher, onOpenUrl = ignoreLink, isActive = true }: { api?: WorldlineBoxBotApi; mediaApi?: WorldlineBoxBotMediaApi; speechApi?: WorldlineBoxBotSpeechApi; launcherApi?: WorldlineBoxDshLauncherApi; browserApi?: WorldlineBoxBrowserApi; browserContext?: BrowserPageContext; onOpenBrowserContext?(id: string): void; onOpenLauncher?():void; onOpenSettings(): void; onOpenUrl?(url: string): void; isActive?: boolean }) {
  const { locale } = useLocale(), t = copy[locale];
  const bindings = useBotDshBindings(launcherApi);
  const [dismissedBinding, setDismissedBinding] = useState('');
  const [snapshot, setSnapshot] = useState<BotSnapshot>(), [selected, setSelected] = useState(''), [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [streams, setStreams] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<'companion' | 'group' | 'world' | null>(null), [editing, setEditing] = useState<BotCompanion>();
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [editorSection, setEditorSection] = useState<BotCompanionSettingsSection>('templates');
  const dialogEpoch = useRef(0);
  const [panel, setPanel] = useState<'memory' | 'history' | null>(null);
  const [callTarget, setCallTarget] = useState<{ conversationId: string; companionId: string }>();
  const composerSend = useRef<BotCallComposerSendBridge>(undefined);
  const registerComposerSend = useCallback((bridge?: BotCallComposerSendBridge) => { composerSend.current = bridge; }, []);
  const closeCall = useCallback(() => { composerSend.current = undefined; setCallTarget(undefined); }, []);
  const openCallUrl = useCallback((url: string) => { closeCall(); onOpenUrl(url); }, [closeCall, onOpenUrl]);
  const [showWorld, setShowWorld] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [peerOnly, setPeerOnly] = useState(false), [joiningPeer, setJoiningPeer] = useState('');
  const joiningPeers = useRef(new Set<string>());
  const [showContext, setShowContext] = useState(true);
  const [contactQuery, setContactQuery] = useState('');
  const [sidebarView, setSidebarView] = useState<'chats' | 'contacts'>('chats');
  const [sidebarPaging, setSidebarPaging] = useState({ key: '', page: 0 });
  const [pinning, setPinning] = useState<Record<string, boolean>>({});
  const [draftFiles, setDraftFiles] = useState<Record<string, BotMediaRef[]>>({}), [imports, setImports] = useState<Record<string, boolean>>({});
  const removedApps = useRef(new Set<string>());
  const [removedAppChoices, setRemovedAppChoices] = useState<Record<string, boolean>>({});
  const markAppRemoved = (key: string, removed: boolean) => { if (removed) removedApps.current.add(key); else removedApps.current.delete(key); setRemovedAppChoices(current => ({ ...current, [key]: removed })); };
  const [assetDrafts, setAssetDrafts] = useState<Record<string, boolean>>({});
  const [browserDrafts, setBrowserDrafts] = useState<Record<string, BrowserPageContext>>({}), [dismissedBrowserContext, setDismissedBrowserContext] = useState('');
  const [attachingBrowser, setAttachingBrowser] = useState(false), browserAttachmentPending = useRef(false);
  const browserAttachmentActivity = (active: boolean) => { browserAttachmentPending.current = active; setAttachingBrowser(active); };
  const browserPicker = browserContext?.referenceId !== dismissedBrowserContext ? browserContext : undefined;
  const [draggingFiles, setDraggingFiles] = useState(false), activeImports = useRef(new Set<string>());
  const locateAfterRender = useRef<string | undefined>(undefined);
  const [browsingHistory, setBrowsingHistory] = useState(false), [newMessages, setNewMessages] = useState(false), [loadingLatest, setLoadingLatest] = useState(false);
  const selectedRef = useRef(selected), generation = useRef(0), refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshotRef = useRef(snapshot), selectionEpoch = useRef(0), opening = useRef(0), sending = useRef(false), paging = useRef(false);
  const sendAttempts = useRef(new Map<string, { content: string; requestId: string; kind: 'message' | 'world'; attachmentIds: string[]; input?:BotRequest }>());
  const windowEpoch = useRef(0), historyMode = useRef(false), latestSeen = useRef(0), jumping = useRef(false), refreshAfterJump = useRef(false);
  const preserveScroll = useRef<{ messageId?: string; offset: number; top: number } | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  const draft = drafts[selected] ?? '';
  const setDraft = (value: string) => { const origin = selectedRef.current; setDrafts(current => ({ ...current, [origin]: value })); };
  const invalidate = useCallback(() => { ++generation.current; }, []);
  const selectConversation = useCallback((id: string) => {
    if (id === selectedRef.current) return;
    closeCall();
    selectedRef.current = id; ++selectionEpoch.current; ++generation.current;
    ++windowEpoch.current; historyMode.current = false; latestSeen.current = 0; jumping.current = false; refreshAfterJump.current = false; paging.current = false; preserveScroll.current = undefined;
    setBrowsingHistory(false); setNewMessages(false); setLoadingLatest(false);
    setSnapshot(current => current ? { ...current, messages: [], hasMore: false } : current);
    setSelected(id); setStreams({}); setPanel(null); setShowWorld(false); setShowMembers(false); setError(''); setDraggingFiles(false); locateAfterRender.current = undefined;
  }, [closeCall]);
  const request = useCallback(async (input: BotRequest): Promise<BotResponse> => {
    if (!api) return { ok: false, error: t.unavailable };
    const origin = 'conversationId' in input ? input.conversationId ?? '' : selectedRef.current;
    const scopedDialogRequest = input.type === 'conversation.members' || input.type === 'conversation.dissolve' || input.type === 'conversation.announcement' || input.type === 'topic.context';
    try {
      const result = await api.request(input);
      if (!result.ok && !scopedDialogRequest && origin === selectedRef.current) setError(result.error ?? t.error);
      return result;
    }
    catch { if (!scopedDialogRequest && origin === selectedRef.current) setError(t.error); return { ok: false, error: t.error }; }
  }, [api, t]);
  const refresh = useCallback(async (conversationId = selectedRef.current) => {
    if (jumping.current) { refreshAfterJump.current = true; return; }
    const revision = ++generation.current, epoch = windowEpoch.current;
    const result = await request({ type: 'state', ...(conversationId ? { conversationId } : {}) });
    if (generation.current !== revision || windowEpoch.current !== epoch || selectedRef.current !== conversationId || !result.snapshot) return;
    const incoming = result.snapshot;
    const next = incoming.messages.filter(message => message.conversationId === conversationId);
    if (historyMode.current) {
      if (next.some(message => message.sequence > latestSeen.current)) setNewMessages(true);
    } else latestSeen.current = next.at(-1)?.sequence ?? 0;
    setSnapshot(current => {
      const prior = current?.messages.filter(message => message.conversationId === conversationId) ?? [];
      if (historyMode.current) {
        const updates = new Map(next.map(message => [message.id, message]));
        return { ...incoming, messages: prior.map(message => updates.get(message.id) ?? message), hasMore: current?.hasMore ?? false };
      }
      // Global sequences can contain other conversations. Shared IDs, rather than
      // numeric adjacency, prove the two pages belong to one continuous window.
      const previousIds = new Set(prior.map(message => message.id));
      const overlap = next.some(message => previousIds.has(message.id));
      if (!prior.length || !next.length || !overlap) return { ...incoming, messages: next.slice(-MESSAGE_WINDOW_LIMIT), hasMore: incoming.hasMore || next.length > MESSAGE_WINDOW_LIMIT };
      const hadEarlier = !!prior.length && !!next.length && prior[0]!.sequence < next[0]!.sequence;
      const merged = new Map(prior.map(message => [message.id, message]));
      for (const message of next) merged.set(message.id, message);
      const combined = [...merged.values()].sort((a, b) => a.sequence - b.sequence);
      return { ...incoming, messages: combined.slice(-MESSAGE_WINDOW_LIMIT), hasMore: combined.length > MESSAGE_WINDOW_LIMIT || (hadEarlier ? current!.hasMore : incoming.hasMore) };
    });
    const active = new Set(incoming.messages.filter(message => ['queued', 'running'].includes(message.status)).map(message => message.id));
    setStreams(current => Object.fromEntries(Object.entries(current).filter(([id]) => active.has(id))));
    if (!conversationId) {
      const first = orderedConversations(incoming)[0];
      if (first) selectConversation(first.id);
    }
  }, [request, selectConversation]);
  const pinConversation = async (id: string, pinned: boolean) => {
    setPinning(current => ({ ...current, [id]: true }));
    try {
      const result = await request({ type: 'conversation.pin', conversationId: id, pinned });
      if (result.ok) {
        setSnapshot(current => current ? { ...current, conversations: current.conversations.map(item => item.id === id ? { ...item, pinned } : item) } : current);
        await refresh();
      } else setError(result.error ?? t.error);
    } finally { setPinning(current => ({ ...current, [id]: false })); }
  };
  useEffect(() => { if (isActive) void refresh(selected); }, [isActive, selected, refresh]);
  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onEvent(event => {
      if (event.type === 'data-cleared') {
        const room = snapshotRef.current?.conversations.find(item => item.id === selectedRef.current);
        if (event.companionId === '*' || room?.memberIds.includes(event.companionId)) {
          // A historical viewport must not retain erased rows when a fresh
          // state page is empty. Invalidate in-flight history responses too.
          ++generation.current; ++windowEpoch.current;
          historyMode.current = false; latestSeen.current = 0; paging.current = false;
          jumping.current = false; refreshAfterJump.current = false; preserveScroll.current = undefined;
          locateAfterRender.current = undefined; sendAttempts.current.clear();
          setBrowsingHistory(false); setNewMessages(false); setLoadingLatest(false); setStreams({}); setError(''); setAssetDrafts({}); setBrowserDrafts({}); removedApps.current.clear(); setRemovedAppChoices({});
          setSnapshot(current => current ? { ...current, messages: [], hasMore: false } : current);
          setDraftFiles(current => ({ ...current, [selectedRef.current]: [] }));
        }
        if (isActive) void refresh(); return;
      }
      if (!isActive) return;
      if (event.type === 'text') {
        if (event.conversationId !== selectedRef.current) return;
        const message = snapshotRef.current?.messages.find(item => item.id === event.messageId && item.conversationId === event.conversationId);
        if (message && !['queued', 'running'].includes(message.status)) return;
        if (historyMode.current && !message) setNewMessages(true);
        else setStreams(current => Object.fromEntries([...Object.entries(current).filter(([id]) => id !== event.messageId).slice(-63), [event.messageId, event.text.slice(0, 512000)]]));
        if (!message && !refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; void refresh(); }, 100);
        return;
      }
      if (event.type === 'error' && (!event.conversationId || event.conversationId === selectedRef.current)) setError(event.message);
      if (!refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = undefined; void refresh(); }, 100);
    });
    return () => { unsubscribe(); clearTimeout(refreshTimer.current); refreshTimer.current = undefined; invalidate(); };
  }, [api, isActive, refresh, invalidate]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    if (locateAfterRender.current) {
      const message = [...scroll.current.querySelectorAll<HTMLElement>('[data-bot-message]')].find(item => item.dataset.botMessage === locateAfterRender.current);
      message?.scrollIntoView?.({ block: 'center' }); locateAfterRender.current = undefined;
    } else if (preserveScroll.current) {
      const anchor = preserveScroll.current;
      const element = [...scroll.current.querySelectorAll<HTMLElement>('[data-bot-message]')].find(item => item.dataset.botMessage === anchor.messageId);
      scroll.current.scrollTop = element ? anchor.top + element.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - anchor.offset : 0;
      preserveScroll.current = undefined;
    } else if (!historyMode.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [selected, snapshot?.messages, streams]);
  const conversation = snapshot?.conversations.find(item => item.id === selected);
  const observing = conversation?.kind === 'peer';
  const conversationUpdates = useBotConversationUpdates({ activity: snapshot?.conversationActivity, conversations: snapshot?.conversations,
    readConversationId: isActive && conversation && !dialog && !showMembers && panel !== 'history' && panel !== 'memory' && !browsingHistory && !loadingLatest ? selected : undefined });
  const participants = conversation?.memberIds.flatMap(id => snapshot?.companions.find(item => item.id === id) ?? []) ?? [];
  const companion = participants[0];
  const bindingKey = `shared-dsh:${bindings.state?.instances.find(instance => instance.isDefault)?.id ?? 'unconfigured'}`;
  const bindingRequired = !!conversation && !observing && (!hasSharedDshBinding(bindings.state) || !!bindings.error);
  const bindingOpen = isActive && bindingRequired && !bindings.loading && !!bindings.state && dismissedBinding !== bindingKey && !dialog && !panel && !showMembers;
  const showBinding = () => setDismissedBinding('');
  useEffect(() => {
    let live = true;
    if (bindingRequired) void Promise.resolve().then(() => { if (live) closeCall(); });
    return () => { live = false; };
  }, [bindingRequired, closeCall]);
  const matchesContact = (name: string) => name.toLocaleLowerCase().includes(contactQuery.trim().toLocaleLowerCase());
  const matchingConversations = snapshot ? orderedConversations(snapshot).filter(item => (!peerOnly || item.kind === 'peer') && matchesContact(item.title)) : [];
  const matchingCompanions = snapshot?.companions.filter(item => matchesContact(item.name)) ?? [];
  const sidebarCount = sidebarView === 'chats' ? matchingConversations.length : matchingCompanions.length;
  const sidebarKey = `${sidebarView}:${peerOnly}:${contactQuery.trim().toLocaleLowerCase()}`;
  const sidebarPages = Math.max(1, Math.ceil(sidebarCount / SIDEBAR_PAGE_SIZE));
  const sidebarPage = Math.min(sidebarPaging.key === sidebarKey ? sidebarPaging.page : 0, sidebarPages - 1);
  const visibleConversations = matchingConversations.slice(sidebarPage * SIDEBAR_PAGE_SIZE, (sidebarPage + 1) * SIDEBAR_PAGE_SIZE);
  const visibleCompanions = matchingCompanions.slice(sidebarPage * SIDEBAR_PAGE_SIZE, (sidebarPage + 1) * SIDEBAR_PAGE_SIZE);
  const smartParticipationHint = locale === 'zh-CN' ? '伙伴按消息内容决定是否参与，可以安静、由一位回应，或由多位共同讨论。@姓名可直接点名。' : 'Companions decide when to join: stay quiet, respond individually, or discuss together. Mention someone to address them directly.';
  const hiddenMessages=new Set(snapshot?.chatRuntime?.hiddenMessageIds??[]);
  const messages = snapshot?.messages.filter(item => !hiddenMessages.has(item.id) && item.conversationId === selected && item.senderId !== 'task-service' && !(item.status === 'sent' && !item.content && !item.attachments?.length && !item.execution)) ?? [];
  const open = async (companionId: string) => {
    const requestNumber = ++opening.current, epoch = selectionEpoch.current;
    const result = await request({ type: 'conversation.open', companionId });
    if (requestNumber !== opening.current || epoch !== selectionEpoch.current || !result.conversationId) return;
    setPeerOnly(false); setSidebarView('chats'); selectConversation(result.conversationId); await refresh(result.conversationId);
  };
  const joinPeer = async () => {
    const origin = selectedRef.current, epoch = selectionEpoch.current;
    if (joiningPeers.current.has(origin) || snapshotRef.current?.conversations.find(item => item.id === origin)?.kind !== 'peer') return;
    joiningPeers.current.add(origin); setJoiningPeer(origin);
    try {
      const result = await request({ type: 'conversation.peer.join', conversationId: origin });
      if (!result.ok || !result.conversationId || selectedRef.current !== origin || selectionEpoch.current !== epoch) return;
      setPeerOnly(false); setSidebarView('chats'); selectConversation(result.conversationId); await refresh(result.conversationId);
    } finally { joiningPeers.current.delete(origin); setJoiningPeer(current => current === origin ? '' : current); }
  };
  const sendMessage = async (kind: 'message' | 'world' = 'message', sticker?: BotMediaRef, override?: { content: string; requestId: string; attachments: readonly BotMediaRef[]; bypassCallBridge: true }): Promise<BotResponse> => {
    if (bindingRequired) { showBinding(); return { ok: false, error: locale === 'zh-CN' ? '请先配置共享 DSH 执行环境，所有伙伴只需配置一次。' : 'Set up the shared DSH executor once for all companions.' }; }
    const files = override ? override.attachments : sticker ? [sticker] : draftFiles[selected] ?? [], attachmentIds = files.map(file => file.id);
    const content = override ? override.content : sticker ? '' : draft, conversationId = selected;
    if (observing || (!content.trim() && !files.length) || !selected || busy || sending.current || browserAttachmentPending.current || activeImports.current.has(selected)) return { ok: false };
    if (files.length > 16) { setError(locale === 'zh-CN' ? '每条消息最多发送16个附件，请分批发送。' : 'Send up to 16 attachments per message.'); return { ok: false }; }
    const previous = sendAttempts.current.get(conversationId);
    const appKey = conversationId + ':' + (snapshotRef.current?.chatRuntime?.topic?.id ?? '');
    const browserContextId = removedApps.current.has(appKey + ':browser') ? undefined : (browserDrafts[conversationId] ?? snapshotRef.current?.chatRuntime?.browserContext)?.referenceId;
    const apps = [...(!removedApps.current.has(appKey + ':asset-manager') && (assetDrafts[conversationId] || snapshotRef.current?.chatRuntime?.apps?.includes('asset-manager')) ? ['asset-manager' as const] : []), ...(browserContextId ? ['browser' as const] : [])];
    const requestId = override?.requestId ?? (previous?.content === content && previous.kind === kind && JSON.stringify(previous.attachmentIds) === JSON.stringify(attachmentIds) && (previous.input?.type === 'message.send' ? previous.input.browserContextId : undefined) === browserContextId && JSON.stringify(previous.input?.type === 'message.send' ? previous.input.apps : undefined) === JSON.stringify(apps) ? previous.requestId : crypto.randomUUID());
    const routing=snapshotRef.current?.chatRuntime,selectedTopicId=routing?.topic?.id;
    const topicId=selectedTopicId&&(!routing?.running.length||routing.running.every(active=>active.topicId!==selectedTopicId))?selectedTopicId:undefined;
    const input: BotRequest = previous?.requestId===requestId&&previous.input?previous.input:kind === 'world' ? { type: 'world.event', conversationId, content, requestId }
      : { type: 'message.send', conversationId, content, requestId, ...(topicId?{topicId}:{}), ...(attachmentIds.length ? { attachmentIds } : {}), ...(browserContextId ? { browserContextId } : {}), ...(apps ? { apps } : {}) };
    sendAttempts.current.set(conversationId, { content, requestId, kind, attachmentIds,input });
    let result: BotResponse = { ok: false };
    let dispatching: Promise<BotResponse> | undefined;
    // Voice retry retains this complete original action, including its native
    // composer lifecycle, after the first sendMessage invocation has returned.
    const perform = (): Promise<BotResponse> => {
      if (dispatching) return dispatching;
      if (sending.current) return Promise.resolve({ ok: false, error: t.error });
      sending.current = true; setBusy(true); setError('');
      dispatching = (async () => {
        try {
          result = await request(input);
          if (result.ok) {
            if (sendAttempts.current.get(conversationId)?.requestId === requestId) sendAttempts.current.delete(conversationId);
            if (!sticker) {
              setAssetDrafts(current => ({ ...current, [conversationId]: false }));
              setBrowserDrafts(current => { if (current[conversationId]?.referenceId !== browserContextId) return current; const next = { ...current }; delete next[conversationId]; return next; });
              setDrafts(current => current[conversationId] === content ? { ...current, [conversationId]: '' } : current);
              setDraftFiles(current => ({ ...current, [conversationId]: (current[conversationId] ?? []).filter(file => !attachmentIds.includes(file.id)) }));
            }
            if (selectedRef.current === conversationId) {
              if (historyMode.current) await jumpToLatest(); else await refresh(conversationId);
            }
          }
          return result;
        } finally { sending.current = false; setBusy(false); dispatching = undefined; }
      })();
      return dispatching;
    };
    try {
      if (!override?.bypassCallBridge && composerSend.current) await composerSend.current.send(content, requestId, perform);
      else await perform();
    } catch { if (!result.ok) setError(t.error); }
    return result;
  };
  const send = async (kind: 'message' | 'world' = 'message', sticker?: BotMediaRef) => (await sendMessage(kind, sticker)).ok;
  const addFiles = async (paths?: string[], paste = false) => {
    if (bindingRequired) { showBinding(); return; }
    const origin = selectedRef.current;
    if (!mediaApi || !origin || snapshotRef.current?.conversations.find(item => item.id === origin)?.kind === 'peer' || activeImports.current.has(origin)) return;
    activeImports.current.add(origin); setImports(current => ({ ...current, [origin]: true }));
    try {
      const result = await mediaApi.request(paths ? { type: 'files.import', conversationId: origin, paths } : { type: paste ? 'files.paste' : 'files.pick', conversationId: origin });
      if (result.ok && !result.cancelled) setDraftFiles(current => {
        const combined = new Map((current[origin] ?? []).map(file => [file.id, file])); for (const file of result.media ?? []) combined.set(file.id, file);
        return { ...current, [origin]: [...combined.values()] };
      });
      else if (!result.ok && selectedRef.current === origin) setError(result.error ?? t.error);
    } catch { if (selectedRef.current === origin) setError(t.error); }
    finally { activeImports.current.delete(origin); setImports(current => ({ ...current, [origin]: false })); }
  };
  const closeDialog = () => { ++dialogEpoch.current; setDialog(null); setEditing(undefined); };
  const saveDialog = async ({ name, persona, members, groupMode, workerConcurrency }: BotCompanionEditorDraft, epoch: number): Promise<BotResponse> => {
    const input: BotRequest = dialog === 'companion'
      ? editing ? { type: 'companion.update', companionId: editing.id, name, ...(persona !== undefined ? { persona } : {}), ...(workerConcurrency !== undefined ? { workerConcurrency } : {}) } : { type: 'companion.create', name, persona: persona ?? '', ...(workerConcurrency !== undefined ? { workerConcurrency } : {}) }
      : { type: 'conversation.create', title: name, kind: dialog === 'world' ? 'world' : 'group', memberIds: members,
        ...(dialog === 'group' ? { participationMode: groupMode } : {}) };
    let result: BotResponse;
    try { result = api ? await api.request(input) : { ok: false, error: t.unavailable }; }
    catch { result = { ok: false, error: t.error }; }
    // An old save may finish after cancel/reopen. It cannot close another draft.
    if (result.ok && dialogEpoch.current === epoch) { if (!editing) closeDialog(); if (result.conversationId) selectConversation(result.conversationId); await refresh(result.conversationId); }
    return result;
  };
  const startDialog = (kind: 'companion' | 'group' | 'world', target?: BotCompanion, section: BotCompanionSettingsSection = 'templates') => {
    setEditorEpoch(++dialogEpoch.current); setDialog(kind); setEditing(target); setEditorSection(section); setError('');
  };
  const earlier = async () => {
    const before = messages[0]?.sequence; if (!before || paging.current) return;
    if (!historyMode.current) { historyMode.current = true; ++windowEpoch.current; setBrowsingHistory(true); }
    const origin = selected, epoch = selectionEpoch.current, window = windowEpoch.current; paging.current = true; ++generation.current;
    const result = await request({ type: 'state', conversationId: origin, before });
    if (window === windowEpoch.current) paging.current = false;
    if (result.snapshot && selectedRef.current === origin && epoch === selectionEpoch.current && window === windowEpoch.current) {
      if (scroll.current) {
        const bounds = scroll.current.getBoundingClientRect();
        const elements = [...scroll.current.querySelectorAll<HTMLElement>('[data-bot-message]')];
        const anchor = elements.find(item => item.getBoundingClientRect().bottom > bounds.top) ?? elements[0];
        preserveScroll.current = { messageId: anchor?.dataset.botMessage, offset: (anchor?.getBoundingClientRect().top ?? bounds.top) - bounds.top, top: scroll.current.scrollTop };
      }
      setSnapshot(current => current ? {
        ...current, hasMore: result.snapshot!.hasMore,
        messages: [...result.snapshot!.messages.filter(old => old.conversationId === origin && !current.messages.some(message => message.id === old.id)), ...current.messages]
          .sort((a, b) => a.sequence - b.sequence).slice(0, MESSAGE_WINDOW_LIMIT),
      } : result.snapshot);
    }
  };
  const jumpToLatest = async () => {
    if (!selected) return;
    if (jumping.current) { refreshAfterJump.current = true; return; }
    const origin = selected, epoch = ++windowEpoch.current, revision = ++generation.current;
    jumping.current = true; paging.current = false; preserveScroll.current = undefined; setLoadingLatest(true);
    try {
      const result = await request({ type: 'state', conversationId: origin });
      if (selectedRef.current !== origin || epoch !== windowEpoch.current || revision !== generation.current || !result.snapshot) return;
      const incoming = result.snapshot, messages = incoming.messages.filter(message => message.conversationId === origin).slice(-MESSAGE_WINDOW_LIMIT);
      historyMode.current = false; latestSeen.current = messages.at(-1)?.sequence ?? 0; setBrowsingHistory(false); setNewMessages(false); setStreams({});
      setSnapshot({ ...incoming, messages, hasMore: incoming.hasMore || incoming.messages.length > MESSAGE_WINDOW_LIMIT });
    } finally {
      if (epoch === windowEpoch.current) {
        jumping.current = false; setLoadingLatest(false);
        if (refreshAfterJump.current) { refreshAfterJump.current = false; void refresh(origin); }
      }
    }
  };
  const status = (message: BotMessage) => {
    return message.status === 'running' ? t.working : message.status === 'queued' ? t.queued : message.status === 'failed' ? t.failed : message.status === 'cancelled' ? t.cancelled : '';
  };
  const locateMessage = async (message: BotMessage) => {
    const origin = selectedRef.current;
    if (message.conversationId !== origin) return;
    const epoch = ++windowEpoch.current, revision = ++generation.current;
    const result = await request({ type: 'state', conversationId: origin, before: message.sequence + 1 });
    if (!result.snapshot || selectedRef.current !== origin || windowEpoch.current !== epoch || generation.current !== revision) return;
    historyMode.current = true; jumping.current = false; paging.current = false; preserveScroll.current = undefined;
    setBrowsingHistory(true); setNewMessages(false); setLoadingLatest(false); setStreams({}); locateAfterRender.current = message.id;
    setSnapshot({ ...result.snapshot, messages: result.snapshot.messages.filter(item => item.conversationId === origin).slice(-MESSAGE_WINDOW_LIMIT) });
  };
  const callCompanion = callTarget && snapshot?.companions.find(item => item.id === callTarget.companionId);
  const selectedAppKey = selected + ':' + (snapshot?.chatRuntime?.topic?.id ?? '');
  const assetAttached = !removedAppChoices[selectedAppKey + ':asset-manager'] && (!!assetDrafts[selected] || !!snapshot?.chatRuntime?.apps?.includes('asset-manager'));
  const attachedBrowser = removedAppChoices[selectedAppKey + ':browser'] ? undefined : browserDrafts[selected] ?? snapshot?.chatRuntime?.browserContext;
  const renderComposer = (options?: BotCallComposerOptions) => bindingRequired ? <div className="bot-binding-blocked" role="status"><div><strong>{locale === 'zh-CN' ? bindings.loading ? '正在检查共享 DSH…' : '配置共享 DSH 后开始聊天' : bindings.loading ? 'Checking shared DSH…' : 'Set up shared DSH to chat'}</strong><p>{bindings.error || (locale === 'zh-CN' ? '所有伙伴共用账号、API、插件和技能，只需配置一次。已有聊天记录仍可查看。' : 'All companions share one account, API configuration, plugins and skills. Existing history remains available.')}</p></div><button type="button" disabled={bindings.loading} onClick={() => { showBinding(); if (!bindings.state) void bindings.refresh(); }}>{locale === 'zh-CN' ? bindings.state ? '配置 DSH' : '重新检查' : bindings.state ? 'Set up DSH' : 'Check again'}</button></div> : conversation?.kind === 'direct' && companion?.enabled === false ? <div className="bot-companion-disabled" role="status"><div><strong>{locale === 'zh-CN' ? `${companion.name}已关闭` : `${companion.name} is disabled`}</strong><p>{locale === 'zh-CN' ? '启用伙伴后可以继续聊天。已有聊天记录已保留。' : 'Enable this companion to continue chatting. Your chat history is preserved.'}</p></div><button type="button" disabled={busy} onClick={() => void request({ type: 'companion.runtime', companionId: companion.id, operation: 'start' }).then(result => { if (result.ok) void refresh(); })}>{locale === 'zh-CN' ? '启用伙伴' : 'Enable companion'}</button></div> : <BotComposer key={selected} locale={locale} draft={draft} setDraft={setDraft} disabled={!selected} busy={busy || attachingBrowser} group={conversation?.kind === 'group'} world={conversation?.kind === 'world'} mentionMembers={conversation && conversation.kind !== 'direct' ? participants : undefined} panel={panel} setPanel={next => { if (next && callTarget) closeCall(); setPanel(next); }} send={send}
    mediaApi={mediaApi} conversationId={selected} attachments={draftFiles[selected] ?? []} addingFiles={imports[selected]} addFiles={() => addFiles()} removeFile={id => setDraftFiles(current => ({ ...current, [selected]: (current[selected] ?? []).filter(file => file.id !== id) }))} sendSticker={async media => { await send('message', media); }} sendVoice={async media => { if (!await send('message', media)) throw Error(locale === 'zh-CN' ? '语音未发送，请重试。录音已保留。' : 'Voice message was not sent. Your recording is retained.'); }}
    topicControls={!options&&<><BotTopicBar key={selected} conversationId={selected} runtime={snapshot?.chatRuntime} members={participants} locale={locale} request={request} refresh={()=>refresh(selected)}/>{assetAttached && <BotAssetAppCard locale={locale} connected={!assetDrafts[selected]} onRemove={() => { markAppRemoved(selectedAppKey + ':asset-manager', true); setAssetDrafts(current => ({ ...current, [selected]: false })); const topicId = snapshot?.chatRuntime?.topic?.id; if (topicId && snapshot?.chatRuntime?.apps?.includes('asset-manager')) void request({ type: 'app.detach', conversationId: selected, topicId, appId: 'asset-manager' }).then(() => refresh(selected)); }} />}{attachedBrowser && <BotBrowserContextCard context={attachedBrowser!} locale={locale} onOpen={onOpenBrowserContext ? () => onOpenBrowserContext(attachedBrowser!.tabId) : undefined} onRemove={() => { markAppRemoved(selectedAppKey + ':browser', true); setBrowserDrafts(current => { const next = { ...current }; delete next[selected]; return next; }); const topicId = snapshot?.chatRuntime?.topic?.id; if (topicId && snapshot?.chatRuntime?.apps?.includes('browser')) void request({ type: 'app.detach', conversationId: selected, topicId, appId: 'browser' }).then(() => refresh(selected)); }} />}</>}
    extraTools={<>{options?.toolbar}<BotApps key={selected} locale={locale} disabled={busy || attachingBrowser} browserAvailable={!!browserApi} browserApi={browserApi} browserContext={attachedBrowser} onBrowserActivityChange={browserAttachmentActivity} assetAttached={assetAttached} onBrowser={async context => {
      markAppRemoved(selectedAppKey + ':browser', false); setBrowserDrafts(current => ({ ...current, [selected]: context }));
    }} onAssets={async () => {
      const result = await request({ type: 'app.connect', conversationId: selected, appId: 'asset-manager' });
      if (!result.ok) throw Error(result.error ?? '连接失败'); markAppRemoved(selectedAppKey + ':asset-manager', false); setAssetDrafts(current => ({ ...current, [selected]: true }));
    }} /></>} cornerControl={options?.corner} status={options && <>{options.status}{error && <p className="bot-call-send-error" role="alert">{error}</p>}</>} onVoiceInputStart={options?.onVoiceInputStart} onVoiceInputActivity={options?.onVoiceInputActivity} returnToChatOnPanel={!!options} />;
  return <div className={`bot-workspace bot-atmosphere${conversation ? ` has-context${showContext ? '' : ' context-collapsed'}` : ''}${dialog || panel === 'memory' || callTarget ? ' is-modal-open' : ''}`}>
    <div className="bot-window-chrome"><span>WorldlineBox <span>/</span> {t.space}</span></div>
    <aside className="bot-sidebar">
      <header><h1>{t.title}</h1><button onClick={() => startDialog('companion')} title={t.add} aria-label={t.add}><BotIcon name="plus" /></button></header>
      <div className="bot-contact-search"><BotIcon name="search" /><input aria-label={t.find} placeholder={t.find} value={contactQuery} onChange={event => setContactQuery(event.target.value)} /></div>
      <div className="bot-sidebar-shortcuts"><button onClick={() => startDialog('group')}><BotIcon name="users" />{t.group}</button><button aria-pressed={sidebarView === 'chats' && peerOnly} onClick={() => { setSidebarView('chats'); setPeerOnly(current => sidebarView === 'chats' ? !current : true); setContactQuery(''); }}><BotIcon name="profile" />{locale === 'zh-CN' ? '伙伴私聊' : 'Companion chats'}{conversationUpdates.hasPeerUpdates && <span className="bot-peer-unread-dot" aria-label={locale === 'zh-CN' ? '伙伴私聊有新消息' : 'New companion messages'} />}</button></div>
      <div className="bot-sidebar-tabs" role="tablist" aria-label={t.title}><button role="tab" aria-selected={sidebarView === 'chats'} onClick={() => { setSidebarView('chats'); setPeerOnly(false); }}>{t.chats}</button><button role="tab" aria-selected={sidebarView === 'contacts'} onClick={() => setSidebarView('contacts')}>{t.contacts}<span>{snapshot?.companions.length ?? 0}</span></button></div>
      <div className="bot-scroll">{sidebarView !== 'contacts' ? visibleConversations.map(item => <div className={`bot-conversation-row${item.pinned ? ' is-pinned' : ''}`} key={item.id}><button className={`bot-contact bot-conversation ${selected === item.id ? 'selected' : ''}`} aria-current={selected === item.id ? 'page' : undefined} onClick={() => selectConversation(item.id)}>
        {item.kind === 'group' || item.kind === 'peer' ? <BotPeerAvatar companions={item.memberIds.flatMap(id => snapshot?.companions.find(person => person.id === id) ?? [])} presence={snapshot?.presence} locale={locale} /> : <BotAvatar companion={item.kind === 'direct' ? snapshot?.companions.find(person => item.memberIds.includes(person.id)) : undefined} presence={item.kind === 'direct' ? snapshot?.presence?.[item.memberIds.find(id => id !== 'user') ?? ''] : undefined} locale={locale} name={item.title} symbol={item.kind === 'world' ? '◎' : undefined} />}<span className="bot-conversation-copy"><span className="bot-conversation-title"><strong>{item.title}</strong>{conversationUpdates.unread(item.id) && <i className="bot-conversation-unread" aria-label={locale === 'zh-CN' ? '有新消息' : 'New messages'} />}</span>{item.kind === 'direct' && (snapshot?.companions.find(person => item.memberIds.includes(person.id))?.enabled === false || snapshot?.presence?.[item.memberIds.find(id => id !== 'user') ?? '']) && <small className="bot-contact-status"><BotPresenceText presence={snapshot?.presence?.[item.memberIds.find(id => id !== 'user') ?? '']} locale={locale} enabled={snapshot?.companions.find(person => item.memberIds.includes(person.id))?.enabled} /></small>}{item.kind !== 'direct' && <small>{item.kind === 'peer' ? locale === 'zh-CN' ? '伙伴私聊 · 旁观' : 'Companion chat · Observing' : locale === 'zh-CN' ? `${item.memberIds.length} 位成员${item.kind === 'world' ? ' · 世界记录' : ''}` : `${item.memberIds.length} members${item.kind === 'world' ? ' · World record' : ''}`}</small>}{snapshot?.conversationActivity?.[item.id] && <small className="bot-conversation-preview">{snapshot?.conversationActivity?.[item.id]?.senderName}：{snapshot?.conversationActivity?.[item.id]?.preview}</small>}</span>
      </button><button type="button" className="bot-conversation-pin" aria-label={`${locale === 'zh-CN' ? item.pinned ? '取消置顶聊天' : '置顶聊天' : item.pinned ? 'Unpin chat' : 'Pin chat'} · ${item.title}`} title={locale === 'zh-CN' ? item.pinned ? '已置顶 · 点击取消置顶' : '置顶聊天' : item.pinned ? 'Pinned · Click to unpin' : 'Pin chat'} aria-pressed={!!item.pinned} disabled={pinning[item.id]} onClick={() => void pinConversation(item.id, !item.pinned)}><BotIcon name={item.pinned ? 'pin-filled' : 'pin'} /></button></div>) : visibleCompanions.map(item => <button className="bot-contact" key={item.id} onClick={() => void open(item.id)}><BotAvatar companion={item} presence={snapshot?.presence?.[item.id]} locale={locale} /><span><strong>{item.name}</strong>{(item.enabled === false || snapshot?.presence?.[item.id]) && <small className="bot-contact-status"><BotPresenceText presence={snapshot?.presence?.[item.id]} locale={locale} enabled={item.enabled} /></small>}<small>{builtinBotCompanion(item.id)?.summary ?? item.persona.slice(0, 42)}</small></span></button>)}
      {!sidebarCount && snapshot && !(sidebarView === 'chats' && peerOnly && !contactQuery) && <p className="bot-sidebar-no-results">{locale === 'zh-CN' ? '没有匹配的聊天或伙伴' : 'No matching chats or companions'}</p>}</div>
      {sidebarPages > 1 && <nav className="bot-sidebar-pagination" aria-label={locale === 'zh-CN' ? '聊天列表分页' : 'Chat list pages'}><span>{locale === 'zh-CN' ? `${sidebarCount} 项` : `${sidebarCount} items`}</span><button type="button" disabled={!sidebarPage} aria-label={locale === 'zh-CN' ? '上一页聊天' : 'Previous chats'} onClick={() => setSidebarPaging({ key: sidebarKey, page: sidebarPage - 1 })}>‹</button><small>{sidebarPage + 1} / {sidebarPages}</small><button type="button" disabled={sidebarPage + 1 >= sidebarPages} aria-label={locale === 'zh-CN' ? '下一页聊天' : 'Next chats'} onClick={() => setSidebarPaging({ key: sidebarKey, page: sidebarPage + 1 })}>›</button></nav>}
    </aside>
    <main className={`bot-main${conversation?.kind === 'group' ? ' is-group-conversation' : ''}`}>
      <header className={`bot-chat-header${conversation?.kind === 'group' ? ' is-group' : ''}`}><div className="bot-chat-identity">{conversation?.kind === 'group' ? <button className="bot-group-avatar-trigger" type="button" aria-label={locale === 'zh-CN' ? '查看群聊成员' : 'View group members'} onClick={() => setShowMembers(true)}><BotPeerAvatar companions={participants} presence={snapshot?.presence} locale={locale} /></button> : observing ? <BotPeerAvatar companions={participants} presence={snapshot?.presence} locale={locale} /> : <BotAvatar companion={conversation?.kind === 'direct' ? companion : undefined} presence={conversation?.kind === 'direct' && companion ? snapshot?.presence?.[companion.id] : undefined} locale={locale} symbol={conversation?.kind === 'world' ? '◎' : undefined} name={conversation?.title ?? t.title} />}<div className="bot-chat-title"><h2>{conversation?.title ?? t.title}</h2><div className="bot-chat-title-status">{observing && <span className="bot-peer-header-label"><BotIcon name="profile" />{locale === 'zh-CN' ? '伙伴私聊 · 旁观' : 'Companion chat · Observing'}</span>}{conversation?.kind === 'group' && <button type="button" className="bot-group-members-trigger" aria-label={locale === 'zh-CN' ? '管理群聊成员' : 'Manage group members'} onClick={() => setShowMembers(true)} title={[conversation.memberIds.includes('user') ? t.user : '', ...participants.map(person => person.name)].filter(Boolean).join('、')}><BotIcon name="users" />{locale === 'zh-CN' ? `${conversation.memberIds.length} 位成员 · ${conversation.memberIds.includes('user') ? '你在群中' : '仅查看'}` : `${conversation.memberIds.length} members · ${conversation.memberIds.includes('user') ? 'You are a member' : 'View only'}`}</button>}{conversation?.kind === 'direct' && !participants.some(person => snapshot?.presence?.[person.id]) && <span className="bot-chat-subtitle">{t.private} · {t.connected}</span>}{!observing && <BotPresenceSummary companions={participants} presence={snapshot?.presence} locale={locale} />}</div></div></div><nav aria-label={t.title}>
        {conversation?.kind === 'group' && <label className="bot-group-policy" title={smartParticipationHint}>{t.replyMode}<select aria-label={t.replyMode} aria-description={smartParticipationHint} value={conversation.participationMode ?? 'all'} onChange={event => {
          const origin = selected;
          void request({ type: 'conversation.policy', conversationId: origin, participationMode: event.target.value as BotParticipationMode }).then(result => {
            if (result.ok && selectedRef.current === origin) void refresh(origin);
          });
        }}><option value="automatic">{t.automatic}</option><option value="all">{t.all}</option><option value="mentions">{t.mentions}</option></select></label>}
        {conversation?.kind === 'group' && !observing && <button type="button" disabled={busy || !api} onClick={() => {
          const origin = selected; setBusy(true);
          void api?.request({ type: 'message.send', conversationId: origin, requestId: crypto.randomUUID(), content: locale === 'zh-CN' ? '停止讨论' : 'stop' }).then(result => {
            if (!result.ok) setError(result.error ?? (locale === 'zh-CN' ? '停止讨论失败' : 'Could not stop the discussion'));
            if (selectedRef.current === origin) void refresh(origin);
          }).catch(failure => setError(String(failure))).finally(() => setBusy(false));
        }}>{locale === 'zh-CN' ? '停止讨论' : 'Stop discussion'}</button>}
        {conversation?.kind === 'world' && <button aria-pressed={showWorld} onClick={() => setShowWorld(!showWorld)}>{t.scene}</button>}
        {companion && conversation?.kind === 'direct' && conversation.memberIds.includes('user') && <button className="bot-call-entry" disabled={companion.enabled === false || bindingRequired} aria-label={locale === 'zh-CN' ? '拨打伙伴电话' : 'Call companion'} title={locale === 'zh-CN' ? '发起文字会面' : 'Start a text conversation'} onClick={() => setCallTarget({ conversationId: selected, companionId: companion.id })}><BotIcon name="phone" /><span>{locale === 'zh-CN' ? '拨号' : 'Call'}</span></button>}
        {companion && conversation?.kind === 'direct' && <button onClick={() => startDialog('companion', companion)}><BotIcon name="profile" />{t.edit}</button>}
      </nav></header>
      {error && <div className="bot-error" role="alert">{error}<button aria-label={t.close} onClick={() => setError('')}>×</button></div>}
      {!bindingRequired && <BotExecutorNotice api={launcherApi} zh={locale==='zh-CN'} companionIds={participants.map(person=>person.id)} onOpenLauncher={onOpenLauncher} />}
      {!bindingRequired && showWorld && conversation?.kind === 'world' && api && companion && <BotWorldScene key={`${selected}:${companion.id}`} api={api} conversationId={selected} companionId={companion.id} isActive={isActive} />}
      <div className="bot-chat-body">
        <section className={`bot-thread-column${draggingFiles ? ' is-file-drag' : ''}`} aria-label={conversation?.title ?? t.title}
          onPaste={event => { if (!bindingRequired && !observing && mediaApi && isBotFilePaste(event.clipboardData, () => mediaApi.hasClipboardFiles?.(selected) ?? false)) { event.preventDefault(); void addFiles(undefined, true); } }}
          onDragOver={event => { if (mediaApi && selected && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = bindingRequired || observing ? 'none' : 'copy'; if (!bindingRequired && !observing) setDraggingFiles(true); } }}
          onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggingFiles(false); }}
          onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDraggingFiles(false); if (bindingRequired || observing) return; const paths = mediaApi?.getDroppedFilePaths([...event.dataTransfer.files]) ?? []; if (paths.length) void addFiles(paths); }}>
        {draggingFiles && <div className="bot-file-drop-hint">{locale === 'zh-CN' ? '松开鼠标，添加到当前聊天' : 'Drop files into this chat'}</div>}
        <div className="bot-transcript" role="log" aria-live="polite" ref={scroll}>
          {!snapshot ? <div className="bot-empty">{api ? t.loading : t.unavailable}</div> : !conversation ? <div className="bot-empty"><h2>{t.empty}</h2><p>{t.intro}</p><button onClick={() => startDialog('companion')}>{t.add}</button></div> : <>
            {!messages.length && <div className="bot-empty bot-conversation-welcome">{observing ? <BotPeerAvatar companions={participants} locale={locale} /> : <BotAvatar companion={companion} name={conversation.title} large />}<h2>{observing ? locale === 'zh-CN' ? '这两位伙伴还没有私聊记录' : 'No conversation between these companions yet' : locale === 'zh-CN' ? `想和${conversation.kind === 'direct' ? companion?.name ?? conversation.title : '伙伴们'}聊些什么？` : 'What would you like to talk about?'}</h2><p>{observing ? locale === 'zh-CN' ? '他们交流时，消息会出现在这里。打开记录不会替他们发言。' : 'Their messages will appear here. Opening this view does not send a message.' : t.welcomeHint}</p></div>}
            {browsingHistory && <div className="bot-sidebar-actions">{newMessages && <span role="status">{t.newer}</span>}<button disabled={loadingLatest} onClick={() => void jumpToLatest()}>{t.latest}</button></div>}
            {loadingLatest && <p role="status">{t.loadingLatest}</p>}
            {snapshot.hasMore && <button className="bot-earlier" disabled={loadingLatest} onClick={() => void earlier()}>{t.more}</button>}
            {messages.map((message, index) => <Fragment key={message.id}>{messageDay(message.createdAt, locale) && (index === 0 || messageDay(message.createdAt, locale) !== messageDay(messages[index - 1]!.createdAt, locale)) && <div className="bot-chat-day"><time dateTime={message.createdAt}>{messageDay(message.createdAt, locale)}</time></div>}<article key={message.id} data-bot-message={message.id} className={`bot-message ${message.senderId === 'user' ? 'from-user' : ''}`}>
              <div className="bot-message-avatar"><BotAvatar companion={snapshot.companions.find(item => item.id === message.senderId)} name={message.senderId === 'user' ? t.user : message.senderName} /></div>
              <div className="bot-message-content"><div className="bot-message-author">{message.senderId === 'user' ? t.user : message.senderName}<time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString(locale)}>{new Date(message.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}</time>{message.senderId !== 'user' && !['queued', 'running'].includes(message.status) && <BotReplyTiming timing={message.timing} locale={locale} />}{!observing&&message.topic&&message.topic.id!==snapshot.chatRuntime?.topic?.id&&<button className="bot-message-topic" type="button" title={`${locale==='zh-CN'?'接续这个话题':'Continue this topic'} · ${message.topic.title}`} onClick={()=>void request({type:'topic.select',conversationId:selected,topicId:message.topic!.id}).then(result=>{if(result.ok)void refresh(selected);})}><BotIcon name="history"/><span>{message.topic.title}</span></button>}</div>
              <BotMessageBody message={message} streamedText={streams[message.id]} statusText={status(message)} locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} onOpenBrowserContext={onOpenBrowserContext} onAnswer={(questionId, text) => request({ type: 'execution.answer', messageId: message.id, questionId, text })} onContinue={observing ? undefined : requestId => request({type:'execution.continue',messageId:message.id,requestId})} />
              {message.error && <small className="bot-message-error">{message.error}</small>}
              {message.senderId !== 'user' && ['queued', 'running'].includes(message.status) && (observing ? <p role="status" className="bot-peer-observer-progress"><BotIcon name="clock" />{botReplyProgressLabel(message.status, message.progress, locale)}</p> : <BotReplyProgressIndicator message={message} locale={locale} onStop={() => void request({ type: 'reply.cancel', messageId: message.id }).then(() => refresh())} />)}
              </div>
            </article></Fragment>)}
          </>}
        </div>
        {observing ? <div className="bot-peer-observer-dock"><div><BotIcon name="profile" /><span><strong>{locale === 'zh-CN' ? '正在旁观伙伴私聊' : 'Observing a companion conversation'}</strong><small>{locale === 'zh-CN' ? '这里仅有两位伙伴，用户不能代替他们发言。' : 'Only the two companions are members. You cannot speak on their behalf.'}</small></span></div><button type="button" aria-pressed={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}><BotIcon name="history" />{locale === 'zh-CN' ? '聊天记录' : 'History'}</button><button type="button" disabled={joiningPeer === selected} onClick={() => void joinPeer()}>{locale === 'zh-CN' ? '创建群聊，一起参与' : 'Create a group to participate'}</button></div> : conversation?.kind === 'group' && !conversation.memberIds.includes('user') ? <div className="bot-peer-viewing"><BotIcon name="users" />{locale === 'zh-CN' ? '当前聊天仅可查看。' : 'This chat is view only.'}</div> : !callTarget && renderComposer()}
        </section>
      </div>
    </main>
    {showContext && conversation && <BotChatContext key={selected} conversation={conversation} companions={participants} presence={snapshot?.presence} locale={locale} onClose={() => setShowContext(false)} onEdit={person => startDialog('companion', person)} onMemory={() => setPanel('memory')} onMembers={() => setShowMembers(true)} onContact={id => void open(id)} onJoinPeer={() => void joinPeer()} joiningPeer={joiningPeer === selected} request={request} onChanged={() => void refresh(selected)} />}
    {!showContext && conversation && <div className="bot-context-collapsed"><button type="button" onClick={() => setShowContext(true)} aria-expanded="false" aria-label={locale === 'zh-CN' ? '展开聊天信息' : 'Expand chat information'} title={locale === 'zh-CN' ? '展开聊天摘要' : 'Expand chat summary'}><BotIcon name="panel-expand" /></button></div>}
    {panel === 'memory' && !observing && api && <BotMemoryWorkspace key={selected} api={api} conversationId={selected} companions={participants} locale={locale} title={conversation?.title ?? t.title} onClose={() => setPanel(null)} />}
    {panel === 'history' && api && <BotHistoryDialog key={selected} api={api} conversationId={selected} locale={locale} companions={snapshot?.companions}
      title={conversation?.title ?? t.title} onClose={() => setPanel(null)} onLocate={message => { setPanel(null); void locateMessage(message); }} />}
    {showMembers && conversation?.kind === 'group' && <BotGroupMembers conversation={conversation} companions={snapshot?.companions ?? []} presence={snapshot?.presence} locale={locale} request={request} onChanged={() => refresh()} onClose={() => setShowMembers(false)} onDissolved={() => { setShowMembers(false); selectConversation(''); void refresh(''); }} />}
    {dialog && <BotCompanionEditor key={editorEpoch} kind={dialog} companion={snapshot?.companions.find(person => person.id === editing?.id) ?? editing} companions={snapshot?.companions ?? []} locale={locale} api={api} launcherApi={launcherApi} onOpenLauncher={onOpenLauncher} initialSection={editorSection} suspended={!!callTarget} onRuntimeChanged={() => { closeCall(); void refresh(); }} onMeet={!bindingRequired && editing && editing.enabled !== false && conversation?.kind === 'direct' && companion?.id === editing.id ? () => setCallTarget({ conversationId: selected, companionId: editing.id }) : undefined} onPersonaChanged={() => { if (dialogEpoch.current === editorEpoch) void refresh(); }}
      onSave={draft => saveDialog(draft, editorEpoch)} onCancel={closeDialog} />}
    {!bindingRequired && callTarget && callCompanion && callTarget.conversationId === selected && <BotCallWindow key={`${callTarget.conversationId}:${callTarget.companionId}`} conversationId={callTarget.conversationId} companion={callCompanion} messages={snapshot?.messages.filter(message => message.conversationId === callTarget.conversationId) ?? []} streams={streams} mediaApi={mediaApi} speechApi={speechApi} locale={locale} onHangup={closeCall} onOpenUrl={openCallUrl} composer={renderComposer} registerComposerSend={registerComposerSend} hasPendingDraft={!!draft.trim() || !!draftFiles[selected]?.length || !!imports[selected]} sendError={error}
      answer={(messageId, questionId, text) => request({ type: 'execution.answer', messageId, questionId, text })}
      onEditText={text => setDrafts(current => ({ ...current, [selected]: current[selected] ? `${current[selected]}\n${text}` : text }))}
      onDropFiles={files => { if (bindingRequired || observing) return; const paths = mediaApi?.getDroppedFilePaths(files) ?? []; if (paths.length) void addFiles(paths); }} onPasteFiles={() => { if (!observing) void addFiles(undefined, true); }}
      send={(content, requestId) => sendMessage('message', undefined, { content, requestId, attachments: [], bypassCallBridge: true })} />}
    {bindingOpen && launcherApi && bindings.state && <BotDshBindingDialog key="shared-dsh" api={launcherApi} state={bindings.state} companions={participants} locale={locale} onState={bindings.accept} onClose={() => setDismissedBinding(bindingKey)} onOpenLauncher={onOpenLauncher} />}
    {browserPicker && <BotBrowserContextPicker context={browserPicker} companions={snapshot?.companions ?? []} locale={locale} onClose={() => setDismissedBrowserContext(browserPicker.referenceId)} onSelect={async companionId => {
      const result = await request({ type: 'conversation.open', companionId }); if (!result.ok || !result.conversationId) throw Error(result.error ?? t.error);
      for (const key of removedApps.current) if (key.startsWith(result.conversationId! + ':') && key.endsWith(':browser')) markAppRemoved(key, false);
      setBrowserDrafts(current => ({ ...current, [result.conversationId!]: browserPicker })); setDismissedBrowserContext(browserPicker.referenceId); setPanel(null); setDialog(null); closeCall(); setPeerOnly(false); setSidebarView('chats'); selectConversation(result.conversationId); await refresh(result.conversationId);
    }} />}
  </div>;
}
