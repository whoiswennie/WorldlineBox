import { expect, it, vi } from 'vitest';
import type { BotMessage } from '../../src/shared/companion-bot';
import type { BotSpeechRequest, BotSpeechResponse } from '../../src/shared/companion-bot-speech';
import { BotCallSpeechSession } from '../../src/renderer/companion-bot/BotCallSpeechSession';

const message = (id: string, content = '你好呀。'): BotMessage => ({ id, conversationId: 'room', eventId: id, senderId: 'companion', senderName: '伙伴', content, sequence: 1, status: 'sent', createdAt: '2026-11-05T00:00:00Z' });
const clip = (partIndex = 0, partCount = 1, text = '你好。'): BotSpeechResponse => ({ ok: true, audio: { base64: 'AQID', mimeType: 'audio/mpeg', voice: 'zh-CN-XiaoyiNeural', text, partIndex, partCount } });
const flush = async () => { for (let step = 0; step < 40; step++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
function fixture(handler: (input: BotSpeechRequest) => Promise<BotSpeechResponse> = async () => clip()) {
  const request = vi.fn(handler), play = vi.fn<(bytes: Uint8Array, mimeType: string) => Promise<'ended' | 'cancelled'>>(async () => 'ended'), stop = vi.fn(), changed = vi.fn();
  const session = new BotCallSpeechSession({ api: { request }, conversationId: 'room', companionId: 'companion', initialMessages: [message('history')], player: { play, stop }, changed });
  return { session, request, play, stop, changed };
}
it('reads only new final companion replies once, preserving historical, user and other-room messages', async () => {
  const f = fixture(), reply = message('new');
  f.session.observe([message('history'), { ...reply, status: 'running' }, { ...message('user'), senderId: 'user' }, { ...message('other'), conversationId: 'other' }]); await flush(); expect(f.request).not.toHaveBeenCalled();
  f.session.observe([reply]); await flush(); f.session.observe([reply]); await flush();
  expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![0]).toMatchObject({ type: 'speech.synthesize', conversationId: 'room', messageId: 'new', partIndex: 0 }); expect(f.play).toHaveBeenCalledOnce();
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', completedMessageIds: ['new'] }); f.session.dispose();
});
it('plays bounded speech parts in sequence instead of overlapping paragraph audio', async () => {
  const f = fixture(async input => input.type === 'speech.synthesize' ? clip(input.partIndex, 2) : { ok: true });
  f.session.observe([message('long')]); await flush();
  expect(f.request.mock.calls.map(([input]) => input.type === 'speech.synthesize' && input.partIndex)).toEqual([0, 1]); expect(f.play).toHaveBeenCalledTimes(2); f.session.dispose();
});
it('keeps the playing caption source immutable when an older message snapshot arrives', async () => {
  const audio = deferred<'ended' | 'cancelled'>(), original = '这是一段已经合成并开始播放的完整回复。';
  const f = fixture(async () => clip(0, 1, original)); f.play.mockReturnValueOnce(audio.promise);
  f.session.observe([message('new', original)]); await flush();
  f.session.updateFrame({ playing: true, level: .5, positionSeconds: 2, durationSeconds: 10 });
  const before = f.changed.mock.calls.at(-1)![0];
  f.session.observe([{ ...message('new', '过期草稿'), status: 'running' }]);
  f.session.updateFrame({ playing: true, level: .4, positionSeconds: 3, durationSeconds: 10 });
  const after = f.changed.mock.calls.at(-1)![0];
  expect(after.sourceText).toBe(original); expect(after.messageId).toBe('new');
  expect(after.displayText!.startsWith(before.displayText!)).toBe(true);
  audio.resolve('ended'); await flush(); expect(f.session.snapshot().sourceText).toBe(original); f.session.dispose();
});
it('cancels a pending synthesis and never plays its late response after hangup', async () => {
  let finish!: (response: BotSpeechResponse) => void;
  const pending = new Promise<BotSpeechResponse>(resolve => { finish = resolve; });
  const f = fixture(async input => input.type === 'speech.synthesize' ? pending : { ok: true, cancelled: true });
  f.session.observe([message('new')]); await flush(); const requestId = (f.request.mock.calls[0]![0] as { requestId: string }).requestId;
  f.session.dispose(); finish(clip()); await flush();
  expect(f.request).toHaveBeenLastCalledWith({ type: 'speech.cancel', requestId }); expect(f.play).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalled();
});
it('does not replay missed history when automatic reading is re-enabled, but permits explicit replay', async () => {
  const f = fixture(); f.session.setEnabled(false); f.session.observe([message('muted')]); f.session.setEnabled(true); f.session.observe([message('muted')]); await flush(); expect(f.play).not.toHaveBeenCalled();
  f.session.replay('history'); await flush(); expect(f.request.mock.calls[0]![0]).toMatchObject({ messageId: 'history' }); f.session.dispose();
});
it('shows synthesis errors, supports retry, and skips code-only replies', async () => {
  let failed = true;
  const f = fixture(async () => failed ? { ok: false, error: '语音网络不可用' } : clip());
  f.session.observe([message('code', '```js\nconst a = 1;\n```')]); await flush(); expect(f.request).not.toHaveBeenCalled();
  f.session.observe([message('new')]); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'error', messageId: 'new', error: '语音网络不可用' });
  failed = false; f.session.replay('new'); await flush(); expect(f.play).toHaveBeenCalledOnce(); f.session.dispose();
});
it('continues B after A fails, preserves A in subsequent speech states, and never retries A automatically', async () => {
  const playing = deferred<'ended' | 'cancelled'>();
  const f = fixture(async input => input.type === 'speech.synthesize' && input.messageId === 'A' ? { ok: false, error: 'A合成失败' } : clip()); f.play.mockReturnValueOnce(playing.promise);
  f.session.observe([message('A'), message('B')]); await flush();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'speech.synthesize').map(([input]) => input.type === 'speech.synthesize' && input.messageId)).toEqual(['A', 'B']);
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'preparing', messageId: 'B', failures: [{ messageId: 'A', error: 'A合成失败' }] });
  f.session.markSpeaking(true); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'speaking', messageId: 'B', failures: [{ messageId: 'A' }] });
  playing.resolve('ended'); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', completedMessageIds: ['B'], failures: [{ messageId: 'A' }] });
  f.session.observe([message('A'), message('B')]); await flush(); expect(f.request).toHaveBeenCalledTimes(2); f.session.dispose();
});
it('clears only the explicitly retried failure and preserves other queued replies during retry', async () => {
  let failed = true; const playing = deferred<'ended' | 'cancelled'>();
  const f = fixture(async input => input.type === 'speech.synthesize' && input.messageId === 'A' && failed ? { ok: false, error: '暂时失败' } : clip()); f.play.mockReturnValueOnce(playing.promise);
  f.session.observe([message('A'), message('B'), message('C')]); await flush(); failed = false; f.session.replay('A');
  expect(f.changed.mock.calls.at(-1)![0].failures).toEqual([]); expect(f.play).toHaveBeenCalledOnce();
  playing.resolve('ended'); await flush();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'speech.synthesize').map(([input]) => input.type === 'speech.synthesize' && input.messageId)).toEqual(['A', 'B', 'A', 'C']);
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', completedMessageIds: ['B', 'A', 'C'], failures: [] }); f.session.dispose();
});
it('reports completed A at queue idle even if a later B fails, so A is never mistaken for unplayed audio', async () => {
  const f = fixture(async input => input.type === 'speech.synthesize' && input.messageId === 'B' ? { ok: false, error: 'B失败' } : clip());
  f.session.observe([message('A'), message('B')]); await flush();
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', completedMessageIds: ['A'], failures: [{ messageId: 'B' }] }); f.session.dispose();
});
it('keeps a failed-message retry visible after the voice error handler stops playback and clears the current phase', async () => {
  let failed = true;
  const f = fixture(async () => failed ? { ok: false, error: '连接中断' } : clip());
  f.changed.mockImplementation(state => { if (state.phase === 'error') f.session.stop(); });
  f.session.observe([message('A')]); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', failures: [{ messageId: 'A', error: '连接中断' }] });
  failed = false; f.session.replay('A'); await flush(); expect(f.play).toHaveBeenCalledOnce(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', failures: [], completedMessageIds: ['A'] }); f.session.dispose();
});
it.each(['stop', 'dispose'] as const)('cancels pending audio and never starts queued or late replies after %s', async operation => {
  const response = deferred<BotSpeechResponse>();
  const f = fixture(async input => input.type === 'speech.synthesize' ? response.promise : { ok: true, cancelled: true });
  f.session.observe([message('A'), message('B')]); await flush(); f.session[operation](); response.resolve(clip()); await flush();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'speech.synthesize').map(([input]) => input.type === 'speech.synthesize' && input.messageId)).toEqual(['A']);
  expect(f.request.mock.calls.some(([input]) => input.type === 'speech.cancel')).toBe(true); expect(f.play).not.toHaveBeenCalled(); f.session.dispose();
});
it('bounds per-meeting failures and makes automatic queue overflow visible instead of silently losing replies', async () => {
  const f = fixture(async () => ({ ok: false, error: '短暂错误' }));
  f.session.observe(Array.from({ length: 20 }, (_, index) => message('reply-' + index))); await flush();
  const failures = f.changed.mock.calls.at(-1)![0].failures; expect(failures).toHaveLength(16); expect(failures.some((failure: { error: string }) => failure.error.includes('等待朗读'))).toBe(true);
  expect(f.request.mock.calls.filter(([input]) => input.type === 'speech.synthesize')).toHaveLength(8); f.session.dispose();
});

