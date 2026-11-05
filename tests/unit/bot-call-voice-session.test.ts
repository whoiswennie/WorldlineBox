import { expect, it, vi } from 'vitest';
import { BotCallVoiceSession, type BotCallVoiceCapture } from '../../src/renderer/companion-bot/BotCallVoiceSession';
import type { LocalSpeechRequest, LocalSpeechResponse } from '../../src/shared/local-speech';
import type { VoiceRecording } from '../../src/renderer/companion-bot/voice-recorder';

const recording: VoiceRecording = { wave: new Uint8Array([82, 73, 70, 70, 1, 2, 3]), seconds: 1 };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; return { promise: new Promise<T>((done, failed) => { resolve = done; reject = failed; }), resolve, reject }; }
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function setup(handler: (request: LocalSpeechRequest) => Promise<LocalSpeechResponse> = async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'standby' } } : input.type === 'speech.transcribe' ? { ok: true, transcript: { text: '你好，我们继续聊。', audioSeconds: 1, engine: 'sensevoice-int8-cpu' } } : { ok: true }) {
  const captures: Array<BotCallVoiceCapture & { finish: (value: VoiceRecording | undefined) => void; fail: (error: Error) => void; limit: () => void }> = [];
  const captureFactory = vi.fn(() => {
    const finished = deferred<VoiceRecording | undefined>();
    const capture = { start: vi.fn(async (onLimit: () => void) => { capture.limit = onLimit; return { finished: finished.promise }; }), stop: vi.fn(() => finished.resolve(recording)), cancel: vi.fn(() => finished.resolve(undefined)), finish: finished.resolve, fail: finished.reject, limit: (): void => undefined };
    captures.push(capture); return capture;
  });
  const request = vi.fn(handler), send = vi.fn<(text: string, requestId: string) => Promise<boolean>>(async () => true), stopSpeech = vi.fn(), changed = vi.fn();
  const session = new BotCallVoiceSession({ api: { request }, captureFactory, send, stopSpeech, changed });
  return { session, request, send, stopSpeech, changed, captureFactory, captures };
}

