/** Bundled progressive Agent Vault methodology skill provider. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'

const PROVIDER = 'worldline-agent-vault'
const ROOT = new URL('../assets/', import.meta.url)
const BASE = { kind: 'directory', path: fileURLToPath(ROOT) } as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const definitions = [
  ['agent-vault-orientation', 'Orient yourself in your private Vault, inspect boundaries, and select the smallest correct recall or maintenance workflow.'],
  ['memory-capture', 'Save a user-requested fact or event immediately as bounded short memory with provenance and retrieval terms.'],
  ['memory-consolidation', 'Normalize and consolidate a large short-memory backlog safely with bounded batches, checkpoints, conflicts, and verification.'],
  ['memory-governance', 'Audit, repair, test, and gradually promote medium memory into durable long-term Wiki knowledge.'],
  ['memory-recall', 'Use multi-probe lexical recall and bounded Wiki exploration without loading the entire Vault.'],
  ['self-development', 'Inspect or deliberately evolve structured identity, appearance, persona, emotion, state, relationships, and common cognition.'],
  ['capability-learning', 'Discover, record, test, and certify procedural methods and experience without confusing knowledge with executable ability.'],
  ['resource-expression', 'Find and use expression or source resources naturally by semantic intent without injecting the complete resource catalog.'],
  ['companion-creation', 'Create a new virtual companion after an explicit user request, including an independent Agent Vault and safe default artwork when no image is supplied.'],
] as const

const candidates: SkillCandidate[] = definitions.map(([name, description]) => ({
  name, description, invocation: INVOCATION, source: 'bundled', provider: PROVIDER,
  resourceBase: BASE, rank: BUNDLED_SKILL_RANK, locator: new URL(`${name}.md`, ROOT),
}))

const provider: SkillProvider = {
  name: PROVIDER,
  list: () => Promise.resolve(candidates),
  async get(candidate): Promise<SkillDefinition> {
    return { name: candidate.name, description: candidate.description, invocation: candidate.invocation,
      source: candidate.source, provider: candidate.provider, resourceBase: BASE,
      content: await readFile(candidate.locator as URL, 'utf8') }
  },
}

export const name = 'skill-agent-vault'
export const inject = ['skills']
export function apply(ctx: Context): void { ctx.skills.registerProvider(() => provider) }
