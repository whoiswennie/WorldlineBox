import type { BotTask } from '../../shared/companion-bot';
import { botTaskClockRunning } from '../../shared/companion-bot-task-clock';

const terminal = (task: BotTask) => ['succeeded', 'failed', 'cancelled'].includes(task.status);
// Older task records can carry a stop/pause intent alongside a live status.
// Present the user's action consistently while the store normalizes that record.
export const botTaskStopping = (task: BotTask) => !terminal(task) && (task.cancelRequested === true || ['stopping', 'stop-requesting', 'stop-request-unknown', 'stop-unconfirmed'].includes(task.progress?.phase ?? task.status));
export const botTaskPausing = (task: BotTask) => !terminal(task) && task.status !== 'paused' && !botTaskStopping(task) && (task.pauseRequested === true || ['pausing', 'pause-requesting', 'pause-request-unknown', 'pause-unconfirmed'].includes(task.progress?.phase ?? task.status));
export const botTaskState = (task: BotTask) => botTaskStopping(task) ? 'cancelled' : botTaskPausing(task) ? 'paused' : task.status;
export const botTaskActive = (task: BotTask) => ['queued', 'running', 'waiting', 'unknown', 'paused'].includes(botTaskState(task));
export const botTaskTimerRunning = (task: BotTask) => !['paused', 'cancelled'].includes(botTaskState(task)) && botTaskClockRunning(task);
export const botTaskCanFollow = (task: BotTask) => task.followupAvailable !== false && !task.humanStopped && !botTaskStopping(task) && !botTaskPausing(task)
  && (['queued', 'running', 'waiting', 'paused'].includes(botTaskState(task)) || task.followupAvailable === true && ['succeeded', 'failed'].includes(task.status));
export const botTaskTitle = (task: BotTask) => task.title?.trim() || task.goal.trim().split(/\r?\n/u)[0]!.slice(0, 64) || 'DSH';
const statusLabels: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['执行中', 'Running'], waiting: ['等待回答', 'Needs an answer'],
  unknown: ['结果待核实', 'Needs verification'], succeeded: ['已完成', 'Completed'], failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'],
  paused: ['已暂停', 'Paused'],
};
export const botTaskStatus = (task: BotTask, locale: 'zh-CN' | 'en') => botTaskState(task) === 'waiting' && task.continuationAvailable
  ? locale === 'zh-CN' ? '等待继续' : 'Waiting to continue' : statusLabels[botTaskState(task)]?.[locale === 'zh-CN' ? 0 : 1] ?? botTaskState(task);

const phases: Record<string, [string, string]> = {
  queued: ['等待执行', 'Waiting to start'], connecting: ['正在连接 DSH', 'Connecting to DSH'], 'waiting-runtime': ['正在连接 DSH', 'Connecting to DSH'],
  'waiting-model': ['等待执行器响应', 'Waiting for the executor'], generating: ['正在处理任务', 'Working on the task'],
  'using-tool': ['正在执行工具', 'Executing a tool'], 'executing-tool': ['正在执行工具', 'Executing a tool'],
  finalizing: ['正在整理结果', 'Preparing the result'], 'preparing-result': ['正在整理结果', 'Preparing the result'],
  retrying: ['正在恢复原任务', 'Reconnecting to the task'], recovering: ['正在核对原任务', 'Reconciling the task'], stopping: ['停止任务', 'Stop task'],
  compacting: ['正在整理任务上下文', 'Organizing task context'], waiting: ['等待继续', 'Waiting to continue'],
  continuing: ['正在接续任务输出', 'Continuing task output'], 'waiting-approval': ['等待 DSH 权限确认', 'Waiting for DSH permission'],
  'stop-requesting': ['停止任务', 'Stop task'], 'stop-unconfirmed': ['已停止', 'Stopped'], 'stop-request-unknown': ['已停止', 'Stopped'],
  pausing: ['暂停任务', 'Pause task'], 'pause-requesting': ['暂停任务', 'Pause task'], 'pause-unconfirmed': ['已暂停', 'Paused'], 'pause-request-unknown': ['已暂停', 'Paused'], paused: ['已暂停', 'Paused'],
  succeeded: ['执行完成', 'Completed'], failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'],
};
export const botTaskPhase = (phase: string, locale: 'zh-CN' | 'en') => phases[phase]?.[locale === 'zh-CN' ? 0 : 1] ?? (locale === 'zh-CN' ? '执行状态已更新' : 'Execution state updated');
export const botTaskTool = (name?: string) => name && /^[\w.:/-]{1,80}$/u.test(name) ? name : undefined;
export function botTaskActivity(task: BotTask, locale: 'zh-CN' | 'en'): string {
  if (botTaskState(task) === 'paused') return locale === 'zh-CN' ? '任务已暂停，进度已保留' : 'Task paused; progress is preserved';
  if (!botTaskActive(task) || task.status === 'unknown') return botTaskStatus(task, locale);
  if (task.continuationAvailable) return locale === 'zh-CN' ? '进度已保留，等待继续' : 'Progress saved; waiting to continue';
  if (task.status === 'waiting') return botTaskStatus(task, locale);
  if (!task.progress) return botTaskStatus(task, locale);
  const tool = task.progress.phase === 'using-tool' ? botTaskTool(task.progress.toolName) : undefined;
  return `${botTaskPhase(task.progress.phase, locale)}${tool ? ` · ${tool}` : ''}`;
}

