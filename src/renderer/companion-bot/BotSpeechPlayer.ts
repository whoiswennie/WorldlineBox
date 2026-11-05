export interface BotSpeechFrame { playing: boolean; level: number; positionSeconds?: number; durationSeconds?: number }
export function botSpeechAudioLevel(samples: Uint8Array | Float32Array): number {
  if (!samples.length) return 0;
  let energy = 0;
  if (samples instanceof Float32Array) {
    for (const value of samples) energy += value ** 2;
  } else {
    for (const value of samples) energy += ((value - 128) / 128) ** 2;
  }
  return Math.min(1, Math.max(0, Math.sqrt(energy / samples.length) - .004) * 8);
}

/** One audible player and one analyser per visit. Never requests a microphone. */
export class BotSpeechPlayer {
  private audio = new Audio();
  private context?: AudioContext;
  private source?: MediaElementAudioSourceNode;
  private analyser?: AnalyserNode;
  private frame = 0;
  private url?: string;
  private closed = false;
  private finish?: (error?: Error, cancelled?: boolean) => void;
  constructor(private readonly onFrame: (frame: BotSpeechFrame) => void) { this.audio.preload = 'auto'; this.audio.volume = .9; }

  unlock(): void {
    if (this.closed) return;
    try {
      if (!this.context) {
        this.context = new AudioContext(); this.source = this.context.createMediaElementSource(this.audio);
        this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512;
        this.source.connect(this.analyser); this.analyser.connect(this.context.destination);
      }
      void this.context.resume().catch(() => undefined);
    } catch {
      // Keep audible output if a device cannot create an analyser.
      if (this.source && !this.analyser && this.context) this.source.connect(this.context.destination);
    }
  }

  play(bytes: Uint8Array, mimeType = 'audio/mpeg'): Promise<'ended' | 'cancelled'> {
    if (this.closed) return Promise.resolve('cancelled');
    this.stop(); this.unlock();
    this.url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    this.audio.src = this.url;
    return new Promise((resolve, reject) => {
      let settled = false, buffering = true;
      const samples = new Float32Array(this.analyser?.fftSize ?? 512);
      const byteSamples = new Uint8Array(samples.length);
      const sample = () => {
        if (settled || this.closed) return;
        const playing = !buffering && !this.audio.paused && !this.audio.ended;
        let level = 0;
        if (this.analyser && playing) {
          if (typeof this.analyser.getFloatTimeDomainData === 'function') {
            this.analyser.getFloatTimeDomainData(samples); level = botSpeechAudioLevel(samples);
          } else {
            this.analyser.getByteTimeDomainData(byteSamples); level = botSpeechAudioLevel(byteSamples);
          }
        }
        this.onFrame({ playing, level,
          ...(Number.isFinite(this.audio.currentTime) ? { positionSeconds: Math.max(0, this.audio.currentTime) } : {}),
          ...(Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? { durationSeconds: this.audio.duration } : {}) });
        this.frame = requestAnimationFrame(sample);
      };
      const playing = () => { buffering = false; cancelAnimationFrame(this.frame); sample(); };
      const waiting = () => { buffering = true; this.onFrame({ playing: false, level: 0 }); };
      const ended = () => finish();
      const failed = () => finish(Error('语音播放失败，可以重新朗读。'));
      const finish = (error?: Error, cancelled = false) => {
        if (settled) return; settled = true; clearTimeout(deadline); cancelAnimationFrame(this.frame);
        this.audio.removeEventListener('playing', playing); this.audio.removeEventListener('waiting', waiting);
        this.audio.removeEventListener('pause', waiting); this.audio.removeEventListener('ended', ended); this.audio.removeEventListener('error', failed);
        this.finish = undefined; this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
        if (this.url) { URL.revokeObjectURL(this.url); this.url = undefined; }
        this.onFrame({ playing: false, level: 0 });
        if (error) reject(error); else resolve(cancelled ? 'cancelled' : 'ended');
      };
      const deadline = setTimeout(() => finish(Error('这段语音播放超时，可以重新朗读。')), 300000);
      this.finish = finish;
      this.audio.addEventListener('playing', playing); this.audio.addEventListener('waiting', waiting);
      this.audio.addEventListener('pause', waiting); this.audio.addEventListener('ended', ended); this.audio.addEventListener('error', failed);
      void Promise.resolve(this.context?.resume()).then(() => {
        if (!settled && !this.closed) return this.audio.play();
      }).catch(error => finish(error instanceof Error ? error : Error('请点击朗读按钮播放语音。')));
    });
  }

  stop(): void {
    this.finish?.(undefined, true); cancelAnimationFrame(this.frame);
    this.onFrame({ playing: false, level: 0 });
  }
  destroy(): void {
    if (this.closed) return; this.stop(); this.closed = true;
    this.source?.disconnect(); this.analyser?.disconnect();
    void this.context?.close().catch(() => undefined); this.context = undefined;
  }
}
