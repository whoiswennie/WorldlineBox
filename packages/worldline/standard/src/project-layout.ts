import type { CanonObjectKind } from './model.ts'

export type StandardCanonObjectKind = Exclude<CanonObjectKind, 'custom'>

/**
 * The one current on-disk contract for a Worldline OC project.
 *
 * Authored Markdown and media are portable truth. Everything under `.worldline`
 * is managed runtime state and must never be edited as authored canon.
 */
export const WORLDLINE_PROJECT_LAYOUT = {
  manifest: 'worldline.toml',
  canonDirectories: {
    charter: 'canon',
    character: 'characters',
    species: 'species',
    place: 'maps/places',
    organization: 'organizations',
    relation: 'relations',
    rule: 'mechanisms',
    concept: 'concepts',
    fact: 'facts',
    item: 'items',
    asset: 'assets/catalog',
    scenario: 'scenarios/plot-points',
    'timeline-event': 'timelines',
  } satisfies Readonly<Record<StandardCanonObjectKind, string>>,
  mediaDirectory: 'assets/files',
  control: {
    root: '.worldline',
    metadata: '.worldline/index.json',
    history: '.worldline/history',
    builds: '.worldline/builds',
    runs: '.worldline/runs',
    trash: '.worldline/trash',
    transfers: '.worldline/transfers',
  },
} as const

export function canonDirectory(kind: StandardCanonObjectKind): string {
  return WORLDLINE_PROJECT_LAYOUT.canonDirectories[kind]
}

export function canonPathBelongsToKind(path: string, kind: StandardCanonObjectKind): boolean {
  const normalized = path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '').toLocaleLowerCase('en-US')
  const directory = canonDirectory(kind).toLocaleLowerCase('en-US')
  return normalized.startsWith(`${directory}/`)
}
