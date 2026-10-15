import { useCallback, useEffect, useRef, useState } from 'react';
import type { Companion, CompanionMessage, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionSocialConversationPage, CompanionSocialDays, CompanionSocialMessage, CompanionSocialMessagePage } from '../../shared/companion-social';
import { companionTimestamp } from '../../shared/companion-time';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { Avatar } from './CompanionVisuals';
import { CompanionMessageBubble } from './CompanionMessageBubble';
import { CompanionReplyStreamStore } from './reply-stream';
import './companion-social.css';

type Request = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
type ConversationCursor = NonNullable<CompanionSocialConversationPage['nextCursor']>;
type MessageCursor = NonNullable<CompanionSocialMessagePage['nextCursor']>;
type MessagePosition = { before?: MessageCursor; around?: string };
function channelLabel(channel: CompanionSocialMessage['channel']) { return channel === 'face_to_face' ? '当面交流' : channel === 'phone' ? '手机消息' : '方式未记录'; }
function ChannelBadge({ channel }: { channel: CompanionSocialMessage['channel'] }) { return <span className={'companions-social-channel is-' + (channel ?? 'unknown')} data-social-channel={channel ?? 'unknown'} title={channel === 'face_to_face' ? '同一场景内当面说的话' : channel === 'phone' ? '通过手机远程发送的消息' : '这条历史记录没有保存交流方式'}><Icon name={channel === 'face_to_face' ? 'users' : channel === 'phone' ? 'message-circle' : 'clock'} />{channelLabel(channel)}</span>; }
function dayStep(day: string, amount: number) { const date = new Date(day + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); }
function useSearch(value: string) { const [search, setSearch] = useState(value); useEffect(() => { const timer = setTimeout(() => setSearch(value.trim()), 250); return () => clearTimeout(timer); }, [value]); return search; }

