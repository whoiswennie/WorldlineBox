import { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { DshTerminalOutput, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { consumeTerminalSnapshot, terminalExternalLink, type TerminalStreamCursor, type TerminalStreamSnapshot } from './terminal-stream';

export interface TerminalSurfaceHandle {
  focus(): void;
  follow(): void;
  clear(): void;
  selection(): string;
  text(): string;
  paste(text: string): void;
  search(text: string, backwards?: boolean): boolean;
}

interface SurfaceCallbacks {
  readonly active: boolean;
  readonly readOnly: boolean;
  readonly onInput: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onFollowChange?: (following: boolean) => void;
  readonly onLink?: (url: string) => void;
  readonly onReady?: (handle?: TerminalSurfaceHandle) => void;
  readonly onSearch?: () => void;
}

interface TerminalView {
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  readonly search: SearchAddon;
  readonly host: HTMLDivElement;
  readonly handle: TerminalSurfaceHandle;
  cursor?: TerminalStreamCursor;
  callbacks?: SurfaceCallbacks;
  following: boolean;
  touchedAt: number;
  writing: Promise<void>;
  input?: (data: string) => void;
  readOnly: boolean;
  disposed: boolean;
}

// React Activity disconnects effects while hiding a module. Retain the real
// emulator and its DOM until the backend removes the session, so alternate
// screens, selections, history and scroll position survive that disconnect.
const views = new Map<string, TerminalView>();
const MAX_VIEWS = 8;
const feeds = new Map<WorldlineBoxDshLauncherApi, () => void>();

export function retainTerminalViews(ids: readonly string[]): void {
  const retained = new Set(ids);
  for (const [id, view] of views) if (!retained.has(id)) {
    view.disposed = true; view.readOnly = true; view.input = undefined; view.callbacks = undefined;
    view.terminal.dispose(); view.host.remove(); views.delete(id);
  }
}

export function disposeTerminalViews(): void {
  retainTerminalViews([]);
  for (const unsubscribe of feeds.values()) unsubscribe(); feeds.clear();
}

function updateView(view: TerminalView, snapshot: TerminalStreamSnapshot): void {
  if (view.disposed) return;
  const end = snapshot.startOffset + snapshot.text.length;
  // Main-process state and incremental IPC use separate channels. An older
  // state snapshot must never replace output already received on the stream.
  if (view.cursor && snapshot.revision === view.cursor.revision && end < view.cursor.endOffset) return;
  if (view.cursor && snapshot.revision < view.cursor.revision) return;
  const update = consumeTerminalSnapshot(snapshot, view.cursor); view.cursor = update.cursor;
  if (!update.reset && !update.text) return;
  view.writing = view.writing.then(() => new Promise<void>(resolve => {
    if (view.disposed) { resolve(); return; }
    if (update.reset) view.terminal.reset();
    if (!update.text) { resolve(); return; }
    const viewportY = view.terminal.buffer.active.viewportY; const following = view.following;
    view.terminal.write(update.text, () => {
      if (following) view.terminal.scrollToBottom();
      else view.terminal.scrollToLine(viewportY);
      resolve();
    });
  }));
}

export function acceptTerminalOutput(output: DshTerminalOutput): void {
  const view = views.get(output.terminalId); if (!view) return;
  const startOffset = output.endOffset - output.text.length;
  if (startOffset < 0) return;
  if (view.cursor && output.outputRevision === view.cursor.revision && output.endOffset <= view.cursor.endOffset) return;
  updateView(view, { text: output.text, startOffset, revision: output.outputRevision });
}

/** One subscription outlives Activity effects and feeds each retained emulator. */
export function connectTerminalOutput(api: WorldlineBoxDshLauncherApi): void {
  if (!feeds.has(api) && api.onTerminalOutput) feeds.set(api, api.onTerminalOutput(acceptTerminalOutput));
}

if (typeof window !== 'undefined') {
  const api = (window as Window & { worldlinebox?: { dshLauncher?: WorldlineBoxDshLauncherApi } }).worldlinebox?.dshLauncher;
  if (api) connectTerminalOutput(api);
  window.addEventListener('pagehide', disposeTerminalViews, { once: true });
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const foreground = token('--ui-content-primary', '#dbe2ee');
  return {
    background: token('--ui-surface-raised', '#f9fafc'), foreground,
    cursor: token('--ui-action-accent', '#6699ff'), cursorAccent: token('--ui-surface-field', '#151922'),
    selectionBackground: '#7799bb55', selectionInactiveBackground: '#7799bb33',
    black: '#586174', brightBlack: '#8791a2', red: '#cc4f57', brightRed: '#e46a72',
    green: '#39875a', brightGreen: '#59a77a', yellow: '#ab7a24', brightYellow: '#c99d47',
    blue: '#4976c8', brightBlue: '#729ae5', magenta: '#a16bbb', brightMagenta: '#bd8fd3',
    cyan: '#328d98', brightCyan: '#5aabb4', white: foreground, brightWhite: foreground,
  };
}

function screenText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  return lines.join('\n').trimEnd();
}

function createView(id: string): TerminalView {
  if (views.size >= MAX_VIEWS) {
    const candidate = [...views].filter(([, view]) => !view.callbacks).sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (candidate) { candidate[1].disposed = true; candidate[1].readOnly = true; candidate[1].input = undefined; candidate[1].terminal.dispose(); candidate[1].host.remove(); views.delete(candidate[0]); }
    else throw new Error('Too many active terminal views.');
  }
  const host = document.createElement('div');
  host.className = 'launcher-xterm-host';
  const terminal = new Terminal({
    allowTransparency: true, allowProposedApi: true, scrollback: 3_000, cursorBlink: true, cursorStyle: 'bar',
    fontFamily: '"IBM Plex Mono", "Noto Sans SC", Consolas, monospace', fontSize: 13, lineHeight: 1.2, minimumContrastRatio: 4.5,
    theme: terminalTheme(), overviewRuler: { width: 8 }, drawBoldTextInBrightColors: false,
    macOptionIsMeta: true, screenReaderMode: true,
    linkHandler: { activate: (_event, value) => { const url = terminalExternalLink(value); if (url) view.callbacks?.onLink?.(url); } },
  });
  const fit = new FitAddon(); const search = new SearchAddon();
  terminal.loadAddon(fit); terminal.loadAddon(search);
  terminal.loadAddon(new WebLinksAddon((_event, value) => {
    const url = terminalExternalLink(value); if (url) view.callbacks?.onLink?.(url);
  }));
  const handle: TerminalSurfaceHandle = {
    focus: () => terminal.focus(),
    follow: () => { view.following = true; terminal.scrollToBottom(); view.callbacks?.onFollowChange?.(true); },
    clear: () => terminal.clear(), selection: () => terminal.getSelection(), text: () => screenText(terminal),
    paste: text => { if (!view.callbacks?.readOnly) terminal.paste(text); },
    search: (text, backwards = false) => {
      if (!text) { search.clearDecorations(); return false; }
      return backwards ? search.findPrevious(text) : search.findNext(text);
    },
  };
  const view: TerminalView = { terminal, fit, search, host, handle, following: true, touchedAt: Date.now(), writing: Promise.resolve(), readOnly: true, disposed: false };
  terminal.onData(data => {
    const report = data.startsWith('\u001b[') && /^[?0-9;]*[Rcn]$/.test(data.slice(2));
    // Cursor/device replies belong to the emulator, even while its DOM is
    // hidden. Dropping them can leave an interactive shell waiting forever.
    if (!view.readOnly && (view.callbacks?.active || report)) view.input?.(data);
  });
  terminal.onResize(({ cols, rows }) => { if (view.callbacks?.active && !view.callbacks.readOnly) view.callbacks.onResize(cols, rows); });
  terminal.onScroll(() => {
    view.following = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    view.callbacks?.onFollowChange?.(view.following);
  });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || !view.callbacks?.active) return true;
    if (event.isComposing || event.keyCode === 229) return true;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && view.callbacks.onSearch) {
      event.preventDefault(); event.stopPropagation(); view.callbacks.onSearch(); return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
      const selection = terminal.getSelection();
      if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined);
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
      if (!view.callbacks.readOnly) void navigator.clipboard?.readText().then(text => terminal.paste(text)).catch(() => undefined);
      return false;
    }
    return true;
  });
  terminal.open(host); views.set(id, view); return view;
}

