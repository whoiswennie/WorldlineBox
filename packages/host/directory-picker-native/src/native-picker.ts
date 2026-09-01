/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import type { PathPickerRequest } from '@deepseek-ai/dsh-host-directory-picker'
import { pickWin32Path } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Path`) for deterministic tests. */
  pickWin32Dialog?: (request: PathPickerRequest, signal: AbortSignal) => Promise<string | null>
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 * @param request - The request supplied by the caller.
 */
export async function pickNativePath(
  request: PathPickerRequest,
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    try {
      const escapedTitle = request.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      const escapedName = request.mode === 'save-file'
        ? request.suggestedName.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
        : ''
      const script = request.mode === 'directory'
        ? `set selectedPath to choose folder with prompt "${escapedTitle}"`
        : request.mode === 'open-file'
          ? `set selectedPath to choose file with prompt "${escapedTitle}"`
          : `set selectedPath to choose file name with prompt "${escapedTitle}" default name "${escapedName}"`
      const result = await run('osascript', ['-e', script, '-e', 'POSIX path of selectedPath'], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (!signal.aborted && errorCode(error) === 1
        && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is, with no PowerShell fallback tier.
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Path
    return await pickDialog(request, signal)
  }

  if (platform === 'linux') {
    try {
      const args = ['--file-selection', `--title=${request.title}`]
      if (request.mode === 'directory') args.push('--directory')
      if (request.mode === 'save-file') args.push('--save', '--confirm-overwrite', `--filename=${request.suggestedName}`)
      for (const extension of request.mode === 'directory' ? [] : request.extensions) {
        args.push(`--file-filter=*.${extension}`)
      }
      const result = await run('zenity', args, signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const command = request.mode === 'directory'
        ? ['--getexistingdirectory', '.']
        : request.mode === 'open-file'
          ? ['--getopenfilename', '.', request.extensions.map(value => `*.${value}`).join(' ')]
          : ['--getsavefilename', request.suggestedName, request.extensions.map(value => `*.${value}`).join(' ')]
      const result = await run('kdialog', [...command, '--title', request.title], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native path picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native path picker is unsupported on ${platform}`)
}
