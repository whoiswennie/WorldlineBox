import {
  scrubRatioFromClientX,
  scrubTimeFromRatio,
} from "./video-player-controls";

/** After a seek, wait this long with little pointer motion before playing. */
export const CARD_HOVER_SCRUB_SETTLE_MS = 500;

/** Pointer travel below this (px) does not count as a new scrub. */
export const CARD_HOVER_SCRUB_MOVE_THRESHOLD_PX = 6;

export type CardHoverScrubIntent = "seek" | "play";

export type CardHoverScrubMedia = {
  currentTime: number;
  duration: number;
  paused: boolean;
  pause(): void;
  play(): Promise<void> | void;
};

/** Horizontal position on the card media box → 0..1 timeline ratio. */
export function cardHoverScrubRatioFromClientX(
  clientX: number,
  media: { left: number; width: number },
): number {
  return scrubRatioFromClientX(clientX, media);
}

export function isSignificantHoverScrubMove(
  deltaPx: number,
  thresholdPx: number = CARD_HOVER_SCRUB_MOVE_THRESHOLD_PX,
): boolean {
  return Math.abs(deltaPx) >= thresholdPx;
}

/**
 * Moving the pointer seeks and shows the playhead. After `settleMs` without
 * a significant move, playback starts from that ratio and the playhead hides.
 */
export function resolveCardHoverScrubIntent(input: {
  significantMove: boolean;
  idleMs: number;
  settleMs?: number;
}): CardHoverScrubIntent {
  if (input.significantMove) return "seek";
  if (input.idleMs >= (input.settleMs ?? CARD_HOVER_SCRUB_SETTLE_MS)) {
    return "play";
  }
  return "seek";
}

export function shouldShowCardHoverPlayhead(intent: CardHoverScrubIntent): boolean {
  return intent === "seek";
}

export function applyCardHoverScrubToMedia(
  media: CardHoverScrubMedia,
  input: { ratio: number; intent: CardHoverScrubIntent },
): void {
  const time = scrubTimeFromRatio(input.ratio, media.duration);
  if (input.intent === "seek") {
    media.pause();
    media.currentTime = time;
    return;
  }
  if (Math.abs(media.currentTime - time) > 0.05) {
    media.currentTime = time;
  }
  if (media.paused) {
    void Promise.resolve(media.play()).catch(() => undefined);
  }
}
