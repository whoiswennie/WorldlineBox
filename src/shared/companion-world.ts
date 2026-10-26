import { z } from 'zod';
import { companionUserStopSchema } from './companion-task-stop';
import { companionInteractionSchema, companionContactReceiptSchema } from './companion-contact';
import { companionWorldArgumentsSchema } from './companion-world-tool';
import { companionMemoryCandidateSchema, companionMemoryConsolidateSchema } from './companion-memory';
import { COMPANION_WORLD_ART_ACTIONS } from './companion-world-actions';
import { companionWorldPerceptionSchema } from './companion-world-perception';
import { companionHomeAddressSchema } from './companion-world-address';
import { companionStateToolProposalSchema } from './companion-state-tool';
import { companionExecutionReadsetSchema } from './companion-execution-evidence';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
export const COMPANION_WORLD_DEFAULT_SETTINGS = { mode: 'realtime', dayDurationMinutes: 1440, timeZone: 'system' } as const;
// Legacy modes remain readable in archived settings; new commands cannot enable them.
export const companionWorldSettingsSchema = z.object({ revision: z.number().int().positive(), mode: z.enum(['compressed', 'realtime']),
  dayDurationMinutes: z.number().min(5).max(1440), timeZone: z.string().min(1).max(100) });
const worldSettingsPatchSchema = companionWorldSettingsSchema.omit({ revision: true }).partial().superRefine((patch, context) => {
  if (patch.mode !== undefined && patch.mode !== 'realtime' || patch.dayDurationMinutes !== undefined && patch.dayDurationMinutes !== 1440)
    context.addIssue({ code: 'custom', message: '伙伴生活始终跟随现实时间，只能修改显示时区。' });
});
export const companionWorldFurnitureSchema = z.object({ id, kind: z.enum(['bed', 'desk', 'computer', 'chair', 'kitchen', 'dining', 'sofa', 'habit', 'door', 'tree', 'bench', 'building', 'fountain', 'lamp']),
  name: z.string(), position: point, width: z.number().positive(), depth: z.number().positive(), anchor: point, blocking: z.boolean(), occupantId: id.optional(), reservedBy: id.optional() });
export const companionWorldSceneSchema = z.object({ id, kind: z.enum(['home', 'park']), name: z.string(), ownerId: id.optional(),
  portals: z.array(z.object({ id, direction: z.enum(['entry', 'exit', 'both']), position: point })).min(1).optional(),
  width: z.number().positive(), depth: z.number().positive(), origin: point, door: point, objects: z.array(companionWorldFurnitureSchema) });
export const companionWorldActorSchema = z.object({ companionId: id, sceneId: id, position: point, homeSceneId: id,
  facing: z.enum(['north', 'east', 'south', 'west']), frame: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  activity: z.enum(['idle', 'walking', 'seating', 'sitting', 'working', 'sleeping', 'eating', 'resting', 'habit', 'standingUp', 'lyingDown', 'waking', 'turning']),
  activityStartedAtReal: z.iso.datetime(),
  artAction: z.enum(COMPANION_WORLD_ART_ACTIONS), artStartedAtReal: z.iso.datetime().optional(),
  transitionEndsAtReal: z.iso.datetime().optional(),
  locomotion: z.enum(['walk', 'run']), movementSpeed: z.number().positive(),
  state: z.object({ energy: z.number().min(0).max(100), mood: z.enum(['calm', 'bright', 'focused', 'tired', 'low']),
    expression: z.enum(['gentle', 'direct', 'playful', 'reserved']), affect: z.object({ pleasure: z.number().min(-1).max(1), arousal: z.number().min(-1).max(1), dominance: z.number().min(-1).max(1) }), thermalComfort: z.number().min(0).max(1) }),
  travel: z.object({ targetSceneId: id, exitId: id, entryId: id }).optional(),
  route: z.array(z.object({ sceneId: id, x: z.number(), y: z.number() })), destinationId: id.optional(), furnitureId: id.optional(),
  routinePhase: z.enum(['awake', 'sleeping', 'eating', 'resting', 'habit']), activityLabel: z.string().optional(),
  parkWalk: z.object({ stage: z.enum(['travelling', 'strolling', 'returning']), durationMinutes: z.number().positive(), participatedMinutes: z.number().nonnegative() }).optional(),
  communication: z.object({ channel: z.enum(['phone', 'face_to_face']), phase: z.enum(['notification', 'typing', 'responding', 'speaking', 'listening']), conversationId: id, recipientIds: z.array(id).max(20), untilReal: z.iso.datetime() }).optional() });
