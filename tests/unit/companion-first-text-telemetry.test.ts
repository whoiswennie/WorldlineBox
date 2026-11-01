import { createHash } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionService, type CompanionServiceOptions } from '../../src/main/companions/service';
import { withCompanionStorageOperation } from '../../src/main/companions/storage-operation-context';
import { COMPANION_REPLY_STREAM_CHANNEL, type CompanionReplyStreamEvent } from '../../src/shared/companions';

type Timing = NonNullable<CompanionServiceOptions['onTiming']>;
type StreamHost = { closed: boolean; options: Pick<CompanionServiceOptions, 'window' | 'onTiming'>; firstTextMessages: Set<string> };
const publish = (CompanionService.prototype as unknown as { publishReplyStream(this: StreamHost, event: CompanionReplyStreamEvent): void }).publishReplyStream;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function event(phase: CompanionReplyStreamEvent['phase'], text = '', messageId = 'PRIVATE_REPLY'): CompanionReplyStreamEvent {
  return { conversationId: 'PRIVATE_ROOM', companionId: 'PRIVATE_OWNER', sourceMessageId: 'PRIVATE_SOURCE', messageId, step: 0, attemptId: 'attempt_one', text, phase };
}
function fixture(onTiming = vi.fn<Timing>()) {
  const send = vi.fn(), window = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  const host: StreamHost = { closed: false, options: { window: () => window, onTiming }, firstTextMessages: new Set() };
  return { host, send, onTiming, publish: (value: CompanionReplyStreamEvent) => publish.call(host, value) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('records the first real streaming body once across later deltas, terminal progress and commit', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T03:00:00Z'));
  const f = fixture(); f.publish(event('streaming')); f.publish(event('streaming', ' \n\t'));
  expect(f.onTiming).not.toHaveBeenCalled();
  f.publish(event('streaming', '真实可见正文'));
  const first = Date.now(); vi.setSystemTime(first + 1500);
  f.publish(event('streaming', '真实可见正文继续增长'));
  f.publish({ ...event('progress'), progress: { revision: 4, phase: 'completed', detail: '已完成', startedAt: new Date(first - 5000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } });
  f.publish(event('committed', '真实可见正文继续增长'));
  expect(f.onTiming).toHaveBeenCalledExactlyOnceWith({ operation: 'reply.first_text', durationMs: 0, firstTextEpochMs: first, messageHash: hash('PRIVATE_REPLY'), sourceMessageHash: hash('PRIVATE_SOURCE') });
  expect(f.send).toHaveBeenCalledTimes(6); expect(f.send).toHaveBeenLastCalledWith(COMPANION_REPLY_STREAM_CHANNEL, expect.objectContaining({ phase: 'committed', text: '真实可见正文继续增长' }));
  expect(JSON.stringify(f.onTiming.mock.calls)).not.toMatch(/真实可见正文|PRIVATE_|PRIVATE_ROOM|PRIVATE_OWNER/u);
});

it('uses a committed body when no streaming body was published', () => {
  const f = fixture(); f.publish(event('committed', '经过审阅后才可发布的正文'));
  f.publish({ ...event('committed', '相同气泡重试结算'), attemptId: 'attempt_two' });
  expect(f.onTiming).toHaveBeenCalledOnce(); expect(f.onTiming.mock.calls[0]![0]).toMatchObject({ operation: 'reply.first_text', firstTextEpochMs: expect.any(Number) });
  expect(f.send).toHaveBeenCalledTimes(2);
});

it('does not count progress, usage, discarded or interrupted text as a first body', () => {
  const f = fixture();
  for (const phase of ['progress', 'usage', 'discarded', 'interrupted'] as const) f.publish(event(phase, '这些都不是新发布的正文'));
  expect(f.onTiming).not.toHaveBeenCalled(); expect(f.host.firstTextMessages.size).toBe(0); expect(f.send).toHaveBeenCalledTimes(4);
});

it('does not interrupt or duplicate streaming when a timing observer throws', () => {
  const onTiming = vi.fn<Timing>(() => { throw new Error('diagnostic observer unavailable'); }), f = fixture(onTiming);
  expect(() => f.publish(event('streaming', '正文仍需正常发送'))).not.toThrow();
  f.publish(event('committed', '正文仍需正常发送'));
  expect(onTiming).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledTimes(2);
});

it('bounds process-local deduplication without clearing a message at its terminal progress', () => {
  const f = fixture();
  for (let index = 0; index < 257; index++) f.publish(event('streaming', '非空正文', `reply_${index}`));
  expect(f.host.firstTextMessages.size).toBe(256); expect(f.onTiming).toHaveBeenCalledTimes(257);
  f.publish(event('progress', '', 'reply_256')); f.publish(event('committed', '最终正文', 'reply_256'));
  expect(f.host.firstTextMessages.size).toBe(256); expect(f.onTiming).toHaveBeenCalledTimes(257);
  expect([...f.host.firstTextMessages].every(value => /^[a-f0-9]{64}$/u.test(value))).toBe(true);
});

it('records nothing when the host cannot publish to a live window', () => {
  const f = fixture(); f.host.options.window = () => undefined;
  f.publish(event('streaming', '没有接收窗口'));
  f.host.closed = true; f.publish(event('committed', '应用已经关闭'));
  expect(f.send).not.toHaveBeenCalled(); expect(f.onTiming).not.toHaveBeenCalled(); expect(f.host.firstTextMessages.size).toBe(0);
});

it('correlates a real reply source with only the host operation hash and never invents an unscoped lane', () => {
  const onTiming = vi.fn<Timing>(), host = { options: { onTiming } };
  const correlate = (CompanionService.prototype as unknown as {
    publishStorageOperation(this: typeof host, sourceMessageId: string): void;
  }).publishStorageOperation;
  correlate.call(host, 'PRIVATE_SOURCE'); expect(onTiming).not.toHaveBeenCalled();
  withCompanionStorageOperation({ priority: 'interactive', lane: 'PRIVATE_TASK_LANE' }, () => correlate.call(host, 'PRIVATE_SOURCE'));
  expect(onTiming).toHaveBeenCalledExactlyOnceWith({ operation: 'reply.storage.operation', durationMs: 0,
    sourceMessageHash: hash('PRIVATE_SOURCE'), storageOperationHash: hash('PRIVATE_TASK_LANE') });
  expect(JSON.stringify(onTiming.mock.calls)).not.toMatch(/PRIVATE_|interactive|lane/u);
});

it('keeps storage correlation observers outside reply authority and error handling', () => {
  const onTiming = vi.fn<Timing>(() => { throw new Error('observer failed'); }), host = { options: { onTiming } };
  const correlate = (CompanionService.prototype as unknown as {
    publishStorageOperation(this: typeof host, sourceMessageId: string): void;
  }).publishStorageOperation;
  expect(() => withCompanionStorageOperation({ priority: 'interactive' }, () => correlate.call(host, 'source'))).not.toThrow();
  expect(onTiming).toHaveBeenCalledOnce(); expect(Object.keys(host)).toEqual(['options']);
});
