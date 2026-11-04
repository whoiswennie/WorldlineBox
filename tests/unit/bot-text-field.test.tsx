// @vitest-environment happy-dom
import { act, createRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BotTextField } from '../../src/renderer/companion-bot/BotTextField';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const fieldStyles = readFileSync('src/renderer/companion-bot/bot-text-field.css', 'utf8');
let root: Root, host: HTMLDivElement, stylesheet: HTMLStyleElement;
let frames: Map<number, FrameRequestCallback>, sequence: number;
beforeEach(() => {
  frames = new Map(); sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  stylesheet = document.createElement('style'); stylesheet.textContent = fieldStyles; document.head.append(stylesheet);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); stylesheet.remove(); vi.unstubAllGlobals(); });
const input = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
const count = () => host.querySelector('.bot-text-field__count')?.textContent;
async function render(content: ReactNode) { await act(() => root.render(content)); }
async function fill(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function flushFrames() {
  await act(() => { const ready = [...frames.values()]; frames.clear(); for (const callback of ready) callback(performance.now()); });
}

it('associates its label, hint and error with the native control and preserves caller accessibility attributes', async () => {
  const changed = vi.fn();
  await render(<BotTextField id="persona" label="伙伴设定" hint="保留你的表达" error="内容待核实" aria-describedby="source-help"
    aria-label="编辑伙伴设定" name="persona" required maxLength={24000} rows={7} onChange={changed} actions={<button type="button">参考</button>} />);
  const textarea = input();
  expect(textarea.id).toBe('persona'); expect(host.querySelector('label')?.htmlFor).toBe('persona');
  expect(textarea.getAttribute('aria-describedby')).toBe('source-help persona-hint persona-error');
  expect(textarea.getAttribute('aria-invalid')).toBe('true'); expect(host.querySelector('[role="alert"]')?.textContent).toBe('内容待核实');
  expect(textarea.name).toBe('persona'); expect(textarea.required).toBe(true); expect(textarea.maxLength).toBe(24000); expect(textarea.getAttribute('rows')).toBe('7');
  expect(textarea.getAttribute('aria-label')).toBe('编辑伙伴设定'); expect(host.querySelector('button')?.textContent).toBe('参考');
  await fill('新设定'); expect(changed).toHaveBeenCalledTimes(1);
  await render(<BotTextField id="persona" aria-invalid="grammar" aria-describedby="source-help" />);
  expect(input().getAttribute('aria-describedby')).toBe('source-help'); expect(input().getAttribute('aria-invalid')).toBe('grammar');
});

it('uses distinct generated labels, native refs, caller styles and the shared no-grip typography', async () => {
  const ref = createRef<HTMLTextAreaElement>();
  await render(<><BotTextField ref={ref} label="第一项" defaultValue="原始文本" className="custom-field" textareaClassName="custom-input" style={{ letterSpacing: '0.1px' }} />
    <BotTextField label="第二项" disabled /></>);
  const controls = [...host.querySelectorAll('textarea')], labels = [...host.querySelectorAll('label')];
  expect(controls[0]!.id).not.toBe(controls[1]!.id); expect(labels.map(label => label.htmlFor)).toEqual(controls.map(control => control.id));
  expect(ref.current).toBe(controls[0]); ref.current!.focus(); ref.current!.setSelectionRange(1, 3);
  expect(document.activeElement).toBe(controls[0]); expect(ref.current!.selectionStart).toBe(1); expect(ref.current!.selectionEnd).toBe(3);
  expect(controls[0]!.style.letterSpacing).toBe('0.1px'); expect(controls[0]!.classList.contains('custom-input')).toBe(true);
  expect(controls[0]!.closest('.custom-field')).not.toBeNull();
  const computed = getComputedStyle(controls[0]!);
  expect(computed.resize).toBe('none'); expect(computed.fontSize).toBe('14px'); expect(computed.lineHeight).toBe('1.6');
  expect(controls[1]!.disabled).toBe(true); expect(controls[1]!.closest('.is-disabled')).not.toBeNull();
});

it('keeps uncontrolled 24k editing and local counts without rerendering the parent or replacing the textarea', async () => {
  let parentRenders = 0;
  function Parent() { parentRenders++; return <BotTextField defaultValue="最初" maxLength={24000} showCount />; }
  await render(<Parent />); const original = input();
  expect(count()).toBe('2 / 24000');
  const long = '原'.repeat(23996) + '🐳鱼'; await fill(long);
  input().setSelectionRange(11, 13); await flushFrames();
  expect(input()).toBe(original); expect(input().value).toBe(long); expect(count()).toBe(`${long.length} / 24000`);
  expect(input().selectionStart).toBe(11); expect(input().selectionEnd).toBe(13); expect(parentRenders).toBe(1);
});

it('keeps controlled values authoritative, including rejected edits and externally supplied replacements', async () => {
  const observed: string[] = [];
  await render(<BotTextField value="固定" showCount maxLength={10} onChange={event => observed.push(event.currentTarget.value)} />);
  await fill('不能越过父值'); await flushFrames();
  expect(observed).toEqual(['不能越过父值']); expect(input().value).toBe('固定'); expect(count()).toBe('2 / 10');
  await render(<BotTextField value="外部更新" showCount maxLength={10} onChange={event => observed.push(event.currentTarget.value)} />);
  expect(input().value).toBe('外部更新'); expect(count()).toBe('4 / 10');
  function Accepted() { const [value, setValue] = useState(''); return <BotTextField value={value} showCount onChange={event => setValue(event.currentTarget.value)} />; }
  await render(<Accepted />); await fill('接受输入'); expect(input().value).toBe('接受输入'); expect(count()).toBe('4');
});

it('forwards composition and clipboard events without trimming IME text or implementing a second maxLength rule', async () => {
  const start = vi.fn(), update = vi.fn(), end = vi.fn(), paste = vi.fn(), values: string[] = [];
  await render(<BotTextField defaultValue="" maxLength={3} showCount onCompositionStart={start} onCompositionUpdate={update} onCompositionEnd={end}
    onPaste={paste} onChange={event => values.push(event.currentTarget.value)} />);
  const textarea = input();
  await act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })));
  await fill('中');
  await act(() => textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '中文' })));
  // Programmatic input can exceed native maxLength; the component must not
  // truncate a surrogate pair or fight composition to enforce another limit.
  await fill('中文🐳');
  await act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文🐳' })));
  const clipboard = new Event('paste', { bubbles: true, cancelable: true }); await act(() => textarea.dispatchEvent(clipboard));
  expect(start).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledTimes(1); expect(end).toHaveBeenCalledTimes(1); expect(paste).toHaveBeenCalledTimes(1);
  expect(values).toEqual(['中', '中文🐳']); expect(textarea.value).toBe('中文🐳'); expect(textarea.maxLength).toBe(3); expect(count()).toBe('4 / 3');
  expect(clipboard.defaultPrevented).toBe(false);
});

