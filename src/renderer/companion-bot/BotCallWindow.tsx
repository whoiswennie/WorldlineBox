import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotCompanion, BotMessage, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import type { BotCallModel, BotCallStage } from '../../shared/companion-call';
import { DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { BotAvatar, botAssetUrl } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotMessageBody } from './BotMessageBody';
import { BotLive2DStage, type BotLive2DControls } from './BotLive2DStage';
import { BOT_CALL_PORTRAIT_SCALE, BOT_CALL_TIMEOUT_MS, botCallClock } from './call-presentation';
import { useBotCallVoice, type BotCallSend } from './useBotCallVoice';
import { BotCallVoiceControls } from './BotCallVoiceControls';
import { BotCallDialogue, isCallTurnReply, type BotCallPlayback, type BotCallTurn } from './BotCallDialogue';
import { BotComposer } from './BotComposer';
import { BotTopicBar } from './BotTopicBar';
import { isBotFilePaste } from './clipboard-paste';
import { readBotCallPreferences, saveBotCallPreferences } from './call-preferences';
import { BotCallDocument, useCallPet } from './call-pet';
import './bot-call.css';

const emptyMessages: readonly BotMessage[] = [];
const poseFields = [
  ['headX', '左右转头', 'Turn head', -1, 1, 0], ['headY', '抬头低头', 'Tilt head', -1, 1, 0], ['headZ', '歪头', 'Lean head', -1, 1, 0],
  ['bodyX', '身体左右', 'Body', -1, 1, 0], ['gazeX', '视线左右', 'Look sideways', -1, 1, 0], ['gazeY', '视线上下', 'Look up/down', -1, 1, 0],
  ['mouthOpen', '张嘴', 'Mouth open', 0, 1, 0], ['mouthSmile', '嘴角', 'Smile', -1, 1, 0], ['eyeOpen', '睁眼', 'Eyes open', 0, 1.2, 1],
] as const;
export function BotCallWindow({ conversationId: directId, companion, api, mediaApi, locale, onHangup, onOpenUrl, draft, setDraft, onDesktopPetChange }: {
  conversationId: string; companion: BotCompanion; api: WorldlineBoxBotApi;
  mediaApi?: WorldlineBoxBotMediaApi; locale: 'zh-CN' | 'en'; onHangup(): void; onOpenUrl(url: string): void;
  draft: string; setDraft(text: string): void;
  onDesktopPetChange?(active: boolean, returning?: boolean): void;
}) {
  const zh = locale === 'zh-CN', [phase, setPhase] = useState<'ringing' | 'connected'>('ringing'), [openedAt] = useState(Date.now), [connectedAt, setConnectedAt] = useState(0), [now, setNow] = useState(Date.now);
  const [muted, setMuted] = useState(false), [audioBlocked, setAudioBlocked] = useState(false), audio = useRef<HTMLAudioElement>(undefined);
  const [preferences] = useState(() => readBotCallPreferences(companion.id));
  const [scene, setScene] = useState(preferences.scene), [voiceInputActive, setVoiceInputActive] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(!!draft), [hudMenu, setHudMenu] = useState(false);
  const [control, setControl] = useState<BotLive2DControls>(), [modelError, setModelError] = useState(''), [interactions, setInteractions] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [scale, setScale] = useState(BOT_CALL_PORTRAIT_SCALE);
  const [expression, setExpression] = useState(''), [motion, setMotion] = useState(''), [notice, setNotice] = useState('');
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [fullBody, setFullBody] = useState(false);
  const [topicPanelOpen, setTopicPanelOpen] = useState(false);
  const desktop = useCallPet(onDesktopPetChange);
  const petOptionsId = useId();
  const onTopicPanelOpen = useCallback((open: boolean) => {
    setTopicPanelOpen(open);
    if (open) setHudMenu(false);
  }, []);
  const [historyFocus, setHistoryFocus] = useState<string>();
  const [pose, setPose] = useState<Record<string, number>>({}), [gazeEnabled, setGazeEnabled] = useState(preferences.gazeEnabled), [idleEnabled, setIdleEnabled] = useState(preferences.idleEnabled);
  const [meeting, setMeeting] = useState<{ id: string; model?: BotCallModel; stage?: BotCallStage; baseline: Set<string> }>();
  const [snapshot, setSnapshot] = useState<BotSnapshot>();
  const [turn, setTurn] = useState<BotCallTurn>();
  const [older, setOlder] = useState<{ topicId?: string; items: BotMessage[]; more: boolean }>();
  const [stage, setStage] = useState({ generation: 0, ignored: new Set<string>(), interrupted: false });
  const stageState = useRef(stage);
  const playback = useRef<BotCallPlayback>({ replies: [], pending: [] });
  const presented = useRef(new Map<string, { id: string; sequence: number }>());
  const interrupting = useRef<Promise<BotResponse>>(undefined);
  const [connecting, setConnecting] = useState(false), [sendError, setSendError] = useState('');
  const [files, setFiles] = useState<BotMediaRef[]>([]), [importing, setImporting] = useState(false), [sending, setSending] = useState(false);
  const live = useRef(false), generation = useRef(0), sendLock = useRef(false), importLock = useRef(false);
  const latestDraft = useRef(draft);
  useLayoutEffect(() => { latestDraft.current = draft; }, [draft]);
  const attempts = useRef(new Map<string, Extract<BotRequest, { type: 'message.send' }>>());
  const textAttempt = useRef<string>(undefined);
  const box = useRef<HTMLElement>(null), transcript = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null);
  const historyFollowing = useRef(true);
  const conversationId = meeting?.id ?? '';
  const messages = snapshot?.messages ?? emptyMessages;
  const lastMessages = useRef(messages);
  useLayoutEffect(() => { lastMessages.current = messages; }, [messages]);
  const runtime = snapshot?.chatRuntime, topicId = runtime?.topic?.id;
  const recordPresentation = useCallback((messageId: string, segmentId: string, sequence: number) => {
    if ((presented.current.get(messageId)?.sequence ?? -1) < sequence) presented.current.set(messageId, { id: segmentId, sequence });
  }, []);
  const recordPlayback = useCallback((state: BotCallPlayback) => { playback.current = state; }, []);
  const updateStage = (value: typeof stage) => { stageState.current = value; setStage(value); };
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
    if (!conversationId) return;
    const serial = ++generation.current;
    const result = await request({ type: 'state', conversationId });
    if (live.current && serial === generation.current && result.snapshot) setSnapshot(result.snapshot);
  }, [conversationId, request]);
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
    return () => { clearTimeout(initial); clearTimeout(timer); unsubscribe(); };
  }, [api, conversationId, refresh]);
  const connect = async () => {
    setConnecting(true); setSendError('');
    const result = await request({ type: 'call.open', conversationId: directId });
    if (!live.current) return;
    setConnecting(false);
    if (!result.ok || !result.conversationId || !result.snapshot) return;
    const baseline = new Set(result.snapshot.messages.flatMap(message => message.parts?.filter(part => part.presentation).map(part => part.id) ?? []));
    for (const message of result.snapshot.messages) {
      const prior = message.parts?.findLast(part => part.presentation);
      if (prior) recordPresentation(message.id, prior.id, prior.sequence);
    }
    setMeeting({ id: result.conversationId, model: result.callModel, stage: result.callStage, baseline });
    setSnapshot(result.snapshot); setConnectedAt(Date.now()); setPhase('connected');
  };
  const interrupt = (requestId: string = crypto.randomUUID()): Promise<BotResponse> => {
    if (!conversationId) return Promise.resolve({ ok: false });
    if (interrupting.current) return interrupting.current;
    const current = stageState.current;
    const queued = messages.filter(message => message.senderId === companion.id && ['queued', 'running'].includes(message.status));
    const candidates = [...new Set([...playback.current.pending, ...queued.map(message => message.id)])].slice(0, 80);
    const replies = candidates.map(messageId => ({ messageId, throughSegmentId: presented.current.get(messageId)?.id }));
    const reset = { generation: current.generation + 1, ignored: new Set([...current.ignored, ...playback.current.replies, ...candidates]), interrupted: candidates.length > 0 };
    // Stop showing queued cues immediately. Main then fences publications and
    // returns any active replies not yet included in the renderer snapshot.
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
      const stopped = !input && (topicId || playback.current.pending.length || runtime?.running.length)
        ? interrupt('send-' + requestId) : undefined;
      setTurn({ id: requestId, content: content.trim() });
      if (!input) {
        if (stopped) {
          const result = await stopped;
          if (!result.ok || !live.current) return { ok: false };
        }
        if (stageState.current.interrupted) updateStage({ ...stageState.current, interrupted: false });
        input = { type: 'message.send', conversationId, content, requestId, topicId, attachmentIds };
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
  const hangup = () => {
    if (conversationId && (playback.current.pending.length || runtime?.running.some(reply => reply.topicId === topicId))) void interrupt();
    onHangup();
  };
  const send: BotCallSend = (text, requestId) => dispatch(text, requestId);
  const voice = useBotCallVoice({ connected: phase === 'connected', conversationId, companionId: companion.id, messages, send });
  const stopVoice = voice.stop;
  const topicRequest = useCallback(async (input: BotRequest) => {
    if (input.type !== 'topic.context' && input.type !== 'topic.list') setSendError('');
    const result = await request(input);
    if (result.ok && (input.type === 'topic.new' || input.type === 'topic.select') && result.topic?.id !== topicId) {
      for (const message of lastMessages.current) for (const part of message.parts ?? []) {
        if (part.presentation) meeting?.baseline.add(part.id);
      }
      stopVoice(); setTurn(undefined); setHistoryFocus(undefined); setOlder(undefined); historyFollowing.current = true;
      textAttempt.current = undefined;
    }
    return result;
  }, [meeting, request, stopVoice, topicId]);
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
      if (live.current && result.ok && result.media?.length) setFiles(current => [...new Map([...current, ...result.media!].map(file => [file.id, file])).values()]);
      if (live.current && !result.ok) setSendError(result.error ?? (zh ? '添加附件失败。' : 'Could not attach files.'));
    } catch { if (live.current) setSendError(zh ? '添加附件失败。' : 'Could not attach files.'); }
    finally { importLock.current = false; if (live.current) setImporting(false); }
  };
  const chat = [...new Map([...(older?.topicId === topicId ? older?.items ?? [] : []), ...messages].map(item => [item.id, item])).values()];
  const more = older?.topicId === topicId && older ? older.more : snapshot?.hasMore;
  const loadEarlier = async () => {
    if (!chat[0]) return;
    const result = await request({ type: 'state', conversationId, before: chat[0].sequence });
    if (!live.current || !result.snapshot || result.snapshot.chatRuntime?.topic?.id !== topicId) return;
    const page = result.snapshot;
    historyFollowing.current = false;
    setOlder(current => ({ topicId, items: [...new Map([...page.messages, ...(current?.topicId === topicId ? current?.items ?? [] : [])].map(item => [item.id, item])).values()], more: page.hasMore }));
  };
  const openHistory = () => { historyFollowing.current = true; setHistoryFocus(undefined); setInteractions(false); setHistoryOpen(true); };
  const toggleInteractions = () => { setHistoryOpen(false); setInteractions(value => !value); };
  const ready = useCallback((controls: BotLive2DControls) => { setControl(controls); setModelError(''); }, []);
  const failed = useCallback((message: string) => { setControl(undefined); setModelError(message); }, []);
  useEffect(() => { control?.gaze(gazeEnabled); }, [control, gazeEnabled]);
  useEffect(() => { control?.idle(idleEnabled); }, [control, idleEnabled]);
  useLayoutEffect(() => { control?.fullBody(fullBody); control?.scale(scale); control?.position(position.x, position.y); }, [control, fullBody, scale, position]);
  useLayoutEffect(() => {
    const host = dock.current, shell = box.current;
    if (phase !== 'connected' || !shell || !host) return;
    const measure = () => shell.style.setProperty('--bot-call-dock-height', host.offsetHeight + 'px');
    measure();
    const observer = new ResizeObserver(measure); observer.observe(host);
    return () => { observer.disconnect(); shell.style.removeProperty('--bot-call-dock-height'); };
  }, [phase]);
  useEffect(() => { const previous = document.activeElement; return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => { box.current?.querySelector<HTMLElement>(phase === 'ringing' ? '[data-call-accept]' : composerExpanded ? 'textarea' : '.bot-call-input-entry')?.focus(); }, [phase, composerExpanded]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { if (phase !== 'ringing') return; const timer = setTimeout(onHangup, Math.max(0, BOT_CALL_TIMEOUT_MS - (Date.now() - openedAt))); return () => clearTimeout(timer); }, [phase, openedAt, onHangup]);
  useEffect(() => {
    if (phase !== 'ringing') return;
    const ringtone = companion.id === DEFAULT_BOT_COMPANION_ID ? 'ringtones/dafeiyu.ogg' : 'ringtone.wav';
    const sound = new Audio(botAssetUrl('companion-call/' + ringtone)); sound.loop = true; sound.volume = .55; audio.current = sound;
    void sound.play().catch(() => { if (audio.current === sound) setAudioBlocked(true); });
    return () => { audio.current = undefined; sound.pause(); sound.removeAttribute('src'); sound.load(); };
  }, [companion.id, phase]);
  useEffect(() => { if (audio.current) audio.current.muted = muted; }, [muted, phase]);
  useEffect(() => {
    if (!transcript.current) return;
    const target = historyOpen && historyFocus && transcript.current.querySelector(`[data-call-message="${CSS.escape(historyFocus)}"]`);
    if (target) target.scrollIntoView?.({ block: 'center' }); else if (historyFollowing.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, phase, historyOpen, historyFocus]);
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
  const toggleDesktop = () => {
    setHudMenu(false);
    if (!desktop.toggle()) setNotice(zh ? '桌宠窗口暂时无法打开。' : 'The desktop pet window could not open.');
  };
  const frameModel = (upper: boolean) => {
    setFullBody(!upper);
    setScale(upper ? BOT_CALL_PORTRAIT_SCALE : 1);
    setPosition({ x: 0, y: 0 });
  };
  const zoomModel = (delta: number) => setScale(value => Math.min(3, Math.max(.4, value + delta)));
  const interactionsPanel = interactions && <aside className="bot-call-interactions" aria-label={zh ? '场景与形象互动' : 'Scene and character controls'}><header><strong>{zh ? '场景与互动' : 'Scene & interactions'}</strong><button onClick={() => setInteractions(false)} aria-label={zh ? '收起互动设置' : 'Close interactions'}>×</button></header>
        {!desktop.pet && <><label>{zh ? '背景场景' : 'Background'}<select value={scene.startsWith('data:') ? 'custom' : scene} onChange={event => { if (event.target.value !== 'custom') changeScene(event.target.value); }}><option value="evening">{zh ? '暮色书房' : 'Evening studio'}</option><option value="plain">{zh ? '静谧留白' : 'Quiet space'}</option>{scene.startsWith('data:') && <option value="custom">{zh ? '自选图片' : 'Your image'}</option>}</select></label>
        <label className="bot-call-upload"><BotIcon name="image" />{zh ? '更换背景图片' : 'Choose a background'}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => void chooseImage(event)} /></label></>}
        {control && <>
          <h3>{zh ? '取景' : 'Framing'}</h3>
          <div className="bot-call-gesture-buttons bot-call-framing-presets">
            <button type="button" aria-pressed={!fullBody} onClick={() => frameModel(true)}><BotIcon name="portrait" />{zh ? '半身' : 'Portrait'}</button>
            <button type="button" aria-pressed={fullBody} onClick={() => frameModel(false)}><BotIcon name="full-body" />{zh ? '全身' : 'Full body'}</button>
          </div>
          <label className="bot-call-pose-slider"><span>{zh ? '形象大小' : 'Character size'}</span><input type="range" min="0.4" max="3" step="0.01" value={scale} aria-label={zh ? '形象大小' : 'Character size'} onChange={event => setScale(Number(event.target.value))} /><output>{Math.round(scale * 100)}%</output></label>
          {(['x', 'y'] as const).map(axis => {
            const label = axis === 'x' ? (zh ? '水平位置' : 'Horizontal position') : (zh ? '垂直位置' : 'Vertical position');
            return <label className="bot-call-pose-slider" key={axis}><span>{label}</span><input type="range" min="-.4" max=".4" step=".01" value={position[axis]} aria-label={label} onChange={event => { const value = Number(event.target.value); setPosition(current => ({ ...current, [axis]: value })); }} /><output>{Math.round(position[axis] * 100)}%</output></label>;
          })}
          <button type="button" onClick={() => frameModel(true)}>{zh ? '重置取景' : 'Reset framing'}</button>
          <details className="bot-call-adjustment"><summary>{zh ? '神态与姿态' : 'Gaze & pose'}</summary><div className="bot-call-adjustment-body"><div className="bot-call-gesture-buttons"><button onClick={() => control.gesture('nod')}>{zh ? '点头' : 'Nod'}</button><button onClick={() => control.gesture('shake')}>{zh ? '摇头' : 'Shake'}</button><button onClick={() => control.gesture('blink')}>{zh ? '眨眼' : 'Blink'}</button></div>
          <label><input type="checkbox" checked={gazeEnabled} onChange={event => { setGazeEnabled(event.target.checked); saveBotCallPreferences(companion.id, { gazeEnabled: event.target.checked }); }} />{zh ? '视线跟随鼠标' : 'Follow pointer'}</label><label><input type="checkbox" checked={idleEnabled} onChange={event => { setIdleEnabled(event.target.checked); saveBotCallPreferences(companion.id, { idleEnabled: event.target.checked }); }} />{zh ? '自然待机动作' : 'Idle motion'}</label>
          {poseFields.map(([key, chinese, english, min, max, initial]) => <label className="bot-call-pose-slider" key={key}><span>{zh ? chinese : english}</span><input aria-label={zh ? chinese : english} type="range" min={min} max={max} step="0.02" value={pose[key] ?? initial} onChange={event => { const value = Number(event.target.value); setPose(current => ({ ...current, [key]: value })); control.pose({ [key]: value }); }} /><output>{(pose[key] ?? initial).toFixed(2)}</output></label>)}
          </div></details>
          <details className="bot-call-adjustment"><summary>{zh ? '表情与动作' : 'Expressions & motions'}</summary><div className="bot-call-adjustment-body"><label>{zh ? '表情' : 'Expression'} <small>{control.catalog.expressions.length}</small><select aria-label={zh ? '选择模型表情' : 'Choose expression'} value={expression} onChange={event => { setExpression(event.target.value); if (event.target.value) control.expression(event.target.value); else { control.reset(); setPose({}); } }}><option value="">{zh ? '默认' : 'Default'}</option>{control.catalog.expressions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label>{zh ? '动作' : 'Motion'} <small>{control.catalog.motions.length}</small><select aria-label={zh ? '选择模型动作' : 'Choose motion'} value={motion} onChange={event => setMotion(event.target.value)}><option value="">{zh ? '选择动作' : 'Choose motion'}</option>{control.catalog.motions.map((item, index) => <option key={item.file} value={index}>{item.name}</option>)}</select></label><button disabled={!motion} onClick={() => control.motion(Number(motion))}>{zh ? '播放动作' : 'Play motion'}</button>
          <button onClick={() => { control.reset(); setPose({}); setExpression(''); setMotion(''); }}>{zh ? '恢复默认姿态' : 'Reset pose'}</button>
          <small className="bot-call-credits">{control.catalog.credits}</small></div></details></>}
      </aside>;
  const editVoice = (text: string) => { setDraft(draft ? draft + '\n' + text : text); setComposerExpanded(true); };
  const composerTools = <BotCallVoiceControls mode="toolbar" inputActive={voiceInputActive} voice={voice} zh={zh} onStart={voice.start} onEdit={editVoice} />;
  const composerStatus = <div className="bot-call-composer-status">
    {modelError && <p className="bot-call-model-error" role="status">{modelError}</p>}
    <BotCallVoiceControls voice={voice} zh={zh} onStart={voice.start} onEdit={editVoice}
      onInterrupt={() => { void interrupt().then(result => { if (result.ok) voice.interrupt(); }); }} />
    {sendError && <p className="bot-call-send-error" role="alert">{sendError}</p>}
  </div>;
  const hangupButton = <button type="button" className="bot-call-hangup" aria-label={zh ? '挂断' : 'End call'} title={zh ? '挂断' : 'End call'} onClick={hangup}><BotIcon name="hangup" /></button>;
  const meetingControls = <>
    {desktop.supported && <button type="button" className="bot-call-pet-toggle" aria-label={petLabel} title={petLabel} onClick={toggleDesktop}><BotIcon name={desktop.pet ? 'return-scene' : 'desktop-pet'} /></button>}
    <button type="button" className="bot-call-history-toggle" aria-label={zh ? '会面聊天记录' : 'Meeting chat history'} title={zh ? '会面聊天记录' : 'Meeting chat history'} aria-expanded={historyOpen} aria-controls="bot-call-history"
      onClick={() => { historyFollowing.current = true; setHistoryFocus(undefined); setHudMenu(false); setInteractions(false); setHistoryOpen(value => !value); }}><BotIcon name="history" /></button>
    {!desktop.pet && <button type="button" className="bot-call-menu-toggle" aria-label={zh ? '会面菜单' : 'Meeting menu'} title={zh ? '会面菜单' : 'Meeting menu'} aria-expanded={hudMenu} onClick={() => setHudMenu(value => !value)}><BotIcon name="settings" /></button>}
    <time className="bot-call-duration">{botCallClock(now - connectedAt)}</time>
  </>;
  const meetingMenu = <aside className="bot-call-hud-menu" aria-label={zh ? '会面工具' : 'Meeting tools'}>
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
    {desktop.pet ? <button type="button" className="bot-call-pet-more" aria-label={zh ? '更多会面功能' : 'More meeting controls'} title={zh ? '更多会面功能' : 'More meeting controls'} aria-expanded={hudMenu} aria-controls={hudMenu ? petOptionsId : undefined}
      onClick={() => { setHistoryOpen(false); setInteractions(false); setHudMenu(value => !value); }}><BotIcon name="more" /></button>
      : composerExpanded && <button type="button" aria-label={zh ? '收起会面输入' : 'Collapse meeting input'} title={zh ? '收起会面输入' : 'Collapse meeting input'} disabled={voiceInputActive} onClick={() => setComposerExpanded(false)}><BotIcon name="chevron-down" /></button>}
    {hangupButton}
  </>;
  const question = messages.findLast(message => message.execution?.question && isCallTurnReply(message, turn) && !stage.ignored.has(message.id));
  const answer = (messageId: string, questionId: string, text: string) => request({ type: 'execution.answer', messageId, questionId, text });
  const topics = <div className="bot-call-topics" aria-label={zh ? '会面话题' : 'Meeting topics'} role="region">
    {desktop.pet && <span className="bot-call-pet-grip" data-pet-drag title={zh ? '拖动桌宠' : 'Drag desktop pet'} aria-hidden="true"><BotIcon name="grip" /></span>}
    <BotTopicBar conversationId={conversationId} runtime={runtime} members={[companion]} locale={locale} request={topicRequest} refresh={refresh} onPanelOpenChange={onTopicPanelOpen} />
  </div>;
  return createPortal(<BotCallDocument.Provider value={desktop.surface}><div className={`bot-call-overlay${desktop.pet ? ' is-desktop-pet' : ''}`}><section ref={box} className={`bot-call-window is-${phase}${fullBody ? " is-full-body" : ""}${!meeting?.model || modelError ? ' is-static-portrait' : ''}`} role="dialog" aria-modal={!desktop.pet} aria-label={zh ? `与${companion.name}会面` : `Meet ${companion.name}`} onKeyDown={keyboard} onPaste={event => { if (conversationId && mediaApi && isBotFilePaste(event.clipboardData, () => mediaApi?.hasClipboardFiles?.(conversationId) ?? false)) { event.preventDefault(); event.stopPropagation(); void addFiles(undefined, true); } }} onDragOver={event => { if (conversationId && mediaApi && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); const paths = mediaApi?.getDroppedFilePaths([...event.dataTransfer.files]); if (paths?.length) void addFiles(paths); } }}>
    {!desktop.pet && <header className="bot-call-header">
      <div>{phase === 'ringing' && <span className="bot-call-brand">WORLDLINE · {zh ? '伙伴会面' : 'COMPANION'}</span>}<strong>{companion.name}</strong></div>
      {phase === 'ringing' ? <span className="bot-call-mode">{zh ? '文字 / 语音输入' : 'Text / voice input'}</span> : meetingControls}
      <button type="button" className="bot-call-close" aria-label={zh ? '结束并关闭会面' : 'End and close'} onClick={hangup}>×</button>
    </header>}
    {phase === 'ringing' ? <div className="bot-call-ringing"><div className="bot-call-dial-orbit"><BotAvatar companion={companion} large /></div><h2>{companion.name}</h2><p>{zh ? '等待你接通' : 'Ready when you are'}</p><small>{zh ? `${remaining} 秒后自动结束` : `Ends automatically in ${remaining}s`}</small>
      <div className="bot-call-dial-actions"><button className="bot-call-hangup" onClick={onHangup}><BotIcon name="phone-off" /><span>{zh ? '取消' : 'Cancel'}</span></button><button className="bot-call-accept" data-call-accept disabled={connecting} onClick={() => void connect()}><BotIcon name="phone" /><span>{connecting ? (zh ? '接通中…' : 'Connecting…') : (zh ? '接通' : 'Connect')}</span></button></div>
      <button className="bot-call-ring-volume" onClick={() => setMuted(value => !value)} aria-pressed={muted}><BotIcon name="volume" />{muted ? zh ? '开启铃声' : 'Unmute ringtone' : zh ? '静音铃声' : 'Mute ringtone'}</button>
      {audioBlocked && <button className="bot-call-ring-retry" onClick={() => { void audio.current?.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)); }}>{zh ? '播放铃声' : 'Play ringtone'}</button>}
      {sendError && <p className="bot-call-ring-error" role="alert">{sendError}</p>}
    </div> : <><div className="bot-call-connected"><div className="bot-call-scene" style={{ backgroundImage: background }}>
      {!desktop.pet && <div className="bot-call-scene-shade" />}
      {meeting?.model && !modelError ? <><BotLive2DStage model={meeting.model} name={companion.name} desktopPet={desktop.pet} onReady={ready} onError={failed} />{!control && <p className="bot-call-loading" role="status">{zh ? '正在准备形象…' : 'Preparing the character…'}</p>}</>
        : <div className="bot-call-portrait"><div className="bot-call-portrait-frame"><BotAvatar companion={companion} large /></div><h2>{companion.name}</h2></div>}
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
      {more && <button type="button" onClick={() => void loadEarlier()}>{zh ? '更早的对话' : 'Earlier messages'}</button>}
      {!chat.length && <div className="bot-call-chat-welcome">{desktop.pet && <BotIcon name="history" />}{zh ? '这个话题还没有消息。' : 'This topic has no messages yet.'}</div>}
      {chat.map(message => <article key={message.id} className={message.senderId === 'user' ? 'is-user' : ''} data-call-message={message.id}>
        <small>{message.senderId === 'user' ? (zh ? '我' : 'You') : companion.name}</small>
        {message.parts?.filter(part => part.presentation && part.text).map(part => <p className="bot-call-log-bubble" key={part.id}>{part.text}</p>)}
        <BotMessageBody message={{ ...message, parts: undefined, execution: undefined, content: message.senderId === 'user' ? message.content : '' }}
          statusText={message.status === 'failed' ? (zh ? '回复失败。' : 'Reply failed.') : ''} locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} />
        {message.execution?.question && <BotMessageBody message={{ ...message, parts: undefined, content: '', attachments: undefined }} statusText="" locale={locale} onAnswer={(id, text) => answer(message.id, id, text)} />}
      </article>)}
    </div></section></div>
    <div className="bot-call-dock" ref={dock}>
      {meeting && <BotCallDialogue key={`${turn?.id ?? topicId ?? 'empty'}:${stage.generation}`} turn={turn} messages={messages} baseline={meeting.baseline} ignored={stage.ignored} connectedAt={connectedAt}
        speechApi={api} conversationId={conversationId} muted={muted}
        catalog={meeting.model?.assets} stage={meeting.stage} control={control} modelLoading={!!meeting.model && !control && !modelError}
        hidden={historyOpen || interactions || topicPanelOpen || desktop.pet && hudMenu} companion={companion} zh={zh}
        interrupted={stage.interrupted} onPresent={recordPresentation} onPlayback={recordPlayback} onInterrupt={() => { void interrupt(); }}
        onHistory={messageId => { setHistoryFocus(messageId); setInteractions(false); setHistoryOpen(true); }}
        extra={question && <BotMessageBody message={{ ...question, parts: undefined, content: '', attachments: undefined }} statusText="" locale={locale} onAnswer={(id, text) => answer(question.id, id, text)} />} />}
      <div className="bot-call-input-group">
      {desktop.pet && hudMenu && <div className="bot-call-pet-options" id={petOptionsId}>
          <div className="bot-call-pet-toolbar">
            <span className="bot-call-pet-identity"><BotAvatar companion={companion} /><strong title={companion.name}>{companion.name}</strong></span>
            {meetingControls}
          </div>
          {meetingMenu}
        </div>}
      {topics}
    {composerExpanded || desktop.pet ? <div className="bot-call-composer-host">
      <BotComposer meeting locale={locale} draft={draft} setDraft={setDraft} disabled={!conversationId} busy={sending} group={false} world={false} conversationId={conversationId}
        panel={null} setPanel={() => undefined} send={() => submit()} mediaApi={mediaApi} attachments={files} addingFiles={importing}
        addFiles={() => addFiles()} removeFile={id => setFiles(current => current.filter(file => file.id !== id))} sendSticker={media => submit(media)}
        extraTools={<>{composerTools}{inputActions}</>} showInputTools={!desktop.pet || hudMenu || voiceInputActive} compact status={composerStatus} onVoiceInputStart={voice.stop} onVoiceInputActivity={setVoiceInputActive} />
    </div> : <><div className="bot-call-live-status">{composerStatus}</div>
      <div className="bot-call-input-row"><button type="button" className="bot-call-input-entry" aria-label={zh ? '展开会面输入' : 'Expand meeting input'}
        onClick={() => { setHudMenu(false); setComposerExpanded(true); }}>{draft || files.length ? (zh ? '继续草稿' : 'Continue draft') : (zh ? '说点什么…' : 'Say something…')}</button>{composerTools}{inputActions}</div></>}</div>
    </div></>}
  </section></div></BotCallDocument.Provider>, desktop.host);
}
