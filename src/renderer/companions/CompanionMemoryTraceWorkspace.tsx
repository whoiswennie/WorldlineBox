import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryTrace, CompanionMemoryTraceEntry, CompanionMemoryTracePage, CompanionMemoryTraceRecord } from '../../shared/companion-memory-trace';
import type { ScheduleRequest } from './companion-schedules';
import { createCoalescedRefresh } from './coalesced-refresh';
import { Avatar } from './CompanionVisuals';
import { Icon, type IconName } from '../Icons';
import './companion-memory-trace.css';

type Kind = CompanionMemoryTraceEntry['kind'];
type Stage = CompanionMemoryTrace['stages'][number]['kind'];
type Root = { kind: Kind; id: string };
type Props = { companion: Companion; request: ScheduleRequest; api?: WorldlineBoxCompanionsApi; active?: boolean;
  onClose(): void; onLearningSources?(): void; onProcessing?(): void; onOpenNote?(noteId: string): void };
const filters = [['all', '全部足迹'], ['learning', '资料阅读'], ['journal', '日记与认识'], ['sleep', '睡眠整理'], ['dream', '梦境']] as const;
const stages: Array<[Stage, string, IconName]> = [['reading', '来源与阅读', 'file-text'], ['capture', '来源整理', 'edit'], ['memory', '相关记忆', 'heart'],
  ['index', '索引投递', 'layers'], ['tags', '标签', 'tag'], ['sleep', '睡眠回顾', 'clock'], ['dream', '梦境', 'sparkles']];
const titles: Record<Kind, string> = { learning: '资料阅读', journal: '日记与认识', sleep: '睡眠整理', dream: '梦境' };
const icons: Record<Kind, IconName> = { learning: 'file-text', journal: 'edit', sleep: 'clock', dream: 'sparkles' };
const statuses: Record<string, string> = { read: '已阅读', withdrawn: '已撤回', forgotten: '已遗忘', invalid: '来源失效', indexed: '已投递', queued: '待收录',
  pending: '等待中', running: '已领取', failed: '需处理', done: '已结束', completed: '已结束', waiting_model: '等待模型', stale: '旧版本', cancelled: '已停止' };
const relations: Record<CompanionMemoryTraceRecord['relation'], string> = { root: '原始凭证', exact_source: '直接引用', shared_source: '共同来源关联',
  dependency: '引用记忆版本', reviewed_version: '已回顾此版本', bound_version: '曾选入此版本', delivery: '投递凭证', batch_output: '本批保存／确认' };
