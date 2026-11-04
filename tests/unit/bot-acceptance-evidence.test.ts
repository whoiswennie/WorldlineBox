import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertPreferenceCapture } from '../fixtures/bot-acceptance-evidence';

const eventId = 'acceptance-source';
const input = () => ({ eventId, sourceMessageId: 'user-message', replyMessageId: 'answer-message',
  job: { kind: 'capture', status: 'done', payload: { sourceEventId: eventId } },
  notes: [{ id: createHash('sha256').update(`${eventId}:capture:0`).digest('hex'), sourceEventId: eventId, indexState: 'indexed',
    sourceMessageIds: ['user-message', 'answer-message'], content: '用户从今天起晚上喝麦茶，上午仍喝咖啡；不是全天都不喝咖啡。' }] });
it('requires a completed capture job and its indexed source-specific note receipts', () => {
  expect(assertPreferenceCapture(input())).toMatchObject({ sourceReceiptsConfirmed: true, eveningTea: true, morningCoffee: true });
  const failed = input(); failed.job.status = 'failed'; expect(() => assertPreferenceCapture(failed)).toThrow('JOB_NOT_COMPLETED');
  const directWrite = input(); directWrite.notes[0]!.id = 'a'.repeat(64); expect(() => assertPreferenceCapture(directWrite)).toThrow('NO_CAPTURE_SOURCE_RECEIPT');
  const pending = input(); pending.notes[0]!.indexState = 'pending'; expect(() => assertPreferenceCapture(pending)).toThrow('INDEX_NOT_CONFIRMED');
});
it('rejects reversed time scopes and an invented all-day coffee ban despite matching both drink keywords', () => {
  const reversed = input(); reversed.notes[0]!.content = '用户晚上喝咖啡，上午喝麦茶。';
  expect(() => assertPreferenceCapture(reversed)).toThrow('TIME_OR_NEGATION');
  const expanded = input(); expanded.notes[0]!.content = '晚上喝麦茶；上午仍喝咖啡；用户全天禁止喝咖啡。';
  expect(() => assertPreferenceCapture(expanded)).toThrow('TIME_OR_NEGATION');
});
