import { SPEECH_MAX_TRANSCRIPT, type LocalSpeechRequest, type LocalSpeechResponse, type WorldlineBoxLocalSpeechApi } from '../../shared/local-speech';
import { speechBase64, type VoiceRecording } from './voice-recorder';

export interface BotCallVoiceCapture {
  start(onLimit: () => void): Promise<{ finished: Promise<VoiceRecording | undefined> } | undefined>;
  stop(): void;
  cancel(): void;
}
export interface BotCallVoiceState {
  phase: 'off' | 'preparing' | 'listening' | 'recognizing' | 'waiting' | 'speaking' | 'error';
  enabled: boolean; turn: number; transcript?: string; error?: string; canRetrySend?: boolean;
}
export interface BotCallVoiceOptions {
  api: WorldlineBoxLocalSpeechApi;
  captureFactory(): BotCallVoiceCapture;
  /** This callback must stay bound to the original meeting conversation. */
  send(text: string, requestId: string): Promise<boolean>;
  stopSpeech(): void;
  changed(state: BotCallVoiceState): void;
}
interface Capture { recorder: BotCallVoiceCapture; epoch: number; stopping: boolean }
interface SendAttempt { text: string; requestId: string; accepted: boolean; perform?: () => Promise<boolean> }

/** Half-duplex UI lifecycle over the existing chat; no model or polling loop. */
export class BotCallVoiceSession {
  private value: BotCallVoiceState = { phase: 'off', enabled: false, turn: 0 };
  private epoch = 0;
  private closed = false;
  private prepared = false;
  private capture?: Capture;
  private readonly activeRequests = new Set<string>();
  private attempt?: SendAttempt;
  private sending = false;
  private resumeRequested = false;
  private playbackBlocked = false;
  private preparingResourcesEpoch?: number;
  private pendingTyped?: { text: string; requestId: string; promise: Promise<boolean> };
  constructor(private readonly options: BotCallVoiceOptions) {}
  get state(): BotCallVoiceState { return { ...this.value }; }
  private current(epoch: number): boolean { return !this.closed && this.value.enabled && this.epoch === epoch; }
  private publish(next: Partial<BotCallVoiceState>): void {
    this.value = { ...this.value, ...next };
    this.value.canRetrySend = this.value.phase === 'error' && !!this.attempt && !this.attempt.accepted;
    this.options.changed({ ...this.value });
  }
  private cancelWork(): number {
    ++this.epoch; this.sending = false; this.resumeRequested = false; this.pendingTyped = undefined; this.preparingResourcesEpoch = undefined;
    const capture = this.capture; this.capture = undefined;
    try { capture?.recorder.cancel(); } catch { /* Still cancel the remaining work. */ }
    for (const requestId of this.activeRequests) void this.options.api.request({ type: 'speech.cancel', requestId }).catch(() => undefined);
    this.activeRequests.clear(); return this.epoch;
  }
  private async request(input: Extract<LocalSpeechRequest, { requestId: string }>): Promise<LocalSpeechResponse> {
    this.activeRequests.add(input.requestId);
    try { return await this.options.api.request(input); }
    finally { this.activeRequests.delete(input.requestId); }
  }
  private fail(error: unknown, epoch: number, stopSpeech = true): void {
    if (!this.current(epoch)) return;
    this.cancelWork(); this.playbackBlocked = false;
    this.publish({ phase: 'error', error: error instanceof Error ? error.message : '语音对话暂时不可用，请重试。' });
    if (stopSpeech) this.options.stopSpeech();
  }

