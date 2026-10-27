import { z } from 'zod';

/** All paths are owner-relative. This manifest describes real files, never
 * fictional memories or a second copy of a character's authored settings. */
export const COMPANION_INSTANCE_LAYOUT = {
  profile: 'profile.md', prompts: '提示词/manifest.json', memoryPolicy: '记忆策略.json',
  diary: '日记', knowledge: '资料', development: '自我认识', world: '世界经历', timeline: '时间线',
  sources: '来源', history: '记忆历史', images: '形象', index: '.认知索引',
} as const;
export const companionInstanceSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-instance-v1'),
  companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), createdAt: z.iso.datetime(),
  files: z.object(Object.fromEntries(Object.entries(COMPANION_INSTANCE_LAYOUT).map(([key, value]) => [key, z.literal(value)])) as {
    [K in keyof typeof COMPANION_INSTANCE_LAYOUT]: z.ZodLiteral<typeof COMPANION_INSTANCE_LAYOUT[K]>
  }).strict(),
});
export type CompanionInstance = z.infer<typeof companionInstanceSchema>;
export interface CompanionAssetLocation { libraryId: string; libraryPath: string; linkedFolderId: string; relativePath: string }
