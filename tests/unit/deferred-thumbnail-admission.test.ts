import { describe, expect, it } from 'vitest';
import { DeferredThumbnailAdmission } from '../../src/worker/deferred-thumbnail-admission';

describe('DeferredThumbnailAdmission', () => {
  it('retains startup work while a viewport queue is active, then admits it once idle', () => {
    const admission = new DeferredThumbnailAdmission();
    admission.defer({ libraryId: 'library', generation: 3 });

    expect(admission.takeWhenIdle('library', 3, true)).toBeUndefined();
    expect(admission.takeWhenIdle('library', 3, false)).toBe(3);
    expect(admission.takeWhenIdle('library', 3, false)).toBeUndefined();
  });

  it('discards work from a closed or replaced library generation', () => {
    const admission = new DeferredThumbnailAdmission();
    admission.defer({ libraryId: 'library', generation: 3 });

    expect(admission.takeWhenIdle('library', 4, true)).toBeUndefined();
    expect(admission.takeWhenIdle('library', 3, false)).toBeUndefined();
  });

  it('cancels pending work at a library lifecycle boundary', () => {
    const admission = new DeferredThumbnailAdmission();
    admission.defer({ libraryId: 'library', generation: 3 });
    admission.cancel('library');

    expect(admission.takeWhenIdle('library', 3, false)).toBeUndefined();
  });
});
