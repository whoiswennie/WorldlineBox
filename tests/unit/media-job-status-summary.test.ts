import { describe, expect, it } from 'vitest';

import {
  MediaJobStatusSummaryCache,
  mediaJobCountTotal,
  mediaJobCountsFromRows,
} from '../../src/worker/media-job-status-summary';

function counts(overrides: Partial<Record<string, number>> = {}) {
  return {
    ...mediaJobCountsFromRows([
      { status: 'queued', count: 3 },
      { status: 'running', count: 1 },
      { status: 'succeeded', count: 10 },
      { status: 'failed', count: 2 },
      { status: 'paused', count: 0 },
      { status: 'cancelled', count: 4 },
    ]),
    ...overrides,
  };
}

describe('MediaJobStatusSummaryCache', () => {
  it('serves the cached counts while the validation token is unchanged', () => {
    const cache = new MediaJobStatusSummaryCache({ staleWindowMs: 1_000, now: () => 0 });
    cache.store('library-a', '5:7', counts(), 20);

    const first = cache.read('library-a', '5:7');
    const second = cache.read('library-a', '5:7');

    expect(first.source).toBe('hit');
    expect(second.source).toBe('hit');
    expect(second.counts).toMatchObject({ queued: 3, succeeded: 10, cancelled: 4 });
    expect(second.totalJobs).toBe(20);
    expect(cache.stats()).toMatchObject({ reads: 2, hits: 2, rebuilds: 1 });
  });

  it('tolerates a bounded stale window, then asks for a rebuild', () => {
    let now = 1_000;
    const cache = new MediaJobStatusSummaryCache({ staleWindowMs: 500, now: () => now });
    cache.store('library-a', '5:7', counts({ queued: 3 }), 20);

    now = 1_200;
    const stale = cache.read('library-a', '6:7');
    expect(stale.source).toBe('stale-hit');
    expect(stale.counts?.queued).toBe(3);
    expect(stale.ageMs).toBe(200);

    now = 1_600;
    const expired = cache.read('library-a', '6:7');
    expect(expired.source).toBe('miss');
    expect(expired.counts).toBeNull();
    expect(cache.stats()).toMatchObject({ hits: 0, staleHits: 1, misses: 1, rebuilds: 1 });
  });

  it('invalidates on demand and keeps libraries apart', () => {
    const cache = new MediaJobStatusSummaryCache({ now: () => 0 });
    cache.store('library-a', '1:1', counts({ queued: 1 }), 1);
    cache.store('library-b', '1:1', counts({ queued: 9 }), 9);

    expect(cache.read('library-b', '1:1').counts?.queued).toBe(9);

    cache.invalidate('library-a');
    expect(cache.read('library-a', '1:1').source).toBe('miss');
    expect(cache.read('library-b', '1:1').source).toBe('hit');

    cache.invalidate();
    expect(cache.read('library-b', '1:1').source).toBe('miss');
  });

  it('folds grouped rows and totals only known statuses', () => {
    const folded = mediaJobCountsFromRows([
      { status: 'queued', count: 2 },
      { status: 'succeeded', count: 5 },
      // Unknown statuses (other job families) must not leak into media counts.
      { status: 'ai.image.analysis', count: 99 },
    ]);

    expect(folded).toMatchObject({ queued: 2, succeeded: 5, running: 0, failed: 0, paused: 0, cancelled: 0 });
    expect(mediaJobCountTotal(folded)).toBe(7);
    expect(mediaJobCountTotal(counts())).toBe(20);
  });
});
