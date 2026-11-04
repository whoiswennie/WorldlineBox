import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BotCompanion, WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { BotMemoryActivity, BotMemoryCatalog, BotMemoryCatalogItem, BotMemoryFullNote, BotMemoryRecallMode, BotMemoryRecallReport, BotMemoryWorkspaceRequest } from '../../shared/companion-bot-memory';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotTextField } from './BotTextField';
import { BotMemoryMaintenance } from './BotMemoryMaintenance';
import { BotMemoryRecallDiagnostics, memoryRecallDuration } from './BotMemoryRecallDiagnostics';
import './bot-memory.css';

const labels = {
  'zh-CN': { title: '记忆工作台', workspace: '记忆', archive: '日记', recall: '召回试查', maintenance: '整理与梦境', close: '关闭记忆工作台', owner: '伙伴', scope: '当前聊天的可用记忆',
    search: '筛选日记', searchHint: '搜索日记内容', allTags: '全部标签', tags: '标签', filter: '筛选', loading: '正在读取…', retry: '重试', refresh: '重新读取', empty: '还没有匹配的日记', emptyHint: '换个关键词或标签，再看看。',
    readHint: '选一篇日记，看看记住了什么', readSub: '全文按需读取；选择多篇可以一起整理。', previous: '上一页', next: '下一页', page: '页', total: '篇日记', selected: '已选', organize: '整理选中日记', clear: '清空选择', select: '选择日记',
    edit: '编辑日记', forget: '忘记这条记忆', forgetConfirm: '确认忘记', forgetHint: '确认后撤回这条记忆及相关来源的使用。', cancel: '取消', save: '保存修改', content: '日记正文', editTags: '标签，用逗号分隔', newNote: '新日记', create: '保存日记', created: '新日记已保存，索引已确认', createHint: '写下要保留的事实、约定或想法。',
    saved: '修改已保存，索引已确认', organized: '新日记已可召回，原记录已归档', forgotten: '这条记忆已撤回', saving: '正在核实结果…', indexed: '可召回', pending: '索引处理中', failed: '索引失败', unknown: '结果待核实', partial: '部分完成', writing: '写入中', tagsInvalid: '最多填写12个标签，每个标签最多64个字符。', archived: '已归档', actions: '更多操作', editShort: '编辑',
    mergeTitle: '把这些记忆整理在一起', mergeHint: '阅读原记录后填写整理正文。保留时间、人物、不同观点与来源；系统不会自动生成摘要。', mergeSubmit: '保存并归档原记录', mergePlaceholder: '写下整理后的完整日记…', max: '最多选择16篇日记',
    query: '想回想什么？', queryHint: '例如：上次说到的周末计划后来改成了什么？', historyQueryHint: '输入人名、项目名，或原话中的具体关键词', passive: '被动召回', semantic: '语义查找', history: '原话关键词', run: '开始试查', running: '正在查询 VCP…',
    passiveHint: '按这句话实际运行本轮自动记忆准备。', semanticHint: '主动语义检索长期记忆。', historyHint: '使用具体关键词查找原始聊天。', result: '本次召回', noHits: '这次没有返回匹配记录', noHitsHint: '这只表示本次查询没有命中。',
    unprovided: '未提供', duration: '总耗时', stages: '阶段耗时', stageHint: '阶段可能嵌套，不能相加为总耗时。', recent: '最近5次试查', noRecent: '还没有试查记录', source: '来源', date: '时间', score: '原始评分', scores: '其他原始评分', evidence: '本轮证据', coverage: '覆盖信息', raw: '原始返回', rank: '返回顺序',
    error: '操作未完成，请重试。', conflict: '这篇日记已发生变化。请重新读取最新内容后再编辑。', receipt: '未取得完整的完成回执，请刷新核实后继续。', noCompanion: '这个聊天还没有可查看的伙伴。',
  },
  en: { title: 'Memory workspace', workspace: 'Memory', archive: 'Journal', recall: 'Try recall', maintenance: 'Organization & dreams', close: 'Close memory workspace', owner: 'Companion', scope: 'Memories available to this chat',
    search: 'Filter notes', searchHint: 'Search journal content', allTags: 'All tags', tags: 'Tags', filter: 'Filter', loading: 'Loading…', retry: 'Retry', refresh: 'Reload note', empty: 'No matching notes yet', emptyHint: 'Try another keyword or tag.',
    readHint: 'Choose a note to read', readSub: 'Full notes load on demand. Select several to organize them.', previous: 'Previous', next: 'Next', page: 'Page', total: 'notes', selected: 'Selected', organize: 'Organize selected notes', clear: 'Clear selection', select: 'Select note',
    edit: 'Edit note', forget: 'Forget this memory', forgetConfirm: 'Confirm forgetting', forgetHint: 'Withdraw this memory and the use of its related sources.', cancel: 'Cancel', save: 'Save changes', content: 'Note content', editTags: 'Tags, separated by commas', newNote: 'New note', create: 'Save note', created: 'New note saved and indexing confirmed', createHint: 'Write facts, plans, or thoughts you want to keep.',
    saved: 'Changes saved and indexing confirmed', organized: 'New note indexed; originals archived', forgotten: 'Memory withdrawn', saving: 'Verifying the result…', indexed: 'Ready for recall', pending: 'Indexing', failed: 'Indexing failed', unknown: 'Outcome unconfirmed', partial: 'Partially completed', writing: 'Writing', tagsInvalid: 'Use up to 12 tags, with up to 64 characters each.', archived: 'Archived', actions: 'More actions', editShort: 'Edit',
    mergeTitle: 'Bring these memories together', mergeHint: 'Read the originals, then write the organized note. Keep dates, people, differing views, and sources. No summary is generated automatically.', mergeSubmit: 'Save and archive originals', mergePlaceholder: 'Write the complete organized note…', max: 'Select up to 16 notes',
    query: 'What would you like to recall?', queryHint: 'For example: What did we finally decide for the weekend?', historyQueryHint: 'Enter a person, project, or specific words from the original message', passive: 'Passive recall', semantic: 'Semantic search', history: 'History keywords', run: 'Try recall', running: 'Querying VCP…',
    passiveHint: 'Run actual automatic memory preparation for this input.', semanticHint: 'Actively search long-term memory by meaning.', historyHint: 'Use specific keywords to find original messages.', result: 'Recall results', noHits: 'No matching records returned', noHitsHint: 'This applies only to this query.',
    unprovided: 'Not provided', duration: 'Total duration', stages: 'Stage durations', stageHint: 'Stages may overlap or nest; their durations must not be added.', recent: 'Last 5 recall queries', noRecent: 'No saved recall queries yet', source: 'Source', date: 'Date', score: 'Original score', scores: 'Other original scores', evidence: 'Evidence', coverage: 'Coverage', raw: 'Original response', rank: 'Returned order',
    error: 'The operation did not complete. Try again.', conflict: 'This note changed. Reload the latest content before editing.', receipt: 'A complete receipt was not returned. Refresh to verify before continuing.', noCompanion: 'There is no companion in this chat yet.',
  },
};
type Locale = keyof typeof labels;
type Words = typeof labels[Locale];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tagsOf = (value: string) => [...new Set(value.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
const printable = (value: unknown, missing: string) => value === undefined || value === null ? missing : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const checksumValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
function stamp(value: string | undefined, locale: Locale, missing: string) {
  if (!value) return missing;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function stateLabel(value: string, t: Words) { return value === 'indexed' ? t.indexed : value === 'pending' ? t.pending : value === 'failed' ? t.failed : value === 'archived' ? t.archived : value === 'unknown' ? t.unknown : value === 'partial' ? t.partial : value === 'writing' ? t.writing : value || t.unprovided; }
function failure(error: unknown, t: Words) {
  const value = error as { message?: string; code?: string };
  return /CONFLICT|CHECKSUM|STALE|CAS/i.test(`${value.code ?? ''} ${value.message ?? ''}`) ? t.conflict : value.message || t.error;
}
function visibleTabStop(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
  if (element.hasAttribute('tabindex') && element.tabIndex < 0) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hidden || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true') return false;
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
      const summary = [...ancestor.children].find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(element)) return false;
    }
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}
/** Wide, audience-scoped memory management surface. A keyed body retires every request on a scope change. */
export function BotMemoryWorkspace({ api, conversationId, companions, locale, title, onClose }: {
  api: WorldlineBoxBotApi; conversationId: string; companions: readonly BotCompanion[]; locale: Locale; title: string; onClose(): void;
}) {
  const t = labels[locale], [owner, setOwner] = useState(companions[0]?.id ?? ''), [tab, setTab] = useState<'archive' | 'recall' | 'maintenance'>('archive'), container = useRef<HTMLElement>(null);
  const companion = companions.find(item => item.id === owner) ?? companions[0];
  useEffect(() => { const previous = document.activeElement; container.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(visibleTabStop);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="bot-memory-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="bot-memory-workspace" ref={container} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t.title} onKeyDown={keyboard}>
      <header className="bot-memory-heading">
        <div className="bot-memory-identity" title={title}><BotAvatar companion={companion} /><strong>{companion?.name}</strong><span>·</span><h2>{t.workspace}</h2></div>
        <nav className="bot-memory-tabs" aria-label={t.title}>{(['archive', 'recall', 'maintenance'] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{t[value]}</button>)}</nav>
        <div className="bot-memory-heading-tools">{companions.length > 1 && <select aria-label={t.owner} value={companion?.id ?? ''} onChange={event => setOwner(event.target.value)}>{companions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
          <button type="button" className="bot-memory-close" aria-label={t.close} onClick={onClose}>×</button></div>
      </header>
      {companion ? <MemoryBody key={JSON.stringify([conversationId, companion.id])} api={api} conversationId={conversationId} companion={companion} locale={locale} tab={tab} /> : <p className="bot-memory-empty">{t.noCompanion}</p>}
    </section>
  </div>;
}
function MemoryBody({ api, conversationId, companion, locale, tab }: { api: WorldlineBoxBotApi; conversationId: string; companion: BotCompanion; locale: Locale; tab: 'archive' | 'recall' | 'maintenance' }) {
  const t = labels[locale];
  const [catalog, setCatalog] = useState<BotMemoryCatalog>({ items: [], tags: [] }), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [tag, setTag] = useState('');
  const [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<Record<string, BotMemoryCatalogItem>>({}), [note, setNote] = useState<BotMemoryFullNote>(), [noteLoading, setNoteLoading] = useState(false), [activeId, setActiveId] = useState('');
  const [editing, setEditing] = useState(false), [organizing, setOrganizing] = useState(false), [creating, setCreating] = useState(false), [confirmForget, setConfirmForget] = useState(false), [content, setContent] = useState(''), [tags, setTags] = useState(''), [mutating, setMutating] = useState(false);
  const alive = useRef(true), listRevision = useRef(0), noteRevision = useRef(0), mutationLock = useRef(false), createRequestId = useRef<string | undefined>(undefined);
  const automaticRefreshes = useRef(0), catalogInFlight = useRef(false);
  const retireRequests = useCallback(() => { alive.current = false; ++listRevision.current; ++noteRevision.current; }, []);
  useEffect(() => { alive.current = true; return retireRequests; }, [retireRequests]);
  const call = useCallback(async (input: BotMemoryWorkspaceRequest) => {
    const result = await api.request(input);
    if (!result.ok) throw Object.assign(new Error(result.error || t.error), { code: record(result).code });
    return result.memory;
  }, [api, t]);
  const scope = { conversationId, companionId: companion.id };
  const load = useCallback(async (quiet = false) => {
    if (quiet && catalogInFlight.current) return;
    const revision = ++listRevision.current; catalogInFlight.current = true;
    if (!quiet) { automaticRefreshes.current = 0; setLoading(true); setError(''); }
    try {
      const raw = record(await call({ type: 'memory.catalog', conversationId, companionId: companion.id, query: query || undefined, tag: tag || undefined, cursor, limit: 24 }));
      if (!Array.isArray(raw.items) || !Array.isArray(raw.tags)) throw new Error(t.receipt);
      if (alive.current && revision === listRevision.current) setCatalog({ ...raw, items: raw.items.slice(0, 24) } as unknown as BotMemoryCatalog);
    } catch (error) { if (alive.current && revision === listRevision.current && !quiet) { setCatalog({ items: [], tags: [] }); setError(failure(error, t)); } }
    finally { if (revision === listRevision.current) { catalogInFlight.current = false; if (alive.current && !quiet) setLoading(false); } }
  }, [call, conversationId, companion.id, query, tag, cursor, t]);
  // IPC synchronization intentionally exposes pending state before the request;
  // results settle asynchronously and are fenced by the request revision.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- start external catalog synchronization with its loading indicator
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const activity = catalog.activity;
    if (tab !== 'archive' || !activity || !(activity.capture.queued + activity.capture.running + activity.originals.pending) || automaticRefreshes.current >= 12) return;
    const timer = setTimeout(() => {
      if (!alive.current || mutationLock.current) return;
      automaticRefreshes.current++; void load(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, [catalog, load, tab]);
  const read = async (id: string) => {
    const revision = ++noteRevision.current; setActiveId(id); setNote(undefined); setNoteLoading(true); setError(''); setEditing(false); setOrganizing(false); setCreating(false); createRequestId.current = undefined; setConfirmForget(false);
    try {
      const raw = record(await call({ type: 'memory.note', ...scope, id }));
      if (raw.id !== id || typeof raw.content !== 'string' || !checksumValid(raw.checksum)) throw new Error(t.receipt);
      if (alive.current && revision === noteRevision.current) { setNote(raw as unknown as BotMemoryFullNote); setContent(raw.content); setTags(Array.isArray(raw.tags) ? raw.tags.join(', ') : ''); }
    } catch (error) { if (alive.current && revision === noteRevision.current) setError(failure(error, t)); }
    finally { if (alive.current && revision === noteRevision.current) setNoteLoading(false); }
  };
  const mutate = async (kind: 'create' | 'update' | 'organize' | 'forget') => {
    if (mutationLock.current || !['create', 'organize'].includes(kind) && !note || kind !== 'forget' && !content.trim()) return;
    const rawTags = [...new Set(tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))];
    if (kind !== 'forget' && (rawTags.length > 12 || rawTags.some(tag => Array.from(tag).length > 64))) { setError(t.tagsInvalid); return; }
    mutationLock.current = true; setMutating(true); setError(''); setNotice('');
    const sources = Object.values(selected).map(item => ({ id: item.id, expectedChecksum: item.checksum }));
    try {
      const input: BotMemoryWorkspaceRequest = kind === 'create' ? { type: 'memory.remember', ...scope, content, tags: tagsOf(tags), requestId: createRequestId.current ??= crypto.randomUUID() }
        : kind === 'forget' ? { type: 'memory.forget', ...scope, id: note!.id }
        : kind === 'update' ? { type: 'memory.update', ...scope, id: note!.id, expectedChecksum: note!.checksum, content, tags: tagsOf(tags) }
          : { type: 'memory.organize', ...scope, sources, content, tags: tagsOf(tags) };
      const receipt = record(await call(input));
      const created = Array.isArray(receipt.receipts) ? receipt.receipts.map(record) : [];
      if (kind === 'create' ? receipt.withdrawn === true || !created.length || created.some(item => item.state !== 'indexed' || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/i.test(item.id) || !checksumValid(item.checksum))
        : kind === 'forget' ? receipt.forgotten !== true || receipt.id !== note!.id
        : typeof receipt.id !== 'string' || !checksumValid(receipt.checksum) || receipt.state !== 'indexed'
          || kind === 'update' && receipt.id !== note!.id || kind === 'organize' && (!Array.isArray(receipt.archived) || !sources.every(source => (receipt.archived as unknown[]).includes(source.id)))) throw new Error(t.receipt);
      if (!alive.current) return;
      setNotice(kind === 'create' ? t.created : kind === 'forget' ? t.forgotten : kind === 'update' ? t.saved : t.organized); setEditing(false); setOrganizing(false); setCreating(false); setConfirmForget(false);
      if (kind === 'forget') { setNote(undefined); setActiveId(''); setSelected(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== note!.id))); }
      else { if (kind === 'organize') setSelected({}); if (kind === 'create') { setSearch(''); setQuery(''); setTag(''); setCursor(undefined); setPrevious([]); } await read(String(kind === 'create' ? created[0]!.id : receipt.id)); }
      if (alive.current) await load();
    } catch (error) { if (alive.current) setError(failure(error, t)); }
    finally { mutationLock.current = false; if (alive.current) setMutating(false); }
  };
  const selection = Object.values(selected);
  const resetPage = () => { setCursor(undefined); setPrevious([]); };
  const beginCreate = () => { ++noteRevision.current; setNoteLoading(false); setNote(undefined); setActiveId(''); setCreating(true); setOrganizing(false); setEditing(false); setConfirmForget(false); setContent(''); setTags(''); setError(''); setNotice(''); createRequestId.current = crypto.randomUUID(); };
  return <>
    {tab === 'archive' ? <div className="bot-memory-archive">
      <aside className="bot-memory-library"><form className="bot-memory-filters" onSubmit={event => { event.preventDefault(); resetPage(); setQuery(search.trim()); }}>
        <label className="bot-memory-search"><BotIcon name="search" /><input type="search" aria-label={t.search} placeholder={t.searchHint} disabled={mutating} value={search} maxLength={400} onChange={event => setSearch(event.target.value)} /><button type="submit" disabled={mutating}>{t.filter}</button></label>
        <label className="bot-memory-tag-filter"><BotIcon name="memory" /><select aria-label={t.tags} disabled={mutating} value={tag} onChange={event => { resetPage(); setTag(event.target.value); }}><option value="">{t.allTags}</option>{catalog.tags.map(item => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}</select><span>{catalog.total === undefined ? '—' : catalog.total} {t.total}</span></label>
      </form>
      {catalog.activity && <MemoryActivity activity={catalog.activity} locale={locale} onRefresh={() => void load()} disabled={loading || mutating} />}
      <div className="bot-memory-list" aria-busy={loading}>{loading ? <p className="bot-memory-empty">{t.loading}</p> : !catalog.items.length ? <div className="bot-memory-empty"><BotIcon name="memory" /><strong>{catalog.activity && !query && !tag ? locale === 'zh-CN' ? '还没有提炼出的日记' : 'No distilled notes yet' : t.empty}</strong><span>{catalog.activity && !query && !tag ? locale === 'zh-CN' ? '原话保留情况见上方，也可以通过“原话关键词”回查。' : 'See archived originals above, or search History keywords.' : t.emptyHint}</span></div>
        : catalog.items.map(item => <article key={item.id} className={`bot-memory-row${activeId === item.id ? ' is-active' : ''}`} data-memory-note={item.id}>
          <input type="checkbox" aria-label={`${t.select} ${item.content?.slice(0, 32) || item.id}`} checked={!!selected[item.id]} disabled={mutating || !['indexed', 'pending'].includes(item.indexState) || !checksumValid(item.checksum) || selection.length >= 16 && !selected[item.id]} onChange={event => {
            const checked = event.target.checked; setSelected(current => { const next = { ...current }; if (checked && Object.keys(next).length < 16) next[item.id] = item; else delete next[item.id]; return next; });
          }} />
          <button type="button" className="bot-memory-row-open" disabled={mutating} onClick={() => void read(item.id)}><strong>{item.content?.split('\n').find(line => line.trim())?.slice(0, 64) || item.id.slice(0, 12)}</strong><p>{item.content?.split('\n').slice(1).join(' ').slice(0, 150) || item.content?.slice(64, 200) || ''}</p><div className="bot-memory-row-tags">{item.tags?.slice(0, 3).map(value => <span key={value}>{value}</span>)}</div><footer><time>{stamp(item.updatedAt || item.createdAt, locale, t.unprovided)}</time><small data-state={item.indexState}>{stateLabel(item.indexState, t)}</small></footer></button>
        </article>)}</div>
      <div className="bot-memory-pagination"><button type="button" className="is-primary" aria-label={t.newNote} disabled={mutating || creating} onClick={beginCreate}><BotIcon name="plus" />{t.newNote}</button><button type="button" disabled={loading || mutating || !previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(current => current.slice(0, -1)); }}>{t.previous}</button><span>{previous.length + 1} {t.page}</span><button type="button" disabled={loading || mutating || !catalog.nextCursor} onClick={() => { setPrevious(current => [...current, cursor]); setCursor(catalog.nextCursor); }}>{t.next}</button></div>
      {!!selection.length && <div className="bot-memory-selection"><span>{t.selected} <b>{selection.length}/16</b></span><button type="button" disabled={mutating} onClick={() => setSelected({})}>{t.clear}</button><button type="button" className="is-primary" disabled={mutating} onClick={() => { ++noteRevision.current; setNoteLoading(false); setCreating(false); createRequestId.current = undefined; setOrganizing(true); setEditing(false); setConfirmForget(false); setContent(''); setTags(''); setNotice(''); }}>{t.organize}</button></div>}
      </aside>
      <section className="bot-memory-reading" aria-busy={noteLoading || mutating}>
        {error && <div className="bot-memory-alert" role="alert">{error}<button type="button" disabled={mutating} onClick={() => { if (creating) void mutate('create'); else if (activeId) void read(activeId); else void load(); }}>{activeId ? t.refresh : t.retry}</button></div>}
        {notice && <p className="bot-memory-notice" role="status">{notice}</p>}
        {noteLoading ? <div className="bot-memory-empty">{t.loading}</div> : creating ? <><header className="bot-memory-reading-heading"><h3>{t.newNote}</h3><button type="button" disabled={mutating} onClick={() => { setCreating(false); createRequestId.current = undefined; setContent(''); setTags(''); setError(''); }}>{t.cancel}</button></header><Editor content={content} tags={tags} setContent={value => { if (value !== content) createRequestId.current = undefined; setContent(value); }} setTags={value => { if (value !== tags) createRequestId.current = undefined; setTags(value); }} disabled={mutating} t={t} placeholder={t.createHint} /><button type="button" className="bot-memory-submit is-primary" disabled={mutating || !content.trim()} onClick={() => void mutate('create')}>{mutating ? t.saving : t.create}</button></>
        : organizing ? <><header className="bot-memory-reading-heading"><div><small>{selection.length} {t.total}</small><h3>{t.mergeTitle}</h3></div><button type="button" disabled={mutating} onClick={() => setOrganizing(false)}>{t.cancel}</button></header><p className="bot-memory-hint">{t.mergeHint}</p><div className="bot-memory-source-chips">{selection.map(item => <span key={item.id}>{item.content?.slice(0, 38) || item.id.slice(0, 12)}</span>)}</div><Editor content={content} tags={tags} setContent={setContent} setTags={setTags} disabled={mutating} t={t} placeholder={t.mergePlaceholder} /><button type="button" className="bot-memory-submit is-primary" disabled={mutating || !content.trim() || !selection.length} onClick={() => void mutate('organize')}>{mutating ? t.saving : t.mergeSubmit}</button></>
        : note ? <><header className="bot-memory-reading-heading">
            <div className="bot-memory-note-meta"><time>{stamp(note.updatedAt || note.createdAt, locale, t.unprovided)}</time><span data-state={note.indexState}>{stateLabel(note.indexState, t)}</span></div>
            <div className="bot-memory-note-tools"><button type="button" aria-label={t.refresh} title={t.refresh} disabled={mutating} onClick={() => void read(note.id)}><NoteIcon name="refresh" /></button>
              <button type="button" className="bot-memory-edit" aria-label={t.edit} title={t.edit} disabled={mutating || !['indexed', 'pending'].includes(note.indexState) || !checksumValid(note.checksum)} onClick={() => { setEditing(true); setConfirmForget(false); }}><NoteIcon name="edit" /><span>{t.editShort}</span></button>
              {note.indexState !== 'archived' && <details className="bot-memory-more" onBlur={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label={t.actions} title={t.actions} aria-haspopup="menu"><NoteIcon name="more" /></summary><div className="bot-memory-popover" role="menu" aria-label={t.actions}><button type="button" role="menuitem" className="is-danger" disabled={mutating} onClick={event => { setConfirmForget(true); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{t.forget}</button></div></details>}
            </div>
          </header>
          {editing ? <><Editor content={content} tags={tags} setContent={setContent} setTags={setTags} disabled={mutating} t={t} /><div className="bot-memory-actions"><button type="button" disabled={mutating} onClick={() => { setEditing(false); setContent(note.content); setTags(note.tags?.join(', ') || ''); }}>{t.cancel}</button><button type="button" className="is-primary" disabled={mutating || !content.trim()} onClick={() => void mutate('update')}>{mutating ? t.saving : t.save}</button></div></>
          : <><NoteText text={note.content} /><div className="bot-memory-note-tags">{note.tags?.map(value => <span key={value}>{value}</span>)}</div>
            {(note.sourceEventId || !!note.sourceMessageIds?.length) && <details className="bot-memory-note-sources"><summary>{t.source}{note.sourceMessageIds?.length ? ` · ${note.sourceMessageIds.length}` : ''}</summary>{note.sourceEventId && <p>{note.sourceEventId}</p>}{note.sourceMessageIds?.map(id => <p key={id}>{id}</p>)}</details>}</>}
          {confirmForget && <div className="bot-memory-confirm"><p>{t.forgetHint}</p><button type="button" disabled={mutating} onClick={() => setConfirmForget(false)}>{t.cancel}</button><button type="button" className="is-danger" disabled={mutating} onClick={() => void mutate('forget')}>{mutating ? t.saving : t.forgetConfirm}</button></div>}</>
        : <div className="bot-memory-empty bot-memory-reading-empty"><BotIcon name="memory" /><h3>{t.readHint}</h3><p>{t.readSub}</p></div>}
      </section>
    </div> : tab === 'recall' ? <RecallPanel key={JSON.stringify(scope)} call={call} scope={scope} locale={locale} /> : <BotMemoryMaintenance key={JSON.stringify(scope)} api={api} {...scope} locale={locale} />}
  </>;
}
function MemoryActivity({ activity: { originals, capture }, locale, onRefresh, disabled }: { activity: BotMemoryActivity; locale: Locale; onRefresh(): void; disabled: boolean }) {
  const zh = locale === 'zh-CN', working = capture.queued + capture.running;
  return <section className="bot-memory-activity" aria-label={zh ? '自动记忆状态' : 'Automatic memory status'}>
    <div><strong>{zh ? `已保留 ${originals.archived} 条原话` : `${originals.archived} original messages archived`}</strong><button type="button" disabled={disabled} onClick={onRefresh}>{zh ? '刷新状态' : 'Refresh status'}</button></div>
    {originals.pending > 0 && <p>{zh ? `${originals.pending} 条原话正在等待保留。` : `${originals.pending} original messages awaiting archive.`}</p>}
    {working > 0 && <p role="status">{zh ? `正在后台提炼 ${working} 段互动；不会重新发送聊天或执行任务。` : `${working} interactions being distilled in the background; chats and tasks are not replayed.`}</p>}
    {capture.failed > 0 && <p className="is-warning">{zh ? `${capture.failed} 段互动提炼未完成，原话仍可回查。` : `${capture.failed} interactions could not be distilled; archived originals remain searchable.`}</p>}
    {capture.empty > 0 && <p>{zh ? `${capture.empty} 段互动未提炼为日记；日记数量不等于原话数量。` : `${capture.empty} interactions produced no journal note; note counts differ from original message counts.`}</p>}
    {capture.unknownDone > 0 && <p>{zh ? `${capture.unknownDone} 段旧互动未记录提炼数量，不能据此判断没有记忆。` : `${capture.unknownDone} older interactions have no recorded note count; this does not mean no memory was retained.`}</p>}
    {!working && !capture.failed && !capture.empty && !capture.unknownDone && <p>{zh ? '原话与提炼后的日记分别保存，日记在下方按需读取。' : 'Original messages and distilled notes are stored separately. Browse notes below.'}</p>}
  </section>;
}
function NoteText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), first = lines.findIndex(line => line.trim());
  const heading = first < 0 ? '' : lines[first]!.replace(/^#{1,6}\s+/, '');
  const body = lines.slice(first + 1).join('\n').trim();
  return <div className="bot-memory-fulltext"><h3>{heading}</h3>{body && body.split(/\n[ \t]*\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}
function NoteIcon({ name }: { name: 'edit' | 'refresh' | 'more' }) {
  if (name === 'more') return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" /></svg>;
  const d = name === 'edit'  ? 'M15 4l5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16z' : 'M20 10a8 8 0 1 0-1 7M20 4v6h-6';
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
function Editor({ content, tags, setContent, setTags, disabled, t, placeholder }: { content: string; tags: string; setContent(value: string): void; setTags(value: string): void; disabled: boolean; t: Words; placeholder?: string }) {
  return <div className="bot-memory-editor"><BotTextField label={t.content} aria-label={t.content} value={content} onChange={event => setContent(event.target.value)} disabled={disabled} maxLength={24000} rows={10} showCount placeholder={placeholder} /><label>{t.editTags}<input aria-label={t.editTags} value={tags} maxLength={800} onChange={event => setTags(event.target.value)} disabled={disabled} /></label></div>;
}
function RecallPanel({ call, scope, locale }: { call(input: BotMemoryWorkspaceRequest): Promise<unknown>; scope: { conversationId: string; companionId: string }; locale: Locale }) {
  const t = labels[locale], [query, setQuery] = useState(''), [mode, setMode] = useState<BotMemoryRecallMode>('passive'), [result, setResult] = useState<BotMemoryRecallReport>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [records, setRecords] = useState<BotMemoryRecallReport[]>(), [recordsLoading, setRecordsLoading] = useState(false), [recordsError, setRecordsError] = useState('');
  const revision = useRef(0), lock = useRef(false), recordsRevision = useRef(0);
  useEffect(() => () => { ++revision.current; ++recordsRevision.current; }, []);
  const invalidate = () => { ++revision.current; lock.current = false; setBusy(false); setResult(undefined); setError(''); };
  const run = async () => {
    if (!query.trim() || lock.current) return;
    const current = ++revision.current; lock.current = true; setBusy(true); setError(''); setResult(undefined);
    try {
      const value = record(await call({ type: 'memory.recall', ...scope, query: query.trim(), mode }));
      if (!Array.isArray(value.hits) || !Array.isArray(value.stages) || value.mode !== mode) throw new Error(t.receipt);
      if (current === revision.current) setResult(value as unknown as BotMemoryRecallReport);
    } catch (error) { if (current === revision.current) setError(failure(error, t)); }
    finally { if (current === revision.current) { lock.current = false; setBusy(false); } }
  };
  const loadRecords = async () => {
    const current = ++recordsRevision.current; setRecordsLoading(true); setRecordsError('');
    try {
      const value = record(await call({ type: 'memory.recall.records', ...scope, limit: 5 }));
      if (!Array.isArray(value.reports)) throw new Error(t.receipt);
      if (current === recordsRevision.current) setRecords((value.reports as BotMemoryRecallReport[]).slice(0, 5));
    } catch (error) { if (current === recordsRevision.current) setRecordsError(failure(error, t)); }
    finally { if (current === recordsRevision.current) setRecordsLoading(false); }
  };
  return <section className="bot-memory-recall"><form onSubmit={event => { event.preventDefault(); void run(); }} className="bot-memory-recall-query"><BotTextField label={t.query} aria-label={t.query} placeholder={mode === 'history' ? t.historyQueryHint : t.queryHint} value={query} maxLength={4000} onChange={event => { invalidate(); setQuery(event.target.value); }} rows={2} showCount /><div className="bot-memory-recall-controls"><div>{(['passive', 'semantic', 'history'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => { invalidate(); setMode(value); }}>{t[value]}</button>)}</div><button className="is-primary" type="submit" disabled={busy || !query.trim()}>{busy ? t.running : t.run}</button></div><p>{t[`${mode}Hint`]}</p></form>
    <div className="bot-memory-recall-records"><button type="button" disabled={recordsLoading} onClick={() => void loadRecords()}><BotIcon name="history" />{recordsLoading ? t.loading : t.recent}</button>{recordsError && <span role="alert">{recordsError}</span>}{records && <div>{!records.length ? <small>{t.noRecent}</small> : records.map(item => <button type="button" key={item.requestId} onClick={() => { invalidate(); setQuery(item.query); setMode(item.mode); setResult(item); }}><time>{stamp(item.createdAt, locale, t.unprovided)}</time><span>{item.query}</span><small>{t[item.mode]}</small></button>)}</div>}</div>
    <div className="bot-memory-recall-output" aria-busy={busy}>{error && <p className="bot-memory-alert" role="alert">{error}</p>}{busy && <p className="bot-memory-empty" role="status">{t.running}</p>}
      {result && <><header className="bot-memory-result-heading"><h3>{t.result} <span>{result.hits.length}</span></h3><span>{t.duration} <b>{memoryRecallDuration(result.totalMs, locale)}</b></span></header>
        {result.notice && <p className="bot-memory-hint bot-memory-result-notice">{result.notice}</p>}
        <BotMemoryRecallDiagnostics stages={result.stages} locale={locale} />
        {!result.hits.length && <div className="bot-memory-empty"><strong>{t.noHits}</strong><p>{t.noHitsHint}</p></div>}
        <ol className="bot-memory-hits">{result.hits.map((hit, index) => <li key={index} className="bot-memory-hit"><span className="bot-memory-rank" aria-label={t.rank}>{hit.rank ?? t.unprovided}</span><article><header><span>{t.source} · {hit.source || t.unprovided}</span><time>{t.date} · {hit.date || t.unprovided}</time></header><p>{hit.text}</p><footer><span>{t.score} <b>{typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : t.unprovided}</b></span></footer>{hit.scores && <details><summary>{t.scores}</summary><dl>{Object.entries(hit.scores).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{printable(value, t.unprovided)}</dd></div>)}</dl></details>}</article></li>)}</ol>
        {result.evidence !== undefined && <details className="bot-memory-evidence"><summary>{t.evidence}</summary><pre>{result.evidence || t.unprovided}</pre></details>}<details className="bot-memory-evidence"><summary>{t.coverage}</summary><pre>{printable(result.coverage, t.unprovided)}</pre></details>{result.raw !== undefined && <details className="bot-memory-evidence"><summary>{t.raw}</summary><pre>{printable(result.raw, t.unprovided)}</pre></details>}</>}
      {!result && !busy && !error && <div className="bot-memory-empty bot-memory-recall-empty"><BotIcon name="search" /><h3>{t.query}</h3><p>{t.queryHint}</p></div>}
    </div>
  </section>;
}
