import { expect, it } from 'vitest';
const modulePath = '../../resources/dsh-bridge/index.js';
const { workerOutputFromEvents } = await import(modulePath);
const user = (id: string) => ({ type: 'user/message', data: { id, source: { kind: 'worldlinebox-bot' } } });
const assistant = (text: string, extra: object = {}) => ({ type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
  { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text },
] } }, ...extra });

it('returns only the exact final native response, keeping stages and tools in the trace', () => {
  const events = [user('worldlinebox-bot:old'), assistant('OLD'), user('worldlinebox-bot:current'), assistant('A progress update'),
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'TOOL_OUTPUT' }] } } },
    assistant('  Final answer.\n'), user('worldlinebox-bot:next'), assistant('NEXT')];
  expect(workerOutputFromEvents(events, { eventId: 'current' })).toMatchObject({ text: '  Final answer.\n', messages: 2, truncated: false });
});

it('excludes interrupted drafts and projection rewrites', () => {
  const events = [user('worldlinebox-bot:task'), assistant('Committed'),
    assistant('INTERRUPTED', { data: { interrupted: true, message: { content: [{ type: 'text', text: 'INTERRUPTED' }] } } }),
    assistant('REWRITE', { surfaceOp: 'replace' }), assistant('')];
  expect(workerOutputFromEvents(events, { eventId: 'task' }).text).toBe('Committed');
});

it('keeps a long native final answer intact without a generated preview or omission notice', () => {
  const final = '🌧'.repeat(1000);
  expect(workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('Stage'), assistant(final)], { eventId: 'task', maxChars: 256 }))
    .toMatchObject({ text: final, totalChars: final.length, truncated: false });
});

it('does not surface an unbound old answer', () => {
  expect(workerOutputFromEvents([assistant('Stale')], { eventId: 'missing' }).text).toBe('');
  expect(workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('')], { eventId: 'task' }).text).toBe('');
});
