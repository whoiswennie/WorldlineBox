import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import type { LocalSpeechStatus, WorldlineBoxLocalSpeechApi } from '../../shared/local-speech';
import { BotIcon } from './BotIcon';
import { speechBase64, VoiceRecorder, type VoiceRecording } from './voice-recorder';
import './bot-voice.css';

export function localSpeechApi(): WorldlineBoxLocalSpeechApi | undefined {
  return (globalThis as typeof globalThis & { worldlinebox?: { localSpeech?: WorldlineBoxLocalSpeechApi } }).worldlinebox?.localSpeech;
}
export function BotVoiceInput({ conversationId, locale, disabled, textOnly = false, onText, onVoice, api = localSpeechApi(), onStart, onActivityChange }: {
  conversationId: string; locale: 'zh-CN' | 'en'; disabled?: boolean; textOnly?: boolean;
  onText(text: string): void; onVoice?(media: BotMediaRef): Promise<void>; api?: WorldlineBoxLocalSpeechApi;
  onStart?(): void; onActivityChange?(active: boolean): void;
}) {
  const zh = locale === 'zh-CN', [open, setOpen] = useState(false), [mode, setMode] = useState<'text' | 'voice'>(textOnly ? 'text' : 'voice');
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'converting' | 'processing'>('idle');
  const [seconds, setSeconds] = useState(0), [recording, setRecording] = useState<VoiceRecording>(), [error, setError] = useState('');
  const [status, setStatus] = useState<LocalSpeechStatus>();
  const recorder = useRef<VoiceRecorder>(undefined), request = useRef(''), live = useRef(true), started = useRef(0), intent = useRef(0);
  const callbacks = useRef({ onText, onVoice, onStart, onActivityChange });
  const held = useRef(false), automatic = useRef(false);
  const controls = useRef({ begin: () => {}, finish: () => {}, exit: () => {}, cancel: () => {} });
  useLayoutEffect(() => { callbacks.current = { onText, onVoice, onStart, onActivityChange }; }, [onText, onVoice, onStart, onActivityChange]);
  const working = phase !== 'idle', ready = status && ['standby', 'ready', 'transcribing', 'loading'].includes(status.phase);
  useEffect(() => { callbacks.current.onActivityChange?.(open || working); }, [open, working]);
  useEffect(() => () => { callbacks.current.onActivityChange?.(false); }, []);
  useEffect(() => {
    live.current = true;
    const stop = () => {
      live.current = false; intent.current += 1; recorder.current?.cancel();
      if (request.current) void api?.request({ type: 'speech.cancel', requestId: request.current });
    };
    return stop;
  }, [api, conversationId]);
  useEffect(() => {
    if (!open || !api) return;
    let active = true;
    const poll = () => { void api.request({ type: 'speech.status' }).then(result => { if (active) setStatus(result.status); }).catch(() => undefined); };
    poll(); const timer = setInterval(poll, 750); return () => { active = false; clearInterval(timer); };
  }, [open, api]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => setSeconds(Math.min(60, Math.floor((performance.now() - started.current) / 1000))), 200); return () => clearInterval(timer);
  }, [phase]);
  const cancel = () => { ++intent.current; held.current = false; automatic.current = false; recorder.current?.cancel(); recorder.current = undefined; if (request.current) void api?.request({ type: 'speech.cancel', requestId: request.current }); request.current = ''; setPhase('idle'); setRecording(undefined); setError(''); };
  const prepare = async () => {
    if (!api || working) return; const epoch = ++intent.current; setPhase('processing'); setError(''); request.current = crypto.randomUUID();
    try { const result = await api.request({ type: 'speech.prepare', requestId: request.current }); if (live.current && intent.current === epoch) { if (!result.ok) setError(result.error ?? '模型准备失败。'); setStatus(result.status); } }
    catch { if (live.current && intent.current === epoch) setError(zh ? '模型准备失败，请重试。' : 'Model preparation failed. Try again.'); }
    finally { if (live.current && intent.current === epoch) { setPhase('idle'); request.current = ''; } }
  };
  const start = async (auto = false) => {
    if (working || disabled || recorder.current || request.current) return;
    callbacks.current.onStart?.();
    held.current = auto; automatic.current = auto;
    const epoch = ++intent.current, capture = new VoiceRecorder(); recorder.current = capture;
    setError(''); setRecording(undefined); setSeconds(0); setPhase('starting');
    try {
      const captured = await capture.start(() => { if (live.current && intent.current === epoch) setPhase('converting'); });
      if (!captured || !live.current || intent.current !== epoch) { capture.cancel(); return; }
      started.current = captured.startedAt; setPhase('recording');
      if (auto && !held.current) { capture.stop(); setPhase('converting'); }
      const value = await captured.finished;
      if (live.current && intent.current === epoch) {
        recorder.current = undefined; setRecording(value); setPhase('idle');
        if (value && automatic.current) void processRecording(value, true);
      }
    } catch (failure) { if (live.current && intent.current === epoch) { recorder.current = undefined; setError(failure instanceof Error && failure.name === 'NotAllowedError' ? zh ? '请允许麦克风访问后重试。' : 'Allow microphone access and try again.' : failure instanceof Error ? failure.message : '录音失败。'); setPhase('idle'); } capture.cancel(); }
  };
  const processRecording = async (value: VoiceRecording, keepOpen = false) => {
    if (!api || request.current) return; const epoch = ++intent.current; setPhase('processing'); setError(''); request.current = crypto.randomUUID();
    try {
      const audio = speechBase64(value.wave);
      const result = await api.request(mode === 'voice' && !textOnly ? { type: 'speech.voice', requestId: request.current, conversationId, audio } : { type: 'speech.transcribe', requestId: request.current, audio });
      if (!live.current || epoch !== intent.current) return;
      if (!result.ok) throw Error(result.error ?? (zh ? '识别失败，请重试。' : 'Recognition failed. Try again.'));
      if (mode === 'voice' && !textOnly && result.media) await callbacks.current.onVoice?.(result.media);
      else if (result.transcript?.text.trim()) callbacks.current.onText(result.transcript.text.trim());
      else throw Error(zh ? '没有识别到语音，请重新录制。' : 'No speech detected. Please record again.');
      if (live.current && epoch === intent.current) { setRecording(undefined); setOpen(keepOpen && mode === 'voice' && !textOnly); }
    } catch (failure) { if (live.current && epoch === intent.current) setError(failure instanceof Error ? failure.message : '语音处理失败。'); }
    finally { if (live.current && epoch === intent.current) { setPhase('idle'); request.current = ''; } }
  };
  const stop = () => { held.current = false; if (recorder.current) { recorder.current.stop(); setPhase('converting'); } };
  useLayoutEffect(() => { controls.current = { begin: () => { void start(true); }, finish: stop, exit: () => { cancel(); setOpen(false); }, cancel }; });
  useEffect(() => {
    if (!open) return;
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controls.current.exit(); return; }
      if (event.code !== 'Space' || event.repeat || event.isComposing || event.target instanceof HTMLElement && !!event.target.closest('textarea,input,[contenteditable="true"]')) return;
      event.preventDefault(); controls.current.begin();
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space' && held.current) { event.preventDefault(); controls.current.finish(); } };
    const blur = () => { if (held.current) controls.current.cancel(); };
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); };
  }, [open]);
  if (!api) return null;
  const progress = status?.phase === 'preparing' && status.totalBytes ? ` ${Math.floor((status.completedBytes ?? 0) * 100 / status.totalBytes)}%` : '';
  const choose = (next: 'voice' | 'text') => {
    if (working) return;
    if (open && mode === next) { cancel(); setOpen(false); return; }
    callbacks.current.onStart?.(); setMode(next); setError(''); setOpen(true);
  };
  return <div className={`bot-voice-input${open ? ' is-open' : ''}`}>
    {!textOnly && <button className="bot-voice-trigger" type="button" disabled={disabled || working} aria-label={zh ? '录音发语音' : 'Record voice message'} title={zh ? '录音发语音' : 'Record voice message'} aria-expanded={open && mode === 'voice'} onClick={() => choose('voice')}><BotIcon name="microphone" /></button>}
    <button className="bot-voice-trigger" type="button" disabled={disabled || working} aria-label={zh ? '语音转文字' : 'Dictation'} title={zh ? '语音转文字' : 'Dictation'} aria-expanded={open && mode === 'text'} onClick={() => choose('text')}><BotIcon name="dictation" /></button>
    {open && <div className="bot-voice-panel" role="region" aria-label={zh ? '本地语音' : 'Local speech'}>
      <header><strong>{mode === 'voice' && !textOnly ? zh ? '录音发语音' : 'Voice message' : zh ? '语音转文字' : 'Dictation'}</strong><small>{zh ? '最长 60 秒 · 本机识别' : 'Up to 60s · On-device recognition'}</small><button type="button" aria-label={zh ? '关闭语音' : 'Close voice input'} onClick={() => { cancel(); setOpen(false); }}>×</button></header>
      {!ready && <p>{zh ? '首次使用需要准备本地识别模型（约 241 MB）。' : 'Prepare the local recognition model (about 241 MB) before first use.'}</p>}
      {(!ready || status?.phase === 'preparing') && <button type="button" disabled={working} onClick={() => void prepare()}>{working ? (zh ? '正在准备' : 'Preparing') + progress : zh ? '准备本地模型' : 'Prepare local model'}</button>}
      {(ready || recording) && <div className={`bot-voice-record-controls is-${phase}`}>
        <span className="bot-voice-status" role="status">{phase === 'recording' ? `${zh ? '正在录音' : 'Recording'} ${seconds} / 60s` : phase === 'starting' ? zh ? '等待麦克风…' : 'Waiting for microphone…' : phase === 'converting' ? zh ? '正在处理录音…' : 'Processing recording…' : phase === 'processing' ? zh ? '正在本地识别…' : 'Recognizing on device…' : recording ? `${zh ? '录音已就绪' : 'Recording ready'} · ${Math.ceil(recording.seconds)}s` : zh ? '说完后点击结束' : 'Stop when you have finished speaking'}</span>
        {phase === 'recording' ? <button type="button" onClick={stop}>{zh ? '结束录音' : 'Stop recording'}</button> : !working && <button type="button" disabled={disabled} onClick={() => void start()}>{recording ? zh ? '重新录音' : 'Record again' : zh ? '开始录音' : 'Start recording'}</button>}
        {recording && <button className="bot-voice-confirm" type="button" disabled={working || disabled} onClick={() => void processRecording(recording)}>{mode === 'voice' && !textOnly ? zh ? '发送语音' : 'Send voice' : zh ? '转成文字' : 'Convert to text'}</button>}
      </div>}
      <footer><span>{zh ? '也可按住空格说话 · Esc 取消' : 'Hold Space to talk · Esc to cancel'}</span>{working && <button type="button" onClick={cancel}>{zh ? '取消本次' : 'Cancel recording'}</button>}</footer>{error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
