import { useId, useState } from 'react';
import type { BotExecution, BotResponse } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';
import './bot-execution.css';

type Locale = 'zh-CN' | 'en';
export type BotExecutionAnswer = (questionId: string, text: string) => Promise<BotResponse>;

/** The transport supplies these events; the chat never interprets or rewrites a result. */
export function BotExecutionDetails({ execution, locale, onAnswer }: { execution: BotExecution; locale: Locale; onAnswer?: BotExecutionAnswer }) {
  return <ExecutionDetails key={`${execution.sessionId ?? ''}:${execution.status}`} execution={execution} locale={locale} onAnswer={onAnswer} />;
}

function ExecutionDetails({ execution, locale, onAnswer }: { execution: BotExecution; locale: Locale; onAnswer?: BotExecutionAnswer }) {
  const zh = locale === 'zh-CN', running = execution.status === 'running', [expanded, setExpanded] = useState(running), id = useId();
  const latest = execution.steps.at(-1);
  const status = running ? execution.question ? zh ? '等待你的回复' : 'Waiting for your reply' : latest?.summary || execution.phase || (zh ? 'DSH 正在处理' : 'DSH is working')
    : execution.status === 'succeeded' ? zh ? '已完成' : 'Completed' : execution.status === 'failed' ? zh ? '执行失败' : 'Execution failed' : zh ? '已停止' : 'Stopped';
  return <section className="bot-execution" data-status={execution.status} aria-label={zh ? 'DSH 执行过程' : 'DSH execution'}>
    <button className="bot-execution-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <BotIcon name={running ? 'clock' : 'check'} />
      <span className="bot-execution-status">{status}</span>
      <span className="bot-execution-action"><span>{expanded ? zh ? '收起过程' : 'Hide details' : zh ? '查看过程' : 'Show details'}</span><BotIcon name="chevron-down" /></span>
    </button>
    <div id={id} hidden={!expanded} className="bot-execution-contents">
      {execution.sessionId && <p className="bot-execution-session">DSH · <code>{execution.sessionId}</code></p>}
      <ol>{execution.steps.map(step => <li key={step.id} data-type={step.type} data-status={step.status}>
        <div className="bot-execution-step"><span>{step.summary || step.toolName || step.type}</span>{step.toolName && step.summary && <code>{step.toolName}</code>}{Number.isFinite(Date.parse(step.at)) && <time dateTime={step.at}>{new Date(step.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}</time>}</div>
        {step.text && <details><summary>{zh ? '内容' : 'Content'}</summary><pre>{step.text}</pre></details>}
      </li>)}</ol>
    </div>
    {running && execution.question && <ExecutionQuestion key={execution.question.id} question={execution.question} locale={locale} onAnswer={onAnswer} />}
  </section>;
}

function ExecutionQuestion({ question, locale, onAnswer }: { question: NonNullable<BotExecution['question']>; locale: Locale; onAnswer?: BotExecutionAnswer }) {
  const zh = locale === 'zh-CN', [text, setText] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  return <form className="bot-execution-question" onSubmit={event => {
    event.preventDefault();
    if (!onAnswer || busy || sent || !text.trim()) return;
    setBusy(true); setError('');
    void onAnswer(question.id, text.trim()).then(result => {
      if (result.ok) setSent(true); else setError(result.error || (zh ? '回复未送达，请重试。' : 'Reply was not delivered. Try again.'));
    }).catch(() => setError(zh ? '回复未送达，请重试。' : 'Reply was not delivered. Try again.')).finally(() => setBusy(false));
  }}>
    <p>{question.text}</p>
    {sent ? <p role="status">{zh ? '已回复，等待会话继续…' : 'Reply sent. Waiting for the session to continue…'}</p> : <><textarea aria-label={zh ? '回复 DSH 问题' : 'Reply to DSH question'} value={text} onChange={event => setText(event.target.value)} maxLength={12000} disabled={busy || !onAnswer} rows={2} /><button type="submit" disabled={!text.trim() || busy || !onAnswer}>{busy ? zh ? '正在回复…' : 'Sending…' : zh ? '回复并继续' : 'Reply and continue'}</button></>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