/** Immutable bytes consumed when a world quotation was created, retained at
 * observation time. A later source read must validate these exact bytes. */
export const companionWorldSourceReadSchema = z.strictObject({ id, conversationId: id, checksum: z.string().regex(/^[a-f0-9]{64}$/u) });
export const companionWorldVisitSchema = z.object({ id, guestId: id, hostId: id, status: z.enum(['requested', 'allowed', 'denied', 'left', 'expired']),
  reason: z.string(), response: z.string().optional(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), sourceMessageId: id.optional(), conversationId: id.optional(),
  sourceRead: companionWorldSourceReadSchema.optional(), responseSourceMessageId: id.optional(), responseConversationId: id.optional(), responseSourceRead: companionWorldSourceReadSchema.optional(),
  destination: z.object({ sceneId: id, entryId: id }).optional() });
export const companionWorldEventSchema = z.object({ id, sequence: z.number().int().positive(), at: z.iso.datetime(), realAt: z.iso.datetime(),
  kind: z.string(), actorId: id.optional(), targetId: id.optional(), sceneId: id.optional(), text: z.string(), simulation: z.literal(true),
  sourceMessageId: id.optional(), conversationId: id.optional(),
  sourceReads: z.array(companionWorldSourceReadSchema).max(128).optional(),
  witnessIds: z.array(id).max(100).optional(),
  behavior: z.object({ id, kind: companionWorldActorSchema.shape.activity, phase: z.enum(['started', 'completed', 'interrupted']), targetId: id.optional(), parentId: id.optional() }).optional(),
  perception: companionWorldPerceptionSchema.pick({ revision: true, radius: true, visibleObjectIds: true, visibleCompanionIds: true, environment: true }).optional(),
  effect: z.object({ type: z.enum(['comfort', 'stress', 'shared_success', 'rest', 'social']), intensity: z.number().min(0).max(1) }).optional() });
export const companionWorldRelationshipSchema = z.object({ companionId: id, targetCompanionId: id, affinity: z.number().min(0).max(100),
  trust: z.number().min(0).max(100), interactions: z.number().int().nonnegative(), updatedAt: z.iso.datetime() });
export const companionWorldWorkSchema = z.object({ workId: id, companionId: id, kind: z.enum(['chat', 'action', 'schedule', 'learning']),
  status: z.enum(['waiting', 'moving', 'seating', 'ready', 'ended']), computerId: id.optional(), nextCheckAt: z.iso.datetime().optional(), reason: z.string().optional() });
export const companionMemoryMaintenanceAuditSchema = z.strictObject({ decision: z.enum(['merge', 'defer']), reason: z.string().trim().min(1).max(2000),
  reviewedMemoryVersions: z.array(z.strictObject({ id, version: z.number().int().positive() })).min(2).max(128) });
export const COMPANION_OPTIONAL_DREAM_FAILURES = {
  runtime_unavailable: { stage: 'wave', message: '可选梦境运行暂不可用，未生成梦境；真实反思与维护仍独立处理。' },
  wave_operation_failed: { stage: 'wave', message: '可选梦境联想服务未完成，未生成梦境；真实反思与维护仍独立处理。' },
  narrative_generation_failed: { stage: 'narrative', message: '可选虚构梦叙述未完成，未生成梦境；真实反思与维护仍独立处理。' },
} as const;
export const companionDreamComponentFailureSchema = z.strictObject({ stage: z.enum(['wave', 'narrative']),
  code: z.enum(['runtime_unavailable', 'wave_operation_failed', 'narrative_generation_failed']), message: z.string().min(1).max(300) })
  .superRefine((value, context) => {
    const expected = COMPANION_OPTIONAL_DREAM_FAILURES[value.code];
    if (value.stage !== expected.stage || value.message !== expected.message)
      context.addIssue({ code: 'custom', message: '梦境组件失败只接受宿主固定阶段、代码与说明。' });
  });
