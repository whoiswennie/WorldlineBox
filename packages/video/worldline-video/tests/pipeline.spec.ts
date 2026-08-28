import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { captionsForRange, parseAss, parseVttOrSrt } from '../src/captions.ts'
import { createChapters } from '../src/pipeline.ts'
import { classifySource } from '../src/resolver.ts'

describe('worldline video pure pipeline', () => {
  it('creates bounded chapters and snaps boundaries to nearby keyframes', () => {
    const chapters = createChapters(7_200, [0, 590, 1_205, 1_800, 2_400, 3_000, 3_600, 4_200, 4_800, 5_400, 6_000, 6_600])
    expect(chapters).toHaveLength(12)
    expect(chapters[1]?.startSeconds).toBe(590)
    expect(chapters.at(-1)?.endSeconds).toBe(7_200)
    expect(chapters.every((chapter, index) => index === 0 || chapter.startSeconds >= chapters[index - 1]!.endSeconds)).toBe(true)
  })

  it('parses VTT, SRT, and ASS captions into one normalized shape', () => {
    expect(parseVttOrSrt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<b>Hello</b> world')).toEqual([
      { startSeconds: 1, endSeconds: 3, text: 'Hello world' },
    ])
    expect(parseVttOrSrt('1\n00:00:04,500 --> 00:00:06,000\nSecond')).toEqual([
      { startSeconds: 4.5, endSeconds: 6, text: 'Second' },
    ])
    expect(parseAss('[Events]\nDialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,Third\\Nline')).toEqual([
      { startSeconds: 7, endSeconds: 9, text: 'Third line' },
    ])
  })

  it('bounds captions and rejects ambiguous relative sources', () => {
    const selected = captionsForRange([
      { startSeconds: 1, endSeconds: 2, text: 'first' },
      { startSeconds: 20, endSeconds: 21, text: 'outside' },
    ], 0, 10)
    expect(selected.text).toContain('first')
    expect(selected.text).not.toContain('outside')
    expect(classifySource('https://example.com/video')).toBe('online')
    expect(() => classifySource('relative.mp4')).toThrow(/absolute local path/u)
  })

  it('ships a methodology skill that requires evidence, hierarchy, and honest limits', async () => {
    const skill = await readFile(new URL('../assets/worldline-video/SKILL.md', import.meta.url), 'utf8')
    expect(skill).toContain('Call `video_probe` first')
    expect(skill).toContain('read one zero-based chapter at a time')
    expect(skill).toContain('Inspect every returned image path')
    expect(skill).toContain('`visual-only` means there is no textual speech evidence')
    expect(skill).toContain('Do not claim continuous viewing from sampled frames')
    expect(skill).toContain('work hierarchically')
  })
})
