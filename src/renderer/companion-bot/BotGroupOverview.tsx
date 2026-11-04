import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotCompanion, BotCompanionPresence, BotConversation, BotRequest, BotResponse } from '../../shared/companion-bot';
import { BotAvatar } from './BotAvatar';
import { BotPresenceText } from './BotPresence';
import { BotTextField } from './BotTextField';
import { BotIcon } from './BotIcon';
import './bot-group-overview.css';

export function BotGroupOverview({ conversation, companions, presence, locale, request, onChanged, onMembers, onContact }: {
  conversation: BotConversation; companions: readonly BotCompanion[]; presence?: Record<string, BotCompanionPresence>; locale: 'zh-CN' | 'en';
  request?(input: BotRequest): Promise<BotResponse>; onChanged?(): void; onMembers(): void; onContact?(companionId: string): void;
}) {
  const zh = locale === 'zh-CN', notice = conversation.announcement;
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<{ text: string; updatedAt: string } | null>(null), [clipped, setClipped] = useState(false);
  const preview = useRef<HTMLParagraphElement>(null);
  const [expected, setExpected] = useState<string | null>(null), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const alive = useRef(true), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    const measure = () => setClipped(element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [notice?.text, editing]);
  const owner = conversation.ownerId === 'user' && conversation.memberIds.includes('user') && !conversation.dissolvedAt;
  const search = query.trim().normalize('NFKC').toLocaleLowerCase();
  const members = [{ id: 'user', name: zh ? '我' : 'Me' }, ...companions].filter(member => !search || member.name.normalize('NFKC').toLocaleLowerCase().includes(search));
  const pages = Math.max(1, Math.ceil(members.length / 7)), currentPage = Math.min(page, pages - 1), visible = members.slice(currentPage * 7, (currentPage + 1) * 7);
  const save = async () => {
    if (!request || saving.current || !owner) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await request({ type: 'conversation.announcement', conversationId: conversation.id, content: draft, expectedUpdatedAt: expected });
      if (!alive.current) return;
      if (result.ok) { setEditing(false); onChanged?.(); }
      else setError(result.error ?? (zh ? '公告未保存，请重试。' : 'The announcement could not be saved.'));
    } catch { if (alive.current) setError(zh ? '公告未保存，请重试。' : 'The announcement could not be saved.'); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="bot-group-overview">
    <section className="bot-group-announcement" aria-label={zh ? '群公告' : 'Group announcement'}>
      <header><h3><BotIcon name="notice" />{zh ? '群公告' : 'Announcement'}</h3>{owner && request && !editing && <button type="button" onClick={() => { setDraft(notice?.text ?? ''); setExpected(notice?.updatedAt ?? null); setEditing(true); setError(''); }} aria-label={zh ? '编辑群公告' : 'Edit group announcement'}>{zh ? '编辑' : 'Edit'}</button>}</header>
      <div className="bot-group-announcement-body">{editing ? <form onSubmit={event => { event.preventDefault(); void save(); }}><BotTextField label={zh ? '公告内容' : 'Announcement text'} value={draft} onChange={event => setDraft(event.target.value)} maxLength={4000} minRows={4} showCount disabled={busy} /><small>{zh ? '所有群成员可见，留空保存可清除公告。' : 'Visible to all members. Save an empty announcement to clear it.'}</small>{error && <p className="bot-group-notice-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>{zh ? '取消' : 'Cancel'}</button><button type="submit" className="bot-group-notice-save" disabled={busy || draft === (notice?.text ?? '')}>{busy ? zh ? '保存中…' : 'Saving…' : zh ? '保存公告' : 'Save announcement'}</button></footer></form>
        : notice ? <><p className="bot-group-notice-text" ref={preview}>{notice.text}</p><footer><time dateTime={notice.updatedAt}>{new Date(notice.updatedAt).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })}{zh ? ' 更新' : ' updated'}</time>{(clipped || notice.text.length > 90 || notice.text.split('\n').length > 3) && <button type="button" onClick={() => setReading({ text: notice.text, updatedAt: notice.updatedAt })}>{zh ? '查看全文' : 'Read more'}</button>}</footer></>
          : <p className="bot-group-notice-empty">{zh ? '还没有群公告' : 'No announcement yet'}</p>}</div>
    </section>
    <section className="bot-group-members-overview" aria-label={zh ? '群成员速览' : 'Group member overview'}><header><h3>{zh ? '群成员' : 'Members'} <span>{conversation.memberIds.length}</span></h3><button type="button" onClick={onMembers}>{zh ? '管理' : 'Manage'}<span aria-hidden="true">↗</span></button></header>
      <label className="bot-group-member-search"><BotIcon name="search" /><input type="search" aria-label={zh ? '搜索群成员' : 'Search group members'} placeholder={zh ? '搜索群成员' : 'Search group members'} maxLength={80} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <div className="bot-group-member-list" role="region" aria-label={zh ? '群成员列表' : 'Group member list'} tabIndex={0}><ul>{visible.map(member => <li key={member.id}><button type="button" onClick={() => member.id === 'user' ? onMembers() : onContact ? onContact(member.id) : onMembers()} title={member.id !== 'user' && onContact ? zh ? `与${member.name}私聊` : `Chat with ${member.name}` : undefined}><BotAvatar companion={companions.find(person => person.id === member.id)} name={member.name} presence={presence?.[member.id]} locale={locale} /><span>{member.name}</span>{member.id === 'user' ? <small className="bot-group-owner-badge">{zh ? '群主' : 'Owner'}</small> : presence?.[member.id] && <BotPresenceText presence={presence[member.id]!} locale={locale} />}</button></li>)}</ul>
      {!visible.length && <p className="bot-group-notice-empty">{zh ? '没有匹配的成员' : 'No matching members'}</p>}
      </div><footer className="bot-group-members-pages"><span>{currentPage + 1} / {pages}</span><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)} aria-label={zh ? '上一页群成员' : 'Previous member page'}>‹</button><button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)} aria-label={zh ? '下一页群成员' : 'Next member page'}>›</button></footer>
    </section>
    {reading && <AnnouncementReader notice={reading} title={conversation.title} locale={locale} onClose={() => setReading(null)} />}
  </div>;
}

/** Read the selected, bounded announcement version as plain text. Reading does
 * not change the sidebar's membership/search/page state or mutate the notice. */
function AnnouncementReader({ notice, title, locale, onClose }: {
  notice: { text: string; updatedAt: string }; title: string; locale: 'zh-CN' | 'en'; onClose(): void;
}) {
  const zh = locale === 'zh-CN', id = useId(), dialog = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement; close.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]') ?? []];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<div className="bot-group-announcement-reader-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="bot-group-announcement-reader" role="dialog" aria-modal="true" aria-labelledby={id} ref={dialog} onKeyDown={keyboard}>
      <header><span className="bot-group-announcement-reader-symbol"><BotIcon name="notice" /></span><div><h2 id={id}>{zh ? '群公告全文' : 'Group announcement'}</h2><p>{title}</p><time dateTime={notice.updatedAt}>{new Date(notice.updatedAt).toLocaleString(locale)}</time></div><button type="button" aria-label={zh ? '关闭公告全文' : 'Close announcement'} ref={close} onClick={onClose}>×</button></header>
      <div className="bot-group-announcement-reader-content" role="region" aria-label={zh ? '公告全文内容' : 'Announcement content'} tabIndex={0}>{notice.text}</div>
    </section>
  </div>, document.body);
}
