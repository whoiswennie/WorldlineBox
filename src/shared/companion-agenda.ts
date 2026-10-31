import { z } from 'zod';
import { isCompanionScheduleTimeZone } from './companion-schedule-time';
import { companionLearningGoalMaterialSchema } from './companion-learning-goals';
import { companionAgendaRoutineSchema, validateCompanionAgendaRoutine } from './companion-agenda-routine';
import { companionAgendaExecutionSchema } from './companion-agenda-execution';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const revision = z.number().int().positive().safe();
const operationId = z.string().min(1).max(200);
const zone = z.string().min(1).max(100).refine(isCompanionScheduleTimeZone, '日程时区无效。');
const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7)
  .refine(value => new Set(value).size === value.length, '星期不能重复。');
export const companionAgendaKindSchema = z.enum(['self', 'chat', 'world', 'research', 'learning', 'memory', 'reflection', 'rest', 'reminder', 'work', 'observation', 'growth']);
export const companionAgendaCategorySchema = z.enum(['daily', 'task', 'event']);
export const companionAgendaTaskResponseSchema = z.strictObject({ decision: z.enum(['accept', 'negotiate', 'decline']), message: z.string().trim().min(1).max(2000) });
export const companionAgendaClassificationSchema = z.strictObject({ basis: z.enum(['daily_routine', 'daily_conversation', 'daily_review', 'system_maintenance', 'native_task', 'source_task', 'self_task']),
  reason: z.string().max(500), sourceMessageId: id.optional(), sourceConversationId: id.optional(), sourceAuthorId: id.optional(), referenceId: id.optional() });
export const companionAgendaExecutorSchema = z.enum(['brain', 'chat', 'activity', 'reminder', 'world', 'learning', 'memory', 'reflection', 'routine', 'dsh', 'observation', 'growth']);
export const companionAgendaTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: instant, timeZone: zone, repeat: z.enum(['once', 'daily', 'weekly', 'monthly']).default('once'), weekDays: weekdays.optional(), probability: z.number().min(0).max(1).optional() }),
  z.strictObject({ kind: z.literal('interval'), anchorAt: instant, everyMinutes: z.number().int().min(1).max(525600), timeZone: zone, probability: z.number().min(0).max(1).optional() }),
  z.strictObject({ kind: z.literal('window'), startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(0).max(1440),
    timeZone: zone, weekDays: weekdays.optional(), probability: z.number().min(0).max(1), checkIntervalMinutes: z.number().int().min(1).max(1440).default(15) })
    .refine(value => value.startMinute !== value.endMinute, '日程机会窗口不能为空。'),
  z.strictObject({ kind: z.literal('event'), topic: z.string().min(1).max(120), quietSeconds: z.number().int().min(0).max(86400).default(0) }),
]);
export const companionAgendaConditionSchema = z.strictObject({ key: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/u), equals: z.union([z.boolean(), z.string().max(500), z.number().finite()]), label: z.string().max(300) });
export const companionAgendaRuleDraftSchema = z.strictObject({ title: z.string().trim().min(1).max(160), intent: z.string().trim().min(1).max(16000),
  kind: companionAgendaKindSchema, executor: companionAgendaExecutorSchema, trigger: companionAgendaTriggerSchema,
  clock: z.enum(['real', 'world']).optional(), routine: companionAgendaRoutineSchema.optional(),
  conditions: z.array(companionAgendaConditionSchema).max(32).default([]), flexible: z.boolean().default(true),
  protected: z.boolean().default(false),
  overlapPolicy: z.enum(['parallel', 'wait', 'skip', 'merge']).default('wait'), resourceKeys: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/u)).max(16).default([]),
  reason: z.string().trim().min(1).max(1000), goalId: id.optional(), grantId: id.optional(), conversationId: id.optional(),
  referenceId: id.optional(), referenceVersion: z.string().min(1).max(200).optional(), expectedMinutes: z.number().int().min(1).max(10080).optional() })
  .superRefine((rule, context) => { for (const message of validateCompanionAgendaRoutine(rule)) context.addIssue({ code: 'custom', path: ['routine'], message }); });
