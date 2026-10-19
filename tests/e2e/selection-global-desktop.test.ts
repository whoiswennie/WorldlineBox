import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi; llm: WorldlineBoxLlmApi } };
type Wire = { store?: boolean; messages: Array<{ role: string; content: string }> };
const PASSAGE = 'Selected desktop passage: 世界线 Alpha';
const prefix = 'Unselected prefix. ';
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function request(page: Page, input: CaptureToolsRequest) {
  const response = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
  if (!response.ok) throw Error(response.error); return response;
}
async function assistant(application: ElectronApplication) {
  await expect.poll(() => application.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 15000 }).toBe(true);
  const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
  await expect(tool.locator('[data-selection-assistant]')).toBeVisible(); return tool;
}
async function selectionLayout(tool: Page) {
  return tool.evaluate(() => {
    const conversation = document.querySelector<HTMLElement>('.selection-conversation')!;
    const bounds = (element: Element) => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect(); return { left, top, right, bottom, width, height };
    };
    return { source: bounds(document.querySelector('.selection-source')!), conversation: bounds(conversation), composer: bounds(document.querySelector('.selection-composer')!),
      articles: [...document.querySelectorAll('.selection-messages article')].map(bounds), scrollTop: conversation.scrollTop, clientHeight: conversation.clientHeight, scrollHeight: conversation.scrollHeight,
      viewport: { width: innerWidth, height: innerHeight } };
  });
}
function assertSelectionLayout(layout: Awaited<ReturnType<typeof selectionLayout>>, nativeContent: number[], allMessages: boolean) {
  expect(layout.source.bottom).toBeLessThanOrEqual(layout.conversation.top + .5);
  expect(layout.conversation.bottom).toBeLessThanOrEqual(layout.composer.top + .5);
  expect(layout.conversation.height).toBeGreaterThan(0);
  expect(Math.abs(layout.viewport.width - nativeContent[0]!)).toBeLessThanOrEqual(2); expect(Math.abs(layout.viewport.height - nativeContent[1]!)).toBeLessThanOrEqual(2);
  for (const bounds of [layout.source, layout.conversation, layout.composer]) {
    expect(bounds.left).toBeGreaterThanOrEqual(-.5); expect(bounds.top).toBeGreaterThanOrEqual(-.5);
    expect(bounds.right).toBeLessThanOrEqual(nativeContent[0]! + 2); expect(bounds.bottom).toBeLessThanOrEqual(nativeContent[1]! + 2);
  }
  if (allMessages) {
    expect(layout.articles).toHaveLength(4); expect(layout.scrollTop).toBe(0); expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
    for (const bounds of layout.articles) {
      expect(bounds.top).toBeGreaterThanOrEqual(layout.conversation.top - .5); expect(bounds.bottom).toBeLessThanOrEqual(layout.conversation.bottom + .5);
      expect(bounds.left).toBeGreaterThanOrEqual(layout.conversation.left - .5); expect(bounds.right).toBeLessThanOrEqual(layout.conversation.right + .5);
    }
  }
}
function nativeFixture(root: string): ChildProcess {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedSelectionFixture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Hotkey() {
    byte[] keys = { 0x11, 0x12, 0x10, 0x7A };
    try { foreach (byte key in keys) keybd_event(key, 0, 0, UIntPtr.Zero); }
    finally { for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero); }
  }
}
'@
$form = [System.Windows.Window]::new(); $form.Title = '自动验收临时样本 · 测试后自动关闭'
$form.Width = 650; $form.Height = 250; $form.WindowStartupLocation = 'CenterScreen'
$panel = [System.Windows.Controls.StackPanel]::new(); $panel.Margin = [System.Windows.Thickness]::new(22)
$label = [System.Windows.Controls.TextBlock]::new(); $label.Text = '自动验收临时样本 · 测试后自动关闭'; $label.Margin = [System.Windows.Thickness]::new(0,0,0,18)
$normal = [System.Windows.Controls.TextBox]::new(); $normal.FontSize = 18; $normal.Text = ${quote(prefix + PASSAGE + '. Unselected suffix.')}
$password = [System.Windows.Controls.PasswordBox]::new(); $password.Password = 'fixture-password-never-export'; $password.Margin = [System.Windows.Thickness]::new(0,18,0,0)
[void]$panel.Children.Add($label); [void]$panel.Children.Add($normal); [void]$panel.Children.Add($password); $form.Content = $panel
$command = ${quote(path.join(root, 'command.txt'))}; $ready = ${quote(path.join(root, 'ready.json'))}
$timer = [System.Windows.Threading.DispatcherTimer]::new(); $timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.add_Tick({
  if (-not [System.IO.File]::Exists($command)) { return }
  $mode = [System.IO.File]::ReadAllText($command); [System.IO.File]::Delete($command)
  if ($mode -eq 'quit') { $form.Close(); return }
  $handle = [System.Windows.Interop.WindowInteropHelper]::new($form).EnsureHandle()
  $foreground = [OwnedSelectionFixture]::GetForegroundWindow(); [uint32]$foregroundProcess = 0
  $foregroundThread = [OwnedSelectionFixture]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
  $thread = [OwnedSelectionFixture]::GetCurrentThreadId()
  $attached = $thread -ne $foregroundThread -and [OwnedSelectionFixture]::AttachThreadInput($thread, $foregroundThread, $true)
  try {
    [void][OwnedSelectionFixture]::BringWindowToTop($handle); [void][OwnedSelectionFixture]::SetForegroundWindow($handle)
    [void]$form.Activate(); [void][OwnedSelectionFixture]::SetFocus($handle)
    if ($mode -eq 'password') { [void]$password.Focus(); [void][System.Windows.Input.Keyboard]::Focus($password); $password.SelectAll() }
    else { [void]$normal.Focus(); [void][System.Windows.Input.Keyboard]::Focus($normal); $normal.Select(${prefix.length}, $(if ($mode -eq 'empty') { 0 } else { ${PASSAGE.length} })) }
  } finally { if ($attached) { [void][OwnedSelectionFixture]::AttachThreadInput($thread, $foregroundThread, $false) } }
  $state = @{ mode = $mode; process = $PID; foreground = [OwnedSelectionFixture]::GetForegroundWindow() -eq $handle }
  [System.IO.File]::WriteAllText($ready, ($state | ConvertTo-Json -Compress))
  if ($mode -ne 'focus') { Start-Sleep -Milliseconds 100; [OwnedSelectionFixture]::Hotkey() }
})
$form.add_ContentRendered({ $timer.Start(); [Console]::WriteLine('READY') })
[void]$form.ShowDialog()
`;
  return spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function command(root: string, mode: 'normal' | 'empty' | 'password' | 'focus') {
  const ready = path.join(root, 'ready.json'); if (existsSync(ready)) rmSync(ready);
  writeFileSync(path.join(root, 'command.txt'), mode);
  await expect.poll(() => existsSync(ready) ? JSON.parse(readFileSync(ready, 'utf8')) as { mode: string; foreground: boolean; process: number } : undefined,
    { timeout: 10000 }).toMatchObject({ mode, foreground: true });
  return JSON.parse(readFileSync(ready, 'utf8')) as { process: number };
}
function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-global-selection-')) throw Error('Unexpected native selection fixture cleanup path');
  rmSync(target, { force: true, recursive: true, maxRetries: 8, retryDelay: 400 });
}

// The product's unmodified native reader runs against a separate OS process.
// No webContents selection, clipboard fallback or synthetic IPC launch is used.
// eslint-disable-next-line no-empty-pattern
test('a real global hotkey reads external desktop selection, keeps a compact normal window and refuses native password/empty selections', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'The external native foreground selection reader is verified on Windows.'); test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-global-selection-'));
  const received: Wire[] = [];
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === 'POST' && incoming.url === '/native-model/chat/completions') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const input of incoming) { bytes += input.length; if (bytes > 150000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(Buffer.from(input)); }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire; received.push(wire);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: received.length > 1 ? '第二轮：保留了前一轮上下文。' : '第一轮：这是来自外部桌面应用的选中文字。' } }] })); return;
    }
    if (incoming.url === '/native-model/models') { outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ data: [{ id: 'native-selection-fixture' }] })); return; }
    outgoing.writeHead(404); outgoing.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local selection model address');
  let application: ElectronApplication | undefined; let fixture: ChildProcess | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }) });
    const main = await application.firstWindow(); await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    expect((await main.evaluate(baseUrl => (globalThis as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'native-selection-fixture', baseUrl, apiKey: 'native-selection-fixture-key' }), `http://127.0.0.1:${address.port}/native-model`)).ok).toBe(true);
    const settings = (await request(main, { type: 'state' })).state!.settings;
    const updated = await request(main, { type: 'settings.save', settings: { ...settings, hideApp: true, shortcuts: { ...settings.shortcuts, selection: 'Control+Alt+Shift+F11' } } });
    expect(updated.state!.shortcuts.find(value => value.task === 'selection')).toMatchObject({ registered: true });
    const clipboardBefore = await application.evaluate(({ clipboard }) => clipboard.readText());
    fixture = nativeFixture(root); let stderr = ''; fixture.stderr?.on('data', data => { stderr += String(data); });
    await new Promise<void>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error('Native fixture did not load: ' + stderr.slice(0, 1000))), 10000);
      fixture!.stdout?.on('data', data => { output += String(data); if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
      fixture!.once('error', cause => { clearTimeout(timer); reject(cause); }); fixture!.once('exit', code => { clearTimeout(timer); reject(Error('Native fixture exited: ' + code + ' ' + stderr.slice(0, 1000))); });
    });
    const native = await command(root, 'normal'); expect(native.process).toBe(fixture.pid); expect(native.process).not.toBe(application.process().pid);
    let tool = await assistant(application);
    expect((await request(tool, { type: 'context' })).text).toBe(PASSAGE);
    expect(received).toHaveLength(0);
    const question = tool.getByRole('textbox', { name: '关于这段文字，想问什么？', exact: true });
    await question.fill('请解释。'); await question.press('Enter'); await expect(tool.locator('.selection-messages article.is-assistant')).toHaveCount(1);
    await question.fill('继续举例。'); await question.press('Enter'); await expect(tool.locator('.selection-messages article.is-assistant')).toHaveCount(2);
    expect(received).toHaveLength(2); expect(received[1]!.store).toBe(false); expect(received[1]!.messages.map(value => value.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.parse(received[1]!.messages[1]!.content)).toEqual({ selected_text: PASSAGE, question: '请解释。' });
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(clipboardBefore);
    let window = await application.browserWindow(tool);
    const geometry = await window.evaluate(window => ({ bounds: window.getBounds(), pinned: window.isAlwaysOnTop(), resizable: window.isResizable() }));
    expect(geometry).toMatchObject({ pinned: false, resizable: true });
    // Windows may add a few DIP of native resize/shadow rounding at fractional
    // desktop scale. The visible panel must stay small, rather than a workbench.
    expect(Math.abs(geometry.bounds.width - 420)).toBeLessThanOrEqual(4); expect(Math.abs(geometry.bounds.height - 520)).toBeLessThanOrEqual(4);
    const appearance = await tool.evaluate(() => {
      const root = document.querySelector('.selection-assistant')!; const text = document.querySelector('.selection-messages article p')!;
      const input = document.querySelector('.selection-composer textarea')!; const header = root.querySelector('header')!; const pin = root.querySelector('.selection-pin')!;
      const style = (element: Element) => ({ family: getComputedStyle(element).fontFamily, appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
        resize: getComputedStyle(element).resize, fieldSizing: getComputedStyle(element).getPropertyValue('field-sizing'), bounds: element.getBoundingClientRect().toJSON() });
      Reflect.set(globalThis, '__selectionPinClicks', 0);
      pin.addEventListener('click', () => Reflect.set(globalThis, '__selectionPinClicks', Number(Reflect.get(globalThis, '__selectionPinClicks')) + 1));
      return { platform: document.documentElement.dataset.platform, uiFont: getComputedStyle(root).getPropertyValue('--ui-font-family'), supportsFieldSizing: CSS.supports('field-sizing', 'content'),
        root: style(root), text: style(text), input: style(input), header: style(header), pin: style(pin), sheets: [...document.styleSheets].map(sheet => sheet.href) };
    });
    expect(appearance.root.family).toContain('Segoe UI'); expect(appearance.text.family).toBe(appearance.root.family); expect(appearance.input.family).toBe(appearance.root.family);
    expect(appearance.supportsFieldSizing).toBe(true); expect(appearance.input.resize).toBe('none'); expect(appearance.input.fieldSizing).toBe('content');
    await tool.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const defaultLayout = await selectionLayout(tool); const defaultContentSize = await window.evaluate(window => window.getContentSize());
    assertSelectionLayout(defaultLayout, defaultContentSize, true);
    const viewport = await tool.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
    const frame = await window.evaluate(async window => ({ png: (await window.webContents.capturePage()).toPNG().toString('base64'), bounds: window.getBounds(), contentSize: window.getContentSize() }));
    const png = Buffer.from(frame.png, 'base64'); const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    expect(Math.abs(viewport.height - frame.contentSize[1])).toBeLessThanOrEqual(2);
    expect(Math.abs(pixels.width - viewport.width * viewport.scale)).toBeLessThanOrEqual(3); expect(Math.abs(pixels.height - viewport.height * viewport.scale)).toBeLessThanOrEqual(3);
    writeFileSync('artifacts/selection-floating-final.png', png);
    await window.evaluate(window => window.setSize(340, 360));
    await expect.poll(() => tool.evaluate(() => ({ width: innerWidth < 346, height: innerHeight < 366 }))).toEqual({ width: true, height: true });
    await tool.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const minimumLayout = await selectionLayout(tool); const minimumContentSize = await window.evaluate(window => window.getContentSize());
    assertSelectionLayout(minimumLayout, minimumContentSize, false);
    await window.evaluate((window, bounds) => window.setBounds(bounds), geometry.bounds);
    await expect.poll(() => tool.evaluate(() => ({ width: innerWidth > 410, height: innerHeight > 510 }))).toEqual({ width: true, height: true });
    await tool.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const nativeBefore = await window.evaluate(window => ({ focused: window.isFocused(), pinned: window.isAlwaysOnTop() }));
    console.log('SELECTION_UI_DIAGNOSTIC', JSON.stringify({ appearance, nativeBefore, defaultLayout, minimumLayout, minimumContentSize,
      preview: { path: 'artifacts/selection-floating-final.png', viewport, pixels, bounds: frame.bounds, contentSize: frame.contentSize }, appPath: await application.evaluate(({ app }) => app.getAppPath()) }));
    await tool.getByRole('button', { name: '保持在最前面', exact: true }).click();
    await expect.poll(async () => ({ native: await window.evaluate(window => window.isAlwaysOnTop()), service: (await request(tool, { type: 'state' })).state!.selectionPinned,
      aria: await tool.locator('.selection-pin').getAttribute('aria-pressed'), clicks: await tool.evaluate(() => Reflect.get(globalThis, '__selectionPinClicks')), errors: await tool.locator('.selection-error').allTextContents() }))
      .toMatchObject({ native: true, service: true, aria: 'true', clicks: 1 });
    await tool.getByRole('button', { name: '取消置顶', exact: true }).click(); await expect.poll(() => window.evaluate(window => window.isAlwaysOnTop())).toBe(false);
    await command(root, 'focus'); await expect.poll(() => window.evaluate(window => window.isFocused())).toBe(false);
    expect(await window.evaluate(window => window.isAlwaysOnTop())).toBe(false);
    await tool.getByRole('button', { name: '关闭', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    for (const mode of ['password', 'empty'] as const) {
      await command(root, mode); tool = await assistant(application); expect((await request(tool, { type: 'context' })).text).toBe('');
      await expect(tool.getByRole('textbox', { name: '选中的文字', exact: true })).toHaveValue('');
      await expect(tool.locator('.selection-messages article')).toHaveCount(0); expect(received).toHaveLength(2);
      expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(clipboardBefore);
      window = await application.browserWindow(tool); expect(await window.evaluate(window => window.isAlwaysOnTop())).toBe(false);
      await tool.getByRole('button', { name: '关闭', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    }
    const evidence = { separateNativeProcess: true, realOsGlobalShortcut: true, exactPartialText: true, clipboardUnchanged: true,
      nativePasswordRejected: true, emptySelectionDoesNotReadWholeDocument: true, defaultBounds: geometry.bounds, defaultTopmost: false, explicitPinAndUnpin: true, yieldsFocusToOtherApps: true,
      temporaryTwoTurnGlobalModel: true, twoTurnsFullyVisibleAtDefaultSize: true, minimumWindowHasNoOverlappingPanels: true };
    console.log('GLOBAL_DESKTOP_SELECTION_RESULT', JSON.stringify(evidence)); await testInfo.attach('global-desktop-selection', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } finally {
    if (fixture) {
      fixture.kill(); await new Promise<void>(resolve => { if (fixture!.exitCode !== null) resolve(); else { fixture!.once('close', () => resolve()); const timer = setTimeout(resolve, 2000); timer.unref(); } });
    }
    await application?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); cleanup(root);
  }
});
