import { fitSize, integerCrop, rectangle, type Annotation, type Rect, type Size } from './model';

/** All operations, including redaction, become pixels in the exported PNG. */
export function drawScreenshot(context: CanvasRenderingContext2D, image: CanvasImageSource, crop: Rect, annotations: readonly Annotation[]): void {
  const { width, height } = context.canvas;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  context.scale(width / crop.width, height / crop.height);
  for (const item of annotations) drawAnnotation(context, item);
  context.restore();
}

export function drawAnnotation(context: CanvasRenderingContext2D, item: Annotation): void {
  context.save();
  context.lineJoin = 'round'; context.lineCap = 'round';
  context.lineWidth = item.size;
  if ('color' in item) { context.strokeStyle = item.color; context.fillStyle = item.color; }
  if ('points' in item) {
    if (item.tool === 'highlight') { context.globalAlpha = 0.32; context.lineWidth = item.size * 4; }
    const start = item.points[0];
    if (start) {
      context.beginPath(); context.moveTo(start.x, start.y);
      if (item.points.length === 1) context.lineTo(start.x + 0.1, start.y + 0.1);
      for (const point of item.points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  } else if ('at' in item) {
    context.font = `600 ${item.size}px system-ui, sans-serif`;
    context.textBaseline = 'top';
    item.text.split('\n').forEach((line, index) => context.fillText(line, item.at.x, item.at.y + index * item.size * 1.35));
  } else {
    const box = rectangle(item.from, item.to);
    if (item.tool === 'redact') {
      context.fillStyle = '#000000';
      context.fillRect(Math.floor(box.x), Math.floor(box.y), Math.ceil(box.width) + 1, Math.ceil(box.height) + 1);
    } else if (item.tool === 'mosaic') {
      pixelate(context, box, Math.max(8, item.size * 4));
    } else if (item.tool === 'rect') {
      context.strokeRect(box.x, box.y, box.width, box.height);
    } else if (item.tool === 'ellipse') {
      context.beginPath(); context.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2); context.stroke();
    } else {
      const angle = Math.atan2(item.to.y - item.from.y, item.to.x - item.from.x);
      const head = Math.max(12, item.size * 4);
      context.beginPath(); context.moveTo(item.from.x, item.from.y); context.lineTo(item.to.x, item.to.y); context.stroke();
      context.beginPath(); context.moveTo(item.to.x, item.to.y);
      context.lineTo(item.to.x - head * Math.cos(angle - Math.PI / 6), item.to.y - head * Math.sin(angle - Math.PI / 6));
      context.lineTo(item.to.x - head * Math.cos(angle + Math.PI / 6), item.to.y - head * Math.sin(angle + Math.PI / 6));
      context.closePath(); context.fill();
    }
  }
  context.restore();
}

/** Read the current flattened surface and replace each block with its average. */
function pixelate(context: CanvasRenderingContext2D, rect: Rect, block: number): void {
  const transform = context.getTransform();
  const bounds = integerCrop({ x: rect.x * transform.a, y: rect.y * transform.d, width: rect.width * transform.a, height: rect.height * transform.d }, context.canvas);
  if (rect.width < 1 || rect.height < 1) return;
  const pixels = context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
  const step = Math.max(2, Math.round(block * transform.a));
  for (let y = 0; y < bounds.height; y += step) {
    for (let x = 0; x < bounds.width; x += step) {
      const endY = Math.min(bounds.height, y + step); const endX = Math.min(bounds.width, x + step);
      const totals = [0, 0, 0, 0]; let count = 0;
      for (let yy = y; yy < endY; yy++) for (let xx = x; xx < endX; xx++) {
        const offset = (yy * bounds.width + xx) * 4;
        for (let c = 0; c < 4; c++) totals[c] = (totals[c] ?? 0) + (pixels.data[offset + c] ?? 0);
        count++;
      }
      for (let yy = y; yy < endY; yy++) for (let xx = x; xx < endX; xx++) {
        const offset = (yy * bounds.width + xx) * 4;
        for (let c = 0; c < 4; c++) pixels.data[offset + c] = Math.round((totals[c] ?? 0) / count);
      }
    }
  }
  // putImageData ignores the current transform, so its coordinates are physical pixels.
  context.putImageData(pixels, bounds.x, bounds.y);
}

export function exportScreenshot(image: CanvasImageSource, crop: Rect, annotations: readonly Annotation[], options?: { maxSide: number; format: 'image/jpeg' | 'image/png' }): string {
  const size: Size = options ? fitSize(crop, { width: options.maxSide, height: options.maxSide }) : crop;
  const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  drawScreenshot(context, image, crop, annotations);
  return canvas.toDataURL(options?.format ?? 'image/png', 0.9);
}
