import { z } from 'zod';

export const companionMemoryFileReceiptSchema = z.strictObject({
  companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), noteId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
  contentRevision: z.number().int().positive(), path: z.string().min(1).max(768), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const companionMemoryFileReceiptsSchema = z.array(companionMemoryFileReceiptSchema);
export type CompanionMemoryFileReceipt = z.infer<typeof companionMemoryFileReceiptSchema>;
