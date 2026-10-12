import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import {
  applyCardHoverScrubToMedia,
  CARD_HOVER_SCRUB_SETTLE_MS,
  cardHoverScrubRatioFromClientX,
  isSignificantHoverScrubMove,
  shouldShowCardHoverPlayhead,
  type CardHoverScrubIntent,
} from "./asset-card-hover-scrub";
import { playheadLeftPercent } from "./audio-waveform-timeline";

function resolvePointerRoot(host: HTMLElement | null): HTMLElement | null {
  return host?.closest(".asset-card") ?? host;
}

/**
 * Hover preview on browse cards: pointer X seeks the timeline; after 500ms
 * of little movement, playback starts and the playhead hides.
 */
export function useCardHoverScrub(input: {
  enabled: boolean;
  hostRef: RefObject<HTMLElement | null>;
  mediaRef: RefObject<HTMLMediaElement | null>;
}): {
  playheadPercent: number;
  showPlayhead: boolean;
} {
  const { enabled, hostRef, mediaRef } = input;
  const lastClientXRef = useRef<number | null>(null);
  const [ratio, setRatio] = useState(0);
  const [intent, setIntent] = useState<CardHoverScrubIntent>("seek");

  useLayoutEffect(() => {
    const root = resolvePointerRoot(hostRef.current);
    if (!root) return;
    const remember = (event: PointerEvent) => {
      lastClientXRef.current = event.clientX;
    };
    root.addEventListener("pointermove", remember);
    root.addEventListener("pointerenter", remember);
    return () => {
      root.removeEventListener("pointermove", remember);
      root.removeEventListener("pointerenter", remember);
    };
  }, [hostRef]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let lastSignificantX = lastClientXRef.current;
    let currentRatio = 0;
    let currentIntent: CardHoverScrubIntent = "seek";
    let settleTimer = 0;

    const apply = (nextIntent: CardHoverScrubIntent, nextRatio: number) => {
      currentRatio = nextRatio;
      currentIntent = nextIntent;
      setRatio(nextRatio);
      setIntent(nextIntent);
      const media = mediaRef.current;
      if (media) {
        applyCardHoverScrubToMedia(media, {
          ratio: nextRatio,
          intent: nextIntent,
        });
      }
    };

    const seekFromClientX = (clientX: number) => {
      const host = hostRef.current;
      if (!host) return;
      const nextRatio = cardHoverScrubRatioFromClientX(
        clientX,
        host.getBoundingClientRect(),
      );
      apply("seek", nextRatio);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        apply("play", currentRatio);
      }, CARD_HOVER_SCRUB_SETTLE_MS);
    };

    const onPointer = (event: PointerEvent) => {
      const clientX = event.clientX;
      lastClientXRef.current = clientX;
      const significant =
        lastSignificantX === null ||
        isSignificantHoverScrubMove(clientX - lastSignificantX);
      if (!significant) return;
      lastSignificantX = clientX;
      seekFromClientX(clientX);
    };

    const onMeta = () => {
      apply(currentIntent, currentRatio);
    };

    const root = resolvePointerRoot(hostRef.current);
    root?.addEventListener("pointermove", onPointer);
    root?.addEventListener("pointerenter", onPointer);
    const media = mediaRef.current;
    media?.addEventListener("loadedmetadata", onMeta);

    if (lastClientXRef.current !== null) {
      lastSignificantX = lastClientXRef.current;
      seekFromClientX(lastClientXRef.current);
    }

    return () => {
      window.clearTimeout(settleTimer);
      root?.removeEventListener("pointermove", onPointer);
      root?.removeEventListener("pointerenter", onPointer);
      media?.removeEventListener("loadedmetadata", onMeta);
    };
  }, [enabled, hostRef, mediaRef]);

  return {
    playheadPercent: enabled ? playheadLeftPercent(ratio) : 0,
    showPlayhead: enabled && shouldShowCardHoverPlayhead(intent),
  };
}
