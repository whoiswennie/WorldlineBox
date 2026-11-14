import { expect, it } from 'vitest';
const modulePath = '../../resources/dsh-bridge/index.js';
const { workerOutputFromEvents } = await import(modulePath);
let sequence=0;
const user = (id: string) => ({ seq:++sequence,type: 'user/message', data: { id, source: { kind: 'worldlinebox-bot' } } });
const assistant = (text: string, extra: object = {}) => ({ seq:++sequence,type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [
  { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text },
] } }, ...extra });

it('preserves earlier user-facing answers as well as the final native response, keeping reasoning and tools in the trace', () => {
  const events = [user('worldlinebox-bot:old'), assistant('OLD'), user('worldlinebox-bot:current'), assistant('A progress update'),
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'TOOL_OUTPUT' }] } } },
    assistant('  Final answer.\n'), user('worldlinebox-bot:next'), assistant('NEXT')];
  expect(workerOutputFromEvents(events, { eventId: 'current' })).toMatchObject({ text: 'A progress update\n\n  Final answer.\n', messages: 2, truncated: false });
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
    .toMatchObject({ text: 'Stage\n\n'+final, totalChars: final.length+7, truncated: false });
});

it('does not surface an unbound old answer', () => {
  expect(workerOutputFromEvents([assistant('Stale')], { eventId: 'missing' }).text).toBe('');
  expect(workerOutputFromEvents([user('worldlinebox-bot:task'), assistant('')], { eventId: 'task' }).text).toBe('');
});
it('retains the source order and identity of native deliveries between substantive text and the final message',()=>{
  const first=assistant('关键正文'),delivery={seq:++sequence,type:'deliverables/presented',data:{files:[{path:'C:/output/report.txt'}]}},last=assistant('完成');
  const result=workerOutputFromEvents([user('worldlinebox-bot:ordered'),first,delivery,last],{eventId:'ordered'});
  expect(result.outputs).toEqual([{id:'native-text-'+first.seq,sequence:first.seq,text:'关键正文'},{id:'native-files-'+delivery.seq,sequence:delivery.seq,files:delivery.data.files},{id:'native-text-'+last.seq,sequence:last.seq,text:'完成'}]);
});

it('acknowledges peer results through a committed call_present receipt from the same turn', () => {
  const tool = { type: 'tool/call', data: { name: 'call_present', callId: 'presentation' } };
  const result = (toolCallId: string, isError: boolean) => ({ type: 'tool/result', surfaceOp: 'append', data: { message: { toolCallId, isError,
    content: [{ type: 'text', text: JSON.stringify({ accepted: 1, segmentIds: ['segment-1'] }) }],
  } } });
  const receipt = 'a'.repeat(64);
  const peerResults = { type: 'user/message', data: { id: 'peer-results', source: { kind: 'worldlinebox-bot-peer-results' },
    content: [{ type: 'text', text: JSON.stringify({ status: 'ready', receipt }) }],
  } };
  const events = [user('worldlinebox-bot:old'), tool, result('presentation', false), user('worldlinebox-bot:meeting'), assistant('Plain draft'), peerResults, tool];
  const unmatched = workerOutputFromEvents([...events, result('presentation', true), result('other-call', false)], { eventId: 'meeting' });
  expect(unmatched.text).toBe('Plain draft');
  expect(unmatched.peerResultsReceipt).toBeUndefined();
  expect(workerOutputFromEvents([...events, result('presentation', false)], { eventId: 'meeting' }).peerResultsReceipt).toBe(receipt);
});
