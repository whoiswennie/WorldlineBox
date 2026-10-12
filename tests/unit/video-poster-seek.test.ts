import { describe, expect, it } from "vitest";

import {
  durationSecondsFromProbeStdout,
  videoPosterGeneratorVersion,
  videoPosterSeekSeconds,
} from "../../src/worker/video-poster-seek";

describe("videoPosterSeekSeconds", () => {
  it("seeks to 25% of a normal duration", () => {
    expect(videoPosterSeekSeconds(30)).toBe(7.5);
    expect(videoPosterSeekSeconds(30.05)).toBe(7.513);
    expect(videoPosterSeekSeconds(10)).toBe(2.5);
  });

  it("stays off the final instant and refuses an unknown duration", () => {
    expect(videoPosterSeekSeconds(0.04)).toBe(0);
    expect(videoPosterSeekSeconds(0)).toBeNull();
    expect(videoPosterSeekSeconds(Number.NaN)).toBeNull();
    expect(videoPosterSeekSeconds(-2)).toBeNull();
  });
});

describe("durationSecondsFromProbeStdout", () => {
  it("reads a plain number or ffprobe JSON", () => {
    expect(durationSecondsFromProbeStdout("12.5\n")).toBe(12.5);
    expect(durationSecondsFromProbeStdout(JSON.stringify({
      format: { duration: "30.05" },
    }))).toBe(30.05);
    expect(durationSecondsFromProbeStdout(JSON.stringify({
      streams: [{ codec_type: "video", duration: "8" }],
    }))).toBe(8);
    expect(durationSecondsFromProbeStdout("")).toBeNull();
    expect(durationSecondsFromProbeStdout("not-json")).toBeNull();
  });
});

describe("videoPosterGeneratorVersion", () => {
  it("marks covers so an opening-frame poster is no longer current", () => {
    expect(videoPosterGeneratorVersion("8.1")).toBe("ffmpeg@8.1;poster-seek-25");
  });
});
