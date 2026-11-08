import { expect, it } from 'vitest';
const modulePath = '../../resources/dsh-bridge/index.js';
const { workerOutputFromEvents } = await import(modulePath);
const user = (id: string, kind = 'worldlinebox-bot') => ({ type: 'user/message', data: { id, source: { kind } } });
const assistant = (text: string, extra: object = {}) => ({ type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
  { type: 'thinking', text: 'PRIVATE_REASONING' }, { type: 'text', text }, { type: 'tool_use', name: 'write', arguments: { content: 'RAW_TOOL_INPUT' } },
] } }, ...extra });

it('retains substantive text before a reporting tool and its final acknowledgement without including other message kinds', () => {
  const events = [user('worldlinebox-bot:old'), assistant('OLD_TASK_FACTS'), user('worldlinebox-bot:current'),
    assistant('上海 18.6°C，体感 19.2°C；来源：fixture，查询时间 14:44。'),
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'RAW_TOOL_RESULT' }] } } },
    { type: 'assistant/attempt', data: { message: { content: [{ type: 'text', text: 'UNCOMMITTED_ATTEMPT' }] } } },
    assistant('INTERRUPTED_DRAFT', { data: { interrupted: true, message: { content: [{ type: 'text', text: 'INTERRUPTED_DRAFT' }] } } }),
    assistant('PROJECTION_REWRITE', { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }), assistant('任务已完成，结果见上文。'),
    user('worldlinebox-bot:next'), assistant('NEXT_TASK_FACTS')];
  const result = workerOutputFromEvents(events, { eventId: 'current' });
  expect(result.text).toContain('上海 18.6°C'); expect(result.text).toContain('体感 19.2°C'); expect(result.text).toContain('结果见上文');
  expect(result.text).toContain('含阶段说明'); expect(result.messages).toBe(2); expect(result.truncated).toBe(false);
  expect(result.text).not.toMatch(/OLD_TASK|NEXT_TASK|RAW_TOOL|PRIVATE_REASONING|UNCOMMITTED|PROJECTION|INTERRUPTED_DRAFT/);
});

it('does not merge a previous completed continuation segment or the following guidance into the current segment', () => {
  const events = [user('worldlinebox-bot:task'), assistant('PREVIOUS_SEGMENT'),
    user('worldlinebox-bot:task:task-continuation:second', 'worldlinebox-bot-task-continuation'), assistant('SECOND_SEGMENT_BODY'),
    user('worldlinebox-bot-output:continued', 'worldlinebox-bot-output-continuation'), assistant('SECOND_SEGMENT_END'),
    user('worldlinebox-bot:third', 'worldlinebox-bot-guidance'), assistant('THIRD_SEGMENT')];
  const result = workerOutputFromEvents(events, { eventId: 'task', startMessageId: 'worldlinebox-bot:task:task-continuation:second' });
  expect(result.text).toContain('SECOND_SEGMENT_BODY'); expect(result.text).toContain('SECOND_SEGMENT_END');
  expect(result.text).not.toMatch(/PREVIOUS_SEGMENT|THIRD_SEGMENT/);
});

it('retains body across native recovery and output continuation notices while deduplicating exact repeated text', () => {
  const events = [user('worldlinebox-bot:task'), assistant('Confirmed facts'),
    user('recovery', 'worldlinebox-bot-recovery'), assistant('Confirmed facts'),
    user('resume', 'worldlinebox-bot-output-resume'), assistant('Final result')];
  const result = workerOutputFromEvents(events, { eventId: 'task' });
  expect(result.text.match(/Confirmed facts/g)).toHaveLength(1); expect(result.text).toContain('Final result'); expect(result.messages).toBe(2);
});

it('preserves a single answer exactly and returns no text without the bound input', () => {
  expect(workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('One final answer')], { eventId: 'task' }).text).toBe('One final answer');
  expect(workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('One final answer'), assistant('')], { eventId: 'task' }).text).toBe('One final answer');
  expect(workerOutputFromEvents([assistant('A stale answer')], { eventId: 'missing' }).text).toBe('');
  expect(workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('')], { eventId: 'task' }).text).toBe('');
});

it('counts Unicode characters and never slices a surrogate pair at either preview boundary', () => {
  const result = workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('🌧'.repeat(600)), assistant('🌤FINAL')], { eventId: 'task', maxChars: 256 });
  expect(result.totalChars).toBe(608); expect(result.truncated).toBe(true);
  expect(result.text).toMatch(/^🌧/u); expect(result.text).toContain('🌤FINAL');
  expect(result.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(/[\uD800-\uDFFF]/u);
});

it('bounds previews with an explicit omission notice, preserving the beginning and final result', () => {
  const result = workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('EARLY_FACTS_' + 'x'.repeat(40000)), assistant('FINAL_FACTS')], { eventId: 'task', maxChars: 1000 });
  expect(result.truncated).toBe(true); expect(result.totalChars).toBeGreaterThan(40000);
  expect(result.text).toContain('EARLY_FACTS_'); expect(result.text).toContain('FINAL_FACTS'); expect(result.text).toContain('中段已省略');
  expect(result.text.length).toBeLessThan(1200); expect(() => workerOutputFromEvents([], { eventId: 'task', maxChars: 1 })).toThrow('budget');
});
