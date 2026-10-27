import { expect, it } from 'vitest';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { COMPANION_CHARACTER_SECTIONS, emptyCompanionCharacter, parseCompanionCharacter, renderCompanionCharacter, standardizeCompanionCharacter } from '../../src/shared/companion-character';
import { companionDraftSchema } from '../../src/shared/companions';

it('provides every built-in with the full authored character sheet and individual performance, limitations and growth', () => {
  expect(BUILTIN_COMPANIONS).toHaveLength(15);
  for (const companion of BUILTIN_COMPANIONS) {
    expect(companionDraftSchema.safeParse(companion).success, companion.id).toBe(true);
    const sheet = parseCompanionCharacter(companion.persona);
    expect(sheet.standardized, companion.id).toBe(true);
    expect(sheet.fields.names).toContain(companion.name === '白幻' || companion.name === '黑幻' ? '幻' : companion.name);
    for (const section of COMPANION_CHARACTER_SECTIONS) for (const field of section.fields)
      expect(sheet.fields[field.key].length, `${companion.id}:${field.key}`).toBeGreaterThan(5);
    expect(sheet.fields.costs).toContain('DSH'); expect(sheet.fields.growth).toContain('可编辑');
    expect(renderCompanionCharacter(sheet.fields, sheet.extra)).toBe(companion.persona);
  }
  for (const key of ['personality', 'flaws', 'goals', 'player'] as const)
    expect(new Set(BUILTIN_COMPANIONS.map(item => parseCompanionCharacter(item.persona).fields[key])).size).toBe(15);
  expect(parseCompanionCharacter(BUILTIN_COMPANIONS[0]!.persona).fields.contacts).toContain('deepseek-flash');
  expect(parseCompanionCharacter(BUILTIN_COMPANIONS[1]!.persona).fields.contacts).toContain('deepseek-sister');
});

it('preserves authored sections and multiline quotes without restoring missing template fields', () => {
  const legacy = '我叫海岚。\n【基础】\n姓名/自称/别称：这是旧文本中的引文，不猜测拆解\n【世界观】\n保留旧背景。';
  expect(standardizeCompanionCharacter(legacy, '海岚')).toBe(legacy);
  const fields = { ...emptyCompanionCharacter('海岚'), voice: '先轻声回应。\n认真时说清条件。\n【关系】\n对熟人/陌生人：只是引用，不能改成关系字段。' };
  const edited = renderCompanionCharacter(fields, '【补充设定】\n' + legacy);
  expect(parseCompanionCharacter(edited).fields.voice).toBe(fields.voice);
  expect(parseCompanionCharacter(edited).extra).toBe('【补充设定】\n' + legacy);
  expect(standardizeCompanionCharacter(edited, '别的名字')).toBe(edited);
  expect(Object.values(emptyCompanionCharacter()).every(value => value === '')).toBe(true);
});
