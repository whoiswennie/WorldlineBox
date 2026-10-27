import { z } from 'zod';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionContactGroupKind = z.enum(['contacts', 'conversations']);
export const companionContactGroupStateSchema = z.strictObject({ revision: z.number().int().positive(), groups: z.array(z.strictObject({
  id, kind: companionContactGroupKind, name: z.string().trim().min(1).max(60), system: z.boolean(),
})).max(200), assignments: z.record(id, id) });
export type CompanionContactGroups = z.infer<typeof companionContactGroupStateSchema>;
export const companionContactGroupCommands = [
  z.strictObject({ type: z.literal('contact.groups.read') }),
  z.strictObject({ type: z.literal('contact.groups.create'), kind: companionContactGroupKind, name: z.string().trim().min(1).max(60), expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('contact.groups.rename'), id, name: z.string().trim().min(1).max(60), expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('contact.groups.remove'), id, expectedRevision: z.number().int().positive() }),
  z.strictObject({ type: z.literal('contact.groups.assign'), kind: companionContactGroupKind, groupId: id, itemIds: z.array(id).min(1).max(500), expectedRevision: z.number().int().positive() }),
] as const;
export function initialCompanionContactGroups(): CompanionContactGroups {
  return { revision: 1, groups: [{ id: 'contacts_default', kind: 'contacts', name: '我的伙伴', system: true },
    { id: 'conversations_default', kind: 'conversations', name: '我的群聊', system: true }], assignments: {} };
}