export function TerminalSurface({ sessionId, snapshot, active, readOnly, label, onInput, onResize, onFollowChange, onLink, onReady, onSearch }: SurfaceCallbacks & {
  readonly sessionId: string;
  readonly snapshot: TerminalStreamSnapshot;
  readonly label: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const callbacks = useRef<SurfaceCallbacks>({ active, readOnly, onInput, onResize, onFollowChange, onLink, onReady, onSearch });
  useEffect(() => { callbacks.current = { active, readOnly, onInput, onResize, onFollowChange, onLink, onReady, onSearch }; }, [active, readOnly, onInput, onResize, onFollowChange, onLink, onReady, onSearch]);
  useEffect(() => {
    const container = mount.current; if (!container) return;
    const view = views.get(sessionId) ?? createView(sessionId);
    view.callbacks = callbacks.current; view.touchedAt = Date.now();
    view.input = callbacks.current.onInput; view.readOnly = callbacks.current.readOnly;
    view.terminal.options.disableStdin = view.callbacks.readOnly;
    view.terminal.options.theme = terminalTheme();
    container.append(view.host); callbacks.current.onReady?.(view.handle);
    callbacks.current.onFollowChange?.(view.following);
    let frame = 0;
    const fit = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!callbacks.current.active || container.clientWidth < 40 || container.clientHeight < 40) return;
        view.fit.fit();
      });
    };
    const observer = new ResizeObserver(fit); observer.observe(container);
    const theme = new MutationObserver(() => { view.terminal.options.theme = terminalTheme(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-profile'] });
    fit();
    return () => {
      observer.disconnect(); theme.disconnect(); if (frame) cancelAnimationFrame(frame);
      callbacks.current.onReady?.(); view.callbacks = undefined; view.touchedAt = Date.now(); view.host.remove();
    };
  }, [sessionId]);
  useEffect(() => {
    const view = views.get(sessionId); if (!view) return;
    view.input = callbacks.current.onInput; view.readOnly = readOnly;
    view.callbacks = callbacks.current; view.terminal.options.disableStdin = readOnly;
    if (active && mount.current && mount.current.clientWidth >= 40 && mount.current.clientHeight >= 40) view.fit.fit();
  }, [sessionId, active, readOnly, onInput, onResize, onFollowChange, onLink, onReady, onSearch]);
  useEffect(() => {
    const view = views.get(sessionId); if (!view) return;
    updateView(view, snapshot);
  }, [sessionId, snapshot]);
  return <div aria-label={label} className="launcher-terminal-viewport" data-dsh-terminal-output data-terminal-session={sessionId} ref={mount} role="region" />;
}
