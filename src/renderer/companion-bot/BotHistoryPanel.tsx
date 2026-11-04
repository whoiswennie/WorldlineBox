import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BotCompanion, BotMessage, WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import './bot-history.css';

const windowLimit = 400;
type HistoryFilter = 'all' | 'media' | 'stickers' | 'files' | 'links';
const filters: HistoryFilter[] = ['all', 'media', 'stickers', 'files', 'links'];
const words = {
  'zh-CN': { title: '聊天记录', placeholder: '搜索聊天记录', search: '搜索聊天记录', loading: '正在查找…', more: '加载更早记录',
    empty: '还没有聊天记录', noMatch: '没有找到相关记录', hint: '换个关键词，或试试其他分类', error: '记录暂时无法读取，请重试。', retry: '重试',
    all: '全部', media: '图片 / 音视频', stickers: '表情', files: '文件', links: '链接', locate: '定位到聊天', close: '关闭', dateUnknown: '日期未知' },
  en: { title: 'Chat history', placeholder: 'Search chat history', search: 'Search chat history', loading: 'Searching…', more: 'Load earlier records',
    empty: 'No messages yet', noMatch: 'No matching messages', hint: 'Try another keyword or category', error: 'Could not load messages. Try again.', retry: 'Retry',
    all: 'All', media: 'Media', stickers: 'Stickers', files: 'Files', links: 'Links', locate: 'Show in chat', close: 'Close', dateUnknown: 'Unknown date' },
};
type Failure = { message: string; before?: number; append: boolean };
interface HistoryProps { api: WorldlineBoxBotApi; conversationId: string; locale: 'zh-CN' | 'en'; companions?: readonly BotCompanion[]; onLocate(message: BotMessage): void }

export function BotHistoryDialog(props: HistoryProps & { title: string; onClose(): void }) {
  const container = useRef<HTMLElement>(null), t = words[props.locale];
  useEffect(() => {
    const previous = document.activeElement;
    container.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]')].filter(element => !element.hidden);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="bot-history-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section ref={container} className="bot-history-dialog" role="dialog" aria-modal="true" aria-label={t.title} onKeyDown={keyboard}>
      <header className="bot-history-heading"><div><h2>{props.title}</h2><span>{t.title}</span></div><button type="button" aria-label={t.close} onClick={props.onClose}>×</button></header>
      <BotHistoryPanel {...props} />
    </section>
  </div>;
}

/** Bounded, conversation-scoped original records. Semantic memory is a separate tool. */
export function BotHistoryPanel(props: HistoryProps) {
  const { conversationId, locale } = props, t = words[locale];
  const [search, setSearch] = useState({ conversationId, value: '', filter: 'all' as HistoryFilter });
  const query = search.conversationId === conversationId ? search.value : '', filter = search.conversationId === conversationId ? search.filter : 'all';
  return <section className="bot-history-panel" aria-label={t.title}>
    <div className="bot-history-controls"><label className="bot-history-search"><BotIcon name="search" />
      <input type="search" aria-label={t.search} placeholder={t.placeholder} value={query} maxLength={200} onChange={event => {
        if (event.target.value !== query) setSearch({ conversationId, value: event.target.value, filter });
      }} />
    </label>
    <div className="bot-history-tabs" role="tablist" aria-label={t.title}>{filters.map(value => <button key={value} type="button" role="tab" aria-selected={filter === value}
      onClick={() => setSearch({ conversationId, value: query, filter: value })}>{t[value]}</button>)}</div></div>
    <HistoryResults key={JSON.stringify([conversationId, locale, query, filter])} {...props} query={query} filter={filter} />
  </section>;
}
function highlight(text: string, query: string) {
  const needle = query.trim(), index = needle ? text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) : -1;
  return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}
