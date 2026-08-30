import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'worldline-video'
const SKILL_BODY_URL = new URL('../assets/worldline-video/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/worldline-video/', import.meta.url)),
} as const
const DESCRIPTION = 'Professionally inspect local and online videos with the built-in Worldline FFmpeg and yt-dlp tools. Use for video understanding, movie analysis, scene review, captions, timelines, and questions about video content.'
const CANDIDATE: SkillCandidate = {
  name: 'worldline-video',
  description: DESCRIPTION,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/**
 *  Register the built-in video workflow instructions.
 * @param ctx - Cordis context that owns the operation.
 */
export function registerVideoSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