it('leaves browser undo, redo, beforeinput and multiline shortcuts available and retains the same editing node', async () => {
  const keydown = vi.fn(); await render(<BotTextField defaultValue="原文" showCount onKeyDown={keydown} />);
  const textarea = input(); await fill('编辑后的原文');
  const undo = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true });
  const redo = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true, shiftKey: true });
  const newline = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', shiftKey: true });
  const beforeUndo = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' });
  await act(() => { for (const event of [undo, redo, newline, beforeUndo]) textarea.dispatchEvent(event); });
  expect([undo, redo, newline, beforeUndo].every(event => !event.defaultPrevented)).toBe(true); expect(keydown).toHaveBeenCalledTimes(3);
  await flushFrames(); expect(input()).toBe(textarea); expect(input().value).toBe('编辑后的原文');
  // happy-dom does not execute a browser's native undo stack. This proves
  // shortcut/event passthrough and node retention, not real Chromium undo.
});

it('measures autoheight only in one queued animation frame, caps growth and returns to minimum height', async () => {
  await render(<BotTextField autoSize minRows={2} maxRows={4} style={{ lineHeight: '20px', padding: '10px 12px', border: '1px solid' }} />);
  let contentHeight = 300;
  const readHeight = vi.fn(() => contentHeight);
  Object.defineProperty(input(), 'scrollHeight', { configurable: true, get: readHeight });
  expect(readHeight).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
  await fill('长内容'); await fill('接着编辑'); expect(readHeight).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
  await flushFrames(); expect(readHeight).toHaveBeenCalledTimes(1); expect(input().style.height).toBe('102px'); expect(input().style.overflowY).toBe('auto');
  contentHeight = 12; await fill('短'); await flushFrames();
  expect(input().style.height).toBe('62px'); expect(input().style.overflowY).toBe('hidden'); expect(input().style.maxHeight).toBe('102px');
});

