import { AUDIO_EXTENSIONS } from "./audio-media";
import {
  DOCUMENT_EXTENSIONS,
  FONT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MODEL_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from "./media-formats";
import { TEXT_EXTENSIONS } from "./text-media";

/**
 * Dotless extensions WorldlineBox classifies as a known media type
 * (`detectMediaType` ≠ `other`). Used by the format-filter 「其他」 token.
 */
export function knownProductFormatExtensionsDotless(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const extension of [
    ...IMAGE_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
    ...MODEL_EXTENSIONS,
    ...DOCUMENT_EXTENSIONS,
    ...FONT_EXTENSIONS,
    ...AUDIO_EXTENSIONS,
    ...TEXT_EXTENSIONS,
  ]) {
    const bare = extension.slice(1).toLowerCase();
    if (seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}
