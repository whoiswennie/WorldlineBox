// WorldlineBox-1d4w: the format filter quick-chips derive from the product format
// registries. These tests pin that every registered extension has a chip and
// that tokens are dotless (they live in a comma field alongside free text).
import { describe, expect, it } from "vitest";

import {
  AUDIO_EXTENSION_NAMES,
  AUDIO_EXTENSIONS,
} from "../../src/shared/audio-media";
import {
  IMAGE_EXTENSIONS,
  MODEL_EXTENSIONS,
  VIDEO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  FONT_EXTENSIONS,
} from "../../src/shared/media-formats";
import {
  FORMAT_FILTER_GROUPS,
  FORMAT_TEXT_TOKEN,
  FORMAT_UNKNOWN_TOKEN,
  OTHER_FORMAT_EXTENSIONS,
} from "../../src/renderer/format-filter-presets";

function allChipTokens(): string[] {
  return [
    ...FORMAT_FILTER_GROUPS.flatMap((group) => [...group.extensions]),
    ...OTHER_FORMAT_EXTENSIONS,
  ];
}

const otherFormatSet = new Set<string>(OTHER_FORMAT_EXTENSIONS);

describe("format-filter-presets", () => {
  it("covers every registered image/video/audio/document/model extension exactly once", () => {
    const chips = allChipTokens();
    const expected = [
      ...IMAGE_EXTENSIONS.map((extension) => extension.slice(1)),
      ...VIDEO_EXTENSIONS.map((extension) => extension.slice(1)),
      ...AUDIO_EXTENSION_NAMES,
      ...MODEL_EXTENSIONS.map((extension) => extension.slice(1)),
      ...DOCUMENT_EXTENSIONS.map((extension) => extension.slice(1)).filter(
        (extension) => !otherFormatSet.has(extension),
      ),
      // WorldlineBox-485aeb: fonts have their own group, no longer 其他.
      ...FONT_EXTENSIONS.map((extension) => extension.slice(1)),
      ...OTHER_FORMAT_EXTENSIONS,
    ];
    expect(new Set(chips)).toEqual(new Set(expected));
    expect(chips.length).toBe(new Set(chips).size);
  });

  it("keeps the font group aligned with the font registry", () => {
    const fontGroup = FORMAT_FILTER_GROUPS.find(
      (group) => group.labelKey === "filter.formatGroupFont",
    );
    expect(fontGroup?.extensions).toEqual(
      FONT_EXTENSIONS.map((extension) => extension.slice(1)),
    );
  });

  it("emits dotless tokens matching the comma-field format", () => {
    for (const token of allChipTokens()) {
      expect(token).not.toMatch(/^\./);
      expect(token).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("keeps the audio group aligned with the audio registry", () => {
    const audioGroup = FORMAT_FILTER_GROUPS.find(
      (group) => group.labelKey === "filter.formatGroupAudio",
    );
    expect(audioGroup?.extensions).toEqual(
      AUDIO_EXTENSIONS.map((extension) => extension.slice(1)),
    );
  });

  it("keeps JFIF and AVIF in the image filter group", () => {
    const imageGroup = FORMAT_FILTER_GROUPS.find(
      (group) => group.labelKey === "filter.formatGroupImage",
    );
    expect(imageGroup?.extensions).toContain("jfif");
    expect(imageGroup?.extensions).toContain("avif");
  });

  it("ships the special text token separately from extension groups", () => {
    expect(FORMAT_TEXT_TOKEN).toBe("text");
    expect(allChipTokens()).not.toContain(FORMAT_TEXT_TOKEN);
  });

  it("keeps HTML, HDF, and HTM in the miscellaneous-format group", () => {
    const documentGroup = FORMAT_FILTER_GROUPS.find(
      (group) => group.labelKey === "filter.formatGroupDocument",
    );
    expect(documentGroup?.extensions).toEqual(["pdf"]);
    expect(OTHER_FORMAT_EXTENSIONS).toEqual(["html", "hdf", "htm"]);
    expect(FORMAT_UNKNOWN_TOKEN).toBe("unknown");
    expect(allChipTokens()).not.toContain(FORMAT_UNKNOWN_TOKEN);
  });
});
