import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A modal must never close because the user clicked beside it.
 *
 * 用户 2026-09-13:「所有的这种置顶窗口(背景会虚化的窗口)都需要避免按窗口外的区域退出」
 * — clicking outside a dialog is easy to do by accident while aiming at a field,
 * and closing a half-filled settings/import/confirm panel loses work. Dialogs
 * keep their explicit close control and Escape (`DialogShell onRequestClose`).
 *
 * This is a source guard, not an interaction test: the failure mode is a *new*
 * dialog (or a re-added handler) quietly reintroducing the dismissal, which no
 * existing journey would necessarily cover.
 */
const RENDERER_ROOT = path.join(process.cwd(), 'src', 'renderer');

/**
 * The idiom that dismissed a modal: a handler on the backdrop element comparing
 * the event target to the element itself. Guarded variants
 * (`if (event.target === event.currentTarget && !busy) …`) match too.
 */
const BACKDROP_DISMISS = /(?:onClick|onMouseDown)=\{\(event\) => \{\s*if \(event\.target === event\.currentTarget[\s\S]*?\}\}/;

/**
 * Offsets of `dialog-backdrop` class attributes whose element also carries a
 * click-away close handler. A blank-area click handler elsewhere in the same
 * file (a folder list or tag grid deselecting on empty space) is unrelated and
 * must stay legal, so only the 200 characters after the class are inspected.
 */
export function backdropDismissOffsets(text: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (;;) {
    const marker = text.indexOf('dialog-backdrop', cursor);
    if (marker < 0) break;
    const window = text.slice(marker, marker + 400);
    const match = BACKDROP_DISMISS.exec(window);
    if (match && match.index < 200) offsets.push(marker + match.index);
    cursor = marker + 'dialog-backdrop'.length;
  }
  return offsets;
}

function collectTsxFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsxFiles(full));
      continue;
    }
    if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('modal backdrops do not dismiss on an outside click', () => {
  it('detects the dismissed idiom it is meant to forbid', () => {
    // Without this the scan below could pass because the pattern rotted.
    expect(backdropDismissOffsets(`
      <div
        className="dialog-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        role="presentation"
      >
    `)).toHaveLength(1);
    expect(backdropDismissOffsets(`
      <div className="dialog-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }} role="presentation">
    `)).toHaveLength(1);
  });

  it('leaves a blank-area click handler outside a backdrop alone', () => {
    // The folder-list / tag-grid deselect pattern is legitimate.
    expect(backdropDismissOffsets(`
      <div
        className="tag-management-grid"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelection({ selectedIds: [] });
        }}
        role="listbox"
      >
    `)).toEqual([]);
  });

  it('no dialog-backdrop element carries a click-away close handler', () => {
    const offenders = collectTsxFiles(RENDERER_ROOT)
      .filter((file) => backdropDismissOffsets(readFileSync(file, 'utf8')).length > 0)
      .map((file) => path.relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
