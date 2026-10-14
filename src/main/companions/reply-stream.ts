import { randomUUID } from 'node:crypto';
import type { CompanionLoopCheckpoint } from '../../shared/companion-loop';
import type { CompanionReplyStreamEvent } from '../../shared/companions';

interface ReplyStreamOptions {
  checkpoint: CompanionLoopCheckpoint;
  step: number;
  publish(event: CompanionReplyStreamEvent): void;
  save(): Promise<unknown>;
}

/** Coalesces actual model output independently of durable checkpoint writes.
 * One attempt owns one draft; retrying replaces it after pending writes settle. */
export class CompanionReplyStream {
  readonly attemptId = randomUUID();
  private text = '';
  private lastPublished?: string;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saves: Promise<void> = Promise.resolve();
  private failure?: unknown;
  private closed = false;

  constructor(private readonly options: ReplyStreamOptions) {
    options.checkpoint.draft = { step: options.step, attemptId: this.attemptId, text: '' };
    this.publish('streaming', '');
  }

  readonly onTextDelta = (text: string): void => {
    if (this.closed || !this.ownsDraft()) return;
    this.text = text;
    this.options.checkpoint.draft!.text = text;
    if (this.lastPublished === '') this.publish('streaming', text);
    else if (!this.eventTimer) this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      if (!this.closed && this.ownsDraft()) this.publish('streaming', this.text);
    }, 60);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (!this.closed && this.ownsDraft()) this.saveDraft();
    }, 750);
  };

  private ownsDraft(): boolean { return this.options.checkpoint.draft?.attemptId === this.attemptId; }
  private publish(phase: CompanionReplyStreamEvent['phase'], text: string): void {
    const { checkpoint, step } = this.options;
    if (!checkpoint.messageId) return;
    if (phase === 'streaming' && this.lastPublished === text) return;
    this.lastPublished = text;
    this.options.publish({ conversationId: checkpoint.conversationId, companionId: checkpoint.companionId,
      sourceMessageId: checkpoint.sourceMessageId, messageId: checkpoint.messageId, step, attemptId: this.attemptId, text, phase });
  }
  private saveDraft(): void {
    this.saves = this.saves.then(async () => {
      if (this.ownsDraft()) await this.options.save();
    }).catch(error => { this.failure ??= error; });
  }
  private stopTimers(): void {
    this.closed = true;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.eventTimer = undefined; this.saveTimer = undefined;
  }

  /** Wait for older partial saves before committing the completed turn. */
  async complete(): Promise<void> {
    this.stopTimers(); await this.saves;
    if (this.failure) throw this.failure;
  }
  committed(text: string): void { this.publish('committed', text); }

  async stop(phase: 'interrupted' | 'discarded'): Promise<void> {
    this.stopTimers(); await this.saves;
    if (this.ownsDraft()) {
      if (phase === 'discarded') delete this.options.checkpoint.draft;
      await this.options.save();
    }
    this.publish(phase, phase === 'discarded' ? '' : this.text);
    if (this.failure) throw this.failure;
  }
}
