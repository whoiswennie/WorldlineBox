import type { BotMessage } from '../../shared/companion-bot';
import { BOT_SPEECH_MAX_AUDIO_BYTES, BOT_SPEECH_MAX_PARTS, BOT_SPEECH_PART_CHARACTERS, botSpeechText, type WorldlineBoxBotSpeechApi } from '../../shared/companion-bot-speech';
import type { BotSpeechFrame } from './BotSpeechPlayer';

export interface BotCallSpeechFailure { messageId: string; error: string }
export interface BotCallSpeechState { phase: 'idle' | 'preparing' | 'speaking' | 'error'; messageId?: string; completedMessageIds?: readonly string[]; error?: string; failures?: readonly BotCallSpeechFailure[]; displayText?: string; revealComplete?: boolean; pendingMessageIds?: readonly string[]; textMessageIds?: readonly string[] }
interface SpeechPlayer { play(bytes: Uint8Array, mimeType: string): Promise<'ended' | 'cancelled'>; stop(): void }

/** Playback queue for already-created chat replies; it never generates dialogue. */
export class BotCallSpeechSession {
  private seen = new Set<string>();
  private queue: string[] = [];
  private activeRequests = new Set<string>();
  private epoch = 0;
  private working = false;
  private closed = false;
  private enabled = true;
  private pending = new Set<string>();
  private text = new Set<string>();
  private pendingIds: readonly string[] = [];
  private textIds: readonly string[] = [];
  private failures = new Map<string, string>();
  private messageTexts = new Map<string, string>();
  private fullText?: string;
  private completedText = '';
  private part?: { characters: string[]; prefix: string; text: string; revealed: number };
  private state: BotCallSpeechState = { phase: 'idle' };
  constructor(private readonly options: {
    api: WorldlineBoxBotSpeechApi; conversationId: string; companionId: string; initialMessages: readonly BotMessage[];
    player: SpeechPlayer; changed(state: BotCallSpeechState): void; enabled?: boolean;
  }) {
    this.enabled = options.enabled ?? true;
    for (const message of options.initialMessages) if (message.status === 'sent' && message.conversationId === options.conversationId && message.senderId === options.companionId) { this.seen.add(message.id); this.rememberText(message); this.releaseText(message.id); }
    this.state = { phase: 'idle', pendingMessageIds: this.pendingIds, textMessageIds: this.textIds };
  }

  snapshot(): BotCallSpeechState { return this.state; }
  private holdText(id: string): boolean {
    let changed = this.text.delete(id);
    if (changed) this.textIds = [...this.text];
    if (!this.pending.has(id)) { this.pending.add(id); this.pendingIds = [...this.pending]; changed = true; }
    return changed;
  }
  private releaseText(id: string): boolean {
    let changed = this.pending.delete(id);
    if (changed) this.pendingIds = [...this.pending];
    if (!this.text.has(id)) {
      this.text.add(id); while (this.text.size > 512) this.text.delete(this.text.values().next().value!);
      this.textIds = [...this.text]; changed = true;
    }
    return changed;
  }

  private rememberText(message: BotMessage): void {
    if (message.conversationId !== this.options.conversationId || message.senderId !== this.options.companionId) return;
    const text = botSpeechText(message.content);
    // Oversized unsupported replies use the original UI's full-message fallback.
    if (Array.from(text).length <= BOT_SPEECH_MAX_PARTS * BOT_SPEECH_PART_CHARACTERS) this.messageTexts.set(message.id, text);
    while (this.messageTexts.size > 512) this.messageTexts.delete(this.messageTexts.keys().next().value!);
  }

