import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { prestartLibraryWorkerAfterWindowShown } from '../../src/main/library-worker-startup';

class Window extends EventEmitter {
  visible = false;
  destroyed = false;
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  show() { this.visible = true; this.emit('show'); }
  close() { this.destroyed = true; this.emit('closed'); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

it('does nothing until a real window is shown, then starts only the utility runtime on a later turn', async () => {
  const window = new Window(), start = vi.fn(async () => undefined), report = vi.fn();
  prestartLibraryWorkerAfterWindowShown(window, { isClosing: () => false, start, report });
  await turn(); expect(start).not.toHaveBeenCalled();
  window.show(); expect(start).not.toHaveBeenCalled();
  await turn(); expect(start).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledWith();
  window.show(); await turn(); expect(start).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled();
});

it('also handles a window already visible when bootstrap finishes without awaiting the runtime', async () => {
  const window = new Window(); window.visible = true;
  const start = vi.fn(() => new Promise<void>(() => undefined));
  expect(prestartLibraryWorkerAfterWindowShown(window, { isClosing: () => false, start, report: vi.fn() })).toBeUndefined();
  expect(start).not.toHaveBeenCalled(); await turn(); expect(start).toHaveBeenCalledOnce();
});

it.each(['closing', 'destroyed', 'closed-before-show'] as const)('does not start after %s', async reason => {
  const window = new Window(), start = vi.fn(async () => undefined); let closing = false;
  prestartLibraryWorkerAfterWindowShown(window, { isClosing: () => closing, start, report: vi.fn() });
  if (reason === 'closed-before-show') window.close();
  else { window.show(); if (reason === 'closing') closing = true; else window.destroyed = true; }
  await turn(); expect(start).not.toHaveBeenCalled();
});

it('reports a failed handshake once without inventing a library command, selection or retry timer', async () => {
  const window = new Window(), failure = new Error('ready handshake failed'), start = vi.fn(async () => { throw failure; }), report = vi.fn();
  prestartLibraryWorkerAfterWindowShown(window, { isClosing: () => false, start, report });
  window.show(); await turn(); await turn();
  expect(start).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledExactlyOnceWith(failure);
});
