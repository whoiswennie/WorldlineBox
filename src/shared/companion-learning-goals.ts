import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const text = z.string().trim().min(1).max(12000);
export const companionLearningGoalMaterialSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('library'), grantId: id }),
  z.strictObject({ kind: z.literal('asset'), grantId: id, assetId: z.string().min(1).max(255) }),
  z.strictObject({ kind: z.literal('file'), attachmentId: id, name: z.string().max(512).optional() }),
  z.strictObject({ kind: z.literal('web'), url: z.string().url().max(4096).refine(value => /^https?:\/\//iu.test(value)) }),
]);
export const companionLearningGoalScheduleSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(10080).default(60),
  /** Empty windows means any time; overnight windows are supported. Day 0 is Sunday. */
  windows: z.array(z.object({ startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(0).max(1439),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional() })).max(14).default([]),
  timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).default('UTC'),
});
export const companionLearningGoalPhaseSchema = z.enum(['idle', 'planning', 'reading', 'integrating', 'testing', 'reflecting', 'waiting']);
const evidence = z.object({ sourceId: id, quote: z.string().min(1).max(1000) });
export const companionLearningGoalReadSchema = z.object({ id, kind: z.enum(['library', 'asset', 'file', 'web']), title: z.string().max(512),
  grantId: id.optional(), assetId: z.string().max(255).optional(), sourceMessageId: id.optional(),
  uri: z.string().max(4096), revision: z.string().max(255), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  readAt: z.string(), characters: z.number().int().nonnegative(), excerpt: z.string().max(12000), truncated: z.boolean() });
export const companionLearningGoalPlanSchema = z.object({ focus: z.string().min(1).max(2000),
  questions: z.array(z.string().min(1).max(1000)).max(5), searchQueries: z.array(z.string().min(1).max(500)).max(3) });
export const companionLearningGoalRoundSchema = z.object({
  id, goalId: id, companionId: id, ordinal: z.number().int().positive(), startedAt: z.string(), updatedAt: z.string(), endedAt: z.string().optional(),
  status: z.enum(['running', 'completed', 'deferred', 'failed', 'cancelled']), phase: companionLearningGoalPhaseSchema,
  plan: companionLearningGoalPlanSchema.optional(), reads: z.array(companionLearningGoalReadSchema).max(6).default([]),
  readingIssues: z.array(z.string().max(1000)).max(10).optional(),
  summary: z.string().max(6000).optional(), claims: z.array(z.object({ text: z.string().max(2000), evidence: z.array(evidence).max(4) })).max(12).default([]),
  memoryIds: z.array(id).max(20).default([]),
  integration: z.object({ action: z.enum(['recorded', 'reused', 'revised']), noteId: id, version: z.number().int().positive(), reason: z.string().max(2000) }).optional(),
  selfTest: z.object({ kind: z.literal('self_test'), questions: z.array(z.object({ question: z.string().max(1500), answer: z.string().max(3000),
    evaluation: z.enum(['supported', 'partial', 'unsupported', 'unassessed']), rationale: z.string().max(2000), evidence: z.array(evidence).max(4) })).max(5),
    supportedAnswers: z.number().int().nonnegative(), assessedQuestions: z.number().int().nonnegative(),
    recall: z.object({ query: z.string().max(16000), contextHash: z.string().regex(/^[a-f0-9]{64}$/u), contextCharacters: z.number().int().nonnegative(), candidateMemoryIds: z.array(id).max(20) }).optional(),
    disclaimer: z.literal('模型自测与自评，仅核验引用来自本轮实际读取材料，不代表客观考试正确率或已经掌握。'),
  }).optional(),
  gaps: z.array(z.string().max(1500)).max(10).default([]), nextPlan: z.array(z.string().max(1500)).max(10).default([]),
  stateReflection: z.object({ focus: z.string().trim().min(1).max(300), reason: z.string().trim().min(1).max(1000),
    evidence: z.array(evidence).min(1).max(6), expectedRevision: z.number().int().positive(),
    outcome: z.enum(['applied', 'skipped', 'not_needed']).optional(), detail: z.string().max(1000).optional() }).optional(),
  error: z.string().max(2000).optional(),
});
export const companionLearningGoalSchema = z.object({ id, companionId: id, text, materials: z.array(companionLearningGoalMaterialSchema).max(20),
  allowWeb: z.boolean(), schedule: companionLearningGoalScheduleSchema, state: z.enum(['active', 'paused', 'stopped']), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(), nextAt: z.string(), phase: companionLearningGoalPhaseSchema, waitReason: z.string().max(2000).optional(),
  totalRounds: z.number().int().nonnegative(), lastRound: companionLearningGoalRoundSchema.optional(),
});
export const companionLearningGoalPageSchema = z.object({ items: z.array(companionLearningGoalSchema).max(50), hasMore: z.boolean(), nextCursor: z.number().int().nonnegative().optional() });
export const companionLearningGoalRoundPageSchema = z.object({ items: z.array(companionLearningGoalRoundSchema).max(50), hasMore: z.boolean(), nextCursor: z.number().int().nonnegative().optional() });
const create = { companionId: id, text, materials: z.array(companionLearningGoalMaterialSchema).max(20).default([]), allowWeb: z.boolean().default(false),
  schedule: companionLearningGoalScheduleSchema.default({ intervalMinutes: 60, windows: [], timeZone: 'UTC' }) };
