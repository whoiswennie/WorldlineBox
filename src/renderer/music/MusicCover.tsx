import { useState } from 'react';
import css from './NeteaseMusic.module.css';

export function MusicCover({ url, title, kind, compact = false }: { url?: string; title?: string; kind: string; compact?: boolean }) {
  const [failedUrl, setFailedUrl] = useState(''); const [revision, setRevision] = useState(0);
  return <div className={`${css.cover}${compact ? ` ${css.compactCover}` : ''}`} data-music-cover={kind}>
    {url && failedUrl !== url ? <img key={`${url}:${revision}`} src={url} alt={title ? `${title} 封面` : '歌单封面'} loading={compact ? 'lazy' : 'eager'} decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /> : <span className={css.coverEmpty}>{url ? '封面暂不可用' : '正在读取封面'}</span>}
    {url && failedUrl === url && !compact ? <button type="button" onClick={() => { setFailedUrl(''); setRevision(value => value + 1); }}>重试封面</button> : null}
  </div>;
}
