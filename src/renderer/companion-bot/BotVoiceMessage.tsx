import { useEffect, useRef, useState } from 'react';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { localSpeechApi } from './BotVoiceInput';
import './bot-voice.css';

export function BotVoiceMessage({ media, conversationId, locale, transcriptOnly = false }: { media: BotMediaRef; conversationId: string; locale: 'zh-CN' | 'en'; transcriptOnly?: boolean }) {
  const zh = locale === 'zh-CN', api = localSpeechApi();
  const [expanded, setExpanded] = useState(false), [transcript, setTranscript] = useState(media.transcript), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const audio = useRef<HTMLAudioElement>(null), [playing, setPlaying] = useState(false);
  const duration = Math.ceil(media.voice?.durationSeconds ?? media.transcript?.audioSeconds ?? 0);
  useEffect(() => { const element = audio.current; return () => { element?.pause(); }; }, []);
  useEffect(() => () => { void api?.request({ type: 'speech.cancel', requestId }); }, [api, requestId]);
  const convert = async () => {
    if (busy) return;
    if (transcript) { setExpanded(!expanded); return; }
    if (!api) return; setBusy(true); setError('');
    try { const result = await api.request({ type: 'speech.attachment', conversationId, attachmentId: media.id, requestId }); if (!result.ok) throw Error(result.error ?? '转写失败。'); setTranscript(result.transcript); setExpanded(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '转写失败。'); } finally { setBusy(false); }
  };
  const play = async () => {
    if (!audio.current) return;
    if (!audio.current.paused) { audio.current.pause(); return; }
    setError('');
    try { await audio.current.play(); } catch { setError(zh ? '语音暂时无法播放，请重试。' : 'Unable to play this voice message. Try again.'); }
  };
  return <div className={`bot-voice-message${transcriptOnly ? ' is-transcript-only' : ''}`}>{!transcriptOnly && <>
    <button type="button" className={`bot-voice-bubble${playing ? ' is-playing' : ''}`} style={{ width: Math.min(270, 132 + duration * 2) }} aria-label={playing ? zh ? '暂停语音消息' : 'Pause voice message' : zh ? '播放语音消息' : 'Play voice message'} aria-pressed={playing} onClick={() => void play()}>
      <span className="bot-voice-play-icon"><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">{playing ? <path d="M5 4h4v12H5zM12 4h4v12h-4z" fill="currentColor" /> : <path d="M6 3.5a1 1 0 0 1 1.5-.86l10 6.5a1 1 0 0 1 0 1.72l-10 6.5A1 1 0 0 1 6 16.5z" fill="currentColor" />}</svg></span>
      <span className="bot-voice-wave" aria-hidden="true">{[5, 9, 15, 8, 5].map((height, index) => <i key={index} style={{ height, animationDelay: `${index * 90}ms` }} />)}</span><span className="bot-voice-duration">{duration}″</span>
    </button>
    <audio ref={audio} preload="none" src={media.url} hidden onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
  </>}
    {(api || transcript) && <button type="button" disabled={busy} aria-expanded={expanded} onClick={() => void convert()}>{busy ? zh ? '正在转写…' : 'Transcribing…' : expanded ? zh ? '收起文字' : 'Hide text' : zh ? '转文字' : 'Show transcript'}</button>}
    {expanded && <p className="bot-voice-transcript">{transcript?.text || (zh ? '没有识别到语音' : 'No speech detected')}</p>}{error && <small role="alert">{error}</small>}
  </div>;
}
