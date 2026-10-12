import { describe, expect, it } from 'vitest';

import {
  LibraryOperationError,
  libraryOpenBlockingTitleKey,
  messageForPublicError,
} from '../../src/renderer/error-utils';
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/protocol/errors';

describe('library already-open prompt (WorldlineBox-79b839)', () => {
  it('uses a prompt title instead of an open-failure title', () => {
    expect(libraryOpenBlockingTitleKey('LIBRARY_ALREADY_OPEN')).toBe(
      'dialog.blockingError.libraryAlreadyOpen',
    );
    expect(libraryOpenBlockingTitleKey('LIBRARY_CORRUPT')).toBe(
      'dialog.blockingError.libraryOpenFailed',
    );
    expect(libraryOpenBlockingTitleKey(undefined)).toBe(
      'dialog.blockingError.libraryOpenFailed',
    );
  });

  it('does not describe the catalog as damaged', () => {
    const zh = messageForPublicError(
      {
        code: 'LIBRARY_ALREADY_OPEN',
        message: PUBLIC_ERROR_MESSAGES.LIBRARY_ALREADY_OPEN,
      },
      'zh-CN',
    );
    const en = messageForPublicError(
      {
        code: 'LIBRARY_ALREADY_OPEN',
        message: PUBLIC_ERROR_MESSAGES.LIBRARY_ALREADY_OPEN,
      },
      'en',
    );
    expect(zh).toContain('相同的资源库ID');
    expect(zh).toContain('是否视为不同资源库进行打开');
    expect(zh).not.toMatch(/损坏|备份|抢救|另选文件夹/);
    expect(en.toLowerCase()).toContain('library id');
    expect(en.toLowerCase()).toContain('different library');
    expect(en.toLowerCase()).not.toMatch(/corrupt|backup|rescue|damage|choose another folder/);
    expect(
      new LibraryOperationError({
        code: 'LIBRARY_ALREADY_OPEN',
        message: PUBLIC_ERROR_MESSAGES.LIBRARY_ALREADY_OPEN,
      }).code,
    ).toBe('LIBRARY_ALREADY_OPEN');
  });
});