it('reveals only from actual playing media positions and does not advance on stalled, buffering, or unknown-duration frames', async () => {
  const text = '一二三四五六七八', playing = deferred<'ended' | 'cancelled'>(), f = fixture(async () => clip(0, 1, text)); f.play.mockReturnValueOnce(playing.promise);
  f.session.observe([message('clock', text)]); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'preparing', messageId: 'clock', displayText: '', revealComplete: false });
  const frame = { playing: true, level: .3, durationSeconds: 8 };
  f.session.updateFrame({ ...frame, positionSeconds: 2 }); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ displayText: '一二', phase: 'speaking', revealComplete: false });
  const changes = f.changed.mock.calls.length;
  for (let index = 0; index < 30; index++) f.session.updateFrame({ ...frame, positionSeconds: 2 });
  f.session.updateFrame({ ...frame, playing: false, positionSeconds: 7 }); f.session.updateFrame({ playing: true, level: .3, positionSeconds: 100 });
  expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.changed.mock.calls.at(-1)![0].displayText).toBe('一二');
  f.session.updateFrame({ ...frame, positionSeconds: 8 }); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ displayText: '一二三四五六七', revealComplete: false });
  playing.resolve('ended'); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', messageId: 'clock', displayText: text, revealComplete: true }); f.session.dispose();
});

