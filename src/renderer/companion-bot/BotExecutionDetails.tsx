import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { BotExecution, BotExecutionStep, BotResponse } from '../../shared/companion-bot';
import { botExecutionRounds } from '../../shared/companion-bot-execution';
import { BotIcon } from './BotIcon';
import './bot-execution.css';

type Locale = 'zh-CN' | 'en';
export type BotExecutionAnswer = (questionId: string, text: string) => Promise<BotResponse>;
export type BotExecutionContinue = (requestId: string) => Promise<BotResponse>;

/** The transport supplies these events; the chat never interprets or rewrites a result. */
export function BotExecutionDetails({ execution, locale, onAnswer, onContinue }: { execution: BotExecution; locale: Locale; onAnswer?: BotExecutionAnswer; onContinue?: BotExecutionContinue }) {
  if (execution.interruption) return <ExecutionContinuation key={`${execution.sessionId ?? ''}:interrupted`} locale={locale} onContinue={onContinue} interruption={execution.interruption.state} />;
  return <ExecutionDetails key={`${execution.sessionId ?? ''}:${execution.status}`} execution={execution} locale={locale} onAnswer={onAnswer} onContinue={onContinue} />;
}

function ExecutionDetails({ execution, locale, onAnswer, onContinue }: { execution: BotExecution; locale: Locale; onAnswer?: BotExecutionAnswer; onContinue?: BotExecutionContinue }) {
  const zh = locale === 'zh-CN', running = execution.status === 'running', [expanded, setExpanded] = useState(false), id = useId();
  const contents=useRef<HTMLDivElement>(null),following=useRef(true);
  useLayoutEffect(()=>{if(running&&expanded&&following.current&&contents.current)contents.current.scrollTop=contents.current.scrollHeight;},[execution.steps,expanded,running]);
  const rounds = botExecutionRounds(execution.steps.filter(step=>!['session_created','session_resumed'].includes(step.type))).filter(round=>round.step!==undefined||round.steps.some(step=>step.type!=='status'));
  const latest = execution.steps.reduce<BotExecution['steps'][number] | undefined>((latest, step) => !latest || Date.parse(step.updatedAt ?? step.at) >= Date.parse(latest.updatedAt ?? latest.at) ? step : latest, undefined);
  const status = running ? execution.question ? zh ? '等待你的回复' : 'Waiting for your reply' : latest?.type === 'reasoning' ? zh ? '正在思考' : 'Thinking' : latest?.summary || execution.phase || (zh ? 'DSH 正在处理' : 'DSH is working')
    : execution.continuation ? zh ? '等待继续' : 'Ready to continue' : execution.status === 'succeeded' ? zh ? '已完成' : 'Completed' : execution.status === 'failed' ? zh ? '执行失败' : 'Execution failed' : zh ? '已停止' : 'Stopped';
  const toolCount = rounds.flatMap(round => round.steps).filter(step => step.type === 'tool_call').length;
  const stepCount = rounds.filter(round => round.step !== undefined).length;
  const currentStage=running&&!execution.question&&latest?.nativeStep!==undefined&&!['step_start','step_end','turn_end'].includes(latest.stage??'')
    ? `${zh?`第 ${latest.nativeStep} 步`:`Step ${latest.nativeStep}`} · ${status}`:status;
  return <section className="bot-execution" data-status={execution.status} data-native-session={execution.sessionId} aria-label={zh ? 'DSH 执行过程' : 'DSH execution'}>
    <button className="bot-execution-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <span className="bot-execution-state-icon"><BotIcon name={running ? 'clock' : execution.status === 'succeeded' ? 'check' : 'notice'} /></span>
      <span className="bot-execution-status">{currentStage}</span>
      <span className="bot-execution-count">{stepCount ? zh ? `${stepCount} 步` : `${stepCount} steps` : ''}{toolCount ? zh ? ` · ${toolCount} 次工具` : ` · ${toolCount} tools` : ''}</span>
      <span className="bot-execution-action"><span className="bot-sr-only">{expanded ? zh ? '收起过程' : 'Hide details' : zh ? '查看过程' : 'Show details'}</span><BotIcon name="chevron-down" /></span>
    </button>
    <div id={id} hidden={!expanded} className="bot-execution-contents" ref={contents} onScroll={event=>{const node=event.currentTarget;following.current=node.scrollHeight-node.scrollTop-node.clientHeight<32;}}>
      {rounds.map(round => <details className="bot-execution-round" key={round.id}>
        <summary><BotIcon name="chevron-down" /><span className="bot-execution-round-title">{round.sessionId && round.sessionId !== execution.sessionId ? zh ? '子会话 · ' : 'Subagent · ' : ''}{round.step !== undefined ? zh ? `第 ${round.step} 步` : `Step ${round.step}` : zh ? '其他进展' : 'Other progress'}</span><small>{round.steps.filter(step=>step.type==='tool_call').length ? zh ? `${round.steps.filter(step=>step.type==='tool_call').length} 次工具调用` : `${round.steps.filter(step=>step.type==='tool_call').length} tool calls` : zh ? '思考' : 'Thinking'}</small></summary>
        <ol>{round.steps.map(step => <li key={step.id} data-type={step.type} data-status={step.outputState ?? step.status}>
          <ExecutionPhase step={step} running={running} locale={locale} />
        </li>)}</ol>
      </details>)}
    </div>
    {running && execution.question && <ExecutionQuestion key={execution.question.id} question={execution.question} locale={locale} onAnswer={onAnswer} />}
    {!running && execution.continuation && <ExecutionContinuation key={execution.continuation.checkpoint} locale={locale} onContinue={onContinue} />}
  </section>;
}

