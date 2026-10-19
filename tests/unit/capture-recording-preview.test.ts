import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingPreview } from '../../src/main/capture-tools/recording-preview';
import type { CaptureRecordingState } from '../../src/shared/capture-tools';

const roots: string[] = [], previews: RecordingPreview[] = [];
afterEach(async () => { for (const preview of previews.splice(0)) preview.clear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(format: CaptureRecordingState['format'] = 'mp4') {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-recording-preview-')); roots.push(root);
  const file = path.join(root, '录制 sample.' + format); await writeFile(file, Buffer.from('0123456789abcdefghij'));
  const state: CaptureRecordingState = { id: 'saved-recording', status: 'saved', format, bytes: 20, startedAt: new Date().toISOString(), path: file };
  const playback = new RecordingPreview(); previews.push(playback); const preview = await playback.prepare(state);
  return { file, root, state, playback, preview };
}

describe('scoped streamed recording previews', () => {
  it.each([['mp4', 'video/mp4'], ['webm', 'video/webm'], ['gif', 'image/gif']] as const)('streams actual saved %s bytes, serves HEAD and supports seek ranges', async (format, mime) => {
    const { playback, preview } = await fixture(format);
    expect(preview).toMatchObject({ mimeType: mime, bytes: 20, name: '录制 sample.' + format });
    expect(preview.url).toMatch(/^worldlinebox-capture:\/\/recording\/[0-9a-f-]{36}$/u);
    const response = await playback.respond(new Request(preview.url));
    expect(response.status).toBe(200); expect(await response.text()).toBe('0123456789abcdefghij');
    expect(response.headers.get('content-type')).toBe(mime); expect(response.headers.get('cache-control')).toBe('no-store');
    const head = await playback.respond(new Request(preview.url, { method: 'HEAD' }));
    expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe('20'); expect(await head.text()).toBe('');
    for (const [range, text, span] of [['bytes=3-6', '3456', '3-6'], ['bytes=17-', 'hij', '17-19'], ['bytes=-4', 'ghij', '16-19']]) {
      const part = await playback.respond(new Request(preview.url, { headers: { Range: range! } }));
      expect(part.status).toBe(206); expect(part.headers.get('content-range')).toBe(`bytes ${span}/20`); expect(await part.text()).toBe(text);
    }
  });
  it('reads only a requested tail from a large sparse file and rejects malformed/multiple/out-of-bounds ranges', async () => {
    const { playback, file, state } = await fixture();
    const handle = await open(file, 'r+'); const size = 2 ** 31 + 16;
    try { await handle.truncate(size); await handle.write(Buffer.from('TAIL'), 0, 4, size - 4); } finally { await handle.close(); }
    const preview = await playback.prepare(state);
    const tail = await playback.respond(new Request(preview.url, { headers: { Range: 'bytes=-4' } }));
    expect(tail.status).toBe(206); expect(tail.headers.get('content-length')).toBe('4'); expect(await tail.text()).toBe('TAIL');
    for (const range of ['bytes=0-1,4-5', 'bytes=-0', `bytes=${size}-`, 'bytes=10-4', 'bytes=9007199254740999-']) {
      const result = await playback.respond(new Request(preview.url, { headers: { Range: range } }));
      expect(result.status).toBe(416); expect(result.headers.get('content-range')).toBe(`bytes */${size}`);
    }
  });
  it('never interprets URL paths as files and revokes capabilities on close, replacement and a new result', async () => {
    const { playback, preview, file, state, root } = await fixture();
    for (const url of [preview.url + '?file=private', preview.url + '/../../secret', preview.url.replace('recording/', 'other/'), 'worldlinebox-capture://recording/C:/private.mp4']) {
      expect((await playback.respond(new Request(url))).status).toBe(404);
    }
    expect((await playback.respond(new Request(preview.url, { method: 'POST' }))).status).toBe(405);
    expect(await playback.prepare(state)).toEqual(preview);
    await rename(file, path.join(root, 'original.mp4')); await writeFile(file, 'replacement private file');
    expect((await playback.respond(new Request(preview.url))).status).toBe(404);
    const next = await playback.prepare({ ...state, id: 'next-recording' });
    expect(next.url).not.toBe(preview.url); expect((await playback.respond(new Request(preview.url))).status).toBe(404);
    playback.clear(); expect((await playback.respond(new Request(next.url))).status).toBe(404);
  });
  it('allows retained failed WebM data, rejects live/empty files, and reports files moved after saving', async () => {
    const { playback, state, file, root } = await fixture();
    await expect(playback.prepare({ ...state, status: 'recording' })).rejects.toThrow('尚未生成');
    await expect(playback.prepare({ ...state, status: 'failed' })).rejects.toThrow('尚未生成');
    const partial = path.join(root, '.recoverable.webm.part'); await rename(file, partial);
    const preview = await playback.prepare({ ...state, status: 'failed', path: partial }); expect(preview.mimeType).toBe('video/webm');
    const response = await playback.respond(new Request(preview.url)); expect(await response.text()).toBe('0123456789abcdefghij');
    await rm(partial); expect((await playback.respond(new Request(preview.url))).status).toBe(404);
    await writeFile(file, ''); await expect(playback.prepare(state)).rejects.toThrow('为空');
  });
});
