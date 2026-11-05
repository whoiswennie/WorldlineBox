import { useId, useRef, useState, type ReactNode } from 'react';
import type { BotCompanion, BotRequest, BotResponse, BotTask } from '../../shared/companion-bot';
import type { BotEffectResolution, BotTaskAnswer } from '../../shared/companion-bot-task';
import { BotTextField } from './BotTextField';
import { BotIcon } from './BotIcon';
import { BotTaskOwner } from './BotTaskOwner';
import { botTaskTitle, botTaskStatus, botTaskState, botTaskActive, botTaskStopping, botTaskPausing, botTaskStages, botTaskCanFollow } from './task-presentation';
import { BotTaskActivity, BotTaskEvents } from './BotTaskActivity';

const labels = {
  'zh-CN': { queued: '排队中', running: '执行中', waiting: '等待回答', succeeded: '已完成', failed: '执行失败', cancelled: '已停止', unknown: '结果待核实',
    stop: '停止', guidance: '追加指导', send: '发送指导', answer: '提交回答', other: '补充回答', submitted: '回答已提交',
    uncertain: '上次操作的结果尚未确认。请先检查实际结果，再逐项决定如何继续。', verification: '核实结果与后续要求', choose: '选择核实结果', applied: '已发生，跳过重复执行', retry: '已确认未发生，允许重试', resume: '核实后继续', error: '操作未完成，请重试。' },
  en: { queued: 'Queued', running: 'Running', waiting: 'Waiting for an answer', succeeded: 'Completed', failed: 'Failed', cancelled: 'Stopped', unknown: 'Result needs verification',
    stop: 'Stop', guidance: 'Additional guidance', send: 'Send guidance', answer: 'Submit answers', other: 'Additional answer', submitted: 'Answers submitted',
    uncertain: 'The last operation has an unconfirmed result. Check what actually happened, then decide how to handle each operation.', verification: 'Verified result and next steps', choose: 'Choose the verified result', applied: 'Already applied; skip execution', retry: 'Confirmed not applied; allow retry', resume: 'Continue after verification', error: 'The operation did not finish. Try again.' },
};
type Control = Extract<BotRequest, { type: 'task.control' }>;
type ControlDraft = Omit<Control, 'type' | 'taskId' | 'conversationId' | 'requestId'>;

