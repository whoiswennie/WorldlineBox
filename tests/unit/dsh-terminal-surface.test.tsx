// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { acceptTerminalOutput, connectTerminalOutput, disposeTerminalViews, TerminalSurface, type TerminalSurfaceHandle } from '../../src/renderer/launcher/TerminalSurface';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';

const emulator = vi.hoisted(() => ({ instances: [] as FakeTerminal[] }));

interface FakeTerminal {
  options: Record<string, unknown>;
  writes: string[];
  resets: number;
  disposed: boolean;
  data?: (data: string) => void;
  resize?: (value: { cols: number; rows: number }) => void;
  scroll?: () => void;
  key?: (event: KeyboardEvent) => boolean;
  buffer: { active: { viewportY: number; baseY: number; length: number; getLine(index: number): { translateToString(trim: boolean): string } } };
  write(value: string, callback?: () => void): void;
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    writes: string[] = [];
    resets = 0;
    disposed = false;
    data?: FakeTerminal['data']; resize?: FakeTerminal['resize']; scroll?: FakeTerminal['scroll']; key?: FakeTerminal['key'];
    buffer = { active: { viewportY: 0, baseY: 10, length: 2, getLine: (index: number) => ({ translateToString: () => index ? 'second line' : 'first line' }) } };
    constructor(options: Record<string, unknown>) { this.options = options; emulator.instances.push(this); }
    loadAddon() { /* Rendering behavior is exercised by the real Electron test. */ }
    open(host: HTMLElement) { const screen = document.createElement('div'); screen.className = 'xterm'; host.append(screen); }
    onData(callback: NonNullable<FakeTerminal['data']>) { this.data = callback; }
    onResize(callback: NonNullable<FakeTerminal['resize']>) { this.resize = callback; }
    onScroll(callback: () => void) { this.scroll = callback; }
    attachCustomKeyEventHandler(callback: NonNullable<FakeTerminal['key']>) { this.key = callback; }
    write(value: string, callback?: () => void) { this.writes.push(value); callback?.(); }
    reset() { this.resets++; }
    clear() { /* The stream clear revision owns the authoritative reset. */ }
    focus() { /* No browser focus simulation is needed for protocol tests. */ }
    paste(text: string) { this.data?.(text); }
    getSelection() { return 'selected text'; }
    scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; }
    scrollToLine(value: number) { this.buffer.active.viewportY = value; }
    dispose() { this.disposed = true; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { /* A real layout is covered by Electron. */ } } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { clearDecorations() { /* noop */ } findNext() { return true; } findPrevious() { return true; } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { constructor() { /* Link scheme validation has separate tests. */ } } }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(() => root?.unmount()); container?.remove(); disposeTerminalViews(); emulator.instances.length = 0;
  root = undefined; container = undefined;
  document.documentElement.style.removeProperty('--ui-content-primary');
  document.documentElement.removeAttribute('data-theme');
});

async function mount(element: React.ReactNode) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(element));
}

it('keeps the same emulator and screen through Activity hiding and consumes only the new output suffix', async () => {
  const onInput = vi.fn(); const onResize = vi.fn();
  const surface = (mode: 'visible' | 'hidden', text: string) => <Activity mode={mode}><TerminalSurface sessionId="activity-session" snapshot={{ text, startOffset: 0, revision: 0 }} active readOnly={false} label="terminal" onInput={onInput} onResize={onResize} /></Activity>;
  await mount(surface('visible', '\u001b[31mfirst'));
  const view = emulator.instances[0]!; const screen = container!.querySelector('.xterm');
  await act(() => root!.render(surface('hidden', '\u001b[31mfirst')));
  expect(view.disposed).toBe(false);
  view.data?.('hidden input'); expect(onInput).not.toHaveBeenCalled();
  await act(() => root!.render(surface('visible', '\u001b[31mfirst\r\nsecond')));
  expect(emulator.instances).toHaveLength(1);
  expect(container!.querySelector('.xterm')).toBe(screen);
  expect(view.writes).toEqual(['\u001b[31mfirst', '\r\nsecond']);
  expect(view.resets).toBe(1);
});

it('forwards raw keys and geometry to the selected PTY without adding line delimiters', async () => {
  const onInput = vi.fn(); const onResize = vi.fn();
  await mount(<TerminalSurface sessionId="raw-session" snapshot={{ text: '', startOffset: 0, revision: 0 }} active readOnly={false} label="terminal" onInput={onInput} onResize={onResize} />);
  const view = emulator.instances[0]!;
  view.data?.('\u0003'); view.data?.('\u001b[A'); view.data?.('中文'); view.resize?.({ cols: 91, rows: 27 });
  expect(onInput.mock.calls).toEqual([['\u0003'], ['\u001b[A'], ['中文']]);
  expect(onResize).toHaveBeenCalledWith(91, 27);
  await act(() => root!.render(<TerminalSurface sessionId="raw-session" snapshot={{ text: '', startOffset: 0, revision: 0 }} active readOnly label="terminal" onInput={onInput} onResize={onResize} />));
  view.data?.('ignored'); expect(onInput).toHaveBeenCalledTimes(3);
});

