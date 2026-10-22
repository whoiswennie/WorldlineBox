import type { McpSettingsResponse } from '../shared/mcp';
import type { TranslateFn } from './i18n/LocaleProvider';

type McpSettingsFailure = Extract<McpSettingsResponse, { ok: false }>;

export function formatMcpSettingsFailure(
  failure: McpSettingsFailure,
  t: TranslateFn,
): string {
  const filePath = failure.details?.filePath ?? '';
  const systemCode = failure.details?.systemCode ?? 'unknown';

  switch (failure.code) {
    case 'MCP_CREDENTIAL_ACCESS_DENIED':
      return failure.details?.recoveryCode
        ? t('settings.mcpCredentialAccessDenied', {
          path: filePath,
          systemCode,
          recoveryCode: failure.details.recoveryCode,
        })
        : t('settings.mcpCredentialAccessDeniedGeneric', { path: filePath, systemCode });
    case 'MCP_CREDENTIAL_INVALID':
      return t('settings.mcpCredentialInvalid', { path: filePath });
    case 'MCP_CREDENTIAL_READ_FAILED':
      return t('settings.mcpCredentialReadFailed', { path: filePath, systemCode });
    case 'MCP_CREDENTIAL_CREATE_FAILED':
      return t('settings.mcpCredentialCreateFailed', { path: filePath, systemCode });
    case 'MCP_CREDENTIAL_ACL_FAILED':
      return failure.details?.recoveryCode
        ? t('settings.mcpCredentialAclCleanupFailed', {
          path: filePath,
          systemCode,
          cleanupCode: failure.details.recoveryCode,
        })
        : t('settings.mcpCredentialAclFailed', { path: filePath, systemCode });
    default:
      return failure.message;
  }
}