interface TaskCardProps { task: BotTask; companion?: BotCompanion; showOwner?: boolean; locale: 'zh-CN' | 'en'; request(input: BotRequest): Promise<BotResponse>; changed(): Promise<unknown>; removed?(): Promise<unknown>; onFollow?(task: BotTask): void; children?: ReactNode }
export function BotTaskCard(props: TaskCardProps) {
  const { task } = props;
  const context = JSON.stringify([task.id, task.attention?.id, task.status === 'paused', task.pauseRequested, task.status === 'unknown' ? task.pendingEffects?.map(effect => [effect.callId, effect.argsHash]) : undefined]);
  return <TaskCardForm key={context} {...props} />;
}
function TaskCardForm({ task, companion, showOwner, locale, request, changed, removed, onFollow, children }: TaskCardProps) {
  const t = labels[locale], attention = task.attention, zh = locale === 'zh-CN', uid = useId();
  const [answers, setAnswers] = useState<Record<string, BotTaskAnswer>>({}), [text, setText] = useState(''), [verification, setVerification] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [decisions, setDecisions] = useState<Record<string, BotEffectResolution['decision']>>({});
  const [tab, setTab] = useState<'overview' | 'activity' | 'details'>('overview');
  const [stopIntent, setStopIntent] = useState<{ at: string; state: 'sending' | 'accepted' | 'unconfirmed' }>();
  const [pauseIntent, setPauseIntent] = useState<{ at: string; state: 'sending' | 'accepted' | 'unconfirmed' }>();
  const sending = useRef(false), attempts = useRef(new Map<string, { body: string; requestId: string }>());
  const active = botTaskActive(task);
  const stoppedView = stopIntent && active && !task.cancelRequested ? { ...task, cancelRequested: true, stopRequestedAt: stopIntent.at,
    progress: { ...task.progress, phase: stopIntent.state === 'sending' ? 'stop-requesting' : stopIntent.state === 'unconfirmed' ? 'stop-request-unknown' : 'stopping' } } : task;
  const view = pauseIntent && active && !botTaskStopping(stoppedView) && task.status !== 'paused' && !task.pauseRequested ? { ...stoppedView, pauseRequested: true, pauseRequestedAt: pauseIntent.at,
    progress: { ...task.progress, phase: pauseIntent.state === 'sending' ? 'pause-requesting' : pauseIntent.state === 'unconfirmed' ? 'pause-request-unknown' : 'pausing' } } : stoppedView;
  const stopping = botTaskStopping(view);
  const pausing = botTaskPausing(view);
  const control = async (draft: ControlDraft) => {
    if (sending.current) return;
    const body = JSON.stringify(draft), previous = attempts.current.get(draft.operation);
    const requestId = previous?.body === body ? previous.requestId : crypto.randomUUID();
    let accepted = false;
    attempts.current.set(draft.operation, { body, requestId }); sending.current = true; setBusy(true); setError('');
    if (draft.operation === 'cancel') setStopIntent(current => ({ at: current?.at ?? new Date().toISOString(), state: 'sending' }));
    if (draft.operation === 'pause') setPauseIntent(current => ({ at: current?.at ?? new Date().toISOString(), state: 'sending' }));
    try {
      const result = await request({ type: 'task.control', conversationId: task.conversationId, taskId: task.id, requestId, ...draft });
      if (!result.ok) { setError(result.error ?? t.error); if (draft.operation === 'cancel') setStopIntent(current => current && { ...current, state: 'unconfirmed' }); if (draft.operation === 'pause') setPauseIntent(current => current && { ...current, state: 'unconfirmed' }); return; }
      accepted = true;
      if (draft.operation === 'send') { setText(''); attempts.current.delete('send'); }
      if (draft.operation === 'resume') setVerification('');
      if (draft.operation === 'cancel') { setStopIntent(current => current && { ...current, state: 'accepted' }); attempts.current.delete('cancel'); }
      if (draft.operation === 'pause') { setPauseIntent(current => current && { ...current, state: 'accepted' }); attempts.current.delete('pause'); }
      if (draft.operation === 'resume_paused') setPauseIntent(undefined);
      if (draft.operation === 'remove' && removed) await removed(); else await changed();
    } catch { setError(accepted ? zh ? '请求已记录，但状态刷新失败。请刷新查看。' : 'The request was recorded, but refreshing the status failed. Refresh to check.' : t.error); if (draft.operation === 'cancel' && !accepted) setStopIntent(current => current && { ...current, state: 'unconfirmed' }); if (draft.operation === 'pause' && !accepted) setPauseIntent(current => current && { ...current, state: 'unconfirmed' }); } finally { sending.current = false; setBusy(false); }
  };
  const answerFor = (id: string): BotTaskAnswer => answers[id] ?? { id, selected: [], custom: '' };
  const patchAnswer = (id: string, patch: Partial<BotTaskAnswer>) => setAnswers(current => ({ ...current, [id]: { ...(current[id] ?? { id, selected: [] }), ...patch } }));
  const complete = attention?.questions.every(question => { const answer = answerFor(question.id); return answer.selected.length || answer.custom?.trim(); });
  const effectsComplete = task.pendingEffects?.every(effect => decisions[effect.callId]) ?? true;
  const resume = () => { if (verification.trim() && effectsComplete) void control({ operation: 'resume', text: verification.trim(),
    ...(task.pendingEffects?.length ? { effectResolutions: task.pendingEffects.map(effect => ({ callId: effect.callId, decision: decisions[effect.callId]! })) } : {}) }); };
  const tabs = [['overview', zh ? '概览' : 'Overview'], ['activity', zh ? '执行记录' : 'Activity'], ['details', zh ? '任务详情' : 'Task details']] as const;
  const shortGoal = task.goal.replace(/\s+/gu, ' ').trim(), preview = shortGoal.length > 180 ? shortGoal.slice(0, 180) + '…' : shortGoal;
  return <article className="bot-task" data-bot-task={task.id} data-task-state={botTaskState(view)}>
    <header className="bot-task-heading"><div>{showOwner ? <BotTaskOwner task={task} companion={companion} locale={locale} /> : <span className="bot-task-eyebrow">{zh ? '委派任务' : 'Delegated task'}</span>}<h4>{botTaskTitle(task)}</h4></div><span className={`bot-task-badge is-${botTaskState(view)}`}>{botTaskStatus(view, locale)}</span></header>
    <nav className="bot-task-tabs" role="tablist" aria-label={zh ? '任务信息' : 'Task information'}>{tabs.map(([value, label], index) => <button key={value} role="tab" id={`${uid}-${value}-tab`} aria-controls={`${uid}-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
      setTab(tabs[next]![0]); document.getElementById(`${uid}-${tabs[next]![0]}-tab`)?.focus();
    }}>{label}{value === 'activity' && !!task.activity?.length && <span>{task.activity.length}</span>}</button>)}</nav>
    <div className="bot-task-content" role="tabpanel" id={`${uid}-${tab}`} aria-labelledby={`${uid}-${tab}-tab`}>
    {tab === 'overview' && <div className="bot-task-overview">
      <BotTaskActivity task={view} locale={locale} busy={busy} onInspect={() => void changed()} onRetryStop={() => void control({ operation: 'cancel' })} onRetryPause={() => void control({ operation: 'pause' })} onRecords={() => setTab('activity')} />
      <ol className="bot-task-stage-flow" aria-label={zh ? '已记录的任务阶段' : 'Recorded task stages'}>{botTaskStages(task, locale).map((stage, index) => <li key={stage.label} data-state={stage.state}><span>{stage.state === 'complete' ? '✓' : index + 1}</span><div><strong>{stage.label}</strong><small>{stage.caption}</small></div></li>)}</ol>
      <section className="bot-task-summary"><header><h5>{zh ? '这项任务' : 'Task brief'}</h5><button onClick={() => setTab('details')}>{zh ? '完整要求' : 'Full requirements'}<span aria-hidden="true">↗</span></button></header><p>{preview || botTaskTitle(task)}</p></section>
      {(task.error || task.diagnostic && active && ['recovering', 'stop-unconfirmed', 'stopping'].includes(view.progress?.phase ?? '')) && <section className="bot-task-attention"><div><BotIcon name="history" /><strong>{zh ? '需要留意' : 'Needs attention'}</strong></div><p>{task.error || (zh ? '连接遇到了问题，原任务和进度已保留。' : 'A connection problem occurred. The original task and its progress are preserved.')}</p><button onClick={() => setTab('activity')}>{zh ? '查看执行记录与原因' : 'View activity and details'}</button></section>}
      {task.summary && <section className="bot-task-result"><header><h5>{zh ? '执行结果' : 'Execution result'}</h5><button onClick={() => setTab('details')}>{zh ? '查看原始结果' : 'View full output'}</button></header><p>{task.summary.length > 800 ? task.summary.slice(0, 800) + '…' : task.summary}</p></section>}
    {attention?.state === 'queued' && active && !stopping && !pausing && task.status !== 'paused' && <form className="bot-task-controls" onSubmit={event => { event.preventDefault(); if (complete) void control({ operation: 'answer', questionId: attention.id, answers: attention.questions.map(question => answerFor(question.id)) }); }}>
      {attention.questions.map(question => <fieldset key={question.id} disabled={busy}>
        <legend>{question.question}</legend>
        {question.options?.map(option => <label key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${task.id}:${attention.id}:${question.id}`} checked={answerFor(question.id).selected.includes(option.label)}
          onChange={event => patchAnswer(question.id, { selected: question.multiSelect ? event.target.checked ? [...answerFor(question.id).selected, option.label] : answerFor(question.id).selected.filter(value => value !== option.label) : [option.label] })} />
          <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
        <BotTextField aria-label={`${t.other} · ${question.header ?? question.question}`} value={answerFor(question.id).custom ?? ''} onChange={event => patchAnswer(question.id, { custom: event.target.value })} maxLength={12000} minRows={2} />
      </fieldset>)}
      <button className="bot-task-primary" disabled={busy || !complete}>{t.answer}</button>
    </form>}
    {attention?.state === 'answered' && active && !stopping && !pausing && task.status !== 'paused' && <p role="status">{t.submitted}</p>}
    {task.status === 'unknown' && !stopping && !pausing && <form className="bot-task-controls bot-task-verification" onSubmit={event => { event.preventDefault(); resume(); }}>
      <p>{t.uncertain}</p>
      {task.pendingEffects?.map(effect => <div className="bot-task-effect" key={effect.callId}><strong>{effect.toolName}</strong>{effect.argumentsPreview && <pre>{effect.argumentsPreview}</pre>}
        <select aria-label={`${t.choose} · ${effect.toolName}`} value={decisions[effect.callId] ?? ''} disabled={busy} onChange={event => {
          const value = event.target.value; setDecisions(current => { const next = { ...current }; if (value) next[effect.callId] = value as BotEffectResolution['decision']; else delete next[effect.callId]; return next; });
        }}><option value="">{t.choose}</option><option value="already_applied">{t.applied}</option><option value="retry">{t.retry}</option></select></div>)}
      <BotTextField aria-label={t.verification} placeholder={t.verification} value={verification} onChange={event => setVerification(event.target.value)} maxLength={16000} minRows={3} />
      <button className="bot-task-primary" disabled={busy || !verification.trim() || !effectsComplete}>{t.resume}</button>
    </form>}
    </div>}
    {tab === 'activity' && <BotTaskEvents task={task} locale={locale} />}
    {tab === 'details' && <div className="bot-task-details"><section className="bot-task-goal"><h5>{zh ? '原始任务要求' : 'Original task requirements'}</h5><p>{task.goal}</p></section>
    {['queued', 'running', 'waiting'].includes(task.status) && attention?.state !== 'queued' && !stopping && !pausing && <section className="bot-task-guidance"><h5>{t.guidance}</h5><form className="bot-task-controls" onSubmit={event => { event.preventDefault(); if (text.trim()) void control({ operation: 'send', text: text.trim() }); }}>
      <BotTextField aria-label={t.guidance} placeholder={t.guidance} value={text} onChange={event => setText(event.target.value)} maxLength={16000} minRows={2} />
      <button className="bot-task-primary" disabled={busy || !text.trim()}>{t.send}</button>
    </form></section>}
    {task.summary && <section className="bot-task-receipt"><h5>{zh ? '原始执行结果' : 'Original executor output'}</h5><pre>{task.summary}</pre></section>}
    {children && <section className="bot-task-environment">{children}</section>}
    <dl className="bot-task-identifiers"><div><dt>{zh ? '任务编号' : 'Task ID'}</dt><dd>{task.id}</dd></div>{task.sessionId && <div><dt>DSH Session</dt><dd>{task.sessionId}</dd></div>}</dl>
    </div>}
    </div>
    <footer className="bot-task-actionbar">
      <button className="bot-task-refresh" disabled={busy} onClick={() => void changed()}><BotIcon name="history" />{zh ? '刷新状态' : 'Refresh status'}</button>
      <div>
        {onFollow && botTaskCanFollow(view) && <button className="bot-task-follow-action" disabled={busy} onClick={() => onFollow(task)}><BotIcon name="external" />{['succeeded', 'failed'].includes(task.status) ? zh ? '继续这个任务' : 'Continue this task' : zh ? '跟进这个任务' : 'Follow up in chat'}</button>}
        {active && !stopping && <button className="bot-task-stop-action" disabled={busy} onClick={() => void control({ operation: 'cancel' })}>{zh ? '停止任务' : 'Stop task'}</button>}
        {stopping && <button disabled className="bot-task-stopping-action">{botTaskState(view) === 'stop-unconfirmed' ? zh ? '停止待核实' : 'Stop unconfirmed' : zh ? '正在停止…' : 'Stopping…'}</button>}
        {!stopping && !pausing && ['queued', 'running'].includes(task.status) && <button disabled={busy} onClick={() => void control({ operation: 'pause' })}>{zh ? '暂停任务' : 'Pause task'}</button>}
        {pausing && <button disabled className="bot-task-stopping-action">{botTaskState(view) === 'pause-unconfirmed' ? zh ? '暂停待核实' : 'Pause unconfirmed' : zh ? '正在确认暂停…' : 'Confirming pause…'}</button>}
        {!stopping && task.status === 'paused' && <button className="bot-task-primary" disabled={busy} onClick={() => void control({ operation: 'resume_paused' })}>{zh ? '继续任务' : 'Resume task'}</button>}
        {task.continuationAvailable && task.status === 'waiting' && !stopping && !pausing && <button className="bot-task-primary" disabled={busy} onClick={() => void control({ operation: 'continue' })}>{zh ? '继续任务' : 'Continue task'}</button>}
        {['succeeded', 'failed', 'cancelled'].includes(task.status) && <button disabled={busy} title={zh ? '只移除任务记录，保留原文件与已发送的附件' : 'Remove the task record; keep files and sent attachments'} onClick={() => void control({ operation: 'remove' })}>{zh ? '移除记录' : 'Remove record'}</button>}
      </div>
    </footer>
    {error && <div className="bot-task-control-error" role="alert"><span>{error}</span><button aria-label={zh ? '关闭操作提示' : 'Dismiss operation message'} onClick={() => setError('')}>×</button></div>}
  </article>;
}
