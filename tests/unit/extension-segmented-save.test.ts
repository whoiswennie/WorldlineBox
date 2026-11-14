import { describe, expect, it, vi } from 'vitest';
import { parseSegmentedManifest } from '../../extension/segmented-manifest';
import { saveMediaViaBrowser } from '../../extension/save-client';

const sourcePageUrl = 'https://example.test/watch';
const manifestUrl = 'https://cdn.example.test/video/index.m3u8';
const playlist = '#EXTM3U\n#EXTINF:2.5,\nfirst.ts\n#EXTINF:1,\nsecond.ts\n#EXT-X-ENDLIST';
const behavior = { notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: true };

describe('browser extension segmented saves', () => {
  it('selects an HLS variant and resolves initialization and relative byte ranges', async () => {
    const read = vi.fn(async (url: string) => ({ url, text: [
      '#EXTM3U', '#EXT-X-MAP:URI="clip.mp4",BYTERANGE="8@0"', '#EXTINF:2,',
      '#EXT-X-BYTERANGE:20@8', 'clip.mp4', '#EXTINF:1,', '#EXT-X-BYTERANGE:15',
      'clip.mp4', '#EXT-X-ENDLIST',
    ].join('\n') }));
    const result = await parseSegmentedManifest('hls', {
      url: manifestUrl,
      text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500\nhigh/index.m3u8',
    }, read);
    expect(read).toHaveBeenCalledExactlyOnceWith('https://cdn.example.test/video/high/index.m3u8');
    expect(result.protocol).toBe('hls-fmp4');
    expect(result.tracks[0]?.parts.map(part => part.range)).toEqual(['bytes=0-7', 'bytes=8-27', 'bytes=28-42']);
  });

  it('expands a static DASH timeline for separate video and audio', async () => {
    const result = await parseSegmentedManifest('dash', {
      url: 'https://cdn.example.test/manifest.mpd',
      text: `<MPD mediaPresentationDuration="PT4S" xmlns="urn:mpeg:dash:schema:mpd:2011">
        <Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="10"
          initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s">
          <SegmentTimeline><S t="0" d="20" r="1"/></SegmentTimeline></SegmentTemplate>
          <Representation id="v" bandwidth="200"/></AdaptationSet>
          <AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="100">
          <SegmentTemplate timescale="1" duration="2" startNumber="5"
            initialization="a/init.mp4" media="a/$Number%03d$.m4s"/></Representation>
          </AdaptationSet></Period></MPD>`,
    }, vi.fn());
    expect(result.protocol).toBe('dash-fmp4');
    expect(result.tracks.map(track => track.parts.map(part => new URL(part.url).pathname))).toEqual([
      ['/v/init.mp4', '/v/0.m4s', '/v/20.m4s'],
      ['/a/init.mp4', '/a/005.m4s', '/a/006.m4s'],
    ]);
  });

  it('uploads every segment in bounded chunks to one desktop session and waits for import', async () => {
    const desktop = 'http://127.0.0.1:19877';
    const session = `${desktop}/media-transfer/sessions/11111111-1111-4111-8111-111111111111`;
    const chunks: Array<[string, number[], string]> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === manifestUrl) return new Response(playlist, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      if (url === 'http://127.0.0.1:19876/ping') return Response.json({ app: 'WorldlineBox' });
      if (url === 'http://127.0.0.1:19876/folders') return Response.json({ reason: 'no active library' }, { status: 503 });
      if (url === `${desktop}/ping`) return Response.json({ app: 'WorldlineBox' });
      if (url === `${desktop}/folders`) return Response.json({ libraryId: 'library', folders: [{ folderId: 'folder' }] });
      if (url === `${desktop}/capabilities`) return Response.json({ segmentedMediaUpload: { version: 1 } });
      if (url === `${desktop}/media-transfer/sessions`) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          targetFolderId: 'folder', expectedLibraryId: 'library', sourcePageUrl, mediaUrl: manifestUrl, protocol: 'hls-ts',
          tracks: [{ kind: 'video', segments: [{ id: 'video-0', durationMs: 2500 }, { id: 'video-1', durationMs: 1000 }] }],
        });
        return Response.json({ sessionId: session.split('/').at(-1), token: 'token', chunkBytes: 2, maxAssetBytes: 20 }, { status: 201 });
      }
      if (url.endsWith('.ts')) return new Response(new Uint8Array([1, 2, 3]));
      if (url.startsWith(`${session}/segments/`)) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
        chunks.push([url.split('/').at(-1)!, Array.from(init?.body as Uint8Array),
          new Headers(init?.headers).get('X-Segment-Final')!]);
        return Response.json({ status: 'ok' });
      }
      if (url === `${session}/commit`) return Response.json({ status: 'accepted' }, { status: 202 });
      if (url === session) return Response.json({ status: 'complete' });
      throw new Error(`Unexpected URL ${url}`);
    });
    await expect(saveMediaViaBrowser({
      kind: 'video', sourcePageUrl, mediaUrl: manifestUrl, targetFolderId: 'folder',
    }, behavior, fetch)).resolves.toEqual({ kind: 'accepted' });
    expect(chunks).toEqual([
      ['video-0?offset=0', [1, 2], 'false'], ['video-0?offset=2', [3], 'true'],
      ['video-1?offset=0', [1, 2], 'false'], ['video-1?offset=2', [3], 'true'],
    ]);
  });
});
