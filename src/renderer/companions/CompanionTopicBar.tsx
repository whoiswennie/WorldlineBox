import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import type { CompanionTopic } from '../../shared/companion-topic';

export type CompanionTopicHistoryFilter = 'current' | 'all' | 'ordinary' | `topic:${string}`;
export const companionTopicStatus = { active: '进行中', paused: '已暂停', closed: '已结束' } as const;
function parseTags(value: string) { return [...new Set(value.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))]; }
function invalidTags(value: string) { const tags = parseTags(value); return tags.length > 50 || tags.some(tag => tag.length > 80); }

export function CompanionTopicBar({ conversationId, members, activeTopicId, topics, historyFilter, request, onActivate, onChanged, onCatalog, onDeleted, onHistoryFilter }: {
  readonly conversationId: string;
  readonly members: readonly { id: string; name: string }[];
  readonly activeTopicId?: string;
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
  const [history, setHistory] = useState<CompanionTopic[]>([]);
  const [query, setQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [status, setStatus] = useState<CompanionTopic['status'] | 'all'>('all');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<number>();
  const [editing, setEditing] = useState<{ topic: CompanionTopic; title: string; tags: string; invitedIds: string[]; fork: boolean }>();
  const [deleting, setDeleting] = useState<string>();
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
  const current = topics.find(topic => topic.id === activeTopicId);
  async function activate(id: string | null) {
    setBusy(true);
    try { await onActivate(id); } finally { setBusy(false); }
  }
  async function create() {
    if (!title.trim() || invalidTags(tags) || busy) return;
    setBusy(true);
    try {
      const result = await request({ type: 'topic.create', conversationId, title: title.trim(), kind, participantIds: invitedIds, tags: parseTags(tags) });
      if (!result?.topic) return;
      onChanged(result.topic);
      await onActivate(result.topic.id);
      setCreating(false); setTitle(''); setTags('');
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
      if (type === 'topic.resume' || type === 'topic.reopen') await onActivate(subject.id);
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
      if (type === 'topic.join') await onActivate(subject.id);
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
  return <section className="companions-topic-bar" aria-label="聊天话题" aria-busy={busy}>
    <div className="companions-topic-controls">
      <span className="companions-topic-current" aria-label="当前发送话题">发送到：<strong>{activeTopicId ? current?.title ?? '正在读取话题…' : '日常聊天'}</strong></span>
      <button disabled={busy} onClick={() => setShowHistory(true)} aria-label="选择发送话题">切换话题</button>
      {current && <span className={`companions-topic-status is-${current.status}`} role="status">{companionTopicStatus[current.status]}</span>}
      {current?.status === 'active' && <button disabled={busy} onClick={() => void transition('topic.pause')}>暂停话题</button>}
      {current?.status === 'paused' && <button disabled={busy} onClick={() => void transition('topic.resume')}>恢复话题</button>}
      {current && current.status !== 'closed' && <button disabled={busy} onClick={() => void transition('topic.close')}>结束话题</button>}
      {activeTopicId && <button disabled={busy} onClick={() => void activate(null)}>返回日常</button>}
      <button disabled={busy} aria-expanded={creating} onClick={() => setCreating(value => !value)}>新建话题</button>
      <button aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>话题列表</button>
      <label className="companions-topic-history">记录<select aria-label="话题历史筛选" value={historyFilter} onChange={event => onHistoryFilter(event.target.value as CompanionTopicHistoryFilter)}>
        <option value="current">仅当前聊天</option><option value="all">全部话题与日常</option><option value="ordinary">仅日常</option>
        {historyFilter.startsWith('topic:') && <option value={historyFilter}>{topics.find(topic => `topic:${topic.id}` === historyFilter)?.title ?? '选中的话题'}</option>}
      </select></label>
    </div>
    {creating && <form className="companions-topic-create" aria-label="新建聊天话题" onSubmit={event => { event.preventDefault(); void create(); }}>
      <input autoFocus aria-label="话题名称" placeholder="例如：周末旅行、狼人杀第一局" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} />
      <select aria-label="话题类型" value={kind} onChange={event => setKind(event.target.value as CompanionTopic['kind'])} disabled={busy}><option value="discussion">讨论</option><option value="game">游戏</option><option value="story">故事</option></select>
      <input aria-label="话题标签" placeholder="标签，用逗号分隔" maxLength={1000} value={tags} onChange={event => setTags(event.target.value)} disabled={busy} />
      <fieldset className="companions-topic-invites"><legend>邀请伙伴（对方自行决定加入）</legend>{members.map(member => <label key={member.id}><input type="checkbox" checked={invitedIds.includes(member.id)} onChange={event => setInvitedIds(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} disabled={busy} />{member.name}</label>)}</fieldset>
      {invalidTags(tags) && <p role="alert">最多 50 个标签，每个标签最多 80 个字。</p>}
      <button className="companion-primary-button" disabled={busy || !title.trim() || invalidTags(tags)} type="submit">创建并进入</button>
      <button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button>
    </form>}
    {showHistory && <section className="companions-topic-library" aria-label="话题列表">
      <header><input aria-label="搜索话题" placeholder="搜索话题名称" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} />
        <input aria-label="按标签搜索话题" placeholder="筛选标签" value={tagQuery} onChange={event => setTagQuery(event.target.value)} maxLength={1000} />
        <select aria-label="话题状态筛选" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">所有状态</option>{Object.entries(companionTopicStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <button disabled={historyLoading} onClick={() => void loadHistory()}>刷新列表</button>
        <button aria-label="关闭话题列表" onClick={() => setShowHistory(false)}>关闭</button></header>
      <div className="companions-topic-library-list">
        {history.map(topic => <article key={topic.id}>
          <div><strong>{topic.title}</strong><span>{companionTopicStatus[topic.status]} · {topic.kind === 'game' ? '游戏' : topic.kind === 'story' ? '故事' : '讨论'}{topic.forkedFromTopicId ? ' · 分支' : ''} · {topic.participantIds.includes('user') ? '已加入' : topic.invitedIds.includes('user') ? '受邀加入' : '可加入'}</span><span>参与者：{topic.participantIds.map(id => id === 'user' ? '我' : members.find(member => member.id === id)?.name ?? id).join('、')}</span>{topic.invitedIds.length > 0 && <span>受邀：{topic.invitedIds.map(id => id === 'user' ? '我' : members.find(member => member.id === id)?.name ?? id).join('、')}</span>}{topic.tags.length > 0 && <span>{topic.tags.map(tag => `#${tag}`).join(' ')}</span>}</div>
          <div className="companions-topic-row-actions">
            <button onClick={() => onHistoryFilter(`topic:${topic.id}`)}>查看记录</button>
            {topic.participantIds.includes('user') ? <><button disabled={busy} onClick={() => void (topic.status === 'active' ? activate(topic.id) : transition(topic.status === 'paused' ? 'topic.resume' : 'topic.reopen', topic))}>{topic.status === 'active' ? '进入话题' : '恢复并进入'}</button><button disabled={busy} onClick={() => void membership('topic.leave', topic)}>退出话题</button></> : <button disabled={busy} onClick={() => void membership('topic.join', topic)}>{topic.status === 'closed' ? '恢复并加入' : '加入话题'}</button>}
            <button disabled={busy} onClick={() => setEditing({ topic, title: topic.title, tags: topic.tags.join(', '), invitedIds: topic.invitedIds, fork: false })}>编辑话题</button>
            <button disabled={busy} onClick={() => setEditing({ topic, title: `${topic.title} · 分支`.slice(0, 120), tags: topic.tags.join(', '), invitedIds: topic.invitedIds, fork: true })}>创建分支</button>
            <button disabled={busy} onClick={() => setDeleting(topic.id)}>删除</button>
          </div>
          {deleting === topic.id && <div className="companions-topic-delete" role="alert"><span>删除「{topic.title}」的话题及工作状态？删除后无法查看该话题原文，记录不会转入日常。</span><button disabled={busy} onClick={() => void transition('topic.delete', topic)}>确认删除话题</button><button onClick={() => setDeleting(undefined)}>取消删除</button></div>}
        </article>)}
        {!history.length && !historyLoading && <p>还没有找到话题。</p>}
        {historyLoading && <p role="status">正在读取话题列表…</p>}
        {nextCursor && <button disabled={historyLoading} onClick={() => void loadHistory(nextCursor)}>读取更早的话题</button>}
      </div>
      {editing && <form className="companions-topic-create" aria-label={editing.fork ? '创建话题分支' : '重命名话题'} onSubmit={event => { event.preventDefault(); void saveTitle(); }}>
        <input autoFocus aria-label={editing.fork ? '分支话题名称' : '新的话题名称'} value={editing.title} maxLength={120} onChange={event => setEditing({ ...editing, title: event.target.value })} disabled={busy} />
        {!editing.fork && <input aria-label="编辑话题标签" value={editing.tags} maxLength={1000} onChange={event => setEditing({ ...editing, tags: event.target.value })} disabled={busy} />}
        {!editing.fork && <fieldset className="companions-topic-invites"><legend>邀请伙伴（已加入的伙伴自行决定退出）</legend>{members.filter(member => !editing.topic.participantIds.includes(member.id)).map(member => <label key={member.id}><input type="checkbox" checked={editing.invitedIds.includes(member.id)} onChange={event => setEditing({ ...editing, invitedIds: event.target.checked ? [...editing.invitedIds, member.id] : editing.invitedIds.filter(id => id !== member.id) })} disabled={busy} />{member.name}</label>)}</fieldset>}
        {invalidTags(editing.tags) && <p role="alert">最多 50 个标签，每个标签最多 80 个字。</p>}
        <button type="submit" disabled={busy || !editing.title.trim() || invalidTags(editing.tags)}>保存{editing.fork ? '并进入' : ''}</button><button type="button" onClick={() => setEditing(undefined)}>取消编辑</button>
      </form>}
    </section>}
    {(historyFilter !== 'current' || current?.status === 'paused') && <p>{current?.status === 'paused' ? '话题已暂停，恢复后可以继续发送。' : `正在浏览历史；新消息仍发送到${current ? `「${current.title}」` : '日常聊天'}。`}</p>}
  </section>;
}