/** Read-only view over the same durable peer messages; observation never creates a player participant. */
export function CompanionSocialMonitor({ companions, request, api, onClose, onOpenUrl }: {
  companions: Companion[]; request: Request; api?: WorldlineBoxCompanionsApi; onClose(): void; onOpenUrl(url: string): void;
}) {
  useDialogFocusTrap(true, '伙伴社交观察');
  const [day, setDay] = useState<string>();
  const [owner, setOwner] = useState(''), [query, setQuery] = useState(''), [messageQuery, setMessageQuery] = useState('');
  const search = useSearch(query), messageSearch = useSearch(messageQuery);
  const [days, setDays] = useState<CompanionSocialDays>();
  const [conversations, setConversations] = useState<CompanionSocialConversationPage>();
  const [conversationId, setConversationId] = useState<string>();
  const [perspective, setPerspective] = useState('');
  const [messages, setMessages] = useState<CompanionSocialMessagePage>();
  const [conversationCursors, setConversationCursors] = useState<(ConversationCursor | undefined)[]>([undefined]);
  const [conversationPage, setConversationPage] = useState(0);
  const [messageCursors, setMessageCursors] = useState<(MessagePosition | undefined)[]>([undefined]);
  const [messagePage, setMessagePage] = useState(0);
  const [listLoading, setListLoading] = useState(true), [messageLoading, setMessageLoading] = useState(false);
  const [listError, setListError] = useState(''), [messageError, setMessageError] = useState('');
  const [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const [newMessages, setNewMessages] = useState(false);
  const [streamStore] = useState(() => new CompanionReplyStreamStore());
  const messageList = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const loadedMessages = useRef<CompanionSocialMessagePage | undefined>(undefined);
  const conversation = conversations?.items.find(item => item.id === conversationId);
  const viewpoint = conversation?.memberIds.includes(perspective) ? perspective : conversation?.memberIds[0];
  const companionName = (id: string) => companions.find(item => item.id === id)?.name ?? '已离开的伙伴';
  const cursor = conversationCursors[conversationPage], position = messageCursors[messagePage];
  const before = position?.before, around = position?.around;
  const resetList = useCallback(() => { setConversationCursors([undefined]); setConversationPage(0); setConversationId(undefined); setConversations(undefined); setMessages(undefined); setListLoading(true); }, []);
  const resetMessages = useCallback(() => { followLatest.current = true; loadedMessages.current = undefined; setNewMessages(false); setMessageCursors([undefined]); setMessagePage(0); setMessages(undefined); setNotice(''); }, []);
  useEffect(() => { void Promise.resolve().then(() => { resetList(); resetMessages(); }); }, [search, resetList, resetMessages]);
  useEffect(() => { void Promise.resolve().then(resetMessages); }, [messageSearch, conversationId, resetMessages]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [onClose]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const remove = api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => setRevision(value => value + 1), 400); }); return () => { remove?.(); clearTimeout(timer); }; }, [api]);
  useEffect(() => {
    let cancelled = false;
    void request({ type: 'social.days', ...(owner ? { companionId: owner } : {}), ...(day ? { month: day.slice(0, 7) } : {}), ...(search ? { query: search } : {}) }).then(result => {
      if (cancelled) return;
      if (result?.socialDays) { setDays(result.socialDays); setDay(current => current ?? result.socialDays!.observedDay); }
      else { setListError(result?.error ?? '社交日历读取失败。'); setListLoading(false); }
    });
    return () => { cancelled = true; };
  }, [request, owner, day, search, revision]);
  useEffect(() => {
    if (day === undefined) return;
    let cancelled = false;
    void request({ type: 'social.conversations', ...(owner ? { companionId: owner } : {}), ...(day ? { day } : {}), ...(search ? { query: search } : {}), ...(cursor ? { before: cursor } : {}), limit: 20 }).then(result => {
      if (cancelled) return;
      setListLoading(false);
      if (!result?.socialConversationPage) { setListError(result?.error ?? '伙伴会话读取失败。'); return; }
      setListError(''); setConversations(result.socialConversationPage);
      setConversationId(current => result.socialConversationPage!.items.some(item => item.id === current) ? current : result.socialConversationPage!.items[0]?.id);
    });
    return () => { cancelled = true; };
  }, [request, day, owner, search, cursor, revision]);
  useEffect(() => {
    if (!conversationId || day === undefined) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) setMessageLoading(true); });
    void request({ type: 'social.messages', conversationId, ...(day ? { day } : {}), ...(messageSearch ? { query: messageSearch } : {}), ...(before ? { before } : {}), ...(around ? { around } : {}), limit: 50 }).then(result => {
      if (cancelled) return;
      setMessageLoading(false);
      if (!result?.socialMessagePage) { setMessageError(result?.error ?? '对话记录读取失败。'); return; }
      setMessageError('');
      const old = loadedMessages.current, incoming = result.socialMessagePage;
      if (!before && !around && !messageSearch && !followLatest.current && old && incoming.items.at(-1)?.message.sequence !== old.items.at(-1)?.message.sequence) { setNewMessages(true); return; }
      loadedMessages.current = incoming; setMessages(incoming); setNewMessages(false);
      if (around) {
        if (!result.socialMessagePage.items.some(item => item.message.id === around)) setNotice('引用不在当前日期或搜索范围内，可以清除筛选后查看。');
        else requestAnimationFrame(() => { if (!cancelled) messageList.current?.querySelector<HTMLElement>(`[data-social-message="${CSS.escape(around)}"]`)?.scrollIntoView({ block: 'center' }); });
      } else if (!before && !messageSearch) requestAnimationFrame(() => { if (!cancelled && messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight; });
    });
    return () => { cancelled = true; };
  }, [request, conversationId, day, messageSearch, before, around, revision]);
  function selectConversation(id: string) { if (id === conversationId) { setRevision(value => value + 1); return; } resetMessages(); setConversationId(id); setMessageQuery(''); setPerspective(''); }
  function selectDay(value: string) { if (value === day) { setRevision(current => current + 1); return; } resetList(); resetMessages(); setDay(value); }
  function showLatest() { followLatest.current = true; setNewMessages(false); setMessageCursors([undefined]); setMessagePage(0); setRevision(value => value + 1); }
  function locateQuote(id: string) { const row = messageList.current?.querySelector<HTMLElement>(`[data-social-message="${CSS.escape(id)}"]`); if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.focus(); } else { setMessageCursors(value => [...value.slice(0, messagePage + 1), { around: id }]); setMessagePage(value => value + 1); } }
  const daySummary = days?.days.find(item => item.day === day);
  const sectionDay = (message: { virtualCreatedAt: string }) => new Intl.DateTimeFormat('en-CA', { timeZone: messages?.timeZone ?? days?.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(message.virtualCreatedAt));
  const preview = (message: CompanionMessage | undefined) => message ? (message.content || '一段新的对话').replace(/\s+/g, ' ').slice(0, 100) : '还没有新的消息';
  return <div className="companions-task-backdrop"><section className="companions-social-monitor" role="dialog" aria-modal="true" aria-label="伙伴社交观察">
    <header><div><small>LIFE BETWEEN COMPANIONS</small><h2>她们之间的小日常</h2><p>{day ? day + ' · ' + (daySummary ? `${daySummary.messageCount} 条交流 · ${daySummary.conversationCount} 个会话` : '按天回看') : '所有日期'}{days && ` · 世界时区 ${days.timeZone}`}</p></div><button className="companion-icon-button" aria-label="关闭社交观察" onClick={onClose}><Icon name="close" /></button></header>
    <div className="companions-social-body"><aside className="companions-social-conversations"><div className="companions-social-filters">
      <div className="companions-social-day"><button aria-label="前一天的社交记录" disabled={!day} onClick={() => selectDay(dayStep(day!, -1))}><Icon name="chevron-left" /></button><input type="date" aria-label="社交记录日期" value={day ?? ''} onChange={event => selectDay(event.target.value)} /><button aria-label="后一天的社交记录" disabled={!day} onClick={() => selectDay(dayStep(day!, 1))}><Icon name="chevron" /></button></div>
      <div className="companions-social-day-links"><button onClick={() => { if (days) selectDay(days.observedDay); }}>今天</button><button onClick={() => selectDay('')}>所有日期</button></div>
      <select aria-label="筛选社交伙伴" value={owner} onChange={event => { resetList(); resetMessages(); setOwner(event.target.value); }}><option value="">全部伙伴</option>{companions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <label className="companions-social-search"><Icon name="search" /><input aria-label="搜索伙伴社交记录" type="search" placeholder="查找会话或聊过的内容" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} /></label>
    </div><nav aria-label="伙伴之间的会话" aria-busy={listLoading}>{listError ? <p role="alert">{listError}<button onClick={() => setRevision(value => value + 1)}>重试</button></p> : !conversations?.items.length ? <p className="companions-social-empty">{listLoading ? '正在翻开社交记录…' : '这一天还没有符合条件的交流。她们会根据自己的生活、关系和话题自主联系。'}</p> : conversations.items.map(item => <button key={item.id} data-social-conversation={item.id} className={conversationId === item.id ? 'is-selected' : ''} aria-pressed={conversationId === item.id} onClick={() => selectConversation(item.id)}><span className="companions-social-avatars">{item.memberIds.slice(0, 3).map(id => <Avatar key={id} companion={companions.find(role => role.id === id) ?? { name: '伙伴', avatar: 'custom' }} showPresence={false} />)}</span><span><strong>{item.title || item.memberIds.map(companionName).join('、')}</strong><small>{item.kind === 'private' ? '伙伴私聊' : `${item.memberIds.length} 位伙伴的群聊`} · {item.messageCount} 条{item.lastMessage?.channel && ` · ${channelLabel(item.lastMessage.channel)}`}</small><p>{item.lastMessage && `${companionName(item.lastMessage.message.authorId)}：`}{preview(item.lastMessage?.message)}</p></span></button>)}</nav>
      <footer className="companions-social-pagination"><button disabled={!conversationPage || listLoading} onClick={() => { setListLoading(true); setConversationPage(value => value - 1); }}>上一页</button><span>{conversationPage + 1} · 共 {conversations?.total ?? 0} 个会话</span><button disabled={!conversations?.hasMore || !conversations.nextCursor || listLoading} onClick={() => { setListLoading(true); setConversationCursors(value => [...value.slice(0, conversationPage + 1), conversations!.nextCursor]); setConversationPage(value => value + 1); }}>下一页</button></footer>
    </aside><main className="companions-social-chat">{conversation ? <><header><div><strong>{conversation.title || conversation.memberIds.map(companionName).join('、')}</strong><small>{conversation.memberIds.map(companionName).join(' · ')} · 当面与手机交流 · 只读观察</small></div><label>观察视角<select aria-label="社交聊天观察视角" value={viewpoint} onChange={event => setPerspective(event.target.value)}>{conversation.memberIds.map(id => <option key={id} value={id}>{companionName(id)}</option>)}</select></label></header><div className="companions-social-chat-toolbar"><label className="companions-social-search"><Icon name="search" /><input type="search" aria-label="在伙伴对话中查找" placeholder="在这段对话中查找" value={messageQuery} maxLength={500} onChange={event => setMessageQuery(event.target.value)} /></label><span>{messages?.total ?? 0} 条消息</span></div>
      {days?.backlog && <p className="companions-social-notice">世界正在接续离线生活，日期以已恢复到的时刻为准。</p>}{notice && <p className="companions-social-notice" role="status">{notice}</p>}{newMessages && <button className="companions-social-new-messages" onClick={showLatest}>有新消息，回到最新记录</button>}
      <div className="companions-social-messages" ref={messageList} onScroll={event => { const list = event.currentTarget; followLatest.current = list.scrollHeight - list.clientHeight - list.scrollTop < 48; }} aria-label="伙伴对话记录" aria-busy={messageLoading}>{messageError ? <p role="alert">{messageError}<button onClick={() => setRevision(value => value + 1)}>重试</button></p> : !messages?.items.length ? <p className="companions-social-empty">{messageLoading ? '正在读取对话…' : '这个条件下没有消息。'}</p> : messages.items.map((item, index) => {
        const message = item.message, author = companions.find(role => role.id === message.authorId) ?? { name: '已离开的伙伴', avatar: 'custom' as const };
        const replied = messages.items.find(row => row.message.id === message.replyToId)?.message;
        const date = sectionDay(item), previous = messages.items[index - 1];
        return <div key={message.id}>{(!previous || sectionDay(previous) !== date) && <div className="companions-date-divider">{date}</div>}<article className={'companions-message' + (message.authorId === viewpoint ? ' is-own' : '')} data-social-message={message.id} data-social-author={message.authorId} data-social-message-channel={item.channel ?? 'unknown'} tabIndex={-1}><Avatar companion={author} showPresence={false} /><div className="companions-message-body"><div className="companions-message-author"><span title={message.authorId}>{author.name}</span><time dateTime={item.virtualCreatedAt} title={'世界时间 ' + item.virtualCreatedAt + '\n现实记录 ' + companionTimestamp(message.createdAt)}>{new Date(item.virtualCreatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: messages.timeZone })}</time><ChannelBadge channel={item.channel} /></div>{!!item.recipientIds.length && <small className="companions-social-recipient">对 {item.recipientIds.map(companionName).join('、')} 说</small>}<CompanionMessageBubble message={message} replied={replied} quoteAuthor={replied ? companionName(replied.authorId) : undefined} actions={[]} now={Date.parse(message.createdAt)} streamStore={streamStore} interrupted={false} onOpenAction={() => undefined} onOpenUrl={onOpenUrl} onOpenAttachment={() => setNotice('伙伴社交记录中的附件只读。')} onLocateQuote={locateQuote} onStreamLayout={() => undefined} /></div></article></div>;
      })}</div><footer className="companions-social-chat-footer"><button disabled={!messages?.hasMore || !messages.nextCursor || messageLoading} onClick={() => { followLatest.current = true; setMessageCursors(value => [...value.slice(0, messagePage + 1), { before: messages!.nextCursor }]); setMessagePage(value => value + 1); }}>更早的消息</button><span>第 {messagePage + 1} 页 · 每页 50 条</span><button disabled={!messagePage || messageLoading} onClick={() => { followLatest.current = true; setMessagePage(value => value - 1); }}>较新的消息</button></footer><p className="companions-social-observation"><Icon name="eye" />这是伙伴之间的交流记录。观察不会加入会话，也不会授予她们玩家的电脑操作权限。</p></> : <div className="companions-social-welcome"><Icon name="users" /><h3>生活里，也有彼此</h3><p>选择一段伙伴私聊或群聊，回看她们在这一天遇见时的交谈，以及通过手机发出的消息。</p></div>}</main></div>
  </section></div>;
}
