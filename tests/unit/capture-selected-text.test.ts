import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { boundedSelectionText, readFocusedSelectedText, WINDOWS_SELECTED_TEXT_SCRIPT } from '../../src/main/capture-tools/selected-text';
import { CAPTURE_SELECTION_MAX_BYTES, captureToolsRequestSchema, captureToolsSettingsSchema, DEFAULT_CAPTURE_TOOLS_SETTINGS } from '../../src/shared/capture-tools';

function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(() => true) });
  const spawnFn = vi.fn<(command: string, args: readonly string[], options: unknown) => ReturnType<typeof spawn>>(() => child as unknown as ReturnType<typeof spawn>);
  return { child, spawnFn, read: (timeoutMs = 3000) => readFocusedSelectedText({ platform: 'win32', timeoutMs, spawnFn: spawnFn as unknown as typeof spawn }) };
}

describe('native selected text boundary', () => {
  it('runs fixed hidden STA UI Automation code and returns only captured Unicode selection bytes', async () => {
    const { child, spawnFn, read } = childFixture(); const pending = read();
    const text = '选中的文字\n$(do not execute this) 🎵'; child.stdout.emit('data', Buffer.from(text)); child.emit('close', 0);
    expect(await pending).toBe(text);
    const [executable, args, options] = spawnFn.mock.calls[0]!;
    expect(executable.toLowerCase()).toMatch(/windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/u);
    expect(options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', expect.any(String)]);
    expect(Buffer.from(args.at(-1)!, 'base64').toString('utf16le')).toBe(WINDOWS_SELECTED_TEXT_SCRIPT);
    expect(WINDOWS_SELECTED_TEXT_SCRIPT).toContain('$pattern.GetSelection()'); expect(WINDOWS_SELECTED_TEXT_SCRIPT).toContain('.Current.IsPassword');
    expect(WINDOWS_SELECTED_TEXT_SCRIPT).not.toMatch(/Clipboard|SendKeys|DocumentRange|ValuePattern|SetForegroundWindow/u);
    expect(WINDOWS_SELECTED_TEXT_SCRIPT).toContain('GetForegroundWindow'); expect(WINDOWS_SELECTED_TEXT_SCRIPT).toContain('RawViewWalker.GetParent');
    expect(args.join(' ')).not.toContain(text); expect(child.kill).not.toHaveBeenCalled();
  });

  it('returns editable empty text on unsupported platforms without launching a helper', async () => {
    const { spawnFn } = childFixture(); expect(await readFocusedSelectedText({ platform: 'linux', spawnFn: spawnFn as unknown as typeof spawn })).toBe(''); expect(spawnFn).not.toHaveBeenCalled();
  });

  it('times out and terminates only its owned helper rather than changing application focus or clipboard', async () => {
    const { child, read } = childFixture(); const pending = read(10); expect(await pending).toBe(''); expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', 0); child.stdout.emit('data', Buffer.from('late private text'));
  });

  it('terminates its pending owned helper at process exit and removes the exit listener on every completion path', async () => {
    const initial = new Set(process.listeners('exit'));
    const exiting = childFixture(); const pending = exiting.read();
    const own = process.listeners('exit').filter(listener => !initial.has(listener)); expect(own).toHaveLength(1);
    // Invoke only the newly registered listener; emitting the global exit event
    // would also run unrelated Vitest and library shutdown hooks.
    own[0]!(0); expect(await pending).toBe(''); expect(exiting.child.kill).toHaveBeenCalledOnce();
    expect(new Set(process.listeners('exit'))).toEqual(initial);
    const finished = childFixture(); const complete = finished.read(); finished.child.emit('close', 0); await complete;
    expect(new Set(process.listeners('exit'))).toEqual(initial); expect(finished.child.kill).not.toHaveBeenCalled();
    const failed = childFixture(); const error = failed.read(); failed.child.emit('error', Error('Unavailable')); await error;
    expect(new Set(process.listeners('exit'))).toEqual(initial);
    const timed = childFixture(); await timed.read(1); expect(new Set(process.listeners('exit'))).toEqual(initial);
  });

  it('rejects excessive helper output and settles benignly on process errors or nonzero exit', async () => {
    const excessive = childFixture(); const one = excessive.read(); excessive.child.stdout.emit('data', Buffer.alloc(CAPTURE_SELECTION_MAX_BYTES + 1, 65)); expect(await one).toBe(''); expect(excessive.child.kill).toHaveBeenCalledOnce();
    const broken = childFixture(); const two = broken.read(); broken.child.emit('error', Error('UI Automation is unavailable')); expect(await two).toBe('');
    const failed = childFixture(); const three = failed.read(); failed.child.emit('close', 1); expect(await three).toBe('');
  });

  it('caps Unicode selection by UTF-8 bytes without splitting characters or carrying NUL bytes', () => {
    const bounded = boundedSelectionText('你'.repeat(20_000) + '\0'); expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(CAPTURE_SELECTION_MAX_BYTES);
    expect(bounded).not.toContain('\uFFFD'); expect(bounded).not.toContain('\0'); expect(bounded.length).toBeGreaterThan(10_000);
  });
});

describe('selection assistant shared contract migration', () => {
  it('adds the default selection shortcut to existing five-shortcut settings without changing the old bindings', () => {
    const legacy = structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS) as { shortcuts: Partial<typeof DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts> };
    delete legacy.shortcuts.selection;
    const migrated = captureToolsSettingsSchema.parse(legacy); expect(migrated.shortcuts.selection).toBe('CommandOrControl+Alt+Shift+D');
    expect(migrated.shortcuts.screenshot).toBe(DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts.screenshot);
  });

  it('bounds text by bytes and keeps all selection clipboard actions explicit and fully shaped', () => {
    const base = { type: 'selection.ask', id: 'question', messages: [{ role: 'user', content: '解释一下' }] };
    expect(captureToolsRequestSchema.safeParse({ ...base, selection: '文'.repeat(12_000) }).success).toBe(false);
    expect(captureToolsRequestSchema.safeParse({ ...base, selection: '文'.repeat(10_000) }).success).toBe(true);
    expect(captureToolsRequestSchema.safeParse({ type: 'selection.clipboard' }).success).toBe(true);
    expect(captureToolsRequestSchema.safeParse({ type: 'selection.clipboard', write: 'not allowed' }).success).toBe(false);
    expect(captureToolsRequestSchema.safeParse({ type: 'selection.copy', text: 'Answer' }).success).toBe(true);
  });
});