function thumbnail(ref: BotMediaRef): string | undefined {
  if (ref.analysisBlocked || ref.previewEligibility === 'external-only') return;
  if (ref.previewUrl) return ref.previewUrl;
  if (ref.size <= 2 * 1024 * 1024 && /^(image\/(png|jpeg|avif|bmp))$/.test(ref.mimeType) && !ref.animated) return ref.url;
}
function HistoryResults({ api, conversationId, locale, companions, onLocate, query, filter }: HistoryProps & { query: string; filter: HistoryFilter }) {
  const t = words[locale];
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [busy, setBusy] = useState(true), [failure, setFailure] = useState<Failure>();
  const [cursor, setCursor] = useState<number>(), [hasMore, setHasMore] = useState(false);
  const generation = useRef(0), pending = useRef<number | undefined>(undefined);
  const read = useCallback(async (token: number, before?: number, append = false) => {
    if (token !== generation.current || pending.current === token) return;
    pending.current = token; setBusy(true); setFailure(undefined);
    try {
      const result = await api.request({ type: 'history.search', conversationId, query: query.trim(), filter, before, limit: 80 });
      if (token !== generation.current) return;
      if (!result.ok || !result.history) { setFailure({ message: result.error ?? t.error, before, append }); return; }
      if (result.history.items.some(message => message.conversationId !== conversationId)) throw new Error('History scope mismatch');
      const page = result.history;
      setMessages(previous => {
        const merged = new Map<string, BotMessage>();
        for (const message of append ? [...previous, ...page.items] : page.items) {
          if (message.content.trim() || message.attachments?.length) merged.set(message.id, message);
        }
        return [...merged.values()].sort((a, b) => b.sequence - a.sequence).slice(-windowLimit);
      });
      setCursor(page.nextBefore); setHasMore(page.hasMore && page.nextBefore !== undefined);
    } catch { if (token === generation.current) setFailure({ message: t.error, before, append }); }
    finally { if (token === generation.current) { pending.current = undefined; setBusy(false); } }
  }, [api, conversationId, query, filter, t.error]);
  useLayoutEffect(() => {
    const token = ++generation.current; pending.current = undefined;
    const timer = setTimeout(() => { void read(token); }, 300);
    return () => { clearTimeout(timer); generation.current = token + 1; };
  }, [read]);
  return <div className="bot-history-content">
    {failure && <div className="bot-history-error" role="alert"><span>{failure.message}</span><button type="button" disabled={busy} onClick={() => { void read(generation.current, failure.before, failure.append); }}>{t.retry}</button></div>}
    {busy && <p className="bot-history-loading" role="status">{t.loading}</p>}
    {!busy && !failure && !messages.length && <div className="bot-history-empty"><BotIcon name="history" /><strong>{query.trim() || filter !== 'all' ? t.noMatch : t.empty}</strong>{(query.trim() || filter !== 'all') && <p>{t.hint}</p>}</div>}
    <ol className="bot-history-results">
      {messages.map((message, index) => {
        const plain = message.content.trim(), preview = plain.length > 360 ? plain.slice(0, 360) + '…' : plain;
        const timestamp = new Date(message.createdAt), validDate = !Number.isNaN(timestamp.valueOf());
        const date = validDate ? timestamp.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }) : t.dateUnknown;
        const previous = messages[index - 1], previousDate = previous ? new Date(previous.createdAt).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }) : undefined;
        return <li className="bot-history-record" key={message.id}>
          {previousDate !== date && <h3 className="bot-history-date">{date}</h3>}
          <button className="bot-history-locate" type="button" title={t.locate} onClick={() => onLocate(message)}>
            <BotAvatar companion={companions?.find(item => item.id === message.senderId)} name={message.senderName || message.senderId} />
            <span className="bot-history-message"><span className="bot-history-meta"><strong>{message.senderName || message.senderId}</strong><time dateTime={message.createdAt} title={validDate ? timestamp.toLocaleString(locale) : message.createdAt}>{validDate ? timestamp.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : ''}</time></span>
            {preview && <span className="bot-history-preview">{highlight(preview, query)}</span>}
            {!!message.attachments?.length && <span className="bot-history-attachments">{message.attachments.slice(0, 4).map(ref => {
              const image = thumbnail(ref);
              return <span key={ref.id} className={image ? 'bot-history-thumbnail' : 'bot-history-file'}>{image ? <img src={image} alt={ref.name} loading="lazy" /> : <><BotIcon name={ref.kind === 'sticker' ? 'sticker' : 'file'} /><span>{ref.name}</span></>}</span>;
            })}{message.attachments.length > 4 && <span className="bot-history-attachment-count">+{message.attachments.length - 4}</span>}</span>}
            </span><span className="bot-history-locate-label">{t.locate}<span aria-hidden="true">↗</span></span>
          </button>
        </li>;
      })}
    </ol>
    {hasMore && <button className="bot-history-more" type="button" disabled={busy || !!failure} onClick={() => { void read(generation.current, cursor, true); }}>{t.more}</button>}
  </div>;
}
