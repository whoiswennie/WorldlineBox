import { z } from 'zod';

/** All paths are owner-relative. This manifest describes real files, never
 * fictional memories or a second copy of a character's authored settings. */
export const COMPANION_INSTANCE_LAYOUT = {
  profile: 'profile.md', fragments: 'profile.fragments.json', prompts: '提示词/manifest.json', memoryPolicy: '认知策略.json',
  roleGuidance: '提示词/角色指导', processorPrompts: '提示词/处理职能',
  diary: '记忆/经历', knowledge: '记忆/知识', development: '记忆/自我认识', timeline: '记忆/导航',
  origin: '演化/起点', goals: '演化/目标', growth: '演化/发布',
  sources: '证据/来源', history: '证据/历史', images: '形象',
  index: '.运行/索引', views: '.运行/视图', publications: '.运行/发布', contexts: '.运行/上下文',
} as const;
export const companionInstanceSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-instance-v2'),
  companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), createdAt: z.iso.datetime(),
  files: z.object(Object.fromEntries(Object.entries(COMPANION_INSTANCE_LAYOUT).map(([key, value]) => [key, z.literal(value)])) as {
    [K in keyof typeof COMPANION_INSTANCE_LAYOUT]: z.ZodLiteral<typeof COMPANION_INSTANCE_LAYOUT[K]>
  }).strict(),
});
export type CompanionInstance = z.infer<typeof companionInstanceSchema>;
export interface CompanionAssetLocation { libraryId: string; libraryPath: string; linkedFolderId: string; relativePath: string }