function ExecutionContinuation({ locale, onContinue, interruption }: { locale: Locale; onContinue?: BotExecutionContinue; interruption?: 'stopping' | 'ready' }) {
  const zh=locale==='zh-CN',[requestId]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false),[error,setError]=useState('');
  const stopping = interruption === 'stopping';
  return <div className={`bot-execution-continuation${interruption ? ' is-interrupted' : ''}`}><p role={interruption ? 'status' : undefined}>{interruption ? <><BotIcon name="clock" />{stopping ? zh ? '正在停止，保留当前进展…' : 'Stopping and saving progress…' : zh ? '已中断 · 进展已保留' : 'Interrupted · progress saved'}</> : zh?'本轮输出已达上限，文件和过程已保留。继续执行会复用原来的 DSH 会话。':'This output limit was reached. Files and progress are saved; continue in the same DSH session.'}</p>
    <button type="button" title={interruption ? zh ? '接回原来的 DSH 会话，无需发送新消息' : 'Continue the original DSH session without sending a new message' : undefined} disabled={!onContinue||busy||accepted||stopping} onClick={()=>{
      if(!onContinue||busy||accepted)return;setBusy(true);setError('');
      void onContinue(requestId).then(result=>{if(result.ok)setAccepted(true);else setError(result.error||(zh?'暂时无法继续，请重试。':'Could not continue. Try again.'));}).catch(()=>setError(zh?'连接中断，请重试。':'Connection interrupted. Try again.')).finally(()=>setBusy(false));
    }}>{accepted?zh?'已继续':'Continued':busy?zh?'正在继续…':'Continuing…':stopping?zh?'正在停止…':'Stopping…':zh?'继续执行':'Continue execution'}</button>{error&&<small role="alert">{error}</small>}
  </div>;
}

function ExecutionPhase({ step, running, locale }: { step: BotExecutionStep; running: boolean; locale: Locale }) {
  const zh = locale === 'zh-CN', thinking = step.type === 'reasoning', tool = step.type === 'tool_call' || step.type === 'tool_result';
  const interrupted = step.outputState === 'abandoned', complete = step.outputState === 'committed' || step.status === 'completed' || step.output !== undefined;
  const failed = step.status === 'failed' || step.summary?.includes('工具执行失败');
  const labels: Record<string, [string, string]> = { read: ['读取文件', 'Read file'], read_file: ['读取文件', 'Read file'], write: ['写入文件', 'Write file'], edit: ['编辑文件', 'Edit file'],
    shell: ['运行命令', 'Run command'], pwsh: ['运行命令', 'Run command'], bash: ['运行命令', 'Run command'], web_fetch:['读取网页','Read page'],web_search:['搜索网页','Search web'], present: ['交付文件', 'Deliver files'], present_files: ['交付文件', 'Deliver files'],
    message_peer: ['伙伴协作', 'Collaborate'], companion_contact: ['伙伴私聊', 'Contact companion'], sessions_spawn: ['启动子会话', 'Start subagent'] };
  const name = Object.keys(labels).find(name => step.toolName === name || step.toolName?.endsWith('_' + name));
  const title = thinking ? zh ? '思考' : 'Thinking' : tool ? name ? labels[name]![zh ? 0 : 1] : zh ? '调用工具' : 'Tool call'
    : step.type === 'child_text' ? zh ? '子会话回复' : 'Subagent reply' : step.type === 'artifacts' ? zh ? '文件已交付' : 'Files delivered' : step.summary || (zh ? '处理进展' : 'Progress');
  const badge = failed ? zh ? '失败' : 'Failed' : interrupted ? zh ? '已中断' : 'Interrupted' : complete ? zh ? '已完成' : 'Done' : running ? zh ? '进行中' : 'In progress' : zh ? '已记录' : 'Recorded';
  const icon = thinking ? 'sparkles' : tool ? 'settings' : step.type === 'artifacts' ? 'file' : 'clock';
  let preview='';
  if(tool&&step.text){try{const args=JSON.parse(step.text) as Record<string,unknown>;preview=String(args.description??args.path??args.file_path??args.url??args.query??args.command??step.toolName??'').replace(/\s+/gu,' ').slice(0,180);}catch{preview=step.toolName??'';}}
  const heading = <><span className="bot-execution-phase-icon"><BotIcon name={icon} /></span><span className="bot-execution-phase-title">{title}</span>{preview&&<span className="bot-execution-preview">{preview}</span>}{(failed||(!complete&&running&&!thinking))&&<span className="bot-execution-phase-badge">{badge}</span>}</>;
  if (!step.text && !step.output) return <div className="bot-execution-notice">{heading}</div>;
  return <details className={`bot-execution-phase ${thinking ? 'bot-execution-reasoning' : tool ? 'bot-execution-tool' : ''}${failed ? ' is-error' : ''}`}>
    <summary>{heading}<BotIcon name="chevron-down" /></summary>
    <div className="bot-execution-phase-body">
      {step.text && <>{tool && <small>{zh ? '输入参数' : 'Input'}</small>}<pre>{step.text}</pre></>}
      {step.output && <><small>{zh ? '工具结果' : 'Result'}</small><pre>{step.output}</pre></>}
    </div>
  </details>;
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
