import {
  ACCOUNT_RUNTIME_RESTART_EXIT_CODE,
  createManagedAccountLaunch,
  type ManagedAccountLaunch,
} from '@deepseek-ai/dsh-local-auth'
import { resolveWorldlineHome } from '@deepseek-ai/dsh-home-paths'

export const TENANT_RESTART_EXIT_CODE = ACCOUNT_RUNTIME_RESTART_EXIT_CODE

/** Resolve the shared WebUI/Electron account generation for Desktop. */
export function desktopTenantLaunch(baseHome = resolveWorldlineHome()): Promise<ManagedAccountLaunch> {
  return createManagedAccountLaunch(baseHome)
}

/** Compatibility projection retained for focused callers that only need child environment. */
export async function desktopTenantEnvironment(baseHome = resolveWorldlineHome()): Promise<NodeJS.ProcessEnv> {
  return (await desktopTenantLaunch(baseHome)).environment
}
