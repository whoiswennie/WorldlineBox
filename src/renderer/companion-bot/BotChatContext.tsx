import { useState } from 'react';
import type { BotBrainContextSummary, BotCompanion, BotCompanionPresence, BotConversation, BotReplyProgress, BotRequest, BotResponse, BotTask, BotTaskSummary } from '../../shared/companion-bot';
import { builtinBotCompanion } from '../../shared/builtin-bot-companions';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotPeerAvatar } from './BotPeerAvatar';
import { BotPresenceText } from './BotPresence';
import { BotGroupOverview } from './BotGroupOverview';
import { botReplyProgressLabel } from './BotReplyProgress';
import { botTaskActive, botTaskActivity, botTaskState, botTaskStatus, botTaskTitle } from './task-presentation';
import './bot-chat-context.css';

type Locale = 'zh-CN' | 'en';
const clock = (value: string | undefined, locale: Locale) => {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  const date = new Date(value), today = new Date();
  return new Intl.DateTimeFormat(locale, { ...(date.toDateString() !== today.toDateString() ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};
const tokens = (value: number, locale: Locale) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const queued = (task: BotTask) => task.status === 'queued' && !task.cancelRequested && !task.pauseRequested;

/** Room-scoped metadata; request measurements are not lifetime token counters. */
export function BotChatContext({ conversation, companions, presence, tasks, taskSummary, brainContexts, locale, onClose, onEdit, onMemory, onTask, onMembers, onContact, onJoinPeer, joiningPeer, request, onChanged }: {
  conversation: BotConversation; companions: readonly BotCompanion[]; presence?: Record<string, BotCompanionPresence>; tasks: readonly BotTask[];
  taskSummary?: BotTaskSummary; brainContexts?: Record<string, BotBrainContextSummary>; locale: Locale;
  onClose(): void; onEdit(companion: BotCompanion): void; onMemory(): void; onTask(id?: string): void; onMembers(): void;
  onContact?(companionId: string): void; request?(input: BotRequest): Promise<BotResponse>; onChanged?(): void;
  onJoinPeer?(): void; joiningPeer?: boolean;
}) {
  const zh = locale === 'zh-CN', direct = conversation.kind === 'direct', person = direct ? companions[0] : undefined;
  const [chosenBrain, setChosenBrain] = useState('');
  const [groupView, setGroupView] = useState<'info' | 'activity'>('info');
  const brain = companions.find(member => member.id === chosenBrain) ?? companions[0];
  const context = brain && brainContexts?.[brain.id]?.conversationId === conversation.id ? brainContexts[brain.id] : undefined;
  const builtin = person ? builtinBotCompanion(person.id) : undefined;
  const active = (taskSummary?.items ?? tasks).filter(task => task.conversationId === conversation.id && botTaskActive(task));
  const ordered = [...active].sort((a, b) => Number(queued(a)) - Number(queued(b)) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  const activeCount = taskSummary?.activeCount ?? active.length, queuedCount = taskSummary?.queuedCount ?? active.filter(queued).length;
  const events = [...new Map(companions.flatMap(member => presence?.[member.id]?.events ?? []).filter(event => event.conversationId === conversation.id).map(event => [event.id, event])).values()].sort((a, b) => b.sequence - a.sequence).slice(0, 3);
  if (conversation.kind === 'peer') return <aside className="bot-chat-context" aria-label={zh ? '聊天信息' : 'Chat information'}>
    <header><span><BotIcon name="profile" />{zh ? '伙伴私聊' : 'Companion conversation'}</span><button type="button" onClick={onClose} aria-expanded="true" aria-label={zh ? '收起聊天信息' : 'Hide chat information'}><BotIcon name="panel-collapse" /></button></header>
    <section className="bot-context-group"><div className="bot-context-person"><BotPeerAvatar companions={companions} /><div><h3>{conversation.title}</h3><p>{zh ? '两位伙伴的真实私聊 · 你正在旁观' : 'A direct conversation between two companions · Observing'}</p></div></div></section>
    <section className="bot-context-peer-members"><h3>{zh ? '私聊双方' : 'Participants'}</h3><p>{zh ? '消息由双方各自的主脑发送。旁观不会把你加入私聊，也不会转入你的其他聊天记录。' : 'Each companion speaks through its own agent. Observing does not add you or transfer your other conversations.'}</p><ul>{companions.map(member => <li key={member.id}><button type="button" onClick={() => onContact?.(member.id)} title={zh ? `与${member.name}私聊` : `Chat with ${member.name}`}><BotAvatar companion={member} presence={presence?.[member.id]} locale={locale} /><span><strong>{member.name}</strong>{presence?.[member.id] && <BotPresenceText presence={presence[member.id]!} locale={locale} />}</span></button></li>)}</ul>
      {onJoinPeer && <button className="bot-context-peer-join" type="button" disabled={joiningPeer} onClick={onJoinPeer}>{zh ? '创建群聊，一起参与' : 'Create a group to participate'}</button>}
    </section>
  </aside>;
  return <aside className="bot-chat-context" aria-label={zh ? '聊天信息' : 'Chat information'}>
    <header><span><BotIcon name="profile" />{zh ? '聊天摘要' : 'Chat summary'}</span><button type="button" onClick={onClose} aria-expanded="true" aria-label={zh ? '收起聊天信息' : 'Hide chat information'} title={zh ? '收起侧栏' : 'Collapse sidebar'}><BotIcon name="panel-collapse" /></button></header>
    {person ? <section className="bot-context-profile"><div className="bot-context-person"><BotAvatar companion={person} /><div><h3>{person.name}</h3>{presence?.[person.id] && <BotPresenceText presence={presence[person.id]!} locale={locale} />}</div></div>
      {builtin?.summary && <p>{builtin.summary}</p>}
      <div className="bot-context-actions"><button type="button" onClick={() => onEdit(person)}><BotIcon name="profile" />{zh ? '伙伴设定' : 'Edit companion'}</button><button type="button" onClick={onMemory}><BotIcon name="memory" />{zh ? '共同记忆' : 'Memories'}</button></div></section>
      : <section className="bot-context-group"><div className="bot-context-person"><BotPeerAvatar companions={companions} /><div><h3>{conversation.title}</h3><p>{zh ? `${conversation.memberIds.length} 位成员${conversation.kind === 'group' ? ' · 你是群主' : ''}` : `${conversation.memberIds.length} members${conversation.kind === 'group' ? ' · You own this group' : ''}`}</p></div></div><button type="button" onClick={conversation.kind === 'group' ? onMembers : onMemory}><BotIcon name={conversation.kind === 'group' ? 'users' : 'memory'} />{conversation.kind === 'group' ? zh ? '管理群成员' : 'Manage members' : zh ? '查看共同记忆' : 'Shared memories'}</button></section>}
    {conversation.kind === 'group' && <><nav className="bot-context-group-tabs" role="tablist" aria-label={zh ? '群聊摘要内容' : 'Group sidebar view'}><button type="button" role="tab" aria-selected={groupView === 'info'} onClick={() => setGroupView('info')}>{zh ? '群资料' : 'Group info'}</button><button type="button" role="tab" aria-selected={groupView === 'activity'} onClick={() => setGroupView('activity')}>{zh ? '主脑与任务' : 'Activity'}{!!activeCount && <span>{activeCount}</span>}</button></nav>{groupView === 'info' && <BotGroupOverview conversation={conversation} companions={companions} presence={presence} locale={locale} request={request} onChanged={onChanged} onMembers={onMembers} onContact={onContact} />}</>}
    {(conversation.kind !== 'group' || groupView === 'activity') && <><section className="bot-context-brain" aria-label={zh ? '主脑上下文摘要' : 'Brain context summary'}>
      <header><h3>{zh ? '主脑动态' : 'Brain activity'}</h3><span className="bot-context-engine">Super Agent</span></header>
      {!direct && companions.length > 1 && <label className="bot-context-brain-picker"><span>{zh ? '查看伙伴' : 'Companion'}</span><select aria-label={zh ? '查看主脑上下文的伙伴' : 'Companion context'} value={brain?.id ?? ''} onChange={event => setChosenBrain(event.target.value)}>{companions.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>}
      <BrainSummary context={context} locale={locale} />
    </section>
    <section className="bot-context-tasks" aria-label={zh ? '任务速览' : 'Task overview'}><header><h3>{conversation.kind === 'group' ? zh ? '群任务速览' : 'Group tasks' : zh ? '任务速览' : 'Task overview'}<span>{activeCount}</span></h3><button type="button" onClick={() => onTask()}>{zh ? '任务中心' : 'Task center'}<span aria-hidden="true">↗</span></button></header>
      {conversation.kind === 'group' && <p className="bot-context-task-scope">{zh ? '本群全部伙伴的任务 · 可到任务中心按伙伴筛选' : 'All companions in this group · filter by owner in Task center'}</p>}
      {!!activeCount && <p className="bot-context-task-counts">{zh ? `共 ${activeCount} 项未结束 · 待办 ${queuedCount} 项` : `${activeCount} unfinished · ${queuedCount} queued`}</p>}
      {ordered.length ? <ol className="bot-context-task-list">{ordered.slice(0, 5).map((task, index) => {
        const owner = companions.find(member => member.id === task.companionId), ownerName = task.companionName || owner?.name || task.companionId;
        return <li key={task.id}><button type="button" className="bot-context-task" onClick={() => onTask(task.id)}><span className="bot-context-task-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span className="bot-context-task-main"><span><strong>{botTaskTitle(task)}</strong><em data-state={botTaskState(task)}>{botTaskStatus(task, locale)}</em></span>
          {!direct && <span className="bot-context-task-owner" title={zh ? `负责伙伴：${ownerName}` : `Owner: ${ownerName}`}><BotAvatar companion={owner} name={ownerName} /><span>{ownerName}</span></span>}
          <small>{botTaskActivity(task, locale)}</small><time dateTime={task.startedAt ?? task.createdAt}>{task.startedAt && clock(task.startedAt, locale) ? `${clock(task.startedAt, locale)} ${zh ? '开始' : 'started'}` : clock(task.createdAt, locale) ? `${clock(task.createdAt, locale)} ${zh ? '提交' : 'submitted'}` : zh ? '时间未记录' : 'Time unavailable'}</time></span><span className="bot-context-task-open" aria-hidden="true">›</span></button></li>;
      })}</ol>
        : <div className="bot-context-task-empty"><BotIcon name="tasks" /><p>{zh ? '暂无待办任务' : 'No pending tasks'}</p></div>}
      {activeCount > 5 && <button className="bot-context-more-tasks" type="button" onClick={() => onTask()}>{zh ? `还有 ${activeCount - 5} 项，前往任务中心` : `${activeCount - 5} more in Task center`}<span aria-hidden="true">→</span></button>}
    </section>
    {!!events.length && <section className="bot-context-events" aria-label={zh ? '最近动态' : 'Recent activity'}><header><h3>{zh ? '最近动态' : 'Recent activity'}</h3></header><ol>{events.map(event => <li key={event.id}><button type="button" onClick={() => onTask(event.taskId)}><span className={`bot-context-event-dot is-${event.kind}`} /><span><strong>{event.status === 'cancelled' ? zh ? '任务已停止' : 'Task stopped' : event.kind === 'task-started' ? zh ? '任务开始' : 'Task started' : event.kind === 'task-completed' ? zh ? '任务完成' : 'Task completed' : zh ? '任务需要处理' : 'Task needs attention'}</strong><small>{event.title}</small></span><time dateTime={event.occurredAt}>{clock(event.occurredAt, locale)}</time></button></li>)}</ol></section>}</>}
  </aside>;
}

function BrainSummary({ context, locale }: { context?: BotBrainContextSummary; locale: Locale }) {
  const zh = locale === 'zh-CN', last = context?.lastRequest;
  const phase = context?.phase ? botReplyProgressLabel('running', { phase: context.phase as BotReplyProgress['phase'] }, locale) : undefined;
  const label = phase ?? (context?.runningMessages ? zh ? '正在处理消息' : 'Processing messages' : context?.queuedMessages ? zh ? '等待处理消息' : 'Messages queued' : zh ? '等待新消息' : 'Waiting for messages');
  const bound = last && Math.min(100, last.inputTokensUpperBound / last.window * 100);
  return <><p className="bot-context-brain-phase" role="status"><span className={context?.runningMessages ? 'is-working' : ''} />{label}{!!context?.queuedMessages && <small>{zh ? `${context.queuedMessages} 条待处理` : `${context.queuedMessages} pending`}</small>}</p>
    {last ? <div className="bot-context-capacity"><header><span>{zh ? '最近请求上下文' : 'Last request context'}</span><small title={zh ? '输入按 UTF-8 字节作保守上界估算；不是累计消耗，也不是精确分词。' : 'Conservative UTF-8 byte upper bound; not cumulative usage or exact tokenization.'}>{zh ? '保守估计' : 'Upper bound'}</small></header><div className="bot-context-token-value" title={`${new Intl.NumberFormat(locale).format(last.inputTokensUpperBound)} / ${new Intl.NumberFormat(locale).format(last.window)} tokens`}><strong>≤ {tokens(last.inputTokensUpperBound, locale)}</strong><span>/ {tokens(last.window, locale)} tokens</span></div><div className="bot-context-token-meter" role="meter" aria-label={zh ? '最近请求输入占窗口比例的保守上界' : 'Last request input upper bound as a fraction of its window'} aria-valuemin={0} aria-valuemax={last.window} aria-valuenow={Math.min(last.inputTokensUpperBound, last.window)}><span style={{ width: `${bound}%` }} /></div>
      <div className="bot-context-token-meta"><span>{last.purpose === 'compaction' ? zh ? '整理请求' : 'Compaction request' : zh ? '回复请求' : 'Reply request'}</span><time dateTime={last.measuredAt}>{clock(last.measuredAt, locale)}</time></div>
      {last.reportedUsage?.inputTokens !== undefined && <p className="bot-context-reported-tokens">{zh ? '模型报告输入' : 'Reported input'} <strong>{tokens(last.reportedUsage.inputTokens, locale)}</strong> tokens</p>}
    </div> : <p className="bot-context-no-metrics">{zh ? '尚无本轮上下文用量记录' : 'No request context measurement yet'}</p>}
    {context && <dl className="bot-context-lifecycle"><div><dt>{zh ? '已处理轮次' : 'Processed turns'}</dt><dd>{context.retention.completedTurns}</dd></div><div><dt>{zh ? '整理尝试' : 'Compaction attempts'}</dt><dd>{context.compactionRequests}{zh ? ' 次' : ''}</dd></div></dl>}
  </>;
}
