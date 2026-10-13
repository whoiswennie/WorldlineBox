// @vitest-environment happy-dom
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogFocusTrap } from '../../src/renderer/use-dialog-focus-trap';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove(); root = undefined; container = undefined; vi.unstubAllGlobals();
});

describe('global dialog focus with retained inactive modules', () => {
  for (const hiddenAttribute of ['hidden', 'inert', 'aria-hidden'] as const) it(`ignores a modal in a ${hiddenAttribute} asset ancestor, traps the portal settings and restores its opener`, async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++frameId; callbacks.set(id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
    function Fixture({ open }: { open: boolean }) {
      useDialogFocusTrap(open);
      const hiddenProps = hiddenAttribute === 'aria-hidden' ? { 'aria-hidden': 'true' as const } : { [hiddenAttribute]: true };
      return <>
        <button id="settings-opener">Settings</button>
        {open && createPortal(<div role="dialog" aria-modal="true" data-global-settings>
          <button id="global-first" data-dialog-initial-focus="true">Appearance</button>
          <button id="global-last">Close settings</button>
        </div>, document.body)}
        {/* A later retained modal must remain irrelevant regardless of document order. */}
        {createPortal(<section {...hiddenProps} data-application-view="assets">
          <div role="dialog" aria-modal="true" data-asset-modal>
            <button id="hidden-asset-first">Asset rename</button>
            <button id="hidden-asset-last">Confirm asset rename</button>
          </div>
        </section>, document.body)}
      </>;
    }
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(() => root!.render(<Fixture open={false} />));
    const opener = container.querySelector<HTMLButtonElement>('#settings-opener')!; opener.focus();
    await act(() => root!.render(<Fixture open />));
    await act(() => { for (const callback of callbacks.values()) callback(0); callbacks.clear(); });
    const first = document.querySelector<HTMLButtonElement>('#global-first')!;
    const last = document.querySelector<HTMLButtonElement>('#global-last')!;
    expect(document.activeElement).toBe(first);
    last.focus(); const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(forward); expect(forward.defaultPrevented).toBe(true); expect(document.activeElement).toBe(first);
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(backward); expect(backward.defaultPrevented).toBe(true); expect(document.activeElement).toBe(last);
    await act(() => root!.render(<Fixture open={false} />));
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[data-asset-modal]')).not.toBeNull();
  });
});
