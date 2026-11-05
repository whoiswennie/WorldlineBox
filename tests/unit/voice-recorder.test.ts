import { afterEach, expect, it, vi } from 'vitest';
import { VoiceRecorder } from '../../src/renderer/companion-bot/voice-recorder';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('automatically stops the recorder at 60 seconds and releases the microphone on cancel', async () => {
  vi.useFakeTimers(); const track = { stop: vi.fn() }, limit = vi.fn(), stop = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal('MediaRecorder', class {
    state = 'inactive'; start() { this.state = 'recording'; } stop() { this.state = 'inactive'; stop(); }
  });
  const recorder = new VoiceRecorder(), capture = await recorder.start(limit);
  await vi.advanceTimersByTimeAsync(59999); expect(stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(stop).toHaveBeenCalledOnce(); expect(limit).toHaveBeenCalledOnce();
  recorder.cancel(); expect(track.stop).toHaveBeenCalled(); expect(await capture?.finished).toBeUndefined();
});
it('stops a microphone granted after the user already closed the recording panel', async () => {
  const track = { stop: vi.fn() }; let grant!: (value: { getTracks(): typeof track[] }) => void;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  const native = vi.fn(); vi.stubGlobal('MediaRecorder', native);
  const recorder = new VoiceRecorder(), starting = recorder.start(vi.fn()); recorder.cancel(); grant({ getTracks: () => [track] });
  expect(await starting).toBeUndefined(); expect(track.stop).toHaveBeenCalledOnce(); expect(native).not.toHaveBeenCalled();
});
it('optionally reports levels and ends a voiced sentence after one second of silence', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  let amplitude = 0.1; const stopped = vi.fn(), silence = vi.fn(), level = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) } });
  vi.stubGlobal('MediaRecorder', class { state = 'inactive'; start() { this.state = 'recording'; } stop() { this.state = 'inactive'; stopped(); } });
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(samples: Float32Array) { samples.fill(amplitude); } }; }
    async resume() {} async close() {}
  });
  const recorder = new VoiceRecorder(), capture = await recorder.start(vi.fn(), { onLevel: level, silenceSeconds: 1, onSilence: silence });
  await vi.advanceTimersByTimeAsync(400); expect(stopped).not.toHaveBeenCalled(); amplitude = 0;
  await vi.advanceTimersByTimeAsync(1000); expect(stopped).toHaveBeenCalledOnce(); expect(silence).toHaveBeenCalledOnce(); expect(level).toHaveBeenCalledWith(expect.any(Number));
  recorder.cancel(); await capture?.finished;
});

function meteredFixture(options: { pendingResume?: boolean; failResume?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  const track = { stop: vi.fn() }, stopped = vi.fn();
  const state = { amplitude: 0, failSample: false, resume: undefined as (() => void) | undefined,
    native: undefined as { onerror?: () => void } | undefined, contexts: [] as Array<{ close: ReturnType<typeof vi.fn>; source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }; analyser: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } }> };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal('MediaRecorder', class {
    state = 'inactive'; mimeType = 'audio/webm'; onstop?: () => void; onerror?: () => void;
    constructor() { state.native = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; stopped(); this.onstop?.(); }
  });
  vi.stubGlobal('AudioContext', class {
    source = { connect: vi.fn(), disconnect: vi.fn() };
    analyser = { fftSize: 1024, connect: vi.fn(), disconnect: vi.fn(), getFloatTimeDomainData(samples: Float32Array) { if (state.failSample) throw Error('meter failed'); samples.fill(state.amplitude); } };
    close = vi.fn().mockResolvedValue(undefined);
    constructor() { state.contexts.push(this); }
    createMediaStreamSource() { return this.source; } createAnalyser() { return this.analyser; }
    async resume() { if (options.pendingResume) await new Promise<void>(resolve => { state.resume = resolve; }); if (options.failResume) throw Error('resume failed'); }
    async decodeAudioData() { return { duration: .5 }; }
  });
  vi.stubGlobal('OfflineAudioContext', class {
    destination = {}; createBufferSource() { return { buffer: undefined, connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array(8000) }; }
  });
  return { track, stopped, state };
}

