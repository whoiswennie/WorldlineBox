import { BOT_PRESENCE_CLIP_SECONDS, BOT_PRESENCE_TASK_TIMEOUT_MS, type BotHeartbeatState, type BotPresenceEnergy, type BotPresenceStatus } from '../../shared/companion-bot-media';
import type { PresenceRecording } from './presence-archive';
import type { SpeechFileSegment } from '../local-speech-audio';
import { abortable } from './abortable';

type CaptureKind = BotPresenceStatus['capture'];
export interface PresenceSample {
  records: readonly PresenceRecording[];
  frames: { kind: 'sheet' | 'keyframe'; timestamps: string[]; jpeg: string }[];
  subtitles: SpeechFileSegment[];
  sources: { kind: CaptureKind; from: number; to: number; originalPath?: string; audio?: 'recognized' | 'unavailable'; visual?: 'available' | 'unavailable' }[];
}
export interface PresenceReaction { reaction: string; vision: boolean; note?: string }
export interface PresenceTarget {
  vision: boolean;
  busy(): boolean;
  observe(sample: PresenceSample, signal: AbortSignal): Promise<PresenceReaction | undefined>;
}
interface Capture {
  beginRound?(at: number, waitMs: number): number;
  updateRound?(id: number, state: BotHeartbeatState, records?: readonly PresenceRecording[], error?: string): void;
  notify?(status: BotPresenceStatus): void;
  screen(signal: AbortSignal): Promise<Uint8Array>;
  prepare(records: readonly PresenceRecording[], signal: AbortSignal): Promise<PresenceSample>;
  add(kind: CaptureKind, bytes: Uint8Array, startedAt: number, at: number): PresenceRecording;
  canCapture(): boolean;
  claim(): PresenceRecording[];
  discardPending(): void;
  finish(records: readonly PresenceRecording[], success: boolean, obsolete: boolean): void;
}

const jitter = (from: number, to: number) => Math.round(from + Math.random() * (to - from));

/** The renderer seals the current recording at the heartbeat. Successful batches
 * leave the pending queue only after DSH receives and processes the evidence. */
export class DesktopPresence {
  private readonly stop = new AbortController();
  private nextAt?: number;
  private waitMs = 0;
  private revision = 0;
  private cycle = 0;
  private captureKind: CaptureKind = 'screen';
  private timer?: ReturnType<typeof setTimeout>;
  private screenTimer?: ReturnType<typeof setTimeout>;
  private screenWork?: Promise<void>;
  private screenshotCycle?: number;
  private lastScreenshotAt?: number;
  private work?: AbortController;
  private phase?: BotPresenceStatus['phase'];
  private recordingDelay?: number;
  private quietRounds = 0;
  private interacting = false;
  private flush?: { id: number; done(): void };
  private flushSerial = 0;
  private vision: boolean;
  private last?: BotPresenceStatus['last'];
  private waitingForPartner = false;
  private error?: string;

  constructor(private energy: BotPresenceEnergy, private readonly target: PresenceTarget, private readonly capture: Capture) {
    this.vision = target.vision;
    this.schedule(jitter(24_000, 30_000));
  }

  status(): BotPresenceStatus {
    const capturePaused = this.waitingForPartner || !this.capture.canCapture();
    const recent = this.lastScreenshotAt !== undefined && Date.now() - this.lastScreenshotAt < 3000;
    const screenshot = this.screenshotCycle !== undefined ? 'capturing' : recent ? 'just-captured' : undefined;
    return { revision: ++this.revision, nextAt: this.nextAt, capture: this.captureKind, cycle: this.cycle, flushCycle: this.flush?.id, screenshot,
      thinking: !!this.work, phase: this.phase, vision: this.vision, capturePaused, last: this.last, waitingForPartner: this.waitingForPartner,
      error: this.error };
  }

