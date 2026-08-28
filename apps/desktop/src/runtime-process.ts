import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BROWSER_HOST_ENTRY_ENV } from './browser-host-entry.ts'

const READY_PATTERN = /worldline web: (http:\/\/[^\s]+)/

export interface RuntimeProcess {
  child: ChildProcess
  ready: Promise<string>
  /** Final process outcome with a bounded diagnostic tail. */
  exited: Promise<RuntimeExit>
  startedAt: number
  stop: () => Promise<void>
}

export interface RuntimeExit {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
}

export interface RuntimeProcessOptions {
  cwd: string
  cliEntry?: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
}

function detectedElectronExecutable(): string | undefined {
  const versions: Record<string, string | undefined> = process.versions
  return versions.electron === undefined ? undefined : process.execPath
}

function runtimeIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/** Environment bridge required when the runtime is hosted by Electron. */
export function electronRuntimeEnvironment(
  electronExecutable: string | undefined = detectedElectronExecutable(),
): NodeJS.ProcessEnv {
  if (electronExecutable === undefined) return {}
  return {
    ELECTRON_PATH: electronExecutable,
    ELECTRON_RUN_AS_NODE: '1',
    [BROWSER_HOST_ENTRY_ENV]: '1',
  }
}

/** Start the exact production CLI Web profile used outside Electron. */
export function startRuntimeProcess(options: RuntimeProcessOptions): RuntimeProcess {
  const startedAt = Date.now()
  const cliEntry = options.cliEntry ?? fileURLToPath(new URL('../../cli/lib/bin.js', import.meta.url))
  // Electron's embedded Node cannot load the ABI-specific helper used to reach
  // the ESM loader. Exposing Node internals gives the CLI loader the same
  // parent-URL-aware package resolution it has under the standalone Node CLI.
  const child = spawn(process.execPath, ['--expose-internals', cliEntry, 'web', '--port', '0', '--no-open'], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.environment,
      // The runtime itself uses Electron's embedded Node. Community browser
      // plugins need the same executable without ELECTRON_RUN_AS_NODE so it
      // can become a real Electron main process. The desktop entry recognizes
      // the inherited marker and delegates to the plugin's host-main module.
      ...electronRuntimeEnvironment(),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let settled = false
  let resolveReady!: (url: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    rejectReady(new Error(`Agent runtime did not become ready within ${options.timeoutMs ?? 90_000}ms.\n${output}`))
  }, options.timeoutMs ?? 90_000)
  timeout.unref()

  const observe = (chunk: Buffer): void => {
    // Post-readiness diagnostics matter most. Retain the tail so an eventual
    // crash is not hidden behind an old startup prefix.
    output = `${output}${chunk.toString()}`.slice(-(64 * 1024))
    if (settled) return
    const match = READY_PATTERN.exec(output)
    if (match?.[1] === undefined) return
    settled = true
    clearTimeout(timeout)
    resolveReady(match[1])
  }
  child.stdout.on('data', observe)
  child.stderr.on('data', observe)
  const exited = new Promise<RuntimeExit>((resolve) => {
    child.once('exit', (code, signal) => { resolve({ code, signal, output }) })
  })
  child.once('error', (error) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    rejectReady(error)
  })
  child.once('exit', (code, signal) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    rejectReady(new Error(`Agent runtime exited before readiness (code=${String(code)}, signal=${String(signal)}).\n${output}`))
  })

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
    child.kill('SIGTERM')
    await Promise.race([
      closed,
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ])
    if (runtimeIsRunning(child)) child.kill('SIGKILL')
  }

  return { child, ready, exited, startedAt, stop }
}
