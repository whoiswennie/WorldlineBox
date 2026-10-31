import type { CompanionReplyProgress } from '../../shared/companion-reply-progress';
import type { CompanionModelUsage } from '../../shared/companion-model-usage';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../shared/companions';

type UsageScope = Pick<CompanionReplyStreamEvent, 'conversationId' | 'companionId' | 'sourceMessageId'>;
export interface CompanionReplySnapshot { readonly overlays: readonly CompanionReplyStreamEvent[]; readonly discarded: ReadonlySet<string>; readonly progress?: CompanionReplyProgress; readonly modelUsage?: CompanionModelUsage; readonly usageScope?: UsageScope }
const EMPTY_SNAPSHOT: CompanionReplySnapshot = { overlays: [], discarded: new Set() };
interface Entry { frames: Map<number, CompanionReplyStreamEvent>; discarded: Set<string>; snapshot: CompanionReplySnapshot; progress?: CompanionReplyProgress; modelUsage?: CompanionModelUsage; usageScope?: UsageScope }
function usageMatches(message: CompanionMessage, scope: UsageScope): boolean {
  return message.conversationId === scope.conversationId && message.authorId === scope.companionId
    && (message.replyToId ?? message.replyProgress?.sourceMessageId) === scope.sourceMessageId;
}
export function projectCompanionModelUsage(message: CompanionMessage | undefined, snapshot: CompanionReplySnapshot): CompanionModelUsage | undefined {
  if (!message || message.sourceUnavailable || message.audience === 'agenda') return undefined;
  return snapshot.modelUsage && snapshot.usageScope && usageMatches(message, snapshot.usageScope)
    && snapshot.modelUsage.revision > (message.modelUsage?.revision ?? 0) ? snapshot.modelUsage : message.modelUsage;
}
/** A host-cleared completed step can retain real tool identities while its
 * old prose is no longer publishable. A live cursor at another/later step is
 * not permission for stale committed IPC to restore that withdrawn prose. */
function hostClearedStep(message: CompanionMessage | undefined, step: number): boolean {
  return !!message && message.segments?.[step]?.text === '' && message.replyDraft?.step !== step
    && (!message.replyDraft || step < message.replyDraft.step);
}

