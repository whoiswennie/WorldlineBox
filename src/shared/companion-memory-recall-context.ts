import { z } from 'zod';
import { companionMemoryContextEvidenceSchema } from './companion-memory-context-evidence';
import { companionMemoryFileReceiptsSchema } from './companion-memory-files';
import { companionMemorySelectionSchema } from './companion-memory-selection';
import { companionMemoryProcedureContextListSchema } from './companion-procedure';
import { companionMemoryTypeScopeSchema } from './companion-memory-scope';

/** One wire contract for Main results and frozen task/social recall receipts.
 * A missing type scope is display-only; MemoryService refuses it as a formal
 * reusable context. No crossing may silently strip an actual typed scope. */
export const companionMemoryRecallContextSchema = z.strictObject({
  text: z.string().max(1024 * 1024), revision: z.string().max(1024), profileKey: z.string().max(4096),
  typeScope: companionMemoryTypeScopeSchema.optional(), selection: companionMemorySelectionSchema.optional(),
  proceduralStatus: companionMemoryProcedureContextListSchema.optional(), fileReceipts: companionMemoryFileReceiptsSchema.optional(),
  evidence: companionMemoryContextEvidenceSchema.optional(),
});
export type CompanionMemoryRecallContext = z.infer<typeof companionMemoryRecallContextSchema>;
