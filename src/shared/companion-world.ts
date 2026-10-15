import { z } from 'zod';
import { companionWorldArgumentsSchema } from './companion-world-tool';
import { companionMemoryCandidateSchema } from './companion-memory';
import { COMPANION_WORLD_ART_ACTIONS } from './companion-world-actions';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
export const COMPANION_WORLD_DEFAULT_SETTINGS = { mode: 'realtime', dayDurationMinutes: 20, timeZone: 'system' } as const;
export const companionWorldSettingsSchema = z.object({ revision: z.number().int().positive(), mode: z.enum(['compressed', 'realtime']),
  dayDurationMinutes: z.number().min(5).max(1440), timeZone: z.string().min(1).max(100) });
export const companionWorldFurnitureSchema = z.object({ id, kind: z.enum(['bed', 'desk', 'computer', 'chair', 'kitchen', 'dining', 'sofa', 'habit', 'door', 'tree', 'bench', 'building']),
  name: z.string(), position: point, width: z.number().positive(), depth: z.number().positive(), anchor: point, blocking: z.boolean(), occupantId: id.optional(), reservedBy: id.optional() });
export const companionWorldSceneSchema = z.object({ id, kind: z.enum(['home', 'commons']), name: z.string(), ownerId: id.optional(),
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
  route: z.array(z.object({ sceneId: id, x: z.number(), y: z.number() })), destinationId: id.optional(), furnitureId: id.optional(),
  routinePhase: z.enum(['awake', 'sleeping', 'eating', 'resting', 'habit']), activityLabel: z.string().optional(),
  communication: z.object({ channel: z.literal('phone'), phase: z.enum(['notification', 'typing', 'responding']), conversationId: id, recipientIds: z.array(id).max(20), untilReal: z.iso.datetime() }).optional() });
export const companionWorldVisitSchema = z.object({ id, guestId: id, hostId: id, status: z.enum(['requested', 'allowed', 'denied', 'left', 'expired']),
  reason: z.string(), response: z.string().optional(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), sourceMessageId: id.optional(), conversationId: id.optional() });
export const companionWorldEventSchema = z.object({ id, sequence: z.number().int().positive(), at: z.iso.datetime(), realAt: z.iso.datetime(),
  kind: z.string(), actorId: id.optional(), targetId: id.optional(), sceneId: id.optional(), text: z.string(), simulation: z.literal(true),
  sourceMessageId: id.optional(), conversationId: id.optional(), effect: z.object({ type: z.enum(['comfort', 'stress', 'shared_success', 'rest', 'social']), intensity: z.number().min(0).max(1) }).optional() });
export const companionWorldRelationshipSchema = z.object({ companionId: id, targetCompanionId: id, affinity: z.number().min(0).max(100),
  trust: z.number().min(0).max(100), interactions: z.number().int().nonnegative(), updatedAt: z.iso.datetime() });
export const companionWorldWorkSchema = z.object({ workId: id, companionId: id, kind: z.enum(['chat', 'action', 'schedule']),
  status: z.enum(['waiting', 'moving', 'seating', 'ready', 'ended']), computerId: id.optional(), nextCheckAt: z.iso.datetime().optional(), reason: z.string().optional() });
export const companionWorldJobSchema = z.object({ id, kind: z.enum(['decision', 'dream']), companionId: id, conversationId: id, status: z.enum(['pending', 'running', 'done', 'failed']),
  leaseToken: id.optional(), throughEventSequence: z.number().int().nonnegative(), createdAt: z.iso.datetime(), attempts: z.number().int().nonnegative(), sourceMemoryIds: z.array(id).max(20).default([]) });
