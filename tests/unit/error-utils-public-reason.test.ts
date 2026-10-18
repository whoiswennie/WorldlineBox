import { describe, expect, it } from 'vitest';

import { createPublicError } from '../../src/shared/protocol/errors';
import { LibraryOperationError, messageForPublicError, toMessage } from '../../src/renderer/error-utils';

describe('renderer-safe public error reasons', () => {
  it.each(['zh-CN', 'en'] as const)('preserves AI failure reasons from IPC objects in %s', (locale) => {
    for (const reason of ['AI_NOT_CONFIGURED', 'AI_NO_ELIGIBLE_ASSETS', 'AI_MODEL_NO_VISION', 'AI_TEXT_UNREADABLE', 'AI_REQUEST_REJECTED'] as const) {
      const error = createPublicError('AI_ANALYSIS_FAILED', reason);
      expect(toMessage(error, 'fallback', locale)).toBe(messageForPublicError(error, locale));
      expect(toMessage(error, 'fallback', locale)).toBe(toMessage(new LibraryOperationError(error), 'fallback', locale));
    }
  });

  it.each(['provider secret sk-must-not-render', 'constructor.name'])('does not expose arbitrary provider details presented as a reason: %s', (reason) => {
    const error = createPublicError('AI_ANALYSIS_FAILED');
    expect(toMessage({ ...error, reason }, 'fallback', 'zh-CN'))
      .toBe(messageForPublicError(error, 'zh-CN'));
  });
});
