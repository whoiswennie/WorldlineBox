import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import startupLogo from '../../../assets/icons/startup-logo.png';
import type { BotCompanion, BotMessage, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import type { BotCallModel, BotCallStage } from '../../shared/companion-call';
import { callBeatKey } from '../../shared/companion-call-captions';
import { DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { BotAvatar, botAssetUrl } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotErrorNotice } from './BotErrorNotice';
import { BotMessageBody } from './BotMessageBody';
import { BotLive2DStage, type BotLive2DControls } from './BotLive2DStage';
import { BOT_CALL_TIMEOUT_MS, botCallClock } from './call-presentation';
import { useBotCallVoice, type BotCallSend } from './useBotCallVoice';
import { BotCallVoiceControls } from './BotCallVoiceControls';
import { BotCallDialogue, isLiveCallReply, type BotCallPlayback, type BotCallTurn } from './BotCallDialogue';
import { BotComposer, BotSpeechMuteButton } from './BotComposer';
import { BotApps, BotTopicAppCard } from './BotApps';
import { useBotTopicApp } from './useBotTopicApp';
import { VideoLoginDialog } from './VideoLoginDialog';
import { useVideoSurface } from './BotVideoCard';
import { useInlineMusicSurface } from '../music/MusicProvider';
import { BotTopicBar } from './BotTopicBar';
import { isBotFilePaste } from './clipboard-paste';
import { BOT_CALL_PAN_LIMIT, BOT_CALL_ZOOM, defaultBotCallFraming, readBotCallFraming, readBotCallPreferences, saveBotCallFraming, saveBotCallPreferences, usesAutomaticBotCallFraming, type BotCallFraming } from './call-preferences';
import { BotCallDocument, BotMeetingSession, useCallPet } from './call-pet';
import './bot-call.css';

const emptyMessages: readonly BotMessage[] = [];
const fallbackRingtone = 'ringtone.wav';
const poseFields = [
  ['headX', '左右转头', 'Turn head', -1, 1, 0], ['headY', '抬头低头', 'Tilt head', -1, 1, 0], ['headZ', '歪头', 'Lean head', -1, 1, 0],
  ['bodyX', '身体左右', 'Body', -1, 1, 0], ['gazeX', '视线左右', 'Look sideways', -1, 1, 0], ['gazeY', '视线上下', 'Look up/down', -1, 1, 0],
  ['mouthOpen', '张嘴', 'Mouth open', 0, 1, 0], ['mouthSmile', '嘴角', 'Smile', -1, 1, 0], ['eyeOpen', '睁眼', 'Eyes open', 0, 1.2, 1],
] as const;
export function BotCallWindow({ conversationId: directId, sessionId, companion, api, mediaApi, locale, onHangup, onOpenUrl, draft, setDraft, onDesktopPetChange, chatInteracting, speechMuted, onSpeechMute }: {
  conversationId: string; sessionId?: string; companion: BotCompanion; api: WorldlineBoxBotApi;
  mediaApi?: WorldlineBoxBotMediaApi; locale: 'zh-CN' | 'en'; onHangup(): void; onOpenUrl(url: string): void;
  draft: string; setDraft(text: string): void;
  onDesktopPetChange?(active: boolean, returning?: boolean): void;
  chatInteracting?: boolean;
  speechMuted: boolean; onSpeechMute(muted: boolean): void;
}) {
  const zh = locale === 'zh-CN', [phase, setPhase] = useState<'ringing' | 'connected'>('ringing'), [openedAt] = useState(Date.now), [connectedAt, setConnectedAt] = useState(0), [now, setNow] = useState(Date.now);
  const [muted, setMuted] = useState(false), [audioBlocked, setAudioBlocked] = useState(false), audio = useRef<HTMLAudioElement>(undefined);
  const ringtoneRetry = useRef<() => void>(undefined);
  const [preferences] = useState(() => readBotCallPreferences(companion.id));
  const [scene, setScene] = useState(preferences.scene), [voiceInputActive, setVoiceInputActive] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(!!draft), [hudMenu, setHudMenu] = useState(false);
  const [control, setControl] = useState<BotLive2DControls>(), [modelError, setModelError] = useState(''), [interactions, setInteractions] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [expression, setExpression] = useState(''), [motion, setMotion] = useState(''), [notice, setNotice] = useState('');
  const [framing, setFraming] = useState(() => defaultBotCallFraming());
  const { scale, x: frameX, y: frameY, fullBody } = framing;
  const [topicPanelOpen, setTopicPanelOpen] = useState(false);
  const desktop = useCallPet(onDesktopPetChange);
  const [compactPetMode, setCompactPetMode] = useState(false);
  const [compactMeetingMode, setCompactMeetingMode] = useState(false);
  const [petStatusRow, setPetStatusRow] = useState<HTMLDivElement | null>(null);
  const [petCaptureControls, setPetCaptureControls] = useState<HTMLDivElement | null>(null);
  const petOptionsId = useId();
  const onTopicPanelOpen = useCallback((open: boolean) => {
    setTopicPanelOpen(open);
    if (open) setHudMenu(false);
  }, []);
  const [historyFocus, setHistoryFocus] = useState<string>();
  const [pose, setPose] = useState<Record<string, number>>({}), [gazeEnabled, setGazeEnabled] = useState(preferences.gazeEnabled), [idleEnabled, setIdleEnabled] = useState(preferences.idleEnabled);
  const [bodyShape, setBodyShape] = useState(0);
  const [meeting, setMeeting] = useState<{ id: string; model?: BotCallModel; stage?: BotCallStage; baseline: Set<string>; activeAtConnect: Set<string>; legacyId?: string }>();
  const hasLiveModel = !!meeting?.model && !modelError;
  const compactPet = desktop.pet && (compactPetMode || !hasLiveModel);
  const compactMeeting = !desktop.pet && compactMeetingMode;
  const hideLiveModel = compactPet || compactMeeting;
  const showPortrait = !desktop.pet && (compactMeeting || !hasLiveModel);
  const compactInputLabel = composerExpanded ? (zh ? '收起桌宠输入' : 'Collapse desktop pet input') : (zh ? '展开会面输入' : 'Expand meeting input');
  const [snapshot, setSnapshot] = useState<BotSnapshot>();
  const [turn, setTurn] = useState<BotCallTurn>();
  const [older, setOlder] = useState<{ items: BotMessage[]; more: boolean }>();
  const [legacy, setLegacy] = useState<{ items: BotMessage[]; more: boolean }>();
  const [stage, setStage] = useState({ generation: 0, ignored: new Set<string>(), interrupted: false });
  const stageState = useRef(stage);
  const playback = useRef<BotCallPlayback>({ replies: [], pending: [] });
  const [presenting, setPresenting] = useState(false);
  const [typing, setTyping] = useState(false);
  const presented = useRef(new Map<string, { id: string; sequence: number }>());
  const interrupting = useRef<Promise<BotResponse>>(undefined);
  const [connecting, setConnecting] = useState(false), [sendError, setSendError] = useState('');
  const stopReplySpeech = useRef<() => void>(undefined);
  const [replyAudioInterrupted, setReplyAudioInterrupted] = useState(false);
  const silenceReply = useCallback(() => {
    stopReplySpeech.current?.();
    setReplyAudioInterrupted(true);
  }, []);
  const [files, setFiles] = useState<BotMediaRef[]>([]), [importing, setImporting] = useState(false), [sending, setSending] = useState(false);
  const live = useRef(false), sendLock = useRef(false), importLock = useRef(false);
  const publicationCursor = useRef<number>(undefined);
  const refreshing = useRef(false), refreshAgain = useRef(false);
  const latestDraft = useRef(draft);
  useLayoutEffect(() => { latestDraft.current = draft; }, [draft]);
  const attempts = useRef(new Map<string, Extract<BotRequest, { type: 'message.send' }>>());
  const textAttempt = useRef<string>(undefined);
  const box = useRef<HTMLElement>(null), transcript = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null);
  const historyFollowing = useRef(true);
  const conversationId = meeting?.id ?? '';
  const revealMusic = useCallback(() => {
    historyFollowing.current = true;
    setHistoryFocus(undefined);
    setInteractions(false);
    setHistoryOpen(true);
  }, []);
  useInlineMusicSurface(legacy?.items[0]?.conversationId ?? conversationId, 'call', phase === 'connected', revealMusic);
  const messages = snapshot?.messages ?? emptyMessages;
  const latestMessages = useRef(messages);
  useLayoutEffect(() => { latestMessages.current = messages; }, [messages]);
  const runtime = snapshot?.chatRuntime, topicId = runtime?.topic?.id;
  const recordPresentation = useCallback((messageId: string, segmentId: string, sequence: number) => {
    if ((presented.current.get(messageId)?.sequence ?? -1) < sequence) presented.current.set(messageId, { id: segmentId, sequence });
  }, []);
  const recordPlayback = useCallback((state: BotCallPlayback) => { playback.current = state; setPresenting(state.pending.length > 0); }, []);
  const updateStage = useCallback((value: typeof stage) => { stageState.current = value; setStage(value); }, []);
  const dismissReplies = useCallback((ids: readonly string[]) => {
    const current = stageState.current;
    const fresh = ids.filter(id => !current.ignored.has(id));
    if (fresh.length) updateStage({ generation: current.generation + 1, ignored: new Set([...current.ignored, ...fresh]), interrupted: false });
  }, [updateStage]);
  const remaining = Math.max(0, Math.ceil((BOT_CALL_TIMEOUT_MS - (now - openedAt)) / 1000));
  const request = useCallback(async (input: BotRequest): Promise<BotResponse> => {
    const background = input.type === 'topic.context' || input.type === 'topic.list';
    try {
      const result = await api.request(input);
      if (!result.ok && live.current && !background) setSendError(result.error ?? (zh ? '会面操作失败。' : 'Meeting request failed.'));
      return result;
    } catch {
      if (live.current && !background) setSendError(zh ? '会面服务暂不可用。' : 'Meeting service is unavailable.');
      return { ok: false };
    }
  }, [api, zh]);
  const refresh = useCallback(async () => {
    if (!conversationId || !meeting) return;
    if (refreshing.current) { refreshAgain.current = true; return; }
    refreshing.current = true;
    try {
      do {
        refreshAgain.current = false;
        const result = await request({ type: 'state', conversationId, surface: 'call', callAfter: publicationCursor.current });
        if (!live.current || !result.snapshot) return;
        const delivery = result.snapshot.callDelivery;
        if (delivery) {
          publicationCursor.current = delivery.cursor;
          for (const id of delivery.messageIds) meeting.activeAtConnect.add(id);
        }
        setSnapshot(result.snapshot);
      } while (refreshAgain.current && live.current);
    } finally { refreshing.current = false; }
  }, [conversationId, meeting, request]);
  const video = useBotTopicApp('video', conversationId, runtime, request, refresh);
  const videoSurface = useVideoSurface(api, conversationId, 'call', phase === 'connected' && !desktop.pet, revealMusic, !legacy);
  const music = useBotTopicApp('music', conversationId, runtime, request, refresh);
  useEffect(() => {
    if (snapshot?.callDelivery?.more) void refresh();
  }, [snapshot?.callDelivery, refresh]);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    if (!conversationId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.onEvent(event => {
      if (event.type !== 'changed' || event.conversationId && event.conversationId !== conversationId || timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 35);
    });
    const initial = setTimeout(() => void refresh(), 0);
    const catchUp = setInterval(() => void refresh(), 10_000);
    return () => { clearInterval(catchUp); clearTimeout(initial); clearTimeout(timer); unsubscribe(); };
  }, [api, conversationId, refresh]);
  const connect = async () => {
    setConnecting(true); setSendError('');
    const result = await request({ type: 'call.open', conversationId: directId, ...(sessionId && { sessionId }) });
    if (!live.current) return;
    setConnecting(false);
    if (!result.ok || !result.conversationId || !result.snapshot) return;
    publicationCursor.current = result.snapshot.callDelivery?.cursor;
    const baseline = new Set(result.snapshot.messages.flatMap(message => message.parts?.filter(part => part.presentation).map(part => callBeatKey(message.id, part.id)) ?? []));
    const activeAtConnect = new Set<string>();
    for (const message of result.snapshot.messages) {
      if (message.status === 'sent') baseline.add(callBeatKey(message.id));
      if (message.status === 'queued' || message.status === 'running') activeAtConnect.add(message.id);
      const prior = message.parts?.findLast(part => part.presentation);
      if (prior) recordPresentation(message.id, prior.id, prior.sequence);
    }
    setFraming(readBotCallFraming(companion.id, result.callModel));
    setMeeting({ id: result.conversationId, model: result.callModel, stage: result.callStage, baseline, activeAtConnect, legacyId: result.legacyCallConversationId });
    setSnapshot(result.snapshot); setConnectedAt(Date.now()); setPhase('connected');
  };
  const interrupt = (requestId: string = crypto.randomUUID(), replyIds?: readonly string[]): Promise<BotResponse> => {
    if (!conversationId) return Promise.resolve({ ok: false });
    if (interrupting.current) return interrupting.current;
    const current = stageState.current;
    const queued = messages.filter(message => meeting && isLiveCallReply(message, companion.id, connectedAt, meeting.activeAtConnect)
      && !current.ignored.has(message.id) && ['queued', 'running'].includes(message.status));
    const candidates = [...new Set(replyIds ?? [...playback.current.pending, ...queued.slice(-1).map(message => message.id)])].slice(0, 80);
    const replies = candidates.map(messageId => ({ messageId, throughSegmentId: presented.current.get(messageId)?.id }));
    const played = playback.current.replies.filter(id => !playback.current.pending.includes(id));
    const reset = { generation: current.generation + 1, ignored: new Set([...current.ignored, ...played, ...candidates]), interrupted: candidates.length > 0 };
    // Stop local playback immediately while Main settles the selected replies.
    if (reset.interrupted) updateStage(reset);
    const operation = request({ type: 'call.interrupt', conversationId, topicId, requestId, replies }).then(result => {
      if (!live.current) return result;
      if (result.ok && (reset.interrupted || result.interruptedReplyIds?.length)) {
        const extra = result.interruptedReplyIds?.filter(id => !reset.ignored.has(id)) ?? [];
        updateStage({ generation: reset.generation + Number(extra.length > 0), interrupted: true, ignored: new Set([...reset.ignored, ...extra]) });
      } else if (!result.ok && reset.interrupted) updateStage({ ...current, generation: reset.generation + 1 });
      void refresh();
      return result;
    }).finally(() => { if (interrupting.current === operation) interrupting.current = undefined; });
    interrupting.current = operation;
    return operation;
  };
  const dispatch = async (content: string, requestId: string, attachmentIds?: string[]) => {
    if (!conversationId || sendLock.current) return { ok: false };
    sendLock.current = true; setSending(true); setSendError('');
    try {
      let input = attempts.current.get(requestId);
      const ownPending = turn?.replyIds?.filter(id => !stageState.current.ignored.has(id)
        && (!messages.some(message => message.id === id) || messages.some(message => message.id === id && ['queued', 'running'].includes(message.status))));
      const stopped = !input && ownPending?.length ? interrupt('send-' + requestId, ownPending) : undefined;
      if (!input && !stopped) {
        dismissReplies(playback.current.replies.filter(id => !playback.current.pending.includes(id) || turn?.replyIds?.includes(id)));
      }
      setTurn({ id: requestId, content: content.trim() });
      setReplyAudioInterrupted(false);
      if (!input) {
        if (stopped) {
          const result = await stopped;
          if (!result.ok || !live.current) return { ok: false };
        }
        if (stageState.current.interrupted) updateStage({ ...stageState.current, interrupted: false });
        input = { type: 'message.send', conversationId, content, requestId, topicId, attachmentIds, surface: 'call' };
        attempts.current.set(requestId, input);
      }
      const result = await request(input);
      if (result.ok) {
        setTurn(current => current?.id === requestId ? { ...current, replyIds: result.replyMessageIds ?? [] } : current);
        attempts.current.delete(requestId);
        void refresh();
      }
      return result;
    } finally {
      sendLock.current = false;
      if (live.current) {
        setTurn(current => current?.id === requestId && !current.replyIds ? { ...current, failed: true } : current);
        setSending(false);
      }
    }
  };
  const hangup = onHangup;
  const send: BotCallSend = (text, requestId) => dispatch(text, requestId);
  const voice = useBotCallVoice({ connected: phase === 'connected', conversationId, companionId: companion.id, messages, send, onSpeechStart: silenceReply });
  const voiceActive = voice.state.enabled && voice.state.phase !== 'error';
  const voiceHold = voiceActive && (replyAudioInterrupted || ['preparing', 'waiting', 'recognizing'].includes(voice.state.phase));
  if (!voiceActive && replyAudioInterrupted) setReplyAudioInterrupted(false);
  const stopVoice = voice.stop;
  const topicRequest = useCallback(async (input: BotRequest) => {
    if (input.type !== 'topic.context' && input.type !== 'topic.list') setSendError('');
    const result = await request(input);
    if (result.ok && (input.type === 'topic.new' || input.type === 'topic.select') && result.topic?.id !== topicId) {
      dismissReplies(playback.current.replies.filter(id => latestMessages.current.some(message => message.id === id && message.topic?.id === topicId && message.status === 'sent')));
      stopVoice(); setReplyAudioInterrupted(false); setTurn(undefined); setHistoryFocus(undefined); setLegacy(undefined); historyFollowing.current = true;
      textAttempt.current = undefined;
    }
    return result;
  }, [dismissReplies, request, stopVoice, topicId]);
  const submit = async (sticker?: BotMediaRef) => {
    const text = sticker ? '' : draft;
    const attachments = sticker ? [sticker] : files;
    if (sendLock.current || importLock.current || (!text.trim() && !attachments.length) || attachments.length > 16) return;
    const ids = attachments.map(file => file.id), prior = textAttempt.current && attempts.current.get(textAttempt.current);
    const requestId = prior && prior.topicId === topicId && prior.content === text && JSON.stringify(prior.attachmentIds) === JSON.stringify(ids)
      ? prior.requestId : crypto.randomUUID();
    if (!sticker) textAttempt.current = requestId;
    await voice.sendAction(text, requestId, async () => {
      const result = await dispatch(text, requestId, ids);
      if (live.current && result.ok && !sticker) {
        if (latestDraft.current === text) setDraft('');
        setFiles(current => current.filter(file => !ids.includes(file.id))); textAttempt.current = undefined;
      }
      return result;
    });
  };
  const addFiles = async (paths?: string[], paste = false) => {
    if (!mediaApi || !conversationId || importLock.current) return;
    importLock.current = true; setImporting(true); setComposerExpanded(true);
    try {
      const result = await mediaApi.request(paths ? { type: 'files.import', conversationId, paths } : { type: paste ? 'files.paste' : 'files.pick', conversationId });
      if (live.current && result.ok && result.media?.length) attachFiles(result.media);
      if (live.current && !result.ok) setSendError(result.error ?? (zh ? '添加附件失败。' : 'Could not attach files.'));
    } catch { if (live.current) setSendError(zh ? '添加附件失败。' : 'Could not attach files.'); }
    finally { importLock.current = false; if (live.current) setImporting(false); }
  };
  const attachFiles = (items: BotMediaRef[]) => setFiles(current => [...new Map([...current, ...items].map(file => [file.id, file])).values()]);
  const chat = legacy?.items ?? [...new Map([...(older?.items ?? []), ...messages].map(item => [item.id, item])).values()];
  const more = legacy?.more ?? older?.more ?? snapshot?.hasMore;
  const loadEarlier = async () => {
    if (!chat[0]) return;
    const result = await request({ type: 'state', conversationId: legacy ? meeting?.legacyId : conversationId, before: chat[0].sequence, surface: 'call' });
    if (!live.current || !result.snapshot) return;
    const page = result.snapshot;
    historyFollowing.current = false;
    const merge = (current?: typeof older) => ({ items: [...new Map([...page.messages, ...(current?.items ?? [])].map(item => [item.id, item])).values()], more: page.hasMore });
    if (legacy) setLegacy(current => current && merge(current)); else setOlder(merge);
  };
  const openHistory = () => { historyFollowing.current = true; setLegacy(undefined); setHistoryFocus(undefined); setInteractions(false); setHistoryOpen(true); };
  const openLegacy = async () => {
    if (!meeting?.legacyId) return;
    const result = await request({ type: 'state', conversationId: meeting.legacyId, surface: 'call' });
    if (live.current && result.snapshot) {
      historyFollowing.current = true;
      setHistoryFocus(undefined);
      setLegacy({ items: result.snapshot.messages, more: result.snapshot.hasMore });
    }
  };
  const toggleInteractions = () => { setHistoryOpen(false); setInteractions(value => !value); };
  const ready = useCallback((controls: BotLive2DControls) => { setControl(controls); setModelError(''); }, []);
  const failed = useCallback((message: string) => { setControl(undefined); setModelError(message); }, []);
  useEffect(() => { control?.gaze(gazeEnabled); }, [control, gazeEnabled]);
  useEffect(() => { control?.idle(idleEnabled); }, [control, idleEnabled]);
  useLayoutEffect(() => { control?.fullBody(fullBody); control?.scale(scale); control?.position(frameX, frameY); }, [control, fullBody, scale, frameX, frameY]);
  useLayoutEffect(() => {
    const host = dock.current, shell = box.current;
    if (phase !== 'connected' || !shell || !host) return;
    const measure = () => shell.style.setProperty('--bot-call-dock-height', host.offsetHeight + 'px');
    measure();
    const observer = new ResizeObserver(measure); observer.observe(host);
    return () => { observer.disconnect(); shell.style.removeProperty('--bot-call-dock-height'); };
  }, [phase]);
  useEffect(() => { const previous = document.activeElement; return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => { box.current?.querySelector<HTMLElement>(phase === 'ringing' ? '[data-call-accept]' : composerExpanded ? 'textarea' : '.bot-call-input-entry')?.focus(); }, [phase, composerExpanded, desktop.surface]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { if (phase !== 'ringing') return; const timer = setTimeout(onHangup, Math.max(0, BOT_CALL_TIMEOUT_MS - (Date.now() - openedAt))); return () => clearTimeout(timer); }, [phase, openedAt, onHangup]);
  useEffect(() => {
    if (phase !== 'ringing') return;
    let ringtone = companion.id === DEFAULT_BOT_COMPANION_ID ? 'ringtones/dafeiyu.wav' : 'ringtones/phoebe.wav';
    const url = (file: string) => botAssetUrl('companion-call/' + file);
    const sound = new Audio(url(ringtone)); sound.loop = true; sound.volume = .75; audio.current = sound;
    const play = async () => {
      try {
        await sound.play();
        if (audio.current === sound) setAudioBlocked(false);
      } catch (error) {
        if (audio.current !== sound) return;
        if (ringtone !== fallbackRingtone && (sound.error || (error as { name?: string })?.name === 'NotSupportedError')) {
          ringtone = fallbackRingtone;
          sound.src = url(ringtone);
          await play();
          return;
        }
        setAudioBlocked(true);
      }
    };
    ringtoneRetry.current = () => void play();
    void play();
    return () => { ringtoneRetry.current = undefined; audio.current = undefined; sound.pause(); sound.removeAttribute('src'); sound.load(); };
  }, [companion.id, phase]);
  useEffect(() => { if (audio.current) audio.current.muted = muted; }, [muted, phase]);
  useEffect(() => {
    if (!transcript.current) return;
    const target = historyOpen && historyFocus && transcript.current.querySelector(`[data-call-message="${CSS.escape(historyFocus)}"]`);
    if (target) target.scrollIntoView?.({ block: 'center' }); else if (historyFollowing.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, phase, historyOpen, historyFocus, legacy]);
  const changeScene = (value: string) => { setScene(value); if (!saveBotCallPreferences(companion.id, { scene: value })) setNotice(zh ? '背景已用于本次会面，存储空间不足，未保存。' : 'Background applied for this visit; storage is full.'); };
  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    if (!/^image\/(?:png|jpeg|webp|avif)$/u.test(file.type) || file.size > 2_500_000) { setNotice(zh ? '请选择小于 2.5 MB 的 PNG、JPEG、WebP 或 AVIF 图片。' : 'Choose a PNG, JPEG, WebP or AVIF image smaller than 2.5 MB.'); return; }
    const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') changeScene(reader.result); }; reader.onerror = () => setNotice(zh ? '背景图片读取失败。' : 'Could not read the image.'); reader.readAsDataURL(file);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (topicPanelOpen) return;
      if (box.current?.querySelector('.bot-expression-picker,.bot-voice-panel')) return;
      if (hudMenu && desktop.pet) { event.preventDefault(); event.stopPropagation(); setHudMenu(false); return; }
      if (composerExpanded) { event.preventDefault(); event.stopPropagation(); setComposerExpanded(false); return; }
      if (hudMenu) { event.preventDefault(); event.stopPropagation(); setHudMenu(false); return; }
      if (historyOpen || interactions) { event.preventDefault(); event.stopPropagation(); setHistoryOpen(false); setInteractions(false); return; }
      event.preventDefault(); event.stopPropagation(); if (desktop.pet) desktop.toggle(); else hangup(); return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),select,input') ?? []].filter(element => element.getClientRects().length > 0), first = controls[0], last = controls.at(-1);
    if (event.shiftKey && desktop.surface.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && desktop.surface.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const background = desktop.pet || scene === 'plain' ? undefined : `url("${scene.startsWith('data:') ? scene : botAssetUrl('companion-call/scenes/evening.png')}")`;
  const petLabel = desktop.pet ? (zh ? '返回会面场景' : 'Return to meeting scene') : (zh ? '切换为桌宠' : 'Switch to desktop pet');
  const compactPetLabel = zh ? '切换为简洁桌宠' : 'Switch to compact desktop pet';
  const toggleDesktop = (compact = false) => {
    setHudMenu(false);
    if (!desktop.toggle()) {
      setNotice(zh ? '桌宠窗口暂时无法打开。' : 'The desktop pet window could not open.');
    } else if (!desktop.pet) setCompactPetMode(compact);
  };
  const toggleCompact = () => {
    if (desktop.pet) setCompactPetMode(value => !value);
    else setCompactMeetingMode(value => !value);
    setHudMenu(false);
  };
  const automaticFraming = usesAutomaticBotCallFraming(meeting?.model);
  const changeFraming = (update: Partial<BotCallFraming>) => {
    const next = { ...framing, ...update };
    setFraming(next);
    if (meeting?.model && !saveBotCallFraming(companion.id, meeting.model, next)) {
      setNotice(zh ? '取景已调整，本机设置未能保存。' : 'Framing applied for this meeting. The setting could not be saved.');
    }
  };
  const frameModel = (upper: boolean) => changeFraming(defaultBotCallFraming(meeting?.model, !upper));
  const zoomModel = (delta: number) => changeFraming({ scale: Math.min(BOT_CALL_ZOOM.max, Math.max(BOT_CALL_ZOOM.min, scale + delta)) });
  const interactionsPanel = interactions && <aside className="bot-call-interactions" aria-label={zh ? '场景与形象互动' : 'Scene and character controls'}><header><strong>{zh ? '场景与互动' : 'Scene & interactions'}</strong><button onClick={() => setInteractions(false)} aria-label={zh ? '收起互动设置' : 'Close interactions'}>×</button></header>
        {!desktop.pet && <><label>{zh ? '背景场景' : 'Background'}<select value={scene.startsWith('data:') ? 'custom' : scene} onChange={event => { if (event.target.value !== 'custom') changeScene(event.target.value); }}><option value="evening">{zh ? '暮色书房' : 'Evening studio'}</option><option value="plain">{zh ? '静谧留白' : 'Quiet space'}</option>{scene.startsWith('data:') && <option value="custom">{zh ? '自选图片' : 'Your image'}</option>}</select></label>
        <label className="bot-call-upload"><BotIcon name="image" />{zh ? '更换背景图片' : 'Choose a background'}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => void chooseImage(event)} /></label></>}
        {control && <>
          <h3>{zh ? '取景' : 'Framing'}</h3>
          <div className="bot-call-gesture-buttons bot-call-framing-presets">
            <button type="button" aria-pressed={!fullBody} onClick={() => frameModel(true)}><BotIcon name="portrait" />{zh ? '半身' : 'Portrait'}</button>
            <button type="button" aria-pressed={fullBody} onClick={() => frameModel(false)}><BotIcon name="full-body" />{zh ? '全身' : 'Full body'}</button>
          </div>
          <label className="bot-call-pose-slider"><span>{zh ? '形象大小' : 'Character size'}</span><input type="range" min={BOT_CALL_ZOOM.min} max={BOT_CALL_ZOOM.max} step="0.01" value={scale} aria-label={zh ? '形象大小' : 'Character size'} onChange={event => changeFraming({ scale: event.currentTarget.valueAsNumber })} /><output>{Math.round(scale * 100)}%</output></label>
          {(['x', 'y'] as const).map(axis => {
            const label = axis === 'x' ? (zh ? '水平位置' : 'Horizontal position') : (zh ? '垂直位置' : 'Vertical position');
            return <label className="bot-call-pose-slider" key={axis}><span>{label}</span><input type="range" min={-BOT_CALL_PAN_LIMIT} max={BOT_CALL_PAN_LIMIT} step=".01" value={framing[axis]} aria-label={label} onChange={event => changeFraming({ [axis]: event.currentTarget.valueAsNumber })} /><output>{Math.round(framing[axis] * 100)}%</output></label>;
          })}
          <button type="button" onClick={() => frameModel(!automaticFraming || !fullBody)}>{zh ? automaticFraming ? '自动取景' : '重置取景' : automaticFraming ? 'Auto frame' : 'Reset framing'}</button>
          <details className="bot-call-adjustment"><summary>{zh ? '神态与姿态' : 'Gaze & pose'}</summary><div className="bot-call-adjustment-body"><div className="bot-call-gesture-buttons"><button onClick={() => control.gesture('nod')}>{zh ? '点头' : 'Nod'}</button><button onClick={() => control.gesture('shake')}>{zh ? '摇头' : 'Shake'}</button><button onClick={() => control.gesture('blink')}>{zh ? '眨眼' : 'Blink'}</button></div>
          <label><input type="checkbox" checked={gazeEnabled} onChange={event => { setGazeEnabled(event.target.checked); saveBotCallPreferences(companion.id, { gazeEnabled: event.target.checked }); }} />{zh ? '视线跟随鼠标' : 'Follow pointer'}</label><label><input type="checkbox" checked={idleEnabled} onChange={event => { setIdleEnabled(event.target.checked); saveBotCallPreferences(companion.id, { idleEnabled: event.target.checked }); }} />{zh ? '自然待机动作' : 'Idle motion'}</label>
          {control.hasBodyShape && <label className="bot-call-pose-slider"><span>{zh ? '体型' : 'Body shape'}</span><input type="range" min="0" max="1" step=".01" value={bodyShape} aria-label={zh ? '体型' : 'Body shape'} onChange={event => {
            const value = Number(event.target.value);
            setBodyShape(value);
            control.bodyShape?.(value);
            if (control.catalog.expressions.find(item => item.name === expression)?.params.includes('Clothes2')) setExpression('');
          }} /><output>{Math.round(bodyShape * 100)}%</output></label>}
          {poseFields.map(([key, chinese, english, min, max, initial]) => <label className="bot-call-pose-slider" key={key}><span>{zh ? chinese : english}</span><input aria-label={zh ? chinese : english} type="range" min={min} max={max} step="0.02" value={pose[key] ?? initial} onChange={event => { const value = Number(event.target.value); setPose(current => ({ ...current, [key]: value })); control.pose({ [key]: value }); }} /><output>{(pose[key] ?? initial).toFixed(2)}</output></label>)}
          </div></details>
          <details className="bot-call-adjustment"><summary>{zh ? '表情与动作' : 'Expressions & motions'}</summary><div className="bot-call-adjustment-body"><label>{zh ? '表情' : 'Expression'} <small>{control.catalog.expressions.length}</small><select aria-label={zh ? '选择模型表情' : 'Choose expression'} value={expression} onChange={event => { setExpression(event.target.value); if (event.target.value) control.expression(event.target.value); else { control.reset(); setPose({}); setBodyShape(0); } }}><option value="">{zh ? '默认' : 'Default'}</option>{control.catalog.expressions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label>{zh ? '动作' : 'Motion'} <small>{control.catalog.motions.length}</small><select aria-label={zh ? '选择模型动作' : 'Choose motion'} value={motion} onChange={event => setMotion(event.target.value)}><option value="">{zh ? '选择动作' : 'Choose motion'}</option>{control.catalog.motions.map((item, index) => <option key={item.file} value={index}>{item.name}</option>)}</select></label><button disabled={!motion} onClick={() => control.motion(Number(motion))}>{zh ? '播放动作' : 'Play motion'}</button>
          <button onClick={() => { control.reset(); setPose({}); setBodyShape(0); setExpression(''); setMotion(''); }}>{zh ? '恢复默认姿态' : 'Reset pose'}</button>
          <small className="bot-call-credits">{control.catalog.credits}</small></div></details></>}
      </aside>;
  const editVoice = (text: string) => { setDraft(draft ? draft + '\n' + text : text); setComposerExpanded(true); };
  const composerTools = <BotCallVoiceControls mode="toolbar" inputActive={voiceInputActive} voice={voice} zh={zh} onStart={voice.start} onEdit={editVoice} />;
  const composerStatus = <div className="bot-call-composer-status">
    {modelError && <p className="bot-call-model-error" role="status">{modelError}</p>}
    <BotCallVoiceControls voice={voice} zh={zh} onStart={voice.start} onEdit={editVoice}
      onInterrupt={() => { silenceReply(); voice.interrupt(); void interrupt(); }} />
    {sendError && <div className="bot-call-send-error" role="alert"><BotErrorNotice message={sendError} zh={zh} /></div>}
  </div>;
  const hangupButton = <button type="button" className="bot-call-hangup" aria-label={zh ? '挂断' : 'End call'} title={zh ? '挂断' : 'End call'} onClick={hangup}><BotIcon name="hangup" /></button>;
  const meetingControls = <>
    {desktop.supported && <button type="button" className="bot-call-pet-toggle" aria-label={petLabel} title={petLabel} onClick={() => toggleDesktop()}><BotIcon name={desktop.pet ? 'return-scene' : 'desktop-pet'} /></button>}
    {desktop.supported && !desktop.pet && hasLiveModel && <button type="button" className="bot-call-pet-toggle" aria-label={compactPetLabel} title={compactPetLabel} onClick={() => toggleDesktop(true)}><BotIcon name="portrait" /></button>}
    <button type="button" className="bot-call-history-toggle" aria-label={zh ? '会面聊天记录' : 'Meeting chat history'} title={zh ? '会面聊天记录' : 'Meeting chat history'} aria-expanded={historyOpen} aria-controls="bot-call-history"
      onClick={() => { historyFollowing.current = true; setHistoryFocus(undefined); setHudMenu(false); setInteractions(false); setHistoryOpen(value => !value); }}><BotIcon name="history" /></button>
    {!desktop.pet && <button type="button" className="bot-call-menu-toggle" aria-label={zh ? '会面菜单' : 'Meeting menu'} title={zh ? '会面菜单' : 'Meeting menu'} aria-expanded={hudMenu} onClick={() => setHudMenu(value => !value)}><BotIcon name="settings" /></button>}
    <time className="bot-call-duration">{botCallClock(now - connectedAt)}</time>
  </>;
  const meetingMenu = <aside className="bot-call-hud-menu" aria-label={zh ? '会面工具' : 'Meeting tools'}>
    {hasLiveModel && <button type="button" className="bot-call-tool-tile bot-call-compact-toggle" aria-pressed={hideLiveModel}
      onClick={toggleCompact}><BotIcon name="portrait" />{zh ? '简洁模式' : 'Compact mode'}</button>}
    <button type="button" className="bot-call-tool-tile" aria-pressed={interactions} onClick={() => { setHudMenu(false); toggleInteractions(); }}><BotIcon name="frame" />{zh ? '场景与互动' : 'Scene & interactions'}</button>
    {control && <>
      <button type="button" className="bot-call-tool-tile" onClick={() => frameModel(fullBody)}><BotIcon name={fullBody ? 'portrait' : 'full-body'} />{fullBody ? zh ? '半身取景' : 'Portrait view' : zh ? '全身取景' : 'Full body view'}</button>
      <div className="bot-call-framing-tools" role="group" aria-label={zh ? '快捷取景' : 'Quick framing'}>
        <button type="button" onClick={() => zoomModel(-.1)} disabled={scale <= .4} aria-label={zh ? '缩小形象' : 'Zoom out'} title={zh ? '缩小形象' : 'Zoom out'}><BotIcon name="minus" /></button>
        <output aria-label={zh ? '形象缩放' : 'Character zoom'}>{Math.round(scale * 100)}%</output>
        <button type="button" onClick={() => zoomModel(.1)} disabled={scale >= 3} aria-label={zh ? '放大形象' : 'Zoom in'} title={zh ? '放大形象' : 'Zoom in'}><BotIcon name="plus" /></button>
      </div>
    </>}
      </aside>;
  const inputActions = <>
    <BotSpeechMuteButton zh={zh} muted={speechMuted} onChange={muted => { if (muted) stopReplySpeech.current?.(); onSpeechMute(muted); }} />
    {desktop.pet && <button type="button" className="bot-call-pet-more" aria-label={zh ? '更多会面功能' : 'More meeting controls'} title={zh ? '更多会面功能' : 'More meeting controls'} aria-expanded={hudMenu} aria-controls={hudMenu ? petOptionsId : undefined}
      onClick={() => { setHistoryOpen(false); setInteractions(false); setHudMenu(value => !value); }}><BotIcon name="more" /></button>}
    <button type="button" aria-label={zh ? '收起会面输入' : 'Collapse meeting input'} title={zh ? '收起会面输入' : 'Collapse meeting input'} disabled={voiceInputActive}
      onClick={() => { if (desktop.pet) setHudMenu(false); setComposerExpanded(false); }}><BotIcon name="chevron-down" /></button>
    {hangupButton}
  </>;
  const question = meeting && messages.findLast(message => message.execution?.question
    && isLiveCallReply(message, companion.id, connectedAt, meeting.activeAtConnect) && !stage.ignored.has(message.id));
  const answer = (messageId: string, questionId: string, text: string) => request({ type: 'execution.answer', messageId, questionId, text });
  const topics = <div className="bot-call-topics" aria-label={zh ? '会面话题' : 'Meeting topics'} role="region">
    {desktop.pet && <span className="bot-call-pet-grip" data-pet-drag title={zh ? '拖动桌宠' : 'Drag desktop pet'} aria-hidden="true"><BotIcon name="grip" /></span>}
    <BotTopicBar conversationId={conversationId} runtime={runtime} members={[companion]} locale={locale} request={topicRequest} refresh={refresh} onPanelOpenChange={onTopicPanelOpen} />
  </div>;
  return createPortal(<BotMeetingSession.Provider value={sessionId}><BotCallDocument.Provider value={desktop.surface}><div className={`bot-call-overlay${desktop.pet ? ' is-desktop-pet' : ''}${compactPet ? ' is-pet-compact' : ''}`}><section ref={box} className={`bot-call-window is-${phase}${fullBody ? " is-full-body" : ""}${showPortrait ? ' is-static-portrait' : ''}`} role="dialog" aria-modal={!desktop.pet} aria-label={zh ? `与${companion.name}会面` : `Meet ${companion.name}`} onKeyDown={keyboard} onPaste={event => { if (conversationId && mediaApi && isBotFilePaste(event.clipboardData, () => mediaApi?.hasClipboardFiles?.(conversationId) ?? false)) { event.preventDefault(); event.stopPropagation(); void addFiles(undefined, true); } }} onDragOver={event => { if (conversationId && mediaApi && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); const paths = mediaApi?.getDroppedFilePaths([...event.dataTransfer.files]); if (paths?.length) void addFiles(paths); } }}>
    {!desktop.pet && <header className="bot-call-header">
      <div className="bot-call-heading">{phase === 'ringing' ? <span className="bot-call-brand">WORLDLINE · {zh ? '伙伴会面' : 'COMPANION'}</span> : <BotAvatar companion={companion} />}<strong>{companion.name}</strong></div>
      {phase === 'ringing' ? <span className="bot-call-mode">{zh ? '文字 / 语音输入' : 'Text / voice input'}</span>
        : <nav className="bot-call-meeting-controls" aria-label={zh ? '通话控制' : 'Call controls'}>{meetingControls}</nav>}
      <button type="button" className="bot-call-close" aria-label={zh ? '结束并关闭会面' : 'End and close'} onClick={hangup}>×</button>
    </header>}
    {phase === 'ringing' ? <div className="bot-call-ringing"><div className="bot-call-dial-orbit"><BotAvatar companion={companion} large /></div><h2>{companion.name}</h2><p>{zh ? '等待你接通' : 'Ready when you are'}</p><small>{zh ? `${remaining} 秒后自动结束` : `Ends automatically in ${remaining}s`}</small>
      <div className="bot-call-dial-actions"><button className="bot-call-hangup" onClick={onHangup}><BotIcon name="phone-off" /><span>{zh ? '取消' : 'Cancel'}</span></button><button className="bot-call-accept" data-call-accept disabled={connecting} onClick={() => void connect()}><BotIcon name="phone" /><span>{connecting ? (zh ? '接通中…' : 'Connecting…') : (zh ? '接通' : 'Connect')}</span></button></div>
      <button className="bot-call-ring-volume" onClick={() => setMuted(value => !value)} aria-pressed={muted}><BotIcon name="volume" />{muted ? zh ? '开启铃声' : 'Unmute ringtone' : zh ? '静音铃声' : 'Mute ringtone'}</button>
      {audioBlocked && <button className="bot-call-ring-retry" onClick={() => ringtoneRetry.current?.()}>{zh ? '播放铃声' : 'Play ringtone'}</button>}
      {sendError && <div className="bot-call-ring-error" role="alert"><BotErrorNotice message={sendError} zh={zh} /></div>}
    </div> : <><div className="bot-call-connected"><div className="bot-call-scene" style={{ backgroundImage: background }}>
      {!desktop.pet && <div className="bot-call-scene-shade" />}
      {meeting?.model && !modelError && <><BotLive2DStage model={meeting.model} name={companion.name} desktopPet={desktop.pet} hidden={hideLiveModel} framing={framing} onReady={ready} onError={failed} />{!hideLiveModel && !control && <p className="bot-call-loading" role="status">{zh ? '正在准备形象…' : 'Preparing the character…'}</p>}</>}
      {showPortrait && <div className="bot-call-portrait"><div className="bot-call-portrait-frame"><BotAvatar companion={companion} large /></div><h2>{companion.name}</h2></div>}
      {meeting && <BotCallDialogue key={stage.generation} turn={turn} messages={messages} baseline={meeting.baseline} ignored={stage.ignored} connectedAt={connectedAt}
        progressTarget={desktop.pet ? petStatusRow : undefined}
        companionId={companion.id} activeAtConnect={meeting.activeAtConnect}
        speechApi={api} conversationId={conversationId} muted={speechMuted} voiceHold={voiceHold} speechStop={stopReplySpeech}
        catalog={meeting.model?.assets} stage={meeting.stage} control={control} modelLoading={!hideLiveModel && hasLiveModel && !control}
        hidden={historyOpen || interactions || topicPanelOpen || desktop.pet && hudMenu} desktopPet={desktop.pet} zh={zh}
        interrupted={stage.interrupted} onPresent={recordPresentation} onPlayback={recordPlayback} onInterrupt={() => { void interrupt(); }} onNotice={setNotice}
        onReplay={() => { if (!voice.state.enabled || voice.state.phase === 'error') setReplyAudioInterrupted(false); }}
        onHistory={messageId => { openHistory(); setHistoryFocus(messageId); }}
        extra={question && <BotMessageBody message={{ ...question, parts: undefined, content: '', attachments: undefined }} statusText="" locale={locale} onAnswer={(id, text) => answer(question.id, id, text)} />} />}
      {!desktop.pet && hudMenu && meetingMenu}
      {notice && <button className="bot-call-notice" role="status" onClick={() => setNotice('')}>{notice} ×</button>}
    </div><section id="bot-call-history" className="bot-call-chat" hidden={!historyOpen && !interactions} aria-label={zh ? '会面聊天' : 'Conversation'}>
      <header>
        <nav role="tablist" aria-label={zh ? '会面面板' : 'Meeting panel'}>
          <button type="button" role="tab" aria-selected={!interactions} onClick={openHistory}>{desktop.pet && <BotIcon name="history" />}{zh ? '对话' : 'Chat'}</button>
          <button type="button" role="tab" aria-selected={interactions} onClick={() => { setHistoryOpen(false); setInteractions(true); }}>{desktop.pet && <BotIcon name="settings" />}{zh ? '操作' : 'Interact'}</button>
        </nav>
        <button type="button" className="bot-call-panel-close" aria-label={zh ? '收起会面面板' : 'Close meeting panel'} onClick={() => { setHistoryOpen(false); setInteractions(false); }}><BotIcon name="close" /></button>
      </header>
      {interactionsPanel}<div hidden={interactions} className="bot-call-transcript" ref={transcript} role="log" aria-live="polite"
        onScroll={event => { const node = event.currentTarget; historyFollowing.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; }}>
      {meeting?.legacyId && <button type="button" onClick={() => legacy ? openHistory() : void openLegacy()}>
        {legacy ? (zh ? '返回当前对话' : 'Back to conversation') : (zh ? '旧版会面记录' : 'Previous meeting history')}
      </button>}
      {more && <button type="button" onClick={() => void loadEarlier()}>{zh ? '更早的对话' : 'Earlier messages'}</button>}
      {!chat.length && <div className="bot-call-chat-welcome">{desktop.pet && <BotIcon name="history" />}{zh ? '还没有消息。' : 'No messages yet.'}</div>}
      {chat.map(message => {
        const captions = message.parts?.some(part => part.music || part.video) ? undefined : message.parts?.filter(part => part.presentation && part.text);
        return <article key={message.id} className={message.senderId === 'user' ? 'is-user' : ''} data-call-message={message.id}>
          <small>{message.senderId === 'user' ? (zh ? '我' : 'You') : message.senderName}</small>
          {captions?.map(part => <p className="bot-call-log-bubble" key={part.id}>{part.text}</p>)}
          <BotMessageBody message={{ ...message, execution: undefined, ...(captions?.length ? { parts: message.parts?.filter(part => part.music || part.video), content: '' } : {}) }}
            statusText={message.status === 'failed' ? (zh ? '回复失败。' : 'Reply failed.') : ''} surface="call" videoPlayback={videoSurface} musicEnabled={phase === 'connected'} locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} />
          {message.error && <BotErrorNotice message={message.error} zh={zh} />}
          {!legacy && message.execution?.question && <BotMessageBody message={{ ...message, parts: undefined, content: '', attachments: undefined }} statusText="" locale={locale} onAnswer={(id, text) => answer(message.id, id, text)} />}
        </article>;
      })}
    </div></section></div>
    {compactPet && <button type="button" className="bot-call-input-entry bot-call-compact-anchor" data-pet-drag=""
      aria-expanded={composerExpanded} aria-label={compactInputLabel} title={`${companion.name} · ${compactInputLabel}`}
      aria-disabled={composerExpanded && voiceInputActive || undefined}
      onClick={() => { if (!voiceInputActive) { setHudMenu(false); setComposerExpanded(value => !value); } }}>
      <BotAvatar companion={companion} />
    </button>}
    <div className={`bot-call-dock${composerExpanded ? '' : ' is-collapsed'}`} ref={dock}>
      {mediaApi?.desktopCaptureSupported && <div className="bot-capture-controls-row" ref={setPetCaptureControls} />}
      {(desktop.pet || mediaApi?.desktopCaptureSupported) && <div className="bot-call-status-row" ref={setPetStatusRow} />}
      {(composerExpanded || mediaApi?.desktopCaptureSupported) && <div className="bot-call-input-group" hidden={!composerExpanded}>
      {desktop.pet && hudMenu && <div className="bot-call-pet-options" id={petOptionsId}>
          <div className="bot-call-pet-toolbar">
            <span className="bot-call-pet-identity"><BotAvatar companion={companion} /><strong title={companion.name}>{companion.name}</strong></span>
            {meetingControls}
          </div>
          {meetingMenu}
        </div>}
      {topics}
      {video.loginPrompt && <VideoLoginDialog state={video.loginPrompt} zh={zh} dismiss={video.dismissLogin} openUrl={onOpenUrl} />}
      {video.attached && <BotTopicAppCard appId="video" locale={locale} connected onOpen={() => onOpenUrl?.('https://www.bilibili.com/')} onRemove={() => void video.detach().catch(cause => setSendError(String(cause)))} />}
      {music.attached && <BotTopicAppCard appId="music" locale={locale} connected onRemove={() => void music.detach().catch(cause => setSendError(String(cause)))} />}
    <div className="bot-call-composer-host">
      <BotComposer meeting locale={locale} draft={draft} setDraft={setDraft} onTypingActivity={setTyping} disabled={!conversationId} busy={sending} group={false} world={false} conversationId={conversationId}
        panel={null} setPanel={() => undefined} send={() => submit()} mediaApi={mediaApi} attachments={files} addingFiles={importing}
        desktopCapture={{ surface: desktop.pet ? 'pet' : 'chat', companionName: companion.name, attach: attachFiles, statusTarget: petStatusRow, controlsTarget: petCaptureControls,
          interacting: chatInteracting || typing || sending || presenting || voiceInputActive || voiceHold }}
        addFiles={() => addFiles()} removeFile={id => setFiles(current => current.filter(file => file.id !== id))} sendSticker={media => submit(media)}
        extraTools={<>{composerTools}<BotApps locale={locale} disabled={sending || !conversationId} videoAttached={video.attached} onVideo={video.connect} musicAttached={music.attached} onMusic={music.connect} />{inputActions}</>} showInputTools={!desktop.pet || hudMenu || voiceInputActive} compact status={composerStatus} onVoiceInputStart={voice.stop} onVoiceInputActivity={setVoiceInputActive} />
    </div></div>}{!compactPet && !composerExpanded && <button type="button" className="bot-call-input-entry" data-pet-drag={desktop.pet ? '' : undefined} aria-expanded="false"
      aria-label={zh ? '展开会面输入' : 'Expand meeting input'} title={zh ? '展开会面输入' : 'Expand meeting input'}
      onClick={() => { setHudMenu(false); setComposerExpanded(true); }}><img src={startupLogo} alt="" draggable={false} /></button>}
    </div></>}
  </section></div></BotCallDocument.Provider></BotMeetingSession.Provider>, desktop.host);
}
