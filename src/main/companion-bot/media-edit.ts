import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { botMediaTextFormat, BOT_MEDIA_PREVIEW_MAX_BYTES, BOT_TEXT_EDIT_BYTES, imageCropArea, type AttachmentEdit, type BotMediaRef, type ImageEdit } from '../../shared/companion-bot-media';

const run = promisify(execFile);
export function editedExtension(ref: BotMediaRef, edit: AttachmentEdit) {
  const name = ref.originalName || ref.name;
  if (ref.size > BOT_MEDIA_PREVIEW_MAX_BYTES || ref.analysisBlocked || ref.previewEligibility === 'external-only') throw Error('附件超过编辑上限。');
  if (edit.kind === 'text' && botMediaTextFormat({ name, mimeType: ref.mimeType }) && ref.size <= BOT_TEXT_EDIT_BYTES) return path.extname(name);
  if (edit.kind === 'image' && ref.mimeType.startsWith('image/')) return '.png';
  if (edit.kind === 'clip' && ref.mimeType.startsWith('audio/')) return '.m4a';
  if (edit.kind === 'clip' && ref.mimeType.startsWith('video/')) return '.webm';
  throw Error('此附件不支持该编辑操作。');
}

async function exportImage(source: string, destination: string, edit: ImageEdit) {
  // Resolve EXIF orientation before computing the crop in displayed coordinates.
  const { data, info } = await sharp(await readFile(source), { page: 0, pages: 1, limitInputPixels: 48_000_000 })
    .autoOrient().ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const crop = imageCropArea(info.width, info.height, edit);
  // libvips can reorder flip and extract in a single pipeline. Materialize the
  // crop so the exported transform always matches the on-screen transform.
  const pixels = crop.width === info.width && crop.height === info.height ? { data, info }
    : await sharp(data, { raw: info }).extract(crop).raw().toBuffer({ resolveWithObject: true });
  await sharp(pixels.data, { raw: pixels.info }).flop(edit.mirror).rotate(edit.turns * 90).png().toFile(destination);
}

export async function exportAttachment(source: { ref: BotMediaRef; path: string }, edit: AttachmentEdit, destination: string, ffmpeg?: string, signal?: AbortSignal) {
  const ext = editedExtension(source.ref, edit);
  if (path.extname(destination).toLowerCase() !== ext.toLowerCase()) throw Error('请使用 ' + ext + ' 扩展名保存副本。');
  const temp = path.join(path.dirname(destination), '.worldlinebox-' + randomUUID() + ext);
  try {
    signal?.throwIfAborted();
    if (edit.kind === 'text') {
      if (Buffer.byteLength(edit.content) > BOT_TEXT_EDIT_BYTES) throw Error('文本副本超过 2 MiB。');
      await writeFile(temp, edit.content, { flag: 'wx', encoding: 'utf8' });
    } else if (edit.kind === 'image') {
      await exportImage(source.path, temp, edit);
    } else {
      if (!ffmpeg) throw Error('找不到用于导出片段的 FFmpeg。');
      const encoding = ext === '.m4a' ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k']
        : ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '6', '-b:v', '3M', '-c:a', 'libopus'];
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-abort_on', 'empty_output',
        '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,wav,mp3,ogg,flac,aac,avi,mpeg,mpegts,asf,aiff',
        '-ss', String(edit.start), '-i', source.path, '-t', String(edit.end - edit.start), '-map_metadata', '-1', '-map_chapters', '-1',
        ...encoding, temp], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 65536, signal })
        .catch(() => { throw Error('片段导出失败，请检查时间范围和媒体编码。'); });
    }
    signal?.throwIfAborted();
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true });
  }
}

