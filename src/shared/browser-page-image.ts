import { z } from 'zod';
export const browserPageImageSchema = z.object({
  id: z.string().uuid(), tabId: z.string(), title: z.string(),
  phase: z.enum(['preparing', 'capturing', 'encoding', 'preview', 'saving', 'saved', 'failed', 'cancelled']),
  completed: z.number().nonnegative(), total: z.number().nonnegative(),
  width: z.number().nonnegative().optional(), height: z.number().nonnegative().optional(),
  bandHeight: z.number().positive().optional(), bands: z.number().int().nonnegative().optional(),
  bytes: z.number().nonnegative().optional(), savedPath: z.string().optional(), error: z.string().optional(),
});
export type BrowserPageImage = z.infer<typeof browserPageImageSchema>;