  /** Called only by a deliberate user's enable/start action. */
  async start(): Promise<void> {
    if (this.closed || this.value.enabled && !['off', 'error'].includes(this.value.phase)) return;
    const epoch = this.cancelWork(); this.attempt = undefined; this.prepared = false; this.playbackBlocked = false;
    this.publish({ enabled: true, phase: 'preparing', transcript: undefined, error: undefined }); this.options.stopSpeech();
    await this.prepareResources(epoch);
  }
  private async prepareResources(epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    this.preparingResourcesEpoch = epoch;
    try {
      const status = await this.options.api.request({ type: 'speech.status' });
      if (!this.current(epoch)) return;
      if (!status.ok || !status.status) throw Error(status.error || '本地语音识别服务尚未就绪。');
      if (['unprepared', 'preparing', 'failed'].includes(status.status.phase)) {
        const prepared = await this.request({ type: 'speech.prepare', requestId: crypto.randomUUID() });
        if (!this.current(epoch)) return;
        if (!prepared.ok || prepared.cancelled) throw Error(prepared.error || '语音资源准备未完成，请重试。');
      }
      this.prepared = true;
      if (this.playbackBlocked) { this.publish({ phase: 'speaking' }); return; }
      await this.listen(epoch);
    } catch (error) { this.fail(error, epoch); }
    finally { if (this.preparingResourcesEpoch === epoch) this.preparingResourcesEpoch = undefined; }
  }
  private async listen(epoch: number): Promise<void> {
    if (!this.current(epoch) || !this.prepared || this.playbackBlocked) return;
    this.resumeRequested = false; this.attempt = undefined;
    this.publish({ phase: 'preparing', turn: this.value.turn + 1, transcript: undefined, error: undefined });
    if (!this.current(epoch) || this.playbackBlocked) return;
    const capture: Capture = { recorder: this.options.captureFactory(), epoch, stopping: false }; this.capture = capture;
    try {
      const started = await capture.recorder.start(() => this.finishUtterance());
      if (!this.current(epoch) || this.capture !== capture) { capture.recorder.cancel(); void started?.finished.catch(() => undefined); return; }
      if (!started) { this.stop(); return; }
      this.publish({ phase: 'listening' });
      void started.finished.then(recording => this.recognize(recording, capture), error => this.fail(error, epoch)).catch(error => this.fail(error, epoch));
    } catch (error) { this.fail(error, epoch); }
  }
  finishUtterance(): void {
    const capture = this.capture;
    if (!capture || !this.current(capture.epoch) || capture.stopping) return;
    capture.stopping = true;
    try { capture.recorder.stop(); } catch (error) { this.fail(error, capture.epoch); }
  }
  private async recognize(recording: VoiceRecording | undefined, capture: Capture): Promise<void> {
    const epoch = capture.epoch;
    if (!this.current(epoch) || this.capture !== capture) return;
    this.capture = undefined; try { capture.recorder.cancel(); } catch { /* Audio bytes remain local to this utterance. */ }
    if (!recording) { this.stop(); return; }
    this.publish({ phase: 'recognizing', error: undefined });
    if (!this.current(epoch)) return;
    try {
      const response = await this.request({ type: 'speech.transcribe', requestId: crypto.randomUUID(), audio: speechBase64(recording.wave) });
      if (!this.current(epoch)) return;
      const text = response.transcript?.text.trim();
      if (!response.ok || response.cancelled || !text) throw Error(response.error || '没有听清这句话，请再说一次。');
      if (text.length > SPEECH_MAX_TRANSCRIPT) throw Error('识别文字过长，请缩短后重试。');
      this.attempt = { text, requestId: crypto.randomUUID(), accepted: false };
      this.publish({ transcript: text }); await this.deliver(epoch);
    } catch (error) { this.fail(error, epoch); }
  }
  private async deliver(epoch: number): Promise<boolean> {
    const attempt = this.attempt; if (!attempt || !this.current(epoch) || this.sending) return false;
    this.sending = true; this.publish({ phase: 'waiting', error: undefined, transcript: attempt.text });
    if (!this.current(epoch) || this.attempt !== attempt) return false;
    try {
      const accepted = await (attempt.perform ? attempt.perform() : this.options.send(attempt.text, attempt.requestId));
      // The chat send has already left this voice lifecycle. Closing the mic or
      // starting a later turn cannot undo its acknowledgement or mark it unsent.
      if (!this.current(epoch) || this.attempt !== attempt) return accepted;
      this.sending = false;
      if (!accepted) throw Error('消息未确认发送，可以重试原消息。');
      attempt.accepted = true;
      if (this.resumeRequested) void this.listen(epoch).catch(error => this.fail(error, epoch));
      return true;
    } catch (error) { this.fail(error, epoch); return false; }
  }
  async retrySend(): Promise<void> {
    if (this.closed || !this.value.enabled || this.value.phase !== 'error' || !this.attempt || this.attempt.accepted) return;
    const epoch = this.cancelWork(); await this.deliver(epoch);
  }
  /** Typed messages use the same half-duplex turn and original chat send intent. */
  sendText(text: string, requestId: string): Promise<boolean> {
    if (!text.trim()) return Promise.resolve(false);
    return this.sendAction(text, requestId, () => this.options.send(text, requestId));
  }
  /** Explicit composer submissions keep their frozen attachments and original send action. */
  sendAction(text: string, requestId: string, perform: () => Promise<boolean>): Promise<boolean> {
    if (this.closed || !this.value.enabled || !requestId) return Promise.resolve(false);
    if (this.pendingTyped?.requestId === requestId) return this.pendingTyped.text === text ? this.pendingTyped.promise : Promise.resolve(false);
    const epoch = this.cancelWork(); this.playbackBlocked = false;
    this.attempt = { text, requestId, accepted: false, perform };
    // Publish preparing before stopping old speech: its synchronous idle callback
    // must not re-open the microphone for this newly submitted turn.
    this.publish({ phase: 'preparing', turn: this.value.turn + 1, transcript: text, error: undefined }); this.options.stopSpeech();
    const pending = { text, requestId, promise: Promise.resolve(false) }; this.pendingTyped = pending;
    pending.promise = this.deliver(epoch).finally(() => { if (this.pendingTyped === pending) this.pendingTyped = undefined; });
    return pending.promise;
  }
  /** Preparation/playback blocks the mic; Root opens the next turn after the whole queue ends. */
  markSpeaking(turn = this.value.turn): void {
    if (this.closed || !this.value.enabled || turn !== this.value.turn || ['off', 'error'].includes(this.value.phase)) return;
    // Unsolicited playback also closes the mic, preventing speaker audio re-recording.
    if (this.prepared && !['waiting', 'speaking'].includes(this.value.phase)) this.cancelWork();
    this.playbackBlocked = true;
    this.publish({ phase: 'speaking', error: undefined });
  }
  /** Root calls after the associated reply fully ends, or when reading is disabled. */
  readyForNextTurn(turn = this.value.turn): void {
    if (this.closed || !this.value.enabled || turn !== this.value.turn || !['waiting', 'speaking'].includes(this.value.phase)) return;
    this.playbackBlocked = false;
    if (!this.prepared) {
      if (this.preparingResourcesEpoch !== this.epoch) { this.publish({ phase: 'preparing' }); void this.prepareResources(this.epoch); }
      return;
    }
    if (this.sending) { this.resumeRequested = true; return; }
    const epoch = this.epoch; void this.listen(epoch).catch(error => this.fail(error, epoch));
  }
  /** An exact reply ID proves acceptance, even if the send acknowledgement is still pending. */
  replyFailed(error: string, turn = this.value.turn): void {
    if (this.closed || !this.value.enabled || turn !== this.value.turn || !['waiting', 'speaking'].includes(this.value.phase)) return;
    if (this.attempt) this.attempt.accepted = true;
    this.fail(Error(error || '伙伴回复或朗读未完成，可以重新开始语音。'), this.epoch, false);
  }
  /** Re-arm an enabled conversation for a deliberate TTS retry, without resending chat. */
  waitForPlayback(): void {
    if (this.closed || !this.value.enabled || !this.prepared) return;
    this.cancelWork(); this.attempt = undefined; this.playbackBlocked = true;
    this.publish({ phase: 'speaking', error: undefined });
  }
  /** Explicit barge-in: stop playback before opening a new microphone capture. */
  async interruptTalk(): Promise<void> {
    if (this.closed || !this.value.enabled) return;
    const epoch = this.cancelWork(); this.playbackBlocked = false;
    this.publish({ phase: 'preparing', error: undefined }); this.options.stopSpeech();
    try { if (this.prepared) await this.listen(epoch); else { this.publish({ enabled: false, phase: 'off' }); await this.start(); } }
    catch (error) { this.fail(error, epoch); }
  }
  pause(): void { this.stop(); }
  stop(): void {
    if (this.closed) return;
    this.cancelWork(); this.playbackBlocked = false; this.publish({ enabled: false, phase: 'off', error: undefined }); this.options.stopSpeech();
  }
  dispose(): void {
    if (this.closed) return;
    this.stop(); this.closed = true; this.attempt = undefined;
    this.value = { phase: 'off', enabled: false, turn: this.value.turn };
  }
}
