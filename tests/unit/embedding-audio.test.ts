import { describe, expect, it } from "vitest";

import { embeddingAudioFfmpegArgs } from "../../src/main/embedding-audio";
import { embeddingAudioRequestBody } from "../../src/main/embedding-llama-session";
import {
  clipEmbeddingDocument,
  formatEmbeddingDocument,
  meanPoolEmbeddings,
} from "../../src/shared/embedding/profile";

describe("embedding audio and documents", () => {
  it("asks llama-server for a wav content block", () => {
    expect(embeddingAudioRequestBody("abc")).toEqual({
      model: "embeddinggemma-2",
      input: [{
        content: [{
          type: "input_audio",
          input_audio: { data: "abc", format: "wav" },
        }],
      }],
    });
  });

  it("converts audio to mono 16 kHz windows", () => {
    expect(embeddingAudioFfmpegArgs({
      sourcePath: "take.wav",
      outputPattern: "window-%03d.wav",
    })).toEqual([
      "-hide_banner",
      "-loglevel", "error",
      "-nostdin",
      "-y",
      "-i", "take.wav",
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      "-f", "segment",
      "-segment_time", "120",
      "-reset_timestamps", "1",
      "window-%03d.wav",
    ]);
  });

  it("averages normalized windows and normalizes the result", () => {
    const pooled = meanPoolEmbeddings([[1, 0], [0, 1]]);
    expect(pooled[0]).toBeCloseTo(Math.SQRT1_2);
    expect(pooled[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it("wraps a document with its file name and keeps a leading slice", () => {
    expect(formatEmbeddingDocument("notes.md", "hello")).toBe("title: notes.md | text: hello");
    expect(clipEmbeddingDocument(` ${"a".repeat(10)}\n`, 4)).toBe("aaaa");
  });
});
