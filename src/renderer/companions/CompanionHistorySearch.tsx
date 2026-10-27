import { useEffect, useRef, useState } from 'react';
import type { Companion, CompanionConversation, CompanionSearchHit, CompanionSearchPage, CompanionSearchQuery } from '../../shared/companions';
import type { CompanionRequest } from './CompanionDialogs';
import type { PlayerProfile } from '../../shared/companion-profile';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { companionTimestamp, companionTimezone } from '../../shared/companion-time';

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/u).filter(Boolean).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return <>{text}</>;
  const regex = new RegExp('(' + terms.join('|') + ')', 'giu');
  return <>{text.split(regex).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}
export function CompanionHistorySearch({ request, conversations, companions, playerProfile, conversationId, onClose, onLocate }: {
  request: CompanionRequest; conversations: CompanionConversation[]; companions: Companion[];
  conversationId?: string; onClose: () => void; onLocate: (hit: CompanionSearchHit) => void;
  playerProfile?: Pick<PlayerProfile, 'name' | 'avatarAttachmentId'>;
}) {
  useDialogFocusTrap(true, '查找聊天记录');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState(conversationId ?? '');
  const [topicFilter, setTopicFilter] = useState<'all' | 'ordinary' | 'current'>('all');
  const activeTopicId = conversations.find(room => room.id === scope)?.activeTopicId;
  const [authorId, setAuthorId] = useState('');
  const [category, setCategory] = useState<NonNullable<CompanionSearchQuery['category']>>('all');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [page, setPage] = useState<CompanionSearchPage | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const snapshot = useRef<number | undefined>(undefined);
  const observedTopic = useRef(activeTopicId);
  useEffect(() => {
    const generation = ++epoch.current;
    let disposed = false;
    const timer = setTimeout(async () => {
      if (topicFilter === 'current' && observedTopic.current !== activeTopicId) {
        observedTopic.current = activeTopicId;
        snapshot.current = undefined; setCursors([undefined]); setPageIndex(0); setPageOffset(0); setPage(null);
        if (!activeTopicId) setTopicFilter('all');
        return;
      }
      observedTopic.current = activeTopicId;
      setBusy(true); setError('');
      const fromDate = from ? new Date(from + 'T00:00:00') : undefined;
      const toDate = to ? new Date(to + 'T00:00:00') : undefined;
      if (toDate) toDate.setDate(toDate.getDate() + 1);
      if (fromDate && toDate && fromDate >= toDate) { setError('结束日期不能早于开始日期。'); setBusy(false); return; }
      const response = await request({ type: 'message.search', query: query.trim(), ...(scope ? { conversationId: scope } : {}),
        ...(scope && topicFilter === 'ordinary' ? { topicId: null } : scope && topicFilter === 'current' && activeTopicId ? { topicId: activeTopicId } : {}),
        ...(authorId ? { authorId } : {}), category, ...(fromDate ? { from: fromDate.toISOString() } : {}), ...(toDate ? { to: toDate.toISOString() } : {}),
        ...(cursors[pageIndex] ? { before: cursors[pageIndex] } : {}), ...(snapshot.current !== undefined ? { snapshot: snapshot.current } : {}), limit: 30, compact: true });
      if (disposed || generation !== epoch.current) return;
      setBusy(false);
      if (!response) { setError('搜索未完成，请重试。'); return; }
      const result = response.searchPage ?? { items: (response.messages ?? []).map(item => ({ ...item, excerpt: item.content.slice(0, 480) })), hasMore: response.hasMore ?? false, snapshot: 0, indexReady: true };
      snapshot.current = result.snapshot; setPage(result);
    }, 250);
    return () => { clearTimeout(timer); disposed = true; };
  }, [request, query, scope, topicFilter, activeTopicId, authorId, category, from, to, pageIndex, cursors, revision]);
  useEffect(() => {
    if (page?.indexReady !== false) return;
    const timer = setTimeout(() => setRevision(value => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [page, revision]);
  function reset() { snapshot.current = undefined; setCursors([undefined]); setPageIndex(0); setPageOffset(0); setPage(null); }
  const authors = scope ? companions.filter(role => conversations.find(room => room.id === scope)?.memberIds.includes(role.id)) : companions;
  const player = { name: playerProfile?.name || '我', avatar: 'custom' as const, avatarAttachmentId: playerProfile?.avatarAttachmentId };
  return <div className="companions-modal-backdrop" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <section role="dialog" aria-modal="true" aria-label="查找聊天记录" className="companions-history-modal">
      <header><div><h2>查找聊天记录</h2><p>按关键词、话题、成员、日期或文件类型查找，再回到原消息</p></div><button className="companion-icon-button" aria-label="关闭聊天搜索" onClick={onClose}>×</button></header>
      <div className="companions-history-query"><Icon name="search" /><input data-dialog-initial-focus="true" aria-label="搜索聊天内容" maxLength={200} placeholder="关键词或文件名，多个关键词用空格分隔" value={query} onChange={event => { reset(); setQuery(event.target.value); }} /><button className="companion-secondary-button" onClick={() => { reset(); setRevision(value => value + 1); }}>刷新</button></div>
      <div className="companions-history-filters">
        <label>聊天<select aria-label="搜索范围" value={scope} onChange={event => { reset(); setScope(event.target.value); setAuthorId(''); setTopicFilter('all'); }}><option value="">全部聊天</option>{conversations.map(room => <option value={room.id} key={room.id}>{room.title}</option>)}</select></label>
        {scope && <label>话题<select aria-label="搜索话题范围" value={topicFilter} onChange={event => { reset(); setTopicFilter(event.target.value as typeof topicFilter); }}><option value="all">全部话题与日常</option><option value="ordinary">仅日常聊天</option>{activeTopicId && <option value="current">仅当前话题</option>}</select></label>}
        <label>发送者<select aria-label="搜索发送者" value={authorId} onChange={event => { reset(); setAuthorId(event.target.value); }}><option value="">所有人</option><option value="user">{player.name}</option>{authors.map(role => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
        <label>类型<select aria-label="消息类型" value={category} onChange={event => { reset(); setCategory(event.target.value as typeof category); }}><option value="all">全部消息</option><option value="images">图片</option><option value="files">文件</option><option value="links">链接</option></select></label>
        <label>开始日期<input aria-label="开始日期" type="date" value={from} onChange={event => { reset(); setFrom(event.target.value); }} /></label><label>结束日期<input aria-label="结束日期" type="date" value={to} onChange={event => { reset(); setTo(event.target.value); }} /></label>
      </div>
      {error && <p className="companions-modal-error" role="alert">{error}</p>}
      {page?.indexReady === false && <p className="companions-history-indexing" role="status">正在为旧记录建立搜索索引，结果会自动补全。关闭后下次仍会接着处理。</p>}
      <div className="companions-history-hits" aria-busy={busy}>
        {page?.items.map(hit => { const author = companions.find(role => role.id === hit.authorId); return <button key={hit.id} className="companions-history-hit" onClick={() => onLocate(hit)} data-search-message={hit.id}>
          <Avatar companion={hit.authorId === 'user' ? player : author} /><div><div className="companions-history-hit-meta"><strong>{hit.authorId === 'user' ? player.name : author?.name ?? '已移除的伙伴'}</strong><time title={companionTimezone(hit.createdAt)}>{companionTimestamp(hit.createdAt)}</time></div><p><Highlight text={hit.excerpt || '附件消息'} query={query} /></p><small>{conversations.find(room => room.id === hit.conversationId)?.title ?? '历史聊天'}<span>查看前后文 <Icon name="chevron-right" /></span></small></div>
        </button>; })}
        {!page?.items.length && !busy && !error && <div className="companions-history-no-results"><Icon name="search" /><p>{page?.indexReady === false ? '索引建立中…' : '没有找到符合条件的消息'}</p><small>试试其他关键词，或调整成员与日期范围</small></div>}
      </div>
      <footer><span>{busy ? '正在搜索…' : `第 ${pageOffset + pageIndex + 1} 页 · 最新记录在前`}</span><div><button className="companion-secondary-button" disabled={busy || pageIndex === 0} onClick={() => setPageIndex(value => value - 1)}>上一页</button><button className="companion-secondary-button" disabled={busy || !page?.hasMore || !page.nextBefore} onClick={() => {
        const before = page?.nextBefore; if (!before) return;
        const next = [...cursors.slice(0, pageIndex + 1), before];
        if (next.length > 64) { setCursors(next.slice(-64)); setPageOffset(value => value + 1); }
        else { setCursors(next); setPageIndex(value => value + 1); }
      }}>下一页</button></div></footer>
    </section>
  </div>;
}
