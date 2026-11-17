import { BOT_PRESENCE_CLIP_SECONDS, BOT_PRESENCE_TASK_TIMEOUT_MS, type BotPresenceEnergy, type BotPresenceStatus } from '../../shared/companion-bot-media';
import type { PresenceRecording } from './presence-archive';
import type { SpeechFileSegment } from '../local-speech-audio';
import { abortable } from './abortable';

type CaptureKind = BotPresenceStatus['capture'];
export interface PresenceSample {
  records: readonly PresenceRecording[];
  frames: { timestamps: string[]; jpeg: string }[];
  subtitles: SpeechFileSegment[];
  sources: { kind: CaptureKind; from: number; to: number; originalPath?: string; audio?: 'recognized' | 'unavailable' }[];
}
export interface PresenceReaction { reaction: string; vision: boolean }
export interface PresenceTarget {
  vision: boolean;
  busy(): boolean;
  observe(sample: PresenceSample, signal: AbortSignal): Promise<PresenceReaction | undefined>;
}
interface Capture {
  screen(signal: AbortSignal): Promise<Uint8Array>;
  prepare(records: readonly PresenceRecording[], signal: AbortSignal): Promise<PresenceSample>;
  add(kind: CaptureKind, bytes: Uint8Array, startedAt: number, at: number): PresenceRecording;
  stage(record: PresenceRecording, signal: AbortSignal): void;
  canCapture(): boolean;
  claim(): PresenceRecording[];
  finish(records: readonly PresenceRecording[], success: boolean): void;
}

const jitter = (from: number, to: number) => Math.round(from + Math.random() * (to - from));

/** The renderer seals the current recording at the heartbeat. Successful batches
 * leave the pending queue only after DSH receives and processes the evidence. */
export class DesktopPresence {
  private readonly stop = new AbortController();
  private nextAt?: number;
  private cycle = 0;
  private captureKind: CaptureKind = 'screen';
  private timer?: ReturnType<typeof setTimeout>;
  private screenTimer?: ReturnType<typeof setTimeout>;
  private screenWork?: Promise<void>;
  private work?: AbortController;
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
    const capturePaused = !this.capture.canCapture();
    return { nextAt: this.nextAt, capture: this.captureKind, cycle: this.cycle, flushCycle: this.flush?.id,
      thinking: !!this.work, vision: this.vision, capturePaused, last: this.last, waitingForPartner: this.waitingForPartner,
      error: this.error ?? (capturePaused ? '待处理队列已满，采集暂缓。' : undefined) };
  }

  putClip(bytes: Uint8Array, startedAt: number, endedAt: number) {
    if (this.stop.signal.aborted) return;
    if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) throw Error('陪伴录像格式无效。');
    if (endedAt <= startedAt || endedAt - startedAt > (BOT_PRESENCE_CLIP_SECONDS + 10) * 1000 || endedAt > Date.now() + 10_000)
      throw Error('陪伴录像时间无效。');
    this.capture.stage(this.capture.add('video', bytes, startedAt, endedAt), this.stop.signal);
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
    this.captureKind = this.chooseCapture();
    this.cycle++;
    this.scheduleScreen();
  }

  close() {
    this.stop.abort();
    clearTimeout(this.timer);
    clearTimeout(this.screenTimer);
  }

  private chooseCapture(): CaptureKind {
    return this.energy === 'active' || this.energy === 'balanced' && Math.random() < .55 ? 'video' : 'screen';
  }

  private async captureScreen(signal: AbortSignal) {
    if (!this.capture.canCapture()) return;
    const bytes = await this.capture.screen(signal);
    signal.throwIfAborted();
    const captured = Date.now();
    this.capture.stage(this.capture.add('screen', bytes, captured, captured), this.stop.signal);
  }

  private scheduleScreen() {
    clearTimeout(this.screenTimer);
    if (this.stop.signal.aborted || this.work || this.captureKind !== 'screen') return;
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
    if (!keepCycle) {
      this.captureKind = this.chooseCapture();
      this.cycle++;
      this.scheduleScreen();
    }
    this.timer = setTimeout(() => { void this.beat(); }, delay);
    this.timer.unref();
  }

  private async flushClip(signal: AbortSignal) {
    const id = ++this.flushSerial;
    try {
      await abortable(new Promise<void>(done => { this.flush = { id, done }; }), AbortSignal.any([signal, AbortSignal.timeout(6000)]));
    } finally { this.flush = undefined; }
  }

  async beat() {
    if (this.stop.signal.aborted) return 'waiting';
    if (this.work) return 'thinking';
    if (this.target.busy()) {
      this.waitingForPartner = true;
      this.schedule(jitter(8500, 13_000), true);
      return 'busy';
    }
    this.waitingForPartner = false;
    clearTimeout(this.timer);
    clearTimeout(this.screenTimer);
    this.nextAt = undefined;
    const work = new AbortController();
    this.work = work;
    const signal = AbortSignal.any([work.signal, this.stop.signal]);
    const deadline = setTimeout(() => work.abort(new DOMException('本轮处理超时。', 'TimeoutError')), BOT_PRESENCE_TASK_TIMEOUT_MS);
    deadline.unref();
    const started = Date.now();
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
      if (!batch.length) return 'waiting';
      if (this.target.busy()) { this.waitingForPartner = true; return 'busy'; }
      const sample = await abortable(this.capture.prepare(batch, signal), signal);
      signal.throwIfAborted();
      const output = await abortable(this.target.observe(sample, signal), signal);
      if (!output) { this.waitingForPartner = true; return 'busy'; }
      processed = true;
      this.vision = output.vision;
      this.last = { at: Date.now(), outcome: output.reaction ? 'responded' : 'observed' };
      this.error = sample.sources.some(source => source.audio === 'unavailable') ? '部分录像音轨转写不可用。' : undefined;
      return 'accepted';
    } catch (error) {
      if (!this.stop.signal.aborted) this.error = error instanceof Error && error.name !== 'TimeoutError'
        ? error.message : '本轮采集未在时限内完成，素材已留待下次处理。';
      this.last = { at: Date.now(), outcome: work.signal.aborted && (work.signal.reason as Error)?.name !== 'TimeoutError' ? 'interrupted' : 'failed' };
      failed = true;
      return 'failed';
    } finally {
      clearTimeout(deadline);
      this.capture.finish(batch, processed);
      this.work = undefined;
      if (!this.stop.signal.aborted) {
        const extra = Math.min(15_000, Math.round((Date.now() - started) * .85));
        this.schedule(failed ? jitter(36_000, 56_000) : jitter(23_000 + extra, 38_000 + extra));
      }
    }
  }
}
