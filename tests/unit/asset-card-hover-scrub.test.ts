import { describe, expect, it, vi } from "vitest";

import {
  applyCardHoverScrubToMedia,
  CARD_HOVER_SCRUB_MOVE_THRESHOLD_PX,
  CARD_HOVER_SCRUB_SETTLE_MS,
  cardHoverScrubRatioFromClientX,
  isSignificantHoverScrubMove,
  resolveCardHoverScrubIntent,
  shouldShowCardHoverPlayhead,
} from "../../src/renderer/asset-card-hover-scrub";

describe("cardHoverScrubRatioFromClientX", () => {
  it("maps 75% of the media width to 0.75", () => {
    expect(
      cardHoverScrubRatioFromClientX(175, { left: 100, width: 100 }),
    ).toBe(0.75);
  });

  it("clamps past the left and right edges", () => {
    expect(cardHoverScrubRatioFromClientX(80, { left: 100, width: 100 })).toBe(0);
    expect(cardHoverScrubRatioFromClientX(240, { left: 100, width: 100 })).toBe(1);
  });
});

describe("resolveCardHoverScrubIntent", () => {
  it("stays in seek while the pointer is still moving or settling", () => {
    expect(
      resolveCardHoverScrubIntent({ significantMove: true, idleMs: 0 }),
    ).toBe("seek");
    expect(
      resolveCardHoverScrubIntent({
        significantMove: false,
        idleMs: CARD_HOVER_SCRUB_SETTLE_MS - 1,
      }),
    ).toBe("seek");
  });

  it("starts playback after 500ms without a significant move", () => {
    expect(
      resolveCardHoverScrubIntent({
        significantMove: false,
        idleMs: CARD_HOVER_SCRUB_SETTLE_MS,
      }),
    ).toBe("play");
  });
});

describe("isSignificantHoverScrubMove", () => {
  it("ignores jitter below the threshold", () => {
    expect(
      isSignificantHoverScrubMove(CARD_HOVER_SCRUB_MOVE_THRESHOLD_PX - 1),
    ).toBe(false);
    expect(
      isSignificantHoverScrubMove(CARD_HOVER_SCRUB_MOVE_THRESHOLD_PX),
    ).toBe(true);
  });
});

describe("shouldShowCardHoverPlayhead", () => {
  it("shows the playhead only while scrubbing", () => {
    expect(shouldShowCardHoverPlayhead("seek")).toBe(true);
    expect(shouldShowCardHoverPlayhead("play")).toBe(false);
  });
});

describe("applyCardHoverScrubToMedia", () => {
  it("pauses and seeks to 75% of a 40s clip", () => {
    const media = {
      currentTime: 0,
      duration: 40,
      paused: true,
      pause: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
    };
    applyCardHoverScrubToMedia(media, { ratio: 0.75, intent: "seek" });
    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.currentTime).toBe(30);
    expect(media.play).not.toHaveBeenCalled();
  });

  it("starts playback from the scrubbed time once settled", () => {
    const play = vi.fn(() => Promise.resolve());
    const media = {
      currentTime: 30,
      duration: 40,
      paused: true,
      pause: vi.fn(),
      play,
    };
    applyCardHoverScrubToMedia(media, { ratio: 0.75, intent: "play" });
    expect(play).toHaveBeenCalledOnce();
    expect(media.pause).not.toHaveBeenCalled();
  });
});