it('ignores initial silence and short noise, then releases a real utterance after a one-second pause without echo', async () => {
  const f = meteredFixture(), level = vi.fn(), silence = vi.fn(), recorder = new VoiceRecorder();
  const capture = await recorder.start(vi.fn(), { onLevel: level, silenceSeconds: 1, minSpeechSeconds: .25, onSilence: silence });
  await vi.advanceTimersByTimeAsync(4000); expect(f.stopped).not.toHaveBeenCalled();
  f.state.amplitude = .06; await vi.advanceTimersByTimeAsync(100); f.state.amplitude = 0; await vi.advanceTimersByTimeAsync(2000); expect(f.stopped).not.toHaveBeenCalled();
  f.state.amplitude = .06; await vi.advanceTimersByTimeAsync(350); f.state.amplitude = 0;
  await vi.advanceTimersByTimeAsync(950); expect(f.stopped).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(50);
  expect(f.stopped).toHaveBeenCalledOnce(); expect(silence).toHaveBeenCalledOnce(); expect((await capture!.finished)!.seconds).toBe(.5);
  expect(f.track.stop).toHaveBeenCalled(); expect(f.state.contexts[0]!.source.connect).toHaveBeenCalledWith(f.state.contexts[0]!.analyser);
  expect(f.state.contexts[0]!.analyser.connect).not.toHaveBeenCalled(); expect(f.state.contexts[0]!.source.disconnect).toHaveBeenCalledOnce(); expect(f.state.contexts[0]!.close).toHaveBeenCalledOnce();
  expect(level).toHaveBeenLastCalledWith(0);
});
it('closes tracks and the optional meter when AudioContext.resume fails', async () => {
  const f = meteredFixture({ failResume: true }), recorder = new VoiceRecorder();
  await expect(recorder.start(vi.fn(), { onLevel() {} })).rejects.toThrow('resume failed');
  expect(f.track.stop).toHaveBeenCalled(); expect(f.state.contexts[0]!.close).toHaveBeenCalledOnce();
});
it('handles a recorder error while resume is pending without an unhandled finished rejection or leaked tracks', async () => {
  const f = meteredFixture({ pendingResume: true }), recorder = new VoiceRecorder(), starting = recorder.start(vi.fn(), { onLevel() {} });
  await Promise.resolve(); await Promise.resolve(); f.state.native!.onerror!(); f.state.resume!();
  await expect(starting).rejects.toThrow('麦克风录音中断'); expect(f.track.stop).toHaveBeenCalled(); expect(f.state.contexts[0]!.close).toHaveBeenCalledOnce();
});
it.each(['sample', 'view'])('stops the microphone and preserves the finished error after an optional %s failure', async kind => {
  const f = meteredFixture(), recorder = new VoiceRecorder();
  const capture = await recorder.start(vi.fn(), { onLevel: () => { if (kind === 'view') throw Error('view failed'); } });
  const failure = expect(capture!.finished).rejects.toThrow(kind === 'view' ? 'view failed' : 'meter failed');
  f.state.failSample = kind === 'sample'; await vi.advanceTimersByTimeAsync(50); await failure;
  expect(f.stopped).toHaveBeenCalledOnce(); expect(f.track.stop).toHaveBeenCalled(); expect(f.state.contexts[0]!.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000); expect(f.stopped).toHaveBeenCalledOnce();
});
it('does not create a new meter timer after cancellation while resume is pending', async () => {
  const f = meteredFixture({ pendingResume: true }), level = vi.fn(), recorder = new VoiceRecorder(), starting = recorder.start(vi.fn(), { onLevel: level });
  await Promise.resolve(); await Promise.resolve(); recorder.cancel(); f.state.resume!(); expect(await starting).toBeUndefined();
  expect(f.track.stop).toHaveBeenCalled(); expect(f.state.contexts[0]!.close).toHaveBeenCalledOnce();
  const calls = level.mock.calls.length; await vi.advanceTimersByTimeAsync(1000); expect(level.mock.calls.length).toBe(calls);
});
it('keeps optional level callbacks finite and does not create an analyser for ordinary recordings', async () => {
  const f = meteredFixture(), ordinary = new VoiceRecorder(), plain = await ordinary.start(vi.fn());
  expect(f.state.contexts).toHaveLength(0); ordinary.cancel(); await plain!.finished;
  const recorder = new VoiceRecorder(), level = vi.fn(), capture = await recorder.start(vi.fn(), { onLevel: level });
  f.state.amplitude = Number.NaN; await vi.advanceTimersByTimeAsync(100); f.state.amplitude = 4; await vi.advanceTimersByTimeAsync(100); recorder.cancel(); await capture!.finished;
  expect(level.mock.calls.every(([value]) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
});
