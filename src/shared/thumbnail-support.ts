/**
 * Whether WorldlineBox should generate or surface raster thumbnail failures for an
 * asset. Text and unknown `other` formats show the generic file icon. Supported
 * image formats are categorized as `image` even when their preview must first
 * be derived by OIIO, so every supported image receives the same card and
 * Inspector thumbnail treatment.
 *
 * `model` counts as thumbnail-capable. FBX/OBJ/glTF/GLB/STL cards are produced
 * by the offscreen GPU renderer (slice E).
 */

import { FBX_CONVERT_ERROR_CODES } from './fbx-conversion';
import { MODEL_THUMBNAIL_ERROR_CODES } from './model-thumbnail-protocol';

export type ThumbnailSupportMediaType =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "model"
  | "document"
  | "font"
  | "other";

export function assetSupportsThumbnail(asset: {
  mediaType: ThumbnailSupportMediaType;
  displayName: string;
}): boolean {
  if (asset.mediaType === "text") return false;
  // Documents (PDF etc.) get a first-page thumbnail; HTML thumbnails render
  // offscreen in Main (WorldlineBox-8ca259).
  if (asset.mediaType === "document") return true;
  // Fonts render a real sample line offscreen (WorldlineBox-485aeb).
  if (asset.mediaType === "font") return true;
  return asset.mediaType !== "other";
}

/**
 * Error codes that mean "no thumbnail expected" rather than a user-actionable
 * failure. Covers:
 * - `UNSUPPORTED_FORMAT` — no generator exists for the format;
 * - MODEL_* — the offscreen render failed (context lost/parse error…);
 *   spec 3D-16 says a failed model thumbnail degrades to the generic 3D icon,
 *   never a failure badge, so these are suppressed exactly like
 *   `UNSUPPORTED_FORMAT`;
 * - FBX_* — the FBX→GLB conversion that must precede a render failed; the
 *   card keeps the generic 3D icon (the viewer still reports the same codes
 *   through its own error surface).
 */
export function isBenignThumbnailErrorCode(errorCode: string | undefined): boolean {
  return (
    errorCode === "UNSUPPORTED_FORMAT"
    || (errorCode !== undefined && MODEL_THUMBNAIL_ERROR_CODES.has(errorCode))
    || (errorCode !== undefined && FBX_CONVERT_ERROR_CODES.has(errorCode))
  );
}
