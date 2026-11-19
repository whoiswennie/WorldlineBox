import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOT_PRESENCE_CAPTURE_EDGE, BOT_PRESENCE_CLIP_SECONDS, BOT_PRESENCE_MAX_CLIP_BYTES, type BotDesktopCaptureScope, type BotPresenceStatus, type BotPresenceEnergy, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';
import { BotErrorNotice } from './BotErrorNotice';
import { useBotCallDocument, useBotMeetingSession } from './call-pet';
import { BotPresenceArchive } from './BotPresenceArchive';

type Clip = ReturnType<typeof recordClip>;
type Session = { scope: BotDesktopCaptureScope; energy: BotPresenceEnergy; stream?: MediaStream; clip?: Clip; timer?: ReturnType<typeof setInterval>;
  uploads: Set<Promise<void>>; cycle: number; recording: boolean; startedCycle?: number; changing?: boolean; connect?(): Promise<void>; poll?(): Promise<void>; latest?: BotPresenceStatus; accept?(status: BotPresenceStatus): boolean };

function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('陪伴采集连接超时，可重新开始陪伴。')), ms); });
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer));
}

function recordClip(stream: MediaStream, sealed: () => void, recordingChanged: (recording: boolean) => void) {
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw Error('当前环境无法录制带声音的陪伴短片。');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 64_000 });
  const chunks: Blob[] = [];
  const startedAt = Date.now(), started = performance.now();
  let bytes = 0, endedAt = startedAt;
  let reported = false;
  const report = (value: boolean) => { if (reported !== value) { reported = value; recordingChanged(value); } };
  const stop = () => {
    if (recorder.state === 'inactive') return;
    endedAt = startedAt + Math.max(1, Math.round(performance.now() - started));
    recorder.stop();
    report(false);
  };
  const finished = new Promise<{ bytes: Uint8Array<ArrayBuffer>; startedAt: number; endedAt: number } | undefined>((resolve, reject) => {
    recorder.ondataavailable = ({ data }) => {
      bytes += data.size;
      if (bytes > BOT_PRESENCE_MAX_CLIP_BYTES) { stop(); return; }
      if (data.size) chunks.push(data);
      if (bytes >= BOT_PRESENCE_MAX_CLIP_BYTES * .75) stop();
    };
    recorder.onstart = () => { if (recorder.state === 'recording') report(true); };
    recorder.onerror = () => { clearTimeout(timer); report(false); reject(Error('陪伴短片录制中断。')); };
    recorder.onstop = () => {
      clearTimeout(timer);
      report(false);
      if (bytes > BOT_PRESENCE_MAX_CLIP_BYTES) { reject(Error('一段陪伴录像超过本地缓存限制。')); return; }
      try { sealed(); } catch (error) { reject(error); return; }
      if (!bytes) { resolve(undefined); return; }
      void new Blob(chunks, { type: mimeType }).arrayBuffer().then(buffer => resolve({ bytes: new Uint8Array(buffer), startedAt, endedAt: Math.max(startedAt + 1, endedAt) }), reject);
    };
  });
  recorder.start(1000);
  const timer = setTimeout(stop, BOT_PRESENCE_CLIP_SECONDS * 1000);
  return { finished: within(finished, (BOT_PRESENCE_CLIP_SECONDS + 8) * 1000), stop, isRecording: () => recorder.state === 'recording' };
}

function HeartbeatCountdown({ status, zh }: { status: BotPresenceStatus; zh: boolean }) {
  const deadline = status.nextAt;
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const refresh = () => setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    refresh();
    const interval = setInterval(refresh, 250);
    return () => clearInterval(interval);
  }, [deadline]);
  if (status.waitingForPartner || !deadline) return null;
  const time = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const label = zh ? '下次心跳' : 'Next heartbeat';
  return <time aria-label={label} title={label} className="bot-presence-countdown">{time}</time>;
}

const energies = ['low', 'balanced', 'active'] as const;

