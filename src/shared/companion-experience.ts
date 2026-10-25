import { z } from 'zod';

const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), id = z.string().regex(/^exp_[a-f0-9]{48}$/u);
export const companionExperienceDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(value + 'T00:00:00Z'); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '经历日期无效。');
export const companionExperienceKindSchema = z.enum(['dsh', 'activity', 'learning', 'schedule', 'life', 'memory', 'dream']);
export const companionExperienceStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'paused', 'withdrawn']);
export const companionExperienceEntrySchema = z.object({ id, companionId: owner, day: companionExperienceDaySchema,
  occurredAt: z.iso.datetime(), updatedAt: z.iso.datetime(), timeZone: z.string().max(100), title: z.string().min(1).max(160),
  kind: companionExperienceKindSchema, origin: z.enum(['action', 'system']), status: companionExperienceStatusSchema,
  revision: z.number().int().positive(), summary: z.string().max(1000).optional(), archiveRelativePath: z.string().max(4096),
  source: z.object({ kind: z.enum(['action', 'activity', 'message', 'learning_round', 'learning_read', 'schedule', 'life', 'world_job', 'memory', 'world_event', 'memory_processing']),
    id: z.string().min(1).max(180), conversationId: owner.optional(), version: z.number().int().positive().optional() }),
});
export const companionExperienceDayPageSchema = z.object({ companionId: owner, timeZone: z.string(),
  days: z.array(z.object({ day: companionExperienceDaySchema, count: z.number().int().positive() })).max(62), hasMore: z.boolean(), nextCursor: z.string().max(4096).optional() });
export const companionExperienceEntryPageSchema = z.object({ companionId: owner, day: companionExperienceDaySchema, timeZone: z.string(),
  items: z.array(companionExperienceEntrySchema).max(100), hasMore: z.boolean(), nextCursor: z.string().max(4096).optional() });
export const companionExperienceDetailSchema = z.object({ entry: companionExperienceEntrySchema,
  sections: z.array(z.object({ title: z.string().max(160), text: z.string().max(1024 * 1024) })).max(12),
  artifacts: z.array(z.object({ label: z.string().max(160), relativePath: z.string().max(4096) })).max(30) });
export const companionExperienceCommands = [
  z.strictObject({ type: z.literal('experience.days'), companionId: owner, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(62).default(31) }),
  z.strictObject({ type: z.literal('experience.list'), companionId: owner, day: companionExperienceDaySchema, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).default(30) }),
  z.strictObject({ type: z.literal('experience.read'), companionId: owner, id }),
  z.strictObject({ type: z.literal('experience.rename'), companionId: owner, id, title: z.string().trim().min(1).max(160), expectedRevision: z.number().int().positive() }),
] as const;
/** The native delegate cannot select another owner or append system events. */
export const companionExperienceArgumentsSchema = z.union([
  z.strictObject({ action: z.literal('days'), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(30).default(20) }),
  z.strictObject({ action: z.literal('list'), day: companionExperienceDaySchema, cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(30).default(20) }),
  z.strictObject({ action: z.literal('read'), id }),
  z.strictObject({ action: z.literal('rename'), id, title: z.string().trim().min(1).max(160), expectedRevision: z.number().int().positive() }),
]);
/** Main-only processing receipt; absent from the public command union. */
export const companionExperiencePublishSchema = z.strictObject({ type: z.literal('experience.publish'), companionId: owner,
  id: z.string().min(1).max(180), title: z.string().min(1).max(160), status: z.string().min(1).max(40), summary: z.string().max(1000), conversationId: owner.optional() });
export function companionExperienceModelResponse<T extends { experienceDetail?: CompanionExperienceDetail; experiencePage?: CompanionExperienceEntryPage; actions?: unknown }>(input: T) {
  const response = { ...input }; delete response.actions;
  const detail = response.experienceDetail;
  // The list is a metadata index, not a second body-reading port.
  if (!detail) return response.experiencePage ? { ...response, experiencePage: { ...response.experiencePage,
    items: response.experiencePage.items.map(entry => { const metadata = { ...entry }; delete metadata.summary; return metadata; }) } } : response;
  let remaining = 8000, truncated = false;
  const sections = detail.sections.map(section => { const content = section.text.slice(0, remaining); remaining -= content.length; truncated ||= content.length < section.text.length; return { ...section, text: content }; }).filter(section => section.text);
  return { ...response, experienceDetail: { ...detail, sections }, truncated, completeRecordAvailable: true };
}
export type CompanionExperienceEntry = z.infer<typeof companionExperienceEntrySchema>;
export type CompanionExperienceKind = z.infer<typeof companionExperienceKindSchema>;
export type CompanionExperienceStatus = z.infer<typeof companionExperienceStatusSchema>;
export type CompanionExperienceDayPage = z.infer<typeof companionExperienceDayPageSchema>;
export type CompanionExperienceEntryPage = z.infer<typeof companionExperienceEntryPageSchema>;
export type CompanionExperienceDetail = z.infer<typeof companionExperienceDetailSchema>;
export type CompanionExperienceCommand = z.infer<typeof companionExperienceCommands[number]>;
