import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { CaptionSegment } from './types.ts'

function parseClock(value: string): number | undefined {
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':').map(Number)
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part))) return undefined
  const seconds = parts.pop() ?? 0
  const minutes = parts.pop() ?? 0
  const hours = parts.pop() ?? 0
  return hours * 3600 + minutes * 60 + seconds
}

function cleanCaptionText(text: string): string {
  return text
    .replace(/<[^>]+>/gu, '')
    .replace(/\{\\[^}]+\}/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 *  Parse WebVTT or SubRip text into normalized segments.
 * @param content - content value.
 * @returns The resulting value.
 */
export function parseVttOrSrt(content: string): CaptionSegment[] {
  const blocks = content.replace(/^\uFEFF/u, '').split(/\r?\n\s*\r?\n/gu)
  const segments: CaptionSegment[] = []
  for (const block of blocks) {
    const lines = block.split(/\r?\n/gu)
    const timingIndex = lines.findIndex(line => line.includes('-->'))
    if (timingIndex === -1) continue
    const timingLine = lines[timingIndex]
    if (timingLine === undefined) continue
    const [startText, endAndSettings] = timingLine.split('-->')
    const endText = endAndSettings?.trim().split(/\s+/u)[0]
    const startSeconds = startText === undefined ? undefined : parseClock(startText)
    const endSeconds = endText === undefined ? undefined : parseClock(endText)
    const text = cleanCaptionText(lines.slice(timingIndex + 1).join(' '))
    if (startSeconds === undefined || endSeconds === undefined || text.length === 0) continue
    segments.push({ startSeconds, endSeconds, text })
  }
  return segments
}

/**
 *  Parse dialogue rows from Advanced SubStation Alpha subtitles.
 * @param content - content value.
 * @returns The resulting value.
 */
export function parseAss(content: string): CaptionSegment[] {
  const segments: CaptionSegment[] = []
  for (const line of content.split(/\r?\n/gu)) {
    if (!/^Dialogue:/iu.test(line)) continue
    const fields = line.slice(line.indexOf(':') + 1).split(',')
    if (fields.length < 10) continue
    const startSeconds = parseClock(fields[1] ?? '')
    const endSeconds = parseClock(fields[2] ?? '')
    const text = cleanCaptionText(fields.slice(9).join(',').replace(/\\N/gu, ' '))
    if (startSeconds === undefined || endSeconds === undefined || text.length === 0) continue
    segments.push({ startSeconds, endSeconds, text })
  }
  return segments
}

/**
 *  Read every supported text-caption file, ignoring one corrupt track at a time.
 * @param paths - paths value.
 * @returns The resulting value.
 */
export async function readCaptionFiles(paths: readonly string[]): Promise<CaptionSegment[]> {
  const all: CaptionSegment[] = []
  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf8')
      all.push(...(extname(path).toLowerCase() === '.ass' ? parseAss(content) : parseVttOrSrt(content)))
    } catch {
      // A malformed optional caption track must not make visual inspection fail.
    }
  }
  all.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds)
  const unique: CaptionSegment[] = []
  let last = ''
  for (const segment of all) {
    const key = `${segment.startSeconds}|${segment.endSeconds}|${segment.text}`
    if (key === last) continue
    unique.push(segment)
    last = key
  }
  return unique
}

/**
 *  Render only caption text overlapping a requested time range.
 * @param segments - segments value.
 * @param startSeconds - start seconds value.
 * @param endSeconds - end seconds value.
 * @param maxCharacters - max characters value.
 * @returns The resulting value.
 */
export function captionsForRange(
  segments: readonly CaptionSegment[],
  startSeconds: number,
  endSeconds: number,
  maxCharacters = 16_000,
): { text: string; truncated: boolean; segmentCount: number } {
  const selected = segments.filter(segment => segment.endSeconds >= startSeconds && segment.startSeconds <= endSeconds)
  const lines = selected.map(segment => `[${formatTime(segment.startSeconds)}] ${segment.text}`)
  const complete = lines.join('\n')
  if (complete.length <= maxCharacters) return { text: complete, truncated: false, segmentCount: selected.length }
  return {
    text: `${complete.slice(0, Math.max(0, maxCharacters - 30))}\n[caption text truncated]`,
    truncated: true,
    segmentCount: selected.length,
  }
}

/**
 *  Human-readable video timestamp.
 * @param seconds - seconds value.
 * @returns The resulting value.
 */
export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const remainder = whole % 60
  return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':')
}
