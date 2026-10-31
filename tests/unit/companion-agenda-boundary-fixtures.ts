import { companionAgendaGoalSchema, companionAgendaGrantSchema, companionAgendaOccurrenceSchema, companionAgendaRuleSchema, companionAgendaRunSchema } from '../../src/shared/companion-agenda';

export const boundaryNow = '2026-10-29T10:00:00.000Z';
export const boundaryRule = () => companionAgendaRuleSchema.parse({ id: 'rule', companionId: 'alice', revision: 1, origin: 'user', status: 'active',
  title: 'PRIVATE_title', intent: 'PRIVATE_intent', kind: 'reminder', executor: 'reminder',
  trigger: { kind: 'at', at: boundaryNow, timeZone: 'UTC', repeat: 'once' }, reason: 'PRIVATE_reason',
  conversationId: 'own-room', grantId: 'grant', goalId: 'goal', sourceMessageId: 'source-message', referenceId: 'reference',
  conditions: [{ key: 'user.available', equals: true, label: 'PRIVATE_condition' }], createdAt: boundaryNow, updatedAt: boundaryNow });
export const boundaryOccurrence = () => companionAgendaOccurrenceSchema.parse({ id: 'occurrence', companionId: 'alice', ruleId: 'rule', ruleRevision: 1,
  scheduledAt: boundaryNow, lastEvaluatedAt: boundaryNow, state: 'running', reason: 'PRIVATE_occurrence-reason', input: 'PRIVATE_input',
  conditionResults: [{ key: 'user.available', label: 'PRIVATE_condition-result', satisfied: true }] });
export const boundaryRun = () => companionAgendaRunSchema.parse({ id: 'run', companionId: 'alice', ruleId: 'rule', occurrenceId: 'occurrence', revision: 1,
  status: 'running', stage: 'PRIVATE_stage', createdAt: boundaryNow, updatedAt: boundaryNow, notBefore: boundaryNow,
  startedAt: boundaryNow, leaseToken: 'lease', leaseUntil: '2026-10-29T10:01:00.000Z',
  failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 1,
  result: 'PRIVATE_output', error: 'PRIVATE_error', checkpoint: 'PRIVATE_checkpoint', nextCondition: 'PRIVATE_next-condition' });
export const boundaryGoal = () => companionAgendaGoalSchema.parse({ id: 'goal', companionId: 'alice', revision: 1, origin: 'user', status: 'active',
  title: 'PRIVATE_goal', intent: 'PRIVATE_goal-intent', domain: 'knowledge', successCriteria: ['PRIVATE_criterion'], nextQuestions: ['PRIVATE_question'],
  materials: [{ kind: 'web', url: 'https://private.example.com/research' }], allowWeb: true, progress: 'PRIVATE_progress',
  grantId: 'grant', conversationId: 'own-room', createdAt: boundaryNow, updatedAt: boundaryNow });
export const boundaryGrant = () => companionAgendaGrantSchema.parse({ id: 'grant', companionId: 'alice', revision: 1, status: 'active',
  title: 'PRIVATE_grant', capabilities: ['observe'], windowIds: ['window:1:0'],
  captureSources: [{ id: 'window:1:0', title: '编辑器', displayId: 'display-1' }],
  fileRoots: ['C:/PRIVATE_files'], outputRoots: ['C:/PRIVATE_outputs'], conversationId: 'own-room',
  createdAt: boundaryNow, updatedAt: boundaryNow });
