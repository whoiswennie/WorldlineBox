import { z } from 'zod';

/** Model request provenance for diagnostics and context snapshots. This does
 * not impose request, token, daily or cost allowances. */
export const companionModelRequestPurposeSchema = z.enum(['reply', 'journal', 'reflection', 'consolidation', 'dream', 'tags', 'timeline', 'learning', 'world', 'repair', 'other']);
export type CompanionModelRequestPurpose = z.infer<typeof companionModelRequestPurposeSchema>;