it('does not schedule layout work for a static field and restores caller dimensions after autoheight is disabled', async () => {
  await render(<BotTextField minRows={10} maxRows={16} style={{ height: '250px' }} />);
  expect(input().getAttribute('rows')).toBe('10'); expect(frames.size).toBe(0); await fill('静态编辑'); expect(frames.size).toBe(0);
  await render(<BotTextField autoSize minRows={2} maxRows={3} style={{ height: '250px', lineHeight: '20px' }} />);
  Object.defineProperty(input(), 'scrollHeight', { configurable: true, get: () => 800 }); await flushFrames(); expect(input().style.height).not.toBe('250px');
  await render(<BotTextField autoSize={false} style={{ height: '250px', maxHeight: '400px', overflowY: 'auto' }} />);
  expect(input().style.height).toBe('250px'); expect(input().style.maxHeight).toBe('400px'); expect(input().style.minHeight).toBe(''); expect(input().style.overflowY).toBe('auto');
});

it('updates an uncontrolled count after native form reset and cancels pending work on unmount', async () => {
  const ref = createRef<HTMLTextAreaElement>();
  await render(<form><BotTextField ref={ref} defaultValue="初始" showCount autoSize /></form>);
  await fill('编辑后的长一些内容'); expect(count()).not.toBe('2');
  await act(() => host.querySelector('form')!.reset()); await flushFrames();
  expect(input().value).toBe('初始'); expect(count()).toBe('2');
  await fill('还有待测量的内容'); expect(frames.size).toBe(1);
  await render(null); expect(ref.current).toBeNull(); expect(frames.size).toBe(0);
  window.dispatchEvent(new Event('resize')); expect(frames.size).toBe(0);
});

it('bounds extreme row requests and coalesces width changes without creating a height-observer loop', async () => {
  let resized: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {}
    disconnect() { disconnect(); }
  });
  await render(<BotTextField autoSize minRows={1000} maxRows={1000} style={{ lineHeight: '20px', padding: 0 }} />);
  const height = vi.fn(() => 1000000);
  Object.defineProperty(input(), 'scrollHeight', { configurable: true, get: height });
  await flushFrames(); expect(input().style.height).toBe('800px'); expect(input().style.maxHeight).toBe('800px');
  const signal = (width: number) => resized!([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  signal(300); signal(300); signal(301); expect(height).toHaveBeenCalledTimes(1); expect(frames.size).toBe(1);
  await flushFrames(); expect(height).toHaveBeenCalledTimes(2);
  signal(301); expect(frames.size).toBe(0);
  await render(null); expect(disconnect).toHaveBeenCalledTimes(1);
});

it('reuses its width observer across controlled edits and measures externally changed values on the next frame', async () => {
  const created = vi.fn(), disconnected = vi.fn(), changed = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor() { created(); }
    observe() {}
    disconnect() { disconnected(); }
  });
  await render(<BotTextField autoSize value="短" onChange={changed} style={{ lineHeight: '20px', padding: 0 }} />);
  let height = 20;
  Object.defineProperty(input(), 'scrollHeight', { configurable: true, get: () => height });
  await flushFrames(); expect(input().style.height).toBe('60px');
  height = 110;
  await render(<BotTextField autoSize value={'更长的外部内容'.repeat(30)} onChange={changed} style={{ lineHeight: '20px', padding: 0 }} />);
  expect(frames.size).toBe(1); await flushFrames(); expect(input().style.height).toBe('110px');
  expect(created).toHaveBeenCalledTimes(1); expect(disconnected).not.toHaveBeenCalled();
});
