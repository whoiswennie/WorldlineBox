// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { BotSpeechPlayer, botSpeechAudioLevel, type BotSpeechFrame } from '../../src/renderer/companion-bot/BotSpeechPlayer';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture() {
  const frames: BotSpeechFrame[] = [], sources: FakeAudio[] = [], revoke = vi.fn(), callbacks = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  class FakeAudio extends EventTarget {
    src = ''; preload = ''; volume = 0; paused = true; ended = false; currentTime = 0; duration = NaN;
    play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('playing')); });
    pause = vi.fn(() => { this.paused = true; }); removeAttribute = vi.fn(); load = vi.fn();
    constructor() { super(); sources.push(this); }
  }
  const close = vi.fn(async () => undefined), disconnect = vi.fn();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('AudioContext', class {
    destination = {}; resume = vi.fn(async () => undefined); close = close;
    createMediaElementSource() { return { connect: vi.fn(), disconnect }; }
    createAnalyser() { return { fftSize: 512, connect: vi.fn(), disconnect, getByteTimeDomainData: (target: Uint8Array) => target.fill(145) }; }
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-speech'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
  const player = new BotSpeechPlayer(frame => frames.push(frame));
  const sample = () => { const entries = [...callbacks]; callbacks.clear(); for (const [, callback] of entries) callback(performance.now()); };
  return { player, frames, audio: sources[0]!, close, disconnect, revoke, sample };
}
it('measures real silence and audio energy without moving the mouth during silence', () => {
  expect(botSpeechAudioLevel(new Uint8Array(512).fill(128))).toBe(0);
  expect(botSpeechAudioLevel(new Uint8Array(512).fill(145))).toBeGreaterThan(.5);
  expect(botSpeechAudioLevel(new Uint8Array(512).fill(255))).toBe(1);
  expect(botSpeechAudioLevel(new Float32Array(512))).toBe(0);
  expect(botSpeechAudioLevel(new Float32Array(512).fill(.001))).toBe(0);
  expect(botSpeechAudioLevel(new Float32Array(512).fill(.05))).toBeGreaterThan(.3);
});
it('uses the actual player analyser and returns the mouth to rest when audio ends', async () => {
  const f = fixture(), play = f.player.play(new Uint8Array([1, 2, 3]));
  await Promise.resolve(); await Promise.resolve();
  expect(f.frames.at(-1)).toMatchObject({ playing: true }); expect(f.frames.at(-1)!.level).toBeGreaterThan(.5);
  f.audio.dispatchEvent(new Event('ended')); await expect(play).resolves.toBe('ended');
  expect(f.frames.at(-1)).toEqual({ playing: false, level: 0 }); expect(f.revoke).toHaveBeenCalledWith('blob:local-speech'); f.player.destroy();
});
it('settles an interrupted utterance and releases its analyser/context on hangup', async () => {
  const f = fixture(), play = f.player.play(new Uint8Array([1])); f.player.destroy();
  await expect(play).resolves.toBe('cancelled'); expect(f.close).toHaveBeenCalledOnce(); expect(f.disconnect).toHaveBeenCalledTimes(2);
  expect(f.frames.at(-1)).toEqual({ playing: false, level: 0 }); await expect(f.player.play(new Uint8Array([2]))).resolves.toBe('cancelled');
});
it('reports decoding failures rather than keeping a speaking pose or an unresolved queue', async () => {
  const f = fixture(), play = f.player.play(new Uint8Array([1])); const result = expect(play).rejects.toThrow('语音播放失败');
  f.audio.dispatchEvent(new Event('error')); await result; expect(f.frames.at(-1)).toEqual({ playing: false, level: 0 }); f.player.destroy();
});
it('reports the real media clock without estimating elapsed time and keeps buffering frames silent until playing resumes', async () => {
  const f = fixture(); f.audio.duration = 8; const play = f.player.play(new Uint8Array([1]));
  await Promise.resolve(); await Promise.resolve(); expect(f.frames.at(-1)).toMatchObject({ playing: true, positionSeconds: 0, durationSeconds: 8 });
  f.audio.currentTime = 2.25; f.sample(); expect(f.frames.at(-1)).toMatchObject({ playing: true, positionSeconds: 2.25, durationSeconds: 8 });
  for (let frame = 0; frame < 20; frame++) f.sample(); expect(f.frames.at(-1)?.positionSeconds).toBe(2.25);
  f.audio.dispatchEvent(new Event('waiting')); f.sample(); f.sample(); expect(f.frames.at(-1)).toMatchObject({ playing: false, level: 0, positionSeconds: 2.25 });
  f.audio.currentTime = 3; f.audio.dispatchEvent(new Event('playing')); expect(f.frames.at(-1)).toMatchObject({ playing: true, positionSeconds: 3 });
  f.player.stop(); await expect(play).resolves.toBe('cancelled'); f.player.destroy();
});
it('leaves unknown duration absent rather than claiming that an undecoded clip has finished', async () => {
  const f = fixture(), play = f.player.play(new Uint8Array([1])); await Promise.resolve(); await Promise.resolve();
  f.audio.currentTime = .5; f.sample(); expect(f.frames.at(-1)).toMatchObject({ playing: true, positionSeconds: .5 }); expect(f.frames.at(-1)).not.toHaveProperty('durationSeconds');
  f.audio.dispatchEvent(new Event('ended')); await expect(play).resolves.toBe('ended'); f.player.destroy();
});