  observe(messages: readonly BotMessage[]): void {
    if (this.closed) return;
    let presentationChanged = false;
    for (const message of messages) {
      if (message.conversationId !== this.options.conversationId || message.senderId !== this.options.companionId) continue;
      if (message.status === 'sent') this.rememberText(message);
      if (message.status === 'failed' || message.status === 'cancelled') {
        presentationChanged = this.releaseText(message.id) || presentationChanged; this.seen.add(message.id); continue;
      }
      // The first observed frame owns presentation, including replies still being generated.
      // Turning sound on later must not erase text the user has already been reading.
      if (!this.pending.has(message.id) && !this.text.has(message.id)) presentationChanged = (this.enabled ? this.holdText(message.id) : this.releaseText(message.id)) || presentationChanged;
      if (message.status !== 'sent' || this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (this.pending.has(message.id) && botSpeechText(message.content)) {
        if (this.queue.length < 8) this.queue.push(message.id);
        else { this.rememberFailure(message.id, '等待朗读的消息较多，请稍后手动重试。'); presentationChanged = this.releaseText(message.id) || presentationChanged; }
      } else presentationChanged = this.releaseText(message.id) || presentationChanged;
    }
    while (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    if (presentationChanged) this.report(this.state); this.start();
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.stop(); }
  replay(messageId: string): void {
    if (this.closed) return;
    const failed = this.failures.has(messageId);
    if (this.currentMessage === messageId && this.working && !failed) return;
    if (!this.queue.includes(messageId) && this.queue.length >= 16) { this.rememberFailure(messageId, '语音排队已满，请稍后重试。'); this.report(this.state); return; }
    this.failures.delete(messageId);
    this.holdText(messageId);
    this.queue = [messageId, ...this.queue.filter(id => id !== messageId)];
    // A retry is queued behind the current audio; it cannot discard other replies.
    this.report(this.state.phase === 'error' ? { ...this.state, phase: 'idle', error: undefined } : this.state); this.start();
  }
  private report(state: BotCallSpeechState): void {
    this.state = { ...state, pendingMessageIds: this.pendingIds, textMessageIds: this.textIds, failures: [...this.failures].map(([messageId, error]) => ({ messageId, error })) };
    this.options.changed(this.state);
  }
  private rememberFailure(messageId: string, error: string): void {
    this.failures.delete(messageId); this.failures.set(messageId, error.slice(0, 1000));
    while (this.failures.size > 16) this.failures.delete(this.failures.keys().next().value!);
  }
  markSpeaking(playing: boolean): void {
    this.updateFrame({ playing, level: 0 });
  }
  /** Presentation follows the media element's clock; waveform frames never create a timer. */
  updateFrame(frame: BotSpeechFrame): void {
    if (this.closed || !this.working || !this.currentMessage || !frame.playing || !this.part) return;
    const part = this.part;
    if (Number.isFinite(frame.positionSeconds) && Number.isFinite(frame.durationSeconds) && frame.durationSeconds! > 0) {
      const fraction = Math.max(0, Math.min(1, frame.positionSeconds! / frame.durationSeconds!));
      // The ended event, rather than rounding at the last media frame, completes a part.
      part.revealed = Math.max(part.revealed, Math.min(part.characters.length - 1, Math.floor(part.characters.length * fraction)));
    }
    const displayText = part.prefix + part.characters.slice(0, Math.max(0, part.revealed)).join('');
    if (this.state.phase !== 'speaking' || this.state.displayText !== displayText) this.report({ phase: 'speaking', messageId: this.currentMessage, displayText, revealComplete: false });
  }
  private completeText(): string | undefined {
    return this.fullText ?? (this.part ? this.part.prefix + this.part.text : this.completedText || undefined);
  }
  private currentMessage?: string;
  private start(): void { if (!this.closed && !this.working && this.queue.length) void this.drain(this.epoch); }
  private async drain(epoch: number): Promise<void> {
    this.working = true;
    const completedMessageIds: string[] = [];
    let lastFailure: BotCallSpeechFailure | undefined;
    try {
      while (this.queue.length && !this.closed && epoch === this.epoch) {
        const messageId = this.queue.shift()!; this.currentMessage = messageId;
        this.fullText = this.messageTexts.get(messageId); this.completedText = ''; this.part = undefined;
        try {
          let count = 1;
          for (let partIndex = 0; partIndex < count; partIndex++) {
            if (this.closed || epoch !== this.epoch) return;
            this.report({ phase: 'preparing', messageId, displayText: this.completedText, revealComplete: false });
            const requestId = crypto.randomUUID(); this.activeRequests.add(requestId);
            const response = await this.options.api.request({ type: 'speech.synthesize', conversationId: this.options.conversationId, messageId, requestId, partIndex }).finally(() => this.activeRequests.delete(requestId));
            if (this.closed || epoch !== this.epoch) return;
            if (response.cancelled) throw Error('这段语音已取消，可以手动重试。');
            if (!response.ok || !response.audio) throw Error(response.error || '暂时无法生成这段语音，可以重试。');
            const audio = response.audio;
            if (audio.partIndex !== partIndex || !Number.isInteger(audio.partCount) || audio.partCount < 1 || audio.partCount > BOT_SPEECH_MAX_PARTS || typeof audio.text !== 'string' || audio.text.length > BOT_SPEECH_PART_CHARACTERS * 2 || audio.base64.length > Math.ceil(BOT_SPEECH_MAX_AUDIO_BYTES / 3) * 4) throw Error('收到的语音数据无效。');
            const decoded = atob(audio.base64), bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
            if (!bytes.length || bytes.length > BOT_SPEECH_MAX_AUDIO_BYTES) throw Error('收到的语音数据无效。');
            count = audio.partCount;
            const offset = this.fullText?.indexOf(audio.text, this.completedText.length) ?? -1;
            this.part = { text: audio.text, prefix: offset >= 0 ? this.fullText!.slice(0, offset) : this.completedText,
              characters: [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(audio.text)].map(segment => segment.segment), revealed: 0 };
            const result = await this.options.player.play(bytes, audio.mimeType);
            if (this.closed || epoch !== this.epoch) return;
            if (result === 'cancelled') throw Error('这段语音播放已停止，可以手动重试。');
            this.completedText = this.part.prefix + this.part.text; this.part = undefined;
            if (partIndex + 1 === count) this.releaseText(messageId);
            this.report({ phase: 'speaking', messageId, displayText: partIndex + 1 === count ? this.completeText() : this.completedText, revealComplete: partIndex + 1 === count });
          }
          completedMessageIds.push(messageId);
        } catch (error) {
          if (this.closed || epoch !== this.epoch) return;
          lastFailure = { messageId, error: (error instanceof Error ? error.message : '语音暂不可用，可以重试。').slice(0, 1000) };
          this.rememberFailure(lastFailure.messageId, lastFailure.error);
          this.releaseText(messageId);
          const displayText = this.completeText(); this.completedText = displayText ?? this.completedText; this.part = undefined;
          this.options.player.stop(); this.report({ phase: 'error', ...lastFailure, displayText, revealComplete: true });
        }
      }
      if (!this.closed && epoch === this.epoch) this.report(!completedMessageIds.length && lastFailure
        ? { phase: 'error', ...lastFailure, completedMessageIds, displayText: this.completeText(), revealComplete: true }
        : { phase: 'idle', messageId: this.currentMessage, completedMessageIds, displayText: this.completeText(), revealComplete: true });
    } finally { if (epoch === this.epoch) { this.working = false; this.currentMessage = undefined; this.start(); } }
  }
  stop(): void {
    const messageId = this.currentMessage ?? this.state.messageId;
    const displayText = this.currentMessage ? this.completeText() : this.state.displayText;
    for (const id of [...this.pending]) { this.seen.add(id); this.releaseText(id); }
    ++this.epoch; this.queue = []; this.working = false; this.currentMessage = undefined;
    this.part = undefined;
    for (const requestId of this.activeRequests) void this.options.api.request({ type: 'speech.cancel', requestId }).catch(() => undefined);
    this.activeRequests.clear(); this.options.player.stop(); if (!this.closed) this.report({ phase: 'idle', messageId, displayText, revealComplete: true });
  }
  dispose(): void { if (this.closed) return; this.stop(); this.closed = true; this.failures.clear(); }
}
