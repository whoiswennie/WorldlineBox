import { z } from 'zod';
import { companionArtifactHash } from './artifact-registry';
import { companionArtifactReferenceSchema, companionArtifactVisibilitySchema, type CompanionArtifactVisibility } from '../../shared/companion-artifact';

export const companionPersonaFragmentSchema = z.strictObject({ fragmentId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/u),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceRefs: z.array(companionArtifactReferenceSchema).max(128), dependencyRefs: z.array(companionArtifactReferenceSchema).max(128),
  visibility: companionArtifactVisibilitySchema, disclosure: z.literal('identity_content'),
});
export type CompanionPersonaFragment = z.infer<typeof companionPersonaFragmentSchema>;
export const companionPersonaFragmentsSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-persona-fragments-v2'),
  companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), profileHash: z.string().regex(/^[a-f0-9]{64}$/u),
  personaHash: z.string().regex(/^[a-f0-9]{64}$/u), fragments: z.array(companionPersonaFragmentSchema).min(1).max(64) });
export type CompanionPersonaFragments = z.infer<typeof companionPersonaFragmentsSchema>;

export function initialCompanionPersonaFragments(companionId: string, profileHash: string, persona: string): CompanionPersonaFragments {
  const paragraphs = [...persona.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/gu)].filter(match => match[0].trim());
  const pieces = paragraphs.length <= 32 ? paragraphs : [{ index: 0, 0: persona }];
  return companionPersonaFragmentsSchema.parse({ schema: 'worldlinebox.companion-persona-fragments-v2', companionId, profileHash,
    personaHash: companionArtifactHash(persona), fragments: pieces.map((match, index) => ({ fragmentId: `origin:${index + 1}`,
      start: match.index, end: match.index! + match[0].length, contentHash: companionArtifactHash(match[0]),
      sourceRefs: [], dependencyRefs: [], visibility: { scope: 'public' }, disclosure: 'identity_content' })) });
}
export function validateCompanionPersonaFragments(persona: string, ledger: CompanionPersonaFragments, expected: { companionId: string; profileHash: string }): void {
  companionPersonaFragmentsSchema.parse(ledger);
  if (ledger.companionId !== expected.companionId || ledger.profileHash !== expected.profileHash || ledger.personaHash !== companionArtifactHash(persona))
    throw new Error('人格片段清单与唯一当前人格版本不符。');
  const ids = new Set<string>(); let through = 0;
  for (const fragment of [...ledger.fragments].sort((a, b) => a.start - b.start)) {
    if (ids.has(fragment.fragmentId) || fragment.start < through || fragment.end <= fragment.start || fragment.end > persona.length
      || persona.slice(through, fragment.start).trim() || companionArtifactHash(persona.slice(fragment.start, fragment.end)) !== fragment.contentHash)
      throw new Error('人格片段存在重叠、缺口、重复身份或hash冲突。');
    ids.add(fragment.fragmentId); through = fragment.end;
  }
  if (persona.slice(through).trim()) throw new Error('当前人格存在未登记片段。');
}
export function companionPersonaFragmentVisible(visibility: CompanionArtifactVisibility, audienceIds: readonly string[]): boolean {
  return audienceIds.length === 0 || visibility.scope === 'public'
    || visibility.scope === 'audience' && audienceIds.length > 0 && audienceIds.every(id => visibility.audienceIds.includes(id));
}
export function projectCompanionPersona(persona: string, ledger: CompanionPersonaFragments, audienceIds: readonly string[]): string {
  return [...ledger.fragments].sort((a, b) => a.start - b.start).filter(fragment => companionPersonaFragmentVisible(fragment.visibility, audienceIds))
    .map(fragment => persona.slice(fragment.start, fragment.end)).join('\n\n');
}
