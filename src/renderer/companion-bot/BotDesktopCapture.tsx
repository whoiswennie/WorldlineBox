import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOT_DESKTOP_AGENT_EVENT, BOT_DESKTOP_AUDIO_SECONDS, type BotDesktopAgentCommand, type BotDesktopCaptureScope, type BotMediaRef, type BotMediaRequest, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';
import { BotCompanionPresence } from './BotCompanionPresence';
import { useBotCallDocument } from './call-pet';
import { recordDesktopVideo } from './desktop-video-recorder';
import { speechBase64, VoiceRecorder } from './voice-recorder';
import './bot-desktop-capture.css';

type Operation = 'screen' | 'watch' | 'listen' | 'transcribe';
type Phase = Operation | 'starting' | 'video-processing' | 'audio-to-text';
type Job = { scope: BotDesktopCaptureScope; release?: () => void; display?: MediaStream };

export function BotDesktopCapture({ api, conversationId, surface, companionName, locale, onAttachment, onBusy, statusTarget, controlsTarget, meeting = false, allowPresence = false, fileRequest = 0, interacting = false }: {
  api: WorldlineBoxBotMediaApi; conversationId: string; surface: 'chat' | 'pet'; locale: 'zh-CN' | 'en';
  onAttachment(media: BotMediaRef[]): void; onBusy(busy: boolean): void;
  statusTarget: HTMLElement | null; controlsTarget?: HTMLElement | null; meeting?: boolean; allowPresence?: boolean; fileRequest?: number; interacting?: boolean; companionName?: string;
}) {
  const zh = locale === 'zh-CN', doc = useBotCallDocument(), panelId = useId();
  const [open, setOpen] = useState(false), [phase, setPhase] = useState<Phase>(), [error, setError] = useState('');
  const [lastScreen, setLastScreen] = useState<BotDesktopCaptureScope>();
  useEffect(() => {
    if (!lastScreen) return;
    const timer = setTimeout(() => setLastScreen(undefined), 3000);
    return () => clearTimeout(timer);
  }, [lastScreen]);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null), current = useRef<Job>(undefined);
  const cancel = useCallback(() => {
    const job = current.current;
    if (!job) return;
    current.current = undefined;
    job.release?.();
    job.display?.getTracks().forEach(track => track.stop());
    void api.request({ type: 'desktop.cancel', ...job.scope }).catch(() => undefined);
  }, [api]);
  const reset = () => { cancel(); setPhase(undefined); onBusy(false); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus(); }
    };
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('keydown', escape, true);
    return () => {
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('keydown', escape, true);
    };
  }, [doc, open]);

  const start = async (operation: Operation, seconds?: number, command?: BotDesktopCaptureScope) => {
    const scope = { requestId: command?.requestId ?? crypto.randomUUID(), conversationId, surface };
    if (current.current) {
      if (command) void api.request({ type: 'desktop.cancel', ...scope }).catch(() => undefined);
      return;
    }
    const job: Job = { scope };
    const recording = operation === 'watch' || operation === 'listen';
    current.current = job;
    if (!command) onBusy(true);
    setError(''); setLastScreen(undefined); setPhase(recording ? 'starting' : operation);
    try {
      let input: BotMediaRequest;
      if (recording) {
        const duration = seconds ?? BOT_DESKTOP_AUDIO_SECONDS;
        const devices = doc.defaultView?.navigator.mediaDevices;
        if (!devices?.getDisplayMedia) throw Error(zh ? '当前窗口无法录制桌面。' : 'Desktop recording is unavailable in this window.');
        const ready = await api.request({ type: operation === 'watch' ? 'desktop.video.begin' : 'desktop.audio.begin', seconds: duration, ...scope });
        if (!ready.ok) throw Error(ready.error);
        if (current.current !== job) { void api.request({ type: 'desktop.cancel', ...scope }).catch(() => undefined); return; }
        if (ready.cancelled) return;
        const video = operation === 'watch'
          ? { frameRate: { ideal: 12, max: 15 }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } }
          : { frameRate: { max: 1 }, width: { ideal: 32 }, height: { ideal: 32 } };
        job.display = await devices.getDisplayMedia({ video, audio: true });
        if (current.current !== job) return;
        const tracks = job.display.getAudioTracks();
        if (!tracks.length) throw Error(zh ? '未取得系统音轨。' : 'No system audio track was returned.');
        if (operation === 'watch') {
          if (!job.display.getVideoTracks().length) throw Error(zh ? '未取得屏幕画面。' : 'No screen track was returned.');
          const videoRecording = recordDesktopVideo(job.display, duration, async (sequence, bytes) => {
            const response = await api.request({ type: 'desktop.video.chunk', ...scope, sequence, bytes });
            if (!response.ok) throw Error(response.error);
          }, active => {
            if (current.current !== job) return;
            setPhase(active ? 'watch' : 'video-processing');
            void api.request({ type: 'desktop.video.activity', ...scope, active }).catch(() => undefined);
          });
          job.release = videoRecording.cancel;
          if (!await videoRecording.finished || current.current !== job) return;
          setPhase('video-processing');
          input = { type: 'desktop.video.finish', ...scope };
        } else {
          job.display.getVideoTracks().forEach(track => track.stop());
          const recorder = new VoiceRecorder();
          job.release = () => recorder.cancel();
          const audioRecording = await recorder.start(() => undefined, { stream: new MediaStream(tracks), maxSeconds: duration });
          if (!audioRecording || current.current !== job) return;
          setPhase('listen');
          void api.request({ type: 'desktop.audio.activity', ...scope, active: true }).catch(() => undefined);
          const sound = await audioRecording.finished;
          void api.request({ type: 'desktop.audio.activity', ...scope, active: false }).catch(() => undefined);
          if (!sound || current.current !== job) return;
          job.display.getTracks().forEach(track => track.stop());
          setPhase('audio-to-text');
          input = { type: 'desktop.audio.finish', audio: speechBase64(sound.wave), ...scope };
        }
      } else input = { type: operation === 'screen' ? 'desktop.screen' : 'desktop.transcribe', ...scope };
      const result = await api.request(input);
      if (current.current !== job) return;
      if (!result.ok) throw Error(result.error);
      if (operation === 'screen' && !result.cancelled) setLastScreen(scope);
      if (operation === 'transcribe' && result.media?.length) onAttachment(result.media);
    } catch (reason) {
      if (current.current === job) setError(reason instanceof Error && reason.message ? reason.message
        : zh ? '桌面采集失败，请重试。' : 'Desktop capture failed. Try again.');
    } finally {
      job.display?.getTracks().forEach(track => track.stop());
      if (current.current === job) reset();
    }
  };

  const receive = useEffectEvent((event: Event) => {
    const command = (event as CustomEvent<BotDesktopAgentCommand>).detail;
    if (!command || command.conversationId !== conversationId || command.surface !== surface) return;
    if (command.operation === 'cancel') {
      if (current.current?.scope.requestId === command.requestId) reset();
      return;
    }
    void start(command.operation, command.seconds, command);
  });
  const startFile = useEffectEvent(() => { void start('transcribe'); });
  const previousFileRequest = useRef(fileRequest);
  useEffect(() => {
    if (previousFileRequest.current !== fileRequest) { previousFileRequest.current = fileRequest; startFile(); }
  }, [fileRequest]);

  useEffect(() => {
    const view = doc.defaultView;
    if (!view || !conversationId) return;
    const scope = { conversationId, surface, requestId: crypto.randomUUID() };
    const listener = (event: Event) => receive(event);
    view.addEventListener(BOT_DESKTOP_AGENT_EVENT, listener);
    let live = true, retries = 0, retry: ReturnType<typeof setTimeout>;
    const ready = async () => {
      const result = await api.request({ type: 'desktop.surface.ready', ...scope }).catch(() => undefined);
      if (!live) { void api.request({ type: 'desktop.surface.closed', ...scope }).catch(() => undefined); return; }
      if ((!result?.ok || result.cancelled) && retries++ < 12) retry = setTimeout(() => void ready(), 150);
    };
    void ready();
    return () => {
      live = false;
      clearTimeout(retry);
      view.removeEventListener(BOT_DESKTOP_AGENT_EVENT, listener);
      cancel();
      onBusy(false);
      void api.request({ type: 'desktop.surface.closed', ...scope }).catch(() => undefined);
    };
  }, [api, cancel, conversationId, doc, onBusy, surface]);

  const pet = surface === 'pet' ? companionName || (zh ? '伙伴' : 'Your companion') : undefined;
  const status = phase && ({
    screen: pet ? (zh ? '让我截一张，记住这一刻' : 'Let me capture this moment') : zh ? '伙伴正在截图' : 'Companion is taking a screenshot',
    starting: zh ? '正在准备采集' : 'Preparing capture',
    watch: pet ? (zh ? '我陪你看着，正在录下这段画面' : 'I’m watching with you and recording this part') : zh ? '伙伴正在录屏' : 'Companion is recording the screen',
    listen: zh ? '伙伴正在听电脑声音' : 'Companion is listening to system audio',
    'video-processing': zh ? '正在整理录像' : 'Processing the recording',
    'audio-to-text': zh ? '正在转写电脑声音' : 'Transcribing system audio',
    transcribe: zh ? '正在分段转写音轨' : 'Transcribing audio in segments',
  }[phase]);
  const receipt = lastScreen?.conversationId === conversationId && lastScreen.surface === surface
    ? pet ? (zh ? pet + '看到了刚才的画面' : pet + ' saw that moment') : (zh ? '刚刚已截图' : 'Screenshot taken') : undefined;
  const title = zh ? '陪伴设置' : 'Companion settings';
  const content = open && <section ref={panel} className="bot-desktop-capture-panel" id={panelId} aria-label={title}>
    <header><strong>{title}</strong>
      <button type="button" aria-label={zh ? '收起陪伴设置' : 'Close companion settings'} onClick={() => { setOpen(false); button.current?.focus(); }}><BotIcon name="close" /></button>
    </header>
    <div ref={setControls} />
  </section>;
  return <div className="bot-desktop-capture">
    {allowPresence && <>
      <button ref={button} type="button" title={title} aria-label={title} aria-controls={panelId} aria-expanded={open}
        onClick={() => setOpen(!open)}><BotIcon name="screen" /></button>
      {controlsTarget && createPortal(content, controlsTarget)}
      <BotCompanionPresence api={api} conversationId={conversationId} surface={surface} petName={pet} meeting={meeting} zh={zh} interacting={interacting}
        controlsTarget={controls} statusTarget={statusTarget} onStarted={() => setOpen(false)} />
    </>}
    {statusTarget && (status || error || receipt) && createPortal(<div className="bot-desktop-capture-status">
      <BotIcon name={phase === 'screen' || receipt ? 'screen' : phase === 'watch' ? 'video' : phase === 'listen' ? 'volume' : 'file'} />
      <span role={error ? 'alert' : 'status'} title={error || status || receipt}>{error || status || receipt}</span>
      <button type="button" aria-label={status ? (zh ? '取消采集' : 'Cancel capture') : (zh ? '关闭提示' : 'Dismiss notice')}
        onClick={() => { if (status) reset(); setError(''); setLastScreen(undefined); }}><BotIcon name="close" /></button>
    </div>, statusTarget)}
  </div>;
}