it('accepts hidden-session output and cursor replies without rewinding to a stale state snapshot', async () => {
  const onInput = vi.fn(); const onResize = vi.fn();
  const surface = (mode: 'visible' | 'hidden') => <Activity mode={mode}><TerminalSurface sessionId="background-session" snapshot={{ text: 'first', startOffset: 0, revision: 0 }} active readOnly={false} label="terminal" onInput={onInput} onResize={onResize} /></Activity>;
  await mount(surface('visible'));
  const view = emulator.instances[0]!;
  await act(() => root!.render(surface('hidden')));
  await act(() => acceptTerminalOutput({ terminalId: 'background-session', text: '\r\nbackground', stream: 'stdout', outputOffset: 0, outputRevision: 0, endOffset: 17 }));
  view.data?.('\u001b[1;1R');
  expect(onInput).toHaveBeenCalledWith('\u001b[1;1R');
  await act(() => root!.render(surface('visible')));
  expect(view.writes).toEqual(['first', '\r\nbackground']);
  expect(view.resets).toBe(1);
});

it('uses one persistent output subscription and releases it with the terminal view cache', () => {
  const unsubscribe = vi.fn();
  const api: WorldlineBoxDshLauncherApi = { request: vi.fn(), onChanged: vi.fn(), onTerminalOutput: vi.fn(() => unsubscribe) };
  connectTerminalOutput(api); connectTerminalOutput(api);
  expect(api.onTerminalOutput).toHaveBeenCalledTimes(1);
  disposeTerminalViews(); expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('keeps explicit console white readable in light themes and changes colors without resetting the screen', async () => {
  document.documentElement.style.setProperty('--ui-content-primary', '#223344');
  await mount(<TerminalSurface sessionId="theme-session" snapshot={{ text: 'screen history', startOffset: 0, revision: 0 }} active readOnly={false} label="terminal" onInput={vi.fn()} onResize={vi.fn()} />);
  const view = emulator.instances[0]!;
  expect(view.options.theme).toMatchObject({ foreground: '#223344', white: '#223344', brightWhite: '#223344' });
  await act(async () => {
    document.documentElement.style.setProperty('--ui-content-primary', '#eaf1ff');
    document.documentElement.setAttribute('data-theme', 'dark');
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(view.options.theme).toMatchObject({ foreground: '#eaf1ff', brightWhite: '#eaf1ff' });
  expect(view.writes).toEqual(['screen history']); expect(view.resets).toBe(1); expect(emulator.instances).toHaveLength(1);
});

it('routes OSC hyperlinks through the same web-only policy as detected output URLs', async () => {
  const onLink = vi.fn();
  await mount(<TerminalSurface sessionId="link-session" snapshot={{ text: '', startOffset: 0, revision: 0 }} active readOnly={false} label="terminal" onInput={vi.fn()} onResize={vi.fn()} onLink={onLink} />);
  const handler = emulator.instances[0]!.options.linkHandler as { activate(event: MouseEvent, value: string): void };
  handler.activate(new MouseEvent('click'), 'file:///C:/private.txt');
  handler.activate(new MouseEvent('click'), 'javascript:alert(1)');
  handler.activate(new MouseEvent('click'), 'https://example.com/docs');
  expect(onLink.mock.calls).toEqual([['https://example.com/docs']]);
});

it('preserves a history viewport, supports explicit follow, and does not steal IME arrows', async () => {
  let handle: TerminalSurfaceHandle | undefined;
  const onReady = (value?: TerminalSurfaceHandle) => { handle = value; };
  const onInput = vi.fn(); const onResize = vi.fn(); const onFollowChange = vi.fn();
  const surface = (text: string) => <TerminalSurface sessionId="history-session" snapshot={{ text, startOffset: 0, revision: 0 }} active readOnly={false} label="terminal" onInput={onInput} onResize={onResize} onFollowChange={onFollowChange} onReady={onReady} />;
  await mount(surface('first'));
  const view = emulator.instances[0]!;
  view.buffer.active.viewportY = 3; view.scroll?.();
  await act(() => root!.render(surface('first\r\nnext')));
  expect(view.buffer.active.viewportY).toBe(3);
  expect(onFollowChange).toHaveBeenLastCalledWith(false);
  handle!.follow(); expect(view.buffer.active.viewportY).toBe(10);
  expect(handle!.text()).toBe('first line\nsecond line');
  expect(handle!.search('line')).toBe(true);
  expect(view.key?.(new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true }))).toBe(true);
  expect(view.key?.(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 229 }))).toBe(true);
});
