import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { localSpeechApi } from './BotVoiceInput';
import { BotIcon } from './BotIcon';
import './bot-voice.css';

export function BotVoiceMessage({ media, conversationId, locale, transcriptOnly = false, trailingAction }: {
  media: BotMediaRef; conversationId: string; locale: 'zh-CN' | 'en'; transcriptOnly?: boolean; trailingAction?: ReactNode;
}) {
  const zh = locale === 'zh-CN', api = localSpeechApi();
  const [expanded, setExpanded] = useState(false), [transcript, setTranscript] = useState(media.transcript), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const transcriptId = useId();
  const audio = useRef<HTMLAudioElement>(null), [playing, setPlaying] = useState(false);
  const duration = Math.ceil(media.voice?.durationSeconds ?? media.transcript?.audioSeconds ?? 0);
  useEffect(() => { const element = audio.current; return () => { element?.pause(); }; }, []);
  useEffect(() => () => { void api?.request({ type: 'speech.cancel', requestId }); }, [api, requestId]);
  const convert = async () => {
    if (busy) return;
    if (transcript) { setExpanded(!expanded); return; }
    if (!api) return; setBusy(true); setError('');
    try {
      const result = await api.request({ type: 'speech.attachment', conversationId, attachmentId: media.id, requestId });
      if (result.cancelled) return;
      if (!result.ok || !result.transcript) throw Error(result.error ?? (zh ? '转写失败，请重试。' : 'Transcription failed. Try again.'));
      setTranscript(result.transcript); setExpanded(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : zh ? '转写失败，请重试。' : 'Transcription failed. Try again.');
    } finally { setBusy(false); }
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
    {(api || transcript || trailingAction) && <div className="bot-voice-actions">
      {(api || transcript) && <button className="bot-voice-transcribe" type="button" disabled={busy} aria-expanded={expanded} aria-controls={transcriptId} onClick={() => void convert()}>
        {busy ? <span className="bot-voice-spinner" aria-hidden="true" /> : <BotIcon name="file" />}
        <span role={busy ? 'status' : undefined}>{busy ? zh ? '正在转写…' : 'Transcribing…' : expanded ? zh ? '收起文字' : 'Hide transcript' : zh ? '转文字' : 'Show transcript'}</span>
        {transcript && <span className={expanded ? 'bot-voice-caret is-expanded' : 'bot-voice-caret'}><BotIcon name="chevron-down" /></span>}
      </button>}
      {trailingAction}
    </div>}
    <section className="bot-voice-transcript" id={transcriptId} hidden={!expanded} aria-label={zh ? '语音转写' : 'Transcript'}>
      {expanded && (transcript?.text || (zh ? '没有识别到语音' : 'No speech detected'))}
    </section>
    {error && <small className="bot-voice-message-error" role="alert">{error}</small>}
  </div>;
}
