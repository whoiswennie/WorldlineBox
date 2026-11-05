import { SPEECH_RECORDING_SECONDS, SPEECH_SAMPLE_RATE } from '../../shared/local-speech';

export interface VoiceRecording { wave: Uint8Array; seconds: number }
export interface VoiceRecorderOptions {
  onLevel?(level: number): void;
  /** Optional sentence endpoint detection for the companion meeting session. */
  silenceSeconds?: number;
  minSpeechSeconds?: number;
  onSilence?(): void;
}
export function encodeSpeechWave(samples: Float32Array): Uint8Array {
  const count = Math.min(samples.length, SPEECH_RECORDING_SECONDS * SPEECH_SAMPLE_RATE), wave = new Uint8Array(44 + count * 2), view = new DataView(wave.buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) wave[at + i] = value.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, wave.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, SPEECH_SAMPLE_RATE, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) { const sample = Math.max(-1, Math.min(1, samples[i]!)); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  return wave;
}
export function speechBase64(bytes: Uint8Array): string {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary);
}

/** Only a deliberate user gesture starts the microphone. Every exit stops all tracks. */
export class VoiceRecorder {
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private timer?: ReturnType<typeof setTimeout>;
  private cancelled = false;
  private finish?: (value: VoiceRecording | undefined) => void;
  private reject?: (error: Error) => void;
  private context?: AudioContext;
  private captureContext?: AudioContext;
  private captureSource?: MediaStreamAudioSourceNode;
  private captureAnalyser?: AnalyserNode;
  private levelTimer?: ReturnType<typeof setInterval>;
  private levelCallback?: VoiceRecorderOptions['onLevel'];
  async start(onLimit: () => void, options: VoiceRecorderOptions = {}): Promise<{ startedAt: number; finished: Promise<VoiceRecording | undefined> } | undefined> {
    let failure: Error | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw Error('当前环境无法使用麦克风。');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (this.cancelled) { this.stream.getTracks().forEach(track => track.stop()); return undefined; }
      const recorder = new MediaRecorder(this.stream), chunks: Blob[] = []; let size = 0;
      this.recorder = recorder;
      const finished = new Promise<VoiceRecording | undefined>((resolve, reject) => { this.finish = resolve; this.reject = reject; });
      // Optional meter initialization awaits resume(). Recorder failures can happen
      // during that wait, before the caller has received the finished promise.
      void finished.catch(() => undefined);
      const fail = (error: Error) => { failure = error; this.reject?.(error); this.cancel(); };
      recorder.ondataavailable = event => {
        size += event.data.size;
        if (size > 8 * 1024 * 1024) { fail(Error('录音过大，请重新录制。')); return; }
        if (event.data.size && !this.cancelled) chunks.push(event.data);
      };
      recorder.onerror = () => fail(Error('麦克风录音中断。'));
      recorder.onstop = () => {
        clearTimeout(this.timer); this.stopLevels(); this.stream?.getTracks().forEach(track => track.stop());
        if (this.cancelled) { this.finish?.(undefined); return; }
        void this.convert(new Blob(chunks, { type: recorder.mimeType })).then(value => this.finish?.(this.cancelled ? undefined : value), error => this.reject?.(error instanceof Error ? error : Error('录音处理失败。')));
      };
      recorder.start(1000); this.timer = setTimeout(() => { this.stop(); onLimit(); }, SPEECH_RECORDING_SECONDS * 1000);
      const startedAt = performance.now();
      if (options.onLevel || options.silenceSeconds) {
        const context = new AudioContext(); this.captureContext = context; this.levelCallback = options.onLevel;
        const source = context.createMediaStreamSource(this.stream); this.captureSource = source;
        const analyser = context.createAnalyser(); this.captureAnalyser = analyser; analyser.fftSize = 1024; source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize); let lastTick = performance.now(), lastSpeech = lastTick, voicedMs = 0;
        await context.resume();
        if (failure) throw failure;
        if (this.cancelled) { this.stopLevels(); return undefined; }
        if (this.captureContext !== context || recorder.state !== 'recording') { this.stopLevels(); return { startedAt, finished }; }
        this.levelTimer = setInterval(() => {
          try {
            analyser.getFloatTimeDomainData(samples); const now = performance.now(), delta = Math.min(100, now - lastTick); lastTick = now;
            const energy = samples.reduce((sum, value) => sum + value * value, 0), rms = Number.isFinite(energy) ? Math.sqrt(energy / samples.length) : 0;
            options.onLevel?.(Math.min(1, rms * 8));
            if (rms >= 0.012) { voicedMs += delta; lastSpeech = now; }
            if (options.silenceSeconds && voicedMs >= (options.minSpeechSeconds ?? 0.3) * 1000 && now - lastSpeech >= options.silenceSeconds * 1000) { this.stop(); options.onSilence?.(); }
          } catch (error) { fail(error instanceof Error ? error : Error('麦克风音量检测中断。')); }
        }, 50);
      }
      return { startedAt, finished };
    } catch (error) {
      const alreadyCancelled = this.cancelled; this.cancel();
      if (alreadyCancelled && !failure) return undefined;
      throw failure ?? error;
    }
  }
  stop(): void { clearTimeout(this.timer); this.stopLevels(); if (this.recorder?.state === 'recording') this.recorder.stop(); }
  cancel(): void { this.cancelled = true; clearTimeout(this.timer); this.stop(); this.stream?.getTracks().forEach(track => track.stop()); this.finish?.(undefined); void this.context?.close().catch(() => undefined); }
  private stopLevels(): void {
    clearInterval(this.levelTimer); this.levelTimer = undefined;
    try { this.captureSource?.disconnect(); } catch { /* A failed/closed context must still release the other resources. */ }
    try { this.captureAnalyser?.disconnect(); } catch { /* The context can have closed before cleanup. */ }
    this.captureSource = undefined; this.captureAnalyser = undefined;
    const context = this.captureContext; this.captureContext = undefined;
    void context?.close().catch(() => undefined);
    const callback = this.levelCallback; this.levelCallback = undefined;
    try { callback?.(0); } catch { /* View errors cannot prevent stopping microphone tracks. */ }
  }
  private async convert(blob: Blob): Promise<VoiceRecording> {
    this.context = new AudioContext();
    try {
      const decoded = await this.context.decodeAudioData(await blob.arrayBuffer());
      const seconds = Math.min(decoded.duration, SPEECH_RECORDING_SECONDS);
      if (!Number.isFinite(seconds) || seconds < 0.25) throw Error('录音太短，请至少说一句话。');
      const offline = new OfflineAudioContext(1, Math.ceil(seconds * SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE);
      const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
      const rendered = await offline.startRendering(); return { wave: encodeSpeechWave(rendered.getChannelData(0)), seconds };
    } finally { await this.context.close().catch(() => undefined); this.context = undefined; }
  }
}
