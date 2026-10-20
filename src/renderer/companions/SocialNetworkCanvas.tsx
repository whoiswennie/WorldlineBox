import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Companion } from '../../shared/companions';
import type { CompanionSocialGraph as Graph } from '../../shared/companion-social';
import type { PlayerProfile } from '../../shared/companion-profile';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';

export const socialStateLabels: Record<string, string> = { available: '可以联系', dormant: '休眠中', sleeping: '正在睡觉', eating: '正在用餐', working: '正在工作', busy: '暂时忙碌', player: '玩家' };
const groupLabels = { active: '已激活伙伴', dormant: '休眠伙伴', player: '玩家' };
const liveLabels = { phone: '手机交流中', face: '当面交谈中', permission: '等待房主许可', queued: '等待送达', reply: '等待回复', visiting: '同场相处中' };
type Group = keyof typeof groupLabels;
type Props = { graph?: Graph; companions: Companion[]; playerProfile?: Pick<PlayerProfile, 'name' | 'avatarAttachmentId'>; selected: string; group?: Group; query: string;
  onSelect(id: string): void; onCenter(id: string): void; onGroup(group?: Group): void; onQuery(query: string): void; onNext(): void; onPrevious(): void; canPrevious: boolean; loading: boolean; onCapacity(limit: number): void };

