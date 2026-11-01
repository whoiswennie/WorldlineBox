import { z } from 'zod';
import { companionMemoryDescriptorSchema, companionMemoryScopeSchema } from './companion-memory';
import { companionMemoryProcedureContextListSchema } from './companion-procedure';

export const companionProcedureStatusReferencesSchema = z.array(z.strictObject({ id: companionMemoryDescriptorSchema.shape.id,
  contentRevision: companionMemoryDescriptorSchema.shape.contentRevision.unwrap() })).max(100);
export type CompanionProcedureStatusReferences = z.infer<typeof companionProcedureStatusReferencesSchema>;
/** Private current annotation projection; it never carries canonical prose. */
export const companionProcedureStatusCommandSchema = companionMemoryScopeSchema.extend({ type: z.literal('memory.procedures.status'),
  references: companionProcedureStatusReferencesSchema }).strict();
export const companionProcedureStatusResultSchema = z.strictObject({ memoryProcedureStatuses: companionMemoryProcedureContextListSchema,
  memoryDescriptors: z.array(companionMemoryDescriptorSchema).max(100) });
export function companionProcedureStatusResult(command: z.infer<typeof companionProcedureStatusCommandSchema>,
  response: { ok: boolean; memoryProcedureStatuses?: unknown; memoryDescriptors?: unknown }) {
  if (!response.ok) return;
  const parsed = companionProcedureStatusResultSchema.safeParse({ memoryProcedureStatuses: response.memoryProcedureStatuses, memoryDescriptors: response.memoryDescriptors });
  if (!parsed.success) return;
  const { memoryProcedureStatuses: statuses, memoryDescriptors: headers } = parsed.data;
  if (new Set(statuses.map(status => status.memoryId)).size !== statuses.length || new Set(headers.map(header => header.id)).size !== headers.length
    || headers.length !== statuses.length || statuses.some(status => !command.references.some(reference => reference.id === status.memoryId && reference.contentRevision === status.contentRevision)
      || !headers.some(header => header.id === status.memoryId && header.companionId === command.companionId && header.contentRevision === status.contentRevision))) return;
  return parsed.data;
}
