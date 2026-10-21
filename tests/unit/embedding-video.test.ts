import { describe, expect, it } from 'vitest';
import { embeddingVideoWindowStarts } from '../../src/worker/embedding-video';
import { workerResultSchema } from '../../src/shared/protocol/responses';

describe('bounded real video preparation', () => {
  it('preserves every short clip window and covers the complete long timeline uniformly', () => {
    expect(embeddingVideoWindowStarts(3)).toEqual([0]);
    expect(embeddingVideoWindowStarts(32)).toEqual([0, 16]);
    expect(embeddingVideoWindowStarts(33)).toEqual([0, 16, 32]);
    const long = embeddingVideoWindowStarts(3600);
    expect(long).toHaveLength(16); expect(long[0]).toBe(0); expect(long.at(-1)).toBe(3584);
    expect(new Set(long).size).toBe(16);
    expect(() => embeddingVideoWindowStarts(Infinity)).toThrow();
    expect(() => embeddingVideoWindowStarts(0)).toThrow();
    expect(() => embeddingVideoWindowStarts(10, 16, 17)).toThrow();
  });
  it('requires bounded frame windows and permits synchronized audio without a second payload', () => {
    const base = { ok: true, type: 'semantic.index.prepared', assetId: 'video', sourceRevision: 'revision', kind: 'video' };
    expect(workerResultSchema.safeParse({ ...base, videoWindows: [{ bytesBase64: 'actual-frames', audioBase64: 'actual-audio' }] }).success).toBe(true);
    expect(workerResultSchema.safeParse({ ...base, bytesBase64: 'old-raw-video' }).success).toBe(false);
    expect(workerResultSchema.safeParse({ ...base, videoWindows: Array.from({ length: 17 }, () => ({ bytesBase64: 'frames' })) }).success).toBe(false);
    expect(workerResultSchema.safeParse({ ...base, videoWindows: [{ bytesBase64: 'frames' }], bytesBase64: 'duplicate' }).success).toBe(false);
  });
});
