import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOT_PRESENCE_CLIP_SECONDS, BOT_PRESENCE_MAX_CLIP_BYTES, type BotDesktopCaptureScope, type BotPresenceStatus, type BotPresenceEnergy, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';
import { useBotCallDocument } from './call-pet';
import { BotPresenceArchive } from './BotPresenceArchive';

type Clip = ReturnType<typeof recordClip>;
type Session = { scope: BotDesktopCaptureScope; energy: BotPresenceEnergy; stream?: MediaStream; clip?: Clip; timer?: ReturnType<typeof setInterval>;
  uploads: Set<Promise<void>>; cycle: number; recording: boolean; draining?: boolean; changing?: boolean; connect?(): Promise<void> };

function recordClip(stream: MediaStream) {
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw Error('当前环境无法录制带声音的陪伴短片。');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 480_000, audioBitsPerSecond: 64_000 });
  const chunks: Blob[] = [];
  const startedAt = Date.now(), started = performance.now();
  let bytes = 0, oversized = false, endedAt = startedAt;
  const stop = () => {
    if (recorder.state === 'inactive') return;
    endedAt = startedAt + Math.max(1, Math.round(performance.now() - started));
    recorder.stop();
  };
  const finished = new Promise<{ bytes: Uint8Array<ArrayBuffer>; startedAt: number; endedAt: number } | undefined>((resolve, reject) => {
    recorder.ondataavailable = ({ data }) => {
      bytes += data.size;
      if (bytes > BOT_PRESENCE_MAX_CLIP_BYTES) { oversized = true; stop(); return; }
      if (data.size) chunks.push(data);
    };
    recorder.onerror = () => { clearTimeout(timer); reject(Error('陪伴短片录制中断。')); };
    recorder.onstop = () => {
      clearTimeout(timer);
      if (oversized) { reject(Error('一段陪伴录像超过本地缓存限制。')); return; }
      if (!bytes) { resolve(undefined); return; }
      void new Blob(chunks, { type: mimeType }).arrayBuffer().then(buffer => resolve({ bytes: new Uint8Array(buffer), startedAt, endedAt: Math.max(startedAt + 1, endedAt) }), reject);
    };
  });
  recorder.start(1000);
  const timer = setTimeout(stop, BOT_PRESENCE_CLIP_SECONDS * 1000);
  return { finished, stop };
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
  if (!deadline) return <small className="bot-presence-countdown">{zh ? '正在观察' : 'Observing'}</small>;
  const time = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const label = zh ? '下次心跳' : 'Next heartbeat';
  return <time aria-label={label} title={label} className="bot-presence-countdown">{time}</time>;
}

const energies = ['low', 'balanced', 'active'] as const;

