import { useBotCallDocument } from './call-pet';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { AttachmentKindIcon, BotAttachment, type BotAttachmentProps } from './BotAttachment';
import { BotIcon } from './BotIcon';
import { botAttachmentCategoryLabel, botAttachmentDetails, botAttachmentSummary, type BotAttachmentCategory } from './attachment-presentation';
import { formatBotFileSize } from './media-presentation';
import './bot-attachment-bundle.css';

type Props = Omit<BotAttachmentProps, 'media' | 'variant'> & { media: readonly BotMediaRef[] };
const categories: BotAttachmentCategory[] = ['image', 'video', 'audio', 'document'], pageSize = 10;
export function BotAttachmentBundle({ media, ...common }: Props) {
  const [expanded, setExpanded] = useState(false), zh = common.locale === 'zh-CN';
  if (media.length < 3) return <>{media.map(item => <BotAttachment key={item.id} media={item} {...common} />)}</>;
  const summary = botAttachmentSummary(media), tiles = media.slice(0, 6), remaining = media.length - tiles.length;
  return <section className="bot-attachment-bundle" aria-label={zh ? `${summary.count} 个附件` : `${summary.count} attachments`}>
    <button type="button" className="bot-attachment-bundle-header" onClick={() => setExpanded(true)} aria-label={zh ? '查看全部附件' : 'View all attachments'}><span className="bot-attachment-bundle-folder"><AttachmentKindIcon kind="bundle" /></span><span><strong>{zh ? '附件合集' : 'Shared attachments'}</strong><small>{zh ? `共 ${summary.count} 个附件` : `${summary.count} attachments`}<i />{formatBotFileSize(summary.bytes)}</small></span><span className="bot-attachment-bundle-expand" aria-hidden="true">↗</span></button>
    <div className={`bot-attachment-bundle-mosaic${tiles.length >= 6 ? ' is-featured' : ''}`}>
      {tiles.map(item => <BotAttachment key={item.id} media={item} {...common} variant="tile" />)}
      <button className="bot-attachment-bundle-more" type="button" onClick={() => setExpanded(true)} aria-label={zh ? '查看全部附件' : 'View all attachments'}><strong>{remaining ? `+${remaining}` : summary.count}</strong><span>{zh ? '查看全部' : 'View all'}</span></button>
    </div>
    <footer><div className="bot-attachment-bundle-types">{categories.filter(kind => summary.counts[kind]).map(kind => <span key={kind}><AttachmentKindIcon kind={kind === 'document' ? 'text' : kind} />{botAttachmentCategoryLabel(kind, zh)} {summary.counts[kind]}</span>)}</div><button type="button" onClick={() => setExpanded(true)}>{zh ? '全部文件' : 'All files'}<span aria-hidden="true">→</span></button></footer>
    {expanded && <AttachmentExplorer key={common.conversationId} media={media} {...common} onClose={() => setExpanded(false)} />}
  </section>;
}
function AttachmentExplorer({ media, onClose, ...common }: Props & { onClose(): void }) {
  const surface = useBotCallDocument();
  const zh = common.locale === 'zh-CN', id = useId(), box = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState(''), [type, setType] = useState<BotAttachmentCategory | 'all'>('all'), [paging, setPaging] = useState({ key: '', page: 0 });
  const summary = botAttachmentSummary(media), normalized = query.normalize('NFKC').toLocaleLowerCase().trim(), pageKey = `${type}:${normalized}`;
  const matching = media.filter(item => { const details = botAttachmentDetails(item); return (type === 'all' || details.category === type) && `${item.name}\n${details.name}`.normalize('NFKC').toLocaleLowerCase().includes(normalized); });
  const pages = Math.max(1, Math.ceil(matching.length / pageSize)), page = Math.min(paging.key === pageKey ? paging.page : 0, pages - 1), visible = matching.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => { const previous = surface.activeElement; close.current?.focus(); return () => { if (previous && previous.isConnected && typeof (previous as HTMLElement).focus === 'function') (previous as HTMLElement).focus(); }; }, [surface]);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!box.current?.contains(event.target as Node)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')], first = controls[0], last = controls.at(-1);
    if (event.shiftKey && surface.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && surface.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<div className="bot-attachment-explorer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="bot-attachment-explorer" ref={box} role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={keyboard}>
    <header><span className="bot-attachment-bundle-folder"><AttachmentKindIcon kind="bundle" /></span><div><h2 id={id}>{zh ? '全部附件' : 'All attachments'}</h2><small>{zh ? `共 ${summary.count} 个附件` : `${summary.count} attachments`} · {formatBotFileSize(summary.bytes)}</small></div><button type="button" ref={close} aria-label={zh ? '关闭附件列表' : 'Close attachment list'} onClick={onClose}>×</button></header>
    <div className="bot-attachment-explorer-search"><BotIcon name="search" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={zh ? '搜索附件文件名' : 'Search attachment filenames'} placeholder={zh ? '搜索完整文件名…' : 'Search filenames…'} /></div>
    <nav aria-label={zh ? '附件类型' : 'Attachment type'}><button type="button" aria-pressed={type === 'all'} onClick={() => setType('all')}>{zh ? '全部' : 'All'} <span>{summary.count}</span></button>{categories.filter(kind => summary.counts[kind]).map(kind => <button type="button" key={kind} aria-pressed={type === kind} onClick={() => setType(kind)}>{botAttachmentCategoryLabel(kind, zh)} <span>{summary.counts[kind]}</span></button>)}</nav>
    <div className="bot-attachment-explorer-list" role="list" aria-label={zh ? '附件文件' : 'Attachment files'}>{visible.map(item => <div role="listitem" key={item.id}><BotAttachment media={item} {...common} variant="list" /></div>)}{!visible.length && <div className="bot-attachment-explorer-empty"><BotIcon name="search" /><strong>{zh ? '没有匹配的附件' : 'No matching attachments'}</strong><span>{zh ? '换个文件名或类型再看看。' : 'Try another filename or file type.'}</span></div>}</div>
    <footer><span>{zh ? `${matching.length} 个附件 · 第 ${page + 1} / ${pages} 页` : `${matching.length} attachments · Page ${page + 1} of ${pages}`}</span><div><button type="button" disabled={!page} onClick={() => setPaging({ key: pageKey, page: page - 1 })}>{zh ? '上一页' : 'Previous'}</button><button type="button" disabled={page + 1 >= pages} onClick={() => setPaging({ key: pageKey, page: page + 1 })}>{zh ? '下一页' : 'Next'}</button></div></footer>
  </section></div>, surface.body);
}
