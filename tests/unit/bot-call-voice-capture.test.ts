import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CallVoiceCapture } from '../../src/renderer/companion-bot/call-voice-capture';
import type { VoiceRecording, VoiceRecorderOptions } from '../../src/renderer/companion-bot/voice-recorder';

const fixture = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), pending: false, failure: undefined as Error | undefined,
  grant: undefined as (() => void) | undefined, settle: undefined as ((value: VoiceRecording | undefined) => void) | undefined,
  limit: undefined as (() => void) | undefined, options: undefined as VoiceRecorderOptions | undefined, track: { stop: vi.fn() } }));
vi.mock('../../src/renderer/companion-bot/voice-recorder', () => ({ VoiceRecorder: class {
  private cancelled = false;
  async start(onLimit: () => void, options: VoiceRecorderOptions) {
    fixture.start(onLimit, options); fixture.limit = onLimit; fixture.options = options;
    if (fixture.pending) await new Promise<void>(resolve => { fixture.grant = resolve; });
    if (this.cancelled) { fixture.track.stop(); return undefined; }
    if (fixture.failure) throw fixture.failure;
    return { startedAt: 250, finished: new Promise<VoiceRecording | undefined>(resolve => { fixture.settle = resolve; }) };
  }
  stop() { fixture.stop(); fixture.track.stop(); fixture.settle?.({ wave: new Uint8Array([1, 2]), seconds: 2 }); }
  cancel() { this.cancelled = true; fixture.cancel(); fixture.track.stop(); fixture.settle?.(undefined); }
} }));

beforeEach(() => { vi.clearAllMocks(); fixture.pending = false; fixture.failure = undefined; fixture.grant = undefined; fixture.settle = undefined; fixture.limit = undefined; fixture.options = undefined; });
afterEach(() => vi.unstubAllGlobals());

it('reuses shared recording, metering and sentence detection without creating another audio context', async () => {
  const context = vi.fn(); vi.stubGlobal('AudioContext', context);
  const level = vi.fn(), capture = new CallVoiceCapture({ onLevel: level }), started = await capture.start(vi.fn());
  expect(fixture.start).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { onLevel: level, silenceSeconds: 1, minSpeechSeconds: .25, onSilence: expect.any(Function) });
  fixture.options!.onLevel!(.45); expect(level).toHaveBeenCalledWith(.45); expect(context).not.toHaveBeenCalled();
  capture.stop(); expect(await started!.finished).toEqual({ wave: new Uint8Array([1, 2]), seconds: 2 }); expect(fixture.stop).toHaveBeenCalledOnce();
});
it('preserves the shared silence result and sixty-second limit callback without double stopping', async () => {
  const limit = vi.fn(), capture = new CallVoiceCapture(), started = await capture.start(limit);
  fixture.options!.onSilence!(); fixture.settle!({ wave: new Uint8Array([1]), seconds: 2 }); capture.stop();
  expect(fixture.stop).not.toHaveBeenCalled(); expect(limit).not.toHaveBeenCalled(); expect((await started!.finished)!.seconds).toBe(2);
  const capped = new CallVoiceCapture(); const cappedResult = await capped.start(limit); fixture.limit!(); fixture.settle!({ wave: new Uint8Array([1]), seconds: 60 });
  expect(limit).toHaveBeenCalledOnce(); expect((await cappedResult!.finished)!.seconds).toBe(60);
});
it('cancels an active capture and suppresses a late result', async () => {
  const capture = new CallVoiceCapture(), started = await capture.start(vi.fn()); capture.cancel();
  expect(await started!.finished).toBeUndefined(); expect(fixture.cancel).toHaveBeenCalled(); expect(fixture.track.stop).toHaveBeenCalled();
});
it.each(['cancel', 'stop'] as const)('%s before a late microphone grant releases it without returning a capture', async operation => {
  fixture.pending = true; const capture = new CallVoiceCapture(), starting = capture.start(vi.fn());
  capture[operation](); fixture.grant!(); expect(await starting).toBeUndefined(); expect(fixture.track.stop).toHaveBeenCalled();
});
it('cancels the shared recorder on startup failure while preserving the error', async () => {
  fixture.failure = Error('resume failed'); const capture = new CallVoiceCapture();
  await expect(capture.start(vi.fn())).rejects.toThrow('resume failed'); expect(fixture.cancel).toHaveBeenCalled();
});
