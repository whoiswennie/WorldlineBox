import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotMaintenanceCandidateDetail, BotMaintenanceCandidateSummary, BotMaintenanceReviews } from '../../shared/companion-bot-maintenance';
import type { BotMemoryFullNote, BotMemoryWorkspaceRequest } from '../../shared/companion-bot-memory';
import { BotIcon } from './BotIcon';

type Call = (input: BotMemoryWorkspaceRequest) => Promise<unknown>;
type Scope = { conversationId: string; companionId: string };
const labels: Record<string, string> = { pending: '待审阅', approved: '已批准，待执行', applying: '正在应用', applied: '已应用', superseded: '已由其他方案整理', rejected: '已驳回', conflict: '来源已变化，尚未执行', unknown: '执行结果待核实' };
const criteria: Record<string, string> = { facts: '事实依据', chronology: '时间与状态', authorship: '人物归属', completeness: '信息完整性', evidence: '原文证据', uncertainty: '不确定性', archive_integrity: '归档完整性', instruction_safety: '指令隔离' };
const names: Record<string, string> = { organize: '合并整理日记', update: '更新日记', archive: '归档冗余日记', insight: '梦境感悟' };
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const complete = (value: Record<string, unknown>) => typeof value.id === 'string' && typeof value.jobId === 'string' && typeof value.content === 'string' && typeof value.status === 'string' && typeof value.revision === 'string' && /^[a-f0-9]{64}$/i.test(value.revision) && [value.sources, value.quotes, value.uncertainties, value.tags].every(Array.isArray);
const stamp = (value: string, locale: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : value;

export function BotMaintenanceCandidateReview({ summary, call, scope, locale, changed, navigate, close, regenerate, position, count, hasPrevious, hasNext }: {
  summary: BotMaintenanceCandidateSummary; call: Call; scope: Scope; locale: 'zh-CN' | 'en'; changed(): void;
  navigate(direction: number): void; close(): void; regenerate(): Promise<void>; position: number; count: number; hasPrevious: boolean; hasNext: boolean;
}) {
  const zh = locale === 'zh-CN', t = (chinese: string, english: string) => zh ? chinese : english;
  const [detail, setDetail] = useState<BotMaintenanceCandidateDetail>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0), [sourceChanged, setSourceChanged] = useState(false), [tab, setTab] = useState<'proposal' | 'sources' | 'reviews' | 'result'>('proposal');
  const alive = useRef(true), revision = useRef(0), locked = useRef(false), requests = useRef(new Map<string, string>()), back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  const retire = useCallback(() => { alive.current = false; ++revision.current; }, []);
  useEffect(() => {
    alive.current = true; const current = ++revision.current;
    void call({ type: 'memory.maintenance.candidate', ...scope, jobId: summary.jobId, candidateId: summary.id }).then(raw => {
      const value = object(raw);
      if (value.id !== summary.id || !complete(value)) throw Error(zh ? '未取得完整候选。' : 'No complete candidate returned.');
      if (alive.current && revision.current === current) { setDetail(value as unknown as BotMaintenanceCandidateDetail); setError(''); }
    }).catch(reason => { if (alive.current && revision.current === current) { setDetail(undefined); setError(reason instanceof Error ? reason.message : zh ? '读取失败，请重试。' : 'Could not load the candidate.'); } });
    return retire;
  }, [call, scope, summary.id, summary.jobId, summary.status, summary.updatedAt, attempt, zh, retire]);
  const review = async (decision: 'approve' | 'reject') => {
    if (!detail || locked.current || decision === 'approve' && sourceChanged) return;
    locked.current = true; setBusy(true); setError('');
    const key = decision + ':' + detail.revision, requestId = requests.current.get(key) ?? crypto.randomUUID(); requests.current.set(key, requestId);
    try {
      const value = object(await call({ type: 'memory.maintenance.review', ...scope, jobId: detail.jobId, candidateId: detail.id, revision: detail.revision, decision, requestId }));
      if (value.id !== detail.id || !complete(value)) throw Error(t('未取得完整回执，请重新读取核实。', 'No complete receipt. Reload to verify.'));
      if (alive.current) { setDetail(value as unknown as BotMaintenanceCandidateDetail); requests.current.delete(key); changed(); }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t('操作未确认，请重试。', 'The outcome is unconfirmed. Retry to verify.')); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const resume = async () => {
    if (!detail || locked.current || detail.execution) return;
    locked.current = true; setBusy(true); setError('');
    const key = 'resume:' + detail.revision, requestId = requests.current.get(key) ?? crypto.randomUUID(); requests.current.set(key, requestId);
    try {
      const value = object(await call({ type: 'memory.maintenance.resume', ...scope, jobId: detail.jobId, candidateId: detail.id, revision: detail.revision, requestId }));
      if (value.id !== detail.id || !complete(value)) throw Error(t('核实请求尚未确认，请重试。', 'The verification request is unconfirmed. Retry.'));
      if (alive.current) { setDetail(value as unknown as BotMaintenanceCandidateDetail); requests.current.delete(key); changed(); }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : t('暂时无法核实，请重试。', 'Could not verify. Retry.')); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const resolution = object(detail?.receipt?.resolution), receiptError = object(detail?.receipt?.error);
  const canResume = detail?.approval && ['approved', 'applying', 'unknown', 'conflict'].includes(detail.status);
  const executionHint = detail?.status === 'superseded' ? t('这些来源已整理，此方案未重复写入。你的人工批准和已有整理结果均已保留。', 'These sources were already organized. This proposal was not written again; approval and prior results are retained.')
    : detail?.status === 'unknown' || detail?.status === 'conflict' ? receiptError.code === 'MEMORY_NOTE_UNAVAILABLE' ? t('批准已保存；来源已被整理或当前不可用。请核实已有结果后继续。', 'Approval is saved. Sources were already organized or are unavailable. Verify the existing result to continue.')
      : typeof receiptError.message === 'string' ? receiptError.message : typeof detail.receipt?.error === 'string' ? detail.receipt.error : t('批准已保存；执行结果尚未确认，可核实原操作并继续。', 'Approval is saved. Verify and continue the original operation.') : '';
  return <section className="bot-maintenance-candidate-detail bot-review-reader" aria-label={t('逐项审阅', 'Candidate review')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); } }}>
    <header className="bot-review-reader-heading"><button ref={back} className="bot-review-back" disabled={busy} onClick={close}><BotIcon name="arrow-left" />{t('返回方案列表', 'Back to candidates')}</button><h3>{zh ? names[summary.type] : summary.type}</h3><nav className="bot-review-pager" aria-label={t('切换候选', 'Navigate candidates')}><button disabled={!hasPrevious || busy} onClick={() => navigate(-1)} aria-label={t('上一项候选', 'Previous candidate')} title={t('上一项候选', 'Previous candidate')}><BotIcon name="chevron-left" /></button><span>{position} / {count}</span><button disabled={!hasNext || busy} onClick={() => navigate(1)} aria-label={t('下一项候选', 'Next candidate')} title={t('下一项候选', 'Next candidate')}><BotIcon name="chevron-right" /></button></nav></header>
    <nav className="bot-review-reader-tabs"><button aria-pressed={tab === 'proposal'} onClick={() => setTab('proposal')}>{t('方案正文', 'Proposed content')}</button><button aria-label={t('来源原文', 'Original sources')} aria-pressed={tab === 'sources'} onClick={() => setTab('sources')}>{t('来源原文', 'Original sources')}{detail ? ` · ${detail.sources.length}` : ''}</button><button aria-pressed={tab === 'reviews'} onClick={() => setTab('reviews')}>{t('审阅记录', 'Review history')}</button>{detail?.status === 'superseded' && typeof resolution.noteId === 'string' && <button aria-pressed={tab === 'result'} onClick={() => setTab('result')}>{t('已整理日记', 'Organized note')}</button>}</nav>
    {error && <div className="bot-memory-alert" role="alert">{error}<button onClick={() => { setError(''); setAttempt(value => value + 1); }}>{t('重新读取候选', 'Reload candidate')}</button></div>}
    {!detail ? <div className="bot-maintenance-empty">{!error && t('正在读取候选…', 'Loading candidate…')}</div> : tab === 'result' && typeof resolution.noteId === 'string' ? <ResolvedNote id={resolution.noteId} call={call} scope={scope} locale={locale} /> : tab === 'reviews' ? <ReviewHistory key={detail.updatedAt} detail={detail} call={call} scope={scope} locale={locale} /> : <div className="bot-review-content-panels">
      <div className="bot-review-draft bot-review-content-scroll" hidden={tab !== 'proposal'}><h4>{detail.type === 'insight' ? t('拟保存的梦境感悟 · 非用户事实', 'Proposed dream insight · not a user fact') : t('拟写入的完整内容', 'Complete proposed content')}</h4><pre className="bot-maintenance-proposed">{detail.type === 'archive' && !detail.content ? t('归档指定的冗余日记；保留原件，可恢复。', 'Archive the specified redundant notes; originals remain recoverable.') : detail.content}</pre>
        <details className="bot-review-rationale"><summary>{t('整理依据与待核实事项', 'Rationale and uncertainties')}{detail.uncertainties.length ? ` · ${detail.uncertainties.length}` : ''}</summary><h4>{t('为什么提出这项改动', 'Reason for this proposal')}</h4><p>{detail.reason}</p>
        <h4>{t('不确定与需核实之处', 'Uncertainties to verify')}</h4>{detail.uncertainties.length ? <ul>{detail.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{t('未列出不确定项，不表示内容已经核实。', 'No uncertainties listed; this does not establish factual correctness.')}</p>}
        </details>{detail.receipt && <details><summary>{t('执行原始回执', 'Original execution receipt')}</summary><pre className="bot-review-receipt">{JSON.stringify(detail.receipt, null, 2)}</pre></details>}
      </div><div className="bot-review-content-scroll" hidden={tab !== 'sources'}><SourceComparison detail={detail} call={call} scope={scope} locale={locale} changed={() => setSourceChanged(true)} /></div>
    </div>}
    {detail && <footer className="bot-review-reader-footer"><div><div className="bot-review-outcome">{detail.approval && <span className="bot-review-approval"><BotIcon name="check" />{detail.approval.actor === 'user' ? t('人工已批准', 'Human approved') : t('已批准', 'Approved')}</span>}<span className="bot-maintenance-status" data-state={detail.status}>{detail.execution?.operation === 'reconcile' ? t(detail.execution.state === 'running' ? '正在核实执行结果' : '等待核实执行结果', detail.execution.state === 'running' ? 'Checking execution result' : 'Queued for verification') : zh ? detail.status === 'pending' && detail.autoReview?.state === 'manual' ? '已审阅 · 需人工确认' : detail.status === 'pending' && detail.autoReview?.state === 'running' ? '全局模型审阅中' : labels[detail.status] || detail.status : detail.status}</span></div><p>{executionHint || (sourceChanged ? t('来源已变化，请重新生成方案后再批准。', 'A source changed. Generate a new plan before approval.') : detail.type === 'insight' ? t('仅保存为梦境感悟，不作为用户事实。', 'Saved as a dream insight, not a user fact.') : detail.type === 'archive' ? t('归档后退出召回，原件保留并可恢复。', 'Archived notes leave recall; originals remain recoverable.') : t('写入索引确认后再归档来源，所有操作保留回执。', 'Source archiving follows confirmed indexing; receipts are retained.'))}</p></div><div className="bot-maintenance-review-actions">{detail.status === 'pending' && <><button disabled={busy} onClick={() => void review('reject')}>{t('驳回此项', 'Reject candidate')}</button><button className="is-primary" disabled={busy || sourceChanged} onClick={() => void review('approve')}>{busy ? t('提交中…', 'Submitting…') : t('批准并应用', 'Approve and apply')}</button></>}{canResume && <><button disabled={busy || !!detail.execution} onClick={() => void regenerate()}>{t('重新生成方案', 'Generate a new plan')}</button><button className="is-primary" disabled={busy || !!detail.execution} onClick={() => void resume()}><BotIcon name="history" />{busy || detail.execution?.operation === 'reconcile' ? t('核实中…', 'Checking…') : detail.execution ? t('执行中…', 'Executing…') : t('核实并继续', 'Verify and continue')}</button></>}{detail.status === 'superseded' && typeof resolution.noteId === 'string' && <button className="is-primary" onClick={() => setTab('result')}><BotIcon name="memory" />{t('查看已整理日记', 'Read the organized note')}</button>}</div></footer>}
  </section>;
}

