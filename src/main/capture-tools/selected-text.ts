import path from 'node:path';
import { spawn } from 'node:child_process';
import { CAPTURE_SELECTION_MAX_BYTES } from '../../shared/capture-tools';

/** Fixed UI Automation code. No user text, clipboard calls, keyboard injection,
 * ValuePattern, or document-wide text reads are interpolated into this script. */
export const WINDOWS_SELECTED_TEXT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $focused) { exit 0 }
  $ancestor = $focused
  for ($i = 0; $i -lt 12 -and $null -ne $ancestor; $i++) {
    if ($ancestor.Current.IsPassword) { exit 0 }
    $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
  }
  $pattern = $null
  if (-not $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { exit 0 }
  $ranges = $pattern.GetSelection()
  if ($null -eq $ranges) { exit 0 }
  $text = [System.Text.StringBuilder]::new()
  for ($i = 0; $i -lt [Math]::Min($ranges.Length, 32); $i++) {
    $part = $ranges[$i].GetText(32769)
    if (-not [string]::IsNullOrEmpty($part)) {
      if ($text.Length -gt 0) { [void]$text.Append([Environment]::NewLine) }
      [void]$text.Append($part)
      if ($text.Length -gt 32768) { break }
    }
  }
  $value = $text.ToString().Replace([string][char]0, '')
  $encoding = [System.Text.UTF8Encoding]::new($false)
  if ($encoding.GetByteCount($value) -gt 32768) {
    $low = 0; $high = $value.Length
    while ($low -lt $high) {
      $mid = [int][Math]::Ceiling(($low + $high) / 2.0)
      if ($encoding.GetByteCount($value.Substring(0, $mid)) -le 32768) { $low = $mid } else { $high = $mid - 1 }
    }
    if ($low -gt 0 -and [char]::IsHighSurrogate($value[$low - 1])) { $low-- }
    $value = $value.Substring(0, $low)
  }
  [Console]::OutputEncoding = $encoding
  [Console]::Write($value)
} catch { exit 0 }
`;

export function boundedSelectionText(value: string): string {
  const text = value.replaceAll('\0', ''); const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= CAPTURE_SELECTION_MAX_BYTES ? text : bytes.subarray(0, CAPTURE_SELECTION_MAX_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
}
export interface SelectedTextOptions { platform?: NodeJS.Platform; timeoutMs?: number; spawnFn?: typeof spawn }
/** Reads only the foreground control's selected TextPattern ranges. Failure or
 * unsupported applications return an editable empty prompt without changing
 * focus or touching the clipboard. Only this owned helper is terminated. */
export function readFocusedSelectedText(options: SelectedTextOptions = {}): Promise<string> {
  if ((options.platform ?? process.platform) !== 'win32') return Promise.resolve('');
  return new Promise(resolve => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(WINDOWS_SELECTED_TEXT_SCRIPT, 'utf16le').toString('base64');
    let child: ReturnType<typeof spawn>;
    try { child = (options.spawnFn ?? spawn)(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(''); return; }
    const chunks: Buffer[] = []; let received = 0; let settled = false;
    const killOwnedHelper = () => { try { child.kill(); } catch { /* The owned helper may have already exited. */ } };
    const onExit = () => { finish(''); killOwnedHelper(); };
    const finish = (text: string) => { if (settled) return; settled = true; clearTimeout(timer); process.removeListener('exit', onExit); resolve(text); };
    const timer = setTimeout(() => { finish(''); killOwnedHelper(); }, Math.min(3000, Math.max(1, options.timeoutMs ?? 3000))); timer.unref();
    // A provider can block in native UI Automation. Main's timeout cannot fire
    // after Electron has exited, so terminate this one owned process at exit.
    process.once('exit', onExit);
    child.stdout?.on('data', (input: Buffer | string) => {
      if (settled) return; const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'); received += bytes.length;
      if (received > CAPTURE_SELECTION_MAX_BYTES) { finish(''); killOwnedHelper(); return; } chunks.push(bytes);
    });
    child.once('error', () => finish(''));
    child.once('close', code => finish(code === 0 ? boundedSelectionText(Buffer.concat(chunks).toString('utf8')) : ''));
  });
}
