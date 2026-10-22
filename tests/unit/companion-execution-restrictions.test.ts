import { expect, it } from 'vitest';
import { companionExecutionRestrictions } from '../../src/main/companions/execution-restrictions';

it('extracts literal restrictions without importing another companion task or the combined user goal', () => {
  const source = '先分析数据，然后让周岚独立检查并写review。只读原文件，禁止修改、删除或移动；不要联网。';
  const restrictions = companionExecutionRestrictions(source);
  expect(restrictions).toEqual(['只读原文件', '禁止修改、删除或移动', '不要联网']);
  expect(restrictions.join('\n')).not.toMatch(/分析数据|周岚|review/);
});
it('keeps English read-only constraints and never adds another positive operation after a prohibition', () => {
  expect(companionExecutionRestrictions('Read-only access. Do not change the input; run the review in another task.')).toEqual(['Read-only access', 'Do not change the input']);
  expect(companionExecutionRestrictions('请先整理资料，交给另一伙伴做复核。')).toEqual([]);
  expect(companionExecutionRestrictions('禁止上传，并请另一位伙伴查数量。')).toEqual(['禁止上传']);
});
