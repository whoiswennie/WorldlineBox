import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';

it('initializes timeline and summary templates byte-for-byte from the original default prompts', async () => {
  const root = path.resolve('vendor/vcp-memory'), initial = await loadInitialTimelinePrompts(root);
  const plugin = createRequire(path.join(root, 'package.json'))(path.join(root, 'Plugin/VCPTimeLine/VCPTimeLine.js')) as {
    summarizeMonth(...args: unknown[]): Promise<string>; generateOneLineSummary(...args: unknown[]): Promise<string>;
  };
  const observed: string[] = [];
  const context = { config: { maxContextTokens: 20000, maxOutputTokens: 8000 }, splitByBudget: () => ['fixture source'],
    callModel: async (system: string) => { observed.push(system); return 'fixture result'; } };
  await Reflect.apply(plugin.summarizeMonth, context, ['Alice_原始归属', '2026-10', ['fixture source']]);
  await Reflect.apply(plugin.generateOneLineSummary, context, ['Alice_原始归属', '2026-10', 'fixture timeline']);
  const render = (template: string) => template.replaceAll('{{agentName}}', 'Alice_原始归属').replaceAll('{{month}}', '2026-10');
  expect(render(initial.timeline)).toBe(observed[0]); expect(render(initial.summary)).toBe(observed[1]);
});