  putClip(bytes: Uint8Array, startedAt: number, endedAt: number, cycle = this.cycle) {
    if (this.stop.signal.aborted || this.waitingForPartner || cycle !== this.cycle) return;
    if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) throw Error('陪伴录像格式无效。');
    if (endedAt <= startedAt || endedAt - startedAt > (BOT_PRESENCE_CLIP_SECONDS + 10) * 1000 || endedAt > Date.now() + 10_000)
      throw Error('陪伴录像时间无效。');
    this.capture.add('video', bytes, startedAt, endedAt);
  }

  recordingStarted(cycle: number) {
    if (cycle !== this.cycle || this.work || this.recordingDelay === undefined) return;
    const delay = this.recordingDelay;
    this.recordingDelay = undefined;
    this.schedule(delay, true);
  }

  syncActivity(interacting: boolean) {
    this.interacting = interacting;
    const busy = interacting || this.target.busy();
    if (busy === this.waitingForPartner) return;
    this.waitingForPartner = busy;
    if (busy) {
      clearTimeout(this.timer);
      clearTimeout(this.screenTimer);
      this.nextAt = this.recordingDelay = undefined;
      this.cycle++;
      this.quietRounds = 0;
      this.lastScreenshotAt = undefined;
      this.capture.discardPending();
      this.work?.abort(Error('用户正在交流。'));
    } else if (!this.work) this.schedule(jitter(24_000, 30_000));
  }

  flushed(id: number) {
    if (this.flush?.id === id) this.flush.done();
  }

  interrupt() {
    this.work?.abort(Error('本轮已中断，未处理素材留待下次。'));
  }

  setEnergy(energy: BotPresenceEnergy) {
    if (this.energy === energy) return;
    this.energy = energy;
    if (!this.work && !this.waitingForPartner) this.schedule(jitter(24_000, 30_000));
  }

  close() {
    this.stop.abort();
    this.capture.discardPending();
    clearTimeout(this.timer);
    clearTimeout(this.screenTimer);
  }

  private chooseCapture(): CaptureKind {
    return this.energy === 'active' || this.energy === 'balanced' && Math.random() < .55 ? 'video' : 'screen';
  }

  private async captureScreen(signal: AbortSignal) {
    if (!this.capture.canCapture()) return;
    const cycle = this.cycle;
    this.screenshotCycle = cycle;
    this.capture.notify?.(this.status());
    try {
      const bytes = await this.capture.screen(signal);
      signal.throwIfAborted();
      if (cycle !== this.cycle || this.waitingForPartner) return;
      const captured = Date.now();
      this.capture.add('screen', bytes, captured, captured);
      this.lastScreenshotAt = captured;
    } finally {
      if (this.screenshotCycle === cycle) this.screenshotCycle = undefined;
      if (!this.stop.signal.aborted) this.capture.notify?.(this.status());
    }
  }

  private scheduleScreen() {
    clearTimeout(this.screenTimer);
    if (this.stop.signal.aborted || this.waitingForPartner || this.work || this.screenWork || this.captureKind !== 'screen') return;
    this.screenTimer = setTimeout(() => {
      const operation = this.captureScreen(this.stop.signal).catch(error => {
        if (!this.stop.signal.aborted) this.error = error instanceof Error ? error.message : '陪伴截图失败。';
      }).finally(() => {
        if (this.screenWork === operation) this.screenWork = undefined;
        if (!this.work) this.scheduleScreen();
      });
      this.screenWork = operation;
    }, jitter(4500, 8500));
    this.screenTimer.unref();
  }

  private schedule(delay: number, keepCycle = false) {
    clearTimeout(this.timer);
    if (this.stop.signal.aborted) return;
    this.nextAt = Date.now() + delay;
    this.waitMs = delay;
    if (!keepCycle) {
      this.captureKind = this.chooseCapture();
      this.recordingDelay = this.captureKind === 'video' ? delay : undefined;
      this.cycle++;
      this.scheduleScreen();
    }
    this.timer = setTimeout(() => { void this.beat(); }, delay);
    this.timer.unref();
  }

  private async flushClip(signal: AbortSignal) {
    const id = ++this.flushSerial;
    try {
      await abortable(new Promise<void>(done => {
        this.flush = { id, done };
        this.capture.notify?.(this.status());
      }), AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
    } finally { this.flush = undefined; }
  }

  async beat() {
    if (this.stop.signal.aborted) return 'waiting';
    if (this.work) return 'thinking';
    try {
      this.syncActivity(this.interacting);
      if (this.waitingForPartner) return 'busy';
    } catch (error) {
      this.error = error instanceof Error ? error.message : '伙伴状态暂时不可用。';
      this.schedule(15_000, true);
      return 'failed';
    }
    this.waitingForPartner = false;
    clearTimeout(this.timer);
    clearTimeout(this.screenTimer);
    this.nextAt = undefined;
    const work = new AbortController();
    this.work = work;
    this.phase = 'sealing';
    const signal = AbortSignal.any([work.signal, this.stop.signal]);
    const deadline = setTimeout(() => work.abort(new DOMException('本轮处理超时。', 'TimeoutError')), BOT_PRESENCE_TASK_TIMEOUT_MS);
    deadline.unref();
    const started = Date.now(), cycle = this.cycle;
    const round = this.capture.beginRound?.(started, this.waitMs);
    const report = (state: BotHeartbeatState, records?: readonly PresenceRecording[], error?: string) => {
      if (round !== undefined) this.capture.updateRound?.(round, state, records, error);
    };
    let outcome: BotHeartbeatState = 'interrupted';
    let batch: PresenceRecording[] = [], failed = false, processed = false;
    try {
      if (this.captureKind === 'video') await this.flushClip(signal);
      else {
        if (this.screenWork) await abortable(this.screenWork, signal);
        try { await abortable(this.captureScreen(signal), signal); }
        catch (error) {
          signal.throwIfAborted();
          this.error = error instanceof Error ? error.message : '陪伴截图失败。';
        }
      }
      signal.throwIfAborted();
      batch = this.capture.claim();
      report('preparing', batch);
      if (!batch.length) { outcome = 'empty'; return 'waiting'; }
      this.syncActivity(this.interacting);
      if (this.waitingForPartner) return 'busy';
      this.phase = 'preparing';
      this.capture.notify?.(this.status());
      const sample = await abortable(this.capture.prepare(batch, signal), signal);
      signal.throwIfAborted();
      this.phase = 'observing';
      report('observing');
      this.capture.notify?.(this.status());
      const output = await abortable(this.target.observe(sample, signal), signal);
      if (!output) { this.syncActivity(this.interacting); return 'busy'; }
      processed = true;
      outcome = 'completed';
      this.quietRounds = output.reaction ? 0 : Math.min(3, this.quietRounds + 1);
      this.vision = output.vision;
      this.last = { at: Date.now(), outcome: output.reaction ? 'responded' : 'observed' };
      this.error = sample.sources.some(source => source.visual === 'unavailable') ? '部分录像画面未能解码。'
        : sample.sources.some(source => source.audio === 'unavailable') ? '部分录像音轨转写不可用。' : undefined;
      return 'accepted';
    } catch (error) {
      if (!this.stop.signal.aborted && !this.waitingForPartner) this.error = error instanceof Error && error.name !== 'TimeoutError'
        ? error.message : '本轮采集未在时限内完成，素材已留待下次处理。';
      this.last = { at: Date.now(), outcome: work.signal.aborted && (work.signal.reason as Error)?.name !== 'TimeoutError' ? 'interrupted' : 'failed' };
      failed = true;
      outcome = signal.aborted && (signal.reason as Error)?.name !== 'TimeoutError' ? 'interrupted' : 'failed';
      return 'failed';
    } finally {
      clearTimeout(deadline);
      report(outcome, undefined, outcome === 'failed' ? this.error : undefined);
      this.capture.finish(batch, processed, cycle !== this.cycle || this.stop.signal.aborted);
      this.work = undefined;
      this.phase = undefined;
      if (!this.stop.signal.aborted && !this.waitingForPartner) {
        const extra = Math.min(15_000, Math.round((Date.now() - started) * .85));
        this.schedule(failed ? jitter(36_000, 56_000) : jitter(23_000, 38_000) + extra + this.quietRounds * 5000);
      }
      if (!this.stop.signal.aborted) this.capture.notify?.(this.status());
    }
  }
}
