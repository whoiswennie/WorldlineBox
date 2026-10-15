import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { companionAvatarCropRequestSchema, type CompanionAvatarCropRequest } from '../../shared/companion-avatar-crop';
import type { CompanionAttachment } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

/** Crop geometry uses the EXIF-normalized image after the user's quarter-turn rotation. */
export async function cropCompanionAvatar(options: { root: string; request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }, input: CompanionAvatarCropRequest): Promise<CompanionAttachment[]> {
  const args = companionAvatarCropRequestSchema.parse(input);
  const registered = (await options.request({ type: 'attachment.get', id: args.attachmentId })).storedAttachment;
  if (!registered || registered.sourcePath || registered.attachment.path || !/^image\/(?:png|jpeg|webp|gif)$/u.test(registered.attachment.mime)) throw new Error('头像裁剪需要已导入的图片副本，请重新选择图片。');
  const root = await realpath(options.root), entry = path.resolve(root, registered.relativePath), file = await realpath(entry), info = await lstat(entry);
  if (!info.isFile() || info.isSymbolicLink() || path.dirname(file) !== path.join(root, 'attachments') || info.size > 20 * 1024 * 1024) throw new Error('头像图片不可读取或超过 20 MiB。');
  const bytes = await readFile(file);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('头像图片超过 20 MiB。');
  let output: Buffer;
  try {
    const pipeline = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024, failOn: 'warning', animated: false });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw new Error();
    let width = metadata.width, height = metadata.height;
    if ([5, 6, 7, 8].includes(metadata.orientation ?? 1)) [width, height] = [height, width];
    if (args.crop.rotation % 180) [width, height] = [height, width];
    const side = Math.max(1, Math.min(width, height, Math.round(Math.min(width, height) / args.crop.zoom)));
    const left = Math.max(0, Math.min(width - side, Math.round(args.crop.centerX * width - side / 2)));
    const top = Math.max(0, Math.min(height - side, Math.round(args.crop.centerY * height - side / 2)));
    output = await pipeline.autoOrient().rotate(args.crop.rotation).extract({ left, top, width: side, height: side })
      .resize(512, 512).png().toBuffer();
  } catch { throw new Error('图片无法完整裁剪，请选择可读取且不超过 64M 像素的 PNG、JPEG、WebP 或 GIF。'); }
  const directory = path.join(root, 'attachments'); await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory || (await lstat(directory)).isSymbolicLink()) throw new Error('头像存储目录不属于应用管理目录。');
  const id = randomUUID(), relativePath = `attachments/${id}.png`, destination = path.join(root, relativePath), temporary = destination + '.tmp';
  try { await writeFile(temporary, output, { flag: 'wx' }); await rename(temporary, destination); }
  finally { await unlink(temporary).catch(() => undefined); }
  const attachment: CompanionAttachment = { id, name: path.parse(registered.attachment.name).name.slice(0, 220) + '-头像.png', mime: 'image/png', size: output.length };
  const response = await options.request({ type: 'attachment.register', stored: { attachment, relativePath } });
  if (!response.ok || response.storedAttachment?.attachment.id !== id) throw new Error('裁剪头像未能保存，请重试。');
  return [{ ...attachment, url: 'worldlinebox-companion://attachment/' + id }];
}
