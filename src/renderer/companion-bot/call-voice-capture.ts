import { VoiceRecorder, type VoiceRecording } from './voice-recorder';

export interface CallVoiceCaptureOptions { onLevel?(level: number): void }

/** Meeting-specific sentence options over the shared microphone/WAV recorder. */
export class CallVoiceCapture {
  private readonly recorder = new VoiceRecorder();
  private used = false;
  private starting = false;
  private stopped = false;
  private cancelled = false;
  constructor(private readonly options: CallVoiceCaptureOptions = {}) {}

  async start(onLimit: () => void): Promise<{ startedAt: number; finished: Promise<VoiceRecording | undefined> } | undefined> {
    if (this.used) throw Error('这段录音已结束，请开始一段新的录音。');
    this.used = true; this.starting = true;
    try {
      const captured = await this.recorder.start(() => { this.stopped = true; if (!this.cancelled) onLimit(); }, {
        onLevel: this.options.onLevel,
        silenceSeconds: 1,
        minSpeechSeconds: .25,
        onSilence: () => { this.stopped = true; },
      });
      this.starting = false;
      if (!captured || this.cancelled) { this.recorder.cancel(); return undefined; }
      const finished = captured.finished.then(value => this.cancelled ? undefined : value, error => { if (this.cancelled) return undefined; throw error; });
      void finished.catch(() => undefined);
      return { startedAt: captured.startedAt, finished };
    } catch (error) {
      this.starting = false; this.stopped = true; this.recorder.cancel();
      if (this.cancelled) return undefined;
      throw error;
    }
  }
  stop(): void {
    if (this.starting) { this.cancel(); return; }
    if (this.stopped) return;
    this.stopped = true; this.recorder.stop();
  }
  cancel(): void { this.cancelled = true; this.stopped = true; this.recorder.cancel(); }
}

export { CallVoiceCapture as BotCallVoiceCapture };