export const companionAgendaRuleSchema = companionAgendaRuleDraftSchema.safeExtend({ id, companionId: id, revision,
  presentation: z.strictObject({ title: z.string().max(160), intent: z.string().max(16000) }).optional(),
  category: companionAgendaCategorySchema.default('event'), classification: companionAgendaClassificationSchema.optional(),
  taskResponse: companionAgendaTaskResponseSchema.extend({ at: instant, by: z.enum(['user', 'self', 'system']) }).optional(),
  origin: z.enum(['user', 'self', 'system']), status: z.enum(['active', 'paused', 'retired']), createdAt: instant, updatedAt: instant,
  sourceMessageId: id.optional(), nextAt: instant.optional() });
export const companionAgendaOccurrenceSchema = z.strictObject({ id, companionId: id, ruleId: id, ruleRevision: revision,
  scheduledAt: instant, windowEnd: instant.optional(), lastEvaluatedAt: instant, nextCheckAt: instant.optional(),
  state: z.enum(['observing', 'ready', 'waiting', 'running', 'completed', 'silent', 'expired', 'cancelled', 'parked', 'abandoned', 'unknown']),
  probabilityThreshold: z.number().nonnegative().optional(), accumulatedHazard: z.number().nonnegative().default(0),
  conditionResults: z.array(z.strictObject({ key: z.string(), label: z.string(), satisfied: z.boolean() })).max(32).default([]),
  reason: z.string().max(2000), eventKey: z.string().max(200).optional(), input: z.string().max(16000).optional() });
export const companionAgendaRunStateSchema = z.enum(['queued', 'running', 'waiting', 'completed', 'silent', 'cancelled', 'parked', 'abandoned', 'unknown']);
export const companionAgendaRunSchema = z.strictObject({ id, companionId: id, ruleId: id, occurrenceId: id, revision,
  status: companionAgendaRunStateSchema, stage: z.string().max(1000), createdAt: instant, updatedAt: instant, notBefore: instant,
  startedAt: instant.optional(), finishedAt: instant.optional(), leaseToken: id.optional(), leaseUntil: instant.optional(),
  pausedByRuleId: id.optional(), pausedByGoalId: id.optional(),
  activeGrantId: id.optional(), activeGrantRevision: revision.optional(),
  failureCount: z.number().int().nonnegative().safe(), cycleFailureCount: z.number().int().nonnegative().safe(), retryCycle: z.number().int().nonnegative().safe(),
  attemptCount: z.number().int().nonnegative().safe(), result: z.string().max(32000).optional(), error: z.string().max(2000).optional(),
  checkpoint: z.string().max(256000).optional(), nextCondition: z.string().max(1000).optional() });
export const companionAgendaStepSchema = z.strictObject({ id, runId: id, companionId: id, effectKey: z.string().min(1).max(200),
  title: z.string().max(200), status: z.enum(['prepared', 'dispatched', 'succeeded', 'failed', 'unknown']),
  result: z.string().max(32000).optional(), createdAt: instant, updatedAt: instant });
export const companionAgendaGoalDraftSchema = z.strictObject({ title: z.string().trim().min(1).max(160), intent: z.string().trim().min(1).max(12000),
  domain: z.enum(['knowledge', 'procedure', 'persona', 'project']), successCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(16),
  nextQuestions: z.array(z.string().trim().min(1).max(1000)).max(16).default([]), grantId: id.optional(), conversationId: id.optional(),
  materials: z.array(companionLearningGoalMaterialSchema).max(20).default([]), allowWeb: z.boolean().default(false) });
export const companionAgendaGoalSchema = companionAgendaGoalDraftSchema.extend({ id, companionId: id, revision, origin: z.enum(['user', 'self', 'system']),
  taskResponse: companionAgendaTaskResponseSchema.extend({ at: instant, by: z.enum(['user', 'self', 'system']) }).optional(),
  status: z.enum(['active', 'paused', 'completed', 'retired']), createdAt: instant, updatedAt: instant, progress: z.string().max(6000).default('') });
