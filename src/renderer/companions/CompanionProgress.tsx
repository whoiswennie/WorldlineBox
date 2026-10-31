import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CompanionAction } from '../../shared/companions';
import { Icon } from '../Icons';
import { DSH_EXECUTION_ACCESS_OPTIONS } from '../../shared/dsh-access';
import { MessageContent } from './MessageContent';
import { companionTimestamp, companionTimezone } from '../../shared/companion-time';
import type { DshRecordPage, DshRecordQuery } from '../../shared/dsh-task-record';
import { DshRecordViewer } from './DshRecordViewer';
import { companionCapabilityDiagnostic, companionCapabilityTitle } from './companion-capability-presentation';
import { companionDshPendingApproval } from '../../shared/companion-dsh-receipt';

const statusLabels: Record<CompanionAction['status'], string> = { queued: '等待处理', running: '正在处理', succeeded: '已返回结果', failed: '处理失败', cancelled: '已停止', interrupted: '执行中断' };
const stageLabels: Record<string, string> = { queued: '等待执行', starting: '正在启动', running: '正在执行', completed: '已完成', failed: '执行失败', cancelled: '已停止', waiting_approval: '等待操作确认', planning: '正在制定计划', executing: '正在执行操作', finishing: '正在整理结果' };

/** One clock for the visible chat; hiding the module stops only this UI timer. */
export function useCompanionClock(running: boolean, isActive: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !isActive) return;
    const tick = () => setNow(Date.now());
    void Promise.resolve().then(tick);
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, isActive]);
  return now;
}

export function elapsedTime(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '0 秒';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}

