import type { BotTask } from '../../shared/companion-bot';

export const botTaskActive = (task: BotTask) => ['queued', 'running', 'waiting', 'unknown', 'paused'].includes(task.status);
export const botTaskCanFollow = (task: BotTask) => task.followupAvailable !== false && !task.humanStopped && !task.cancelRequested && !task.pauseRequested
  && (['queued', 'running', 'waiting', 'paused'].includes(task.status) || task.followupAvailable === true && ['succeeded', 'failed'].includes(task.status));
export const botTaskStopping = (task: BotTask) => botTaskActive(task) && (task.cancelRequested === true || task.progress?.phase === 'stopping');
export const botTaskPausing = (task: BotTask) => botTaskActive(task) && task.status !== 'paused' && !botTaskStopping(task) && (task.pauseRequested === true || task.progress?.phase === 'pausing');
export const botTaskState = (task: BotTask) => botTaskStopping(task) ? ['stop-unconfirmed', 'stop-request-unknown'].includes(task.progress?.phase ?? '') ? 'stop-unconfirmed' : 'stopping' : botTaskPausing(task) ? ['pause-unconfirmed', 'pause-request-unknown'].includes(task.progress?.phase ?? '') ? 'pause-unconfirmed' : 'pausing' : task.status;
export const botTaskTitle = (task: BotTask) => task.title?.trim() || task.goal.trim().split(/\r?\n/u)[0]!.slice(0, 64) || 'DSH';
const statusLabels: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['执行中', 'Running'], waiting: ['等待回答', 'Needs an answer'],
  unknown: ['结果待核实', 'Needs verification'], succeeded: ['已完成', 'Completed'], failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'],
  paused: ['已暂停', 'Paused'], pausing: ['正在暂停', 'Pausing'], 'pause-unconfirmed': ['暂停待核实', 'Pause unconfirmed'],
};
export const botTaskStatus = (task: BotTask, locale: 'zh-CN' | 'en') => botTaskStopping(task) ? ['stop-unconfirmed', 'stop-request-unknown'].includes(task.progress?.phase ?? '') ? locale === 'zh-CN' ? '停止待核实' : 'Stop unconfirmed' : locale === 'zh-CN' ? '正在停止' : 'Stopping'
  : botTaskPausing(task) ? statusLabels[botTaskState(task)]![locale === 'zh-CN' ? 0 : 1] : task.status === 'waiting' && task.continuationAvailable ? locale === 'zh-CN' ? '等待继续' : 'Waiting to continue' : statusLabels[task.status]?.[locale === 'zh-CN' ? 0 : 1] ?? task.status;