export const companionAgendaTaskSchema = z.discriminatedUnion('form', [
  z.strictObject({ form: z.literal('execution'), execution: companionAgendaExecutionSchema }),
  z.strictObject({ form: z.literal('scheduled'), rule: companionAgendaRuleSchema }),
  z.strictObject({ form: z.literal('longterm'), goal: companionAgendaGoalSchema }),
]);
export const companionAgendaGrantDraftSchema = z.strictObject({ title: z.string().trim().min(1).max(160),
  capabilities: z.array(z.enum(['observe', 'browser', 'dsh', 'files.read', 'files.deliver', 'learning'])).max(6),
  goalId: id.optional(), fileRoots: z.array(z.string().min(1).max(4096)).max(32).default([]), outputRoots: z.array(z.string().min(1).max(4096)).max(16).default([]),
  windowIds: z.array(z.string().min(1).max(300)).max(32).default([]), conversationId: id.optional(), allowPublicWeb: z.boolean().default(false),
  captureSources: z.array(z.strictObject({ id: z.string().min(1).max(300), title: z.string().max(1000), displayId: z.string().max(100).optional() })).max(32).default([]),
  expiresAt: instant.optional() });
export const companionAgendaGrantSchema = companionAgendaGrantDraftSchema.extend({ id, companionId: id, revision, status: z.enum(['active', 'revoked']), createdAt: instant, updatedAt: instant });
export const companionAgendaAuthoritySchema = z.strictObject({ kind: z.enum(['user', 'self', 'system']), sourceMessageId: id.optional(), grantId: id.optional() });
const owner = { companionId: id };
const mutation = { ...owner, operationId };
export const companionAgendaPublicCommands = [
  z.strictObject({ type: z.literal('agenda.read'), ...owner, from: instant.optional(), to: instant.optional(), afterId: id.optional(), limit: z.number().int().min(1).max(100).default(50), category: companionAgendaCategorySchema.optional(), compactRecurring: z.boolean().optional() }),
  z.strictObject({ type: z.literal('agenda.event.read'), ...owner, id }),
  z.strictObject({ type: z.literal('agenda.rule.create'), ...mutation, rule: companionAgendaRuleDraftSchema }),
  z.strictObject({ type: z.literal('agenda.rule.update'), ...mutation, id, expectedRevision: revision, rule: companionAgendaRuleDraftSchema }),
  z.strictObject({ type: z.literal('agenda.rule.control'), ...mutation, id, expectedRevision: revision, action: z.enum(['pause', 'resume', 'retire']), taskResponse: companionAgendaTaskResponseSchema.optional() }),
  z.strictObject({ type: z.literal('agenda.goals.read'), ...owner, afterId: id.optional(), limit: z.number().int().min(1).max(100).default(50) }),
  z.strictObject({ type: z.literal('agenda.goal.create'), ...mutation, goal: companionAgendaGoalDraftSchema }),
  z.strictObject({ type: z.literal('agenda.goal.update'), ...mutation, id, expectedRevision: revision, goal: companionAgendaGoalDraftSchema, progress: z.string().max(6000).optional() }),
  z.strictObject({ type: z.literal('agenda.goal.control'), ...mutation, id, expectedRevision: revision, action: z.enum(['pause', 'resume', 'retire', 'complete']), evidence: z.string().trim().min(1).max(6000).optional(), taskResponse: companionAgendaTaskResponseSchema.optional() }),
  z.strictObject({ type: z.literal('agenda.grants.read'), ...owner }),
  z.strictObject({ type: z.literal('agenda.grant.configure'), ...mutation, id: id.optional(), expectedRevision: revision.optional(), grant: companionAgendaGrantDraftSchema }),
  z.strictObject({ type: z.literal('agenda.grant.revoke'), ...mutation, id, expectedRevision: revision }),
  z.strictObject({ type: z.literal('agenda.run.control'), ...mutation, id, expectedRevision: revision, action: z.enum(['pause', 'resume', 'abandon', 'cancel']) }),
  z.strictObject({ type: z.literal('agenda.tasks.read'), ...owner, afterId: id.optional(), limit: z.number().int().min(1).max(100).default(50),
    executionStatus: z.enum(['active', 'ended', 'all']).default('active') }),
] as const;
const authority = { authority: companionAgendaAuthoritySchema };
// Keep the literal discriminants intact for every umbrella IPC/storage union.
const hostMutations = [companionAgendaPublicCommands[2].extend(authority), companionAgendaPublicCommands[3].extend(authority),
  companionAgendaPublicCommands[4].extend(authority), companionAgendaPublicCommands[6].extend(authority), companionAgendaPublicCommands[7].extend(authority),
  companionAgendaPublicCommands[8].extend(authority), companionAgendaPublicCommands[10].extend(authority), companionAgendaPublicCommands[11].extend(authority),
  companionAgendaPublicCommands[12].extend(authority)] as const;
