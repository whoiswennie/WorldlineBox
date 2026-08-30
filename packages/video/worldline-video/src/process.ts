import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

const STDOUT_LIMIT = 24 * 1024 * 1024
const STDERR_LIMIT = 4 * 1024 * 1024

/** Result from a bounded managed child process. */
export interface CommandResult {
  stdout: string
  stderr: string
  outcome: SubprocessOutcome
}

/**
 *  Run a fixed argv vector through Worldline's managed subprocess service.
 * @param ctx - Cordis context that owns the operation.
 * @param argv - argv value.
 * @param cwd - cwd value.
 * @param signal - Cancellation signal for the operation.
 * @returns The resulting value.
 */
export async function runCommand(
  ctx: Context,
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STDOUT_LIMIT },
      stderr: { maxBytes: STDERR_LIMIT },
    },
    graceMs: 5_000,
    ...(signal === undefined ? {} : { signal }),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new Error('video command returned no collected output')
  if (stdout.lossy || stderr.lossy) throw new Error('video command output exceeded its safety limit')
  return { stdout: stdout.text, stderr: stderr.text, outcome }
}

/**
 *  Require a successful command and include a bounded diagnostic on failure.
 * @param command - command value.
 * @param result - result value.
 * @returns The resulting value.
 */
export function requireSuccess(command: string, result: CommandResult): string {
  if (result.outcome.exitCode === 0 && result.outcome.signal === null) return result.stdout
  const detail = result.stderr.trim().slice(-4_000)
  throw new Error(
    `${command} failed (${result.outcome.signal ?? `exit ${result.outcome.exitCode ?? 'unknown'}`})`
      + (detail.length > 0 ? `: ${detail}` : ''),
  )
}