/** One IPC subscription, with notifications only for the bubble being changed. */
export class CompanionReplyStreamStore {
  private readonly entries = new Map<string, Entry>();
  private readonly messages = new Map<string, CompanionMessage>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly retired = new Set<string>();
  private readonly finished = new Set<string>();
  snapshot = (id: string): CompanionReplySnapshot => this.entries.get(id)?.snapshot ?? EMPTY_SNAPSHOT;
  subscribe = (id: string, listener: () => void) => {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  };
  private retire(event: CompanionReplyStreamEvent) {
    this.retired.add(event.messageId + '/' + event.attemptId);
    while (this.retired.size > 1024) this.retired.delete(this.retired.values().next().value!);
  }
  private publish(id: string, entry: Entry) {
    entry.snapshot = { overlays: [...entry.frames.values()].sort((a, b) => a.step - b.step), discarded: new Set(entry.discarded), progress: entry.progress, modelUsage: entry.modelUsage, usageScope: entry.usageScope };
    for (const listener of this.listeners.get(id) ?? []) listener();
    while (this.entries.size > 128) {
      const oldest = this.entries.keys().next().value!;
      if (oldest === id) break;
      this.entries.delete(oldest);
    }
  }
  accept(event: CompanionReplyStreamEvent) {
    const message = this.messages.get(event.messageId);
    if (message && (message.conversationId !== event.conversationId || message.authorId !== event.companionId || (message.replyToId ?? message.replyProgress?.sourceMessageId) !== undefined && (message.replyToId ?? message.replyProgress?.sourceMessageId) !== event.sourceMessageId)) return;
    let entry = this.entries.get(event.messageId);
    if (!entry) { entry = { frames: new Map(), discarded: new Set(), snapshot: EMPTY_SNAPSHOT }; this.entries.set(event.messageId, entry); }
    // Usage has its own host revision and never becomes a prose overlay, even
    // when a final provider report arrives after the final text was committed.
    if (event.modelUsage && event.modelUsage.revision > (entry.modelUsage?.revision ?? message?.modelUsage?.revision ?? 0)) {
      entry.modelUsage = event.modelUsage;
      entry.usageScope = { conversationId: event.conversationId, companionId: event.companionId, sourceMessageId: event.sourceMessageId };
      this.publish(event.messageId, entry);
    }
    if (event.phase === 'usage') return;
    if (event.phase === 'progress') {
      if (!event.progress || event.progress.revision <= (entry.progress?.revision ?? message?.replyProgress?.revision ?? 0)) return;
      entry.progress = event.progress; this.publish(event.messageId, entry); return;
    }
    if (hostClearedStep(message, event.step)) { this.retire(event); return; }
    if (this.finished.has(event.messageId) || this.retired.has(event.messageId + '/' + event.attemptId)) return;
    const previous = entry.frames.get(event.step);
    if (event.phase === 'discarded') {
      this.retire(event); entry.discarded.add(event.attemptId);
      if (previous?.attemptId === event.attemptId) entry.frames.delete(event.step);
      this.publish(event.messageId, entry); return;
    }
    if (previous?.attemptId === event.attemptId) {
      if (event.phase === 'streaming' && (previous.phase !== 'streaming' || previous.text.length > event.text.length)) return;
      if (previous.text === event.text && previous.phase === event.phase) return;
    } else if (previous) { this.retire(previous); entry.discarded.add(previous.attemptId); }
    if (event.phase === 'committed' && message?.segments?.[event.step]?.text === event.text && message.replyDraft?.step !== event.step) {
      this.retire(event); entry.frames.delete(event.step);
    } else entry.frames.set(event.step, event);
    this.publish(event.messageId, entry);
  }
  reconcile(messages: readonly CompanionMessage[]) {
    for (const message of messages) {
      this.messages.set(message.id, message);
      // Initial placeholders have no completed segments. A real published
      // snapshot takes precedence even if its terminal IPC frame arrives late.
      const finished = message.isReplyDraft !== true && !message.replyDraft && !!message.segments?.length;
      if (finished) { this.finished.add(message.id); while (this.finished.size > 256) this.finished.delete(this.finished.values().next().value!); }
      let entry = this.entries.get(message.id);
      if (!entry && (message.replyProgress || message.modelUsage)) { entry = { frames: new Map(), discarded: new Set(), snapshot: EMPTY_SNAPSHOT }; this.entries.set(message.id, entry); }
      if (!entry) continue;
      let changed = false;
      if (entry.usageScope && !usageMatches(message, entry.usageScope)) { entry.modelUsage = undefined; entry.usageScope = undefined; changed = true; }
      if (message.modelUsage && message.modelUsage.revision > (entry.modelUsage?.revision ?? 0)) {
        entry.modelUsage = message.modelUsage;
        entry.usageScope = { conversationId: message.conversationId, companionId: message.authorId, sourceMessageId: message.replyToId ?? message.replyProgress?.sourceMessageId ?? '' };
        changed = true;
      }
      if (message.replyProgress && message.replyProgress.revision > (entry.progress?.revision ?? 0)) { entry.progress = message.replyProgress; changed = true; }
      for (const [step, frame] of entry.frames) {
        const committed = frame.phase === 'committed' && message.segments?.[step]?.text === frame.text && message.replyDraft?.step !== step;
        if (committed || finished || hostClearedStep(message, step)) { entry.frames.delete(step); this.retire(frame); changed = true; }
      }
      if (changed) this.publish(message.id, entry);
    }
    while (this.messages.size > 256) this.messages.delete(this.messages.keys().next().value!);
  }
}

/** Progress-only readers must not copy every reply segment on each clock tick. */
export function projectCompanionReplyProgress(message: CompanionMessage, snapshot: CompanionReplySnapshot): CompanionReplyProgress | undefined {
  if (message.sourceUnavailable) return undefined;
  return snapshot.progress && snapshot.progress.revision > (message.replyProgress?.revision ?? 0) ? snapshot.progress : message.replyProgress;
}

export function projectCompanionReply(message: CompanionMessage, snapshot: CompanionReplySnapshot) {
  if (message.sourceUnavailable) return { segments: [], phase: undefined, progress: undefined };
  const progress = projectCompanionReplyProgress(message, snapshot);
  const segments = message.segments?.map(segment => ({ ...segment }));
  if (!snapshot.overlays.length && (!message.replyDraft || !snapshot.discarded.has(message.replyDraft.attemptId))) return { segments, phase: undefined, progress };
  const projected = segments ?? (message.content ? [{ text: message.content, actionIds: [] }] : []);
  if (message.replyDraft && snapshot.discarded.has(message.replyDraft.attemptId) && projected[message.replyDraft.step]) projected[message.replyDraft.step] = { ...projected[message.replyDraft.step]!, text: '' };
  for (const frame of snapshot.overlays) {
    if (hostClearedStep(message, frame.step)) continue;
    while (projected.length <= frame.step) projected.push({ text: '', actionIds: [] });
    projected[frame.step] = { ...projected[frame.step]!, text: frame.text };
  }
  const phase = snapshot.overlays.some(frame => frame.phase === 'streaming') ? 'streaming' : snapshot.overlays.some(frame => frame.phase === 'interrupted') ? 'interrupted' : undefined;
  return { segments: projected, phase, progress };
}
