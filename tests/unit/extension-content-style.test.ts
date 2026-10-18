import { afterEach, describe, expect, it, vi } from 'vitest';
import { installContentStyle, setContentStyleInstaller } from '../../extension/content-style';

afterEach(() => setContentStyleInstaller(undefined));

describe('extension content stylesheet adapter', () => {
  it('preserves standalone extension style nodes and the original CSS verbatim', () => {
    const style = { textContent: '' };
    const createElement = vi.fn().mockReturnValue(style);
    const appendChild = vi.fn();
    const root = { ownerDocument: { createElement }, appendChild } as unknown as ShadowRoot;
    const css = '.tree-host { position: fixed; pointer-events: none; }';
    installContentStyle(root, css);
    expect(createElement).toHaveBeenCalledExactlyOnceWith('style');
    expect(style.textContent).toBe(css); expect(appendChild).toHaveBeenCalledExactlyOnceWith(style);
  });

  it('uses the isolated preload adapter for its exact root without adding inline style nodes', () => {
    const appendChild = vi.fn(); const root = { appendChild } as unknown as ShadowRoot;
    const adapter = vi.fn(); setContentStyleInstaller(adapter);
    installContentStyle(root, '.bubble { position: fixed; }');
    expect(adapter).toHaveBeenCalledExactlyOnceWith(root, '.bubble { position: fixed; }');
    expect(appendChild).not.toHaveBeenCalled();
  });
});
