import { z } from 'zod';
import { dshExecutionAccessModeSchema } from './dsh-access';
import { dshTaskArtifactSchema, dshTaskCapabilitiesSchema, dshTaskSpecSchema, dshEffectiveCapabilitiesSchema, dshDeliveryVerificationSchema } from './dsh-task-spec';

const id = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const dshTaskSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
export const dshTaskInputSchema = z.strictObject({ prompt: z.string().min(1).max(65536), instanceId: id.optional(),
  sessionId: dshTaskSessionIdSchema.optional(), title: z.string().trim().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(), maxOutputBytes: z.number().int().min(1024).max(16 * 1024 ** 2).optional() });
export type DshTaskInput = z.infer<typeof dshTaskInputSchema>;
export const dshTaskRecordSchema = z.object({ id, operationId: id, instanceId: id, runtimeId: id, runtimeVersion: z.string().max(128),
  title: z.string().max(100), status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  accessMode: dshExecutionAccessModeSchema.optional(),
  profile: dshTaskSpecSchema.pick({ mode: true, tools: true, skills: true }).optional(),
  effective: dshEffectiveCapabilitiesSchema.optional(), constraintsDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  taskWorkspaceRoot: z.string().max(4096).optional(),
  sessionWorkspacePath: z.string().max(4096).optional(),
  workspacePath: z.string().max(4096).optional(), pid: z.number().int().positive().optional(),
  sessionId: dshTaskSessionIdSchema.optional(), startedAt: z.string(), finishedAt: z.string().optional(), error: z.string().max(1000).optional(), code: z.number().int().nullable().optional() });
export type DshTaskRecord = z.infer<typeof dshTaskRecordSchema>;
export const dshTaskResultSchema = z.object({ taskId: id, instanceId: id, runtimeId: id, runtimeVersion: z.string().max(128),
  sessionId: dshTaskSessionIdSchema.optional(), text: z.string().max(1024 * 1024).optional(), code: z.number().int().nullable().optional(),
  workspacePath: z.string().optional(), mode: z.enum(['native', 'ptc']).optional(), artifacts: z.array(dshTaskArtifactSchema).max(100).optional(),
  structured: z.unknown().optional(), capabilities: dshTaskCapabilitiesSchema.optional(),
  verification: dshDeliveryVerificationSchema.optional(), effective: dshEffectiveCapabilitiesSchema.optional() });
export type DshTaskResult = z.infer<typeof dshTaskResultSchema>;
export const dshTaskEventSchema = z.object({ taskId: id, sequence: z.number().int().min(0), type: z.string().max(100), receivedAt: z.string(),
  sessionId: dshTaskSessionIdSchema.optional(), text: z.string().max(1024 * 1024).optional(), code: z.string().max(100).optional(),
  stage: z.enum(['preparing', 'starting', 'session', 'turn_start', 'step_start', 'step_end', 'turn_end', 'tool_prepare', 'tool_start', 'tool_end', 'message', 'completed', 'failed']).optional(),
  contentKind: z.enum(['input', 'output', 'message']).optional(), callId: z.string().max(200).optional(),
  streamId: z.string().max(100).optional(),
  outputState: z.enum(['draft', 'committed', 'abandoned']).optional(),
  artifacts: z.array(dshTaskArtifactSchema).max(100).optional(),
  toolName: z.string().max(100).optional(), summary: z.string().max(1000).optional() });
export type DshTaskEvent = z.infer<typeof dshTaskEventSchema>;