function ResolvedNote({ id, call, scope, locale }: { id: string; call: Call; scope: Scope; locale: 'zh-CN' | 'en' }) {
  const [note, setNote] = useState<BotMemoryFullNote>(), [error, setError] = useState(''), zh = locale === 'zh-CN';
  useEffect(() => { let live = true; void call({ type: 'memory.note', ...scope, id }).then(raw => { const value = object(raw); if (value.id !== id || typeof value.content !== 'string') throw Error(zh ? '暂时无法读取整理结果。' : 'Could not read the organized note.'); if (live) setNote(value as unknown as BotMemoryFullNote); }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : 'Could not read result'); }); return () => { live = false; }; }, [id, call, scope, zh]);
  return <div className="bot-review-content-scroll"><div className="bot-review-draft"><h4>{zh ? '已保存的整理结果' : 'Saved organization result'}</h4>{error && <p role="alert">{error}</p>}{note ? <pre className="bot-maintenance-proposed">{note.content}</pre> : !error && <p>{zh ? '正在读取已整理日记…' : 'Reading organized note…'}</p>}</div></div>;
}

function SourceComparison({ detail, call, scope, locale, changed }: { detail: BotMaintenanceCandidateDetail; call: Call; scope: Scope; locale: 'zh-CN' | 'en'; changed(): void }) {
  const zh = locale === 'zh-CN', [index, setIndex] = useState(0), [note, setNote] = useState<BotMemoryFullNote>(), [error, setError] = useState(''), revision = useRef(0);
  const source = detail.sources[index];
  useEffect(() => () => { ++revision.current; }, []);
  const read = async () => { if (!source) return; const current = ++revision.current; setError('');
    try { const value = object(await call({ type: 'memory.note', ...scope, id: source.id })); if (value.id !== source.id || typeof value.content !== 'string') throw Error(zh ? '未取得来源原件。' : 'No source original returned.'); if (current === revision.current) { setNote(value as unknown as BotMemoryFullNote); if (value.checksum !== source.checksum) changed(); } }
    catch (reason) { if (current === revision.current) setError(reason instanceof Error ? reason.message : 'Source unavailable'); }
  };
  return <div className="bot-review-sources"><h4>{zh ? '来源与原文对照' : 'Original source evidence'}</h4><div className="bot-review-source-heading"><select aria-label={zh ? '选择来源日记' : 'Select source note'} value={index} onChange={event => { ++revision.current; setIndex(Number(event.target.value)); setNote(undefined); setError(''); }}>{detail.sources.map((item, position) => <option value={position} key={item.id}>{zh ? '来源' : 'Source'} {position + 1} · {stamp(item.createdAt, locale)}</option>)}</select><button onClick={() => void read()}>{zh ? '查看原日记' : 'Read original note'}</button></div>
    {source && detail.quotes.filter(item => item.sourceId === source.id).map((item, position) => <blockquote className="bot-maintenance-quote" key={position}>{item.text}</blockquote>)}
    {error && <p role="alert">{error}</p>}{note && <><p className="bot-memory-hint">{note.checksum !== source?.checksum ? zh ? '来源与方案快照已不同：下方是当前版本，上方引用保留方案生成时的摘录。' : 'Source changed since the plan snapshot; original proposal quotes remain above.' : zh ? '当前原件全文，与方案来源版本一致。' : 'Full current original; version matches the proposal.'}{note.indexState === 'archived' && (zh ? ' 此原件已归档，仍可读取。' : ' This original is archived and remains readable.')}</p><pre className="bot-review-source-original bot-maintenance-source-body">{note.content}</pre></>}
  </div>;
}