export const companionWorldJobSchema = z.object({ id, kind: z.enum(['decision', 'dream']), companionId: id, conversationId: id, status: z.enum(['pending', 'running', 'done', 'failed']),
  stop: companionUserStopSchema.optional(), startedAt: z.iso.datetime().optional(), updatedAt: z.iso.datetime().optional(), finishedAt: z.iso.datetime().optional(),
  terminal: z.boolean().optional(), error: z.string().max(2000).optional(),
  leaseToken: id.optional(), throughEventSequence: z.number().int().nonnegative(), createdAt: z.iso.datetime(), attempts: z.number().int().nonnegative(), sourceMemoryIds: z.array(id).max(128).default([]), encounterMemberIds: z.array(id).min(2).max(4).optional(),
  sleepEpisodeId: id.optional(), dreamAllowed: z.boolean().optional(), maintenanceMemoryIds: z.array(id).max(12).optional(), maintenance: companionMemoryMaintenanceAuditSchema.optional(),
  dreamComponentFailure: companionDreamComponentFailureSchema.optional() });
export const companionWorldSnapshotSchema = z.object({
  settings: companionWorldSettingsSchema,
  clock: z.object({ realNow: z.iso.datetime(), virtualNow: z.iso.datetime(), speed: z.number().positive(), day: z.number().int(), hour: z.number().min(0).max(24), daylight: z.boolean() }),
  environment: z.object({ weather: z.enum(['clear', 'cloudy', 'rain', 'snow']).optional(), light: z.number().min(0).max(1), outdoorTemperature: z.number().optional(), indoorTemperature: z.number().optional() }),
  scenes: z.array(companionWorldSceneSchema), actors: z.array(companionWorldActorSchema), visits: z.array(companionWorldVisitSchema),
  residents: z.array(z.object({ companionId: id, name: z.string(), active: z.boolean().optional(), homeSceneId: id.optional() })),
  knownAddresses: z.array(companionHomeAddressSchema).optional(),
  events: z.array(companionWorldEventSchema), relationships: z.array(companionWorldRelationshipSchema), works: z.array(companionWorldWorkSchema),
  lastEventSequence: z.number().int().nonnegative(), backlog: z.boolean(),
  perception: companionWorldPerceptionSchema.optional(),
});
export type CompanionWorldSettings = z.infer<typeof companionWorldSettingsSchema>;
export type CompanionWorldScene = z.infer<typeof companionWorldSceneSchema>;
export type CompanionWorldActor = z.infer<typeof companionWorldActorSchema>;
export type CompanionWorldVisit = z.infer<typeof companionWorldVisitSchema>;
export type CompanionWorldEvent = z.infer<typeof companionWorldEventSchema>;
export type CompanionWorldRelationship = z.infer<typeof companionWorldRelationshipSchema>;
export type CompanionWorldWork = z.infer<typeof companionWorldWorkSchema>;
export type CompanionWorldJob = z.infer<typeof companionWorldJobSchema>;
export type CompanionWorldSnapshot = z.infer<typeof companionWorldSnapshotSchema>;
export const companionWorldTimeSchema = z.object({ realNow: z.iso.datetime(), virtualNow: z.iso.datetime(),
  timeZone: z.string(), mode: z.enum(['compressed', 'realtime']), speed: z.number().positive(), backlog: z.boolean(),
  elapsed: z.array(z.object({ realAt: z.iso.datetime(), milliseconds: z.number().nonnegative() })).max(10).optional() });
export const companionWorldStatusSchema = z.object({ clock: companionWorldTimeSchema,
  environment: companionWorldSnapshotSchema.shape.environment.optional(),
  contacts: z.array(companionContactReceiptSchema).max(20), interactions: z.array(companionInteractionSchema).max(60) });
