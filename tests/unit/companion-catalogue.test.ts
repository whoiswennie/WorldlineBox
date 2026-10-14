import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { BUILTIN_COMPANIONS, BUILTIN_WELCOMES, builtinCompanionId } from '../../src/shared/companion-personas';
import { BUILTIN_COMPANION_PROFILES } from '../../src/shared/companion-catalogue';
import { COMPANION_TEMPLATE_IDS } from '../../src/shared/companion-template-ids';
import { companionDraftSchema, companionsRequestSchema } from '../../src/shared/companions';

it('registers all old identities once alongside the existing whale sisters and keeps service inheritance independent of character names', () => {
  expect(BUILTIN_COMPANIONS).toHaveLength(15);
  expect(new Set(BUILTIN_COMPANIONS.map(item => item.id)).size).toBe(15);
  expect(BUILTIN_COMPANIONS.filter(item => item.name === '大肥鱼')).toHaveLength(1);
  for (const templateId of COMPANION_TEMPLATE_IDS) {
    expect(companionsRequestSchema.parse({ type: 'companion.add-builtin', templateId })).toEqual({ type: 'companion.add-builtin', templateId });
    const id = builtinCompanionId(templateId);
    const item = BUILTIN_COMPANIONS.find(entry => entry.id === id)!;
    const draft = companionDraftSchema.parse(item);
    expect(draft.avatar).toBe(templateId);
    expect(draft.model).toBe('');
    expect(draft.llm).toBeUndefined();
    expect(BUILTIN_WELCOMES[id]).toBeTruthy();
    expect(BUILTIN_COMPANION_PROFILES.find(profile => profile.id === id)?.introduction).toBeTruthy();
  }
});

it('ships each new portrait with a reference fingerprint and exact generation prompt', () => {
  const manifest = JSON.parse(readFileSync('assets/companions/portraits/manifest.json', 'utf8')) as { portraits: { id: string; file: string; sha256: string; referenceSha256: string; prompt: string }[] };
  expect(manifest.portraits).toHaveLength(13);
  expect(new Set(manifest.portraits.map(item => item.id)).size).toBe(13);
  for (const item of manifest.portraits) {
    expect(BUILTIN_COMPANIONS.some(profile => profile.id === item.id)).toBe(true);
    expect(existsSync(item.file)).toBe(true);
    expect(createHash('sha256').update(readFileSync(item.file)).digest('hex')).toBe(item.sha256);
    expect(item.referenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(item.prompt.length).toBeGreaterThan(150);
  }
});
