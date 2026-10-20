import type { PlayerProfile } from '../../shared/companion-profile';
import { useEffect, useRef, useState } from 'react';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionSocialFlowEvent, CompanionSocialGraph as SocialGraph } from '../../shared/companion-social';
import { Icon } from '../Icons';
import { SocialNetworkCanvas } from './SocialNetworkCanvas';
import { createCoalescedRefresh } from './coalesced-refresh';

const linkLabels: Record<SocialGraph['links'][number]['status'], string> = { idle: '暂无进行中的交互', phone: '手机交流中', face: '当面交谈中', queued: '消息等待送达', reply: '等待真实回复', permission: '等待房主许可', visiting: '处于同一场景' };
type Props = { playerProfile?: Pick<PlayerProfile, 'name' | 'avatarAttachmentId'>; companions: Companion[]; initialCompanionId?: string; request(input: CompanionsRequest): Promise<CompanionsResponse | undefined>; api?: WorldlineBoxCompanionsApi; onHistory(id: string, owner: string): void };

/** Observer-only graph. Polling reads durable facts; it never schedules actors or invents activity. */
export function CompanionSocialGraph({ playerProfile, companions, initialCompanionId, request, api, onHistory }: Props) {
  const [chosenCenterId, setCenterId] = useState<string>();
  const centerId = chosenCenterId || initialCompanionId || companions.find(role => role.id === 'deepseek-flash')?.id || companions[0]?.id || '';
  const [graph, setGraph] = useState<SocialGraph>(), [error, setError] = useState(''), [updated, setUpdated] = useState<number>();
  const [selectedPeer, setSelectedPeer] = useState(''), [selectedEvent, setSelectedEvent] = useState<string>(), [filter, setFilter] = useState('all');
  const [pageLimit, setPageLimit] = useState(16);
  const [query, setQuery] = useState(''), [searchQuery, setSearchQuery] = useState(''), [group, setGroup] = useState<'active' | 'dormant' | 'player'>();
  const [pages, setPages] = useState<string[]>([]), [trail, setTrail] = useState<string[]>([]), [loading, setLoading] = useState(false), [graphKey, setGraphKey] = useState('');
  const afterPeerId = pages.at(-1), scopeKey = [centerId, searchQuery, group, afterPeerId, pageLimit].join('|');
  useEffect(() => { const timeout = setTimeout(() => setSearchQuery(query.trim()), 250); return () => clearTimeout(timeout); }, [query]);
  const [paused, setPaused] = useState(false), [revision, setRevision] = useState(0);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const knownIds = useRef<Set<string> | undefined>(undefined), refreshRef = useRef<() => void>(() => undefined);
  const stream = useRef<HTMLDivElement>(null), follow = useRef(true);
  useEffect(() => {
    let disposed = false;
    knownIds.current = undefined;
    const read = async () => {
      if (disposed || document.hidden || paused || !centerId) return;
      setLoading(true);
      try {
        const result = await request({ type: 'social.graph', companionId: centerId, limit: pageLimit, ...(searchQuery ? { query: searchQuery } : {}), ...(group ? { group } : {}), ...(afterPeerId ? { afterPeerId } : {}) });
        if (disposed) return;
        if (!result?.socialGraph) { setError(result?.error ?? '暂时无法连接社交实况，正在重试。'); return; }
        const incoming = result.socialGraph, ids = new Set(incoming.events.map(event => event.id));
        setFreshIds(new Set(knownIds.current ? [...ids].filter(id => !knownIds.current!.has(id)) : []));
        knownIds.current = ids; setGraph(incoming); setGraphKey(scopeKey); setError(''); setUpdated(Date.now());
        if (follow.current) requestAnimationFrame(() => { if (!disposed && stream.current) stream.current.scrollTop = 0; });
      } catch { if (!disposed) setError('社交实况连接中断，正在重试。'); }
      finally { if (!disposed) setLoading(false); }
    };
    const refresh = createCoalescedRefresh(read, undefined, 750);
    refreshRef.current = () => { void refresh.trigger(); };
    const changed = () => { void refresh.trigger(); };
    const unsubscribe = api?.onChanged(changed), interval = setInterval(changed, 2000);
    document.addEventListener('visibilitychange', changed); changed();
    return () => { disposed = true; clearInterval(interval); refresh.dispose(); unsubscribe?.(); document.removeEventListener('visibilitychange', changed); };
  }, [request, api, centerId, paused, revision, searchQuery, group, afterPeerId, scopeKey, pageLimit]);
  const current = graph?.centerId === centerId && graphKey === scopeKey ? graph : undefined;
  const name = (id: string) => current?.nodes.find(node => node.id === id)?.name ?? (id === 'user' ? '我' : companions.find(role => role.id === id)?.name ?? '伙伴');
  const time = (at: string, seconds = false) => new Date(at).toLocaleTimeString('zh-CN', { timeZone: current?.timeZone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const peers = (current?.nodes.filter(node => node.id !== centerId) ?? []).sort((a, b) => (a.id === 'user' ? -2 : a.id === selectedPeer ? -1 : 0) - (b.id === 'user' ? -2 : b.id === selectedPeer ? -1 : 0));
  const events = (current?.events ?? []).filter(event => (!selectedPeer || event.actorId === selectedPeer || event.targetIds.includes(selectedPeer))
    && (filter === 'all' || (filter === 'messages' ? !!event.message : !event.message))).slice().reverse();
  const chosen = current?.events.find(event => event.id === selectedEvent), selectedLink = current?.links.find(link => link.targetId === selectedPeer);
  function focusPeer(id: string) { setSelectedPeer(current => current === id ? '' : id); setSelectedEvent(undefined); }
  function changeQuery(value: string) { setQuery(value); setPages([]); setSelectedPeer(''); }
  function changeGroup(value?: typeof group) { setGroup(value); setPages([]); setSelectedPeer(''); }
  function recenter(id: string, back = false) { if (!back) setTrail(value => [...value.slice(-19), centerId]); setPages([]); setGroup(undefined); setQuery(''); setSearchQuery(''); setCenterId(id); setSelectedPeer(''); setSelectedEvent(undefined); setFreshIds(new Set()); follow.current = true; }
  const eventDescription = (event: CompanionSocialFlowEvent) => (event.actorName ?? name(event.actorId)) + ' → ' + (event.targetNames ?? event.targetIds.map(name)).join('、');
  return <div className="social-live" aria-label="实时社交图谱" data-social-center={centerId}>
    <div className="social-live-toolbar"><label>关系中心<select aria-label="社交图谱中心伙伴" value={centerId} onChange={event => recenter(event.target.value)}>{[...new Map([...(companions.find(role => role.id === centerId) ? [] : [{ id: centerId, name: name(centerId) }]), ...[...companions.slice(0, 40), ...companions.filter(role => role.id === centerId)]].map(role => [role.id, role])).values()].map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      {trail.length > 0 && <button className="social-return" onClick={() => { const previous = trail.at(-1)!; setTrail(value => value.slice(0, -1)); recenter(previous, true); }}>返回上一中心</button>}
      <span className={'social-live-indicator' + (error ? ' is-error' : paused ? ' is-paused' : '')}><i />{error ? '连接中断' : paused ? '已暂停观察' : '实时同步'}</span>
      <span className="social-live-clock"><Icon name="clock" />世界 {current ? `${current.observedDay} ${time(current.virtualNow, true)}` : '正在读取…'}</span>
      <button className="companion-icon-button" aria-label={paused ? '恢复实时观察' : '暂停实时观察'} onClick={() => setPaused(value => !value)}><Icon name={paused ? 'play' : 'pause'} /></button>
      <button className="companion-icon-button" aria-label="刷新社交图谱" onClick={() => setRevision(value => value + 1)}><Icon name="refresh" /></button>
    </div>
    {error && <p className="social-live-error" role="alert">{error}<button onClick={() => refreshRef.current()}>立即重试</button></p>}
    <div className="social-live-workspace"><section className="social-network" aria-label="伙伴关系网络">
      <div className="social-network-caption"><div><small>RELATIONSHIP MAP</small><h3>{name(centerId)}的社交网络</h3><p>从真实往来中，看见她与每个人的联系</p></div><div className="social-map-help" title="大型网络先聚合显示；点击分类展开，搜索任意姓名或 ID。按画布大小与可读间距分批加载关系，双击伙伴逐层探索，拖动平移，Ctrl+滚轮缩放。"><Icon name="info" /><span>如何使用</span></div></div>
      <div className="social-map-metrics"><div><span><Icon name="users" />全部关系</span><strong>{(current?.total ?? peers.length).toLocaleString()}<small>位</small></strong></div><div><span><Icon name="activity" />已激活伙伴</span><strong>{(current?.groups?.find(item => item.id === 'active')?.count ?? peers.filter(node => node.id !== 'user' && node.active).length).toLocaleString()}<small>位</small></strong></div><div><span><Icon name="clock" />当前局部</span><strong>{peers.length}<small>位</small></strong></div></div>
      <SocialNetworkCanvas key={centerId} graph={current} companions={companions} playerProfile={playerProfile} selected={selectedPeer} group={group} query={query} onSelect={focusPeer} onCenter={recenter} onGroup={changeGroup} onQuery={changeQuery} canPrevious={pages.length > 0} loading={loading && !current} onCapacity={setPageLimit} onNext={() => { if (current?.nextPeerId) { setPages(value => [...value.slice(-31), current.nextPeerId!]); setSelectedPeer(''); } }} onPrevious={() => { setPages(value => value.slice(0, -1)); setSelectedPeer(''); }} />
      <div className="social-network-bottom"><div className="social-network-legend"><span><i className="phone" />手机联系</span><span><i className="face" />当面交流</span><span><i className="permission" />等待处理</span><span><i />往来关系</span></div><small>单击查看 · 双击切换中心 · 拖动画布平移</small></div>
      <p className="social-network-note"><Icon name="eye" />观察实况 · 选择一位伙伴，查看她们之间正在发生的事{updated && <span>最近同步 {new Date(updated).toLocaleTimeString('zh-CN')}</span>}</p>
    </section><aside className="social-event-panel" aria-label="实时社交事件流"><header><div><small>LIVE EVENTS</small><h3>实时事件流</h3></div><span>{events.length} 条</span></header>
      <div className="social-event-filters"><select aria-label="筛选图谱往来对象" value={selectedPeer} onChange={event => { setSelectedPeer(event.target.value); setSelectedEvent(undefined); }}><option value="">全部往来</option>{peers.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select><select aria-label="筛选社交事件类型" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">所有事件</option><option value="messages">交流消息</option><option value="visits">拜访与行动</option></select></div>
      {selectedLink && <div className="social-relationship-detail"><div><strong>{name(centerId)} <span>↔</span> {name(selectedPeer)}</strong><button className="companion-icon-button" aria-label="清除关系筛选" onClick={() => focusPeer(selectedPeer)}><Icon name="close" /></button></div><p>{linkLabels[selectedLink.status]}</p>{selectedLink.kind === 'peer' && <small>近期 {selectedLink.phoneCount} 条手机消息 · {selectedLink.faceCount} 条当面交流</small>}<div className="social-relationship-actions">{selectedPeer !== 'user' && <button onClick={() => recenter(selectedPeer)}>以她为中心<Icon name="network" /></button>}{selectedLink.kind === 'peer' && selectedLink.conversationIds[0] && <button onClick={() => onHistory(selectedLink.conversationIds[0]!, centerId)}>查看往来记录<Icon name="chevron" /></button>}</div></div>}
      <div className="social-event-list" ref={stream} onScroll={event => { follow.current = event.currentTarget.scrollTop < 48; }}>
        {!current ? <p className="companions-social-empty">正在连接真实社交记录…</p> : !events.length ? <p className="companions-social-empty">暂无符合条件的事件。真实交流或行动发生后会自动显示。</p> : events.map(event => <button key={event.id} data-social-event={event.id} className={'social-event is-' + event.kind + (selectedEvent === event.id ? ' is-selected' : '') + (freshIds.has(event.id) ? ' is-new' : '')} aria-expanded={selectedEvent === event.id} onClick={() => setSelectedEvent(value => value === event.id ? undefined : event.id)}><div className="social-event-marker"><Icon name={event.kind === 'face_to_face' ? 'users' : event.message ? 'message-circle' : event.kind === 'scene_enter' ? 'box' : 'activity'} /></div><div className="social-event-content"><div><strong>{event.label}</strong><time dateTime={event.at}>{time(event.at, true)}</time></div><small>{eventDescription(event)}</small><p>{event.message ? event.text : event.kind === 'scene_enter' ? '已通过入口进入目标场景；当面交流另行记录。' : event.kind === 'scene_depart' ? '已开始实际移动，抵达后会产生新事件。' : event.kind === 'visit_request' ? '拜访申请已登记，等待房主决定。' : event.label}</p>{chosen?.id === event.id && <section className="social-event-expanded">{event.textTruncated && <span>内容为预览，完整原文已保留。</span>}<span>世界时间 {new Date(event.at).toLocaleString('zh-CN', { timeZone: current.timeZone })}</span><span>现实记录 {new Date(event.realAt).toLocaleString('zh-CN')}</span>{event.sceneId && <span>场景 {event.sceneId}</span>}{event.message?.message.replyToId && <span>回应了一条已有消息</span>}<em>已记录的{event.message ? '实际消息' : '宿主行为'} · {event.message?.channel === 'face_to_face' ? '同场且距离核验通过' : '可追溯事实'}</em></section>}</div></button>)}
        {current?.hasMoreEvents && <p className="social-event-history-hint">显示最近 60 条事件。完整消息可在「往来记录」按日期回看。</p>}
      </div>
      <footer>自动同步 · 世界时区 {current?.timeZone ?? '—'}</footer>
    </aside></div>
  </div>;
}
