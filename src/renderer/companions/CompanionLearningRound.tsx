import { useEffect, useMemo, useState } from 'react';
import type { CompanionLearningGoalRead, CompanionLearningGoalRound } from '../../shared/companion-learning-goals';
import { Icon } from '../Icons';

export const learningPhaseLabels: Record<CompanionLearningGoalRound['phase'], string> = { idle: '等待下一轮', planning: '规划这一轮', reading: '阅读材料', integrating: '整理理解', testing: '自测与核对', reflecting: '反思与计划', waiting: '等待合适时机' };
const statusLabels: Record<CompanionLearningGoalRound['status'], string> = { running: '进行中', completed: '本轮已记录', deferred: '本轮已延后', failed: '需要处理', cancelled: '已停止本轮' };
const evaluations = { supported: '自评：有材料支持', partial: '自评：部分支持', unsupported: '自评：缺少支持', unassessed: '尚未评估' };
export function learningDate(value?: string, timeZone?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间未记录';
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
  catch { return new Date(value).toLocaleString('zh-CN'); }
}

function ReadDetail({ read }: { read: CompanionLearningGoalRead }) {
  const [page, setPage] = useState(0);
  // Only a small slice of the actual receipt is mounted, even for large materials.
  const slices = useMemo(() => {
    const result: string[] = [];
    for (let offset = 0; offset < read.excerpt.length;) {
      let end = Math.min(offset + 3000, read.excerpt.length);
      if (end < read.excerpt.length && /[\uD800-\uDBFF]/u.test(read.excerpt[end - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(read.excerpt[end] ?? '')) --end;
      result.push(read.excerpt.slice(offset, end)); offset = end;
    }
    return result;
  }, [read.excerpt]);
  const count = slices.length;
  return <div className="learning-round-read-detail"><p className="learning-round-plain">{slices[page] || '本轮未保留可展示的原文片段。'}</p>{count > 1 && <nav aria-label="阅读原文分页"><button type="button" disabled={!page} onClick={() => setPage(value => value - 1)}>上一段</button><span>{page + 1} / {count}</span><button type="button" disabled={page + 1 >= count} onClick={() => setPage(value => value + 1)}>下一段</button></nav>}{read.truncated && <small>本轮仅读取并保存了材料的一部分；这里展示实际读取片段。</small>}<details><summary>材料版本凭证</summary><dl><div><dt>来源</dt><dd>{read.uri}</dd></div><div><dt>版本</dt><dd>{read.revision}</dd></div><div><dt>内容校验</dt><dd>{read.contentHash}</dd></div></dl></details></div>;
}

type Evidence = CompanionLearningGoalRound['claims'][number]['evidence'];
function EvidenceQuotes({ evidence, reads, onRead }: { evidence: Evidence; reads: CompanionLearningGoalRead[]; onRead(id: string): void }) {
  if (!evidence.length) return <p className="learning-round-muted">本项没有已核验的原文引用。</p>;
  return <div className="learning-round-evidence">{evidence.map((item, index) => {
    const source = reads.find(read => read.id === item.sourceId);
    // Do not render a quote that cannot be tied to this exact round's read receipt.
    if (!source || !source.excerpt.includes(item.quote)) return <p key={index} className="learning-round-muted">此引用未能与本轮原文凭证核对。</p>;
    return <blockquote key={index}><p>{item.quote}</p><button type="button" onClick={() => onRead(source.id)}><Icon name="file-text" size={13} />{source.title}<Icon name="chevron-right" size={12} /></button></blockquote>;
  })}</div>;
}

export function CompanionLearningRound({ round, onOpenNote }: { round: CompanionLearningGoalRound; onOpenNote?(id: string): void }) {
  const [readId, setReadId] = useState<string>(), [claimsOpen, setClaimsOpen] = useState(false), [testOpen, setTestOpen] = useState(false), [issuesOpen, setIssuesOpen] = useState(false);
  useEffect(() => { if (!readId) return; document.getElementById(`learning-round-read-${readId}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [readId]);
  return <article className="learning-round-detail" aria-label={`第 ${round.ordinal} 轮学习详情`}>
    <header><div><span className="learning-goal-kicker">第 {round.ordinal} 轮学习</span><h3>{round.plan?.focus || learningPhaseLabels[round.phase]}</h3></div><span className={'learning-goal-state is-' + round.status}>{statusLabels[round.status]}</span></header>
    <div className="learning-round-time"><time dateTime={round.startedAt}>开始 {learningDate(round.startedAt)}</time>{round.endedAt ? <time dateTime={round.endedAt}>结束 {learningDate(round.endedAt)}</time> : <span>{learningPhaseLabels[round.phase]}</span>}</div>
    {round.error && <p className="learning-goal-error" role="status">{round.error}</p>}
    {round.status === 'cancelled' && <p className="learning-round-muted">本轮已停止。下面仅展示已提交的真实记录。</p>}
    {round.plan && <section className="learning-round-section"><span className="learning-round-step"><Icon name="sparkles" size={15} /></span><div><h4>这一轮想弄清楚</h4>{!!round.plan.questions.length && <ul>{round.plan.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>}{!!round.plan.searchQueries.length && <details><summary>本轮查询计划</summary><ul>{round.plan.searchQueries.map((query, index) => <li key={index}>{query}</li>)}</ul></details>}</div></section>}
    <section className="learning-round-section"><span className="learning-round-step"><Icon name="file-text" size={15} /></span><div><h4>实际读过的材料 <small>{round.reads.length} 份</small></h4>{!round.reads.length && <p className="learning-round-muted">本轮尚无已提交的阅读凭证。</p>}<ul className="learning-round-reads">{round.reads.map(read => <li key={read.id} id={`learning-round-read-${read.id}`}><button type="button" aria-label={read.title} aria-expanded={readId === read.id} onClick={() => setReadId(current => current === read.id ? undefined : read.id)}><span><strong>{read.title}</strong><small>{learningDate(read.readAt)} · {read.characters.toLocaleString('zh-CN')} 字符 · {read.kind === 'web' ? '网页' : read.kind === 'file' ? '本地文件' : '授权资产资料'}</small></span><Icon name={readId === read.id ? 'chevron' : 'chevron-right'} size={13} /></button>{readId === read.id && <ReadDetail key={read.id + read.contentHash} read={read} />}</li>)}</ul>{!!round.readingIssues?.length && <details className="learning-round-reading-issues" onToggle={event => setIssuesOpen(event.currentTarget.open)}><summary>本轮未能读取的材料 · {round.readingIssues.length} 项</summary>{issuesOpen && <ul>{round.readingIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</details>}</div></section>
    <section className="learning-round-section"><span className="learning-round-step"><Icon name="layers" size={15} /></span><div><h4>留下了哪些理解</h4>{round.summary ? <p className="learning-round-plain">{round.summary}</p> : <p className="learning-round-muted">本轮尚未提交理解总结。</p>}{!!round.claims.length && <details onToggle={event => setClaimsOpen(event.currentTarget.open)}><summary>查看 {round.claims.length} 项理解与原文依据</summary>{claimsOpen && <ol className="learning-round-claims">{round.claims.map((claim, index) => <li key={index}><p>{claim.text}</p><EvidenceQuotes evidence={claim.evidence} reads={round.reads} onRead={setReadId} /></li>)}</ol>}</details>}{round.integration && <div className="learning-round-integration"><span><Icon name="layers" size={13} />{round.integration.action === 'reused' ? '复用了已有的学习记忆' : round.integration.action === 'revised' ? '更新了已有的学习记忆' : '留下了一份新的学习记忆'}<small>版本 {round.integration.version}</small></span><p>{round.integration.reason}</p></div>}{!!round.memoryIds.length && <div className="learning-round-memories"><span>已关联到个人记忆</span>{round.memoryIds.map((id, index) => <button type="button" key={id} disabled={!onOpenNote} onClick={() => onOpenNote?.(id)}><Icon name="file-text" size={13} />查看记忆 {index + 1}<Icon name="arrow-up-right" size={12} /></button>)}</div>}</div></section>
    <section className="learning-round-section"><span className="learning-round-step"><Icon name="check" size={15} /></span><div><h4>自测与核对</h4>{round.selfTest ? <><p className="learning-round-assessment">自评有材料支持 {round.selfTest.supportedAnswers} 项 · 已评估 {round.selfTest.assessedQuestions} 题</p><p className="learning-round-disclaimer">{round.selfTest.disclaimer}</p><details onToggle={event => setTestOpen(event.currentTarget.open)}><summary>查看 {round.selfTest.questions.length} 道自测题与回答</summary>{testOpen && <ol className="learning-round-questions">{round.selfTest.questions.map((question, index) => <li key={index}><h5>{question.question}</h5><span className={'learning-round-evaluation is-' + question.evaluation}>{evaluations[question.evaluation]}</span><p className="learning-round-plain">{question.answer}</p><p className="learning-round-muted">{question.rationale}</p><EvidenceQuotes evidence={question.evidence} reads={round.reads} onRead={setReadId} /></li>)}</ol>}</details></> : <p className="learning-round-muted">本轮尚未提交自测；不推断已经掌握。</p>}</div></section>
    <section className="learning-round-section"><span className="learning-round-step"><Icon name="clock" size={15} /></span><div><h4>还不清楚的地方</h4>{round.gaps.length ? <ul>{round.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul> : <p className="learning-round-muted">本轮没有记录具体不足。</p>}<h4 className="learning-round-next-heading">下一轮准备怎么做</h4>{round.nextPlan.length ? <ul>{round.nextPlan.map((plan, index) => <li key={index}>{plan}</li>)}</ul> : <p className="learning-round-muted">本轮尚未留下下一步计划。</p>}{round.stateReflection && <details><summary>整理后的关注 · {round.stateReflection.outcome === 'applied' ? '已更新' : round.stateReflection.outcome === 'skipped' ? '保留当前状态' : round.stateReflection.outcome === 'not_needed' ? '无需重复更新' : '尚未提交'}</summary><p className="learning-round-plain">{round.stateReflection.focus}</p><p className="learning-round-muted">{round.stateReflection.reason}</p>{round.stateReflection.detail && <p className="learning-round-muted">{round.stateReflection.detail}</p>}<EvidenceQuotes evidence={round.stateReflection.evidence} reads={round.reads} onRead={setReadId} /></details>}</div></section>
  </article>;
}