export function BotCompanionPresence({ api, conversationId, surface, meeting, zh, controlsTarget, statusTarget, onStarted }: {
  api: WorldlineBoxBotMediaApi; conversationId: string; surface: 'chat' | 'pet'; zh: boolean;
  meeting: boolean; controlsTarget: HTMLElement | null; statusTarget: HTMLElement | null; onStarted(): void;
}) {
  const doc = useBotCallDocument();
  const active = useRef<Session>(undefined);
  const [mode, setMode] = useState<'off' | 'starting' | 'active' | 'paused'>('off');
  const [energy, setEnergy] = useState<BotPresenceEnergy>('balanced');
  const [changing, setChanging] = useState(false);
  const [archiveScope, setArchiveScope] = useState<BotDesktopCaptureScope>();
  const [status, setStatus] = useState<BotPresenceStatus>();
  const [error, setError] = useState('');
  const release = useCallback(async () => {
    const session = active.current;
    if (!session) return;
    active.current = undefined;
    clearInterval(session.timer);
    session.draining = true;
    session.recording = false;
    session.clip?.stop();
    session.stream?.getTracks().forEach(track => track.stop());
    try { await Promise.allSettled([...session.uploads]); }
    finally { await api.request({ type: 'desktop.cancel', ...session.scope }).catch(() => undefined); }
  }, [api]);
  useEffect(() => () => { void release(); }, [release]);

  const stop = (paused: boolean) => {
    void release(); setStatus(undefined); setError(''); setChanging(false); setMode(paused ? 'paused' : 'off');
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
      const ready = await api.request({ type: 'desktop.presence.start', ...scope, energy, meeting });
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
        const stream = await devices.getDisplayMedia({ video: { frameRate: { ideal: 6, max: 8 }, width: { ideal: 960, max: 960 }, height: { ideal: 540, max: 540 } }, audio: true });
        if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
        session.stream = stream;
        if (!stream.getAudioTracks().length || !stream.getVideoTracks().length) throw Error(zh ? '未取得屏幕和系统音轨。' : 'Screen or system audio is missing.');
        for (const track of stream.getTracks()) track.addEventListener('ended', () => fail(Error(zh ? '屏幕共享已结束。' : 'Desktop sharing has ended.')), { once: true });
      };
      session.connect = connect;
      if (energy !== 'low') await connect();
      if (!current()) return;
      setMode('active');
      const recordNext = () => {
        if (!current() || !session.recording || session.changing || !session.stream || session.clip) return;
        const clip = recordClip(session.stream);
        session.clip = clip;
        const upload = clip.finished.then(async data => {
          if (session.clip === clip) session.clip = undefined;
          if (current()) recordNext();
          if (data && (current() || session.draining)) {
            const saved = await api.request({ type: 'desktop.presence.clip', ...scope, ...data });
            if (!saved.ok) throw Error(saved.error);
          }
        });
        session.uploads.add(upload);
        void upload.catch(fail).finally(() => { session.uploads.delete(upload); });
      };
      const updateRecorder = (status: BotPresenceStatus) => {
        const record = status.capture === 'video' && !status.thinking && !status.capturePaused;
        session.recording = record;
        const stream = session.stream;
        if (!record) session.clip?.stop();
        for (const track of stream?.getTracks() ?? []) track.enabled = record;
        if (record) recordNext();
      };
      let polling = false;
      let flushedCycle: number | undefined;
      const poll = async () => {
        if (!current() || polling || session.changing) return;
        polling = true;
        try {
          const result = await api.request({ type: 'desktop.presence.status', ...scope });
          if (!current() || session.changing) return;
          if (!result.ok || !result.presence) throw Error(result.error || (zh ? '陪伴模式已结束。' : 'Companion mode has ended.'));
          if (result.presence.cycle < session.cycle) return;
          session.cycle = result.presence.cycle;
          setStatus(result.presence);
          updateRecorder(result.presence);
          const { flushCycle } = result.presence;
          if (flushCycle !== undefined && flushCycle !== flushedCycle) {
            await Promise.all([...session.uploads]);
            if (!current()) return;
            const ack = await api.request({ type: 'desktop.presence.flushed', ...scope, cycle: flushCycle });
            if (!ack.ok) throw Error(ack.error);
            flushedCycle = flushCycle;
          }
        } catch (reason) { fail(reason); } finally { polling = false; }
      };
      if (ready.presence) updateRecorder(ready.presence);
      session.timer = setInterval(() => { void poll(); }, 400);
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
      const result = await api.request({ type: 'desktop.presence.energy', ...session.scope, energy: value });
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
  const clearObservations = async (scope: BotDesktopCaptureScope) => {
    const result = await api.request({ type: 'desktop.presence.archive.clear', ...scope });
    if (!result.ok) throw Error(result.error);
    return result.recordings ?? [];
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
  const hint = error || status?.error || (mode === 'active' ? `${label} · ${words[energy]}` : label);
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
      }}>{zh ? '查看观察缓存' : 'View observation cache'}</button>
    </div>, controlsTarget)}
    {archiveScope && <BotPresenceArchive api={api} scope={archiveScope} zh={zh} onClose={() => setArchiveScope(undefined)}
      onClear={() => clearObservations(archiveScope)} />}
    {statusTarget && (mode !== 'off' || error) && createPortal(<div className="bot-presence-status" data-mode={mode}>
      <i aria-hidden="true" className="bot-presence-dot" />
      <span role={mode === 'off' ? 'alert' : 'status'} title={hint}>{error || status?.error || label}</span>
      {mode === 'active' && <>
        {status?.waitingForPartner && <small className="bot-presence-countdown">{zh ? '等伙伴完成当前任务' : 'Waiting for companion'}</small>}
        {!status?.thinking && !status?.waitingForPartner && last && lastLabel && <small className="bot-presence-countdown"
          title={new Date(last.at).toLocaleTimeString(zh ? 'zh-CN' : 'en-US')}>{lastLabel}</small>}
        {status && <HeartbeatCountdown status={status} zh={zh} />}
        {status?.thinking && <button type="button" title={zh ? '中断本轮' : 'Interrupt this round'} aria-label={zh ? '中断本轮' : 'Interrupt this round'} onClick={() => void interrupt()}><BotIcon name="stop" /></button>}
        <button type="button" title={words.pause} aria-label={words.pause} onClick={() => stop(true)}><BotIcon name="pause" /></button>
      </>}
      {mode === 'paused' && <button type="button" title={words.resume} aria-label={words.resume} onClick={() => void start()}><BotIcon name="play" /></button>}
      <button type="button" title={words.stop} aria-label={words.stop} onClick={() => stop(false)}><BotIcon name="close" /></button>
    </div>, statusTarget)}
  </>;
}
