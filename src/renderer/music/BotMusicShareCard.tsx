import { useState } from 'react';
import type { MusicShare, PlaybackMode } from '../../shared/music';
import { BotIcon } from '../companion-bot/BotIcon';
import { useInlineMusicCard } from './MusicProvider';
import css from './NeteaseMusic.module.css';

const modes: Record<PlaybackMode, readonly [string, string]> = {
  once: ['顺序播放', 'Play in order'],
  list: ['列表循环', 'Repeat queue'],
  single: ['单曲循环', 'Repeat track'],
  shuffle: ['随机播放', 'Shuffle'],
};

export function BotMusicShareCard({ card, conversationId, locale, surface, enabled }: { card: MusicShare; conversationId: string; locale: 'zh-CN' | 'en'; surface: 'chat' | 'call'; enabled: boolean }) {
  const { targetRef, play } = useInlineMusicCard(conversationId, surface, card.id, enabled);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const zh = locale === 'zh-CN';
  return <div className={css.musicMessage} data-music-card={card.id}>
    <button className={css.musicMessageStart} type="button" disabled={!play || busy} aria-busy={busy}
      aria-label={(zh ? '播放 ' : 'Play ') + card.title} onClick={() => {
      if (!play) return;
      setBusy(true); setError('');
      void play(card).catch(cause => {
        if (cause?.name !== 'AbortError') setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => setBusy(false));
    }}>
      <span className={css.messagePlay}><BotIcon name="music" /></span>
      <span className={css.musicMessageCopy}>
        <strong>{card.title}</strong>
        <small>{zh ? card.trackCount + ' 首' : card.trackCount + (card.trackCount === 1 ? ' track' : ' tracks')} · {modes[card.mode][zh ? 0 : 1]}</small>
      </span>
      <span className={css.messagePlayAction}><BotIcon name="play" /></span>
    </button>
    <div ref={targetRef} className={css.musicPlayerTarget} />
    {error && <small role="alert">{error}</small>}
  </div>;
}
