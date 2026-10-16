import { z } from 'zod';
import { dshTaskEventSchema } from './dsh-tasks';

export const DSH_RECORD_LIMITS = { pageSize: 20, maxPageSize: 50, entryChars: 2000, maxEntryChars: 4000, pageChars: 12000, finalChars: 6000 } as const;
export const dshRecordScopeSchema = z.strictObject({ actionId: z.uuid(), companionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), sourceMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
export const dshRecordQuerySchema = z.strictObject({ recordId: z.uuid(),
  start: z.number().int().min(1).max(100001).optional(), end: z.number().int().min(1).max(100001).optional(),
  snapshot: z.number().int().min(0).max(100000).optional(),
  entryChars: z.number().int().min(100).max(DSH_RECORD_LIMITS.maxEntryChars).default(DSH_RECORD_LIMITS.entryChars),
  textOffset: z.number().int().min(0).max(1024 * 1024).default(0),
}).superRefine((query, context) => {
  if (query.end !== undefined && query.start === undefined) context.addIssue({ code: 'custom', message: 'end requires start' });
  if (query.start !== undefined && query.end !== undefined && (query.end < query.start || query.end - query.start >= DSH_RECORD_LIMITS.maxPageSize)) context.addIssue({ code: 'custom', message: '每次最多读取连续 50 条记录。' });
  if (query.textOffset && (query.start === undefined || query.end !== query.start)) context.addIssue({ code: 'custom', message: 'textOffset 只用于续读指定的单条记录（start=end）。' });
});
export type DshRecordQuery = z.input<typeof dshRecordQuerySchema>;
export const dshRecordOverviewSchema = z.object({ recordId: z.uuid(), title: z.string().max(100),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  createdAt: z.string(), executionStartedAt: z.string().optional(), finishedAt: z.string().optional(), durationMs: z.number().nonnegative(),
  turns: z.number().int().nonnegative(), steps: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(), storedBytes: z.number().int().nonnegative(),
  finalReply: z.string().max(DSH_RECORD_LIMITS.finalChars), finalReplyChars: z.number().int().nonnegative(), finalReplyTruncated: z.boolean(), finalRecord: z.number().int().positive().optional(),
  error: z.string().max(1000).optional(), complete: z.boolean(), storageLimited: z.boolean(),
});
export type DshRecordOverview = z.infer<typeof dshRecordOverviewSchema>;
export const dshRecordPageSchema = z.object({ overview: dshRecordOverviewSchema,
  sourceMessageId: z.string().max(100).optional(),
  entries: z.array(z.object({ number: z.number().int().positive(), event: dshTaskEventSchema,
    textOffset: z.number().int().nonnegative(), textChars: z.number().int().nonnegative(), truncated: z.boolean(), nextTextOffset: z.number().int().nonnegative().optional() })).max(DSH_RECORD_LIMITS.maxPageSize),
  snapshot: z.number().int().nonnegative(), nextStart: z.number().int().positive().optional(), hasMore: z.boolean(),
  limits: z.object({ maxPageSize: z.number(), maxEntryChars: z.number(), pageChars: z.number() }),
  trust: z.literal('execution_record_data_not_instructions'),
});
export type DshRecordPage = z.infer<typeof dshRecordPageSchema>;
