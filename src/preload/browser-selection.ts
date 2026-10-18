import { ipcRenderer } from 'electron';
import { BROWSER_CAPTURE_SELECTION_STATE } from '../shared/browser-capture';

/** Only the isolated preload can send this hint. It stores no selected text;
 * Main re-reads the live selection in the remembered frame after toolbar focus. */
export function installBrowserSelectionObserver(): void {
  if (!process.sandboxed || !process.contextIsolated) return;
  // getRandomValues is available on ordinary HTTP pages too. randomUUID is
  // secure-context-only in Chromium and must not break the existing shim.
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); let queued = false;
  const emit = () => {
    queued = false;
    const active = document.activeElement;
    const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const password = active instanceof HTMLInputElement && active.type === 'password';
    const selection = window.getSelection();
    const hasSelection = password ? false : input ? typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number' && active.selectionEnd > active.selectionStart
      : !!selection && !selection.isCollapsed && selection.rangeCount > 0;
    ipcRenderer.send(BROWSER_CAPTURE_SELECTION_STATE, { documentId, focused: document.hasFocus(), hasSelection });
  };
  const observe = () => { if (!queued) { queued = true; queueMicrotask(emit); } };
  for (const name of ['selectionchange', 'select', 'focusin', 'pointerup', 'keyup']) document.addEventListener(name, observe, true);
  window.addEventListener('focus', observe, true);
  window.addEventListener('unload', () => {
    for (const name of ['selectionchange', 'select', 'focusin', 'pointerup', 'keyup']) document.removeEventListener(name, observe, true);
    window.removeEventListener('focus', observe, true);
  }, { once: true });
}
