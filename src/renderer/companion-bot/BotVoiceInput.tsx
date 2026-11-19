import { useBotCallDocument } from './call-pet';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import type { WorldlineBoxLocalSpeechApi } from '../../shared/local-speech';
import { BotIcon } from './BotIcon';
import { speechBase64, VoiceRecorder, type VoiceRecording } from './voice-recorder';
import './bot-voice.css';

export function localSpeechApi(): WorldlineBoxLocalSpeechApi | undefined {
  return (globalThis as typeof globalThis & { worldlinebox?: { localSpeech?: WorldlineBoxLocalSpeechApi } }).worldlinebox?.localSpeech;
}
type Mode = 'text' | 'voice';
type Phase = 'idle' | 'starting' | 'recording' | 'converting' | 'processing' | 'ready' | 'sending';
const emptyLevels = () => Array<number>(24).fill(0);

export function BotVoiceInput({ conversationId, locale, disabled, textOnly = false, onText, onVoice, api = localSpeechApi(), onStart, onActivityChange }: {
  conversationId: string; locale: 'zh-CN' | 'en'; disabled?: boolean; textOnly?: boolean;
  onText(text: string): void; onVoice?(media: BotMediaRef): Promise<void>; api?: WorldlineBoxLocalSpeechApi;
  onStart?(): void; onActivityChange?(active: boolean): void;
}) {
  const surface = useBotCallDocument();
  const zh = locale === 'zh-CN', [mode, setMode] = useState<Mode>('text'), [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0), [levels, setLevels] = useState(emptyLevels), [error, setError] = useState('');
  const [recording, setRecording] = useState<VoiceRecording>(), [media, setMedia] = useState<BotMediaRef>();
  const [playing, setPlaying] = useState(false), [playhead, setPlayhead] = useState(0), [previewError, setPreviewError] = useState(false);
  const preview = useRef<HTMLAudioElement>(null);
  const previewRecording = mode === 'voice' ? recording : undefined;
  const recorder = useRef<VoiceRecorder>(undefined), request = useRef(''), live = useRef(true), started = useRef(0), intent = useRef(0);
  const currentPhase = useRef<Phase>('idle'), held = useRef(false);
  const callbacks = useRef({ onText, onVoice, onStart, onActivityChange });
  const controls = useRef({ finish: () => {}, cancel: () => {} });
  const changePhase = (value: Phase) => { currentPhase.current = value; setPhase(value); };
  useLayoutEffect(() => { callbacks.current = { onText, onVoice, onStart, onActivityChange }; }, [onText, onVoice, onStart, onActivityChange]);
  const open = phase !== 'idle' || !!recording || !!error;
  const busy = ['starting', 'recording', 'converting', 'processing', 'sending'].includes(phase);
  useEffect(() => { callbacks.current.onActivityChange?.(open); }, [open]);
  useEffect(() => () => { callbacks.current.onActivityChange?.(false); }, []);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false; intent.current += 1; recorder.current?.cancel(); recorder.current = undefined;
      if (request.current) void api?.request({ type: 'speech.cancel', requestId: request.current }).catch(() => undefined);
    };
  }, [api, conversationId]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => setSeconds(Math.floor((performance.now() - started.current) / 1000)), 200);
    return () => clearInterval(timer);
  }, [phase]);
  useLayoutEffect(() => {
    const audio = preview.current;
    if (!previewRecording || !audio) return;
    const url = URL.createObjectURL(new Blob([previewRecording.wave.slice()], { type: 'audio/wav' }));
    audio.src = url;
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
  }, [previewRecording]);

  const resetPreview = () => { setPlaying(false); setPlayhead(0); setPreviewError(false); };
  const togglePreview = async () => {
    const audio = preview.current;
    if (!audio || currentPhase.current === 'sending') return;
    if (!audio.paused) { audio.pause(); return; }
    setPreviewError(false);
    const url = audio.src;
    try { await audio.play(); }
    catch (failure) {
      if (preview.current === audio && audio.src === url && !(failure instanceof DOMException && failure.name === 'AbortError')) setPreviewError(true);
    }
  };

  const cancel = () => {
    ++intent.current; held.current = false; recorder.current?.cancel(); recorder.current = undefined;
    if (request.current) void api?.request({ type: 'speech.cancel', requestId: request.current }).catch(() => undefined);
    request.current = ''; changePhase('idle'); setRecording(undefined); setMedia(undefined); setError(''); setLevels(emptyLevels()); resetPreview();
  };
  const processRecording = async (value: VoiceRecording, selected: Mode, epoch: number) => {
    if (!api || request.current) return;
    changePhase('processing'); setError(''); const requestId = crypto.randomUUID(); request.current = requestId;
    try {
      // Startup warms the shared recognizer. After a failed warmup or a worker
      // crash, the same request automatically loads it again without a setup UI.
      const audio = speechBase64(value.wave);
      const result = await api.request(selected === 'voice'
        ? { type: 'speech.voice', requestId, conversationId, audio }
        : { type: 'speech.transcribe', requestId, audio });
      if (!live.current || epoch !== intent.current) return;
      if (!result.ok) throw Error(result.error ?? (zh ? '识别失败，请重试。' : 'Recognition failed. Try again.'));
      if (selected === 'voice' && result.media) { setMedia(result.media); changePhase('ready'); }
      else if (selected === 'text' && result.transcript?.text.trim()) {
        callbacks.current.onText(result.transcript.text.trim()); setRecording(undefined); changePhase('idle');
      } else throw Error(zh ? '没有识别到语音，请重新录制。' : 'No speech detected. Please record again.');
    } catch (failure) {
      if (live.current && epoch === intent.current) { setError(failure instanceof Error ? failure.message : '语音处理失败。'); changePhase('idle'); }
    } finally { if (request.current === requestId) request.current = ''; }
  };
  const start = async (selected: Mode) => {
    if (!api || disabled || recorder.current || request.current || ['starting', 'recording', 'converting', 'processing', 'sending'].includes(currentPhase.current)) return;
    callbacks.current.onStart?.();
    const epoch = ++intent.current, capture = new VoiceRecorder(); recorder.current = capture;
    setMode(selected); setError(''); setRecording(undefined); setMedia(undefined); setSeconds(0); setLevels(emptyLevels()); resetPreview(); changePhase('starting');
    try {
      const captured = await capture.start(() => { if (live.current && intent.current === epoch) changePhase('converting'); }, {
        onLevel: level => { if (live.current && intent.current === epoch) setLevels(previous => [...previous.slice(1), Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0]); },
      });
      if (!captured || !live.current || intent.current !== epoch) { capture.cancel(); return; }
      started.current = captured.startedAt; changePhase('recording');
      const value = await captured.finished;
      if (!live.current || intent.current !== epoch) return;
      recorder.current = undefined;
      if (!value) { changePhase('idle'); return; }
      setSeconds(Math.floor(value.seconds)); setRecording(value);
      await processRecording(value, selected, epoch);
    } catch (failure) {
      if (live.current && intent.current === epoch) {
        recorder.current = undefined;
        setError(failure instanceof Error && failure.name === 'NotAllowedError'
          ? zh ? '请允许麦克风访问后重试。' : 'Allow microphone access and try again.'
          : failure instanceof Error ? failure.message : '录音失败。');
        changePhase('idle');
      }
      capture.cancel();
    }
  };
  const stop = () => {
    held.current = false;
    if (currentPhase.current === 'starting') { cancel(); return; }
    if (currentPhase.current === 'recording' && recorder.current) { changePhase('converting'); recorder.current.stop(); }
  };
  const send = async () => {
    if (!media || disabled || currentPhase.current !== 'ready' || !callbacks.current.onVoice) return;
    const epoch = ++intent.current; preview.current?.pause(); changePhase('sending'); setError('');
    try {
      await callbacks.current.onVoice(media);
      if (live.current && intent.current === epoch) { setRecording(undefined); setMedia(undefined); changePhase('idle'); }
    } catch (failure) {
      if (live.current && intent.current === epoch) { setError(failure instanceof Error ? failure.message : '发送失败。'); changePhase('ready'); }
    }
  };
  const retry = () => {
    if (recording && !media && !request.current && currentPhase.current === 'idle') void processRecording(recording, mode, ++intent.current);
  };
  useLayoutEffect(() => { controls.current = { finish: stop, cancel }; });
  useEffect(() => {
    if (!open) return;
    const down = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controls.current.cancel(); return; }
      if (event.code !== 'Space' || event.repeat || currentPhase.current !== 'recording' || event.target instanceof HTMLElement && !!event.target.closest('textarea,input,button,[contenteditable="true"]')) return;
      event.preventDefault(); held.current = true;
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space' && held.current) { event.preventDefault(); controls.current.finish(); } };
    const blur = () => { if (held.current) controls.current.cancel(); };
    const view = surface.defaultView;
    if (!view) return;
    view.addEventListener('keydown', down, true); view.addEventListener('keyup', up, true); view.addEventListener('blur', blur);
    return () => { view.removeEventListener('keydown', down, true); view.removeEventListener('keyup', up, true); view.removeEventListener('blur', blur); };
  }, [open, surface]);
  if (!api) return null;
  const choose = (selected: Mode) => { if (mode === selected && ['starting', 'recording'].includes(currentPhase.current)) stop(); else void start(selected); };
  const time = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const activityLabel = phase === 'recording' ? zh ? '正在录音' : 'Recording' : phase === 'starting' ? zh ? '正在连接麦克风' : 'Connecting microphone' : phase === 'sending' ? zh ? '正在发送语音' : 'Sending voice' : zh ? '正在识别' : 'Recognizing';
  const previewLabel = playing ? zh ? '暂停试听' : 'Pause preview' : zh ? '试听录音' : 'Preview recording';
  return <div className={`bot-voice-input${open ? ' is-open' : ''}`}>
    {(!textOnly ? ['voice', 'text'] as const : ['text'] as const).map(selected => {
      const label = selected === 'voice' ? zh ? '录音发语音' : 'Record voice message' : zh ? '语音转文字' : 'Dictation';
      const active = open && mode === selected;
      return <button key={selected} className="bot-voice-trigger" type="button" disabled={disabled && !active || busy && (!active || !['starting', 'recording'].includes(phase))}
        aria-label={label} title={active && phase === 'recording' ? zh ? '结束录音' : 'Stop recording' : label} aria-pressed={active} aria-expanded={active} onClick={() => choose(selected)}><BotIcon name={selected === 'voice' ? 'microphone' : 'dictation'} /></button>;
    })}
    {open && <div className={`bot-voice-panel is-${phase}`} role="region" aria-label={zh ? '本地语音' : 'Local speech'} aria-busy={phase === 'processing' || phase === 'converting' || phase === 'sending'}>
      <div className="bot-voice-meter-row">
        {previewRecording ? <>
          <button type="button" className="bot-voice-preview" disabled={phase === 'sending'} aria-label={previewLabel} title={previewLabel} onClick={() => void togglePreview()}>
            <BotIcon name={playing ? 'pause' : 'play'} />
          </button>
          <progress className="bot-voice-preview-progress" aria-label={zh ? '试听进度' : 'Preview progress'} max={previewRecording.seconds} value={playhead} />
          <audio ref={preview} preload="none" hidden
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={event => setPlayhead(event.currentTarget.currentTime)}
            onEnded={event => { event.currentTarget.currentTime = 0; setPlayhead(0); setPlaying(false); }}
            onError={event => { if (event.currentTarget.hasAttribute('src')) { setPlaying(false); setPreviewError(true); } }} />
        </> : <>
          <span className="bot-voice-capture-dot" aria-hidden="true" />
          <div className="bot-voice-live-wave" aria-label={activityLabel}>{levels.map((level, index) => <i key={index} style={{ height: 3 + level * 23 }} />)}</div>
        </>}
        <time className="bot-voice-elapsed" aria-label={zh ? '录制时长' : 'Recording duration'}>{time}</time>
        {busy && phase !== 'recording' && <span className="bot-voice-spinner" role="status" aria-label={activityLabel} />}
        {phase === 'recording' && <button type="button" className="bot-voice-finish" aria-label={zh ? '结束录音' : 'Stop recording'} title={zh ? '结束录音' : 'Stop recording'} onClick={stop}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" /></svg></button>}
        {media && !busy && <button type="button" className="bot-voice-confirm" disabled={disabled} aria-label={zh ? '发送语音' : 'Send voice'} title={zh ? '发送语音' : 'Send voice'} onClick={() => void send()}><BotIcon name="arrow" /></button>}
        {error && recording && !media && !busy && <button type="button" aria-label={zh ? '重试识别' : 'Retry recognition'} title={zh ? '重试识别' : 'Retry recognition'} onClick={retry}><BotIcon name="history" /></button>}
        <button type="button" aria-label={zh ? '关闭语音' : 'Close voice input'} title={zh ? '取消' : 'Cancel'} onClick={cancel}><BotIcon name="close" /></button>
      </div>
      {error && <p className="bot-voice-error" role="alert">{error}</p>}
      {previewError && <p className="bot-voice-error" role="alert">{zh ? '录音暂时无法播放，请重试。' : 'Unable to preview the recording. Try again.'}</p>}
    </div>}
  </div>;
}
