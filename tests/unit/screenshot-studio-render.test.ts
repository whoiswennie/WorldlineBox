import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawScreenshot, exportScreenshot } from '../../src/renderer/browser/screenshot/render';
import type { Annotation } from '../../src/renderer/browser/screenshot/model';

function surface(width = 64, height = 64) {
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  return { canvas, context, dom: context as unknown as CanvasRenderingContext2D };
}

afterEach(() => vi.unstubAllGlobals());

describe('flattened screenshot export', () => {
  it('exports only the selected source area', () => {
    const source = surface(); source.context.fillStyle = '#ff0000'; source.context.fillRect(20, 20, 20, 20);
    const output = surface(20, 20);
    drawScreenshot(output.dom, source.canvas as unknown as CanvasImageSource, { x: 20, y: 20, width: 20, height: 20 }, []);
    expect([...output.context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...output.context.getImageData(19, 19, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });

  it('redacts actual exported PNG pixels rather than covering an editable DOM layer', async () => {
    const source = surface(); source.context.fillStyle = '#ff0000'; source.context.fillRect(0, 0, 64, 64);
    const output = surface();
    drawScreenshot(output.dom, source.canvas as unknown as CanvasImageSource, { x: 0, y: 0, width: 64, height: 64 }, [{ tool: 'redact', from: { x: 10, y: 10 }, to: { x: 30, y: 30 }, size: 4 }]);
    const decoded = await loadImage(output.canvas.toBuffer('image/png')); const flattened = surface(); flattened.context.drawImage(decoded, 0, 0);
    expect([...flattened.context.getImageData(20, 20, 1, 1).data]).toEqual([0, 0, 0, 255]);
    expect([...flattened.context.getImageData(2, 2, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });

  it('replaces mosaic blocks with irreversible averaged pixels and leaves outside untouched', () => {
    const source = surface();
    source.context.fillStyle = '#ff0000'; source.context.fillRect(0, 0, 4, 16);
    source.context.fillStyle = '#0000ff'; source.context.fillRect(4, 0, 4, 16);
    const output = surface();
    drawScreenshot(output.dom, source.canvas as unknown as CanvasImageSource, { x: 0, y: 0, width: 64, height: 64 }, [{ tool: 'mosaic', from: { x: 0, y: 0 }, to: { x: 8, y: 16 }, size: 2 }]);
    expect([...output.context.getImageData(1, 1, 1, 1).data]).toEqual([128, 0, 128, 255]);
    expect([...output.context.getImageData(6, 1, 1, 1).data]).toEqual([128, 0, 128, 255]);
    expect([...output.context.getImageData(30, 30, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it('scales redaction coordinates when preparing the image for the model', () => {
    const source = surface(200, 100); const output = surface(100, 50);
    drawScreenshot(output.dom, source.canvas as unknown as CanvasImageSource, { x: 0, y: 0, width: 200, height: 100 }, [{ tool: 'redact', from: { x: 80, y: 20 }, to: { x: 120, y: 60 }, size: 4 }]);
    expect([...output.context.getImageData(50, 20, 1, 1).data]).toEqual([0, 0, 0, 255]);
    expect([...output.context.getImageData(10, 20, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it('supports every drawing tool on a real canvas', () => {
    const source = surface(200, 200); const output = surface(200, 200);
    const annotations: Annotation[] = [
      { tool: 'pen', points: [{ x: 4, y: 4 }, { x: 40, y: 40 }], color: '#ff0000', size: 3 },
      { tool: 'highlight', points: [{ x: 5, y: 50 }, { x: 150, y: 50 }], color: '#ffff00', size: 4 },
      ...(['rect', 'ellipse', 'arrow'] as const).map(tool => ({ tool, from: { x: 80, y: 80 }, to: { x: 160, y: 160 }, color: '#0000ff', size: 3 })),
      { tool: 'text', at: { x: 10, y: 160 }, text: 'Hello\nWorld', color: '#000000', size: 12 },
    ];
    expect(() => drawScreenshot(output.dom, source.canvas as unknown as CanvasImageSource, { x: 0, y: 0, width: 200, height: 200 }, annotations)).not.toThrow();
    expect([...output.context.getImageData(20, 20, 1, 1).data]).not.toEqual([255, 255, 255, 255]);
  });

  it('bounds LLM payload dimensions and exports the current edits into JPEG', async () => {
    const source = surface(2000, 1000);
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) });
    const result = exportScreenshot(source.canvas as unknown as CanvasImageSource, { x: 0, y: 0, width: 2000, height: 1000 }, [{ tool: 'redact', from: { x: 0, y: 0 }, to: { x: 2000, y: 1000 }, size: 4 }], { maxSide: 1600, format: 'image/jpeg' });
    expect(result.startsWith('data:image/jpeg;base64,')).toBe(true);
    const decoded = await loadImage(result);
    expect([decoded.width, decoded.height]).toEqual([1600, 800]);
    const output = surface(1600, 800); output.context.drawImage(decoded, 0, 0);
    expect([...output.context.getImageData(500, 500, 1, 1).data]).toEqual([0, 0, 0, 255]);
  });
});
