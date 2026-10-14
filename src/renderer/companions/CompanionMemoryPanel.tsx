import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionMemory, CompanionMessage, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryPage } from '../../shared/companion-memory';
import { companionTimestamp } from '../../shared/companion-time';
import { Icon } from '../Icons';

type MemoryKind = NonNullable<CompanionMemory['kind']>;
type MemoryStatus = NonNullable<CompanionMemory['status']>;
type MemoryRead = NonNullable<CompanionsResponse['memoryRead']>;
type ProcessingStatus = NonNullable<CompanionsResponse['memoryStatus']>;
export interface CompanionMemoryDraft { content: string; sourceMessageId?: string; nonce: number }
const KINDS: Record<MemoryKind, string> = { fact: '事实', preference: '偏好', agreement: '约定', event: '经历', task: '任务状态', reflection: '伙伴感想', knowledge: '知识与经验', overview: '阶段概览', hypothesis: '未决假设' };
const STATUSES: Record<MemoryStatus, string> = { active: '当前有效', superseded: '已被修订', forgotten: '已遗忘', invalid: '来源失效', conflict: '存在冲突' };
const EVIDENCE: Record<NonNullable<CompanionMemory['epistemicStatus']>, string> = { asserted: '明确表达', confirmed: '已确认', subjective: '伙伴视角', hypothesis: '尚待证实', conflict: '证据冲突', unverified: '来源待核查' };
const EVENTS: Record<NonNullable<CompanionMemory['eventStatus']>, string> = { planned: '计划中', ongoing: '进行中', completed: '已完成', cancelled: '已取消', reconsidering: '重新考虑' };
const PAGE_SIZE = 20;
function sourceContent(source: CompanionMessage): string {
  if (!source.memoryEvidenceOnly) return source.content;
  try {
    const result = JSON.parse(source.content) as Record<string, unknown>;
    const states: Record<string, string> = { succeeded: '已结束', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
    return [typeof result.title === 'string' ? result.title : '任务结果', typeof result.status === 'string' ? `执行状态：${states[result.status] ?? result.status}` : '', typeof result.result === 'string' ? result.result : '', typeof result.error === 'string' ? `错误：${result.error}` : ''].filter(Boolean).join('\n');
  } catch { return source.content; }
}

export function CompanionMemoryPanel({ companionId, conversationId, conversationKind, request, api, draft: requestedDraft, onDraftConsumed, onLocateSource, authorName }: {
  readonly companionId: string; readonly conversationId: string; readonly conversationKind: 'private' | 'group';
  readonly request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  readonly api?: WorldlineBoxCompanionsApi; readonly draft?: CompanionMemoryDraft; readonly onDraftConsumed?: () => void;
  readonly onLocateSource: (message: CompanionMessage) => void; readonly authorName: (id: string) => string;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | 'history'>('active');
  const [page, setPage] = useState<CompanionMemoryPage>();
  const [cursor, setCursor] = useState<number>();
  const [previousCursors, setPreviousCursors] = useState<(number | undefined)[]>([]);
  const [processing, setProcessing] = useState<ProcessingStatus>();
  const [detail, setDetail] = useState<MemoryRead>();
  const [detailId, setDetailId] = useState<string>();
  const [draft, setDraft] = useState(requestedDraft?.content ?? '');
  const [sourceMessageId, setSourceMessageId] = useState(requestedDraft?.sourceMessageId);
  const [editing, setEditing] = useState<CompanionMemory>();
  const [forgetting, setForgetting] = useState<CompanionMemory>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true), listEpoch = useRef(0), detailEpoch = useRef(0), statusEpoch = useRef(0);
  const selectedDetail = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    const epoch = ++listEpoch.current;
    setBusy(true);
    const result = await request({ type: 'memory.browse', companionId, conversationId, query, terms: [], tags: [], includeHistory: statusFilter !== 'active', limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), ...(kind ? { kind } : {}), ...(statusFilter === 'history' ? {} : { status: statusFilter }) });
    if (!alive.current || epoch !== listEpoch.current) return;
    setBusy(false);
    if (result?.memoryPage) { setPage(result.memoryPage); setError(''); }
    else { setPage(undefined); setError('记忆暂时无法读取，请刷新重试。'); }
  }, [request, companionId, conversationId, query, cursor, kind, statusFilter]);
  const loadStatus = useCallback(async () => {
    const epoch = ++statusEpoch.current;
    const result = await request({ type: 'memory.status', companionId, conversationId });
    if (alive.current && epoch === statusEpoch.current && result?.memoryStatus) setProcessing(result.memoryStatus);
  }, [request, companionId, conversationId]);
  const read = useCallback(async (id: string, sourceCursor?: number) => {
    const epoch = ++detailEpoch.current;
    setDetailId(id);
    if (selectedDetail.current !== id) { setDetail(undefined); selectedDetail.current = id; }
    const result = await request({ type: 'memory.inspect', companionId, conversationId, id, sourceLimit: 10, ...(sourceCursor === undefined ? {} : { sourceCursor }) });
    if (!alive.current || epoch !== detailEpoch.current) return;
    if (result?.memoryRead) setDetail(current => sourceCursor === undefined ? result.memoryRead : { ...result.memoryRead!, sources: [...new Map([...(current?.sources ?? []), ...result.memoryRead!.sources].map(message => [message.id, message])).values()] });
    else setError('这条记忆已发生变化或无法读取，请刷新列表。');
  }, [request, companionId, conversationId]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { ++listEpoch.current; const timer = setTimeout(() => { void load(); }, 180); return () => clearTimeout(timer); }, [load]);
  useEffect(() => { void Promise.resolve().then(loadStatus); }, [loadStatus]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api?.onChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { void load(); void loadStatus(); if (detailId) void read(detailId); }, 250);
    });
    return () => { unsubscribe?.(); clearTimeout(timer); };
  }, [api, load, loadStatus, detailId, read]);
  useEffect(() => {
    if (!processing || !(processing.pending || processing.running || processing.failed || processing.backfillThrough < processing.backfillTarget)) return;
    const timer = setInterval(() => { void loadStatus(); }, 3000);
    return () => clearInterval(timer);
  }, [processing, loadStatus]);
  useEffect(() => {
    if (!requestedDraft) return;
    void Promise.resolve().then(() => { setDraft(requestedDraft.content); setSourceMessageId(requestedDraft.sourceMessageId); setEditing(undefined); onDraftConsumed?.(); });
  }, [requestedDraft, onDraftConsumed]);

  function resetPage() { setCursor(undefined); setPreviousCursors([]); }
  function subjectLabel(subject: string) { return subject === 'user' ? '你' : subject === companionId ? authorName(companionId) : subject; }
  function toggleDetail(id: string) {
    if (detailId !== id) { void read(id); return; }
    selectedDetail.current = undefined; setDetailId(undefined); setDetail(undefined); ++detailEpoch.current;
  }
  function edit(memory: CompanionMemory) { setEditing(memory); setDraft(memory.content); setSourceMessageId(memory.sourceMessageId); setForgetting(undefined); }
  async function save() {
    if (!draft.trim() || saving) return;
    setSaving(true); setError('');
    const result = await request({ type: 'memory.save', companionId, conversationId, content: draft.trim(), ...(editing ? { id: editing.id, ...(editing.version ? { expectedVersion: editing.version } : {}) } : {}), ...(sourceMessageId ? { sourceMessageId } : {}) });
    if (!alive.current) return;
    setSaving(false);
    if (!result?.ok) { setError('记忆未保存。请检查连接，或刷新后再修正。'); return; }
    setDraft(''); setEditing(undefined); setSourceMessageId(undefined);
    await Promise.all([load(), loadStatus()]);
    if (detailId) void read(detailId);
  }
  async function forget(memory: CompanionMemory) {
    if (saving) return;
    setSaving(true); setError('');
    const result = await request({ type: 'memory.forget', companionId, conversationId, id: memory.id, sourceMessageIds: [], persistent: false });
    if (!alive.current) return;
    setSaving(false);
    if (!result?.ok) { setError('遗忘未完成，请重试。'); return; }
    setForgetting(undefined); selectedDetail.current = undefined; setDetail(undefined); setDetailId(undefined);
    if (editing?.id === memory.id) { setEditing(undefined); setDraft(''); setSourceMessageId(undefined); }
    await Promise.all([load(), loadStatus()]);
  }
  async function retry() {
    setRetrying(true);
    const result = await request({ type: 'memory.jobs.retry', companionId });
    if (!alive.current) return;
    setRetrying(false);
    if (!result?.ok) setError('重试没有启动，请稍后再试。');
    await loadStatus();
  }

  return <section className="companions-memory-panel" aria-label="共同记忆管理">
    <div className="companions-memory-overview">
      <div><h4>记忆档案 <span>{page ? page.items.length + ' 条 · 本页' : '自动收录'}</span></h4>
        <p className="companions-subtle">聊天中的重要片段会自动留下。需要时，可以回到原话核查。</p>
        <p className="companions-memory-scope">{conversationKind === 'group' ? '当前群聊可见的记忆' : '当前私聊允许使用的记忆'}</p>
      </div>
      <details className="companions-memory-processing">
        <summary>{!processing ? '读取收录状态…' : processing.failed ? '收录遇到问题 · ' + processing.failed + ' 项待重试' : processing.pending || processing.running ? '自动收录中 · ' + processing.pending + ' 项等待' : '自动收录已跟进'}</summary>
        {processing && <><dl><div><dt>待处理 / 进行中 / 失败</dt><dd>{processing.pending} / {processing.running} / {processing.failed}</dd></div><div><dt>消息 / 已处理位置</dt><dd>{processing.messageWatermark} / {processing.extractionWatermark}</dd></div><div><dt>历史消息登记</dt><dd>{processing.backfillThrough} / {processing.backfillTarget}</dd></div><div><dt>已完成处理</dt><dd>{processing.completed}</dd></div></dl><small>位置是持久化处理进度，不表示每条消息都应形成记忆。</small>{processing.lastError && <p role="alert">{processing.lastError}</p>}{processing.failed > 0 && <button disabled={retrying} onClick={() => void retry()}>{retrying ? '正在重试…' : '重试失败收录'}</button>}</>}
      </details>
    </div>
    <div className="companions-memory-filters">
      <input aria-label="搜索共同记忆" type="search" maxLength={1000} placeholder="搜索内容、人物或标签" value={query} onChange={event => { setQuery(event.target.value); resetPage(); }} />
      <div><select aria-label="记忆类型" value={kind} onChange={event => { setKind(event.target.value as MemoryKind | ''); resetPage(); }}><option value="">全部类型</option>{Object.entries(KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="记忆状态" value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter); resetPage(); }}><option value="active">当前有效</option><option value="history">包含历史</option><option value="superseded">已被修订</option><option value="conflict">存在冲突</option><option value="invalid">来源失效</option><option value="forgotten">已遗忘</option></select></div>
    </div>
    {error && <p className="companions-memory-error" role="alert">{error} <button onClick={() => { void load(); void loadStatus(); }}>刷新</button></p>}
    <div className="companions-memory-workspace">
      <div className="companions-memory-list" aria-label="记忆列表">
        {busy && <p className="companions-subtle" role="status">正在查找记忆…</p>}
        {!busy && page && !page.items.length && <div className="companions-memory-empty"><Icon name="archive" /><p>{query || kind || statusFilter !== 'active' ? '没有符合条件的记忆' : '共同经历，正在慢慢积累'}</p><small>聊天记录始终保存在本地，重要片段会自动收录。</small></div>}
        {page?.items.map(({ memory }) => <article className={'companions-memory' + (detailId === memory.id ? ' is-selected' : '')} key={memory.id} data-memory-status={memory.status ?? 'active'}>
          <div className="companions-memory-meta"><span>{memory.kind ? KINDS[memory.kind] : '未分类'}</span><span>{STATUSES[memory.status ?? 'active']}</span>{memory.epistemicStatus && <span>{EVIDENCE[memory.epistemicStatus]}</span>}{memory.eventStatus && <span>{EVENTS[memory.eventStatus]}</span>}</div>
          <p>{memory.content}</p>
          {!!memory.tags?.length && <div className="companions-memory-tags">{memory.tags.map(tag => <button key={tag.id ?? tag.type + '/' + tag.name} title={tag.aliases.length ? '别名：' + tag.aliases.join('、') : tag.name} onClick={() => { setQuery(tag.name); resetPage(); }}>{tag.name}</button>)}</div>}
          <div className="companions-memory-actions"><small>{memory.captureMethod === 'automatic' ? '自动收录' : memory.origin === 'user' ? '手动补充' : '伙伴记录'} · <time dateTime={memory.updatedAt} title={companionTimestamp(memory.updatedAt)}>{new Date(memory.updatedAt).toLocaleDateString('zh-CN')}</time>{memory.version && ' · 修订 ' + memory.version}</small>
            <button aria-label={'查看记忆来源 ' + memory.id} title="来源与修订" onClick={() => toggleDetail(memory.id)}><Icon name="search" /><span>来源</span></button>
            {(!memory.status || memory.status === 'active' || memory.status === 'conflict') && <><button aria-label={'编辑记忆 ' + memory.id} title="修正记忆" onClick={() => edit(memory)}><Icon name="edit" /><span>修正</span></button><button aria-label={'删除记忆 ' + memory.id} title="忘记这件事" onClick={() => setForgetting(memory)}><Icon name="trash" /></button></>}
          </div>
          {forgetting?.id === memory.id && <div className="companions-memory-forget"><p>这条记忆及其旧来源衍生内容将退出召回，聊天原文仍保留。</p><div><button disabled={saving} onClick={() => setForgetting(undefined)}>取消</button><button disabled={saving} onClick={() => void forget(memory)}>{saving ? '正在遗忘…' : '确认遗忘'}</button></div></div>}
        </article>)}
        {page && <div className="companions-memory-pagination"><button disabled={busy || !previousCursors.length} onClick={() => { setCursor(previousCursors.at(-1)); setPreviousCursors(current => current.slice(0, -1)); }}>上一页</button><span>第 {previousCursors.length + 1} 页</span><button disabled={busy || !page.hasMore || page.nextCursor === undefined} onClick={() => { setPreviousCursors(current => [...current, cursor]); setCursor(page.nextCursor); }}>下一页</button></div>}
      </div>
      <aside className="companions-memory-reading" aria-label="记忆来源与修订">
        <header><h3>来源与修订</h3><span>回到当时的对话</span></header>
        {detailId ? <div className="companions-memory-detail">
          {!detail ? <p className="companions-subtle">正在读取来源…</p> : <>
            <p className="companions-memory-reading-content">{detail.memory.content}</p>
            <p>{detail.memory.subject && '主体：' + subjectLabel(detail.memory.subject) + ' · '}修订 {detail.memory.version ?? 1}</p>
            {detail.memory.qualifier && <p>适用范围：{detail.memory.qualifier}</p>}
            {(detail.memory.validFrom || detail.memory.validTo) && <p>有效时间：{detail.memory.validFrom || '未指定'} ～ {detail.memory.validTo || '未指定'}</p>}
            {!detail.sources.length && <p className="companions-subtle">这条记录没有可展开的消息来源。</p>}
            {detail.sources.map(source => <details key={source.id} className="companions-memory-source"><summary>{authorName(source.authorId)} · {companionTimestamp(source.createdAt)}</summary><p>{sourceContent(source)}</p><button aria-label={'定位记忆来源 ' + source.id} onClick={() => onLocateSource(source)}>{source.memoryEvidenceOnly ? '查看任务记录' : '查看原消息'}</button></details>)}
            {detail.hasMore && detail.nextSourceCursor !== undefined && <button onClick={() => void read(detailId, detail.nextSourceCursor)}>展开更多来源</button>}
            {!!detail.related.length && <details className="companions-memory-related"><summary>关联与修订记录（{detail.related.length}）</summary>{detail.related.map(related => <div key={related.id}><small>{STATUSES[related.status ?? 'active']} · 修订 {related.version ?? 1}</small><p>{related.content}</p></div>)}</details>}
          </>}
        </div> : <div className="companions-memory-reading-empty"><Icon name="file" /><p>选一条记忆，展开它的来处</p><small>原消息、修订和相关经历，会在这里显示。</small></div>}
      </aside>
    </div>
    <details className="companions-memory-manual" open={!!editing || !!draft}><summary>{editing ? '修正这条记忆' : '补充一条记忆'}</summary><div className="companions-memory-editor"><textarea aria-label="共同记忆内容" rows={3} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="可选补充；伙伴会自动收录聊天中的重要信息" />{sourceMessageId && <small>来自聊天中的一条消息</small>}<div>{(editing || draft) && <button disabled={saving} onClick={() => { setEditing(undefined); setDraft(''); setSourceMessageId(undefined); }}>取消修正</button>}<button disabled={!draft.trim() || saving} onClick={() => void save()}>{saving ? '正在保存…' : editing ? '保存修正' : '记住这件事'}</button></div></div></details>
  </section>;
}
