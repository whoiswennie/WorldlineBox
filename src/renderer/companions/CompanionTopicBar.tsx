import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icons';
import { ChatGlyph } from './CompanionVisuals';
import type { CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import type { CompanionTopic } from '../../shared/companion-topic';

export type CompanionTopicHistoryFilter = 'current' | 'all' | 'ordinary' | `topic:${string}`;
export const companionTopicStatus = { active: '进行中', paused: '已暂停', closed: '已结束' } as const;
function parseTags(value: string) { return [...new Set(value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))]; }
function invalidTags(value: string) { const tags = parseTags(value); return tags.length > 50 || tags.some(tag => tag.length > 80); }

export function CompanionTopicBar({ conversationId, members, activeTopicId, defaultTopicId, topics, historyFilter, request, onActivate, onChanged, onCatalog, onDeleted, onHistoryFilter }: {
  readonly conversationId: string;
  readonly members: readonly { id: string; name: string }[];
  readonly activeTopicId?: string;
  readonly defaultTopicId?: string;
  readonly topics: readonly CompanionTopic[];
  readonly historyFilter: CompanionTopicHistoryFilter;
  readonly request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  readonly onActivate: (topicId: string | null) => Promise<void>;
  readonly onChanged: (topic: CompanionTopic) => void;
  readonly onCatalog: (topics: CompanionTopic[]) => void;
  readonly onDeleted: (topicId: string) => void;
  readonly onHistoryFilter: (filter: CompanionTopicHistoryFilter) => void;
}): ReactNode {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<CompanionTopic['kind']>('discussion');
  const [tags, setTags] = useState('');
  const [invitedIds, setInvitedIds] = useState<string[]>(members.map(member => member.id));
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [portalRoot, setPortalRoot] = useState<Element>();
  const [history, setHistory] = useState<CompanionTopic[]>([]);
  const [query, setQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [status, setStatus] = useState<CompanionTopic['status'] | 'all'>('all');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<number>();
  const [editing, setEditing] = useState<{ topic: CompanionTopic; title: string; tags: string; invitedIds: string[]; fork: boolean }>();
  const [deleting, setDeleting] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const historyEpoch = useRef(0);
  const catalogCallback = useRef(onCatalog);
  useLayoutEffect(() => { catalogCallback.current = onCatalog; }, [onCatalog]);
  const invalidateHistory = useCallback(() => { ++historyEpoch.current; }, []);
  const loadHistory = useCallback(async (before?: number) => {
    if (invalidTags(tagQuery)) return;
    const epoch = ++historyEpoch.current; setHistoryLoading(true);
    const result = await request({ type: 'topic.list', conversationId, query: query.trim() || undefined, tags: parseTags(tagQuery), status: status === 'all' ? undefined : status, before, limit: 50 });
    if (epoch !== historyEpoch.current) return;
    setHistoryLoading(false);
    if (!result?.topics) return;
    setHistory(current => before ? [...current, ...result.topics!.filter(topic => !current.some(previous => previous.id === topic.id))].slice(-200) : result.topics!);
    setNextCursor(result.hasMore ? result.topicNextCursor : undefined); catalogCallback.current(result.topics);
  }, [request, conversationId, query, tagQuery, status]);
  useEffect(() => {
    if (!showHistory) return;
    const timer = setTimeout(() => void loadHistory(), query || tagQuery ? 200 : 0);
    return () => { clearTimeout(timer); invalidateHistory(); };
  }, [showHistory, loadHistory, query, tagQuery, invalidateHistory]);
  useEffect(() => {
    if (!showHistory) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : trigger.current;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [showHistory]);
  const current = topics.find(topic => topic.id === activeTopicId);
  async function activate(id: string | null) {
    setBusy(true);
    try { await onActivate(id); setShowHistory(false); } finally { setBusy(false); }
  }
  async function create() {
    if (!title.trim() || invalidTags(tags) || busy) return;
    setBusy(true);
    try {
      const result = await request({ type: 'topic.create', conversationId, title: title.trim(), kind, participantIds: invitedIds, tags: parseTags(tags) });
      if (!result?.topic) return;
      onChanged(result.topic);
      await onActivate(result.topic.id);
      setCreating(false); setTitle(''); setTags(''); setShowHistory(false);
      if (showHistory) await loadHistory();
    } finally { setBusy(false); }
  }
  async function transition(type: 'topic.pause' | 'topic.resume' | 'topic.close' | 'topic.reopen' | 'topic.delete', subject = current) {
    if (!subject || busy) return;
    setBusy(true);
    try {
      const result = await request({ type, conversationId, topicId: subject.id, expectedRevision: subject.revision });
      if (result?.topic) onChanged(result.topic);
      if (!result?.ok) return;
      if (type === 'topic.delete') { onDeleted(subject.id); setDeleting(undefined); }
      if (type === 'topic.resume' || type === 'topic.reopen') { await onActivate(subject.id); setShowHistory(false); }
      else if (type !== 'topic.pause' && activeTopicId === subject.id) await onActivate(null);
      if (showHistory) await loadHistory();
    } finally { setBusy(false); }
  }
  async function membership(type: 'topic.join' | 'topic.leave', subject: CompanionTopic) {
    setBusy(true);
    try {
      let result = await request({ type, conversationId, topicId: subject.id });
      if (!result?.ok) return;
      if (type === 'topic.join' && result.topic?.status === 'closed') {
        result = await request({ type: 'topic.reopen', conversationId, topicId: subject.id, expectedRevision: result.topic.revision });
        if (!result?.ok) return;
      }
      if (result.topic) onChanged(result.topic);
      if (type === 'topic.join') { await onActivate(subject.id); setShowHistory(false); }
      if (type === 'topic.leave' && activeTopicId === subject.id) await onActivate(null);
      await loadHistory();
    } finally { setBusy(false); }
  }
  async function saveTitle() {
    if (!editing?.title.trim() || invalidTags(editing.tags) || busy) return;
    setBusy(true);
    try {
      const result = await request(editing.fork
        ? { type: 'topic.fork', conversationId, topicId: editing.topic.id, title: editing.title.trim() }
        : { type: 'topic.update', conversationId, topicId: editing.topic.id, expectedRevision: editing.topic.revision, patch: { title: editing.title.trim(), tags: parseTags(editing.tags), invitedIds: editing.invitedIds } });
      if (!result?.topic) return;
      onChanged(result.topic); setEditing(undefined);
      if (editing.fork) await onActivate(result.topic.id);
      await loadHistory();
    } finally { setBusy(false); }
  }
  function close() { setShowHistory(false); setCreating(false); setEditing(undefined); setDeleting(undefined); }
  return <>
    <button ref={trigger} className={`companion-icon-button${showHistory ? ' is-active' : ''}`} aria-label="话题管理" title="话题管理" aria-haspopup="dialog" aria-expanded={showHistory} onClick={event => { setPortalRoot(event.currentTarget.closest('.companions-app') ?? document.body); setShowHistory(true); }}><ChatGlyph name="topic" /></button>
    {showHistory && portalRoot && createPortal(<div className="companions-modal-backdrop companions-topic-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} className="companions-topic-manager" role="dialog" aria-modal="true" aria-label="话题管理" tabIndex={-1} aria-busy={busy} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
    }}>
    <header className="companions-topic-heading"><div><h3>话题</h3><p>每段聊天都保存在独立话题中，切换后随时接着聊。</p></div><button className="companion-icon-button" aria-label="关闭话题管理" onClick={close}><Icon name="close" /></button></header>
    <div className="companions-topic-body">
    <section className="companions-topic-current-card" aria-label="当前聊天位置">
      <div><span>当前发送到</span><strong>{current?.title ?? '正在读取话题…'}</strong></div>
      {current && <span className={`companions-topic-status is-${current.status}`} role="status">{companionTopicStatus[current.status]}</span>}
      <div className="companions-topic-current-actions">
      {current?.status === 'active' && !current.isPrimary && <button disabled={busy} onClick={() => void transition('topic.pause')}>暂停话题</button>}
      {current?.status === 'paused' && <button disabled={busy} onClick={() => void transition('topic.resume')}>恢复话题</button>}
      {current && !current.isPrimary && current.status !== 'closed' && <button disabled={busy} onClick={() => void transition('topic.close')}>结束话题</button>}
      {activeTopicId && activeTopicId !== defaultTopicId && <button disabled={busy} onClick={() => void activate(defaultTopicId ?? null)}>返回主要对话</button>}
      </div>
    </section>
    <div className="companions-topic-list-heading"><h4>聊天话题</h4><button className="companion-primary-button" disabled={busy} aria-expanded={creating} onClick={() => setCreating(value => !value)}><Icon name="plus" />新建话题</button></div>
    {creating && <form className="companions-topic-create" aria-label="新建聊天话题" onSubmit={event => { event.preventDefault(); void create(); }}>
      <input autoFocus aria-label="话题名称" placeholder="给话题起个名字，例如：狼人杀" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} />
      <select aria-label="话题类型" value={kind} onChange={event => setKind(event.target.value as CompanionTopic['kind'])} disabled={busy}><option value="discussion">讨论</option><option value="game">游戏</option><option value="story">故事</option></select>
      <input aria-label="话题标签" placeholder="标签，用逗号分隔（可选）" maxLength={1000} value={tags} onChange={event => setTags(event.target.value)} disabled={busy} />
      <fieldset className="companions-topic-invites"><legend>{kind === 'discussion' ? '参与聊天的伙伴' : '邀请伙伴（对方自行决定加入）'}</legend>{members.map(member => <label key={member.id}><input type="checkbox" checked={invitedIds.includes(member.id)} onChange={event => setInvitedIds(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} disabled={busy} />{member.name}</label>)}</fieldset>
      {invalidTags(tags) && <p role="alert">最多 50 个标签，每个标签最多 80 个字。</p>}
      <button className="companion-primary-button" disabled={busy || !title.trim() || invalidTags(tags)} type="submit">创建并进入</button>
      <button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button>
    </form>}
    <section className="companions-topic-library" aria-label="话题列表">
      <header><label className="companions-topic-search"><Icon name="search" /><input aria-label="搜索话题" placeholder="搜索话题名称" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} /></label>
        <button className="companion-icon-button" title="刷新列表" aria-label="刷新列表" disabled={historyLoading} onClick={() => void loadHistory()}><Icon name="refresh" /></button></header>
      <div className="companions-topic-filters"><input aria-label="按标签搜索话题" placeholder="筛选标签" value={tagQuery} onChange={event => setTagQuery(event.target.value)} maxLength={1000} />
        <select aria-label="话题状态筛选" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">所有状态</option>{Object.entries(companionTopicStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="companions-topic-library-list">
        {history.map(topic => <article key={topic.id} className={topic.id === activeTopicId ? 'is-current' : ''}>
          <div><strong>{topic.title}</strong>{topic.id === activeTopicId && <em>当前</em>}<span>{companionTopicStatus[topic.status]} · {topic.kind === 'game' ? '游戏' : topic.kind === 'story' ? '故事' : '讨论'}{topic.forkedFromTopicId ? ' · 分支' : ''} · {topic.participantIds.includes('user') ? '已加入' : topic.invitedIds.includes('user') ? '受邀加入' : '可加入'}</span><span>参与者：{topic.participantIds.map(id => id === 'user' ? '我' : members.find(member => member.id === id)?.name ?? id).join('、')}</span>{topic.invitedIds.length > 0 && <span>已邀请：{topic.invitedIds.map(id => id === 'user' ? '我' : members.find(member => member.id === id)?.name ?? id).join('、')}</span>}{topic.tags.length > 0 && <span>{topic.tags.map(tag => `#${tag}`).join(' ')}</span>}</div>
          <div className="companions-topic-row-actions">
            <button onClick={() => { onHistoryFilter(`topic:${topic.id}`); close(); }}>查看记录</button>
            {topic.participantIds.includes('user') ? <button className="companions-topic-enter" disabled={busy} onClick={() => void (topic.status === 'active' ? activate(topic.id) : transition(topic.status === 'paused' ? 'topic.resume' : 'topic.reopen', topic))}>{topic.status === 'active' ? '进入话题' : '恢复并进入'}</button> : <button className="companions-topic-enter" disabled={busy} onClick={() => void membership('topic.join', topic)}>{topic.status === 'closed' ? '恢复并加入' : '加入话题'}</button>}
            <details className="companions-topic-more"><summary aria-label={`管理${topic.title}`}>更多</summary><div>
              <button disabled={busy} onClick={() => setEditing({ topic, title: topic.title, tags: topic.tags.join(', '), invitedIds: topic.invitedIds, fork: false })}>编辑话题</button>
              <button disabled={busy} onClick={() => setEditing({ topic, title: `${topic.title} · 分支`.slice(0, 120), tags: topic.tags.join(', '), invitedIds: topic.invitedIds, fork: true })}>创建分支</button>
              {!topic.isPrimary && topic.participantIds.includes('user') && <button disabled={busy} onClick={() => void membership('topic.leave', topic)}>退出话题</button>}
              {!topic.isPrimary && <button className="companions-topic-danger" disabled={busy} onClick={() => setDeleting(topic.id)}>删除</button>}
            </div></details>
          </div>
          {deleting === topic.id && <div className="companions-topic-delete" role="alert"><span>删除「{topic.title}」的话题及工作状态？删除后无法查看该话题原文，记录不会转入日常。</span><button disabled={busy} onClick={() => void transition('topic.delete', topic)}>确认删除话题</button><button onClick={() => setDeleting(undefined)}>取消删除</button></div>}
        </article>)}
        {!history.length && !historyLoading && <p className="companions-topic-empty">{query || tagQuery || status !== 'all' ? '没有找到匹配的话题，试试其他筛选条件。' : '话题暂未加载，请刷新重试。已有聊天记录会保留。'}</p>}
        {historyLoading && <p role="status">正在读取话题列表…</p>}
        {nextCursor && <button className="companions-topic-load-more" disabled={historyLoading} onClick={() => void loadHistory(nextCursor)}>读取更早的话题</button>}
      </div>
      {editing && <form className="companions-topic-create" aria-label={editing.fork ? '创建话题分支' : '重命名话题'} onSubmit={event => { event.preventDefault(); void saveTitle(); }}>
        <input autoFocus aria-label={editing.fork ? '分支话题名称' : '新的话题名称'} value={editing.title} maxLength={120} onChange={event => setEditing({ ...editing, title: event.target.value })} disabled={busy} />
        {!editing.fork && <input aria-label="编辑话题标签" value={editing.tags} maxLength={1000} onChange={event => setEditing({ ...editing, tags: event.target.value })} disabled={busy} />}
        {!editing.fork && <fieldset className="companions-topic-invites"><legend>邀请伙伴（已加入的伙伴自行决定退出）</legend>{members.filter(member => !editing.topic.participantIds.includes(member.id)).map(member => <label key={member.id}><input type="checkbox" checked={editing.invitedIds.includes(member.id)} onChange={event => setEditing({ ...editing, invitedIds: event.target.checked ? [...editing.invitedIds, member.id] : editing.invitedIds.filter(id => id !== member.id) })} disabled={busy} />{member.name}</label>)}</fieldset>}
        {invalidTags(editing.tags) && <p role="alert">最多 50 个标签，每个标签最多 80 个字。</p>}
        <button type="submit" disabled={busy || !editing.title.trim() || invalidTags(editing.tags)}>保存{editing.fork ? '并进入' : ''}</button><button type="button" onClick={() => setEditing(undefined)}>取消编辑</button>
      </form>}
    </section>
    <label className="companions-topic-history">聊天记录显示<select aria-label="话题历史筛选" value={historyFilter} onChange={event => onHistoryFilter(event.target.value as CompanionTopicHistoryFilter)}>
        <option value="current">仅当前话题</option><option value="all">全部话题</option><option value="ordinary">主要对话</option>
        {historyFilter.startsWith('topic:') && <option value={historyFilter}>{topics.find(topic => `topic:${topic.id}` === historyFilter)?.title ?? '选中的话题'}</option>}
      </select></label>
      {historyFilter !== 'current' && <p className="companions-topic-history-note">仅更改查看的记录，新消息仍发送到当前聊天位置。</p>}
    </div>
    </div></div>, portalRoot)}
  </>;
}
