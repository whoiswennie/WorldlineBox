import { expect, it } from 'vitest';
import { companionDurationMilliseconds, companionTaskDuration } from '../../src/renderer/companions/task-duration';

const day = 86400000;
it.each([
  [0, '0 秒'], [59999, '59 秒'], [60000, '1 分 00 秒'],
  [3723000, '1 小时 2 分 03 秒'], [day, '1 天 00 秒'],
  [30 * day, '1 个月 00 秒'], [365 * day, '1 年 00 秒'],
  [(365 + 30 + 2) * day + 11045000, '1 年 1 个月 2 天 3 小时 4 分 05 秒'],
])('formats elapsed milliseconds %s as %s', (milliseconds, expected) => {
  expect(companionDurationMilliseconds(milliseconds)).toBe(expected);
});

it.each([NaN, Infinity, -Infinity, -1, Number.MAX_VALUE])('rejects unsupported elapsed milliseconds %s', milliseconds => {
  expect(companionDurationMilliseconds(milliseconds)).toBeUndefined();
});

it('rejects missing, invalid and backwards timestamp ranges', () => {
  expect(companionTaskDuration(undefined, '2026-10-30T00:00:00Z')).toBeUndefined();
  expect(companionTaskDuration('invalid', '2026-10-30T00:00:00Z')).toBeUndefined();
  expect(companionTaskDuration('2026-10-30T00:00:00Z', 'invalid')).toBeUndefined();
  expect(companionTaskDuration('2026-10-30T00:00:00Z', '2026-10-29T00:00:00Z')).toBeUndefined();
});