export const companionWorldSnapshotSchema = z.object({
  settings: companionWorldSettingsSchema,
  clock: z.object({ realNow: z.iso.datetime(), virtualNow: z.iso.datetime(), speed: z.number().positive(), day: z.number().int(), hour: z.number().min(0).max(24), daylight: z.boolean() }),
  environment: z.object({ weather: z.enum(['clear', 'cloudy', 'rain', 'snow']), light: z.number().min(0).max(1), outdoorTemperature: z.number(), indoorTemperature: z.number() }),
  scenes: z.array(companionWorldSceneSchema), actors: z.array(companionWorldActorSchema), visits: z.array(companionWorldVisitSchema),
  residents: z.array(z.object({ companionId: id, name: z.string(), homeSceneId: id })),
  events: z.array(companionWorldEventSchema), relationships: z.array(companionWorldRelationshipSchema), works: z.array(companionWorldWorkSchema),
  lastEventSequence: z.number().int().nonnegative(), backlog: z.boolean(),
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
export type CompanionWorldTime = z.infer<typeof companionWorldTimeSchema>;
export type CompanionWorldScope = { companionId: string; conversationId: string; beforeSequence?: number };
export type CompanionWorldOccupancy = { start: number; end: number; phase: 'sleeping' | 'eating' | 'resting' | 'habit'; habitId?: string; habitKind?: 'rest' | 'exercise' | 'study' | 'leisure' | 'custom' };
const scope = z.object({ companionId: id, conversationId: id, beforeSequence: z.number().int().positive().optional() });
export const companionWorldPublicCommands = [
  z.strictObject({ type: z.literal('world.snapshot') }),
  z.strictObject({ type: z.literal('world.configure'), expectedRevision: z.number().int().positive(), patch: companionWorldSettingsSchema.omit({ revision: true }).partial() }),
  scope.extend({ type: z.literal('world.observe') }).strict(),
  scope.extend({ type: z.literal('world.tool'), sourceMessageId: id.optional(), arguments: companionWorldArgumentsSchema }).strict(),
] as const;
export const companionWorldStorageCommands = [
  ...companionWorldPublicCommands,
  z.strictObject({ type: z.literal('world.clock'), since: z.array(z.iso.datetime()).max(10).optional() }),
  z.strictObject({ type: z.literal('world.tick'), now: z.iso.datetime().optional(), snapshot: z.boolean().default(false) }),
  scope.extend({ type: z.literal('world.attention.record'), sourceMessageId: id, sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/), urgency: z.enum(['urgent', 'ordinary']), confidence: z.number().min(0).max(1), evidence: z.array(z.string().min(1).max(4000)).min(1).max(10), reason: z.string().min(1).max(1000) }).strict(),
  scope.extend({ type: z.literal('world.work.begin'), workId: id, kind: z.enum(['chat', 'action', 'schedule']), sourceMessageId: id.optional(), urgent: z.boolean().default(false), fixed: z.boolean().default(false) }).strict(),
  z.strictObject({ type: z.literal('world.work.ready'), companionId: id, workId: id }),
  z.strictObject({ type: z.literal('world.work.end'), companionId: id, workId: id }),
  z.strictObject({ type: z.literal('world.job.claim'), kind: z.enum(['decision', 'dream']) }),
  z.strictObject({ type: z.literal('world.job.complete'), id, leaseToken: id, action: companionWorldArgumentsSchema.optional(), sourceMemoryIds: z.array(id).max(30).default([]), memoryCandidates: z.array(companionMemoryCandidateSchema).max(20).default([]),
    dream: z.strictObject({ text: z.string().max(8000), sourceMessageIds: z.array(id).min(1).max(30), relatedMemoryIds: z.array(id).min(1).max(30), evidence: z.array(z.object({ sourceMessageId: id, quote: z.string().min(1).max(4000) })).min(1).max(60) }).optional(),
    appraisals: z.array(z.strictObject({ eventId: id, targetCompanionId: id, type: z.enum(['support', 'respect', 'boundary_violation', 'hostility', 'shared_success', 'repair', 'disappointment']), intensity: z.number().min(0).max(1), confidence: z.number().min(0).max(1) })).max(10).default([]) }),
  z.strictObject({ type: z.literal('world.job.fail'), id, leaseToken: id, error: z.string().max(2000) }),
] as const;
