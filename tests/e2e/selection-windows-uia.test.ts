import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { readFocusedSelectedText } from '../../src/main/capture-tools/selected-text';

const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encoded = (script: string) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
function clipboardSequence(): string {
  const script = 'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class ClipboardSequenceProbe { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }\'; [Console]::Write([ClipboardSequenceProbe]::GetClipboardSequenceNumber())';
  const result = spawnSync(powershell, encoded(script), { windowsHide: true, encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0 || !/^\d+$/u.test(result.stdout)) throw Error('Could not inspect clipboard sequence counter'); return result.stdout;
}
async function selectedFixture(mode: 'rich' | 'password') {
  const title = 'WorldlineBoxSelectionFixture-' + randomUUID();
  const expected = mode === 'rich' ? 'Selected sample: 世界线 Alpha' : '';
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SelectionFixtureWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window); [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr window); }'
$form = [System.Windows.Window]::new()
$form.Title = '${title}'; $form.Width = 620; $form.Height = 190; $form.Topmost = $true
$control = ${mode === 'rich' ? '[System.Windows.Controls.TextBox]::new()' : '[System.Windows.Controls.PasswordBox]::new()'}
[System.Windows.Automation.AutomationProperties]::SetAutomationId($control, 'WorldlineBoxSelectionControl')
$control.FontSize = 18
${mode === 'rich' ? "$control.Text = 'Known prefix. Selected sample: 世界线 Alpha. Known suffix.'" : "$control.Password = 'fixture-password-never-export'"}
$form.Content = $control
$timer = [System.Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [TimeSpan]::FromMilliseconds(600)
$timer.add_Tick({
  $timer.Stop()
  $foreground = [SelectionFixtureWindow]::GetForegroundWindow(); [uint32]$foregroundProcess = 0
  $foregroundThread = [SelectionFixtureWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
  $thread = [SelectionFixtureWindow]::GetCurrentThreadId()
  $attached = $thread -ne $foregroundThread -and [SelectionFixtureWindow]::AttachThreadInput($thread, $foregroundThread, $true)
  $handle = [System.Windows.Interop.WindowInteropHelper]::new($form).EnsureHandle()
  try {
    [void][SelectionFixtureWindow]::ShowWindow($handle, 5); [void][SelectionFixtureWindow]::BringWindowToTop($handle)
    [void][SelectionFixtureWindow]::SetForegroundWindow($handle); [void]$form.Activate(); [void][SelectionFixtureWindow]::SetFocus($handle); [void]$control.Focus(); [void][System.Windows.Input.Keyboard]::Focus($control)
  } finally { if ($attached) { [void][SelectionFixtureWindow]::AttachThreadInput($thread, $foregroundThread, $false) } }
  ${mode === 'rich' ? '$control.Select(14, ' + expected.length + ')' : '$control.SelectAll()'}
  [Console]::WriteLine('FIXTURE:' + $form.IsVisible + ':' + $control.IsVisible + ':' + $control.Focusable + ':' + ([SelectionFixtureWindow]::GetForegroundWindow() -eq $handle))
  [Console]::WriteLine('READY:' + $handle.ToInt64() + ':' + $handle.ToInt64())
})
$form.add_ContentRendered({ $timer.Start() })
[void]$form.ShowDialog()
`;
  const fixture = spawn(powershell, encoded(script), { windowsHide: false, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    let controlHandle = ''; let fixtureDiagnostic = '';
    await new Promise<void>((resolve, reject) => {
      let ready = ''; const timer = setTimeout(() => reject(Error('Owned selection fixture did not become ready')), 7000);
      fixture.stdout.on('data', data => { ready += String(data); const handles = /READY:(\d+):(\d+)/u.exec(ready); if (handles) { controlHandle = handles[2]!; fixtureDiagnostic = /FIXTURE:[A-Za-z:]+/u.exec(ready)?.[0] ?? ''; clearTimeout(timer); resolve(); } });
      fixture.once('error', () => { clearTimeout(timer); reject(Error('Owned selection fixture could not start')); });
      fixture.once('close', () => { clearTimeout(timer); reject(Error('Owned selection fixture exited before readiness')); });
    });
    const clipboardBefore = clipboardSequence();
    let diagnostic = '';
    // The production helper is unchanged. This test-only precondition refuses
    // to inspect another application's control if foreground focus changes.
    const guard = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ownedWindow = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]${controlHandle})
$ownedControl = $ownedWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'WorldlineBoxSelectionControl'))
if ($null -eq $ownedControl -or $ownedControl.Current.ProcessId -ne ${fixture.pid}) { [Console]::Error.WriteLine('control=false'); exit 0 }
if (-not $ownedControl.Current.HasKeyboardFocus) { $ownedControl.SetFocus() }
Start-Sleep -Milliseconds 150
$node = [System.Windows.Automation.AutomationElement]::FocusedElement
$owned = $null -ne $node -and $node.Current.ProcessId -eq ${fixture.pid}
if (-not $owned) { [Console]::Error.WriteLine('owned=false'); exit 0 }
[Console]::Error.WriteLine('owned=true')
[Console]::Error.WriteLine('password=' + $node.Current.IsPassword)
`;
    const text = await readFocusedSelectedText({ spawnFn: ((executable, args, options) => {
      const parameters = [...args ?? []]; const script = Buffer.from(parameters.at(-1)!, 'base64').toString('utf16le');
      parameters[parameters.length - 1] = Buffer.from(guard + '\n' + script, 'utf16le').toString('base64');
      const child = spawn(executable, parameters, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.on('data', data => { diagnostic += String(data); }); return child;
    }) as typeof spawn });
    return { mode, selectedOnly: text === expected, passwordEmpty: mode !== 'password' || text === '', clipboardUnchanged: clipboardBefore === clipboardSequence(),
      ownedForeground: diagnostic.includes('owned=true'), passwordControl: diagnostic.includes('password=True'), fixtureVisibleAndFocused: fixtureDiagnostic === 'FIXTURE:True:True:True:True' };
  } finally {
    fixture.kill(); await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once('close', () => resolve()); const timer = setTimeout(resolve, 2000); timer.unref(); } });
  }
}

// No fixture text or unexpected foreground contents are printed or attached.
// eslint-disable-next-line no-empty-pattern
test('Windows UI Automation reads only selected ranges, refuses password fields and leaves clipboard untouched', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Native UI Automation is Windows only'); test.setTimeout(30000);
  const rich = await selectedFixture('rich'); expect(rich.ownedForeground).toBe(true); expect(rich.selectedOnly).toBe(true); expect(rich.clipboardUnchanged).toBe(true);
  const password = await selectedFixture('password'); expect(password.ownedForeground).toBe(true); expect(password.passwordControl).toBe(true); expect(password.passwordEmpty).toBe(true); expect(password.clipboardUnchanged).toBe(true);
  await testInfo.attach('native-selection-evidence', { body: JSON.stringify({ rich, password, clipboardMutation: false, keyboardInjection: false }), contentType: 'application/json' });
});
