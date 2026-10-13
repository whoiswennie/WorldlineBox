import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const dshRepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const dshSkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const dshMarketKindSchema = z.enum(['plugin', 'skill']);
export const dshMarketEntrySchema = z.object({
  id: z.string().min(1).max(512), kind: dshMarketKindSchema, name: z.string().max(200), description: z.string().max(4000),
  sourceUrl: z.string().max(2048), repository: dshRepositorySchema.optional(), npmName: z.string().max(214).optional(),
  version: z.string().max(128).optional(), category: z.string().max(100), stars: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(), riskLabels: z.array(z.string().max(100)).max(30),
  capabilities: z.array(z.string().max(100)).max(50).optional(),
});
export type DshMarketEntry = z.infer<typeof dshMarketEntrySchema>;
export const dshMarketPageSchema = z.object({
  kind: dshMarketKindSchema, query: z.string().max(200), page: z.number().int().min(1), pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(), entries: z.array(dshMarketEntrySchema).max(100), fetchedAt: z.string().optional(),
  stale: z.boolean(), error: z.string().optional(),
});
export type DshMarketPage = z.infer<typeof dshMarketPageSchema>;
export const dshSkillTargetSchema = z.object({
  repository: dshRepositorySchema, commit: z.string().regex(/^[a-f0-9]{40}$/), archiveSha256: digest,
  sourcePath: z.string().min(1).max(2000), name: dshSkillNameSchema, description: z.string().max(4000),
});
export type DshSkillTarget = z.infer<typeof dshSkillTargetSchema>;
export const dshSkillInspectionSchema = z.object({ repository: dshRepositorySchema, commit: z.string().regex(/^[a-f0-9]{40}$/),
  archiveSha256: digest, targets: z.array(dshSkillTargetSchema).max(1000), });
export type DshSkillInspection = z.infer<typeof dshSkillInspectionSchema>;
export const dshInstalledSkillSchema = z.object({
  name: dshSkillNameSchema, description: z.string().max(4000), enabled: z.boolean(), path: z.string(), managed: z.boolean(),
  repository: dshRepositorySchema.optional(), commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  archiveSha256: digest.optional(), sourcePath: z.string().max(2000).optional(), installedAt: z.string().optional(),
});
export type DshInstalledSkill = z.infer<typeof dshInstalledSkillSchema>;
export const dshMarketplaceStateSchema = z.object({ plugins: dshMarketPageSchema.optional(), skills: dshMarketPageSchema.optional() });
export type DshMarketplaceState = z.infer<typeof dshMarketplaceStateSchema>;
