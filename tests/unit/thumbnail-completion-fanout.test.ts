import { describe, expect, it, vi } from "vitest";

import type { ThumbnailEvent } from "../../src/shared/protocol/responses";
import {
  OFFSCREEN_THUMBNAIL_BATCH_LIMIT,
  ThumbnailCompletionFanout,
} from "../../src/shared/thumbnail-completion-fanout";

describe("ThumbnailCompletionFanout", () => {
  it("publishes visible completions immediately and batches the rest", () => {
    vi.useFakeTimers();
    const published: ThumbnailEvent[] = [];
    const fanout = new ThumbnailCompletionFanout({
      publish: (event) => published.push(event),
      delayMs: 75,
    });
    fanout.setImmediateAssetIds("lib-1", ["visible-1"]);

    fanout.publishReady({
      libraryId: "lib-1",
      assetId: "visible-1",
      artifactId: "art-visible",
    });
    for (let index = 0; index < 250; index += 1) {
      fanout.publishReady({
        libraryId: "lib-1",
        assetId: `off-${index}`,
        artifactId: `art-${index}`,
      });
    }

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "asset.thumbnail.ready",
      assetId: "visible-1",
    });

    vi.advanceTimersByTime(75);
    const batches = published.filter((event) => event.type === "asset.thumbnail.batch-ready");
    expect(batches).toHaveLength(3);
    expect(batches.every((event) => event.type === "asset.thumbnail.batch-ready" && event.ready.length <= OFFSCREEN_THUMBNAIL_BATCH_LIMIT)).toBe(true);
    expect(
      batches.reduce((sum, event) => sum + (event.type === "asset.thumbnail.batch-ready" ? event.completedCount : 0), 0),
    ).toBe(250);
    fanout.dispose();
    vi.useRealTimers();
  });

  it("promotes queued completions when they enter the visible set", () => {
    vi.useFakeTimers();
    const published: ThumbnailEvent[] = [];
    const fanout = new ThumbnailCompletionFanout({
      publish: (event) => published.push(event),
      delayMs: 75,
    });
    fanout.publishReady({
      libraryId: "lib-1",
      assetId: "soon-visible",
      artifactId: "art-1",
    });
    expect(published).toHaveLength(0);
    fanout.setImmediateAssetIds("lib-1", ["soon-visible"]);
    expect(published).toEqual([
      expect.objectContaining({
        type: "asset.thumbnail.ready",
        assetId: "soon-visible",
      }),
    ]);
    vi.advanceTimersByTime(75);
    expect(published).toHaveLength(1);
    fanout.dispose();
    vi.useRealTimers();
  });

  it("drops a pending batch after the library is cleared", () => {
    vi.useFakeTimers();
    const published: ThumbnailEvent[] = [];
    const fanout = new ThumbnailCompletionFanout({
      publish: (event) => published.push(event),
      delayMs: 75,
    });
    fanout.publishReady({
      libraryId: "lib-1",
      assetId: "off-1",
      artifactId: "art-1",
    });
    fanout.clear("lib-1");
    vi.advanceTimersByTime(75);
    expect(published).toHaveLength(0);
    fanout.dispose();
    vi.useRealTimers();
  });
});
