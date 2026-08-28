import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { worldlineHomePath } from '@deepseek-ai/dsh-home-paths'
import { captionsForRange, readCaptionFiles } from './captions.ts'
import { requireSuccess, runCommand } from './process.ts'
import { classifySource, pathWithBundledTools, resolveVideoExecutables } from './resolver.ts'
import type { VideoChapter, VideoManifest, VideoProbe } from './types.ts'

interface ProbeStream {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  tags?: Record<string, string>
}

interface FfprobeDocument {
  format?: { filename?: string; duration?: string; tags?: Record<string, string> }
  streams?: ProbeStream[]
  chapters?: Array<{ start_time?: string; end_time?: string; tags?: Record<string, string> }>
  frames?: Array<{ best_effort_timestamp_time?: string; pkt_pts_time?: string }>
}

interface YtDlpDocument {
  title?: string
  duration?: number
  width?: number
  height?: number
  vcodec?: string
  acodec?: string
  uploader?: string
  webpage_url?: string
  chapters?: unknown[]
  subtitles?: Record<string, unknown>
  automatic_captions?: Record<string, unknown>
  url?: string
  http_headers?: Record<string, string>
}

const CACHE_ROOT = worldlineHomePath('cache', 'video')
const TEXT_SUBTITLE_EXTENSIONS = new Set(['.vtt', '.srt', '.ass', '.ssa'])
const IMAGE_SUBTITLE_CODECS = new Set(['dvd_subtitle', 'hdmv_pgs_subtitle', 'xsub'])
const activeIndexes = new Map<string, Promise<VideoManifest>>()

