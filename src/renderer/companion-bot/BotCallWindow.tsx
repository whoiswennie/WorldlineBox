import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BotCompanion, BotMessage } from '../../shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import type { WorldlineBoxBotSpeechApi } from '../../shared/companion-bot-speech';
import { botSpeechText } from '../../shared/companion-bot-speech';
import { BotAvatar, botAssetUrl } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotMessageBody } from './BotMessageBody';
import { BotLive2DStage, type BotLive2DControls } from './BotLive2DStage';
import { BOT_CALL_PORTRAIT_SCALE, BOT_CALL_TIMEOUT_MS, botCallClock } from './call-presentation';
import { useBotCallSpeech } from './useBotCallSpeech';
import { useBotCallVoice, type BotCallSend } from './useBotCallVoice';
import { BotCallVoiceControls } from './BotCallVoiceControls';
import { BotCallCaption } from './BotCallCaption';
import './bot-call.css';

const sceneKey = 'worldlinebox.companion-call.scene.v1';
export interface BotCallComposerSendBridge {
  send(text: string, requestId: string, perform: () => Promise<{ ok: boolean; replyMessageIds?: readonly string[] }>): Promise<boolean>;
}
export interface BotCallComposerOptions {
  toolbar: ReactNode; status: ReactNode; corner?: ReactNode; onVoiceInputStart(): void; onVoiceInputActivity(active: boolean): void;
}
const poseFields = [
  ['headX', '左右转头', 'Turn head', -1, 1, 0], ['headY', '抬头低头', 'Tilt head', -1, 1, 0], ['headZ', '歪头', 'Lean head', -1, 1, 0],
  ['bodyX', '身体左右', 'Body', -1, 1, 0], ['gazeX', '视线左右', 'Look sideways', -1, 1, 0], ['gazeY', '视线上下', 'Look up/down', -1, 1, 0],
  ['mouthOpen', '张嘴', 'Mouth open', 0, 1, 0], ['mouthSmile', '嘴角', 'Smile', -1, 1, 0], ['eyeOpen', '睁眼', 'Eyes open', 0, 1.2, 1],
] as const;
function savedScene(): string { try { const saved = localStorage.getItem(sceneKey); return saved === 'plain' || saved === 'evening' || saved && /^data:image\/(?:png|jpeg|webp|avif);base64,[A-Za-z0-9+/]+=*$/u.test(saved) && saved.length < 4_000_000 ? saved : 'evening'; } catch { return 'evening'; } }
export function BotCallWindow({ conversationId, companion, messages, streams, mediaApi, speechApi, locale, onHangup, send, onOpenUrl, composer, registerComposerSend, onEditText, onDropFiles, hasPendingDraft = false, sendError = '' }: {
  conversationId: string;
  companion: BotCompanion; messages: readonly BotMessage[]; streams: Readonly<Record<string, string>>; locale: 'zh-CN' | 'en'; onHangup(): void;
  mediaApi?: WorldlineBoxBotMediaApi;
  speechApi?: WorldlineBoxBotSpeechApi;
  send: BotCallSend; onOpenUrl(url: string): void;
  composer(options: BotCallComposerOptions): ReactNode;
  registerComposerSend?(bridge?: BotCallComposerSendBridge): void;
  onEditText(text: string): void; onDropFiles?(files: File[]): void;
  hasPendingDraft?: boolean;
  sendError?: string;
}) {
  const zh = locale === 'zh-CN', [phase, setPhase] = useState<'ringing' | 'connected'>('ringing'), [openedAt] = useState(Date.now), [connectedAt, setConnectedAt] = useState(0), [now, setNow] = useState(Date.now);
  const [muted, setMuted] = useState(false), [audioBlocked, setAudioBlocked] = useState(false), audio = useRef<HTMLAudioElement>(undefined);
  const [scene, setScene] = useState(savedScene), [voiceInputActive, setVoiceInputActive] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(hasPendingDraft), [hudMenu, setHudMenu] = useState(false);
  const [control, setControl] = useState<BotLive2DControls>(), [modelError, setModelError] = useState(''), [interactions, setInteractions] = useState(false), [historyOpen, setHistoryOpen] = useState(false), [scale, setScale] = useState(BOT_CALL_PORTRAIT_SCALE);
  const [expression, setExpression] = useState(''), [motion, setMotion] = useState(''), [notice, setNotice] = useState('');
  const [historyFocus, setHistoryFocus] = useState<string>();
  const [pose, setPose] = useState<Record<string, number>>({}), [gazeEnabled, setGazeEnabled] = useState(true), [idleEnabled, setIdleEnabled] = useState(true);
  const speech = useBotCallSpeech({ api: speechApi, conversationId, companionId: companion.id, connected: phase === 'connected', messages, control });
  const speechPhase = speech.state.phase, stopSpeech = speech.stop;
  const voice = useBotCallVoice({ connected: phase === 'connected', conversationId, companionId: companion.id, messages, send, speech });
  const box = useRef<HTMLElement>(null), transcript = useRef<HTMLDivElement>(null), composerHost = useRef<HTMLDivElement>(null), liveStatus = useRef<HTMLDivElement>(null);
  const deepseek = companion.id === 'builtin-dafeiyu', remaining = Math.max(0, Math.ceil((BOT_CALL_TIMEOUT_MS - (now - openedAt)) / 1000));
  const chat = messages.filter(message => ['user', companion.id].includes(message.senderId) && (message.content || message.attachments?.length || streams[message.id] || ['queued', 'running', 'failed'].includes(message.status)));
  const latest = [...chat].reverse().find(message => message.senderId === companion.id && message.status === 'sent' && message.content);
  const presentingSpeech = speech.available && ['preparing', 'speaking'].includes(speech.state.phase);
  const pinnedSpeech = (presentingSpeech || speech.state.phase === 'error') && chat.find(message => message.senderId === companion.id && message.id === speech.state.messageId);
  const dialogue = pinnedSpeech || chat.find(message => speech.state.pendingMessageIds?.includes(message.id)) || [...chat].reverse().find(message => message.senderId === companion.id);
  const audioText = dialogue && speech.available && speech.state.messageId === dialogue.id && speech.state.phase !== 'error' && !speech.state.failures?.some(failure => failure.messageId === dialogue.id) ? speech.state.displayText : undefined;
  const captionSource = dialogue ? (['queued', 'running'].includes(dialogue.status) ? streams[dialogue.id] || dialogue.content : dialogue.content || streams[dialogue.id]) || '' : '';
  const captionText = botSpeechText(captionSource);
  const awaitingSpeech = !!dialogue && audioText === undefined && speech.available && !speech.state.failures?.some(failure => failure.messageId === dialogue.id)
    && (speech.state.pendingMessageIds?.includes(dialogue.id) || speech.enabled && !speech.state.textMessageIds?.includes(dialogue.id) && ['queued', 'running', 'sent'].includes(dialogue.status) && (dialogue.status !== 'sent' || !!captionText));
  const captionReveal = awaitingSpeech ? '' : audioText;
  const captionWaiting = dialogue?.status === 'failed' && !captionText ? zh ? '回复失败，请在聊天记录中查看详情。' : 'Reply failed. See the chat history.'
    : awaitingSpeech || captionReveal === '' || !captionSource && !!dialogue && ['queued', 'running'].includes(dialogue.status) ? dialogue?.status === 'sent' ? zh ? '正在准备语音…' : 'Preparing speech…' : zh ? '正在回应…' : 'Replying…' : undefined;
  const openHistory = () => { setHistoryFocus(undefined); setInteractions(false); setHistoryOpen(true); };
  const toggleInteractions = () => { setHistoryOpen(false); setInteractions(value => !value); };
  const ready = useCallback((controls: BotLive2DControls) => { setControl(controls); setModelError(''); }, []), failed = useCallback((message: string) => setModelError(message), []);
  const stopPlayback = () => { if (voice.state.enabled && voice.state.phase === 'speaking') voice.interrupt(); else speech.stop(); };
  const replay = (messageId: string) => { voice.waitForPlayback(); speech.replay(messageId); };
  const speechFailures = speech.state.failures?.length ? speech.state.failures : speech.state.phase === 'error' && speech.state.messageId ? [{ messageId: speech.state.messageId, error: speech.state.error }] : [];
  useEffect(() => {
    if (phase !== 'connected') return;
    registerComposerSend?.({ send: voice.sendAction });
    return () => registerComposerSend?.();
  }, [phase, registerComposerSend, voice.sendAction]);
  useEffect(() => { if (voiceInputActive && ['preparing', 'speaking'].includes(speechPhase)) stopSpeech(); }, [voiceInputActive, speechPhase, stopSpeech]);
  useLayoutEffect(() => {
    const host = composerHost.current, status = liveStatus.current, shell = box.current;
    if (phase !== 'connected' || !shell) return;
    const measure = () => {
      shell.style.setProperty('--bot-call-dock-height', `${host ? Math.max(96, Math.ceil(host.getBoundingClientRect().height)) : 0}px`);
      shell.style.setProperty('--bot-call-status-height', `${status ? Math.ceil(status.getBoundingClientRect().height) : 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); if (host) observer.observe(host); if (status) observer.observe(status);
    return () => { observer.disconnect(); shell.style.removeProperty('--bot-call-dock-height'); shell.style.removeProperty('--bot-call-status-height'); };
  }, [phase, composerExpanded]);
  useEffect(() => { const previous = document.activeElement; return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => { box.current?.querySelector<HTMLElement>(phase === 'ringing' ? '[data-call-accept]' : composerExpanded ? 'textarea' : '.bot-call-input-entry')?.focus(); }, [phase, composerExpanded]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { if (phase !== 'ringing') return; const timer = setTimeout(onHangup, Math.max(0, BOT_CALL_TIMEOUT_MS - (Date.now() - openedAt))); return () => clearTimeout(timer); }, [phase, openedAt, onHangup]);
  useEffect(() => {
    if (phase !== 'ringing') return;
    const sound = new Audio(botAssetUrl('companion-call/ringtone.wav')); sound.loop = true; sound.volume = .55; audio.current = sound;
    void sound.play().catch(() => setAudioBlocked(true));
    return () => { sound.pause(); sound.removeAttribute('src'); sound.load(); audio.current = undefined; };
  }, [phase]); // mute changes should not restart the first 26 seconds
  useEffect(() => { if (audio.current) audio.current.muted = muted; }, [muted, phase]);
  useEffect(() => {
    if (!transcript.current) return;
    const target = historyOpen && historyFocus && transcript.current.querySelector(`[data-call-message="${CSS.escape(historyFocus)}"]`);
    if (target) target.scrollIntoView?.({ block: 'center' }); else transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, streams, phase, historyOpen, historyFocus]);
  const changeScene = (value: string) => { setScene(value); try { localStorage.setItem(sceneKey, value); } catch { setNotice(zh ? '背景已用于本次会面，存储空间不足，未保存。' : 'Background applied for this visit; storage is full.'); } };
  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    if (!/^image\/(?:png|jpeg|webp|avif)$/u.test(file.type) || file.size > 2_500_000) { setNotice(zh ? '请选择小于 2.5 MB 的 PNG、JPEG、WebP 或 AVIF 图片。' : 'Choose a PNG, JPEG, WebP or AVIF image smaller than 2.5 MB.'); return; }
    const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') changeScene(reader.result); }; reader.onerror = () => setNotice(zh ? '背景图片读取失败。' : 'Could not read the image.'); reader.readAsDataURL(file);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (box.current?.querySelector('.bot-expression-picker,.bot-voice-panel')) return;
      if (composerExpanded) { event.preventDefault(); event.stopPropagation(); setComposerExpanded(false); return; }
      if (hudMenu) { event.preventDefault(); event.stopPropagation(); setHudMenu(false); return; }
      if (historyOpen || interactions) { event.preventDefault(); event.stopPropagation(); setHistoryOpen(false); setInteractions(false); return; }
      event.preventDefault(); event.stopPropagation(); onHangup(); return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),select,input') ?? []].filter(element => element.getClientRects().length > 0), first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const background = scene === 'plain' ? undefined : `url("${scene.startsWith('data:') ? scene : botAssetUrl('companion-call/scenes/evening.png')}")`;
  const frameModel = (upper: boolean) => { control?.view(upper); setScale(upper ? BOT_CALL_PORTRAIT_SCALE : 1); };
  const zoomModel = (delta: number) => { const value = Math.max(.65, Math.min(2.2, scale + delta)); control?.scale(value); setScale(value); };
  const interactionsPanel = interactions && <aside className="bot-call-interactions" aria-label={zh ? '场景与形象互动' : 'Scene and character controls'}><header><strong>{zh ? '场景与互动' : 'Scene & interactions'}</strong><button onClick={() => setInteractions(false)} aria-label={zh ? '收起互动设置' : 'Close interactions'}>×</button></header>
        <label>{zh ? '背景场景' : 'Background'}<select value={scene.startsWith('data:') ? 'custom' : scene} onChange={event => { if (event.target.value !== 'custom') changeScene(event.target.value); }}><option value="evening">{zh ? '暮色书房' : 'Evening studio'}</option><option value="plain">{zh ? '静谧留白' : 'Quiet space'}</option>{scene.startsWith('data:') && <option value="custom">{zh ? '自选图片' : 'Your image'}</option>}</select></label>
        <label className="bot-call-upload"><BotIcon name="image" />{zh ? '更换背景图片' : 'Choose a background'}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => void chooseImage(event)} /></label>
        {control && <><h3>{zh ? '神态与姿态' : 'Gaze & pose'}</h3><div className="bot-call-gesture-buttons"><button onClick={() => control.gesture('nod')}>{zh ? '点头' : 'Nod'}</button><button onClick={() => control.gesture('shake')}>{zh ? '摇头' : 'Shake'}</button><button onClick={() => control.gesture('blink')}>{zh ? '眨眼' : 'Blink'}</button></div>
          <label><input type="checkbox" checked={gazeEnabled} onChange={event => { setGazeEnabled(event.target.checked); control.gaze(event.target.checked); }} />{zh ? '视线跟随鼠标' : 'Follow pointer'}</label><label><input type="checkbox" checked={idleEnabled} onChange={event => { setIdleEnabled(event.target.checked); control.idle(event.target.checked); }} />{zh ? '自然待机动作' : 'Idle motion'}</label>
          {poseFields.map(([key, chinese, english, min, max, initial]) => <label className="bot-call-pose-slider" key={key}><span>{zh ? chinese : english}</span><input aria-label={zh ? chinese : english} type="range" min={min} max={max} step="0.02" value={pose[key] ?? initial} onChange={event => { const value = Number(event.target.value); setPose(current => ({ ...current, [key]: value })); control.pose({ [key]: value }); }} /><output>{(pose[key] ?? initial).toFixed(2)}</output></label>)}
          <h3>{zh ? '模型表情与动作' : 'Expressions & motions'}</h3><label>{zh ? '表情' : 'Expression'} <small>{control.catalog.expressions.length}</small><select aria-label={zh ? '选择模型表情' : 'Choose expression'} value={expression} onChange={event => { setExpression(event.target.value); if (event.target.value) control.expression(event.target.value); else { control.reset(); setPose({}); } }}><option value="">{zh ? '默认' : 'Default'}</option>{control.catalog.expressions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          <label>{zh ? '动作' : 'Motion'} <small>{control.catalog.motions.length}</small><select aria-label={zh ? '选择模型动作' : 'Choose motion'} value={motion} onChange={event => setMotion(event.target.value)}><option value="">{zh ? '选择动作' : 'Choose motion'}</option>{control.catalog.motions.map((item, index) => <option key={item.file} value={index}>{item.name}</option>)}</select></label><button disabled={!motion} onClick={() => control.motion(Number(motion))}>{zh ? '播放动作' : 'Play motion'}</button>
          <h3>{zh ? '取景' : 'Framing'}</h3><div className="bot-call-gesture-buttons"><button onClick={() => frameModel(true)}>{zh ? '半身' : 'Portrait'}</button><button onClick={() => frameModel(false)}>{zh ? '全身' : 'Full body'}</button></div><label>{zh ? '形象大小' : 'Character size'}<input type="range" min="0.65" max="2.2" step="0.05" value={scale} aria-label={zh ? '形象大小' : 'Character size'} onChange={event => { const value = Number(event.target.value); setScale(value); control.scale(value); }} /></label><button onClick={() => { control.reset(); setPose({}); setExpression(''); setMotion(''); }}>{zh ? '恢复默认姿态' : 'Reset pose'}</button>
          <small className="bot-call-credits">{control.catalog.credits}</small></>}
      </aside>;
  const startVoice = () => { if (speech.available && !speech.enabled) speech.toggle(); voice.start(); };
  const composerTools = <BotCallVoiceControls mode="toolbar" inputActive={voiceInputActive} voice={voice} zh={zh} onStart={startVoice} onEdit={onEditText} />;
  const composerStatus = <div className="bot-call-composer-status">
    <BotCallVoiceControls voice={voice} zh={zh} onStart={startVoice} onEdit={onEditText} hideErrorDetail={speechFailures.some(failure => failure.error === voice.state.error)} />
    {speech.available && <div className="bot-call-speech-controls" data-speech-phase={speech.state.phase}>{composerExpanded && <button type="button" aria-label={zh ? '自动朗读伙伴回复' : 'Read new replies aloud'} aria-pressed={speech.enabled} disabled={voiceInputActive} onClick={speech.toggle}><BotIcon name="volume" />{zh ? '自动朗读' : 'Read aloud'}</button>}<span role="status">{speech.state.phase === 'preparing' ? zh ? '正在准备语音…' : 'Preparing speech…' : speech.state.phase === 'speaking' ? zh ? `${companion.name}正在说话` : `${companion.name} is speaking` : zh ? '伙伴声音' : 'Companion voice'}</span>{['preparing', 'speaking'].includes(speech.state.phase) && <button type="button" onClick={stopPlayback} aria-label={zh ? '停止朗读' : 'Stop speech'}>{zh ? '停止' : 'Stop'}</button>}</div>}
    {!!speechFailures.length && <div className="bot-call-speech-failures">{speechFailures.map(failure => <div key={failure.messageId} className="bot-call-speech-error" role="alert" data-speech-failure={failure.messageId}><span>{failure.error}<small>{chat.find(message => message.id === failure.messageId)?.content.slice(0, 32)}</small></span><button type="button" disabled={voiceInputActive} onClick={() => replay(failure.messageId)}>{zh ? '重试朗读' : 'Retry speech'}</button></div>)}</div>}
  </div>;
  return createPortal(<div className="bot-call-overlay"><section ref={box} className={`bot-call-window is-${phase}`} role="dialog" aria-modal="true" aria-label={zh ? `与${companion.name}会面` : `Meet ${companion.name}`} onKeyDown={keyboard} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); onDropFiles?.([...event.dataTransfer.files]); } }}>
    <header className="bot-call-header"><div>{phase === 'ringing' && <span className="bot-call-brand">WORLDLINE · {zh ? '伙伴会面' : 'COMPANION'}</span>}<strong>{companion.name}</strong></div>{phase === 'ringing' && <span className="bot-call-mode">{zh ? '文字 / 语音输入' : 'Text / voice input'}</span>}{phase === 'connected' && <><button type="button" className="bot-call-history-toggle" aria-label={zh ? '会面聊天记录' : 'Meeting chat history'} aria-expanded={historyOpen} aria-controls="bot-call-history" onClick={() => { setHistoryFocus(undefined); setHudMenu(false); setInteractions(false); setHistoryOpen(value => !value); }}><BotIcon name="history" /><span>{zh ? '聊天记录' : 'History'}</span></button><button type="button" className="bot-call-menu-toggle" aria-label={zh ? '会面菜单' : 'Meeting menu'} aria-expanded={hudMenu} onClick={() => setHudMenu(value => !value)}><BotIcon name="settings" /></button><time className="bot-call-duration">{botCallClock(now - connectedAt)}</time></>}<button type="button" className="bot-call-close" aria-label={zh ? '结束并关闭会面' : 'End and close'} onClick={onHangup}>×</button></header>
    {phase === 'ringing' ? <div className="bot-call-ringing"><div className="bot-call-dial-orbit"><BotAvatar companion={companion} large /></div><h2>{companion.name}</h2><p>{zh ? '等待你接通' : 'Ready when you are'}</p><small>{zh ? `${remaining} 秒后自动结束` : `Ends automatically in ${remaining}s`}</small>
      <div className="bot-call-dial-actions"><button className="bot-call-hangup" onClick={onHangup}><BotIcon name="phone-off" /><span>{zh ? '取消' : 'Cancel'}</span></button><button className="bot-call-accept" data-call-accept onClick={() => { if (speech.available && speech.enabled) speech.unlock(); setConnectedAt(Date.now()); setPhase('connected'); }}><BotIcon name="phone" /><span>{zh ? '接通' : 'Connect'}</span></button></div>
      <button className="bot-call-ring-volume" onClick={() => setMuted(value => !value)} aria-pressed={muted}><BotIcon name="volume" />{muted ? zh ? '开启铃声' : 'Unmute ringtone' : zh ? '静音铃声' : 'Mute ringtone'}</button>
      {audioBlocked && <button className="bot-call-ring-retry" onClick={() => { void audio.current?.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)); }}>{zh ? '播放铃声' : 'Play ringtone'}</button>}
    </div> : <><div className="bot-call-connected"><div className="bot-call-scene" style={{ backgroundImage: background }}>
      <div className="bot-call-scene-shade" />
      {deepseek && !modelError ? <><BotLive2DStage onReady={ready} onError={failed} reaction={latest ? { id: latest.id, text: latest.content } : undefined} />{!control && <p className="bot-call-loading" role="status">{zh ? '正在准备形象…' : 'Preparing the character…'}</p>}</> : <div className="bot-call-portrait"><BotAvatar companion={companion} large /><h2>{companion.name}</h2><p>{zh ? '我在这里，慢慢聊。' : 'I’m here. Take your time.'}</p></div>}
      {modelError && <p className="bot-call-model-error" role="status">{modelError} {zh ? '可以继续打字聊天。' : 'You can keep chatting.'}</p>}
      {hudMenu && <aside className="bot-call-hud-menu" aria-label={zh ? '会面工具' : 'Meeting tools'}><div className="bot-call-scene-tools"><button aria-pressed={interactions} onClick={() => { setHudMenu(false); toggleInteractions(); }}><BotIcon name="sparkles" />{zh ? '场景与互动' : 'Scene & interactions'}</button></div>
      {control && <div className="bot-call-framing-tools" aria-label={zh ? '快捷取景' : 'Quick framing'}><button onClick={() => zoomModel(-.1)} disabled={scale <= .65} aria-label={zh ? '缩小形象' : 'Zoom out'}>−</button><button onClick={() => zoomModel(.1)} disabled={scale >= 2.2} aria-label={zh ? '放大形象' : 'Zoom in'}>+</button><button onClick={() => frameModel(scale < 1.5)}>{scale < 1.5 ? zh ? '半身取景' : 'Portrait view' : zh ? '全身取景' : 'Full body view'}</button></div>}
      </aside>}
      {notice && <button className="bot-call-notice" role="status" onClick={() => setNotice('')}>{notice} ×</button>}
      {!historyOpen && !interactions && dialogue && <section className="bot-call-dialogue" aria-label={zh ? '伙伴当前回应' : 'Current companion reply'} aria-live="polite" data-call-dialogue-message={dialogue.id}>
        <header><span className={`bot-call-speaking-wave${speech.state.phase === 'speaking' ? ' is-speaking' : ''}`} aria-hidden="true"><i /><i /><i /></span><span>{companion.name}</span>{speech.available && dialogue.status === 'sent' && !!dialogue.content.trim() && <button type="button" className="bot-call-replay" aria-label={speech.state.messageId === dialogue.id && ['preparing', 'speaking'].includes(speech.state.phase) ? zh ? '停止朗读' : 'Stop speech' : zh ? '朗读当前回应' : 'Read current reply'} onClick={() => speech.state.messageId === dialogue.id && ['preparing', 'speaking'].includes(speech.state.phase) ? stopPlayback() : replay(dialogue.id)}><BotIcon name="volume" /></button>}</header>
        <div className="bot-call-dialogue-content"><BotCallCaption key={dialogue.id} text={captionText || (captionSource ? zh ? '这条回复包含代码或附件，可查看完整内容。' : 'This reply contains code or attachments. View the full reply.' : '')} revealedText={captionReveal} waiting={captionWaiting} speaking={presentingSpeech} locale={locale} forceFull={!!captionSource && !captionText} onOpenFull={() => { setHistoryFocus(dialogue.id); setInteractions(false); setHistoryOpen(true); }} />
          {!!dialogue.attachments?.length && <div className="bot-call-caption-attachments"><BotMessageBody message={{ ...dialogue, content: '', status: 'sent' }} statusText="" locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} /></div>}
        </div>
      </section>}
    </div><section id="bot-call-history" className="bot-call-chat" hidden={!historyOpen && !interactions} aria-label={zh ? '会面聊天' : 'Conversation'}><header><nav role="tablist" aria-label={zh ? '会面面板' : 'Meeting panel'}><button role="tab" aria-selected={!interactions} onClick={openHistory}>{zh ? '对话' : 'Chat'}</button><button role="tab" aria-selected={interactions} onClick={() => { setHistoryOpen(false); setInteractions(true); }}>{zh ? '操作' : 'Interact'}</button></nav><button type="button" className="bot-call-panel-close" aria-label={zh ? '收起会面面板' : 'Close meeting panel'} onClick={() => { setHistoryOpen(false); setInteractions(false); }}>×</button></header>
      {interactionsPanel}<div hidden={interactions} className="bot-call-transcript" ref={transcript} role="log" aria-live="polite">
      {!chat.length && <div className="bot-call-chat-welcome">{zh ? `和${companion.name}打个招呼吧。` : `Say hello to ${companion.name}.`}</div>}
      {chat.map(message => <article key={message.id} className={message.senderId === 'user' ? 'is-user' : ''} data-call-message={message.id}><small>{message.senderId === 'user' ? zh ? '我' : 'You' : companion.name}{speech.available && message.senderId === companion.id && message.status === 'sent' && !!message.content.trim() && <button className="bot-call-replay" onClick={() => speech.state.messageId === message.id && ['preparing', 'speaking'].includes(speech.state.phase) ? stopPlayback() : replay(message.id)} aria-label={speech.state.messageId === message.id && ['preparing', 'speaking'].includes(speech.state.phase) ? zh ? '停止朗读' : 'Stop speech' : zh ? '朗读这条消息' : 'Read this reply'}><BotIcon name="volume" /></button>}</small><BotMessageBody message={message} streamedText={streams[message.id]} statusText={message.status === 'failed' ? zh ? '回复失败，请在私聊中查看详情。' : 'Reply failed. See your chat for details.' : zh ? '正在回应…' : 'Replying…'} locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} />{!message.content && !streams[message.id] && !message.attachments?.length && ['queued', 'running'].includes(message.status) && <p className="bot-call-pending" role="status">{zh ? '正在回应…' : 'Replying…'}</p>}</article>)}
    </div></section></div>
    {composerExpanded ? <div ref={composerHost} className="bot-call-composer-host">{composer({ toolbar: composerTools, status: composerStatus, corner: <button type="button" className="bot-call-composer-collapse" aria-label={zh ? '收起会面输入' : 'Collapse meeting input'} disabled={voiceInputActive} onClick={() => setComposerExpanded(false)}><BotIcon name="chevron-down" /></button>, onVoiceInputStart: () => { voice.stop(); speech.stop(); }, onVoiceInputActivity: setVoiceInputActive })}</div> : <><div ref={liveStatus} className="bot-call-live-status">{composerStatus}{sendError && <div className="bot-call-send-error" role="alert"><span>{sendError}</span><button type="button" onClick={() => setComposerExpanded(true)}>{zh ? '继续编辑' : 'Continue editing'}</button></div>}</div><div className="bot-call-input-row"><button type="button" className="bot-call-input-entry" aria-label={zh ? '展开会面输入' : 'Expand meeting input'} onClick={() => { setHudMenu(false); setComposerExpanded(true); }}>{hasPendingDraft ? zh ? '继续未发送的草稿' : 'Continue your unsent draft' : zh ? '说点什么 · 随时可以插话' : 'Say something · join in any time'}</button><div className="bot-call-entry-tools">{composerTools}{speech.available && <button type="button" aria-label={zh ? '自动朗读伙伴回复' : 'Read new replies aloud'} aria-pressed={speech.enabled} title={zh ? '伙伴声音' : 'Companion voice'} onClick={speech.toggle}><BotIcon name="volume" /></button>}</div></div></>}
    <footer className="bot-call-footer"><span><i />{zh ? voice.state.enabled ? '语音已开启' : '已接通' : voice.state.enabled ? 'Voice on' : 'Connected'}</span><button className="bot-call-hangup" onClick={onHangup}><BotIcon name="phone-off" />{zh ? '挂断' : 'End call'}</button><span>{zh ? '麦克风由你开启' : 'Microphone is opt-in'}</span></footer></>}
  </section></div>, document.body);
}
