import { Window } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { installBrowserSelectionObserver } from '../../src/preload/browser-selection';
import { BROWSER_CAPTURE_SELECTION_STATE } from '../../src/shared/browser-capture';

vi.mock('electron', () => ({ ipcRenderer: { send: vi.fn() } }));
let dom: Window | undefined;
const sandboxed = Object.getOwnPropertyDescriptor(process, 'sandboxed');
const isolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated');
afterEach(() => {
  dom?.close(); dom = undefined; vi.unstubAllGlobals();
  if (sandboxed) Object.defineProperty(process, 'sandboxed', sandboxed); else Reflect.deleteProperty(process, 'sandboxed');
  if (isolated) Object.defineProperty(process, 'contextIsolated', isolated); else Reflect.deleteProperty(process, 'contextIsolated');
});
it('observes actual HTTP selections when secure-context randomUUID is unavailable, without transmitting their text', async () => {
  dom = new Window({ url: 'http://ordinary-insecure.example/article' });
  dom.document.body.innerHTML = '<p>Selected private page content</p>';
  const realRandom = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { getRandomValues: realRandom });
  vi.stubGlobal('window', dom); vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLInputElement', dom.HTMLInputElement); vi.stubGlobal('HTMLTextAreaElement', dom.HTMLTextAreaElement);
  Object.defineProperty(process, 'sandboxed', { value: true, configurable: true });
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true });
  expect(globalThis.crypto.randomUUID).toBeUndefined();
  expect(() => installBrowserSelectionObserver()).not.toThrow();
  const range = dom.document.createRange(); range.selectNodeContents(dom.document.querySelector('p')!); dom.getSelection()!.addRange(range);
  dom.document.dispatchEvent(new dom.Event('selectionchange')); await Promise.resolve();
  expect(ipcRenderer.send).toHaveBeenCalledWith(BROWSER_CAPTURE_SELECTION_STATE, { documentId: expect.stringMatching(/^[a-f0-9]{32}$/u), focused: expect.any(Boolean), hasSelection: true });
  expect(JSON.stringify(vi.mocked(ipcRenderer.send).mock.calls)).not.toContain('Selected private page content');
});
