/**
 * Size the text viewer textarea.
 *
 * No-wrap matches the historical layout: grow to the longest line so the
 * surrounding scroller owns both axes. Wrap fills the stage width instead.
 */

export type TextViewerLayoutTarget = {
  style: { height: string; width: string };
  scrollHeight: number;
  scrollWidth: number;
  parentElement: { clientWidth: number } | null;
};

export function applyTextViewerTextareaLayout(
  textarea: TextViewerLayoutTarget,
  wrap: boolean,
): void {
  if (wrap) {
    textarea.style.width = "";
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
    return;
  }
  textarea.style.height = "0px";
  textarea.style.height = `${textarea.scrollHeight}px`;
  const minWidth = textarea.parentElement?.clientWidth ?? 0;
  textarea.style.width = "0px";
  textarea.style.width = `${Math.max(textarea.scrollWidth, minWidth)}px`;
}
