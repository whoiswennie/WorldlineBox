import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const dshTaskSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
export const dshTaskInputSchema = z.strictObject({ prompt: z.string().min(1).max(65536), instanceId: id.optional(),
  sessionId: dshTaskSessionIdSchema.optional(), title: z.string().trim().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(), maxOutputBytes: z.number().int().min(1024).max(16 * 1024 ** 2).optional() });
export type DshTaskInput = z.infer<typeof dshTaskInputSchema>;
export const dshTaskRecordSchema = z.object({ id, operationId: id, instanceId: id, runtimeId: id, runtimeVersion: z.string().max(128),
  title: z.string().max(100), status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  sessionId: dshTaskSessionIdSchema.optional(), startedAt: z.string(), finishedAt: z.string().optional(), error: z.string().max(1000).optional(), code: z.number().int().nullable().optional() });
export type DshTaskRecord = z.infer<typeof dshTaskRecordSchema>;
export const dshTaskResultSchema = z.object({ taskId: id, instanceId: id, runtimeId: id, runtimeVersion: z.string().max(128),
  sessionId: dshTaskSessionIdSchema.optional(), text: z.string().max(1024 * 1024).optional(), code: z.number().int().nullable().optional() });
export type DshTaskResult = z.infer<typeof dshTaskResultSchema>;
export const dshTaskEventSchema = z.object({ taskId: id, sequence: z.number().int().min(0), type: z.string().max(100), receivedAt: z.string(),
  sessionId: dshTaskSessionIdSchema.optional(), text: z.string().max(1024 * 1024).optional(), code: z.string().max(100).optional() });
export type DshTaskEvent = z.infer<typeof dshTaskEventSchema>;
