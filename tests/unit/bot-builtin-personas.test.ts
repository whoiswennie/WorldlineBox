import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { builtinBotPersonaTemplates } from '../../src/shared/builtin-bot-personas';

// Fingerprints of the complete “人格设定” bodies extracted from the four supplied
// DOCX files, with Word paragraph boundaries represented by LF. This guards
// against accidentally truncating the prompts or importing export metadata.
const documentBodies = [
  ['dafeiyu-original', 1388, '8532acbb228e9e99a25aba4c76f07d613d0a3651d1380fda65b56c1ed5a7e7fc'],
  ['dafeiyu-daughter-v2', 2289, '4ddad6c48bc54943242a2a45d345b2883018c73829cc7671a039df9cf04a1e20'],
  ['dafeiyu-tieba', 2101, '21fc9a90b261af794979c2f606ab9477711fcfa8715219388d2b863499ff31bd'],
  ['dafeiyu-mowan', 1168, '982e4c7e4f0dcb9bed6642ff30ff5eff64d7114f7e901fac0996e3495efee628'],
] as const;

describe('built-in companion persona templates', () => {
  it.each(documentBodies)('preserves the complete %s document prompt', (id, length, fingerprint) => {
    const template = builtinBotPersonaTemplates(DEFAULT_BOT_COMPANION_ID).find(item => item.id === id);
    expect(template).toBeDefined();
    expect(template?.prompt.length).toBe(length);
    expect(createHash('sha256').update(template!.prompt, 'utf8').digest('hex')).toBe(fingerprint);
    expect(template?.prompt).not.toMatch(/ASTRBOT PERSONA CARD|创建时间|更新时间|人格 ID/);
  });

  it('keeps the original default stable while exposing all four document variants', () => {
    const templates = builtinBotPersonaTemplates(DEFAULT_BOT_COMPANION_ID);
    expect(templates).toHaveLength(5);
    expect(new Set(templates.map(item => item.id)).size).toBe(5);
    expect(templates[0]).toEqual({
      id: 'default', name: '默认人格', prompt: BUILTIN_BOT_COMPANIONS[0]?.persona,
    });
  });

  it('returns only each other built-in companion’s own default and no presets for custom companions', () => {
    for (const companion of BUILTIN_BOT_COMPANIONS.filter(item => item.id !== DEFAULT_BOT_COMPANION_ID)) {
      expect(builtinBotPersonaTemplates(companion.id)).toEqual([
        { id: 'default', name: '默认人格', prompt: companion.persona },
      ]);
    }
    expect(builtinBotPersonaTemplates('custom-companion')).toEqual([]);
  });
});