function parseJson(command: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${command} returned invalid JSON`, { cause: error })
  }
}

function parseManifest(text: string): VideoManifest {
  const value = parseJson('video manifest', text)
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1) {
    const version = typeof value === 'object' && value !== null && 'version' in value
      ? String(value.version)
      : 'missing'
    throw new Error(`unsupported video manifest version: ${version}`)
  }
  return value as VideoManifest
}

function finite(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function firstStream(document: FfprobeDocument, type: string): ProbeStream | undefined {
  return document.streams?.find(stream => stream.codec_type === type)
}

async function ffprobe(
  ctx: Context,
  executable: string,
  source: string,
  signal?: AbortSignal,
): Promise<FfprobeDocument> {
  const result = await runCommand(ctx, [
    executable,
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-of', 'json',
    source,
  ], dirname(source), signal)
  return parseJson('ffprobe', requireSuccess('ffprobe', result)) as FfprobeDocument
}

async function keyframeTimes(
  ctx: Context,
  executable: string,
  source: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const result = await runCommand(ctx, [
    executable,
    '-v', 'error',
    '-select_streams', 'v:0',
    '-skip_frame', 'nokey',
    '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time,pkt_pts_time',
    '-of', 'json',
    source,
  ], dirname(source), signal)
  const document = parseJson('ffprobe keyframe scan', requireSuccess('ffprobe keyframe scan', result)) as FfprobeDocument
  const values = (document.frames ?? [])
    .map(frame => finite(frame.best_effort_timestamp_time ?? frame.pkt_pts_time))
    .filter((value): value is number => value !== undefined)
  return [...new Set(values.map(value => Math.round(value * 1_000) / 1_000))].sort((a, b) => a - b)
}

/** Create stable approximately ten-minute chapters, snapped to nearby keyframes. */
export function createChapters(durationSeconds: number, keyframes: readonly number[]): VideoChapter[] {
  if (!(durationSeconds > 0)) return [{ index: 0, startSeconds: 0, endSeconds: 0, title: 'Complete video' }]
  const target = 10 * 60
  const count = Math.max(1, Math.ceil(durationSeconds / target))
  const nominal = durationSeconds / count
  const boundaries = [0]
  for (let index = 1; index < count; index += 1) {
    const wanted = nominal * index
    const nearby = keyframes
      .filter(value => Math.abs(value - wanted) <= 30)
      .sort((left, right) => Math.abs(left - wanted) - Math.abs(right - wanted))[0]
    const candidate = nearby ?? wanted
    const previous = boundaries.at(-1) ?? 0
    boundaries.push(Math.max(previous + 1, Math.min(durationSeconds - 1, candidate)))
  }
  boundaries.push(durationSeconds)
  return boundaries.slice(0, -1).map((startSeconds, index) => ({
    index,
    startSeconds,
    endSeconds: boundaries[index + 1] ?? durationSeconds,
    title: `Part ${index + 1} of ${count}`,
  }))
}

function titleFromProbe(document: FfprobeDocument, source: string): string {
  return document.format?.tags?.title?.trim() || basename(source)
}

async function localFingerprint(source: string): Promise<string> {
  const info = await stat(source)
  if (!info.isFile()) throw new Error(`local video source is not a file: ${source}`)
  return createHash('sha256').update(`${resolve(source)}\0${info.size}\0${info.mtimeMs}`).digest('hex').slice(0, 24)
}

function onlineFingerprint(source: string, onlineMode: 'cache' | 'stream'): string {
  return createHash('sha256').update(`${source}\0${onlineMode}`).digest('hex').slice(0, 24)
}

async function discoverCaptionFiles(directory: string, stem?: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && TEXT_SUBTITLE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .filter(entry => stem === undefined || entry.name === `${stem}${extname(entry.name)}` || entry.name.startsWith(`${stem}.`))
    .map(entry => join(directory, entry.name))
    .sort()
}

async function extractEmbeddedCaptions(
  ctx: Context,
  ffmpeg: string,
  document: FfprobeDocument,
  mediaPath: string,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const captions: string[] = []
  for (const stream of document.streams ?? []) {
    if (stream.codec_type !== 'subtitle' || stream.index === undefined || IMAGE_SUBTITLE_CODECS.has(stream.codec_name ?? '')) continue
    const language = stream.tags?.language?.replace(/[^a-z0-9_-]/giu, '_') || `track-${stream.index}`
    const target = join(cacheDir, `embedded.${language}.${stream.index}.vtt`)
    const result = await runCommand(ctx, [
      ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', mediaPath, '-map', `0:${stream.index}`, target,
    ], cacheDir, signal)
    if (result.outcome.exitCode === 0 && result.outcome.signal === null) captions.push(target)
  }
  return captions
}

async function downloadOnlineVideo(
  ctx: Context,
  source: string,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const tools = await resolveVideoExecutables(ctx, signal)
  const result = await runCommand(ctx, [
    tools.ytDlp,
    '--no-playlist',
    '--continue',
    '--no-overwrites',
    '--no-warnings',
    '--restrict-filenames',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'all,-live_chat',
    '--convert-subs', 'vtt',
    '--ffmpeg-location', dirname(tools.ffmpeg),
    '--max-filesize', '25G',
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    '--merge-output-format', 'mp4',
    '--print', 'after_move:filepath',
    '-o', join(cacheDir, 'source.%(ext)s'),
    source,
  ], cacheDir, signal)
  const output = requireSuccess('yt-dlp download', result)
  const printed = output.split(/\r?\n/gu).map(value => value.trim()).filter(Boolean).at(-1)
  if (printed !== undefined && await access(printed).then(() => true, () => false)) return resolve(printed)
  const media = (await readdir(cacheDir, { withFileTypes: true }))
    .find(entry => entry.isFile() && entry.name.startsWith('source.') && !TEXT_SUBTITLE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
  if (media === undefined) throw new Error('yt-dlp completed without a usable media file')
  return join(cacheDir, media.name)
}

async function downloadOnlineCaptions(
  ctx: Context,
  source: string,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const tools = await resolveVideoExecutables(ctx, signal)
  const result = await runCommand(ctx, [
    tools.ytDlp,
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'all,-live_chat',
    '--convert-subs', 'vtt',
    '--ffmpeg-location', dirname(tools.ffmpeg),
    '-o', join(cacheDir, 'source.%(ext)s'),
    source,
  ], cacheDir, signal)
  // Caption availability is optional and site extractors sometimes return a
  // nonzero preprocessing status even though metadata and the media stream are
  // usable. Preserve any complete text tracks they did write, but never turn a
  // visual-only online source into a total indexing failure.
  if (result.outcome.signal !== null && signal?.aborted === true) {
    requireSuccess('yt-dlp caption retrieval', result)
  }
  return await discoverCaptionFiles(cacheDir)
}

async function resolveOnlineStream(
  ctx: Context,
  source: string,
  signal?: AbortSignal,
): Promise<{ url: string; headers: Record<string, string> }> {
  const tools = await resolveVideoExecutables(ctx, signal)
  const result = await runCommand(ctx, [
    tools.ytDlp,
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '-f', 'bestvideo[height<=1080][vcodec^=avc1]/bestvideo[height<=1080]/best[height<=1080]/best',
    source,
  ], process.cwd(), signal)
  const value = parseJson('yt-dlp stream resolver', requireSuccess('yt-dlp stream resolver', result)) as YtDlpDocument
  if (value.url === undefined || !/^https?:\/\//iu.test(value.url)) {
    throw new Error('yt-dlp returned no streamable HTTP(S) video URL')
  }
  return { url: value.url, headers: value.http_headers ?? {} }
}

/** Probe without downloading online media, or inspect a local container. */
export async function probeVideo(ctx: Context, source: string, signal?: AbortSignal): Promise<VideoProbe> {
  const sourceKind = classifySource(source)
  const tools = await resolveVideoExecutables(ctx, signal)
  if (sourceKind === 'online') {
    const result = await runCommand(ctx, [
      tools.ytDlp, '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', source,
    ], process.cwd(), signal)
    const value = parseJson('yt-dlp metadata probe', requireSuccess('yt-dlp metadata probe', result)) as YtDlpDocument
    const durationSeconds = finite(value.duration)
    const width = finite(value.width)
    const height = finite(value.height)
    return {
      source,
      sourceKind,
      title: value.title ?? source,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(value.vcodec === undefined ? {} : { videoCodec: value.vcodec }),
      ...(value.acodec === undefined ? {} : { audioCodec: value.acodec }),
      ...(value.uploader === undefined ? {} : { uploader: value.uploader }),
      ...(value.webpage_url === undefined ? {} : { webpageUrl: value.webpage_url }),
      chapters: value.chapters?.length ?? 0,
      subtitleLanguages: [...new Set([
        ...Object.keys(value.subtitles ?? {}),
        ...Object.keys(value.automatic_captions ?? {}),
      ])].sort(),
    }
  }
  const document = await ffprobe(ctx, tools.ffprobe, source, signal)
  const video = firstStream(document, 'video')
  const audio = firstStream(document, 'audio')
  const durationSeconds = finite(document.format?.duration)
  return {
    source,
    sourceKind,
    title: titleFromProbe(document, source),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(video?.width === undefined ? {} : { width: video.width }),
    ...(video?.height === undefined ? {} : { height: video.height }),
    ...(video?.codec_name === undefined ? {} : { videoCodec: video.codec_name }),
    ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
    chapters: document.chapters?.length ?? 0,
    subtitleLanguages: (document.streams ?? [])
      .filter(stream => stream.codec_type === 'subtitle')
      .map(stream => stream.tags?.language ?? `track-${stream.index ?? 'unknown'}`),
  }
}

async function buildManifest(
  ctx: Context,
  source: string,
  onlineMode: 'cache' | 'stream',
  signal?: AbortSignal,
): Promise<VideoManifest> {
  const sourceKind = classifySource(source)
  const id = sourceKind === 'local' ? await localFingerprint(source) : onlineFingerprint(source, onlineMode)
  const cacheDir = join(CACHE_ROOT, id)
  const manifestPath = join(cacheDir, 'manifest.json')
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  try {
    return parseManifest(await readFile(manifestPath, 'utf8'))
  } catch {
    // Missing or invalid manifests are rebuilt under the writer lock.
  }
  return await withFileLock(manifestPath, async () => {
    try {
      return parseManifest(await readFile(manifestPath, 'utf8'))
    } catch {
      // The lock owner performs the one rebuild.
    }
    const tools = await resolveVideoExecutables(ctx, signal)
    if (sourceKind === 'online' && onlineMode === 'stream') {
      const probe = await probeVideo(ctx, source, signal)
      const durationSeconds = probe.durationSeconds ?? 0
      const captionFiles = await downloadOnlineCaptions(ctx, source, cacheDir, signal)
      const manifest: VideoManifest = {
        version: 1,
        id,
        source,
        sourceKind,
        onlineMode,
        mediaPath: source,
        title: probe.title,
        durationSeconds,
        ...(probe.width === undefined ? {} : { width: probe.width }),
        ...(probe.height === undefined ? {} : { height: probe.height }),
        ...(probe.videoCodec === undefined ? {} : { videoCodec: probe.videoCodec }),
        ...(probe.audioCodec === undefined ? {} : { audioCodec: probe.audioCodec }),
        indexedAt: new Date().toISOString(),
        keyframes: [],
        chapters: createChapters(durationSeconds, []),
        captionFiles,
      }
      await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return manifest
    }
    const mediaPath = sourceKind === 'local' ? source : await downloadOnlineVideo(ctx, source, cacheDir, signal)
    const document = await ffprobe(ctx, tools.ffprobe, mediaPath, signal)
    const durationSeconds = finite(document.format?.duration) ?? 0
    const video = firstStream(document, 'video')
    const audio = firstStream(document, 'audio')
    const keyframes = await keyframeTimes(ctx, tools.ffprobe, mediaPath, signal)
    const sidecars = await discoverCaptionFiles(dirname(mediaPath), sourceKind === 'local' ? parse(mediaPath).name : undefined)
    const embedded = await extractEmbeddedCaptions(ctx, tools.ffmpeg, document, mediaPath, cacheDir, signal)
    const captionFiles = [...new Set([...sidecars, ...embedded])]
    const manifest: VideoManifest = {
      version: 1,
      id,
      source,
      sourceKind,
      ...(sourceKind === 'online' ? { onlineMode } : {}),
      mediaPath: resolve(mediaPath),
      title: titleFromProbe(document, mediaPath),
      durationSeconds,
      ...(video?.width === undefined ? {} : { width: video.width }),
      ...(video?.height === undefined ? {} : { height: video.height }),
      ...(video?.codec_name === undefined ? {} : { videoCodec: video.codec_name }),
      ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
      indexedAt: new Date().toISOString(),
      keyframes,
      chapters: createChapters(durationSeconds, keyframes),
      captionFiles,
    }
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return manifest
  }, { waitMs: 2 * 60 * 60 * 1_000 })
}

/** Build or reuse an atomic, content-keyed video index. */
export async function indexVideo(
  ctx: Context,
  source: string,
  options: { onlineMode?: 'cache' | 'stream' } = {},
  signal?: AbortSignal,
): Promise<{ manifest: VideoManifest; manifestPath: string }> {
  const sourceKind = classifySource(source)
  const onlineMode = options.onlineMode ?? 'cache'
  const id = sourceKind === 'local' ? await localFingerprint(source) : onlineFingerprint(source, onlineMode)
  const existing = activeIndexes.get(id)
  const pending = existing ?? buildManifest(ctx, source, onlineMode, signal)
  if (existing === undefined) activeIndexes.set(id, pending)
  try {
    const manifest = await pending
    return { manifest, manifestPath: join(CACHE_ROOT, manifest.id, 'manifest.json') }
  } finally {
    if (activeIndexes.get(id) === pending) activeIndexes.delete(id)
  }
}

function selectedTimes(manifest: VideoManifest, start: number, end: number, maxFrames: number): number[] {
  const count = Math.max(1, Math.min(32, Math.floor(maxFrames)))
  const span = Math.max(0, end - start)
  const uniform = Array.from({ length: count }, (_, index) => start + span * ((index + 0.5) / count))
  return uniform.map(wanted => manifest.keyframes
    .filter(value => value >= start && value <= end)
    .sort((left, right) => Math.abs(left - wanted) - Math.abs(right - wanted))[0] ?? wanted)
}

async function extractFrame(
  ctx: Context,
  ffmpeg: string,
  manifest: VideoManifest,
  timestamp: number,
  width: number,
  input?: { url: string; headers: Record<string, string> },
  signal?: AbortSignal,
): Promise<string> {
  const frameDir = join(CACHE_ROOT, manifest.id, 'frames')
  await mkdir(frameDir, { recursive: true, mode: 0o700 })
  const name = `${Math.round(timestamp * 1_000).toString().padStart(12, '0')}-w${width}.jpg`
  const target = join(frameDir, name)
  if (await access(target).then(() => true, () => false)) return target
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp.jpg`
  try {
    const headerText = input === undefined
      ? ''
      : Object.entries(input.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')
    const headers = headerText.length === 0 ? [] : ['-headers', headerText]
    const result = await runCommand(ctx, [
      ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      ...headers,
      '-ss', timestamp.toFixed(3), '-i', input?.url ?? manifest.mediaPath,
      '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '3', temporary,
    ], frameDir, signal)
    requireSuccess('ffmpeg frame extraction', result)
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!await access(target).then(() => true, () => false)) throw error
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return target
}

/** Read a bounded time range from an index and materialize only requested frames. */
export async function readVideoRange(
  ctx: Context,
  manifestPath: string,
  options: { chapter?: number; startSeconds?: number; endSeconds?: number; maxFrames?: number; width?: number },
  signal?: AbortSignal,
): Promise<{
  manifest: VideoManifest
  startSeconds: number
  endSeconds: number
  frames: Array<{ timestampSeconds: number; path: string }>
  captions: string
  captionSegments: number
  captionsTruncated: boolean
  analysisMode: 'visual-and-captions' | 'visual-only'
}> {
  const manifest = parseManifest(await readFile(resolve(manifestPath), 'utf8'))
  const chapter = options.chapter === undefined ? undefined : manifest.chapters[options.chapter]
  if (options.chapter !== undefined && chapter === undefined) throw new Error(`chapter ${options.chapter} does not exist`)
  const startSeconds = Math.max(0, options.startSeconds ?? chapter?.startSeconds ?? 0)
  const endSeconds = Math.min(manifest.durationSeconds, options.endSeconds ?? chapter?.endSeconds ?? manifest.durationSeconds)
  if (!(endSeconds > startSeconds)) throw new Error('video read range must have end_seconds greater than start_seconds')
  const times = [...new Set(selectedTimes(manifest, startSeconds, endSeconds, options.maxFrames ?? 12))]
  const tools = await resolveVideoExecutables(ctx, signal)
  const input = manifest.sourceKind === 'online' && manifest.onlineMode === 'stream'
    ? await resolveOnlineStream(ctx, manifest.source, signal)
    : undefined
  const frames: Array<{ timestampSeconds: number; path: string }> = []
  for (const timestampSeconds of times) {
    frames.push({
      timestampSeconds,
      path: await extractFrame(ctx, tools.ffmpeg, manifest, timestampSeconds, options.width ?? 960, input, signal),
    })
  }
  const segments = await readCaptionFiles(manifest.captionFiles)
  const captions = captionsForRange(segments, startSeconds, endSeconds)
  return {
    manifest,
    startSeconds,
    endSeconds,
    frames,
    captions: captions.text,
    captionSegments: captions.segmentCount,
    captionsTruncated: captions.truncated,
    analysisMode: segments.length > 0 ? 'visual-and-captions' : 'visual-only',
  }
}

/** Exposed for diagnostics and tests; never mutates the process environment. */
export async function videoToolEnvironment(ctx: Context, signal?: AbortSignal): Promise<{ path: string }> {
  return { path: pathWithBundledTools(await resolveVideoExecutables(ctx, signal)) }
}