function dateLabel(value?: string) { if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录'; return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
function dateBound(value: string, end = false) { const date = new Date(value + (end ? 'T23:59:59.999' : 'T00:00:00')); return value && Number.isFinite(date.getTime()) ? date.toISOString() : undefined; }
function initialStage(kind: Kind): Stage { return kind === 'learning' ? 'reading' : kind === 'sleep' ? 'sleep' : kind === 'dream' ? 'dream' : 'memory'; }
function AssetEvidence({ asset }: { asset: NonNullable<CompanionMemoryTraceEntry['asset']> }) {
  return <details className="memory-trace-asset-evidence"><summary>资料版本与读取片段</summary><dl><div><dt>资产库</dt><dd>{asset.libraryId}</dd></div><div><dt>资料</dt><dd>{asset.assetId}</dd></div><div><dt>读取版本</dt><dd>{asset.assetRevisionId}</dd></div><div><dt>读取范围</dt><dd>偏移 {asset.offset.toLocaleString()} · {asset.characters.toLocaleString()} 字符</dd></div><div><dt>内容校验</dt><dd>{asset.contentHash}</dd></div></dl></details>;
}
function RecordEvidence({ record }: { record: CompanionMemoryTraceRecord }) {
  return <details><summary>来源凭证</summary><code>{record.id}</code>{record.sourceMessageId && <code>来源：{record.sourceMessageId}</code>}{record.captureBatchId && <code>整理批次：{record.captureBatchId}</code>}{record.outputCount !== undefined && <code>本批保存／确认 {record.outputCount} 项结果</code>}{record.outputs?.map(output => <code key={output.noteId}>记忆：{output.noteId} · 版本 {output.version}</code>)}{record.worldJobId && <code>睡眠作业：{record.worldJobId}</code>}{record.sleepEpisodeId && <code>睡眠阶段：{record.sleepEpisodeId}</code>}{record.asset && <AssetEvidence asset={record.asset} />}</details>;
}

/** A bounded, owner-scoped evidence journal. It does not infer missing causal links. */
export function CompanionMemoryTraceWorkspace(props: Props) {
  return <CompanionMemoryTraceBody key={props.companion.id} {...props} />;
}
function CompanionMemoryTraceBody({ companion, request, api, active = true, onClose, onLearningSources, onProcessing, onOpenNote }: Props) {
  const [kind, setKind] = useState<(typeof filters)[number][0]>('all'), [queryDraft, setQueryDraft] = useState(''), [query, setQuery] = useState('');
  const [dates, setDates] = useState({ from: '', to: '' }), [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Root>(), [stage, setStage] = useState<Stage>('reading'), [stageCursors, setStageCursors] = useState<string[]>([]);
  const [page, setPage] = useState<CompanionMemoryTracePage>(), [trace, setTrace] = useState<CompanionMemoryTrace>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [wasActive, setWasActive] = useState(active);
  const alive = useRef(false), serial = useRef(0), scope = useRef('');
  const cursor = cursors.at(-1), stageCursor = stageCursors.at(-1);
  const key = JSON.stringify([companion.id, kind, query, dates, cursor, selected, stage, stageCursor]);
  useLayoutEffect(() => { scope.current = key; }, [key]);
  // Reconcile visibility before committing a cached story; preserve only its navigation state.
  if (wasActive !== active) { setWasActive(active); setPage(undefined); setTrace(undefined); }
  const stopReading = useCallback(() => { alive.current = false; serial.current++; }, []);
  const visiblePage = page?.companionId === companion.id ? page : undefined;
  const visibleTrace = trace?.companionId === companion.id && trace.root.id === selected?.id && trace.root.kind === selected.kind ? trace : undefined;
  const refresh = useCallback(async () => {
    if (!active || scope.current !== key) return;
    const epoch = ++serial.current; setLoading(true);
    try {
      const from = dateBound(dates.from), to = dateBound(dates.to, true);
      if (from && to && from > to) throw new Error('开始日期不能晚于结束日期。');
      const result = selected ? await request({ type: 'memory.trace.inspect', companionId: companion.id, ...selected, stage, cursor: stageCursor, limit: 10 })
        : await request({ type: 'memory.trace.list', companionId: companion.id, kind, query, from, to, cursor, limit: 20 });
      if (!alive.current || epoch !== serial.current || scope.current !== key) return;
      if (!result?.ok) throw new Error(result?.error || '成长记录暂时无法读取。');
      if (selected) {
        if (result.memoryTrace?.companionId !== companion.id || result.memoryTrace.root.id !== selected.id || result.memoryTrace.root.kind !== selected.kind) throw new Error('这条记录的归属已变化，请返回列表核对。');
        setTrace(result.memoryTrace);
      } else {
        if (result.memoryTracePage?.companionId !== companion.id) throw new Error('成长记录的归属未能核实。');
        setPage(result.memoryTracePage);
      }
      setError('');
    } catch (cause) { if (alive.current && epoch === serial.current && scope.current === key) { setTrace(undefined); setPage(undefined); setError(cause instanceof Error ? cause.message : '成长记录暂时无法读取。'); } }
    finally { if (alive.current && epoch === serial.current && scope.current === key) setLoading(false); }
  }, [active, key, companion.id, cursor, dates, kind, query, request, selected, stage, stageCursor]);
  useEffect(() => {
    if (!active) return; alive.current = true;
    const reads = createCoalescedRefresh(refresh, undefined, 2000); void reads.trigger();
    const unsubscribe = api?.onChanged(() => reads.trigger());
    return () => { stopReading(); reads.dispose(); unsubscribe?.(); };
  }, [active, api, refresh, stopReading]);
  useEffect(() => { if (!active || selected || visiblePage?.index.state !== 'indexing') return; const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, [active, selected, visiblePage?.index.state, refresh]);
  const open = (root: Root) => { setTrace(undefined); setStage(initialStage(root.kind)); setStageCursors([]); setSelected({ kind: root.kind, id: root.id }); setError(''); };
  const currentStage = visibleTrace?.stages.find(item => item.kind === stage);
  const resetPage = () => { setCursors([]); setPage(undefined); setError(''); };
  return <section className="companions-memory-trace" aria-label="伙伴成长足迹" hidden={!active}>
    <header className="memory-trace-header"><div><Avatar companion={companion} /><span><small>{companion.name} · 每一步，都有来处</small><h2>成长足迹</h2></span></div><div><button type="button" aria-label="刷新成长足迹" onClick={() => void refresh()}><Icon name="refresh" size={15} /></button><button type="button" aria-label="关闭成长足迹" onClick={onClose}><Icon name="close" size={18} /></button></div></header>
    <div className="memory-trace-scroll"><div className="memory-trace-paper">
      <div className="memory-trace-actions">{selected ? <button type="button" onClick={() => { setSelected(undefined); setTrace(undefined); setStageCursors([]); setError(''); }}><Icon name="chevron-left" size={14} />返回足迹</button> : <span>阅读、记忆与睡眠中的整理</span>}<div>{onLearningSources && <button type="button" onClick={onLearningSources}><Icon name="file-text" size={14} />学习来源</button>}{onProcessing && <button type="button" onClick={onProcessing}><Icon name="activity" size={14} />处理进度</button>}</div></div>
      {!selected && <><form className="memory-trace-search" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); resetPage(); }}><Icon name="search" size={16} /><input aria-label="搜索成长足迹" placeholder="查找资料名、记录标题或编号" value={queryDraft} maxLength={500} onChange={event => setQueryDraft(event.target.value)} /><button type="submit">查找</button><details><summary aria-label="按记录日期筛选"><Icon name="clock" size={16} /></summary><div><label>记录日期起<input type="date" aria-label="成长足迹开始日期" value={dates.from} onChange={event => { setDates(value => ({ ...value, from: event.target.value })); resetPage(); }} /></label><label>记录日期止<input type="date" aria-label="成长足迹结束日期" value={dates.to} onChange={event => { setDates(value => ({ ...value, to: event.target.value })); resetPage(); }} /></label><small>现实中的记录时间</small></div></details></form>
        <div className="memory-trace-filters" role="tablist" aria-label="成长足迹类型">{filters.map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={kind === value} onClick={() => { setKind(value); resetPage(); }}>{label}</button>)}</div>
        {visiblePage?.index.state === 'indexing' && <p className="memory-trace-notice" role="status"><Icon name="clock" size={14} />历史目录正在准备，当前结果尚未覆盖全部记录。已建立 {visiblePage.index.indexed.toLocaleString('zh-CN')} 项目录。</p>}</>}
      {error && <p className="memory-trace-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>重新读取</button></p>}
      {selected ? visibleTrace ? <article className="memory-trace-story" aria-label="成长经历链"><div className="memory-trace-story-heading"><span>{titles[visibleTrace.root.kind]}<small>{statuses[visibleTrace.root.status] ?? '已记录'}</small></span><h3>{visibleTrace.root.redacted ? '已撤回的' + titles[visibleTrace.root.kind] + '记录' : visibleTrace.root.title}</h3><time dateTime={visibleTrace.root.at}>{dateLabel(visibleTrace.root.at)}</time>{visibleTrace.root.asset && !visibleTrace.root.redacted && <AssetEvidence asset={visibleTrace.root.asset} />}{visibleTrace.root.redacted && <p className="memory-trace-notice">来源已撤回或记忆已失效，保留状态凭证，不展示旧正文。</p>}</div>
          <div className="memory-trace-stages" role="tablist" aria-label="经历链环节">{stages.map(([value, label, icon]) => <button type="button" role="tab" key={value} aria-selected={stage === value} onClick={() => { setStage(value); setStageCursors([]); setTrace(undefined); }}><Icon name={icon} size={14} />{label}</button>)}</div>
          {currentStage && <section aria-label={currentStage.label} className="memory-trace-stage"><h4>{currentStage.label}</h4>{!currentStage.records.length ? <p className="memory-trace-empty">尚无这个环节的可追溯记录。</p> : <ol aria-label="环节凭证">{currentStage.records.map(record => <li key={record.kind + ':' + record.id} data-trace-record={record.id}><span className={'memory-trace-dot' + (record.confidence === 'shared_source' ? ' is-related' : '')} /><div><span className="memory-trace-record-meta">{relations[record.relation]}<small>{statuses[record.status] ?? '已记录'}</small></span><h5>{visibleTrace.root.redacted ? '内容已撤回' : record.title}</h5><p>{visibleTrace.root.redacted ? '仅保留该环节的状态凭证，旧内容不再展示。' : record.detail}</p><footer><time dateTime={record.at}>{dateLabel(record.at)}</time>{record.version && <span>版本 {record.version}</span>}</footer><div className="memory-trace-record-actions">{record.noteId && onOpenNote && !visibleTrace.root.redacted && <button type="button" onClick={() => onOpenNote(record.noteId!)}>查看这篇记忆<Icon name="arrow-up-right" size={12} /></button>}{record.noteId && !visibleTrace.root.redacted && record.noteId !== visibleTrace.root.noteId && <button type="button" onClick={() => open({ kind: record.kind === 'dream' ? 'dream' : 'journal', id: record.noteId! })}>继续追溯<Icon name="chevron-right" size={12} /></button>}<RecordEvidence record={record} /></div></div></li>)}</ol>}
            <nav className="memory-trace-pagination" aria-label="经历链环节分页"><button type="button" disabled={!stageCursors.length || loading} onClick={() => { setTrace(undefined); setStageCursors(value => value.slice(0, -1)); }}>上一页凭证</button><span>第 {stageCursors.length + 1} 页</span><button type="button" disabled={!currentStage.nextCursor || loading} onClick={() => { const next = currentStage.nextCursor; if (next) { setTrace(undefined); setStageCursors(value => [...value, next]); } }}>下一页凭证</button></nav></section>}
          {!!visibleTrace.limitations.length && <details className="memory-trace-limitations"><summary><Icon name="info" size={13} />这份经历链的记录范围</summary>{visibleTrace.limitations.map((line, index) => <p key={index}>{line}</p>)}</details>}
        </article> : !error && <p className="memory-trace-empty" role="status">正在核对真实凭证…</p>
        : <><ol className="memory-trace-feed" aria-label="成长足迹记录">{visiblePage?.entries.map(entry => <li key={entry.kind + ':' + entry.id} data-trace-entry={entry.id}><span className={'memory-trace-entry-icon is-' + entry.kind}><Icon name={icons[entry.kind]} size={18} /></span><button type="button" onClick={() => open(entry)}><span className="memory-trace-entry-meta">{titles[entry.kind]}<time dateTime={entry.at}>{dateLabel(entry.at)}</time></span><h3>{entry.redacted ? '已撤回的' + titles[entry.kind] + '记录' : entry.title}</h3><span className="memory-trace-entry-footer">{statuses[entry.status] ?? '已记录'}{entry.redacted ? ' · 正文已撤回' : entry.version ? ` · 版本 ${entry.version}` : ''}<span>查看经历链<Icon name="chevron-right" size={13} /></span></span></button></li>)}</ol>{!visiblePage?.entries.length && !error && <p className="memory-trace-empty" role="status">{loading ? '正在整理足迹目录…' : query || dates.from || dates.to ? '没有找到匹配的记录，试试其他条件。' : '新的阅读、日记或睡眠整理发生后，会在这里留下真实记录。'}</p>}
          <nav className="memory-trace-pagination" aria-label="成长足迹分页"><button type="button" disabled={!cursors.length || loading} onClick={() => { setPage(undefined); setCursors(value => value.slice(0, -1)); }}>上一页</button><span>第 {cursors.length + 1} 页 · 每页最多20条</span><button type="button" disabled={!visiblePage?.nextCursor || loading} onClick={() => { const next = visiblePage?.nextCursor; if (next) { setPage(undefined); setCursors(value => [...value, next]); } }}>下一页</button></nav></>}
    </div></div>
  </section>;
}
