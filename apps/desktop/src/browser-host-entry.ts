import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Marker inherited by the Agent runtime and then by a community browser
 * plugin.  A packaged Electron executable normally ignores a JavaScript path
 * passed on its command line and launches its own app again; this marker lets
 * the desktop entry hand that child launch to the plugin's host-main module.
 */
export const BROWSER_HOST_ENTRY_ENV = 'WORLDLINE_BROWSER_HOST_ENTRY'

/** Resolve the dsh-builtin-browser child entry from a packaged app launch. */
export function browserHostEntry(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (environment[BROWSER_HOST_ENTRY_ENV] !== '1') return undefined

  const rpcPort = argv.indexOf('--rpc-port')
  if (rpcPort <= 0) return undefined
  const candidate = argv[rpcPort - 1]
  if (candidate === undefined || basename(candidate).toLowerCase() !== 'host-main.js') return undefined
  return candidate
}

/** Load the community plugin's Electron main-process entry in this process. */
export async function runBrowserHostEntry(entry: string): Promise<void> {
  await import(pathToFileURL(entry).href)
}