function PresenceActivity({ status, recording, zh, petName }: { status: BotPresenceStatus; recording: boolean; zh: boolean; petName?: string }) {
  const capture = recording ? 'recording' : status.screenshot;
  const activity = status.phase ?? (status.capturePaused ? 'paused' : status.capture === 'screen' ? 'waiting' : 'starting');
  const labels = zh ? { recording: '正在录屏', capturing: '正在截图', 'just-captured': '刚刚已截图', sealing: '正在收尾采集',
    preparing: '正在整理画面与字幕', observing: status.vision ? '正在观察本轮画面' : '正在理解本轮记录', paused: '采集暂缓', waiting: '等待下次截图', starting: '准备录屏' }
    : { recording: 'Recording screen', capturing: 'Taking screenshot', 'just-captured': 'Screenshot taken', sealing: 'Finishing capture',
      preparing: 'Preparing frames and subtitles', observing: status.vision ? 'Reviewing captured frames' : 'Reviewing this round', paused: 'Capture on hold', waiting: 'Waiting for screenshot', starting: 'Preparing to record' };
  const petLabels = !petName ? labels : zh ? { recording: petName + '正在观察你', capturing: '让我截一张，记住这一刻',
    'just-captured': '截好啦，刚才的画面我留住了', sealing: '这段看完啦，我收个尾', preparing: '我在整理刚才看到的画面',
    observing: '我在回想刚才那一幕', paused: '让我先歇会儿，这会儿没看屏幕', waiting: '我在旁边陪你，这会儿没看屏幕', starting: '等我准备好，再陪你看屏幕' }
    : { recording: petName + ' is watching along with you', capturing: petName + ' is taking a look at your screen',
      'just-captured': petName + ' saw that moment', sealing: 'Taking one last look', preparing: 'Recalling the last few moments',
      observing: petName + ' is reflecting', paused: 'Taking a short break', waiting: petName + ' is keeping you company', starting: petName + ' is looking at your screen' };
  const technical = capture === 'recording' ? 'recording' : capture === 'capturing' ? 'screenshot' : 'idle';
  return <span className="bot-presence-activity" data-capture={technical} aria-live="polite" aria-atomic="true">
    {capture && <small data-activity={capture} title={labels[capture]}><BotIcon name={recording ? 'video' : 'screen'} />{petLabels[capture]}</small>}
    {petName && recording && <small>{zh ? '我在录下这段画面' : 'I’m recording this part'}</small>}
    {(!capture || technical === 'idle' && status.phase) && <small data-activity={activity} title={labels[activity]}>{petLabels[activity]}</small>}
  </span>;
}

