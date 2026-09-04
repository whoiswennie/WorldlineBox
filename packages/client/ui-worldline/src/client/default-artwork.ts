import type { CanonObjectKind } from '@deepseek-ai/dsh-worldline-standard/types'

const ART_ROOT = '/worldline-experience/worldline-defaults'

export const DEFAULT_CHARACTER_ART = [
  { label: '幻 · 白色形态', value: '/worldline-experience/default-companion.png' },
  { label: '幻 · 黑色形态', value: '/worldline-experience/default-companion-dark.png' },
] as const

export const DEFAULT_MAP_ARTWORK = `${ART_ROOT}/map.png`

export const DEFAULT_ARTWORK: Readonly<Record<CanonObjectKind, string>> = {
  charter: `${ART_ROOT}/charter.png`,
  character: DEFAULT_CHARACTER_ART[0].value,
  place: `${ART_ROOT}/place.png`,
  organization: `${ART_ROOT}/organization.png`,
  species: `${ART_ROOT}/species.png`,
  item: `${ART_ROOT}/item.png`,
  concept: `${ART_ROOT}/concept.png`,
  rule: `${ART_ROOT}/rule.png`,
  relation: `${ART_ROOT}/relation.png`,
  fact: `${ART_ROOT}/fact.png`,
  'timeline-event': `${ART_ROOT}/timeline-event.png`,
  scenario: `${ART_ROOT}/scenario.png`,
  asset: `${ART_ROOT}/asset.png`,
  custom: `${ART_ROOT}/custom.png`,
}

function hash(value: string): number {
  let result = 2_166_136_261
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0
    result = Math.imul(result, 16_777_619)
  }
  return result >>> 0
}

/** Keep the apparent random Huan form stable for one character across reloads. */
export function defaultCharacterArtwork(identity: string): string {
  return DEFAULT_CHARACTER_ART[hash(identity) % DEFAULT_CHARACTER_ART.length]?.value
    ?? DEFAULT_CHARACTER_ART[0].value
}

export function randomCharacterArtwork(): string {
  return DEFAULT_CHARACTER_ART[Math.floor(Math.random() * DEFAULT_CHARACTER_ART.length)]?.value
    ?? DEFAULT_CHARACTER_ART[0].value
}

export function defaultArtwork(kind: CanonObjectKind, identity: string): string {
  return kind === 'character' ? defaultCharacterArtwork(identity) : DEFAULT_ARTWORK[kind]
}

export function artworkSources(
  authored: string | undefined,
  kind: CanonObjectKind,
  identity: string,
): readonly string[] {
  return [...new Set([authored, defaultArtwork(kind, identity)]
    .filter((source): source is string => source !== undefined && source !== ''))]
}
