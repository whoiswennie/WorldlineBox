import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionReplyStreamEvent } from '../../src/shared/companions';
import { CompanionReplyStream } from '../../src/main/companions/reply-stream';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const checkpoint: CompanionLoopCheckpoint = { conversationId: 'room', companionId: 'alice', sourceMessageId: 'source',
    messageId: 'bubble', status: 'running', turns: [], supplements: [] };
  const events: CompanionReplyStreamEvent[] = [], saved: CompanionLoopCheckpoint[] = [];
  const save = vi.fn(async () => { saved.push(structuredClone(checkpoint)); });
  const stream = new CompanionReplyStream({ checkpoint, step: 0, publish: event => events.push(event), save });
  return { checkpoint, events, saved, save, stream };
}

describe('actual reply output transport and durable drafts', () => {
  it('publishes the first fragment immediately, coalesces later events and checkpoints less frequently', async () => {
    const f = fixture();
    f.stream.onTextDelta('你');
    expect(f.events.at(-1)).toMatchObject({ text: '你', phase: 'streaming' });
    f.stream.onTextDelta('你好'); f.stream.onTextDelta('你好，世界');
    expect(f.events.at(-1)?.text).toBe('你');
    await vi.advanceTimersByTimeAsync(60);
    expect(f.events.at(-1)?.text).toBe('你好，世界'); expect(f.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(690);
    expect(f.saved).toHaveLength(1);
    expect(f.saved[0]?.draft?.text).toBe('你好，世界');
    await f.stream.complete();
  });

  it('flushes an interrupted partial and ignores late provider callbacks', async () => {
    const f = fixture(); f.stream.onTextDelta('这段尚未结束');
    await f.stream.stop('interrupted');
    expect(f.saved.at(-1)?.draft?.text).toBe('这段尚未结束');
    expect(f.events.at(-1)).toMatchObject({ phase: 'interrupted', text: '这段尚未结束' });
    const count = f.events.length; f.stream.onTextDelta('旧回调不应重新出现');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.events).toHaveLength(count); expect(f.checkpoint.draft?.text).toBe('这段尚未结束');
  });

  it('discards a failed attempt before a replacement starts without adding a completed turn', async () => {
    const f = fixture(); f.stream.onTextDelta('旧尝试'); await f.stream.stop('discarded');
    expect(f.saved.at(-1)?.draft).toBeUndefined(); expect(f.checkpoint.turns).toEqual([]);
    const replacement = new CompanionReplyStream({ checkpoint: f.checkpoint, step: 0, publish: event => f.events.push(event), save: f.save });
    replacement.onTextDelta('新的正文'); f.stream.onTextDelta('旧片段不能盖过新尝试');
    await replacement.complete();
    expect(f.checkpoint.draft).toMatchObject({ attemptId: replacement.attemptId, text: '新的正文' });
    delete f.checkpoint.draft;
    f.checkpoint.turns.push({ text: '新的正文', rawText: '新的正文', calls: [] });
    await f.save(); replacement.committed('新的正文');
    expect(f.saved.at(-1)?.turns[0]?.text).toBe('新的正文');
    expect(f.events.at(-1)).toMatchObject({ phase: 'committed', attemptId: replacement.attemptId, text: '新的正文' });
  });

  it('awaits an outstanding checkpoint before a completed turn can commit', async () => {
    const f = fixture(); let release!: () => void;
    f.save.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.stream.onTextDelta('正在生成'); await vi.advanceTimersByTimeAsync(750);
    let completed = false;
    const finishing = f.stream.complete().then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    release(); await finishing; expect(completed).toBe(true);
  });

  it('surfaces a checkpoint failure before the caller commits a model decision', async () => {
    const f = fixture(); f.save.mockRejectedValueOnce(new Error('写入失败'));
    f.stream.onTextDelta('这只是草稿'); await vi.advanceTimersByTimeAsync(750);
    await expect(f.stream.complete()).rejects.toThrow('写入失败');
    expect(f.checkpoint.turns).toEqual([]);
  });
});