export type CompanionWorldStatus = z.infer<typeof companionWorldStatusSchema>;
export type CompanionWorldTime = z.infer<typeof companionWorldTimeSchema>;
export type CompanionWorldScope = { companionId: string; conversationId: string; beforeSequence?: number };
export type CompanionWorldOccupancy = { start: number; end: number; phase: 'sleeping' | 'eating' | 'resting' | 'habit'; habitId?: string; habitKind?: 'rest' | 'exercise' | 'study' | 'leisure' | 'custom' };
const scope = z.object({ companionId: id, conversationId: id, beforeSequence: z.number().int().positive().optional() });
export const companionWorldPublicCommands = [
  z.strictObject({ type: z.literal('world.snapshot') }),
  z.strictObject({ type: z.literal('world.configure'), expectedRevision: z.number().int().positive(), patch: worldSettingsPatchSchema }),
  scope.extend({ type: z.literal('world.observe') }).strict(),
  scope.extend({ type: z.literal('world.tool'), sourceMessageId: id.optional(), clientId: id.optional(), arguments: companionWorldArgumentsSchema }).strict(),
  z.strictObject({ type: z.literal('world.status'), companionIds: z.array(id).max(20) }),
] as const;
export const companionWorldStorageCommands = [
  ...companionWorldPublicCommands,
  z.strictObject({ type: z.literal('world.sleep-plan'), companionId: id }),
  z.strictObject({ type: z.literal('world.clock'), since: z.array(z.iso.datetime()).max(10).optional() }),
  z.strictObject({ type: z.literal('world.clock.peek') }),
  z.strictObject({ type: z.literal('world.tick'), now: z.iso.datetime().optional(), snapshot: z.boolean().default(false) }),
  scope.extend({ type: z.literal('world.attention.record'), sourceMessageId: id, sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/), urgency: z.enum(['urgent', 'ordinary']), confidence: z.number().min(0).max(1), evidence: z.array(z.string().min(1).max(4000)).min(1).max(10), reason: z.string().min(1).max(1000) }).strict(),
  scope.extend({ type: z.literal('world.work.begin'), workId: id, kind: z.enum(['chat', 'action', 'schedule', 'learning']), sourceMessageId: id.optional(), urgent: z.boolean().default(false), fixed: z.boolean().default(false),
    authorizationGrantId: id.optional(), invocationId: id.optional(),
    learningGrantId: id.optional(), learningLeaseToken: id.optional() }).strict(),
  z.strictObject({ type: z.literal('world.work.ready'), companionId: id, workId: id }),
  z.strictObject({ type: z.literal('world.work.end'), companionId: id, workId: id }),
  z.strictObject({ type: z.literal('world.job.claim'), kind: z.enum(['decision', 'dream']), excludedCompanionIds: z.array(id).max(100).optional() }),
  z.strictObject({ type: z.literal('world.job.check'), id, leaseToken: id }),
  z.strictObject({ type: z.literal('world.job.bind-memories'), id, leaseToken: id,
    memoryVersions: z.array(z.strictObject({ id, version: z.number().int().positive() })).min(1).max(128) }),
  z.strictObject({ type: z.literal('world.job.complete'), id, leaseToken: id, executionReadset: companionExecutionReadsetSchema.optional(), expectedMemoryRevision: z.string().min(1).max(128).optional(), expectedProhibitionRevision: z.string().min(1).max(128).optional(), stateProposal: companionStateToolProposalSchema.optional(), expectedStateRevision: z.number().int().positive().optional(), activityTask: z.strictObject({ title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(16000) }).optional(), action: companionWorldArgumentsSchema.optional(), sourceMemoryIds: z.array(id).max(128).default([]), memoryCandidates: z.array(companionMemoryCandidateSchema).max(40).default([]),
    consolidations: z.array(companionMemoryConsolidateSchema).max(4).optional(),
    maintenance: companionMemoryMaintenanceAuditSchema.optional(),
    dreamComponentFailure: companionDreamComponentFailureSchema.optional(),
    dream: z.strictObject({ text: z.string().max(8000), sourceMessageIds: z.array(id).min(1).max(30), relatedMemoryIds: z.array(id).min(1).max(30), evidence: z.array(z.object({ sourceMessageId: id, quote: z.string().min(1).max(4000) })).min(1).max(60) }).optional(),
    appraisals: z.array(z.strictObject({ eventId: id, targetCompanionId: id, type: z.enum(['support', 'respect', 'boundary_violation', 'hostility', 'shared_success', 'repair', 'disappointment']), intensity: z.number().min(0).max(1), confidence: z.number().min(0).max(1) })).max(10).default([]) }),
  z.strictObject({ type: z.literal('world.job.fail'), id, leaseToken: id, error: z.string().max(2000), terminal: z.boolean().optional() }),
] as const;
