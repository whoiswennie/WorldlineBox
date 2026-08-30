import { access } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Contract for video executables.
 */
export interface VideoExecutables {
  ffmpeg: string
  ffprobe: string
  ffplay: string
  ytDlp: string
}

const SOURCE_TOOLS = fileURLToPath(new URL('../../../../resources/tools/', import.meta.url))

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function bundledExecutables(root: string): Promise<VideoExecutables | undefined> {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const ffmpegRoot = join(root, 'ffmpeg', process.platform === 'win32' ? 'windows-x64' : `${process.platform}-${process.arch}`)
  const ytRoot = join(root, 'yt-dlp', process.platform === 'win32' ? 'windows-x64' : `${process.platform}-${process.arch}`)
  const tools = {
    ffmpeg: join(ffmpegRoot, `ffmpeg${suffix}`),
    ffprobe: join(ffmpegRoot, `ffprobe${suffix}`),
    ffplay: join(ffmpegRoot, `ffplay${suffix}`),
    ytDlp: join(ytRoot, `yt-dlp${suffix}`),
  }
  return (await Promise.all(Object.values(tools).map(exists))).every(Boolean) ? tools : undefined
}

/**
 *  Locate packaged tools first and explicitly fall back to the host PATH.
 * @param ctx - Cordis context that owns the operation.
 * @param signal - Cancellation signal for the operation.
 * @returns The resulting value.
 */
export async function resolveVideoExecutables(ctx: Context, signal?: AbortSignal): Promise<VideoExecutables> {
  const configured = process.env.WORLDLINE_VIDEO_TOOLS_DIR?.trim()
  const roots = [configured, SOURCE_TOOLS, resolve(process.cwd(), 'resources', 'tools')]
    .filter((value): value is string => value !== undefined && value.length > 0)
  for (const root of roots) {
    const tools = await bundledExecutables(root)
    if (tools !== undefined) return tools
  }
  const [ffmpeg, ffprobe, ffplay, ytDlp] = await Promise.all([
    ctx.subprocess.resolveExecutable(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', undefined, signal),
    ctx.subprocess.resolveExecutable(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe', undefined, signal),
    ctx.subprocess.resolveExecutable(process.platform === 'win32' ? 'ffplay.exe' : 'ffplay', undefined, signal),
    ctx.subprocess.resolveExecutable(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', undefined, signal),
  ])
  return { ffmpeg, ffprobe, ffplay, ytDlp }
}

/**
 *  PATH value suitable for yt-dlp's FFmpeg discovery without global mutation.
 * @param tools - tools value.
 * @returns The resulting value.
 */
export function pathWithBundledTools(tools: VideoExecutables): string {
  const entries = [dirname(tools.ffmpeg), dirname(tools.ytDlp), process.env.PATH ?? '']
  return entries.filter(Boolean).join(delimiter)
}

/**
 *  Reject ambiguous or unsafe source spellings at the tool boundary.
 * @param source - source value.
 * @returns The resulting value.
 */
export function classifySource(source: string): 'local' | 'online' {
  if (/^https?:\/\//iu.test(source)) return 'online'
  if (isAbsolute(source)) return 'local'
  throw new Error('source must be an absolute local path or an HTTP(S) URL')
}