it('stays off until explicit start, prepares missing resources before opening the microphone and sends recognized text through the original chat callback', async () => {
  const f = setup(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'unprepared' } } : input.type === 'speech.transcribe' ? { ok: true, transcript: { text: '这是原私聊里的语音。', engine: 'sensevoice-int8-cpu', audioSeconds: 1 } } : { ok: true });
  expect(f.session.state.phase).toBe('off'); expect(f.request).not.toHaveBeenCalled(); await f.session.start();
  expect(f.request.mock.calls.map(([request]) => request.type)).toEqual(['speech.status', 'speech.prepare']); expect(f.session.state).toMatchObject({ phase: 'listening', enabled: true, turn: 1 });
  f.session.finishUtterance(); await flush(); expect(f.request.mock.calls.map(([request]) => request.type)).toEqual(['speech.status', 'speech.prepare', 'speech.transcribe']);
  expect(f.send).toHaveBeenCalledWith('这是原私聊里的语音。', expect.any(String)); expect(f.session.state).toMatchObject({ phase: 'waiting', transcript: '这是原私聊里的语音。' }); expect(f.captures[0]!.cancel).toHaveBeenCalled(); f.session.dispose();
});
it('waits for the whole reply playback to finish before opening the next microphone and rejects stale turn notifications', async () => {
  const f = setup(); await f.session.start(); f.session.finishUtterance(); await flush(); const turn = f.session.state.turn;
  f.session.markSpeaking(turn); expect(f.session.state.phase).toBe('speaking'); expect(f.captureFactory).toHaveBeenCalledOnce();
  f.session.readyForNextTurn(turn); await flush(); expect(f.session.state).toMatchObject({ phase: 'listening', turn: 2 }); expect(f.captureFactory).toHaveBeenCalledTimes(2);
  f.session.readyForNextTurn(turn); f.session.markSpeaking(turn); await flush(); expect(f.session.state.phase).toBe('listening'); expect(f.captureFactory).toHaveBeenCalledTimes(2); f.session.dispose();
});
it('defers next-turn capture when playback ends before the chat send acknowledgment arrives', async () => {
  const f = setup(), acknowledgment = deferred<boolean>(); f.send.mockReturnValueOnce(acknowledgment.promise);
  await f.session.start(); f.session.finishUtterance(); await flush(); f.session.markSpeaking(); f.session.readyForNextTurn(); await flush(); expect(f.captureFactory).toHaveBeenCalledOnce();
  acknowledgment.resolve(true); await flush(); expect(f.captureFactory).toHaveBeenCalledTimes(2); expect(f.session.state.phase).toBe('listening'); f.session.dispose();
});
it('keeps failed recognized text and retries the same original message intent without recognizing or recording again', async () => {
  const f = setup(); f.send.mockResolvedValueOnce(false).mockResolvedValueOnce(true); await f.session.start(); f.session.finishUtterance(); await flush();
  expect(f.session.state).toMatchObject({ phase: 'error', transcript: '你好，我们继续聊。' }); const original = f.send.mock.calls[0];
  await f.session.retrySend(); expect(f.send.mock.calls[1]).toEqual(original); expect(f.captureFactory).toHaveBeenCalledOnce(); expect(f.request.mock.calls.filter(([request]) => request.type === 'speech.transcribe')).toHaveLength(1); expect(f.session.state.phase).toBe('waiting'); f.session.dispose();
});
it('preserves an accepted failed reply without resending its text, and lets the user start a fresh microphone turn', async () => {
  const f = setup(), acknowledgment = deferred<boolean>(); f.send.mockReturnValueOnce(acknowledgment.promise);
  await f.session.start(); f.session.finishUtterance(); await flush(); const turn = f.session.state.turn;
  f.session.replyFailed('这条伙伴回复失败。', turn); expect(f.session.state).toMatchObject({ phase: 'error', transcript: '你好，我们继续聊。', canRetrySend: false });
  acknowledgment.resolve(true); await flush(); await f.session.retrySend(); expect(f.send).toHaveBeenCalledOnce();
  await f.session.start(); expect(f.session.state).toMatchObject({ phase: 'listening', turn: turn + 1 }); expect(f.send).toHaveBeenCalledOnce();
  f.session.replyFailed('旧一轮失败', turn); expect(f.session.state.phase).toBe('listening'); f.session.dispose();
});
it('cancels preparation and ignores late resource results after microphone mute or hangup', async () => {
  const prepare = deferred<LocalSpeechResponse>(); const f = setup(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'unprepared' } } : input.type === 'speech.prepare' ? prepare.promise : { ok: true });
  const starting = f.session.start(); await flush(); const requestId = (f.request.mock.calls.find(([request]) => request.type === 'speech.prepare')![0] as { requestId: string }).requestId;
  f.session.pause(); expect(f.request).toHaveBeenLastCalledWith({ type: 'speech.cancel', requestId }); prepare.resolve({ ok: true }); await starting;
  expect(f.captureFactory).not.toHaveBeenCalled(); expect(f.session.state).toMatchObject({ phase: 'off', enabled: false }); f.session.dispose();
});
it('cancels recognition and never sends a delayed transcript into a closed meeting', async () => {
  const transcript = deferred<LocalSpeechResponse>(); const f = setup(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'ready' } } : input.type === 'speech.transcribe' ? transcript.promise : { ok: true });
  await f.session.start(); f.session.finishUtterance(); await flush(); expect(f.session.state.phase).toBe('recognizing'); f.session.dispose();
  expect(f.request.mock.calls.at(-1)![0]).toMatchObject({ type: 'speech.cancel' }); transcript.resolve({ ok: true, transcript: { text: '不应晚发。', engine: 'sensevoice-int8-cpu', audioSeconds: 1 } }); await flush(); expect(f.send).not.toHaveBeenCalled(); expect(f.session.state.phase).toBe('off');
});
it('stops playback before explicit barge-in and discards any old capture result', async () => {
  const f = setup(); await f.session.start(); const first = f.captures[0]!; f.session.markSpeaking(); expect(first.cancel).toHaveBeenCalled();
  const before = f.stopSpeech.mock.calls.length; await f.session.interruptTalk(); expect(f.stopSpeech).toHaveBeenCalledTimes(before + 1); expect(f.captureFactory).toHaveBeenCalledTimes(2); expect(f.session.state.phase).toBe('listening');
  first.finish(recording); await flush(); expect(f.send).not.toHaveBeenCalled(); f.session.dispose();
});
it('does not open the microphone if playback begins while resources are still preparing', async () => {
  const preparing = deferred<LocalSpeechResponse>(); const f = setup(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'unprepared' } } : input.type === 'speech.prepare' ? preparing.promise : { ok: true });
  const start = f.session.start(); await flush(); f.session.markSpeaking(); preparing.resolve({ ok: true }); await start;
  expect(f.session.state.phase).toBe('speaking'); expect(f.captureFactory).not.toHaveBeenCalled(); f.session.readyForNextTurn(); await flush(); expect(f.session.state.phase).toBe('listening'); f.session.dispose();
});
it('cancels a pending microphone permission request and discards the late capture without reviving the meeting', async () => {
  const f = setup(), permission = deferred<{ finished: Promise<VoiceRecording | undefined> }>(), utterance = deferred<VoiceRecording | undefined>();
  const capture = { start: vi.fn(async () => permission.promise), stop: vi.fn(), cancel: vi.fn(), finish: utterance.resolve, fail: utterance.reject, limit: () => undefined };
  f.captureFactory.mockReturnValueOnce(capture); const starting = f.session.start(); await flush(); expect(f.session.state.phase).toBe('preparing');
  f.session.dispose(); expect(capture.cancel).toHaveBeenCalled(); permission.resolve({ finished: utterance.promise }); await starting; utterance.resolve(recording); await flush();
  expect(f.session.state.phase).toBe('off'); expect(f.send).not.toHaveBeenCalled(); expect(f.request.mock.calls.filter(([input]) => input.type === 'speech.transcribe')).toHaveLength(0);
});
it('handles the capture time limit once, reports capture/recognition failures, and cleans every error path', async () => {
  const f = setup(); await f.session.start(); f.captures[0]!.limit(); f.session.finishUtterance(); await flush(); expect(f.captures[0]!.stop).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
  f.session.readyForNextTurn(); await flush(); f.captures[1]!.fail(Error('录音中断')); await flush(); expect(f.session.state).toMatchObject({ phase: 'error', error: '录音中断' }); expect(f.captures[1]!.cancel).toHaveBeenCalled(); f.session.dispose();
  const failed = setup(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'ready' } } : { ok: false, error: '没有听清' }); await failed.session.start(); failed.session.finishUtterance(); await flush(); expect(failed.session.state).toMatchObject({ phase: 'error', error: '没有听清' }); expect(failed.send).not.toHaveBeenCalled(); failed.session.dispose();
});
it('routes typing through the same voice turn, cancels microphone capture, and waits for its exact reply', async () => {
  const f = setup(); await f.session.start(); const originalTurn = f.session.state.turn, capture = f.captures[0]!;
  expect(await f.session.sendText('我现在改成打字。', 'typed-request')).toBe(true);
  expect(capture.cancel).toHaveBeenCalled(); expect(f.send).toHaveBeenCalledWith('我现在改成打字。', 'typed-request'); expect(f.session.state).toMatchObject({ phase: 'waiting', turn: originalTurn + 1 });
  f.session.readyForNextTurn(originalTurn); await flush(); expect(f.captureFactory).toHaveBeenCalledOnce();
  f.session.readyForNextTurn(originalTurn + 1); await flush(); expect(f.captureFactory).toHaveBeenCalledTimes(2); f.session.dispose();
});
it('invalidates a pending ASR transcript when typing takes over, without late voice sends', async () => {
  const late = deferred<LocalSpeechResponse>(); const f = setup(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'ready' } } : input.type === 'speech.transcribe' ? late.promise : { ok: true });
  await f.session.start(); f.session.finishUtterance(); await flush(); expect(f.session.state.phase).toBe('recognizing');
  expect(await f.session.sendText('以这条打字消息为准。', 'typed-now')).toBe(true); late.resolve({ ok: true, transcript: { text: '已经过期的声音', audioSeconds: 1, engine: 'sensevoice-int8-cpu' } }); await flush();
  expect(f.send).toHaveBeenCalledExactlyOnceWith('以这条打字消息为准。', 'typed-now'); expect(f.request.mock.calls.some(([input]) => input.type === 'speech.cancel')).toBe(true); f.session.dispose();
});
it('coalesces the same in-flight typed intent and retries a failed send with its original ID', async () => {
  const f = setup(), accepted = deferred<boolean>(); f.send.mockReturnValueOnce(accepted.promise).mockResolvedValueOnce(true); await f.session.start();
  const first = f.session.sendText('保留这句话。', 'same-id'), duplicate = f.session.sendText('保留这句话。', 'same-id'); expect(duplicate).toBe(first);
  expect(await f.session.sendText('不同内容。', 'same-id')).toBe(false); expect(f.send).toHaveBeenCalledOnce();
  accepted.resolve(false); expect(await first).toBe(false); expect(f.session.state).toMatchObject({ phase: 'error', canRetrySend: true, transcript: '保留这句话。' });
  await f.session.retrySend(); expect(f.send.mock.calls[1]).toEqual(f.send.mock.calls[0]); expect(f.session.state.phase).toBe('waiting'); f.session.dispose();
});
it('returns the real accepted chat acknowledgement after microphone shutdown without reopening voice', async () => {
  const f = setup(); expect(await f.session.sendText('未开启不发出。', 'off')).toBe(false); expect(f.send).not.toHaveBeenCalled();
  const accepted = deferred<boolean>(); f.send.mockReturnValueOnce(accepted.promise); await f.session.start();
  const pending = f.session.sendText('旧轮次消息。', 'old'); f.session.stop(); const changes = f.changed.mock.calls.length;
  accepted.resolve(true); expect(await pending).toBe(true); expect(f.session.state).toMatchObject({ phase: 'off', enabled: false });
  expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.captureFactory).toHaveBeenCalledOnce(); f.session.dispose();
});
it('does not let a late accepted chat acknowledgement change a newer typed turn or its transcript', async () => {
  const f = setup(), accepted = deferred<boolean>(); f.send.mockReturnValueOnce(accepted.promise); await f.session.start();
  const old = f.session.sendText('原来提交的文字。', 'old-intent'); f.session.stop(); await f.session.start();
  expect(await f.session.sendText('这是新的文字和轮次。', 'new-intent')).toBe(true);
  const latest = f.session.state, changes = f.changed.mock.calls.length, stops = f.stopSpeech.mock.calls.length;
  accepted.resolve(true); expect(await old).toBe(true);
  expect(f.session.state).toEqual(latest); expect(f.session.state).toMatchObject({ phase: 'waiting', transcript: '这是新的文字和轮次。' });
  expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.stopSpeech).toHaveBeenCalledTimes(stops); expect(f.captureFactory).toHaveBeenCalledTimes(2); f.session.dispose();
});
it('returns a late chat acknowledgement after dispose without reviving the closed meeting', async () => {
  const f = setup(), accepted = deferred<boolean>(); f.send.mockReturnValueOnce(accepted.promise); await f.session.start();
  const pending = f.session.sendText('挂机前已发出的消息。', 'last-intent'); f.session.dispose(); const changes = f.changed.mock.calls.length;
  accepted.resolve(true); expect(await pending).toBe(true); expect(f.session.state).toMatchObject({ phase: 'off', enabled: false });
  expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.captureFactory).toHaveBeenCalledOnce();
});
it('re-arms failed TTS playback without replaying accepted chat and resumes listening only after playback completion', async () => {
  const f = setup(); await f.session.start(); f.session.finishUtterance(); await flush(); f.session.replyFailed('朗读失败，请重试。');
  const stops = f.stopSpeech.mock.calls.length; f.session.waitForPlayback(); expect(f.session.state).toMatchObject({ phase: 'speaking', canRetrySend: false }); expect(f.stopSpeech).toHaveBeenCalledTimes(stops);
  await f.session.retrySend(); expect(f.send).toHaveBeenCalledOnce(); expect(f.captureFactory).toHaveBeenCalledOnce();
  f.session.readyForNextTurn(); await flush(); expect(f.session.state.phase).toBe('listening'); expect(f.captureFactory).toHaveBeenCalledTimes(2); f.session.dispose();
});