const phases: Record<string, [string, string]> = {
  queued: ['等待执行', 'Waiting to start'], connecting: ['正在连接 DSH', 'Connecting to DSH'], 'waiting-runtime': ['正在连接 DSH', 'Connecting to DSH'],
  'waiting-model': ['等待执行器响应', 'Waiting for the executor'], generating: ['正在处理任务', 'Working on the task'],
  'using-tool': ['正在执行工具', 'Executing a tool'], 'executing-tool': ['正在执行工具', 'Executing a tool'],
  finalizing: ['正在整理结果', 'Preparing the result'], 'preparing-result': ['正在整理结果', 'Preparing the result'],
  retrying: ['正在恢复原任务', 'Reconnecting to the task'], recovering: ['正在核对原任务', 'Reconciling the task'], stopping: ['正在停止', 'Stopping'],
  compacting: ['正在整理任务上下文', 'Organizing task context'], waiting: ['等待继续', 'Waiting to continue'],
  continuing: ['正在接续任务输出', 'Continuing task output'], 'waiting-approval': ['等待 DSH 权限确认', 'Waiting for DSH permission'],
  'stop-unconfirmed': ['停止结果待核实', 'Stop outcome unconfirmed'],
  pausing: ['正在确认暂停', 'Confirming pause'], 'pause-unconfirmed': ['暂停结果待核实', 'Pause outcome unconfirmed'], paused: ['已暂停', 'Paused'],
  succeeded: ['执行完成', 'Completed'], failed: ['执行失败', 'Failed'], cancelled: ['已停止', 'Stopped'],
};
export const botTaskPhase = (phase: string, locale: 'zh-CN' | 'en') => phases[phase]?.[locale === 'zh-CN' ? 0 : 1] ?? (locale === 'zh-CN' ? '执行状态已更新' : 'Execution state updated');
export const botTaskTool = (name?: string) => name && /^[\w.:/-]{1,80}$/u.test(name) ? name : undefined;
export function botTaskActivity(task: BotTask, locale: 'zh-CN' | 'en'): string {
  if (botTaskStopping(task)) return ['stop-unconfirmed', 'stop-request-unknown'].includes(task.progress?.phase ?? '') ? locale === 'zh-CN' ? '停止结果尚未确认' : 'Stop outcome is unconfirmed' : task.progress?.phase === 'stop-requesting' ? locale === 'zh-CN' ? '正在提交停止请求' : 'Submitting the stop request' : locale === 'zh-CN' ? '等待执行器确认停止' : 'Waiting for the executor to confirm stopping';
  if (botTaskPausing(task)) return ['pause-unconfirmed', 'pause-request-unknown'].includes(task.progress?.phase ?? '') ? locale === 'zh-CN' ? '暂停结果尚未确认' : 'Pause outcome is unconfirmed' : task.progress?.phase === 'pause-requesting' ? locale === 'zh-CN' ? '正在提交暂停请求' : 'Submitting the pause request' : locale === 'zh-CN' ? '等待执行器确认暂停' : 'Waiting for the executor to confirm pausing';
  if (task.status === 'paused') return locale === 'zh-CN' ? '任务已暂停，进度已保留' : 'Task paused; progress is preserved';
  if (!botTaskActive(task) || task.status === 'unknown') return botTaskStatus(task, locale);
  if (task.continuationAvailable) return locale === 'zh-CN' ? '进度已保留，等待继续' : 'Progress saved; waiting to continue';
  if (task.status === 'waiting') return botTaskStatus(task, locale);
  if (!task.progress) return botTaskStatus(task, locale);
  const tool = task.progress.phase === 'using-tool' ? botTaskTool(task.progress.toolName) : undefined;
  return `${botTaskPhase(task.progress.phase, locale)}${tool ? ` · ${tool}` : ''}`;
}

export function botTaskHint(task: BotTask, locale: 'zh-CN' | 'en'): string {
  const zh = locale === 'zh-CN';
  if (task.status === 'paused' && !botTaskStopping(task)) return zh ? '任务已经暂停，工作区和已有进度会保留。继续时会沿用这个任务；停止任务则需要确认终止执行。' : 'The task is paused. Its workspace and progress remain available for continuing the same task, or stopping it explicitly.';
  if (botTaskPausing(task)) return task.progress?.phase === 'pause-unconfirmed' ? zh ? '执行器暂时无法确认暂停，自动重试已暂停。可以核对原任务状态，或重新核实暂停；不会将停止标记为可恢复的暂停。' : 'Pausing could not be confirmed and automatic retries are paused. Reconcile the original task or recheck pausing; a stopped task is never presented as resumable.' : zh ? '暂停请求已发出，正在等待执行器确认。确认前任务可能仍在运行，已有进度会保留。' : 'The pause request is awaiting executor acknowledgement. Work may still be running until confirmation; existing progress is preserved.';
  if (botTaskStopping(task) && task.progress?.phase === 'stop-requesting') return zh ? '正在发送停止请求，执行器尚未确认。请求处理期间会保留原任务和已有进度。' : 'The stop request is being sent. The task and its progress remain available while awaiting acknowledgement.';
  if (botTaskStopping(task) && task.progress?.phase === 'stop-request-unknown') return zh ? '停止请求的接收状态尚未确认。可以核对当前状态或重新提交同一任务的停止请求。' : 'Delivery of the stop request is unconfirmed. Check the current state or resubmit the stop request for the same task.';
  if (botTaskStopping(task) && task.progress?.phase === 'stop-unconfirmed') return zh ? '执行器暂时无法确认停止，自动重试已暂停。原任务和已有进度会保留，重新核实时不会新建任务。' : 'The executor could not confirm stopping, so automatic retries are paused. The same task and its existing progress are preserved for reconciliation.';
  if (botTaskStopping(task)) return zh ? '停止请求已经记录。正在核对执行器的最终状态，确认前会保留已有进度。' : 'The stop request is recorded. Existing progress is preserved while the executor confirms its final state.';
  if (task.status === 'unknown') return zh ? '上次操作是否完成尚未确认。先核实实际结果，系统会保留原任务并避免重复执行。' : 'The last operation has an unconfirmed outcome. Verify its actual effect before continuing the same task.';
  if (task.status === 'queued' && task.progress?.phase === 'recovering') return zh ? '连接暂时中断，正在重新接入原任务。可在执行记录查看连接原因和已尝试次数。' : 'The connection was interrupted. The app is reconnecting to the original task; connection details are available in Activity.';
  if (task.status === 'queued') return zh ? '任务已保存，等待执行资源就绪。开始执行和完成时都会更新这里。' : 'The task is saved and waiting for an available executor. This view updates when execution starts or finishes.';
  if (task.continuationAvailable && task.status === 'waiting') return zh ? '本轮输出达到上限。已有进度和工作区已保留，可以继续原任务。' : 'This turn reached its output limit. Progress and the workspace are preserved so the same task can continue.';
  if (task.status === 'waiting') return zh ? '执行器需要你的回答，确认后将继续这个任务。' : 'The executor needs your answer before the same task can continue.';
  if (task.progress?.phase === 'waiting-approval') return zh ? 'DSH 正在等待权限确认。请在共享执行器窗口处理，原任务和工作区会保留。' : 'DSH is waiting for permission approval in the shared executor window. The original task and workspace are preserved.';
  if (task.status === 'failed') return zh ? '任务未能完成。已有记录和失败原因会保留在这里。' : 'The task did not complete. Its records and failure details remain available here.';
  if (task.status === 'cancelled') return zh ? '执行器已确认停止，已有结果和任务记录会保留。' : 'The executor confirmed the task has stopped. Existing outputs and task records are retained.';
  if (task.status === 'succeeded') return zh ? '执行结果已返回。伙伴会在聊天中与你沟通，原始执行结果可在这里查看。' : 'Execution has returned a result. Your companion reports back in chat, and the executor output is available here.';
  return zh ? '执行器正在处理这项任务。这里展示实际收到的执行状态，不代表估算完成比例。' : 'The executor is working on this task. The status reflects received events rather than an estimated completion percentage.';
}