const publicReads = [companionAgendaPublicCommands[0], companionAgendaPublicCommands[1], companionAgendaPublicCommands[5], companionAgendaPublicCommands[9], companionAgendaPublicCommands[13]] as const;
export const companionAgendaStorageCommands = [
  ...publicReads, ...hostMutations,
  z.strictObject({ type: z.literal('agenda.goal.read'), ...owner, id }),
  z.strictObject({ type: z.literal('agenda.tick'), ...owner, now: instant, facts: z.record(z.string(), z.union([z.boolean(), z.string().max(500), z.number().finite()])).default({}) }),
  z.strictObject({ type: z.literal('agenda.emit'), ...owner, eventKey: z.string().min(1).max(200), topic: z.string().min(1).max(120), at: instant, input: z.string().max(16000).default('') }),
  z.strictObject({ type: z.literal('agenda.claim'), companionId: id.optional(), now: instant, leaseMs: z.number().int().min(1000).max(600000).default(30000), limit: z.number().int().min(1).max(10).default(1), excludedOwners: z.array(id).max(100).default([]) }),
  z.strictObject({ type: z.literal('agenda.run.heartbeat'), ...owner, id, leaseToken: id, now: instant, leaseMs: z.number().int().min(1000).max(600000).default(30000) }),
  z.strictObject({ type: z.literal('agenda.run.checkpoint'), ...owner, id, leaseToken: id, now: instant, checkpoint: z.string().max(256000), stage: z.string().max(1000) }),
  z.strictObject({ type: z.literal('agenda.run.read'), ...owner, id }),
  z.strictObject({ type: z.literal('agenda.run.bindGrant'), ...owner, id, leaseToken: id, now: instant, grantId: id, grantRevision: revision }),
  z.strictObject({ type: z.literal('agenda.step.read'), ...owner, runId: id, effectKey: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal('agenda.run.reconcile'), ...owner, id, expectedRevision: revision, now: instant,
    outcome: z.enum(['resume', 'completed', 'cancelled']), evidence: z.string().trim().min(1).max(6000) }),
  z.strictObject({ type: z.literal('agenda.step.reconcile'), ...owner, runId: id, expectedRunRevision: revision,
    effectKey: z.string().min(1).max(200), now: instant, outcome: z.enum(['succeeded', 'not_dispatched']),
    evidence: z.string().trim().min(1).max(6000), result: z.string().max(32000).optional() }),
  z.strictObject({ type: z.literal('agenda.run.settle'), ...owner, id, leaseToken: id, now: instant, outcome: z.enum(['completed', 'silent', 'waiting', 'failed', 'cancelled', 'unknown', 'parked', 'abandoned']),
    result: z.string().max(32000).optional(), error: z.string().max(2000).optional(), stage: z.string().max(1000).optional(), notBefore: instant.optional(), nextCondition: z.string().max(1000).optional() }),
  z.strictObject({ type: z.literal('agenda.step.record'), ...owner, runId: id, leaseToken: id, now: instant, effectKey: z.string().min(1).max(200), title: z.string().max(200),
    status: companionAgendaStepSchema.shape.status, result: z.string().max(32000).optional() }),
] as const;
// Host authorities are deliberately absent from renderer/model commands.
export const companionAgendaCommandSchema = z.union(companionAgendaStorageCommands);
export const companionAgendaPublicCommandSchema = z.discriminatedUnion('type', companionAgendaPublicCommands);
export const companionAgendaClaimSchema = z.strictObject({ rule: companionAgendaRuleSchema, occurrence: companionAgendaOccurrenceSchema, run: companionAgendaRunSchema, leaseToken: id });
export const companionAgendaViewSchema = z.strictObject({ companionId: id, rules: z.array(companionAgendaRuleSchema), occurrences: z.array(companionAgendaOccurrenceSchema),
  runs: z.array(companionAgendaRunSchema), goals: z.array(companionAgendaGoalSchema), grants: z.array(companionAgendaGrantSchema),
  hasMore: z.boolean(), nextId: id.optional(), observedAt: instant, revision: z.number().int().nonnegative().safe(),
  worldTime: z.strictObject({ realNow: instant, virtualNow: instant, timeZone: z.string(), speed: z.number().positive() }).optional() });