export function BotCompanionPresence({ api, conversationId, surface, petName, meeting, zh, controlsTarget, statusTarget, onStarted, interacting }: {
  api: WorldlineBoxBotMediaApi; conversationId: string; surface: 'chat' | 'pet'; zh: boolean;
  meeting: boolean; controlsTarget: HTMLElement | null; statusTarget: HTMLElement | null; onStarted(): void; interacting?: boolean; petName?: string;
}) {
  const doc = useBotCallDocument();
  const sessionId = useBotMeetingSession();
  const active = useRef<Session>(undefined);
  const [recording, setRecording] = useState(false);
  const inConversation = useRef(interacting);
  useEffect(() => {
    inConversation.current = interacting;
    const session = active.current;
    if (interacting && session) {
      session.recording = false;
      session.clip?.stop();
      for (const track of session.stream?.getTracks() ?? []) track.enabled = false;
    }
    void session?.poll?.();
  }, [interacting]);
  const [mode, setMode] = useState<'off' | 'starting' | 'active' | 'paused'>('off');
  const [energy, setEnergy] = useState<BotPresenceEnergy>('balanced');
  const [changing, setChanging] = useState(false);
  const [archiveScope, setArchiveScope] = useState<BotDesktopCaptureScope>();
  const [status, setStatus] = useState<BotPresenceStatus>();
  const [error, setError] = useState('');
  useEffect(() => api.onPresenceActivity?.(event => {
    const session = active.current;
    if (session && !session.changing && event.requestId === session.scope.requestId && event.conversationId === conversationId
      && event.surface === surface && event.status.cycle >= session.cycle) session.accept?.(event.status);
  }), [api, conversationId, surface]);
  const release = useCallback(async () => {
    const session = active.current;
    if (!session) return;
    active.current = undefined;
    clearInterval(session.timer);
    session.recording = false;
    session.clip?.stop();
    session.stream?.getTracks().forEach(track => track.stop());
    await api.request({ type: 'desktop.cancel', ...session.scope }).catch(() => undefined);
  }, [api]);
  useEffect(() => () => { void release(); }, [release]);

  const stop = (paused: boolean) => {
    void release(); setRecording(false); setStatus(undefined); setError(''); setChanging(false); setMode(paused ? 'paused' : 'off');
  };
  const start = async () => {
    if (active.current) return;
    const scope = { conversationId, surface, requestId: crypto.randomUUID() };
    const session: Session = { scope, energy, uploads: new Set(), cycle: 0, recording: false };
    const current = () => active.current === session;
    active.current = session;
    setError(''); setStatus(undefined); setMode('starting');
    onStarted();
    const fail = (reason: unknown) => {
      if (current()) { stop(false); setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    try {
      if (!sessionId) throw Error(zh ? '请先接通伙伴会面。' : 'Connect the meeting first.');
      const ready = await within(api.request({ type: 'desktop.presence.start', ...scope, sessionId, energy, meeting, interacting: inConversation.current }), 15_000);
      if (!current()) {
        void api.request({ type: 'desktop.cancel', ...scope }).catch(() => undefined);
        return;
      }
      if (!ready.ok) throw Error(ready.error);
      session.cycle = ready.presence?.cycle ?? 0;
      setStatus(ready.presence);
      const connect = async () => {
        const devices = doc.defaultView?.navigator.mediaDevices;
        if (!devices?.getDisplayMedia) throw Error(zh ? '当前窗口无法采集桌面。' : 'Desktop capture is unavailable in this window.');
        const view = doc.defaultView!;
        const width = view.screen.width * view.devicePixelRatio, height = view.screen.height * view.devicePixelRatio;
        const scale = Math.min(1, BOT_PRESENCE_CAPTURE_EDGE / Math.max(width, height));
        const stream = await devices.getDisplayMedia({ video: { frameRate: { ideal: 6, max: 8 },
          width: { ideal: Math.round(width * scale), max: BOT_PRESENCE_CAPTURE_EDGE }, height: { ideal: Math.round(height * scale), max: BOT_PRESENCE_CAPTURE_EDGE } }, audio: true });
        if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
        session.stream = stream;
        for (const track of stream.getTracks()) track.enabled = false;
        for (const track of stream.getVideoTracks()) track.contentHint = 'detail';
        if (!stream.getVideoTracks().length) throw Error(zh ? '未取得桌面画面。' : 'Screen capture is unavailable.');
        for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => fail(Error(zh ? '屏幕共享已结束。' : 'Desktop sharing has ended.')), { once: true });
      };
      session.connect = () => within(connect(), 15_000);
      if (energy !== 'low') await session.connect();
      if (!current()) return;
      setMode('active');
      const recordNext = () => {
        if (!current() || !session.recording || session.changing || !session.stream || session.clip || session.uploads.size >= 2) return;
        const cycle = session.cycle;
        const clip = recordClip(session.stream, () => {
          if (session.clip === clip) session.clip = undefined;
          recordNext();
        }, value => {
          if (!current()) return;
          if (value) session.startedCycle = cycle;
          setRecording(value);
          void api.request({ type: 'desktop.presence.recording', ...scope, cycle, recording: value }).catch(() => undefined);
        });
        session.clip = clip;
        const upload = clip.finished.then(async data => {
          if (data && current() && !inConversation.current) {
            const saved = await within(api.request({ type: 'desktop.presence.clip', ...scope, ...data, cycle }), 10_000);
            if (!saved.ok) throw Error(saved.error);
          }
        });
        session.uploads.add(upload);
        void upload.catch(fail).finally(() => { session.uploads.delete(upload); if (current() && session.recording) { try { recordNext(); } catch (reason) { fail(reason); } } });
      };
      const updateRecorder = (status: BotPresenceStatus) => {
        const record = status.capture === 'video' && !status.thinking && !status.capturePaused && !inConversation.current;
        session.recording = record;
        const stream = session.stream;
        if (!record) session.clip?.stop();
        for (const track of stream?.getTracks() ?? []) track.enabled = record;
        if (record) recordNext();
      };
      session.accept = status => {
        if (status.cycle < session.cycle || (status.revision ?? 0) < (session.latest?.revision ?? 0)) return false;
        session.latest = status;
        session.cycle = status.cycle;
        setStatus(status);
        updateRecorder(status);
        return true;
      };
      let polling = false;
      let flushedCycle: number | undefined;
      const poll = async () => {
        if (!current() || polling || session.changing) return;
        polling = true;
        try {
          const result = await within(api.request({ type: 'desktop.presence.status', ...scope, recordingCycle: session.startedCycle,
            recording: session.clip?.isRecording() ?? false, interacting: inConversation.current }), 10_000);
          if (!current() || session.changing) return;
          if (!result.ok || !result.presence) throw Error(result.error || (zh ? '陪伴模式已结束。' : 'Companion mode has ended.'));
          if (!session.accept!(result.presence)) return;
          const { flushCycle } = result.presence;
          if (flushCycle !== undefined && flushCycle !== flushedCycle) {
            await Promise.all([...session.uploads]);
            if (!current()) return;
            const ack = await within(api.request({ type: 'desktop.presence.flushed', ...scope, cycle: flushCycle }), 10_000);
            if (!ack.ok) throw Error(ack.error);
            flushedCycle = flushCycle;
          }
        } catch (reason) { fail(reason); } finally { polling = false; }
      };
      if (ready.presence) session.accept(ready.presence);
      session.poll = poll;
      session.timer = setInterval(() => { void poll(); }, 750);
      void poll();
    } catch (reason) { fail(reason); }
  };
  const changeEnergy = async (value: BotPresenceEnergy) => {
    const session = active.current;
    if (!session) { setEnergy(value); return; }
    if (session.changing || session.energy === value) return;
    session.changing = true;
    setChanging(true); setError('');
    try {
      session.recording = false;
      session.clip?.stop();
      await Promise.all([...session.uploads]);
      if (active.current !== session) return;
      const result = await within(api.request({ type: 'desktop.presence.energy', ...session.scope, energy: value }), 10_000);
      if (active.current !== session) return;
      if (!result.ok || result.cancelled) throw Error(result.error);
      session.energy = value;
      if (value === 'low') {
        session.stream?.getTracks().forEach(track => track.stop());
        session.stream = undefined;
      } else if (!session.stream) await session.connect?.();
      if (active.current !== session) return;
      if (result.presence) session.cycle = result.presence.cycle;
      setEnergy(value);
      setStatus(result.presence);
    } catch (reason) {
      if (active.current === session) { stop(false); setError(reason instanceof Error ? reason.message : String(reason)); }
    } finally {
      session.changing = false;
      if (active.current === session) setChanging(false);
    }
  };
  const interrupt = async () => {
    const session = active.current;
    if (!session) return;
    try {
      const result = await api.request({ type: 'desktop.presence.interrupt', ...session.scope });
      if (!result.ok) throw Error(result.error);
      if (active.current === session) setStatus(result.presence);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const words = zh ? { power: '精力值', low: '低 · 只截图', balanced: '平衡 · 录像或截图', active: '高 · 持续录像', start: '开始陪伴', resume: '继续陪伴', pause: '暂停陪伴', stop: '结束陪伴', clear: '清空观察缓存' }
    : { power: 'Energy', low: 'Low · Screenshots', balanced: 'Balanced · Mixed', active: 'High · Continuous video', start: 'Start companion mode', resume: 'Resume companion mode', pause: 'Pause companion mode', stop: 'End companion mode', clear: 'Clear observation buffer' };
  const label = mode === 'paused' ? (zh ? '陪伴已暂停' : 'Companion mode paused') : mode === 'starting' ? (zh ? '正在连接桌面' : 'Connecting to the desktop')
    : status?.vision === false ? (zh ? '陪伴中 · 模型无图像能力' : 'Alongside you · model has no vision') : zh ? '陪伴中' : 'Alongside you';
  const diagnostic = error || status?.error;
  const hint = mode === 'active' ? `${label} · ${words[energy]}` : label;
  const pausedForChat = interacting || status?.waitingForPartner;
  const capturing = recording || status?.screenshot === 'capturing';
  const last = status?.last;
  const outcomes = zh ? { responded: '上轮已回应', observed: '上轮已观察', failed: '上轮未完成', interrupted: '上轮已中断' }
    : { responded: 'Last round replied', observed: 'Last round observed', failed: 'Last round did not finish', interrupted: 'Last round interrupted' };
  const lastLabel = last && outcomes[last.outcome];
  return <>
    {controlsTarget && createPortal(<div className="bot-presence-settings">
      <label>{words.power}<select aria-label={words.power} value={energy} disabled={mode === 'starting' || changing} onChange={event => void changeEnergy(event.target.value as BotPresenceEnergy)}>
        {energies.map(value => <option value={value} key={value}>{words[value]}</option>)}
      </select></label>
      {(mode === 'off' || mode === 'paused') && <button type="button" onClick={() => void start()}>{mode === 'paused' ? words.resume : words.start}</button>}
      <button className="is-quiet" type="button" onClick={() => {
        setArchiveScope({ conversationId, surface, requestId: crypto.randomUUID() });
        onStarted();
      }}>{zh ? '查看心跳事件线' : 'View heartbeat timeline'}</button>
    </div>, controlsTarget)}
    {archiveScope && <BotPresenceArchive api={api} scope={archiveScope} zh={zh} onClose={() => setArchiveScope(undefined)} />}
    {statusTarget && createPortal(diagnostic && <div className="bot-presence-error-row">
      <div className="bot-presence-error">
        <div role="alert"><BotErrorNotice message={diagnostic} zh={zh} /></div>
        {mode === 'off' && <button className="bot-presence-error-close" type="button"
          aria-label={zh ? '关闭错误提示' : 'Dismiss error'} onClick={() => stop(false)}><BotIcon name="close" /></button>}
      </div>
    </div>, statusTarget)}
    {statusTarget && mode !== 'off' && createPortal(<div className="bot-presence-status" data-mode={mode}>
      <i aria-hidden="true" className="bot-presence-dot" />
      <span className={petName && mode === 'active' && status?.vision !== false ? 'bot-sr-only' : undefined} role="status" title={hint}>{label}</span>
      {mode === 'active' && <>
        {pausedForChat && !capturing && <small className="bot-presence-countdown" data-capture="idle">{petName ? (zh ? petName + '正专心和你聊天，先不看屏幕' : petName + ' is chatting with you, screen capture paused') : (zh ? '心跳暂停 · 等待交流结束' : 'Heartbeat paused · waiting for conversation')}</small>}
        {status && (!pausedForChat || capturing) && <PresenceActivity status={status} recording={recording} zh={zh} petName={petName} />}
        {!petName && !interacting && !status?.thinking && !status?.waitingForPartner && last && lastLabel && <small className="bot-presence-countdown"
          title={new Date(last.at).toLocaleTimeString(zh ? 'zh-CN' : 'en-US')}>{lastLabel}</small>}
        {status && !interacting && <HeartbeatCountdown status={status} zh={zh} />}
        {status?.thinking && <button type="button" title={zh ? '中断本轮' : 'Interrupt this round'} aria-label={zh ? '中断本轮' : 'Interrupt this round'} onClick={() => void interrupt()}><BotIcon name="stop" /></button>}
        <button type="button" title={words.pause} aria-label={words.pause} onClick={() => stop(true)}><BotIcon name="pause" /></button>
      </>}
      {mode === 'paused' && <button type="button" title={words.resume} aria-label={words.resume} onClick={() => void start()}><BotIcon name="play" /></button>}
      <button type="button" title={words.stop} aria-label={words.stop} onClick={() => stop(false)}><BotIcon name="close" /></button>
    </div>, statusTarget)}
  </>;
}