it('accumulates completed speech parts, preserves word spacing and emoji graphemes, and keeps a queued reply from stealing the current line', async () => {
  const first = deferred<'ended' | 'cancelled'>(), second = deferred<'ended' | 'cancelled'>(), third = deferred<'ended' | 'cancelled'>();
  const text = '你好👩‍💻！ Hello世界。'; const f = fixture(async input => input.type === 'speech.synthesize' && input.messageId === 'A' ? clip(input.partIndex, 2, input.partIndex ? 'Hello世界。' : '你好👩‍💻！') : clip(0, 1, '后续回复。'));
  f.play.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  f.session.observe([message('A', text)]); await flush(); f.session.updateFrame({ playing: true, level: .3, positionSeconds: 3, durationSeconds: 4 });
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ messageId: 'A', displayText: '你好👩‍💻', revealComplete: false });
  f.session.observe([message('A', text), message('B', '后续回复。')]); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ messageId: 'A', displayText: '你好👩‍💻' });
  first.resolve('ended'); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'preparing', messageId: 'A', displayText: '你好👩‍💻！', revealComplete: false });
  f.session.updateFrame({ playing: true, level: .3, positionSeconds: 4, durationSeconds: 8 }); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ messageId: 'A', displayText: '你好👩‍💻！ Hell' });
  second.resolve('ended'); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'preparing', messageId: 'B', displayText: '' });
  third.resolve('ended'); await flush(); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', messageId: 'B', displayText: '后续回复。', revealComplete: true, completedMessageIds: ['A', 'B'] }); f.session.dispose();
});

