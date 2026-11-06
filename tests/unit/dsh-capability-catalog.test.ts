import { expect, it } from 'vitest';
import { dshTaskCapabilityQuerySchema } from '../../src/shared/dsh-task-spec';
const modulePath = '../../resources/dsh-bridge/index.js';
const { capabilityCatalogPage } = await import(modulePath);

it('pages over 1500 real registrations without disclosing their schemas and searches only the requested category', () => {
  const tools = Array.from({ length: 1507 }, (_, index) => ({ name: 'native_tool_' + index.toString().padStart(4, '0'),
    description: 'Native registered tool ' + index, parameters: { privateSchema: 'MUST_NOT_APPEAR' } }));
  const skills = [{ name: 'native_skill_1500', description: 'A native skill', content: 'MUST_NOT_APPEAR' }];
  const names: string[] = []; let offset = 0;
  for (;;) {
    const page = capabilityCatalogPage(tools, skills, { category: 'tool', offset, limit: 30 });
    expect(page.total).toBe(1507); expect(page.items.length).toBeLessThanOrEqual(30);
    expect(JSON.stringify(page)).not.toMatch(/parameters|privateSchema|MUST_NOT_APPEAR/u);
    names.push(...page.items.map((item: { name: string }) => item.name));
    if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  expect(new Set(names).size).toBe(1507); expect(names).toHaveLength(1507);
  expect(capabilityCatalogPage(tools, skills, { category: 'skill', query: '1500', limit: 1 }).items).toEqual([{ kind: 'skill', name: 'native_skill_1500', description: 'A native skill' }]);
  expect(capabilityCatalogPage(tools, skills, { category: 'tool', query: '1500', limit: 1 }).items[0].name).toBe('native_tool_1500');
});
it('validates progressive discovery independently from installed plugin metadata', () => {
  expect(dshTaskCapabilityQuerySchema.parse({ kind: 'summary' })).toEqual({ kind: 'summary' });
  expect(dshTaskCapabilityQuerySchema.safeParse({ kind: 'catalog', limit: 31 }).success).toBe(false);
  expect(dshTaskCapabilityQuerySchema.safeParse({ kind: 'summary', query: 'skin' }).success).toBe(false);
  expect(() => capabilityCatalogPage([], [], { limit: 1000 })).toThrow('catalog');
  expect(capabilityCatalogPage([], [], { category: 'all' })).toMatchObject({ total: 0, items: [] });
});
