import { z } from 'zod';

export type BotMaintenanceKind = 'organize' | 'dream';
export type BotMaintenanceStatus = 'queued' | 'running' | 'review' | 'applying' | 'completed' | 'cancelled' | 'failed' | 'blocked';
export type BotMaintenanceCandidateStatus = 'pending' | 'approved' | 'rejected' | 'applying' | 'applied' | 'superseded' | 'conflict' | 'unknown';
export interface BotMaintenanceSettings {
  enabled: boolean; kind: BotMaintenanceKind; intervalHours: number; idleMinutes: number; minNotes: number; autoApply: 'never' | 'lossless';
  nextEligibleAt: string; lastActivityAt: string; lastRunAt?: string; blockedReason?: string;
  autoReview?: boolean;
}
export interface BotMaintenanceJob {
  id: string; kind: BotMaintenanceKind; status: BotMaintenanceStatus; phase: string; automatic: boolean;
  createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; elapsedMs: number; attempts: number; error?: string;
  metrics: { examined: number; selected: number; deferred: number; candidates: number; applied: number; rejected: number; superseded?: number; incremental?: boolean; context?: number };
  narrative?: string; nextCursor?: string;
  autoReview?: { state: 'queued' | 'running' | 'waiting' | 'manual' | 'done'; total: number; reviewed: number; manual: number;
    currentPosition?: number; busyJobId?: string; startedAt?: string; retryAt?: string; error?: string };
}
export interface BotMaintenanceCandidateSummary {
  id: string; jobId: string; type: 'organize' | 'update' | 'insight' | 'archive'; title: string;
  status: BotMaintenanceCandidateStatus; revision: string; sourceCount: number; uncertaintyCount: number; updatedAt: string;
  autoReview?: { state: 'queued' | 'running' | 'waiting' | 'manual' | 'reviewed'; reason?: string };
}
export interface BotMaintenanceCandidateDetail extends BotMaintenanceCandidateSummary {
  content: string; tags: string[]; reason: string; uncertainties: string[]; quotes: Array<{ sourceId: string; text: string }>;
  sources: Array<{ id: string; checksum: string; createdAt: string; tags: string[] }>;
  receipt?: Record<string, unknown>;
  approval?: { actor: 'user' | 'model' | 'lossless'; approvedAt: string };
  execution?: { operation: 'apply' | 'reconcile'; state: 'queued' | 'running' };
}
export interface BotMaintenanceReviewRecord {
  id: string; jobId: string; candidateId: string; candidateRevision: string; createdAt: string;
  actor: 'user' | 'model' | 'lossless'; decision: 'approve' | 'reject' | 'manual' | 'retry'; reason: string;
  model?: string; promptVersion?: string;
  cycle?: number;
  checks?: Array<{ criterion: string; passed: boolean; reason: string }>;
  evidence?: Array<{ sourceId: string; quote: string }>;
  sources?: Array<{ id: string; checksum: string }>;
}
export interface BotMaintenanceReviews { items: BotMaintenanceReviewRecord[]; nextCursor?: string }
export interface BotMaintenanceDiagnostic { id: number; phase: string; createdAt: string; preview: string; chars: number }
export interface BotMaintenanceList { items: BotMaintenanceJob[]; nextCursor?: string }
export interface BotMaintenanceCandidates { items: BotMaintenanceCandidateSummary[]; nextCursor?: string }
export interface BotMaintenanceDiagnostics { items: BotMaintenanceDiagnostic[]; nextAfter?: number; entry?: { id: number; text: string; offset: number; nextOffset?: number; total: number } }
const id = z.string().min(1).max(160), scope = { conversationId: id, companionId: id };
export const botMaintenanceSettingsPatchSchema = z.strictObject({ enabled: z.boolean().optional(), kind: z.enum(['organize', 'dream']).optional(),
  intervalHours: z.number().int().min(1).max(720).optional(), idleMinutes: z.number().int().min(1).max(1440).optional(),
  minNotes: z.number().int().min(4).max(1000).optional(), autoApply: z.enum(['never', 'lossless']).optional(), autoReview: z.boolean().optional() });
export const botMemoryMaintenanceSchemas = [
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.run'), kind: z.enum(['organize', 'dream']), requestId: id, cursor: z.string().max(1000).optional() }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.list'), cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.get'), jobId: id }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.candidates'), jobId: id, cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(12).optional() }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.candidate'), jobId: id, candidateId: id }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.resume'), jobId: id, candidateId: id, revision: z.string().regex(/^[a-f0-9]{64}$/), requestId: id }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.reviews'), jobId: id, candidateId: id.optional(), cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.diagnostics'), jobId: id, after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(20).optional(), entryId: z.number().int().positive().optional(), offset: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.review'), jobId: id, candidateId: id, revision: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approve', 'reject']), requestId: id }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.cancel'), jobId: id, requestId: id }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.retry'), jobId: id, requestId: id }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.settings.get') }),
  z.strictObject({ ...scope, type: z.literal('memory.maintenance.settings.update'), settings: botMaintenanceSettingsPatchSchema }),
] as const;
export type BotMemoryMaintenanceRequest = z.infer<typeof botMemoryMaintenanceSchemas[number]>;
