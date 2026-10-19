import path from 'node:path';
import { spawn } from 'node:child_process';
import { CAPTURE_SELECTION_MAX_BYTES } from '../../shared/capture-tools';

/** Fixed UI Automation code. Only selected ranges in the foreground control or
 * its owning text container are read; no clipboard or document-wide fallback. */
export const WINDOWS_SELECTED_TEXT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SelectionForeground {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo {
    public uint Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  public static IntPtr Focus(IntPtr foreground) {
    uint process; uint thread = GetWindowThreadProcessId(foreground, out process);
    var info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
    return GetGUIThreadInfo(thread, ref info) ? info.Focus : IntPtr.Zero;
  }
}
'@
  $foreground = [SelectionForeground]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { exit 0 }
  $text = [System.Text.StringBuilder]::new()
  # Chromium and document editors can expose focus on a link, inline child or
  # nested HWND rather than on the text provider. Ascend only that focus chain,
  # never search unrelated windows or fall back to a whole document's value.
  for ($attempt = 0; $attempt -lt 3 -and $text.Length -eq 0; $attempt++) {
    if ([SelectionForeground]::GetForegroundWindow() -ne $foreground) { exit 0 }
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $nativeFocus = [SelectionForeground]::Focus($foreground)
    $roots = @($focused)
    if ($nativeFocus -ne [IntPtr]::Zero) { $roots += [System.Windows.Automation.AutomationElement]::FromHandle($nativeFocus) }
    foreach ($root in $roots) {
      if ($null -eq $root) { continue }
      $chain = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
      $ancestor = $root; $owned = $false
      for ($i = 0; $i -lt 24 -and $null -ne $ancestor; $i++) {
        if ($ancestor.Current.IsPassword) { exit 0 }
        $chain.Add($ancestor)
        $native = [IntPtr]$ancestor.Current.NativeWindowHandle
        if ($native -ne [IntPtr]::Zero -and [SelectionForeground]::GetAncestor($native, 2) -eq $foreground) { $owned = $true }
        if ($native -eq $foreground) { break }
        $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
      }
      if (-not $owned) { continue }
      foreach ($candidate in $chain) {
        $pattern = $null
        if (-not $candidate.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { continue }
        $ranges = $pattern.GetSelection()
        if ($null -eq $ranges) { continue }
        for ($i = 0; $i -lt [Math]::Min($ranges.Length, 32); $i++) {
          $part = $ranges[$i].GetText(32769)
          if (-not [string]::IsNullOrEmpty($part)) {
            if ($text.Length -gt 0) { [void]$text.Append([Environment]::NewLine) }
            [void]$text.Append($part)
            if ($text.Length -gt 32768) { break }
          }
        }
        if ($text.Length -gt 0) { break }
      }
      if ($text.Length -gt 0) { break }
    }
    if ($text.Length -eq 0 -and $attempt -lt 2) { Start-Sleep -Milliseconds 60 }
  }
  if ([SelectionForeground]::GetForegroundWindow() -ne $foreground) { exit 0 }
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
/** Reads only the foreground control/container's selected TextPattern ranges. Failure or
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
