import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companionAttachmentResponse } from '../../src/main/companions/attachment-response';

let root: string, file: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-media-response-')); file = path.join(root, 'media.bin'); await writeFile(file, '0123456789'); });
afterEach(async () => {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-media-response-')) throw new Error('Unexpected media test cleanup target.');
  await rm(root, { recursive: true, force: true });
});
const request = (range?: string, method = 'GET') => new Request('https://attachment.invalid/media', { method, headers: range ? { Range: range } : {} });
describe('registered companion media response', () => {
  it('seeks directly to the tail of a large sparse media file without buffering the full video', async () => {
    const size = 1536 * 1024 * 1024, handle = await open(file, 'w');
    try { await handle.truncate(size); await handle.write(Buffer.from('tail'), 0, 4, size - 4); } finally { await handle.close(); }
    const response = await companionAttachmentResponse(file, 'video/mp4', request('bytes=-4'));
    expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(`bytes ${size - 4}-${size - 1}/${size}`);
    expect(await response.text()).toBe('tail');
  });
  it('streams the complete file with an accurate MIME type and length', async () => {
    const response = await companionAttachmentResponse(file, 'video/webm', request());
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('video/webm');
    expect(response.headers.get('content-length')).toBe('10'); expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(await response.text()).toBe('0123456789');
  });
  it.each([['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10']])('serves seek %s exactly', async (range, content, header) => {
    const response = await companionAttachmentResponse(file, 'audio/wav', request(range));
    expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(header);
    expect(response.headers.get('content-length')).toBe(String(content.length)); expect(await response.text()).toBe(content);
  });
  it.each(['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'bytes=9007199254740999-'])('rejects an invalid range %s', async range => {
    const response = await companionAttachmentResponse(file, 'video/mp4', request(range));
    expect(response.status).toBe(416); expect(response.headers.get('content-range')).toBe('bytes */10'); expect(await response.text()).toBe('');
  });
  it('returns HEAD metadata without a body and never accepts a write method', async () => {
    const response = await companionAttachmentResponse(file, 'audio/wav', request('bytes=1-4', 'HEAD'));
    expect(response.status).toBe(206); expect(response.headers.get('content-length')).toBe('4'); expect(await response.text()).toBe('');
    expect((await companionAttachmentResponse(file, 'audio/wav', request(undefined, 'POST'))).status).toBe(405);
  });
  it('handles an empty file without creating an invalid stream', async () => {
    await writeFile(file, ''); const response = await companionAttachmentResponse(file, 'text/plain', request());
    expect(response.headers.get('content-length')).toBe('0'); expect(await response.text()).toBe('');
  });
});
