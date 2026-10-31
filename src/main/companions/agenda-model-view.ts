import type { CompanionAgendaGoal, CompanionAgendaResponse, CompanionAgendaRule, CompanionAgendaRun } from '../../shared/companion-agenda';

/** The human owner's calendar and a model's current message port are different
 * readers. Other private commitments are enough to avoid a scheduling conflict,
 * but their subjects, inputs, materials and outputs do not enter a peer/group. */
export function companionAgendaModelView(response: CompanionAgendaResponse, port: { conversationId: string; allowPrivate: boolean }): CompanionAgendaResponse {
  const withoutLease = (run: CompanionAgendaRun): CompanionAgendaRun => ({ ...run, leaseToken: undefined, leaseUntil: undefined, activeGrantId: undefined, activeGrantRevision: undefined });
  response = { ...response,
    ...(response.agenda ? { agenda: { ...response.agenda, runs: response.agenda.runs.map(withoutLease) } } : {}),
    ...(response.agendaRun ? { agendaRun: withoutLease(response.agendaRun) } : {}),
    ...(response.agendaEvent ? { agendaEvent: { ...response.agendaEvent, runs: response.agendaEvent.runs.map(withoutLease) } } : {}),
    agendaClaim: undefined, agendaClaims: undefined,
  };
  if (port.allowPrivate) return response;
  const hidden = (rule: CompanionAgendaRule) => rule.conversationId !== port.conversationId;
  const ruleView = (rule: CompanionAgendaRule): CompanionAgendaRule => !hidden(rule) ? rule : { ...rule, title: '已有私人约定',
    intent: '此安排的私人内容不属于当前消息入口；仅使用时间避免冲突。', reason: '私人约定，仅展示时间与运行状态。',
    conditions: [], sourceMessageId: undefined, referenceId: undefined, referenceVersion: undefined, grantId: undefined, conversationId: undefined, resourceKeys: [],
    classification: undefined, taskResponse: undefined, presentation: undefined,
    routine: rule.routine?.kind === 'meal' ? { kind: 'meal', name: '用餐' } : rule.routine,
    trigger: rule.trigger.kind === 'event' ? { ...rule.trigger, topic: 'private_event' } : rule.trigger };
  const goalView = (goal: CompanionAgendaGoal): CompanionAgendaGoal => goal.conversationId === port.conversationId ? goal : { ...goal,
    title: '本人的私人长期方向', intent: '私人内容不属于本次消息入口。', successCriteria: ['在本人的私聊中核对。'], nextQuestions: [],
    progress: '', materials: [], allowWeb: false, grantId: undefined, conversationId: undefined, taskResponse: undefined };
  const redactRun = (run: CompanionAgendaRun): CompanionAgendaRun => ({ ...run, stage: '私人安排，仅展示运行状态。', result: undefined, error: undefined, checkpoint: undefined, nextCondition: undefined });
  const view = response.agenda;
  const privateRules = new Set(view?.rules.filter(hidden).map(rule => rule.id));
  const readableRules = new Set(view?.rules.filter(rule => !hidden(rule)).map(rule => rule.id));
  const event = response.agendaEvent;
  if (event && hidden(event.rule)) return { ok: false, error: '这件事的私人内容不能进入当前消息入口，请在本人私聊中核对。' };
  return { ...response,
    ...(view ? { agenda: { ...view, rules: view.rules.map(ruleView), goals: view.goals.map(goalView), grants: [],
      occurrences: view.occurrences.map(item => privateRules.has(item.ruleId) || !readableRules.has(item.ruleId) ? { ...item, input: undefined, eventKey: undefined, reason: '私人约定。', conditionResults: [] } : { ...item, input: undefined, eventKey: undefined }),
      runs: view.runs.map(run => privateRules.has(run.ruleId) || !readableRules.has(run.ruleId) ? redactRun(run) : { ...run, checkpoint: undefined, result: undefined, error: undefined }) } } : {}),
    ...(event ? { agendaEvent: { ...event, occurrences: event.occurrences.map(item => ({ ...item, input: undefined, eventKey: undefined })),
      runs: event.runs.map(redactRun), steps: [] } } : {}),
    ...(response.agendaRule ? { agendaRule: ruleView(response.agendaRule) } : {}),
    ...(response.agendaGoal ? { agendaGoal: goalView(response.agendaGoal) } : {}),
    ...(response.agendaGoals ? { agendaGoals: response.agendaGoals.map(goalView) } : {}),
    ...(response.agendaTasks ? { agendaTasks: response.agendaTasks.map(task => task.form === 'execution'
      ? task.execution.conversationId === port.conversationId ? task : { ...task, execution: { ...task.execution,
        title: '本人的其他私人执行任务', stage: '本次消息入口仅展示实际执行状态。', sourceMessageId: undefined, parentMessageId: undefined, taskId: undefined, canResume: false, contentAvailable: false } }
      : task.form === 'scheduled' ? { ...task, rule: ruleView(task.rule) } : { ...task, goal: goalView(task.goal) }) } : {}),
    ...(response.agendaGrants ? { agendaGrants: [] } : {}),
    ...(response.agendaRun ? { agendaRun: redactRun(response.agendaRun) } : {}),
    ...(response.agendaOccurrence ? { agendaOccurrence: { ...response.agendaOccurrence, input: undefined, eventKey: undefined, reason: '只展示运行状态。', conditionResults: [] } } : {}),
    agendaClaim: undefined, agendaClaims: undefined, agendaStep: undefined, agendaSteps: undefined,
    agendaGrant: undefined,
  };
}