export function botTaskStages(task: BotTask, locale: 'zh-CN' | 'en') {
  const zh = locale === 'zh-CN', phases = new Set([...(task.activity?.map(item => item.phase) ?? []), task.progress?.phase]);
  const execution = ['waiting-model', 'using-tool', 'executing-tool', 'generating', 'compacting', 'continuing', 'waiting-approval'];
  const executed = execution.some(phase => phases.has(phase)), result = ['succeeded', 'failed', 'cancelled'].includes(task.status);
  const returned = phases.has('finalizing') || task.status === 'succeeded';
  const connecting = phases.has('connecting') || phases.has('recovering'), stopping = botTaskStopping(task) || botTaskPausing(task) || task.status === 'paused';
  const suspendedCaption = botTaskStopping(task) ? zh ? '待确认停止' : 'Stop pending' : botTaskPausing(task) ? zh ? '待确认暂停' : 'Pause pending' : zh ? '已暂停' : 'Paused';
  return [
    { label: zh ? '接收任务' : 'Received', state: 'complete', caption: zh ? '已保存' : 'Saved' },
    { label: zh ? '连接执行器' : 'Connection', state: executed || returned ? 'complete' : connecting && !result && !stopping ? 'current' : connecting && result ? 'ended' : 'pending', caption: executed || returned ? zh ? '已接入' : 'Connected' : stopping ? zh ? '待核实' : 'Unconfirmed' : connecting ? result ? zh ? '未完成' : 'Unfinished' : zh ? '连接中' : 'Connecting' : zh ? '等待连接' : 'Not connected' },
    { label: zh ? '执行与核验' : 'Execution', state: returned ? 'complete' : executed && result ? 'ended' : executed && !stopping ? 'current' : 'pending', caption: returned ? zh ? '已返回' : 'Returned' : stopping ? suspendedCaption : executed ? result ? zh ? '已结束' : 'Ended' : zh ? '执行中' : 'Working' : zh ? '等待执行' : 'Not started' },
    { label: zh ? '处理结果' : 'Outcome', state: result ? task.status === 'succeeded' ? 'complete' : 'ended' : phases.has('finalizing') ? 'current' : 'pending', caption: result ? botTaskStatus(task, locale) : zh ? '等待结果' : 'Awaiting outcome' },
  ];
}
