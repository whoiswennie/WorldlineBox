/** Seven bundled workflows for authoring and operating the current Worldline format. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'worldline-domain'

/** Identifies the package-owned worldline skills value.
 */
export const WORLDLINE_SKILLS = [
  ['worldline-authoring', 'Create and revise Canon sources with stable identity, provenance, and explicit author authority.'],
  ['worldline-character-design', 'Design executable characters whose traits, relationships, resources, and actions remain source-grounded.'],
  ['worldline-map-design', 'Design and audit structured Worldline maps, topology, travel constraints, layers, and provenance.'],
  ['worldline-mechanism-design', 'Turn authored rules into reviewable actions, systems, invariants, retry policy, and conflict semantics.'],
  ['worldline-scenario-design', 'Design simulation scenarios, initial conditions, actors, goals, seeds, and observable success criteria.'],
  ['worldline-build-audit', 'Compile and audit closure, diagnostics, questions, proposals, provenance coverage, and immutable freezing.'],
  ['worldline-simulation-analysis', 'Analyze deterministic Runs, event causality, processes, reservations, deadlocks, AI audit, and branches.'],
] as const

type WorldlineSkillName = typeof WORLDLINE_SKILLS[number][0]

const WORLDLINE_SKILL_REFERENCES: Readonly<Record<WorldlineSkillName, string>> = {
  'worldline-authoring': 'authority.md',
  'worldline-character-design': 'character-model.md',
  'worldline-map-design': 'map-model.md',
  'worldline-mechanism-design': 'mechanism-checklist.md',
  'worldline-scenario-design': 'scenario-template.md',
  'worldline-build-audit': 'build-gates.md',
  'worldline-simulation-analysis': 'run-diagnostics.md',
}

function skillUrl(name: WorldlineSkillName): URL {
  return new URL(`../assets/skills/${name}/SKILL.md`, import.meta.url)
}

function referenceUrl(name: WorldlineSkillName): URL {
  return new URL(
    `../assets/skills/${name}/references/${WORLDLINE_SKILL_REFERENCES[name]}`,
    import.meta.url,
  )
}

/** Identifies the package-owned worldline skill candidates value.
 */
export const WORLDLINE_SKILL_CANDIDATES: readonly SkillCandidate[] = WORLDLINE_SKILLS.map(
  ([name, description]) => ({
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    locator: skillUrl(name),
  }),
)

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(WORLDLINE_SKILL_CANDIDATES),
  async get(candidate): Promise<SkillDefinition | undefined> {
    const matched = WORLDLINE_SKILL_CANDIDATES.find(item => item.name === candidate.name)
    if (matched === undefined || !(matched.locator instanceof URL)) return undefined
    const reference = await readFile(referenceUrl(matched.name as WorldlineSkillName), 'utf8')
    return {
      name: matched.name,
      description: matched.description,
      invocation: matched.invocation,
      provider: matched.provider,
      source: matched.source,
      content: `${await readFile(matched.locator, 'utf8').then(value => value.trimEnd())}\n\n`
        + `## 已加载的当前格式参考\n\n${reference.trim()}\n`,
    }
  },
}

export const name = 'skill-worldline'
export const inject = ['skills']

/** Register one bundled provider; project `.worldline/skills` entries win through registry rank. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