const update = { companionId: id, id, expectedRevision: z.number().int().positive(), text: text.optional(), materials: z.array(companionLearningGoalMaterialSchema).max(20).optional(),
  allowWeb: z.boolean().optional(), schedule: companionLearningGoalScheduleSchema.optional(), state: z.enum(['active', 'paused', 'stopped']).optional() };
const page = { companionId: id, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) };
export const companionLearningGoalWorkspaceCommands = [
  z.strictObject({ type: z.literal('memory.learning.goals.list'), ...page }),
  z.strictObject({ type: z.literal('memory.learning.goals.create'), ...create }),
  z.strictObject({ type: z.literal('memory.learning.goals.update'), ...update }),
  z.strictObject({ type: z.literal('memory.learning.goals.run'), companionId: id, id, expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('memory.learning.goals.rounds'), ...page, id }),
] as const;
export const companionLearningGoalStorageCommands = [
  z.strictObject({ type: z.literal('learning.goals.list'), ...page }), z.strictObject({ type: z.literal('learning.goals.create'), ...create }),
  z.strictObject({ type: z.literal('learning.goals.update'), ...update }),
  z.strictObject({ type: z.literal('learning.goals.run'), companionId: id, id, expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('learning.goals.rounds'), ...page, id }),
  z.strictObject({ type: z.literal('learning.goals.claim'), excludedOwners: z.array(id).max(100).default([]), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('learning.goals.heartbeat'), id, leaseToken: id, leaseMs: z.number().int().min(1000).max(600000).default(120000), phase: companionLearningGoalPhaseSchema }),
  z.strictObject({ type: z.literal('learning.goals.checkpoint'), id, leaseToken: id, round: companionLearningGoalRoundSchema }),
  z.strictObject({ type: z.literal('learning.goals.source'), id, leaseToken: id, read: companionLearningGoalReadSchema }),
  z.strictObject({ type: z.literal('learning.goals.integrate'), id, leaseToken: id, content: z.string().min(1).max(65536),
    expectedProhibitionRevision: z.string().min(1).max(128),
    claimHash: z.string().regex(/^[a-f0-9]{64}$/u), reason: z.string().max(2000),
    target: z.object({ id, expectedVersion: z.number().int().positive(), action: z.enum(['reuse', 'revise']) }).optional(),
    evidence: z.array(z.object({ sourceMessageId: id, quote: z.string().min(1).max(1000) })).min(1).max(48) }),
  z.strictObject({ type: z.literal('learning.goals.finish'), id, leaseToken: id, round: companionLearningGoalRoundSchema, retryAfterMs: z.number().int().min(1000).max(604800000).optional() }),
] as const;
export const companionLearningGoalJobSchema = z.object({ goal: companionLearningGoalSchema, round: companionLearningGoalRoundSchema, previousRound: companionLearningGoalRoundSchema.optional(), leaseToken: id });
export const companionLearningGoalStorageCommandSchema = z.discriminatedUnion('type', companionLearningGoalStorageCommands);
export type CompanionLearningGoal = z.infer<typeof companionLearningGoalSchema>;
export type CompanionLearningGoalMaterial = z.infer<typeof companionLearningGoalMaterialSchema>;
export type CompanionLearningGoalRound = z.infer<typeof companionLearningGoalRoundSchema>;
export type CompanionLearningGoalRead = z.infer<typeof companionLearningGoalReadSchema>;
export type CompanionLearningGoalPlan = z.infer<typeof companionLearningGoalPlanSchema>;
export type CompanionLearningGoalJob = z.infer<typeof companionLearningGoalJobSchema>;
export type CompanionLearningGoalWorkspaceCommand = z.infer<(typeof companionLearningGoalWorkspaceCommands)[number]>;
