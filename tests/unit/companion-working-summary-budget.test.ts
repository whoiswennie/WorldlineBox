import { expect, it } from 'vitest';
import { workingSummaryBudget, workingSummarySchema } from '../../src/main/companions/working-summary-budget';

it('bounds only the summary module and records actual old-summary plus new-chunk volume', () => {
  const input = { previous: { summary: '原始旧摘要'.repeat(1000), stage: '过去阶段' }, chunk: [{ content: '尚未履行的承诺；原件已更正。'.repeat(80) }],
    moduleWindowChars: 10000, retainedChars: 1500, providerMaxOutputTokens: 8192 };
  const snapshot = JSON.stringify(input), budget = workingSummaryBudget(input);
  expect(budget.maxCombinedChars).toBe(3000); expect(budget.providerMaxOutputTokens).toBe(8192);
  expect(budget.priorSummaryChars).toBe(input.previous.summary.length + input.previous.stage.length);
  expect(budget.replacementInputUtf8Bytes).toBeGreaterThan(budget.replacementInputChars);
  expect(workingSummarySchema(budget).safeParse({ summary: '保留精确更正、未履约、当前人物及下一步，原文仍可查。', stage: '未履约' }).success).toBe(true);
  expect(JSON.stringify(input)).toBe(snapshot);
});

it('rejects output growth under ordinary pressure, combined stage overflow and repeated historical accumulation', () => {
  const budget = workingSummaryBudget({ previous: { summary: '短旧摘要', stage: '旧' }, chunk: ['新片段'], moduleWindowChars: 10000, retainedChars: 0, providerMaxOutputTokens: 8192 });
  expect(workingSummarySchema(budget).safeParse({ summary: '以每章梗概重复全部历史。'.repeat(100), stage: '' }).success).toBe(false);
  const large = workingSummaryBudget({ chunk: ['原文'.repeat(5000)], moduleWindowChars: 10000, retainedChars: 0, providerMaxOutputTokens: 8192 });
  expect(workingSummarySchema(large).safeParse({ summary: 'a'.repeat(2900), stage: 'b'.repeat(200) }).success).toBe(false);
  expect(workingSummarySchema(large).safeParse({ summary: 'a'.repeat(3001), stage: '' }).success).toBe(false);
});

it('does not repeatedly impose a compression ratio on an already short checkpoint', () => {
  const budget = workingSummaryBudget({ previous: { summary: '当前精确状态', stage: '进行中' }, chunk: [{ recordId: 'actual_record', result: '新进展'.repeat(300) }],
    moduleWindowChars: 10000, retainedChars: 0, providerMaxOutputTokens: 8192 });
  expect(workingSummarySchema(budget).safeParse({ summary: '当前精确状态。新进展依然未确认，原recordId=actual_record，保留待办。', stage: '进行中' }).success).toBe(true);
});
