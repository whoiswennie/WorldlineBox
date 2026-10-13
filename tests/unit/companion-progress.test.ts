import { expect, it } from 'vitest';
import { companionProgressEvent, mergeCompanionProgress } from '../../src/shared/companion-progress';
it('keeps the newest token snapshot across delayed database refreshes and excludes private reasoning', () => {
  const base = { taskId: 'native-a', type: 'text_stream', stage: 'message' as const, summary: '能力正在流式输出', receivedAt: '', streamId: 'stream_1' };
  const newest = companionProgressEvent({ ...base, sequence: 8, text: '已经生成的完整片段' })!;
  const stale = companionProgressEvent({ ...base, sequence: 2, text: '旧片段' })!;
  expect(mergeCompanionProgress([newest], [stale])).toEqual([newest]);
  expect(mergeCompanionProgress([stale], [newest])).toEqual([newest]);
  expect(companionProgressEvent({ ...base, type: 'thinking', sequence: 9, text: 'private' })).toBeUndefined();
});