export const companionAgendaResponseShape = {
  agenda: companionAgendaViewSchema.optional(), agendaRule: companionAgendaRuleSchema.optional(), agendaOccurrence: companionAgendaOccurrenceSchema.optional(),
  agendaRun: companionAgendaRunSchema.optional(), agendaGoal: companionAgendaGoalSchema.optional(), agendaGrant: companionAgendaGrantSchema.optional(),
  agendaStep: companionAgendaStepSchema.optional(), agendaSteps: z.array(companionAgendaStepSchema).optional(),
  agendaClaim: companionAgendaClaimSchema.optional(), agendaClaims: z.array(companionAgendaClaimSchema).optional(),
  agendaEvent: z.strictObject({ rule: companionAgendaRuleSchema, occurrences: z.array(companionAgendaOccurrenceSchema), runs: z.array(companionAgendaRunSchema), steps: z.array(companionAgendaStepSchema) }).optional(),
  agendaGoals: z.array(companionAgendaGoalSchema).optional(), agendaGrants: z.array(companionAgendaGrantSchema).optional(),
  agendaTasks: z.array(companionAgendaTaskSchema).optional(),
  agendaHasMore: z.boolean().optional(), agendaNextId: id.optional(),
  agendaRevision: z.number().int().nonnegative().safe().optional(),
};
export type CompanionAgendaCommand = z.output<typeof companionAgendaCommandSchema>;
export type CompanionAgendaPublicCommand = z.output<typeof companionAgendaPublicCommandSchema>;
export type CompanionAgendaRule = z.output<typeof companionAgendaRuleSchema>;
export type CompanionAgendaCategory = z.output<typeof companionAgendaCategorySchema>;
export type CompanionAgendaTask = z.output<typeof companionAgendaTaskSchema>;
export type CompanionAgendaRuleDraft = z.input<typeof companionAgendaRuleDraftSchema>;
export type CompanionAgendaOccurrence = z.output<typeof companionAgendaOccurrenceSchema>;
export type CompanionAgendaRun = z.output<typeof companionAgendaRunSchema>;
export type CompanionAgendaGoal = z.output<typeof companionAgendaGoalSchema>;
export type CompanionAgendaGrant = z.output<typeof companionAgendaGrantSchema>;
export type CompanionAgendaStep = z.output<typeof companionAgendaStepSchema>;
export type CompanionAgendaAuthority = z.output<typeof companionAgendaAuthoritySchema>;
export type CompanionAgendaClaim = z.output<typeof companionAgendaClaimSchema>;
export type CompanionAgendaView = z.output<typeof companionAgendaViewSchema>;
export type CompanionAgendaResponse = { ok: boolean; error?: string } & z.output<z.ZodObject<typeof companionAgendaResponseShape>>;
