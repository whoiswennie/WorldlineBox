import { describe, expect, it } from 'vitest';

import { catalogs } from '../../src/renderer/i18n/catalogs';
import { createTranslator } from '../../src/renderer/i18n/types';
import { formatMcpSettingsFailure } from '../../src/renderer/mcp-settings-error';

describe('MCP settings initialization diagnostics', () => {
  it('shows the permission error, repair result, and key file location in Chinese', () => {
    const failure = {
      ok: false as const,
      code: 'MCP_CREDENTIAL_ACCESS_DENIED',
      message: 'Could not restore access.',
      details: {
        filePath: 'user-data/mcp-client-credential-pepper',
        systemCode: 'EPERM',
        recoveryCode: '5',
      },
    };

    const message = formatMcpSettingsFailure(failure, createTranslator(catalogs['zh-CN']));

    expect(message).toContain('EPERM');
    expect(message).toContain('5');
    expect(message).toContain('user-data/mcp-client-credential-pepper');
    expect(message).toContain('保留了原文件和密钥');
  });

  it('explains why an invalid key is not silently recreated in English', () => {
    const failure = {
      ok: false as const,
      code: 'MCP_CREDENTIAL_INVALID',
      message: 'Invalid key.',
      details: { filePath: 'user-data/mcp-client-credential-pepper' },
    };

    const message = formatMcpSettingsFailure(failure, createTranslator(catalogs.en));

    expect(message).toContain('did not recreate it');
    expect(message).toContain('user-data/mcp-client-credential-pepper');
  });
});
