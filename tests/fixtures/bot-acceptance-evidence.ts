import { createHash } from 'node:crypto';

export const captureJobId = (eventId: string) => 'memory-' + createHash('sha256').update(JSON.stringify(['capture', `capture:${eventId}`])).digest('hex');
interface CaptureNote { id: string; content: string; sourceEventId?: string; sourceMessageIds: string[]; indexState: string }
interface CaptureJob { kind: string; status: string; payload: Record<string, unknown> }
/** These assertions are for one explicit acceptance case. They do not score
 * general memory accuracy or turn a protocol model into a real quality test. */
export function assertPreferenceCapture(input: { eventId: string; sourceMessageId: string; replyMessageId: string; job: CaptureJob | undefined; notes: CaptureNote[] }) {
  const { eventId, job } = input;
  if (!job || job.kind !== 'capture' || job.status !== 'done' || job.payload.sourceEventId !== eventId) throw new Error('AUTOMATIC_CAPTURE_JOB_NOT_COMPLETED');
  const expected = new Set(Array.from({ length: 6 }, (_, i) => createHash('sha256').update(`${eventId}:capture:${i}`).digest('hex')));
  const notes = input.notes.filter(note => expected.has(note.id) && note.sourceEventId === eventId);
  if (!notes.length) throw new Error('AUTOMATIC_CAPTURE_HAS_NO_CAPTURE_SOURCE_RECEIPT');
  if (notes.some(note => note.indexState !== 'indexed' || !note.sourceMessageIds.includes(input.sourceMessageId) || !note.sourceMessageIds.includes(input.replyMessageId))) {
    throw new Error('AUTOMATIC_CAPTURE_SOURCE_OR_INDEX_NOT_CONFIRMED');
  }
  const content = notes.map(note => note.content.split('\n\n来源事件：')[0]).join('\n'), clauses = content.split(/[。；;，,\n]/u).map(value => value.replace(/\s/g, ''));
  const evening = '(?:晚上|晚间|夜间|夜晚)', morning = '(?:上午|早上)';
  const eveningTeaPattern = new RegExp(`${evening}(?:(?!${morning}).){0,40}麦茶|麦茶(?:(?!${morning}).){0,30}${evening}`);
  const morningCoffeePattern = new RegExp(`${morning}(?:(?!${evening}).){0,40}咖啡|咖啡(?:(?!${evening}).){0,30}${morning}`);
  const eveningTea = clauses.some(clause => eveningTeaPattern.test(clause));
  const morningCoffee = clauses.some(clause => morningCoffeePattern.test(clause));
  const unqualifiedBan = clauses.some(clause => !/(?:不是|并非|不表示|不意味着|不等于)/.test(clause)
    && /(?:(?:全天|整天|所有时段|任何时间)[^。；;\n]{0,16}(?:不喝|禁用|禁止|戒掉)[^。；;\n]{0,8}咖啡|(?:从不|不再)喝咖啡)/.test(clause));
  if (!eveningTea || !morningCoffee || unqualifiedBan) throw new Error('AUTOMATIC_CAPTURE_TIME_OR_NEGATION_SCOPE_INCORRECT');
  return { notes: notes.length, sourceReceiptsConfirmed: true, indexed: true, eveningTea, morningCoffee, noUnqualifiedAllDayCoffeeBan: !unqualifiedBan };
}
