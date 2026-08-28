import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchNeteasePlaylistCatalog,
  fetchNeteaseTrackLyrics,
  NETEASE_PLAYLIST_ID,
  NeteaseMusicGateway,
  parseNeteaseLyrics,
  parseNeteaseWordLyrics,
  resolveNeteaseTrackStream,
} from '../src/index.ts'

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('NetEase music Host gateway', () => {
  it('expands every ordered track id instead of trusting the ten embedded rows', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => String(10_000 + index))
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      if (url.pathname === '/api/v6/playlist/detail') return response({
        code: 200,
        playlist: {
          id: NETEASE_PLAYLIST_ID,
          name: '完整歌单',
          coverImgUrl: 'https://p1.music.126.net/cover.jpg',
          trackCount: ids.length,
          tracks: ids.slice(0, 10).map(id => ({ id })),
          trackIds: ids.map(id => ({ id })),
        },
      })
      const requested = JSON.parse(url.searchParams.get('ids') ?? '[]') as number[]
      return response({
        code: 200,
        songs: requested.map(id => ({
          id,
          name: `歌曲 ${String(id)}`,
          dt: 123_000,
          ar: [{ name: '天幻' }],
          al: { name: '作品集', picUrl: `https://p1.music.126.net/${String(id)}.jpg` },
        })),
      })
    })

    const catalog = await fetchNeteasePlaylistCatalog(NETEASE_PLAYLIST_ID, fetcher)

    expect(catalog.trackCount).toBe(205)
    expect(catalog.tracks).toHaveLength(205)
    expect(catalog.tracks[0]).toMatchObject({ id: ids[0], name: `歌曲 ${ids[0]}` })
    expect(catalog.tracks.at(-1)).toMatchObject({ id: ids.at(-1) })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('normalizes a trusted public media redirect to HTTPS', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://m801.music.126.net/free/song.mp3?token=one' },
    }))

    await expect(resolveNeteaseTrackStream('3419785927', fetcher)).resolves.toEqual({
      trackId: '3419785927',
      url: 'https://m801.music.126.net/free/song.mp3?token=one',
    })
  })

  it('rejects malformed ids and redirects outside NetEase media hosts', async () => {
    await expect(resolveNeteaseTrackStream('../secret', vi.fn())).rejects.toThrow('正整数')
    await expect(resolveNeteaseTrackStream('42', async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/not-music.mp3' },
    }))).rejects.toThrow('不受信任')
  })

  it('parses synchronized lyrics and joins translations by timestamp', async () => {
    expect(parseNeteaseLyrics('[offset:100]\n[00:01.20][00:02.300]第一句')).toEqual([
      { timeMs: 1_300, text: '第一句' },
      { timeMs: 2_400, text: '第一句' },
    ])
    expect(parseNeteaseLyrics('[00:03.000]原文|行内翻译')).toEqual([
      { timeMs: 3_000, text: '原文', translatedText: '行内翻译' },
    ])
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      expect(url.searchParams.get('lv')).toBe('-1')
      expect(url.searchParams.get('kv')).toBe('-1')
      expect(url.searchParams.get('yv')).toBe('-1')
      return response({
        code: 200,
        lrc: { lyric: '[00:01.000]第一句|旧翻译\n[00:04.250]第二句' },
        tlyric: { lyric: '[00:01.000]First line' },
      })
    })

    await expect(fetchNeteaseTrackLyrics('42', fetcher)).resolves.toEqual({
      trackId: '42',
      lines: [
        { timeMs: 1_000, text: '第一句', translatedText: 'First line' },
        { timeMs: 4_250, text: '第二句' },
      ],
    })
  })

  it('falls back to word-synchronized and romanized lyric variants', async () => {
    expect(parseNeteaseWordLyrics(
      '[1200,900](1200,300,0)逐(1500,300,0)字(1800,300,0)歌词',
    )).toEqual([{ timeMs: 1_200, text: '逐字歌词' }])

    const wordFetcher = vi.fn(async () => response({
      code: 200,
      lrc: { lyric: '' },
      yrc: { lyric: '[1200,900](1200,300,0)逐(1500,300,0)字(1800,300,0)歌词' },
      ytlrc: { lyric: '[00:01.200]Word lyric' },
    }))
    await expect(fetchNeteaseTrackLyrics('43', wordFetcher)).resolves.toEqual({
      trackId: '43',
      lines: [{ timeMs: 1_200, text: '逐字歌词', translatedText: 'Word lyric' }],
    })

    const romanizedFetcher = vi.fn(async () => response({
      code: 200,
      lrc: { lyric: '' },
      yrc: { lyric: '' },
      romalrc: { lyric: '[00:02.500]romaji fallback' },
    }))
    await expect(fetchNeteaseTrackLyrics('44', romanizedFetcher)).resolves.toEqual({
      trackId: '44',
      lines: [{ timeMs: 2_500, text: 'romaji fallback' }],
    })
  })

  it('exposes catalog, stream and lyrics remotes and bounds song access to the playlist', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input)
      return url.pathname === '/api/v6/playlist/detail'
        ? response({
          code: 200,
          playlist: {
            id: NETEASE_PLAYLIST_ID,
            name: '固定歌单',
            trackCount: 1,
            trackIds: [{ id: 42 }],
          },
        })
        : response({
          code: 200,
          songs: [{ id: 42, name: '公开歌曲', dt: 60_000, ar: [], al: {} }],
        })
    })
    vi.stubGlobal('fetch', fetcher)
    const ctx = new Context()
    await ctx.plugin(NeteaseMusicGateway)
    const gateway = ctx.get('neteaseMusic') as NeteaseMusicGateway

    expect(remoteMethods(gateway).map(method => method.method)).toEqual([
      'catalog',
      'stream',
      'lyrics',
    ])
    await expect(gateway.stream(NETEASE_PLAYLIST_ID, '999', new AbortController().signal))
      .rejects.toThrow('不属于内置网易云歌单')
    await expect(gateway.lyrics(NETEASE_PLAYLIST_ID, '999', new AbortController().signal))
      .rejects.toThrow('不属于内置网易云歌单')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })
})
