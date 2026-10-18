import { describe, expect, it } from 'vitest';
import { commitEdit, EMPTY_HISTORY, fitSize, imagePoint, integerCrop, MAX_HISTORY, rectangle, redoEdit, screenshotFilename, undoEdit, type Annotation } from '../../src/renderer/browser/screenshot/model';

const first: Annotation = { tool: 'redact', from: { x: 1, y: 2 }, to: { x: 5, y: 6 }, size: 4 };
const second: Annotation = { tool: 'text', at: { x: 4, y: 5 }, text: 'Private', color: '#f00', size: 20 };

describe('screenshot selection and edit history', () => {
  it('maps scaled desktop coordinates into physical pixels and clamps outside drags', () => {
    const bounds = { x: 150, y: 80, width: 600, height: 400 };
    const pixels = { width: 1200, height: 800 };
    expect(imagePoint({ x: 450, y: 280 }, bounds, pixels)).toEqual({ x: 600, y: 400 });
    expect(imagePoint({ x: -30, y: 1000 }, bounds, pixels)).toEqual({ x: 0, y: 800 });
  });

  it('supports reverse-direction area selection', () => {
    expect(rectangle({ x: 90, y: 130 }, { x: 10, y: 30 })).toEqual({ x: 10, y: 30, width: 80, height: 100 });
  });

  it('includes fractional boundary pixels and keeps crops inside the source', () => {
    expect(integerCrop({ x: 10.4, y: 20.7, width: 35.9, height: 19.8 }, { width: 100, height: 100 })).toEqual({ x: 10, y: 20, width: 37, height: 21 });
    expect(integerCrop({ x: 98.5, y: 99.4, width: 80, height: 80 }, { width: 100, height: 100 })).toEqual({ x: 98, y: 99, width: 2, height: 1 });
  });

  it('downsizes model images without stretching or unnecessarily enlarging them', () => {
    expect(fitSize({ width: 4000, height: 2000 }, { width: 1600, height: 1600 })).toEqual({ width: 1600, height: 800 });
    expect(fitSize({ width: 400, height: 200 }, { width: 1600, height: 1600 })).toEqual({ width: 400, height: 200 });
  });

  it('restores a cleared drawing with undo and restores the clear with redo', () => {
    const drawn = commitEdit(EMPTY_HISTORY, [first, second]);
    const cleared = commitEdit(drawn, []);
    expect(undoEdit(cleared).present).toEqual([first, second]);
    expect(redoEdit(undoEdit(cleared)).present).toEqual([]);
    expect(drawn.present).toEqual([first, second]);
  });

  it('discards redo when drawing a new annotation after undo', () => {
    const history = commitEdit(commitEdit(EMPTY_HISTORY, [first]), [first, second]);
    const branched = commitEdit(undoEdit(history), [second]);
    expect(branched.future).toEqual([]);
    expect(redoEdit(branched).present).toEqual([second]);
  });

  it('caps undo memory and tolerates undo/redo on an empty stack', () => {
    let history = EMPTY_HISTORY;
    for (let index = 0; index < 100; index++) history = commitEdit(history, index % 2 ? [first] : []);
    expect(history.past).toHaveLength(MAX_HISTORY);
    expect(undoEdit(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
    expect(redoEdit(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
  });

  it('produces portable PNG filenames without Windows path characters', () => {
    expect(screenshotFilename(new Date('2026-10-18T09:10:11Z'))).toBe('Screenshot-2026-10-18T09-10-11.png');
  });
});
