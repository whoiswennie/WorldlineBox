/** Playback is streamed with byte ranges; very large originals open in a system app. */
export const COMPANION_MEDIA_PREVIEW_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const COMPANION_IMAGE_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;
/** Larger attachments stay registered local references, without whole-file buffering. */
export const COMPANION_ATTACHMENT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