export function CompanionActionCard({ action, now, onStop, onGuide, onResume, onTerminate, compact = false, defaultShowProgress = false, onOpenUrl, onReadRecord }: { action: CompanionAction; now: number; onStop: () => void; onGuide?: () => void; onResume?: () => void | Promise<unknown>; onTerminate?: () => void | Promise<unknown>; compact?: boolean; defaultShowProgress?: boolean; onOpenUrl?: (url: string) => void; onReadRecord?: (query: DshRecordQuery) => Promise<DshRecordPage | undefined> }) {
  const [showProgress, setShowProgress] = useState(defaultShowProgress);
  const [follow, setFollow] = useState(true);
  const [operationBusy, setOperationBusy] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const running = action.status === 'queued' || action.status === 'running';
  const nativeRecord = !!action.taskId && (!action.capability || action.capability.name === 'think');
  const events = (action.events ?? []).filter(event => !/(?:^|[._-])(reasoning|thinking|analysis)(?:$|[._-])/i.test(event.type)).sort((a, b) => a.sequence - b.sequence);
  const last = events.at(-1);
  const access = action.accessMode && DSH_EXECUTION_ACCESS_OPTIONS.find(option => option.value === action.accessMode);
  const label = companionDshPendingApproval(action) ? '等待你在 DSH 中确认权限' : running && action.stage ? stageLabels[action.stage] || companionCapabilityDiagnostic(action.stage) : statusLabels[action.status];
  useLayoutEffect(() => { if (showProgress && follow && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [action.events, showProgress, follow]);
  return <article className={`companions-action-card${compact ? ' is-compact' : ''}`} data-companion-action={action.id}>
    <div className="companions-action-card-heading"><span className="companions-action-card-symbol"><Icon name="activity" /></span><strong>{companionCapabilityTitle(action)}</strong>{running && !action.capability && <button className="companions-stop-action" aria-label={`停止处理 ${action.id}`} title="停止这件事" onClick={onStop}><Icon name="stop" /><span>停止</span></button>}</div>
    <div className="companions-action-card-status"><span data-status={action.status}><i />{label}{access && <small className="companions-action-access" title={access.description} aria-label={`执行权限：${access.label}`}>{access.label}</small>}</span><time>已用时 {elapsedTime(action.attemptCreatedAt || action.createdAt, running ? now : new Date(action.updatedAt).getTime())}</time></div>
    {defaultShowProgress && <dl className="companions-task-times"><div><dt>创建时间</dt><dd><time dateTime={action.createdAt}>{companionTimestamp(action.createdAt)}</time></dd></div><div><dt>开始时间</dt><dd>{action.startedAt ? <time dateTime={action.startedAt}>{companionTimestamp(action.startedAt)}</time> : running ? '等待启动' : '尚未进入执行阶段'}</dd></div><div><dt>{running ? '最后更新' : action.finishedAt ? '结束时间' : '记录更新时间'}</dt><dd><time dateTime={action.finishedAt || action.updatedAt}>{companionTimestamp(action.finishedAt || action.updatedAt)}</time></dd></div><div><dt>显示时区</dt><dd>{companionTimezone(action.createdAt)}</dd></div></dl>}
    {last ? <p className="companions-action-latest-step">{last.toolName && <strong>{last.toolName} · </strong>}{companionCapabilityDiagnostic(last.summary)}</p> : running && <p className="companions-action-latest-step is-quiet">等待执行过程回传</p>}
    <button className="companions-progress-toggle" type="button" aria-expanded={showProgress} onClick={() => setShowProgress(!showProgress)}><Icon name="activity" />{showProgress ? '收起实时进度' : '实时查看进度'}<span>{events.length ? `${events.length} 条记录` : running ? '正在连接' : '暂无记录'}</span></button>
    {running && onGuide && !action.capability && <button className="companions-guide-task" onClick={onGuide}>给这件事补充要求</button>}
    {!action.capability && (action.canResume && onResume || running && action.pid && onTerminate) && <div className="companions-task-controls">{action.canResume && onResume && <button className="companion-secondary-button" disabled={operationBusy} onClick={() => { setOperationBusy(true); void Promise.resolve(onResume()).finally(() => setOperationBusy(false)); }}>{operationBusy ? '正在恢复…' : '从上次进度继续'}</button>}{running && action.pid && onTerminate && <button className="companions-terminate-task" disabled={operationBusy} title="结束这条任务拥有的 CLI 进程，可稍后恢复" onClick={() => { setOperationBusy(true); void Promise.resolve(onTerminate()).finally(() => setOperationBusy(false)); }}>结束执行进程{action.pid ? ` · PID ${action.pid}` : ''}</button>}{(action.attempt ?? 1) > 1 && <small>第 {action.attempt} 次运行 · 沿用原任务</small>}</div>}
    {showProgress && <section className="companions-live-progress" aria-label={`${action.title}的实时进度`}><header><strong>执行过程</strong><span>{running ? '实时更新' : '已保存'}</span>{!follow && <button onClick={() => setFollow(true)}>跟随最新</button>}</header><div ref={outputRef} className="companions-live-output" onScroll={event => { const node = event.currentTarget; setFollow(node.scrollHeight - node.clientHeight - node.scrollTop < 40); }}>
      {!events.length && <p className="companions-progress-empty">{running ? '正在准备能力环境，过程将在这里实时出现。' : '没有保留的过程记录。'}</p>}
      {events.map(event => <article key={event.streamId ?? event.sequence} data-progress-kind={event.contentKind || 'status'}><div className="companions-progress-event-heading"><time dateTime={event.receivedAt} title={companionTimezone(event.receivedAt)}>{companionTimestamp(event.receivedAt)}</time><strong>{event.toolName || (event.contentKind === 'message' ? '输出' : '状态')}</strong><span>{event.summary}</span>{event.outputState && <small>{event.outputState === 'draft' ? '生成中' : event.outputState === 'abandoned' ? '已放弃，未执行' : '已确认'}</small>}</div>{event.content && (event.contentKind === 'message' ? <MessageContent content={event.content} onOpenUrl={onOpenUrl} /> : <pre>{event.content}</pre>)}</article>)}
    </div></section>}
    {action.error && <><p className="companions-action-error">{companionCapabilityDiagnostic(action.error)}</p>{companionCapabilityDiagnostic(action.error) !== action.error && <details className="companions-action-result"><summary>原始错误信息</summary><pre>{action.error}</pre></details>}</>}
    {defaultShowProgress && (!action.capability || nativeRecord) && action.executionSummary && <div className="companions-execution-summary"><div><span>{action.executionSummary.turns} 轮</span><span>{action.executionSummary.steps} 步</span><span>{action.executionSummary.toolCalls} 次工具调用</span><span>{action.executionSummary.recordCount} 条存档</span></div><small>记录 ID</small><code>{action.executionSummary.recordId}</code></div>}
    {defaultShowProgress && nativeRecord && action.taskId && onReadRecord && <details className="companions-record-details"><summary>按段查看完整记录</summary><DshRecordViewer recordId={action.executionSummary?.recordId ?? action.taskId} read={onReadRecord} onOpenUrl={onOpenUrl} /></details>}
    {action.result && <details className="companions-action-result"><summary>查看结果</summary><MessageContent content={action.result} onOpenUrl={onOpenUrl} /></details>}
  </article>;
}