it.each(['stop', 'failure'] as const)('preserves the complete current line when playback is interrupted by %s', async operation => {
  const text = '这句台词应该完整保留。', playing = deferred<'ended' | 'cancelled'>(), f = fixture(async () => clip(0, 1, text)); f.play.mockReturnValueOnce(playing.promise);
  f.session.observe([message('A', text)]); await flush(); f.session.updateFrame({ playing: true, level: .2, positionSeconds: 1, durationSeconds: 10 });
  if (operation === 'stop') f.session.stop(); else playing.resolve('cancelled'); await flush();
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ messageId: 'A', displayText: text, revealComplete: true });
  if (operation === 'failure') expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'error', failures: [{ messageId: 'A' }] });
  const changes = f.changed.mock.calls.length; f.session.updateFrame({ playing: true, level: 1, positionSeconds: 9, durationSeconds: 10 }); expect(f.changed).toHaveBeenCalledTimes(changes);
  playing.resolve('ended'); await flush(); f.session.dispose();
});

it('reveals the full fallback text on synthesis failure before any audio has started and preserves it while clearing retry errors', async () => {
  const text = '失败时仍然可以阅读这句话。', f = fixture(async () => ({ ok: false, error: '合成失败' })); f.session.observe([message('A', text)]); await flush();
  expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'error', messageId: 'A', displayText: text, revealComplete: true });
  f.session.setEnabled(false); expect(f.changed.mock.calls.at(-1)![0]).toMatchObject({ phase: 'idle', messageId: 'A', displayText: text, revealComplete: true, failures: [{ messageId: 'A' }] }); f.session.dispose();
});
it('reserves a new reply from its first running frame without synthesizing its unfinished text', async () => {
  const synthesis = deferred<BotSpeechResponse>(), f = fixture(async () => synthesis.promise);
  f.session.observe([{ ...message('A', ''), status: 'running' }]);
  expect(f.session.snapshot()).toMatchObject({ pendingMessageIds: ['A'], textMessageIds: ['history'] }); expect(f.request).not.toHaveBeenCalled();
  f.session.observe([message('A', '正在生成的完整内容。')]); await flush();
  expect(f.session.snapshot()).toMatchObject({ phase: 'preparing', messageId: 'A', displayText: '', pendingMessageIds: ['A'] });
  synthesis.resolve(clip(0, 1, '正在生成的完整内容。')); await flush();
  expect(f.session.snapshot()).toMatchObject({ phase: 'idle', pendingMessageIds: [], textMessageIds: ['history', 'A'] }); f.session.dispose();
});
it('keeps a reply already visible while muted readable when automatic speech is enabled midway through generation', async () => {
  const f = fixture(); f.session.setEnabled(false); f.session.observe([{ ...message('A', '已经看见'), status: 'running' }]);
  f.session.setEnabled(true); f.session.observe([message('A', '已经看见的完整消息。')]); await flush();
  expect(f.session.snapshot().textMessageIds).toContain('A'); expect(f.session.snapshot().pendingMessageIds).not.toContain('A'); expect(f.request).not.toHaveBeenCalled(); f.session.dispose();
});
it('releases running and queued replies on interruption and never starts them later when generation completes', async () => {
  const f = fixture(); f.session.observe([{ ...message('A', ''), status: 'running' }, { ...message('B', ''), status: 'queued' }]); f.session.stop();
  expect(f.session.snapshot().pendingMessageIds).toEqual([]); expect(f.session.snapshot().textMessageIds).toEqual(['history', 'A', 'B']);
  f.session.observe([message('A'), message('B')]); await flush(); expect(f.request).not.toHaveBeenCalled();
  f.session.observe([message('C')]); await flush(); expect(f.request).toHaveBeenCalledOnce(); f.session.dispose();
});
it('releases an initially pending reply that finishes without speakable text and retains stable ownership snapshots across frames', async () => {
  const f = fixture(); f.session.observe([{ ...message('code', ''), status: 'running' }]); f.session.observe([message('code', '```js\nconst a=1\n```')]);
  expect(f.session.snapshot().pendingMessageIds).toEqual([]); expect(f.session.snapshot().textMessageIds).toContain('code'); expect(f.request).not.toHaveBeenCalled();
  const playing = deferred<'ended' | 'cancelled'>(); f.play.mockReturnValueOnce(playing.promise); f.session.observe([message('A')]); await flush();
  const { pendingMessageIds, textMessageIds } = f.session.snapshot();
  f.session.updateFrame({ playing: true, level: 1, positionSeconds: 1, durationSeconds: 10 });
  expect(f.session.snapshot().pendingMessageIds).toBe(pendingMessageIds); expect(f.session.snapshot().textMessageIds).toBe(textMessageIds);
  playing.resolve('ended'); await flush(); f.session.dispose();
});
