import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import { companionJobPageSchema, type CompanionJobDisposition, type CompanionJobKind, type CompanionJobPageCommand } from '../../shared/companion-job-control';
import { CompanionJobControls, companionJobStateLabels } from './CompanionJobControls';
import './companion-job-controls.css';

const kinds: Record<CompanionJobKind, string> = { capture: '来源整理', source_files: '来源文件发布', history_files: '历史与当前正文发布', topic_compaction: '话题摘要整理', index: '记忆投递与索引', tags: '自动标签', world: '世界活动与维护', learning: '知识学习', learning_goal: '学习目标', timeline: '月度时间线', growth: '人格成长' };
const filters = { needs: '需要处理', failed: '失败', parked: '已搁置', abandoned: '已放弃', all: '全部状态' };
type Filter = keyof typeof filters;
const statesFor = (filter: Filter): CompanionJobPageCommand['states'] => filter === 'all' ? undefined : filter === 'needs' ? ['failed', 'parked'] : [filter];
type Props = { ownerId: string; api?: WorldlineBoxCompanionsApi; initialKind?: CompanionJobKind; onClose?(): void };
export function CompanionJobFailures(props: Props) { return <FailureBrowser key={props.ownerId} {...props} />; }
function FailureBrowser({ ownerId, api, initialKind = 'capture', onClose }: Props) {
  const [kind, setKind] = useState<CompanionJobKind>(initialKind), [filter, setFilter] = useState<Filter>('needs');
  const [items, setItems] = useState<CompanionJobDisposition[]>([]), [next, setNext] = useState<string>(), [hasMore, setHasMore] = useState(false);
  const [selection, setSelection] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState(''), [folded, setFolded] = useState(0);
  const alive = useRef(false), sequence = useRef(0), scope = ownerId + ':' + kind + ':' + filter, currentScope = useRef(scope);
  useLayoutEffect(() => { currentScope.current = scope; }, [scope]);
  const invalidate = useCallback(() => { ++sequence.current; }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; invalidate(); }; }, [invalidate]);
  const load = useCallback(async (afterId?: string) => {
    const epoch = ++sequence.current, expectedScope = ownerId + ':' + kind + ':' + filter; setLoading(true); setError('');
    if (!afterId) { setItems([]); setNext(undefined); setHasMore(false); setSelection(''); setFolded(0); }
    try { const states = statesFor(filter), result = await api?.workspace?.({ type: 'jobs.page', ownerId, kind, ...(states ? { states } : {}), ...(afterId ? { afterId } : {}), limit: 20 });
      if (!alive.current || sequence.current !== epoch || currentScope.current !== expectedScope) return;
      if (!result?.ok || !result.jobPage) throw new Error(result?.error || '故障处理记录暂不可读取。'); const page = companionJobPageSchema.parse(result.jobPage);
      if (page.items.length > 20 || page.items.some(item => item.ownerId !== ownerId || item.kind !== kind || states && !states.includes(item.state))
        || page.hasMore && (!page.nextId || page.nextId === afterId)) throw new Error('作业分页的归属、状态或继续位置不一致。');
      setItems(previous => { const combined = afterId ? [...previous] : [];
        for (const item of page.items) { const index = combined.findIndex(old => old.id === item.id); if (index < 0) combined.push(item); else combined[index] = item; }
        return combined.slice(-60);
      });
      if (afterId) setFolded(value => value + Math.max(0, items.length + page.items.filter(item => !items.some(old => old.id === item.id)).length - 60));
      setNext(page.nextId); setHasMore(page.hasMore);
    } catch (cause) { if (alive.current && sequence.current === epoch && currentScope.current === expectedScope) { setError(cause instanceof Error ? cause.message : '故障分页尚未核实。'); setHasMore(false); } }
    finally { if (alive.current && sequence.current === epoch && currentScope.current === expectedScope) setLoading(false); }
  }, [api, ownerId, kind, filter, items]);
  const latestLoad = useRef(load); useLayoutEffect(() => { latestLoad.current = load; }, [load]);
  useEffect(() => { void latestLoad.current(); return invalidate; }, [scope, invalidate]);
  const selected = items.find(item => item.id === selection) ?? items[0];
  const update = (value: CompanionJobDisposition) => setItems(previous => previous.flatMap(item => item.id !== value.id ? [item] : statesFor(filter)?.includes(value.state) === false ? [] : [value]));
  return <section className="companion-job-failure-browser" aria-label="故障作业管理"><header><div><h3>故障作业管理</h3><p>按当前伙伴和所选类型分页核对。搁置保留事件，放弃需要明确确认。</p></div>{onClose && <button type="button" onClick={onClose}>返回处理总览</button>}</header>
    <div className="companion-job-browser-filters"><label>处理类型<select aria-label="故障作业类型" value={kind} onChange={event => setKind(event.target.value as CompanionJobKind)}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>状态<select aria-label="故障状态筛选" value={filter} onChange={event => setFilter(event.target.value as Filter)}>{Object.entries(filters).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button type="button" disabled={loading} onClick={() => void load()}>从头核对</button></div>
    {error && <p role="alert">{error}</p>}{loading && !items.length && <p role="status">正在核对所选类型…</p>}
    {!loading && !error && !items.length ? <p className="cognition-empty">当前伙伴的这一类型和状态暂无已登记作业。</p> : <div className="companion-job-browser-body"><ol aria-label="分页故障作业">{items.map(item => <li key={item.id}><button type="button" aria-pressed={selected?.id === item.id} onClick={() => setSelection(item.id)}><span>{companionJobStateLabels[item.state]}</span><strong>{kinds[item.kind]}</strong>{item.lastErrorAt&&<small>最近失败 {new Date(item.lastErrorAt).toLocaleString('zh-CN',{hour12:false})}</small>}{item.lastError && <p>{item.lastError.length > 160 ? item.lastError.slice(0, 160) + '…' : item.lastError}</p>}<small>{item.memoryId && item.contentRevision ? `记忆修订 r${item.contentRevision} · 选中后可核对` : item.sourceMessageId?'有原始消息依据 · 选中后可核对':'处理依据需在详情核对'}</small><small>累计失败 {item.failureCount} 次 · 本轮 {item.cycleFailureCount} 次</small></button></li>)}</ol>
      {selected && <article aria-label="所选故障详情"><h4>{kinds[selected.kind]} · {companionJobStateLabels[selected.state]}</h4><CompanionJobControls ownerId={ownerId} kind={selected.kind} id={selected.id} api={api} onDisposition={update} /></article>}</div>}
    <footer><p>当前保留 {items.length} 条已读取记录。{folded > 0 && `较早读取的 ${folded} 条列表已收起，可从头重新核对。`}</p>{hasMore && <button type="button" disabled={loading} onClick={() => void load(next)}>{loading ? '正在加载…' : '加载更多故障记录'}</button>}</footer>
  </section>;
}
