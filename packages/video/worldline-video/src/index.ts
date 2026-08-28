/** Worldline-native video tools and bundled skill. */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-skill'
import '@deepseek-ai/dsh-subprocess'
import '@deepseek-ai/dsh-tools'
import { registerVideoSkill } from './skill.ts'
import { registerVideoTools } from './tools.ts'

export const name = 'worldline-video'
export const inject = ['tools', 'skills', 'subprocess']

/** Register the complete Worldline video capability. */
export function apply(ctx: Context): void {
  registerVideoTools(ctx)
  registerVideoSkill(ctx)
}

export { createChapters, indexVideo, probeVideo, readVideoRange } from './pipeline.ts'
export { captionsForRange, parseAss, parseVttOrSrt } from './captions.ts'
export { classifySource, resolveVideoExecutables } from './resolver.ts'
export type { CaptionSegment, VideoChapter, VideoManifest, VideoProbe } from './types.ts'
