import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { fullPageImage } from '../../src/main/browser/full-page-image';

function fixture(width = 1200, height = 12000) {
  let attached = false;
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  const sendCommand = vi.fn(async (method: string) => method === 'Page.getLayoutMetrics' ? { cssContentSize: { x: 0, y: 0, width, height } } : { data: png.toString('base64') });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined), debugger: {
    isAttached: () => attached, attach: vi.fn(() => { attached = true; }), detach: vi.fn(() => { attached = false; }), sendCommand,
  } });
  return { contents, sendCommand, png };
}
it('captures full document CSS dimensions in the same page without resizing its viewport', async () => {
  const f = fixture(); expect(await fullPageImage(f.contents as unknown as WebContents)).toEqual(f.png);
  expect(f.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1200, height: 12000, scale: 1 } });
  expect(f.contents.debugger.detach).toHaveBeenCalledOnce(); expect(f.contents.debugger.isAttached()).toBe(false);
});
it('rejects oversized documents without silently cropping or starting a huge allocation', async () => {
  const f = fixture(2000, 100000); await expect(fullPageImage(f.contents as unknown as WebContents)).rejects.toThrow('网页尺寸过大');
  expect(f.sendCommand.mock.calls.map(([method]) => method)).not.toContain('Page.captureScreenshot'); expect(f.contents.debugger.detach).toHaveBeenCalledOnce();
});
it('rejects a changed document and never detaches another debugger owner', async () => {
  const f = fixture(); await expect(fullPageImage(f.contents as unknown as WebContents, () => false)).rejects.toThrow('跳转');
  expect(f.contents.debugger.attach).not.toHaveBeenCalled(); f.contents.debugger.attach();
  await expect(fullPageImage(f.contents as unknown as WebContents)).rejects.toThrow('调试器'); expect(f.contents.debugger.detach).not.toHaveBeenCalled();
});