export function botTaskHint(task: BotTask, locale: 'zh-CN' | 'en'): string {
  const zh = locale === 'zh-CN';
  if (botTaskState(task) === 'paused') return zh ? '任务已暂停，用时已冻结。继续时会沿用原任务和已有进度。' : 'The task is paused and its timer is frozen. Resume the same task with its saved progress.';
  if (botTaskState(task) === 'cancelled') return zh ? '任务已停止，用时已冻结。已有结果和文件会保留。' : 'The task is stopped and its timer is frozen. Existing results and files are retained.';
  if (task.status === 'unknown') return zh ? '上次操作是否完成尚未确认。先核实实际结果，系统会保留原任务并避免重复执行。' : 'The last operation has an unconfirmed outcome. Verify its actual effect before continuing the same task.';
  if (task.status === 'queued' && task.progress?.phase === 'recovering') return zh ? '连接暂时中断，正在重新接入原任务。可在执行记录查看连接原因和已尝试次数。' : 'The connection was interrupted. The app is reconnecting to the original task; connection details are available in Activity.';
  if (task.status === 'queued') return zh ? '任务已保存，等待执行资源就绪。开始执行和完成时都会更新这里。' : 'The task is saved and waiting for an available executor. This view updates when execution starts or finishes.';
  if (task.continuationAvailable && task.status === 'waiting') return zh ? '本轮输出达到上限。已有进度和工作区已保留，可以继续原任务。' : 'This turn reached its output limit. Progress and the workspace are preserved so the same task can continue.';
  if (task.status === 'waiting') return zh ? '执行器需要你的回答，确认后将继续这个任务。' : 'The executor needs your answer before the same task can continue.';
  if (task.progress?.phase === 'waiting-approval') return zh ? 'DSH 正在等待权限确认。请在共享执行器窗口处理，原任务和工作区会保留。' : 'DSH is waiting for permission approval in the shared executor window. The original task and workspace are preserved.';
  if (task.status === 'failed') return zh ? '任务未能完成。已有记录和失败原因会保留在这里。' : 'The task did not complete. Its records and failure details remain available here.';
  if (task.status === 'succeeded') return zh ? '执行结果已返回。伙伴会在聊天中与你沟通，原始执行结果可在这里查看。' : 'Execution has returned a result. Your companion reports back in chat, and the executor output is available here.';
  return zh ? '执行器正在处理这项任务。这里展示实际收到的执行状态，不代表估算完成比例。' : 'The executor is working on this task. The status reflects received events rather than an estimated completion percentage.';
}

export function botTaskStages(task: BotTask, locale: 'zh-CN' | 'en') {
  const zh = locale === 'zh-CN', phases = new Set([...(task.activity?.map(item => item.phase) ?? []), task.progress?.phase]);
  const execution = ['waiting-model', 'using-tool', 'executing-tool', 'generating', 'compacting', 'continuing', 'waiting-approval'];
  const state = botTaskState(task), executed = execution.some(phase => phases.has(phase)), result = ['succeeded', 'failed', 'cancelled'].includes(state);
  const returned = phases.has('finalizing') || task.status === 'succeeded';
  const connecting = phases.has('connecting') || phases.has('recovering'), paused = state === 'paused';
  const suspendedCaption = paused ? zh ? '已暂停' : 'Paused' : zh ? '已停止' : 'Stopped';
  return [
    { label: zh ? '接收任务' : 'Received', state: 'complete', caption: zh ? '已保存' : 'Saved' },
    { label: zh ? '连接执行器' : 'Connection', state: executed || returned ? 'complete' : connecting && !result && !paused ? 'current' : connecting && result ? 'ended' : 'pending', caption: executed || returned ? zh ? '已接入' : 'Connected' : result ? zh ? '未接入' : 'Not connected' : connecting ? result ? zh ? '未完成' : 'Unfinished' : zh ? '连接中' : 'Connecting' : zh ? '等待连接' : 'Not connected' },
    { label: zh ? '执行任务' : 'Execution', state: returned ? 'complete' : executed && result ? 'ended' : executed && !paused ? 'current' : 'pending', caption: returned ? zh ? '已返回' : 'Returned' : (paused || state === 'cancelled') ? suspendedCaption : executed ? result ? zh ? '已结束' : 'Ended' : zh ? '执行中' : 'Working' : zh ? '等待执行' : 'Not started' },
    { label: zh ? '处理结果' : 'Outcome', state: result ? task.status === 'succeeded' ? 'complete' : 'ended' : phases.has('finalizing') ? 'current' : 'pending', caption: result ? botTaskStatus(task, locale) : zh ? '等待结果' : 'Awaiting outcome' },
  ];
}
