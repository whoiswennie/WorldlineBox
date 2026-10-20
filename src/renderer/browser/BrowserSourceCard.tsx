import { memo, useState } from 'react';
import type { BrowserAiSource } from '../../shared/browser-ai';
import { Icon } from '../Icons';
import { SiteMark } from './BrowserBookmarks';
import { BrowserMarkdown } from './BrowserMarkdown';

/** Source bodies mount only when requested; a streamed answer never reparses them. */
export const BrowserSourceCard = memo(function BrowserSourceCard({ source, open, zh }: {
  source: BrowserAiSource; open(url: string): void; zh: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  let host = source.url;
  try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch { /* Keep a readable fallback. */ }
  const kind = source.kind === 'fetched' ? (zh ? '已抓取正文' : 'Fetched page')
    : source.kind === 'current' ? (zh ? '浏览器实读' : 'Live page') : (zh ? '搜索结果' : 'Search result');
  const excerpt = source.snippet || source.content.replace(/[#*>`]/g, '').replace(/\s+/g, ' ').slice(0, 220);
  return <article className={'browser-source-card is-' + source.kind}>
    <div className="browser-source-card-meta"><SiteMark url={source.url} /><span title={host}>{host}</span><small>{kind}</small><span className="browser-source-number">{source.id}</span></div>
    <button type="button" className="browser-source-card-title" title={source.url} onClick={() => open(source.url)}>{source.title || host}</button>
    {excerpt ? <p className="browser-source-card-excerpt">{excerpt.slice(0, 800)}</p> : null}
    <div className="browser-source-card-actions">{source.date ? <time>{source.date}</time> : null}
      {source.content ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon name="file-text" size={12} />{expanded ? (zh ? '收起正文' : 'Hide content') : (zh ? '阅读正文' : 'Read content')}</button> : null}
      <button type="button" onClick={() => open(source.url)}><Icon name="globe" size={12} />{zh ? '打开网页' : 'Open page'}</button>
    </div>
    {expanded && source.content ? <div className="browser-source-card-content" role="region" aria-label={zh ? '来源正文' : 'Source content'}>
      {source.truncated ? <p className="browser-source-clip-note">{zh ? '这里是已读取的正文片段，可打开原网页继续阅读。' : 'This is an extracted passage. Open the original page to continue reading.'}</p> : null}
      <BrowserMarkdown text={source.content} open={open} /></div> : null}
  </article>;
}, (previous, next) => previous.zh === next.zh && previous.open === next.open && previous.source.id === next.source.id
  && previous.source.title === next.source.title && previous.source.url === next.source.url && previous.source.date === next.source.date
  && previous.source.kind === next.source.kind && previous.source.snippet === next.source.snippet && previous.source.content === next.source.content && previous.source.truncated === next.source.truncated);

export function BrowserSources({ sources, open, zh }: { sources: BrowserAiSource[]; open(url: string): void; zh: boolean }) {
  const [all, setAll] = useState(false);
  return <section className="browser-ai-sources" aria-label={zh ? '参考来源' : 'Sources'}>
    <header><Icon name="link" size={14} /><strong>{zh ? '参考来源' : 'Sources'}</strong><small>{sources.length}</small></header>
    <div>{(all ? sources : sources.slice(0, 3)).map(source => <BrowserSourceCard key={source.id} source={source} open={open} zh={zh} />)}</div>
    {sources.length > 3 ? <button type="button" className="browser-sources-more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? (zh ? '收起更多来源' : 'Show fewer sources') : (zh ? `查看全部 ${sources.length} 个来源` : `View all ${sources.length} sources`)}</button> : null}
  </section>;
}
