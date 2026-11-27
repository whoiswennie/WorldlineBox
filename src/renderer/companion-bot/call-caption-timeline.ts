import { botCallMotionId, type BotCallCue, type BotCallModelCatalog } from '../../shared/companion-call';
import { callCaptionHoldMs, callCaptionPlaybackPages, type CallCaptionPage } from '../../shared/companion-call-captions';

export const CALL_CAPTION_HISTORY_PAGES = 128;
export interface CallBeat { id: string; messageId: string; partId?: string; sequence: number; text: string; cue: BotCallCue }
interface PlaybackPage extends CallCaptionPage { beat: CallBeat; speechPage: number; hold: number }
export interface CaptionTimeline { first: number; pages: PlaybackPage[]; snapshotBeats: Set<string> }

export function appendCallCaptions(previous: CaptionTimeline, incoming: readonly CallBeat[], catalog?: BotCallModelCatalog): CaptionTimeline {
  const snapshotBeats = new Set<string>();
  const retained = new Set(previous.pages.map(page => page.beat.id));
  let { first, pages } = previous;
  for (const beat of incoming) {
    const seen = previous.snapshotBeats.has(beat.id) || retained.has(beat.id) || snapshotBeats.has(beat.id);
    snapshotBeats.add(beat.id);
    if (seen) continue;
    const added = callCaptionPlaybackPages(beat.text, beat.partId).map((page, speechPage) => ({
      ...page, beat, speechPage, hold: callCaptionHoldMs(page.text),
    }));
    if (!added.length) continue;
    const motion = catalog?.motions.find(item => botCallMotionId(item) === beat.cue.motion);
    const readingTime = added.reduce((total, page) => total + page.hold, 0);
    const minimum = Math.max(beat.cue.durationMs ?? 0, (motion?.duration ?? 0) * 1000, beat.cue.expression ? 1800 : 0, beat.cue.gesture ? 900 : 0);
    added[added.length - 1]!.hold += Math.max(0, minimum - readingTime);
    const discarded = Math.max(0, pages.length + added.length - CALL_CAPTION_HISTORY_PAGES);
    first += discarded;
    pages = [...pages.slice(discarded), ...added.slice(-CALL_CAPTION_HISTORY_PAGES)];
  }
  return { first, pages, snapshotBeats };
}