/** Bounded neighbourhood rendering. An aggregate represents all its members, never an arbitrary sample. */
export function SocialNetworkCanvas({ graph, companions, playerProfile, selected, group, query, onSelect, onCenter, onGroup, onQuery, onNext, onPrevious, canPrevious, loading, onCapacity }: Props) {
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 }), [directory, setDirectory] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | undefined>(undefined);
  const roles = useMemo(() => new Map(companions.map(role => [role.id, role])), [companions]);
  const center = graph?.nodes.find(node => node.id === graph.centerId), peers = graph?.nodes.filter(node => node.id !== graph.centerId) ?? [];
  const total = graph?.total ?? peers.length, matched = graph?.matchedTotal ?? peers.length;
  const groups = graph?.groups ?? (['active','dormant','player'] as const).map(id => ({ id, count: peers.filter(node => id === 'player' ? node.id === 'user' : node.id !== 'user' && node.active === (id === 'active')).length }));
  const overview = !group && !query && total > (graph?.nodes.length ? peers.length : 16);
  const shown = overview ? peers.filter(node => node.id === selected) : peers;
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 480 });
  const slots = useMemo(() => {
    const result: Array<{ x: number; y: number }> = [], { width, height } = size;
    const columns = Math.max(1, Math.floor((width / 2 - 70) / 155)), rows = Math.max(2, Math.floor((height - 110) / 115) + 1);
    for (let column = 1; column <= columns; column++) for (let row = 0; row < rows; row++) for (const side of [-1, 1]) result.push({ x: width / 2 + side * column * 155, y: height / 2 + (row - (rows - 1) / 2) * 115 });
    result.push({ x: width / 2, y: 55 }, { x: width / 2, y: height - 80 });
    return result;
  }, [size]);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => { const width = element.clientWidth, height = element.clientHeight; if (width < 200 || height < 200) return;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
      const columns = Math.max(1, Math.floor((width / 2 - 70) / 155)), rows = Math.max(2, Math.floor((height - 110) / 115) + 1);
      onCapacity(Math.min(40, Math.max(4, columns * rows * 2 + 1)));
    };
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); return () => observer.disconnect();
  }, [onCapacity]);
  const positions = shown.map((node, index) => ({ ...node, ...(slots[index] ?? { x: size.width / 2, y: -200 }) }));
  const portrait = (node: Graph['nodes'][number]) => node.id === 'user' ? { id: 'user', name: playerProfile?.name ?? '我', avatar: 'custom' as const, avatarAttachmentId: playerProfile?.avatarAttachmentId }
    : { ...node, avatar: node.avatar ?? roles.get(node.id)?.avatar ?? 'custom', avatarAttachmentId: node.avatarAttachmentId ?? roles.get(node.id)?.avatarAttachmentId };
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  return <div className="social-explorer">
    <div className="social-explorer-search"><label><Icon name="search" /><input type="search" aria-label="搜索全部社交关系" placeholder="搜索姓名或 ID，定位任意关系…" value={query} onChange={event => { onQuery(event.target.value); setDirectory(true); }} /></label><button aria-pressed={directory} onClick={() => setDirectory(value => !value)}><Icon name="users" />关系目录</button></div>
    <div className="social-explorer-scope"><button className={!group ? 'is-active' : ''} onClick={() => { onGroup(undefined); onQuery(''); reset(); }}>全网总览 <b>{total.toLocaleString()}</b></button>{groups.filter(item => item.count).map(item => <button key={item.id} className={group === item.id ? 'is-active' : ''} onClick={() => { onGroup(item.id); reset(); }}>{groupLabels[item.id]} <b>{item.count.toLocaleString()}</b></button>)}<span>{loading ? '同步中…' : overview ? '聚合显示 · 点击展开' : `已加载 ${peers.length} / ${matched.toLocaleString()}`}</span></div>
    <div ref={canvas} className="social-network-canvas" aria-label="社交关系画布" tabIndex={0}
      onPointerDown={event => { if (event.button || (event.target as HTMLElement).closest('button, input, [data-social-edge], .social-relation-directory')) return; drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) setPan({ x: drag.current.px + event.clientX - drag.current.x, y: drag.current.py + event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}
      onWheel={event => { if (!(event.ctrlKey || event.metaKey)) return; event.preventDefault(); setZoom(value => Math.max(.4, Math.min(2.5, value - event.deltaY * .002))); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === '+' || event.key === '=') setZoom(value => Math.min(2.5, value + .1)); else if (event.key === '-') setZoom(value => Math.max(.4, value - .1)); else if (event.key === '0') reset(); else return; event.preventDefault(); }}>
      <div className="social-map-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <svg className="social-network-lines" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true"><defs><marker id="social-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
          {overview && groups.filter(item => item.count).map((item, index) => <g key={item.id} className={'social-edge is-cluster is-' + item.id}><path d={`M ${size.width / 2} ${size.height / 2} Q ${size.width * (index === 0 ? .25 : .75)} ${size.height / 2}, ${size.width * [.215,.785,.785][index]!} ${size.height * [.5,.29,.71][index]!}`} /></g>)}
          {positions.map(node => { const link = graph?.links.find(link => link.targetId === node.id), path = `M ${size.width / 2} ${size.height / 2} Q ${(size.width / 2 + node.x) / 2} ${size.height / 2 + (node.y - size.height / 2) * .25}, ${node.x} ${node.y}`; return <g key={node.id} data-social-edge={node.id} className={'social-edge is-' + link?.status + (selected === node.id ? ' is-selected' : '')} onClick={() => onSelect(node.id)}><path className="social-edge-hit" d={path} /><path d={path} markerEnd={link?.fromId === graph?.centerId ? 'url(#social-arrow)' : undefined} markerStart={link?.fromId === node.id ? 'url(#social-arrow)' : undefined} /><path className="social-edge-motion" d={path} /></g>; })}
        </svg>
        {overview && groups.filter(item => item.count).map((item, index) => <button key={item.id} data-social-cluster={item.id} className={'social-cluster is-' + item.id} style={{ left: `${[21.5,78.5,78.5][index]}%`, top: `${[50,29,71][index]}%` }} onClick={() => { onGroup(item.id); reset(); }}><span className="social-cluster-orb"><Icon name={'users'} /><strong>{item.count.toLocaleString()}</strong></span><b>{groupLabels[item.id]}</b><small>展开关系 <Icon name="chevron" /></small></button>)}
        {center && <article className="social-ego" data-social-focus={center.id}><Avatar companion={portrait(center)} showPresence={false} /><strong>{center.name}</strong><span><i />{socialStateLabels[center.state] ?? center.state}</span><small>{total.toLocaleString()} 位关系对象</small></article>}
        {positions.map(node => { const link = graph?.links.find(link => link.targetId === node.id); return <button key={node.id} data-social-node={node.id} aria-pressed={selected === node.id} className={'social-graph-person is-' + node.state + (selected === node.id ? ' is-selected' : '') + (link?.status && link.status !== 'idle' ? ' is-live' : '')} style={{ left: `${node.x / size.width * 100}%`, top: `${node.y / size.height * 100}%` }} onClick={() => onSelect(node.id)} onDoubleClick={() => { if (node.id !== 'user') { onCenter(node.id); reset(); } }} title={`${node.name} · ${socialStateLabels[node.state] ?? node.state} · 单击查看，双击展开她的关系`}><Avatar companion={portrait(node)} showPresence={false} /><strong>{node.name}</strong><span>{socialStateLabels[node.state] ?? node.state}</span>{link && link.status !== 'idle' && <em>{liveLabels[link.status]}</em>}</button>; })}
        {graph && !total && <div className="social-network-empty">尚无实际往来，真实联系发生后自动出现。</div>}
      </div>
      {directory && <aside className="social-relation-directory" aria-label="分页关系目录"><header><strong>{query ? '搜索结果' : group ? groupLabels[group] : '全部关系'} <small>{matched.toLocaleString()}</small></strong><button aria-label="收起关系目录" onClick={() => setDirectory(false)}><Icon name="close" /></button></header><div>{peers.map(node => <button key={node.id} data-social-result={node.id} className={selected === node.id ? 'is-selected' : ''} onClick={() => onSelect(node.id)}><Avatar companion={portrait(node)} showPresence={false} /><span><strong>{node.name}</strong><small>{socialStateLabels[node.state] ?? node.state}</small></span><Icon name="chevron" /></button>)}{!peers.length && <p>{loading ? '查询中…' : '没有匹配的关系'}</p>}</div><footer><button disabled={!canPrevious || loading} onClick={onPrevious}>上一批</button><button disabled={!graph?.hasMorePeers || loading} onClick={onNext}>下一批</button></footer></aside>}
      <div className="social-map-view-label"><Icon name="network" />{overview ? '全网聚合' : '局部关系'}<span>点击查看 · 双击展开</span></div>
      <div className="social-map-controls"><button aria-label="缩小社交图谱" onClick={() => setZoom(value => Math.max(.4, value - .1))}><Icon name="minus" /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大社交图谱" onClick={() => setZoom(value => Math.min(2.5, value + .1))}><Icon name="plus" /></button><i /><button aria-label="复位社交图谱" onClick={reset}><Icon name="fit-window" /></button></div>
    </div>
    <div className="social-explorer-pagination"><span>{overview ? '所有关系均计入聚合；展开后按需加载，休眠世界保持卸载。' : `${matched.toLocaleString()} 位匹配对象 · 按可读间距分批加载`}</span><div><button disabled={!canPrevious || loading} onClick={onPrevious}><Icon name="chevron" />上一批</button><button disabled={!graph?.hasMorePeers || loading} onClick={onNext}>下一批<Icon name="chevron" /></button></div></div>
  </div>;
}
