import { z } from 'zod';

export const dshPluginPackageNameSchema = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i);
export const dshInstalledPluginSchema = z.object({ name: dshPluginPackageNameSchema, spec: z.string().max(2048),
  version: z.string().max(128).optional(), description: z.string().max(4000), enabled: z.boolean(), bundle: z.boolean(), core: z.boolean(),
  removable: z.boolean().optional(), toggleable: z.boolean().optional(),
  scope: z.enum(['instance', 'runtime', 'missing']).optional(), installPath: z.string().max(4096).optional(),
  sourceUrl: z.string().max(2048).optional(), error: z.string().optional() });
export type DshInstalledPlugin = z.infer<typeof dshInstalledPluginSchema>;