it('submits an attachment-only composer action once without falling back to text chat or opening the microphone early', async () => {
  const f = setup(), accepted = deferred<boolean>(), perform = vi.fn(() => accepted.promise), duplicateAction = vi.fn(async () => true);
  expect(await f.session.sendAction('', 'attachment-off', perform)).toBe(false); expect(perform).not.toHaveBeenCalled();
  await f.session.start(); const capture = f.captures[0]!, turn = f.session.state.turn;
  expect(await f.session.sendText('', 'empty-text')).toBe(false); expect(capture.cancel).not.toHaveBeenCalled();
  const pending = f.session.sendAction('', 'attachment-only', perform), duplicate = f.session.sendAction('', 'attachment-only', duplicateAction);
  expect(duplicate).toBe(pending); expect(perform).toHaveBeenCalledOnce(); expect(duplicateAction).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  expect(capture.cancel).toHaveBeenCalled(); expect(f.session.state).toMatchObject({ phase: 'waiting', transcript: '', turn: turn + 1 });
  accepted.resolve(true); expect(await pending).toBe(true); expect(f.captureFactory).toHaveBeenCalledOnce();
  f.session.readyForNextTurn(turn + 1); await flush(); expect(f.captureFactory).toHaveBeenCalledTimes(2); f.session.dispose();
});