function ReviewHistory({ detail, call, scope, locale }: { detail: BotMaintenanceCandidateDetail; call: Call; scope: Scope; locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN', [page, setPage] = useState<BotMaintenanceReviews>({ items: [] }), [cursor, setCursor] = useState<string>(), [error, setError] = useState('');
  useEffect(() => { let live = true; void call({ type: 'memory.maintenance.reviews', ...scope, jobId: detail.jobId, candidateId: detail.id, cursor, limit: 20 }).then(raw => { const value = object(raw); if (!Array.isArray(value.items)) throw Error(zh ? '未取得审阅记录。' : 'No review history returned.'); if (live) setPage(value as unknown as BotMaintenanceReviews); }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : 'Review history unavailable'); }); return () => { live = false; }; }, [call, scope, detail.jobId, detail.id, cursor, zh]);
  return <div className="bot-review-history">{error && <p role="alert">{error}</p>}{!page.items.length && <div className="bot-maintenance-empty">{zh ? '尚无审阅记录。人工与模型的每次决定都会保留在这里。' : 'No reviews yet. Human and model decisions are recorded here.'}</div>}{page.items.map(item => <article key={item.id}><header><strong>{item.actor === 'model' ? `${zh ? '全局模型审阅' : 'Global model review'} · ${item.model || '—'}` : item.actor === 'lossless' ? zh ? '无损规则审阅' : 'Lossless policy' : zh ? '人工审阅' : 'Human review'}</strong><span>{zh ? item.decision === 'approve' ? '批准' : item.decision === 'reject' ? '驳回' : item.decision === 'retry' ? '暂缓并自动重试' : '转交人工' : item.decision}</span></header><time>{stamp(item.createdAt, locale)}</time><p>{item.reason}</p>{item.checks?.map(check => <div className="bot-review-check" data-passed={check.passed} key={check.criterion}><b>{check.passed ? '✓' : '!'}</b><div><strong>{zh ? criteria[check.criterion] || check.criterion : check.criterion}</strong><p>{check.reason}</p></div></div>)}{item.evidence?.length ? <details><summary>{zh ? '审阅时采用的原文证据' : 'Evidence used in this review'}</summary>{item.evidence.map((value, index) => <blockquote className="bot-maintenance-quote" key={index}>{value.quote}</blockquote>)}</details> : null}<small>{item.promptVersion || (zh ? '人工明确操作' : 'Explicit human action')} · {zh ? '候选版本' : 'Candidate revision'} {item.candidateRevision.slice(0, 12)}</small></article>)}{page.nextCursor && <button onClick={() => setCursor(page.nextCursor)}>{zh ? '更早的审阅记录' : 'Earlier reviews'}</button>}</div>;
}
