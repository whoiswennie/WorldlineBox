import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DSH_TASK_VISUAL_MAX_IMAGES, DSH_TASK_VISUAL_MAX_IMAGE_BYTES, dshTaskVisualInputSchema, type DshTaskVisualInput, type DshTaskVisualManifest } from './task-execution';

/** Decode before connecting to native DSH. Paths never grant file access and
 * payload bytes never become task-prompt prose or archive event text. */
export async function validateDshTaskVisualInputs(values: readonly DshTaskVisualInput[] = []): Promise<DshTaskVisualManifest> {
  if (values.length > DSH_TASK_VISUAL_MAX_IMAGES) throw new Error('Too many observation images in one bounded native message.');
  const manifest: DshTaskVisualManifest = [];
  for (const value of values) {
    const input = dshTaskVisualInputSchema.parse(value), bytes = Buffer.from(input.dataBase64, 'base64');
    if (!bytes.length || bytes.length > DSH_TASK_VISUAL_MAX_IMAGE_BYTES || bytes.toString('base64') !== input.dataBase64
      || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('Trusted observation image bytes or digest are invalid.');
    const image = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning', animated: false }), metadata = await image.metadata();
    const format = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[input.mime];
    if (metadata.format !== format || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error('Trusted observation image MIME or raster dimensions are invalid.');
    await image.stats();
    manifest.push({ mime: input.mime, sha256: input.sha256, source: input.source });
  }
  return manifest;
}