it('preserves the original rich-message action for an explicit send retry without replacing frozen attachments', async () => {
  const f = setup(), firstAck = deferred<boolean>(), frozenAttachment = { name: 'original.png' };
  const perform = vi.fn(async () => { expect(frozenAttachment.name).toBe('original.png'); return perform.mock.calls.length === 1 ? firstAck.promise : true; });
  await f.session.start(); const pending = f.session.sendAction('', 'frozen-attachment-id', perform);
  expect(await f.session.sendAction('different message', 'frozen-attachment-id', async () => true)).toBe(false);
  firstAck.resolve(false); expect(await pending).toBe(false); expect(f.session.state).toMatchObject({ phase: 'error', canRetrySend: true, transcript: '' });
  expect(perform).toHaveBeenCalledOnce(); await f.session.retrySend();
  expect(perform).toHaveBeenCalledTimes(2); expect(f.send).not.toHaveBeenCalled(); expect(f.session.state).toMatchObject({ phase: 'waiting', canRetrySend: false });
  expect(f.captureFactory).toHaveBeenCalledOnce(); await f.session.retrySend(); expect(perform).toHaveBeenCalledTimes(2); f.session.dispose();
});

it('returns the accepted rich-message acknowledgment after microphone shutdown without changing a later turn', async () => {
  const f = setup(), accepted = deferred<boolean>(), perform = vi.fn(() => accepted.promise);
  await f.session.start(); const pending = f.session.sendAction('', 'already-submitted-attachment', perform);
  f.session.stop(); await f.session.start(); const current = f.session.state, changes = f.changed.mock.calls.length;
  accepted.resolve(true); expect(await pending).toBe(true); expect(perform).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  expect(f.session.state).toEqual(current); expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.captureFactory).toHaveBeenCalledTimes(2); f.session.dispose();
});
