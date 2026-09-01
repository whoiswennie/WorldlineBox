import type { CanonObjectKind } from './model.ts'

const CANON_KINDS = new Set<CanonObjectKind>([
  'charter',
  'character',
  'place',
  'organization',
  'species',
  'item',
  'concept',
  'rule',
  'relation',
  'fact',
  'timeline-event',
  'scenario',
  'asset',
  'custom',
])

/** Describes the canon kind resolution value exchanged across the package boundary.
 */
export interface CanonKindResolution {
  readonly kind: CanonObjectKind
  readonly customKind?: string
}

/** Resolve the one current Canon object classification shared by compiler and clients.
 * @param path - The path supplied by the caller.
 * @param explicit - The explicit supplied by the caller.
 * @returns The result produced by the operation.
 */
export function inferCanonObjectKind(path: string, explicit?: string): CanonKindResolution {
  if (explicit !== undefined) {
    return CANON_KINDS.has(explicit as CanonObjectKind)
      ? { kind: explicit as CanonObjectKind }
      : { kind: 'custom', customKind: explicit }
  }
  const normalized = path.replace(/\\/gu, '/').toLocaleLowerCase('en-US')
  if (normalized === 'canon/charter.md') return { kind: 'charter' }
  if (normalized.startsWith('characters/')) return { kind: 'character' }
  if (normalized.startsWith('places/') || normalized.startsWith('maps/')) return { kind: 'place' }
  if (normalized.startsWith('organizations/') || normalized.startsWith('factions/')) return { kind: 'organization' }
  if (normalized.startsWith('species/')) return { kind: 'species' }
  if (normalized.startsWith('items/')) return { kind: 'item' }
  if (normalized.startsWith('concepts/')) return { kind: 'concept' }
  if (normalized.startsWith('rules/') || normalized.startsWith('mechanisms/')) return { kind: 'rule' }
  if (normalized.startsWith('relations/')) return { kind: 'relation' }
  if (normalized.startsWith('facts/')) return { kind: 'fact' }
  if (normalized.includes('timeline')) return { kind: 'timeline-event' }
  if (normalized.startsWith('scenarios/')) return { kind: 'scenario' }
  if (normalized.startsWith('assets/')) return { kind: 'asset' }
  return { kind: 'custom', customKind: 'document' }
}
